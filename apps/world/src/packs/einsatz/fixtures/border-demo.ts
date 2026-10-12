import { routeDistanceMeters, type GeoJsonPoint, type OperationalObject } from '../../../core/model/index.ts'
import type { ScenarioDefinition } from '../../../core/scenarios/definition.ts'
import type { Actor } from '../../../core/simulation-runs/actors.ts'
import { createDirectRoutingAdapter } from '../../../routing/direct-adapter.ts'
import type { RoutingAdapter } from '../../../routing/protocol.ts'
import { einsatzCommandIds } from '../capabilities.ts'
import type { UnitType } from '../config-schema.ts'
import { trackDataSchema } from '../engine/combat-model.ts'
import { einsatzDataSchema, type TaskData, type UnitData } from '../engine/model.ts'
import { boardWords } from '../board/text.ts'
import { createWall, openScreen, pastGuardMs, roleScreen, runFor, type Screen, type ScreenCall } from './board-harness.ts'
import { borderConfig, sideTypes } from './border-harness.ts'
import { openRun, type OpenRun } from './run-harness.ts'

/**
 * Test-only demo plays of the halden-border Definitions on a real Run, every
 * Blue order given by taps on a Board screen holding a preset's roles. The
 * good dispatcher taps each unserved call in list order and sends its first
 * recommendation, confirming a divert; at a beat it gives the order the beat
 * names. Red, when a person plays it, gives its orders on its own preset's
 * roles. A play records what the objectives are judged on: when each task
 * closed, when Blue first identified an enemy shooter, the steps each side
 * lost, and every call each screen made; and what the pacing is judged on:
 * when each preset had something to decide, and how soon a unit could reach
 * each task from where the units stood when it came in. A play runs on the
 * direct router unless it is given another, such as a slowed one standing in
 * for road timings. Production code never imports this file.
 */

export const stepS = 5

/** A Blue order at a beat, given by taps once the Run reaches `atS`, to a unit of `group`: a decision for every preset holding that group's role. */
export interface Beat {
  readonly atS: number
  readonly name: string
  readonly group: string
  readonly act: (play: DemoContext) => Promise<void>
}

/** A Red order, given on Red's roles once the Run reaches `atS`: its input as given, or as read from the Run then, such as a call a cue created. */
export interface RedOrder {
  readonly atS: number
  readonly capabilityId: string
  readonly input: unknown | ((play: DemoContext) => unknown)
}

export interface DemoContext {
  readonly run: OpenRun
  readonly screen: Screen
  /** The watching preset screens, by preset id. */
  readonly watchers: ReadonlyMap<string, Screen>
  readonly definition: ScenarioDefinition
  readonly units: () => ReadonlyArray<UnitData & { readonly id: string; readonly label: string }>
  readonly tasks: () => ReadonlyArray<TaskData & { readonly id: string; readonly label: string }>
  /** The task a timeline cue created, by the label its input gives. */
  readonly cueTask: (cueId: string) => TaskData & { readonly id: string; readonly label: string }
}

export interface DemoOutcome {
  /** Run seconds at which each task closed, by label; absent while open. */
  readonly closedAtS: ReadonlyMap<string, number>
  readonly createdAtS: ReadonlyMap<string, number>
  readonly sides: ReadonlyMap<string, string>
  /** Each task's id and each unit's id, by label, as the Run gave them. */
  readonly taskIds: ReadonlyMap<string, string>
  readonly unitIds: ReadonlyMap<string, string>
  /** Run seconds at which Blue first held an identified track of an enemy shooter. */
  readonly firstShooterIdentifiedS: number | undefined
  /** Run seconds at which Blue first held any track. */
  readonly firstTrackS: number | undefined
  readonly stepsLost: Readonly<Record<string, number>>
  /** Every call the Blue screen made, with its Run second. */
  readonly calls: ReadonlyArray<ScreenCall & { readonly atS: number }>
  /** Every call Red's preset screen made by tapping its recommendations, with its Run second. */
  readonly redCalls: ReadonlyArray<ScreenCall & { readonly atS: number }>
  readonly redRefusals: ReadonlyArray<string>
  /** Run seconds at which each watched preset had something to decide: a row newly unserved on its Calls list, a beat to one of its groups' units, or, for Red's preset, an order Red gave. */
  readonly decisions: Readonly<Record<string, ReadonlyArray<number>>>
  /** For each task, by label: the seconds the soonest unit of its side that serves it would take to get there from where it stood when the task came in. */
  readonly reachS: ReadonlyMap<string, number>
  /** Tasks still open at the end, with how many non-destroyed units of their side serve them. */
  readonly openAtEnd: ReadonlyArray<{ readonly label: string; readonly side: string | undefined; readonly servers: number }>
  /** A digest of what the play did, for determinism. */
  readonly digest: string
}

