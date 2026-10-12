import type { OperationalObject } from '../../../core/model/index.ts'
import type { ScenarioDefinition } from '../../../core/scenarios/definition.ts'
import type { Actor } from '../../../core/simulation-runs/actors.ts'
import { einsatzCommandIds } from '../capabilities.ts'
import type { UnitType } from '../config-schema.ts'
import { trackDataSchema } from '../engine/combat-model.ts'
import { einsatzDataSchema, type TaskData, type UnitData } from '../engine/model.ts'
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
 * lost, and every call each screen made. Production code never imports this
 * file.
 */

export const stepS = 5

/** A Blue order at a beat, given by taps once the Run reaches `atS`. */
export interface Beat {
  readonly atS: number
  readonly name: string
  readonly act: (play: DemoContext) => Promise<void>
}

/** A Red order, given on Red's roles once the Run reaches `atS`. */
export interface RedOrder {
  readonly atS: number
  readonly capabilityId: string
  readonly input: unknown
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
  /** Run seconds at which Blue first held an identified track of an enemy shooter. */
  readonly firstShooterIdentifiedS: number | undefined
  /** Run seconds at which Blue first held any track. */
  readonly firstTrackS: number | undefined
  readonly stepsLost: Readonly<Record<string, number>>
  /** Every call the Blue screen made, with its Run second. */
  readonly calls: ReadonlyArray<ScreenCall & { readonly atS: number }>
  readonly redRefusals: ReadonlyArray<string>
  /** Run seconds at which each preset screen's event log gained an entry. */
  readonly logTimes: Readonly<Record<string, ReadonlyArray<number>>>
  /** A digest of what the play did, for determinism. */
  readonly digest: string
}

const records = (objects: ReadonlyArray<OperationalObject>) => objects.flatMap(object => {
  const data = einsatzDataSchema.safeParse(object.packData)
  return data.success ? [{ ...data.data, id: object.id as string, label: object.label }] : []
})

/** A second tap on the highlighted unit lets it go, so the next tap on a call selects the call. */
export const letGo = async (screen: Screen): Promise<void> => {
  const selected = screen.view().selected
  if (selected?.kind === 'unit') await screen.click({ kind: 'row', list: 'units', id: selected.id })
}

/** One pass of the good dispatcher: every unserved call in list order is tapped, and its first recommendation sent. */
export const tapRecommendations = async (screen: Screen): Promise<void> => {
  await letGo(screen)
  const tried = new Set<string>()
  for (let round = 0; round < 40; round++) {
    const row = screen.view().workList.rows.find(entry => !entry.served && !tried.has(entry.id))
    if (row === undefined) return
    tried.add(row.id)
    await screen.click({ kind: 'row', list: 'work', id: row.id })
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

export const playDemo = async (options: {
  readonly definition: ScenarioDefinition
  readonly untilS: number
  /** Whether Blue's screen dispatches by recommendation; a Blue that does nothing taps nothing. */
  readonly dispatch: boolean
  readonly beats?: ReadonlyArray<Beat>
  readonly red?: ReadonlyArray<RedOrder>
  /** Preset screens that only watch, by preset id, to read what each sees. */
  readonly watchers?: ReadonlyArray<string>
  readonly inspect?: (context: DemoContext, atS: number) => void
}): Promise<DemoOutcome> => {
  const { definition } = options
  const [blue, red] = (definition.sides ?? []).map(side => side.id) as [string, string]
  const presets = definition.rolePresets ?? []
  const presetRoles = (id: string) => presets.find(preset => preset.id === id)!.roles
  const run = await openRun({ definition })
  try {
    const actor = roleScreen(run, ...presets[0]!.roles)
    const screen = await openScreen(run, createWall(), { actor })
    const watchers = new Map<string, Screen>()
    for (const id of options.watchers ?? []) watchers.set(id, await openScreen(run, createWall(), { actor: roleScreen(run, ...presetRoles(id)) }))
    const redPreset = presets.find(preset => preset.roles.length > 0 && preset.roles.every(roleId => run.run.roles()!.roles.find(role => role.id === roleId)?.sees?.includes(red) === true))
    const redActor: Actor | undefined = redPreset === undefined ? undefined : roleScreen(run, ...redPreset.roles)
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
    const calls: Array<ScreenCall & { readonly atS: number }> = []
    const redRefusals: string[] = []
    const logTimes: Record<string, number[]> = Object.fromEntries([presets[0]!.id, ...watchers.keys()].map(id => [id, []]))
    const logSizes = new Map<string, number>()
    const shooters = shooterLabels(definition, red)
    let firstShooterIdentifiedS: number | undefined
    let firstTrackS: number | undefined
    const beats = [...options.beats ?? []]
    const redOrders = [...options.red ?? []]
    const observe = () => {
      for (const task of context.tasks()) {
        if (!createdAtS.has(task.label)) createdAtS.set(task.label, nowS())
        if (task.side !== undefined) sides.set(task.label, task.side)
        if (task.closedAtMs !== undefined && !closedAtS.has(task.label)) closedAtS.set(task.label, (task.closedAtMs - startMs) / 1_000)
      }
      for (const object of objects()) {
        const track = trackDataSchema.safeParse(object.packData)
        if (!track.success || object.audience === 'public' || object.audience?.includes(blue) !== true) continue
        firstTrackS ??= nowS()
        if (track.data.identity !== undefined && shooters.has(track.data.identity.typeLabel)) firstShooterIdentifiedS ??= nowS()
      }
      for (const [id, watched] of [[presets[0]!.id, screen] as const, ...watchers]) {
        const size = watched.view().log.length
        if (size !== (logSizes.get(id) ?? 0)) logTimes[id]!.push(nowS())
        logSizes.set(id, size)
      }
    }
    for (let atS = 0; atS <= options.untilS; atS += stepS) {
      if (atS > 0) await runFor(run, stepS * 1_000, [screen, ...watchers.values()])
      for (const order of redOrders.filter(entry => entry.atS <= nowS())) {
        redOrders.splice(redOrders.indexOf(order), 1)
        const result = await run.invoke(order.capabilityId, order.input, redActor)
        if (!result.ok) redRefusals.push(`${order.atS}: ${result.reason}`)
      }
      const before = screen.calls.length
      for (const beat of beats.filter(entry => entry.atS <= nowS())) {
        beats.splice(beats.indexOf(beat), 1)
        await beat.act(context)
      }
      if (options.dispatch) await tapRecommendations(screen)
      calls.push(...screen.calls.slice(before).map(call => ({ ...call, atS: nowS() })))
      observe()
      options.inspect?.(context, nowS())
    }
    const stepsLost = Object.fromEntries([blue, red].map(side => [side, context.units()
      .filter(unit => unit.side === side)
      .reduce((sum, unit) => sum + (unit.integrity === 'destroyed' ? 2 : unit.integrity === 'damaged' ? 1 : 0), 0)]))
    const digest = JSON.stringify({ closed: [...closedAtS], calls: calls.map(call => [call.atS, call.capabilityId, call.input, call.result.ok]), stepsLost, firstShooterIdentifiedS, redRefusals })
    return { closedAtS, createdAtS, sides, firstShooterIdentifiedS, firstTrackS, stepsLost, calls, redRefusals, logTimes, digest }
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
