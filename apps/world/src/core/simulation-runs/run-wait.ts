import { z } from 'zod'
import {
  isoTimestampSchema, procedureRunIdSchema, simulationRunEventSchema,
  type ActorId, type IsoTimestamp, type ProcedureRunState, type SimulationRunEvent,
} from '../model/index.ts'

// Waiting in a caller's turn for a named change in a Simulation Run: a durable
// event, an amount of plant time, or someone else taking over a procedure Run
// the caller drives. Generic over the journal; it interprets no Pack's events.

export const runWaitMaxMs = 20_000
const maxReturnedEvents = 10

export const runWaitInputSchema = z.object({
  afterSequence: z.number().int().nonnegative().optional()
    .describe('Wait for changes after this journal sequence (a step read\'s sequence); omit to wait from now.'),
  maxWaitMs: z.number().int().min(1_000).max(runWaitMaxMs).default(runWaitMaxMs)
    .describe('Wall time to wait at most, in milliseconds.'),
  simulationSeconds: z.number().min(1).max(600).optional()
    .describe('Return once this much plant time has passed from now.'),
  events: z.array(z.object({
    type: z.string().min(1).max(80).describe('A durable event type, e.g. interaction.signal.received or procedure.run.driver.changed.'),
    procedureRunId: procedureRunIdSchema.optional().describe('Only events of this procedure Run.'),
    signalType: z.string().min(1).max(160).optional().describe('Only interaction signals of this type, e.g. process-plant.proposal.approved.'),
  }).strict()).min(1).max(8).optional()
    .describe('Return at the first durable event after afterSequence matching any of these.'),
  procedureRunId: procedureRunIdSchema.optional()
    .describe('A procedure Run whose current step the result carries as next, as world.procedure.run.step.read returns it.'),
}).strict().superRefine((input, context) => {
  if (input.simulationSeconds === undefined && input.events === undefined) {
    context.addIssue({ code: 'custom', path: ['simulationSeconds'], message: 'Name simulationSeconds, events, or both to wait for.' })
  }
})
export type RunWaitInput = z.infer<typeof runWaitInputSchema>

export const runWaitReasonSchema = z.enum(['event', 'simulation-time', 'driver-changed', 'clock-paused', 'timeout'])

export const runWaitResultSchema = z.object({
  reason: runWaitReasonSchema,
  /** The sequence the wait looked after: afterSequence, or the journal's when the wait began. */
  fromSequence: z.number().int().nonnegative(),
  sequence: z.number().int().nonnegative(),
  simulationTime: isoTimestampSchema,
  paused: z.literal(true).optional(),
  waitedMs: z.number().int().nonnegative(),
  /** A procedure Run the caller drove that someone else took over, released, closed or reset. */
  driverChanged: z.object({
    runId: procedureRunIdSchema,
    procedureId: z.string(),
    change: z.enum(['procedure.run.driver.changed', 'procedure.run.closed', 'procedure.run.reset']),
    by: z.string(),
    driver: z.object({ kind: z.enum(['ai', 'person']), label: z.string().optional() }).strict().optional(),
    status: z.string().optional(),
  }).strict().optional(),
  /** The matching events (and the driver change), at most ten. */
  events: z.array(simulationRunEventSchema).optional(),
  more: z.literal(true).optional(),
}).strict()
export type RunWaitResult = z.infer<typeof runWaitResultSchema>

export interface RunWaitPorts {
  /** Durable events after a sequence, as the caller may see them. */
  readonly events: (afterSequence: number) => ReadonlyArray<SimulationRunEvent>
  readonly sequence: () => number
  readonly clock: () => { readonly currentTime: IsoTimestamp; readonly paused: boolean }
  /** Wakes the wait when the Run commits events; returns the unsubscribe. */
  readonly subscribe: (wake: () => void) => () => void
  readonly now: () => number
  readonly schedule: (callback: () => void, delayMs: number) => () => void
  /** True once the Run is no longer loaded: deleted, its Workspace removed, or World stopping. */
  readonly closed: () => boolean
}

/** The Run closed under a wait; the wait ends at once instead of holding its caller until maxWaitMs. */
export const runClosedWhileWaiting = (): Error & { readonly code: 'simulation_run_closed' } =>
  Object.assign(new Error('The Simulation Run closed while waiting: it was deleted, its Workspace removed, or World is stopping'), { code: 'simulation_run_closed' as const })

/** The procedure Runs a caller drives or drove, to tell when someone else takes one over. */
export interface RunWaitDrivenRun {
  readonly runId: string
  readonly procedureId: string
  readonly sourceId: string
  readonly plantId: string
}

export const drivenRunsOf = (
  caller: ActorId,
  runs: ReadonlyArray<ProcedureRunState>,
  journal: ReadonlyArray<SimulationRunEvent>,
): ReadonlyArray<RunWaitDrivenRun> => {
  const drove = new Set(journal.flatMap(event => event.type === 'procedure.run.driver.changed' && event.driver?.actorId === caller ? [event.runId] : []))
  return runs
    .filter(run => run.driver?.actorId === caller || drove.has(run.runId))
    .map(run => ({ runId: run.runId, procedureId: run.procedureId, sourceId: run.sourceId, plantId: run.scope.plantId }))
}