const records = (objects: ReadonlyArray<OperationalObject>) => objects.flatMap(object => {
  const data = einsatzDataSchema.safeParse(object.packData)
  return data.success ? [{ ...data.data, id: object.id as string, label: object.label }] : []
})

/** A router whose every route and table entry is `factor` times as long and slow as the direct router's: road timings for a headless play. */
export const slowedRouting = (factor: number): RoutingAdapter => {
  const direct = createDirectRoutingAdapter()
  return {
    id: `direct-x${factor}`,
    route: async request => {
      const route = await direct.route(request)
      return { ...route, distanceM: route.distanceM * factor as typeof route.distanceM, durationSeconds: route.durationSeconds * factor }
    },
    table: async request => {
      const table = await direct.table(request)
      return {
        ...table,
        durationsSeconds: table.durationsSeconds.map(row => row.map(entry => entry === null ? null : entry * factor)),
        distancesM: table.distancesM.map(row => row.map(entry => entry === null ? null : entry * factor as typeof entry)),
      }
    },
  }
}

/** A second tap on the highlighted unit lets it go, so the next tap on a call selects the call. */
export const letGo = async (screen: Screen): Promise<void> => {
  const selected = screen.view().selected
  if (selected?.kind === 'unit') await screen.click({ kind: 'row', list: 'units', id: selected.id })
}

/**
 * One pass of the good dispatcher: every unserved call in list order is
 * tapped, and its first recommendation sent. A call a busy unit holds as its
 * next job is covered next and shows no button; the good dispatcher sends
 * another now, the first of the units the bar lists below it.
 */
export const tapRecommendations = async (screen: Screen): Promise<void> => {
  await letGo(screen)
  const tried = new Set<string>()
  for (let round = 0; round < 40; round++) {
    const row = screen.view().workList.rows.find(entry => !entry.served && !tried.has(entry.id))
    if (row === undefined) return
    tried.add(row.id)
    await screen.click({ kind: 'row', list: 'work', id: row.id })
    const selected = screen.view().selected
    const another = selected?.kind === 'task' && screen.view().commit.text.startsWith(boardWords.coveredNext) ? selected.alternatives[0] : undefined
    if (another !== undefined) {
      await screen.wait(pastGuardMs)
      await screen.click({ kind: 'alternative', number: another.number })
      continue
    }
    if (screen.view().commit.state !== 'ready') continue
    await screen.wait(pastGuardMs)
    await screen.click({ kind: 'commit' })
    // A divert asks to confirm what it drops.
    if (screen.view().commit.state === 'confirm') {
      await screen.wait(pastGuardMs)
      await screen.click({ kind: 'commit' })
    }
    tried.delete(row.id)
  }
}

/** The shooter types of a side, from the groups the Definition gives it. */
export const shooterLabels = (definition: ScenarioDefinition, side: string): ReadonlySet<string> => {
  const held = sideTypes(definition, side)
  return new Set(borderConfig(definition).unitTypes.filter((type: UnitType) => held.has(type.id) && type.components.effector !== undefined).map(type => type.label))
}

/** What serves a task: a unit type providing one of its requirements or carrying one of its load classes. */
const servesTask = (definition: ScenarioDefinition, typeId: string, task: TaskData): boolean => {
  const config = borderConfig(definition)
  const type = config.unitTypes.find(entry => entry.id === typeId)
  const template = config.taskTemplates.find(entry => entry.id === task.template)
  if (type === undefined || template === undefined) throw new Error(`Unknown unit type ${typeId} or task template ${task.template}`)
  const classes = Object.keys({ ...task.loads, ...task.pickedUp })
  return template.requires.some(requirement => type.components.service?.provides.includes(requirement.provides) === true)
    || type.components.carry?.classes.some(carried => classes.includes(carried)) === true
}

