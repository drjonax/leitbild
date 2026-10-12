import type { OperationalObject } from '../../../core/model/index.ts'
import type { Actor } from '../../../core/simulation-runs/actors.ts'
import { createDirectRoutingAdapter } from '../../../routing/direct-adapter.ts'
import type { RouteRequest, RouteTableRequest, RoutingAdapter } from '../../../routing/protocol.ts'
import { einsatzCommandIds as ids, einsatzQueryIds } from '../capabilities.ts'
import type { EinsatzConfig } from '../config-schema.ts'
import { einsatzConfigSchema } from '../config-validation.ts'
import type { TaskData, UnitData } from '../engine/model.ts'
import { einsatzPackId } from '../ids.ts'
import type { Recommendation } from '../recommendation-schema.ts'
import { refusalCode } from '../refusal.ts'
import { roleScreen } from './board-harness.ts'
import { openRun, operator, type OpenRun } from './run-harness.ts'

/**
 * Test-only: plays a demo Scenario Definition headless on a real Run, in
 * fixed steps of Run time, with one dispatcher policy per screen, and logs
 * what the demo's objectives are judged on. A policy acts only as its screen
 * may: it reads the recommendation for each call its screen queues and sends
 * through the Run's Capability path, as the Board does. Calls, units and
 * places are found by the Run's objects, by when a cue created them and
 * where they stand, never by a type or template name. Production code never
 * imports this file.
 */

/** An order a policy gives: a Capability and its input. */
export interface Order {
  readonly capabilityId: string
  readonly input: unknown
}

/** What a beat's plan reads: the Run as its screen sees it, at the step the beat falls due. */
export interface BeatContext {
  readonly nowS: number
  /** The calls a cue created at this Run second, in the order the Run holds them: the order the cues created them. */
  readonly callsCreatedAt: (atS: number) => ReadonlyArray<OperationalObject>
  readonly units: () => ReadonlyArray<OperationalObject>
  readonly recommend: (taskId: string) => Promise<Recommendation>
}

/** A good dispatcher's planned move at a beat: the orders it gives at `atS`, besides following recommendations. */
export interface Beat {
  readonly name: string
  readonly atS: number
  readonly plan: (context: BeatContext) => Promise<ReadonlyArray<Order>>
}

export type Policy =
  /** Never acts. */
  | { readonly kind: 'nothing' }
  /**
   * Accepts the recommendation of each call its screen queues, as it arrives
   * and until the call is served, leaving a call alone that a unit holds
   * queued; at each beat it first gives the beat's orders.
   */
  | { readonly kind: 'recommendations'; readonly beats: ReadonlyArray<Beat> }

export interface CallLog {
  readonly id: string
  readonly label: string
  readonly template: string
  readonly rank: string
  readonly createdS: number
  /** When a unit first stood on scene there (on task), to the step. */
  firstOnSceneS?: number
  closedS?: number
  /** Units seen on task there. */
  readonly onScene: Set<string>
}

export interface OrderLog {
  readonly atS: number
  readonly screen: string
  readonly beat?: string
  readonly capabilityId: string
  readonly input: unknown
  readonly ok: boolean
  readonly reason?: string
}

export interface PlayLog {
  readonly calls: ReadonlyArray<CallLog>
  readonly orders: ReadonlyArray<OrderLog>
  readonly run: OpenRun
}

/** A routing adapter whose travel takes `factor` times as long as the direct model's: road detours and town speeds. */
export const slowedRouting = (factor: number): RoutingAdapter => {
  const direct = createDirectRoutingAdapter()
  return {
    id: `direct-slowed-${factor}`,
    route: async (request: RouteRequest) => {
      const result = await direct.route(request)
      return { ...result, durationSeconds: result.durationSeconds * factor, provider: `direct-slowed-${factor}` }
    },
    table: async (request: RouteTableRequest) => {
      const result = await direct.table(request)
      return { ...result, durationsSeconds: result.durationsSeconds.map(row => row.map(seconds => seconds === null ? null : seconds * factor)) }
    },
  }
}

const isTask = (data: unknown): data is TaskData => (data as { readonly type?: unknown }).type === 'task'
const isUnit = (data: unknown): data is UnitData => (data as { readonly type?: unknown }).type === 'unit'