const matches = (filter: NonNullable<RunWaitInput['events']>[number], event: SimulationRunEvent): boolean => {
  if (event.type !== filter.type) return false
  if (filter.procedureRunId !== undefined) {
    const runId = event.type === 'procedure.run.started' ? event.run.runId : 'runId' in event ? event.runId : undefined
    if (runId !== filter.procedureRunId) return false
  }
  if (filter.signalType !== undefined && (event.type !== 'interaction.signal.received' || event.signal.type !== filter.signalType)) return false
  return true
}

const takenOver = (caller: ActorId, driven: ReadonlyArray<RunWaitDrivenRun>, event: SimulationRunEvent): RunWaitResult['driverChanged'] => {
  if (event.type === 'procedure.run.driver.changed' && event.changedBy !== caller) {
    const run = driven.find(candidate => candidate.runId === event.runId)
    if (run === undefined || event.driver?.actorId === caller) return undefined
    return { runId: event.runId, procedureId: run.procedureId, change: event.type, by: event.changedBy,
      ...(event.driver === undefined ? {} : { driver: { kind: event.driver.kind, ...(event.driver.label === undefined ? {} : { label: event.driver.label }) } }) }
  }
  if (event.type === 'procedure.run.closed' && event.closedBy !== caller) {
    const run = driven.find(candidate => candidate.runId === event.runId)
    return run === undefined ? undefined : { runId: event.runId, procedureId: run.procedureId, change: event.type, by: event.closedBy, status: event.status }
  }
  if (event.type === 'procedure.run.reset' && event.resetBy !== caller) {
    const run = driven.find(candidate => candidate.sourceId === event.sourceId && candidate.procedureId === event.procedureId && candidate.plantId === event.scope.plantId)
    return run === undefined ? undefined : { runId: procedureRunIdSchema.parse(run.runId), procedureId: run.procedureId, change: event.type, by: event.resetBy }
  }
  return undefined
}

const tickMs = 250

/** Resolves at the first of: a matching event, the plant time, a take-over, a paused clock while waiting for plant time, or maxWaitMs; rejects when the Run closes. */
export const waitForRunChange = async (config: {
  readonly input: RunWaitInput
  readonly caller: ActorId
  readonly driven: ReadonlyArray<RunWaitDrivenRun>
  readonly ports: RunWaitPorts
}): Promise<RunWaitResult> => {
  const { input, ports } = config
  const startedAt = ports.now()
  const fromSequence = input.afterSequence ?? ports.sequence()
  const startClock = ports.clock()
  const targetMs = input.simulationSeconds === undefined ? undefined : Date.parse(startClock.currentTime) + input.simulationSeconds * 1_000
  let cursor = fromSequence
  const matched: SimulationRunEvent[] = []
  return await new Promise<RunWaitResult>((resolve, reject) => {
    let settled = false
    const cleanups: Array<() => void> = []
    const abandon = (): void => {
      if (settled) return
      settled = true
      for (const cleanup of cleanups.splice(0)) cleanup()
      reject(runClosedWhileWaiting())
    }
    const finish = (reason: RunWaitResult['reason'], extra: { readonly driverChanged?: RunWaitResult['driverChanged']; readonly events?: ReadonlyArray<SimulationRunEvent> } = {}): void => {
      if (settled) return
      settled = true
      for (const cleanup of cleanups.splice(0)) cleanup()
      const clock = ports.clock()
      const events = extra.events ?? []
      resolve(runWaitResultSchema.parse({
        reason,
        fromSequence,
        sequence: ports.sequence(),
        simulationTime: clock.currentTime,
        ...(clock.paused ? { paused: true } : {}),
        waitedMs: Math.max(0, Math.round(ports.now() - startedAt)),
        ...(extra.driverChanged === undefined ? {} : { driverChanged: extra.driverChanged }),
        ...(events.length === 0 ? {} : { events: events.slice(0, maxReturnedEvents) }),
        ...(events.length > maxReturnedEvents ? { more: true } : {}),
      }))
    }
    const check = (): void => {
      if (settled) return
      if (ports.closed()) return abandon()
      const fresh = ports.events(cursor)
      if (fresh.length > 0) cursor = fresh.at(-1)!.seq
      for (const event of fresh) {
        const driverChanged = takenOver(config.caller, config.driven, event)
        if (driverChanged !== undefined) return finish('driver-changed', { driverChanged, events: [event] })
        if (input.events?.some(filter => matches(filter, event)) === true) matched.push(event)
      }
      if (matched.length > 0) return finish('event', { events: matched })
      if (targetMs !== undefined) {
        const clock = ports.clock()
        if (clock.paused) return finish('clock-paused')
        if (Date.parse(clock.currentTime) >= targetMs) return finish('simulation-time')
      }
      if (ports.now() - startedAt >= input.maxWaitMs) return finish('timeout')
    }
    // Plant time passes without events; a short wall tick watches the clock.
    let cancelTick = (): void => {}
    const tick = (): void => {
      check()
      if (!settled) cancelTick = ports.schedule(tick, tickMs)
    }
    cleanups.push(() => cancelTick())
    cleanups.push(ports.subscribe(check))
    cleanups.push(ports.schedule(() => ports.closed() ? abandon() : finish('timeout'), input.maxWaitMs))
    tick()
  })
}
