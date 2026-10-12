import { geoPointFromLonLat, roleClassForRoleSet, type GeoJsonPoint, type IsoTimestamp, type ObjectId, type OperationalObject } from '../../../core/model/index.ts'
import type { Actor } from '../../../core/simulation-runs/actors.ts'
import { viewerForActor } from '../../../core/simulation-runs/role-gates.ts'
import { sideViewOfSnapshot } from '../../../core/simulation-runs/side-view.ts'
import { createBoardController, type BoardController } from '../board/controller.ts'
import { boardQueryIds } from '../board/calls.ts'
import type { BoardEffect, BoardEventBody, BoardKey, BoardView, CallResult, ClickTarget, MapTarget, TargetPreview } from '../board/types.ts'
import { configurationOutputSchema, type EinsatzConfig, type TaskTemplate, type UnitType } from '../config-schema.ts'
import { einsatzConfigSchema } from '../config-validation.ts'
import { openModeViewer, type PictureViewer } from '../picture.ts'
import civil from './halden-civil.scenario.json'
import civilRoles from './halden-civil-roles.scenario.json'
import { operator, type OpenRun } from './run-harness.ts'

/**
 * Test-only driver for the Einsatz Board: a "screen" is a Board controller
 * wired to a real Run the way the panel wires it. It feeds the Run's objects
 * and time, performs every effect through the Run's Capability path (commands
 * and `recommend`), feeds the answers back, and counts operator actions. The
 * wall clock is the test's own, so guards and key timing are exact while the
 * Run clock keeps running. In a role Run a screen holds roles: it reads the
 * Run's objects through its role set's lens, and every call it makes passes
 * core's role gates and the Einsatz adapter's authority as that role set.
 * Production code never imports this file.
 */

export interface Wall {
  readonly now: () => number
  readonly advance: (ms: number) => void
}

export const createWall = (): Wall => {
  let ms = 1_000_000
  return { now: () => ms, advance: delta => { ms += delta } }
}

export interface ScreenCall {
  readonly capabilityId: string
  readonly input: unknown
  readonly result: CallResult
}