export const playDemo = async (options: {
  readonly definition: ScenarioDefinition
  readonly untilS: number
  /** Whether Blue's screen dispatches by recommendation; a Blue that does nothing taps nothing. */
  readonly dispatch: boolean
  readonly beats?: ReadonlyArray<Beat>
  readonly red?: ReadonlyArray<RedOrder>
  /** Whether Red's preset screen sends the first recommendation for each of Red's calls as it arrives, as Blue's does. */
  readonly redDispatch?: boolean
  /** Preset screens that only watch, by preset id, to read what each sees and has to decide. */
  readonly watchers?: ReadonlyArray<string>
  /** The Run's router: the direct one unless given. */
  readonly routing?: RoutingAdapter
  readonly inspect?: (context: DemoContext, atS: number) => void
}): Promise<DemoOutcome> => {
  const { definition } = options
  const routing = options.routing ?? createDirectRoutingAdapter()
  const [blue, red] = (definition.sides ?? []).map(side => side.id) as [string, string]
  const presets = definition.rolePresets ?? []
  const presetRoles = (id: string) => presets.find(preset => preset.id === id)!.roles
  const run = await openRun({ definition, routing })
  try {
    const actor = roleScreen(run, ...presets[0]!.roles)
    const screen = await openScreen(run, createWall(), { actor })
    const watchers = new Map<string, Screen>()
    for (const id of options.watchers ?? []) watchers.set(id, await openScreen(run, createWall(), { actor: roleScreen(run, ...presetRoles(id)) }))
    const redPreset = presets.find(preset => preset.roles.length > 0 && preset.roles.every(roleId => run.run.roles()!.roles.find(role => role.id === roleId)?.sees?.includes(red) === true))
    const redActor: Actor | undefined = redPreset === undefined ? undefined : roleScreen(run, ...redPreset.roles)
    if (options.redDispatch === true && (redPreset === undefined || !watchers.has(redPreset.id))) throw new Error('A Red that dispatches needs its preset screen watched')
    const redScreen = options.redDispatch === true ? watchers.get(redPreset!.id) : undefined
    const startMs = run.nowMs()
    const nowS = () => (run.nowMs() - startMs) / 1_000
    const objects = () => run.run.snapshot().objects
    const context: DemoContext = {
      run, screen, watchers, definition,
      units: () => records(objects()).filter((record): record is UnitData & { id: string; label: string } => record.type === 'unit'),
      tasks: () => records(objects()).filter((record): record is TaskData & { id: string; label: string } => record.type === 'task'),
      cueTask: cueId => {
        const cue = definition.timeline?.cues.find(entry => entry.id === cueId)
        const label = (cue?.actions[0] as { readonly input?: { readonly label?: string } } | undefined)?.input?.label
        const task = context.tasks().find(entry => entry.label === label)
        if (task === undefined) throw new Error(`The Run holds no task from cue ${cueId}`)
        return task
      },
    }
    const createdAtS = new Map<string, number>()
    const closedAtS = new Map<string, number>()
    const sides = new Map<string, string>()
    const reachS = new Map<string, number>()
    const calls: Array<ScreenCall & { readonly atS: number }> = []
    const redCalls: Array<ScreenCall & { readonly atS: number }> = []
    const redRefusals: string[] = []
    const watched = new Map<string, Screen>([[presets[0]!.id, screen], ...watchers])
    const decisions: Record<string, number[]> = Object.fromEntries([...watched.keys()].map(id => [id, []]))
    const unservedBefore = new Map<string, ReadonlySet<string>>()
    const shooters = shooterLabels(definition, red)
    let firstShooterIdentifiedS: number | undefined
    let firstTrackS: number | undefined
    const beats = [...options.beats ?? []]
    const redOrders = [...options.red ?? []]
    const holds = (presetId: string, group: string) => presetRoles(presetId).includes(`group:${group}`)
    /** A new row unserved on a preset's Calls list since the last look is a decision for that preset. */
    const noteRows = () => {
      for (const [id, watching] of watched) {
        const unserved = new Set(watching.view().workList.rows.filter(row => !row.served).map(row => row.id))
        if ([...unserved].some(rowId => !(unservedBefore.get(id)?.has(rowId) ?? false))) decisions[id]!.push(nowS())
        unservedBefore.set(id, unserved)
      }
    }
    /** How soon the soonest unit of the task's side that serves it could get there, from where the units stand now. */
    const reachOf = async (task: TaskData): Promise<number> => {
      const to = task.point as GeoJsonPoint
      const seconds = await Promise.all(objects().flatMap(object => {
        const data = einsatzDataSchema.safeParse(object.packData)
        const from = object.spatial.position?.point
        if (!data.success || data.data.type !== 'unit' || data.data.side !== task.side || data.data.integrity === 'destroyed' || from === undefined) return []
        if (!servesTask(definition, data.data.unitType, task)) return []
        const mobility = borderConfig(definition).unitTypes.find(type => type.id === (data.data as UnitData).unitType)!.components.mobility
        if (mobility === undefined) return []
        return [(async () => mobility.mode === 'direct'
          ? mobility.mobilizeS + routeDistanceMeters(from, to) / mobility.speedMps
          : mobility.mobilizeS + (await routing.route({ from, to })).durationSeconds / mobility.speedFactor)()]
      }))
      return Math.min(...seconds)
    }
    const observe = async () => {
      for (const task of context.tasks()) {
        if (!createdAtS.has(task.label)) {
          createdAtS.set(task.label, (task.createdAtMs - startMs) / 1_000)
          reachS.set(task.label, await reachOf(task))
        }
        if (task.side !== undefined) sides.set(task.label, task.side)
        if (task.closedAtMs !== undefined && !closedAtS.has(task.label)) closedAtS.set(task.label, (task.closedAtMs - startMs) / 1_000)
      }
      for (const object of objects()) {
        const track = trackDataSchema.safeParse(object.packData)
        if (!track.success || object.audience === 'public' || object.audience?.includes(blue) !== true) continue
        firstTrackS ??= nowS()
        if (track.data.identity !== undefined && shooters.has(track.data.identity.typeLabel)) firstShooterIdentifiedS ??= nowS()
      }
    }
    for (let atS = 0; atS <= options.untilS; atS += stepS) {
      if (atS > 0) await runFor(run, stepS * 1_000, [...watched.values()])
      noteRows()
      for (const order of redOrders.filter(entry => entry.atS <= nowS())) {
        redOrders.splice(redOrders.indexOf(order), 1)
        if (redPreset !== undefined && watched.has(redPreset.id)) decisions[redPreset.id]!.push(nowS())
        const result = await run.invoke(order.capabilityId, typeof order.input === 'function' ? order.input(context) : order.input, redActor)
        if (!result.ok) redRefusals.push(`${order.atS}: ${result.reason}`)
      }
      const before = screen.calls.length
      for (const beat of beats.filter(entry => entry.atS <= nowS())) {
        beats.splice(beats.indexOf(beat), 1)
        for (const id of watched.keys()) if (holds(id, beat.group)) decisions[id]!.push(nowS())
        await beat.act(context)
      }
      if (options.dispatch) await tapRecommendations(screen)
      calls.push(...screen.calls.slice(before).map(call => ({ ...call, atS: nowS() })))
      if (redScreen !== undefined) {
        const redBefore = redScreen.calls.length
        await tapRecommendations(redScreen)
        redCalls.push(...redScreen.calls.slice(redBefore).map(call => ({ ...call, atS: nowS() })))
      }
      await observe()
      options.inspect?.(context, nowS())
    }
    const stepsLost = Object.fromEntries([blue, red].map(side => [side, context.units()
      .filter(unit => unit.side === side)
      .reduce((sum, unit) => sum + (unit.integrity === 'destroyed' ? 2 : unit.integrity === 'damaged' ? 1 : 0), 0)]))
    const living = context.units().filter(unit => unit.integrity !== 'destroyed')
    const taskIds = new Map(context.tasks().map(task => [task.label, task.id]))
    const unitIds = new Map(context.units().map(unit => [unit.label, unit.id]))
    const openAtEnd = context.tasks().filter(task => task.closedAtMs === undefined).map(task => ({
      label: task.label,
      side: task.side,
      servers: living.filter(unit => unit.side === task.side && servesTask(definition, unit.unitType, task)).length,
    }))
    const digest = JSON.stringify({ closed: [...closedAtS], calls: [...calls, ...redCalls].map(call => [call.atS, call.capabilityId, call.input, call.result.ok]), stepsLost, firstShooterIdentifiedS, redRefusals })
    return { closedAtS, createdAtS, sides, taskIds, unitIds, firstShooterIdentifiedS, firstTrackS, stepsLost, calls, redCalls, redRefusals, decisions, reachS, openAtEnd, digest }
  } finally {
    await run.close()
  }
}