/** The Einsatz configuration of a Definition. */
export const configOf = (definition: unknown): EinsatzConfig =>
  einsatzConfigSchema.parse((definition as { readonly packs: ReadonlyArray<{ readonly id: string; readonly config: unknown }> }).packs.find(pack => pack.id === einsatzPackId)!.config)

/** Metres between two points, flat at their mean latitude: enough to compare short distances in a town. */
export const metresBetween = (a: readonly [number, number], b: readonly [number, number]): number => {
  const meanLat = ((a[1] + b[1]) / 2) * Math.PI / 180
  return Math.hypot((b[0] - a[0]) * 111_320 * Math.cos(meanLat), (b[1] - a[1]) * 110_540)
}
export const lonLatOf = (object: OperationalObject): [number, number] => {
  const point = object.spatial.position?.point.coordinates
  if (point === undefined) throw new Error(`${object.id} stands nowhere`)
  return [point[0]!, point[1]!]
}

interface Screen {
  readonly name: string
  readonly actor: Actor
  readonly policy: Policy
}

/**
 * Plays the Definition until `untilS` in `stepS` steps. Each screen names a
 * dispatcher by the roles it holds (none in open mode) and its policy. A
 * dispatcher reacts `reactS` after each call arrives, as a person at an iPad
 * does: it acts on a call, and gives a beat's orders, only once that long
 * has passed since the call or the beat.
 */
export const playDemo = async (options: {
  readonly definition: unknown
  readonly screens: ReadonlyArray<{ readonly name: string; readonly roleIds?: ReadonlyArray<string>; readonly policy: Policy }>
  readonly untilS: number
  readonly stepS?: number
  readonly reactS?: number
  readonly routing?: RoutingAdapter
}): Promise<PlayLog> => {
  const stepS = options.stepS ?? 5
  const reactS = options.reactS ?? 0
  const run = await openRun({ definition: options.definition, ...(options.routing === undefined ? {} : { routing: options.routing }) })
  const startMs = run.nowMs()
  const config = configOf(options.definition)
  const classOrder = config.loadClasses.map(entry => entry.id)
  const screens: Screen[] = options.screens.map(screen => ({
    name: screen.name,
    actor: screen.roleIds === undefined ? operator : roleScreen(run, ...screen.roleIds),
    policy: screen.policy,
  }))
  const calls = new Map<string, CallLog>()
  const orders: OrderLog[] = []
  const beatsDone = new Set<string>()
  const nowS = () => Math.round((run.nowMs() - startMs) / 1_000)
  const objects = () => run.run.snapshot().objects.filter(object => object.packId === einsatzPackId)
  const secondsOf = (ms: number) => Math.round((ms - startMs) / 1_000)

  const give = async (screen: Screen, order: Order, beat?: string): Promise<void> => {
    const result = await run.invoke(order.capabilityId, order.input, screen.actor)
    orders.push({ atS: nowS(), screen: screen.name, ...(beat === undefined ? {} : { beat }), ...order, ok: result.ok, ...(result.ok ? {} : { reason: result.reason }) })
  }
  const recommendFor = (screen: Screen) => async (taskId: string): Promise<Recommendation> =>
    await run.query<Recommendation>(einsatzQueryIds.recommend, { taskId }, screen.actor)

  const observe = (): void => {
    const all = objects()
    for (const object of all) {
      const data = object.packData
      if (!isTask(data)) continue
      const call = calls.get(object.id) ?? { id: object.id, label: object.label, template: data.template, rank: data.rank, createdS: secondsOf(data.createdAtMs), onScene: new Set<string>() }
      calls.set(object.id, call)
      const here = all.filter(entry => isUnit(entry.packData) && entry.packData.taskId === object.id && entry.packData.phase === 'on-task')
      for (const unit of here) call.onScene.add(unit.id)
      if (call.firstOnSceneS === undefined && (here.length > 0 || Object.keys(data.pickedUp).length > 0 || Object.keys(data.served).length > 0)) call.firstOnSceneS = nowS()
      if (call.closedS === undefined && data.closedAtMs !== undefined) call.closedS = secondsOf(data.closedAtMs)
    }
  }

  const dispatch = async (screen: Screen): Promise<void> => {
    if (screen.policy.kind === 'nothing') return
    const context: BeatContext = {
      nowS: nowS(),
      callsCreatedAt: atS => objects().filter(object => isTask(object.packData) && secondsOf(object.packData.createdAtMs) === atS),
      units: () => objects().filter(object => isUnit(object.packData)),
      recommend: recommendFor(screen),
    }
    for (const beat of screen.policy.beats) {
      const key = `${screen.name}:${beat.name}`
      if (beatsDone.has(key) || beat.atS + reactS > nowS()) continue
      beatsDone.add(key)
      for (const order of await beat.plan(context)) await give(screen, order, beat.name)
    }
    const open = objects()
      .flatMap(object => isTask(object.packData) && object.packData.closedAtMs === undefined && secondsOf(object.packData.createdAtMs) + reactS <= nowS() ? [{ id: object.id, data: object.packData }] : [])
      .sort((a, b) => classOrder.indexOf(a.data.rank) - classOrder.indexOf(b.data.rank) || a.data.createdAtMs - b.data.createdAtMs || (a.id < b.id ? -1 : 1))
    for (const task of open) {
      let answer: Recommendation
      try {
        answer = await context.recommend(task.id)
      } catch (error) {
        // A call only another desk's units serve is not in this screen's queue.
        if (refusalCode((error as Error).message) === 'task_not_in_role_queue') continue
        throw error
      }
      if (answer.need === null || answer.next.length > 0 || answer.proposal.units.length === 0) continue
      const diverts = answer.proposal.units.flatMap(unit => unit.divertFrom === undefined ? [] : [{ unitId: unit.unitId, fromTaskId: unit.divertFrom.taskId }])
      await give(screen, { capabilityId: ids.send, input: { units: answer.proposal.units.map(unit => unit.unitId), to: { taskId: task.id }, ...(diverts.length === 0 ? {} : { divert: diverts }) } })
    }
  }

  observe()
  while (nowS() < options.untilS) {
    for (const screen of screens) await dispatch(screen)
    observe()
    run.forward(stepS * 1_000)
    await run.settle()
    observe()
  }
  return { calls: [...calls.values()], orders, run }
}