export interface Screen {
  readonly board: BoardController
  readonly view: () => BoardView
  /** Operator actions so far: keys (not repeats, which the World key router swallows), clicks and map clicks. */
  readonly actions: () => number
  readonly resetActions: () => void
  /** Every command this screen sent, with its result. */
  readonly calls: ReadonlyArray<ScreenCall>
  readonly sounds: () => number
  /** The map's selection as the Board's `select` effects left it. */
  readonly mapSelection: () => string | null
  /** Recommendation queries this screen made. */
  readonly queries: () => number
  /**
   * Hands an event to the Board as the panel would, without performing what it
   * returns: a test performs the effects later, so events land before results.
   */
  readonly raw: (event: BoardEventBody) => ReadonlyArray<BoardEffect>
  readonly perform: (effects: ReadonlyArray<BoardEffect>) => Promise<void>
  /** Feeds the Run's objects and time, then performs every effect that follows. */
  readonly sync: () => Promise<void>
  /** A key press as the World key router delivers it: a repeat never reaches the Board, and a key the Board does not handle is not dispatched. */
  readonly key: (key: string, options?: { readonly shift?: boolean; readonly repeat?: boolean }) => Promise<void>
  readonly click: (target: ClickTarget) => Promise<void>
  readonly mapSelect: (objectId: string | null) => Promise<void>
  readonly mapTarget: (unitId: string, target: MapTarget) => Promise<void>
  /** The hover preview the panel would show for a map target. */
  readonly preview: (unitId: string, target: MapTarget) => TargetPreview | null
  readonly focus: (active: boolean) => Promise<void>
  /** Lets wall time pass, as the panel's timer does. */
  readonly wait: (ms: number) => Promise<void>
  /** While frozen, the screen receives no snapshots: what it shows is what it showed before. */
  readonly freeze: (frozen: boolean) => void
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** A key as the World key router reports it: `KeyboardEvent.key`, the physical `code` a US layout gives it, and Shift. */
const panelKey = (key: string, shift: boolean): BoardKey => ({
  key,
  code: /^[a-zA-Z]$/.test(key) ? `Key${key.toUpperCase()}` : /^[0-9]$/.test(key) ? `Digit${key}` : key === '[' ? 'BracketLeft' : key === ']' ? 'BracketRight' : key,
  shift,
})

/**
 * The screen's viewer: in a role Run, the role set its actor holds, as core
 * stamps it for the Pack; in open mode, the viewer the test gives the Board,
 * or open mode itself.
 */
const screenViewer = (run: OpenRun, actor: Actor, viewer: PictureViewer | undefined): PictureViewer => {
  const declaration = run.run.roles()
  const held = viewerForActor(declaration, actor)
  if (declaration === null || held === undefined) return viewer ?? openModeViewer
  if (viewer !== undefined) throw new Error('A screen of a role Run takes its viewer from the roles its actor holds')
  return {
    class: held.class,
    sees: held.sees,
    roles: held.roleIds.map(roleId => {
      const role = declaration.roles.find(entry => entry.id === roleId)
      if (role === undefined) throw new Error(`The Run declares no role ${roleId}`)
      return role
    }),
  }
}

export const openScreen = async (run: OpenRun, wall: Wall, options: { readonly viewer?: PictureViewer; readonly config?: EinsatzConfig; readonly actor?: Actor } = {}): Promise<Screen> => {
  const actor = options.actor ?? operator
  const viewer = screenViewer(run, actor, options.viewer)
  // The panel reads the configuration once at join, through the configuration query.
  const config = options.config ?? configurationOutputSchema.parse(await run.query(boardQueryIds.configuration, {}, actor)).config
  const board = createBoardController({ config, viewer, sides: run.run.roles()?.sides ?? [] })
  /** The Run's objects through this screen's lens: a side picture holds only what its audience lets it see. */
  const lensed = (): ReadonlyArray<OperationalObject> => {
    const snapshot = run.run.snapshot()
    return viewer.sees === 'all' ? snapshot.objects : sideViewOfSnapshot(snapshot, viewer.sees).objects
  }
  const calls: ScreenCall[] = []
  let actions = 0
  let sounds = 0
  let queries = 0
  let mapSelection: string | null = null
  let frozen = false

  const perform = async (effects: ReadonlyArray<BoardEffect>): Promise<void> => {
    for (const effect of effects) {
      if (effect.kind === 'invoke') {
        const outcome = await run.run.invokeCapability(actor, { capabilityId: effect.capabilityId, input: effect.input })
        if (outcome.kind !== 'command') throw new Error(`${effect.capabilityId} is not a command`)
        const result: CallResult = outcome.result.ok ? { ok: true } : { ok: false, reason: outcome.result.reason }
        calls.push({ capabilityId: effect.capabilityId, input: effect.input, result })
        await dispatch({ kind: 'result', callId: effect.callId, result })
      } else if (effect.kind === 'recommend') {
        queries += 1
        let answer: unknown
        try {
          const outcome = await run.run.invokeCapability(actor, { capabilityId: boardQueryIds.recommend, input: { taskId: effect.taskId } })
          if (outcome.kind !== 'query') throw new Error('recommend is not a query')
          // The panel passes the answer as it arrives; the Board validates it.
          answer = outcome.result
        } catch (error) {
          await dispatch({ kind: 'recommendation-failed', taskId: effect.taskId, key: effect.key, reason: message(error) })
          continue
        }
        await dispatch({ kind: 'recommendation', taskId: effect.taskId, key: effect.key, answer })
      } else if (effect.kind === 'sound') sounds += 1
      else if (effect.objectId !== mapSelection) {
        // The map takes the selection, and the panel's selectedObjectId prop echoes it back.
        mapSelection = effect.objectId
        await dispatch({ kind: 'selection', objectId: effect.objectId })
      }
    }
  }
  const raw = (event: BoardEventBody): ReadonlyArray<BoardEffect> => board.dispatch({ ...event, wallMs: wall.now() })
  const dispatch = async (event: BoardEventBody): Promise<void> => { await perform(raw(event)) }
  const sync = async (): Promise<void> => {
    if (frozen) return
    await dispatch({ kind: 'snapshot', objects: lensed(), currentTime: new Date(run.nowMs()).toISOString() as IsoTimestamp })
  }
  const operatorAction = async (event: BoardEventBody): Promise<void> => {
    actions += 1
    await dispatch(event)
    await sync()
  }

  await sync()
  return {
    board,
    view: board.view,
    actions: () => actions,
    resetActions: () => { actions = 0 },
    calls,
    sounds: () => sounds,
    mapSelection: () => mapSelection,
    queries: () => queries,
    raw: event => {
      if (event.kind === 'key' || event.kind === 'click' || event.kind === 'selection' || event.kind === 'map-target') actions += 1
      return raw(event)
    },
    perform,
    sync,
    key: async (key, keyOptions = {}) => {
      if (keyOptions.repeat === true) return
      const pressed = panelKey(key, keyOptions.shift ?? false)
      if (!board.handlesKey(pressed)) {
        actions += 1
        return
      }
      await operatorAction({ kind: 'key', ...pressed })
    },
    click: async target => await operatorAction({ kind: 'click', target }),
    mapSelect: async objectId => {
      mapSelection = objectId as ObjectId | null
      await operatorAction({ kind: 'selection', objectId: objectId as ObjectId | null })
    },
    mapTarget: async (unitId, target) => await operatorAction({ kind: 'map-target', controllerId: unitId as ObjectId, target }),
    preview: (unitId, target) => board.preview(unitId as ObjectId, target),
    focus: async active => await dispatch({ kind: 'focus', active }),
    wait: async ms => {
      wall.advance(ms)
      await dispatch({ kind: 'tick' })
    },
    freeze: value => { frozen = value },
  }
}

/** Moves the running Run clock forward and lets the Run publish, then lets each screen see it. */
export const runFor = async (run: OpenRun, ms: number, screens: ReadonlyArray<Screen> = []): Promise<void> => {
  run.forward(ms)
  await run.settle()
  for (const screen of screens) await screen.sync()
}

/** The civil Halden Definition with other items and timeline: the same configuration, a scene a test builds. */
export const civilWith = (items: ReadonlyArray<Record<string, unknown>>, timeline?: unknown): unknown => ({
  ...civil,
  packs: [{ ...civil.packs[0]!, items }],
  ...(timeline === undefined ? { timeline: undefined } : { timeline }),
})

/** The civil role Definition with other items and no timeline: its roles and authority over a scene a test builds. */
export const civilRolesWith = (items: ReadonlyArray<Record<string, unknown>>): unknown => ({
  ...civilRoles,
  packs: [{ ...civilRoles.packs[0]!, items }],
  timeline: undefined,
})

/** A screen of a role Run holding these roles, as core resolves its connection. */
export const roleScreen = (run: OpenRun, ...roleIds: ReadonlyArray<string>): Actor => {
  const declaration = run.run.roles()
  if (declaration === null) throw new Error('A role screen needs a Run that declares roles')
  return {
    id: `actor:screen-${roleIds.join('-')}` as Actor['id'],
    label: `Screen ${roleIds.join(', ')}`,
    role: roleClassForRoleSet(declaration, roleIds),
    roleIds,
  }
}

/** Who sets a scene up: the operator in open mode, a screen holding the Controller role in a role Run. */
export const setupActor = (run: OpenRun): Actor => {
  const declaration = run.run.roles()
  if (declaration === null) return operator
  const controller = declaration.roles.find(role => role.class === 'controller')
  if (controller === undefined) throw new Error('This role Run declares no Controller role to set a scene up')
  return roleScreen(run, controller.id)
}

export const civilConfig: EinsatzConfig = einsatzConfigSchema.parse(civil.packs[0]!.config)

const only = <T extends { readonly id: string }>(entries: ReadonlyArray<T>, what: string): string => {
  if (entries.length !== 1) throw new Error(`The civil Definition needs exactly one ${what}; found ${entries.length}`)
  return entries[0]!.id
}

/**
 * The civil configuration's types, templates and classes, found by their
 * components and requirements, never by name.
 */
export const civilKinds = (config: EinsatzConfig) => {
  const typeWhere = (what: string, predicate: (type: UnitType) => boolean) => only(config.unitTypes.filter(predicate), what)
  const templateWhere = (what: string, predicate: (template: TaskTemplate) => boolean) => only(config.taskTemplates.filter(predicate), what)
  const providers = (template: TaskTemplate) => template.requires.map(requirement => requirement.provides)
  const pair = config.taskTemplates.find(template => template.requires.some(requirement => requirement.count === 2))!
  const conditioned = config.taskTemplates.find(template => template.requires.some(requirement => requirement.where.length > 0))!
  return {
    classes: config.loadClasses.map(entry => entry.id),
    types: {
      /** Road mobility, carries one load of every class. */
      carrier: typeWhere('road carrier', type => type.components.mobility?.mode === 'road' && type.components.carry?.capacity === 1),
      /** Direct mobility, carries two loads. */
      flyer: typeWhere('direct carrier', type => type.components.mobility?.mode === 'direct' && type.components.carry !== undefined),
      /** Provides the service a template needs twice. */
      pairServer: typeWhere('pair server', type => providers(pair).some(service => type.components.service?.provides.includes(service) === true)),
      /** Provides the service a template needs with a property condition. */
      conditionedServer: typeWhere('conditioned server', type => providers(conditioned).some(service => type.components.service?.provides.includes(service) === true)),
      /** A public site receiving every load class. */
      site: typeWhere('full site', type => type.components.receiving?.accepts.length === config.loadClasses.length),
    },
    templates: {
      /** Counted load only, no floor: the urgency is the load. */
      load: templateWhere('load template', template => template.requires.length === 0 && template.priorityClass === undefined),
      pair: pair.id,
      /** One unit of the pair service, with a floor. */
      single: templateWhere('single template', template => template.requires.length === 1 && template.requires[0]!.count === 1 && template.requires[0]!.where.length === 0),
      conditioned: conditioned.id,
      /** Nothing to serve, ranked by its floor. */
      report: templateWhere('report template', template => template.requires.length === 0 && template.priorityClass !== undefined),
    },
  }
}

export const unitAt = (id: string, label: string, unitType: string, position: readonly [number, number], extra: Record<string, unknown> = {}) =>
  ({ type: 'unit', id, label, unitType, position, ...extra })
export const taskAt = (id: string, label: string, template: string, position: readonly [number, number], loads?: Readonly<Record<string, number>>) =>
  ({ type: 'task', id, label, template, position, ...(loads === undefined ? {} : { loads }) })
export const pointAt = (position: readonly [number, number]): GeoJsonPoint => geoPointFromLonLat(position[0], position[1])
/** A map click on an object, as core's map routing hands it to the panel. */
export const onObject = (objectId: string): MapTarget => ({ kind: 'object', objectId: objectId as ObjectId })
/** A map click on open ground. */
export const onGround = (position: readonly [number, number]): MapTarget => ({ kind: 'point', point: pointAt(position) })

/** Wall time an operator waits before committing, so a guard armed by the list moving has run out. */
export const pastGuardMs = 600

/**
 * The recommendation follower: at every step of the running Run it presses N
 * and then Enter on the most urgent unserved row, confirming when the Board
 * asks, until that row offers nothing to commit. It stops at `untilMs` of Run
 * time.
 */
export const follow = async (run: OpenRun, screen: Screen, options: { readonly untilMs: number; readonly stepMs: number }): Promise<void> => {
  while (run.nowMs() < options.untilMs) {
    await runFor(run, options.stepMs, [screen])
    for (let round = 0; round < 20; round++) {
      await screen.key('n')
      if (screen.view().commit.state !== 'ready') break
      await screen.wait(pastGuardMs)
      await screen.key('Enter')
      if (screen.view().commit.state === 'confirm') {
        await screen.wait(pastGuardMs)
        await screen.key('Enter')
      }
    }
  }
}