/** A beat: tap a unit of the Board's unit list, then one of its verbs. */
export const unitVerb = async (screen: Screen, unitId: string, verb: 'recall' | 'hold'): Promise<void> => {
  await screen.click({ kind: 'row', list: 'units', id: unitId })
  await screen.click({ kind: 'verb', verb, id: unitId })
  await letGo(screen)
}

/** A beat: + on a busy unit's row, then the call it should take next. */
export const addToEnd = async (screen: Screen, unitId: string, taskId: string): Promise<void> => {
  await screen.click({ kind: 'verb', verb: 'add', id: unitId })
  await screen.wait(pastGuardMs)
  await screen.click({ kind: 'row', list: 'work', id: taskId })
}

/** A beat: tap a busy unit, then a call, and choose to add the call to the end of its chain. */
export const askThenAddToEnd = async (screen: Screen, unitId: string, taskId: string): Promise<void> => {
  await screen.click({ kind: 'row', list: 'units', id: unitId })
  await screen.wait(pastGuardMs)
  await screen.click({ kind: 'row', list: 'work', id: taskId })
  if (screen.view().commit.state !== 'choice') throw new Error(`Expected Do now or Add to end, the bar reads: ${screen.view().commit.text}`)
  await screen.wait(pastGuardMs)
  await screen.click({ kind: 'option', option: 'add-to-end' })
}

export const commandIds = einsatzCommandIds