/**
 * A beat: when a call arrives that a busy unit already at work could serve
 * next, add it to the end of the chain of the nearest such unit instead of
 * sending a free one from further away.
 */
export const addToEndOfNearestBusy = (name: string, atS: number): Beat => ({
  name,
  atS,
  plan: async context => {
    const [call] = context.callsCreatedAt(atS)
    if (call === undefined) throw new Error(`${name}: no call arrived at ${atS} s`)
    const busy = new Set((await context.recommend(call.id)).committed.map(entry => entry.unitId))
    const nearest = context.units().filter(unit => busy.has(unit.id) && isUnit(unit.packData) && unit.packData.phase === 'on-task')
      .sort((a, b) => metresBetween(lonLatOf(a), lonLatOf(call)) - metresBetween(lonLatOf(b), lonLatOf(call)))[0]
    if (nearest === undefined) throw new Error(`${name}: no busy unit could serve ${call.label}`)
    return [{ capabilityId: ids.queue, input: { unitId: nearest.id, to: { taskId: call.id } } }]
  },
})

/**
 * A beat: when two calls arrive together, give both to the unit recommended
 * for the first, in one chain, instead of sending a second unit: send it to
 * the first, then add the second to the end of its chain, as the Board's
 * taps do (the unit, the first call, + and the second call).
 */
export const chainBoth = (name: string, atS: number): Beat => ({
  name,
  atS,
  plan: async context => {
    const [first, second] = context.callsCreatedAt(atS)
    if (first === undefined || second === undefined) throw new Error(`${name}: two calls should arrive at ${atS} s`)
    const unitId = (await context.recommend(first.id)).proposal.units[0]?.unitId
    if (unitId === undefined) throw new Error(`${name}: no unit is recommended for ${first.label}`)
    return [
      { capabilityId: ids.send, input: { units: [unitId], to: { taskId: first.id } } },
      { capabilityId: ids.queue, input: { unitId, to: { taskId: second.id } } },
    ]
  },
})
