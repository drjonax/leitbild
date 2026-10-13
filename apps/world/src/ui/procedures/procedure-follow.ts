import type { ObjectId, ProcedureId, ProcedureRunId, ProcedureRunState, ProcedureStepId } from '../../core/model/index.ts'
import type { SimulationRunEventPayload } from '../simulation-run-events.ts'
import { procedureActorIsAi, procedureRunFor } from './procedure-run-selectors.ts'

// A procedure window follows a Run an AI agent drives: it scrolls to the Run's
// new current step and goes on to the procedure a transfer hands the Run to,
// as the person's own confirmed transfer would. It moves only once the person
// has left the window alone for a few seconds, and never takes focus. A Run a
// person drives, or nobody does, moves only when someone moves it. A Run an AI
// agent starts live opens its unit's procedure window on it, once per start.

/** How long a window waits after the person's last pointer, wheel, touch or key in it before it moves by itself. */
export const procedureFollowIdleMs = 4_000

/** What a window last showed of its document's Run on its unit; an AI agent's move is the difference. */
export interface ProcedureFollowMark {
  /** The document and unit shown, as `procedureViewKey` writes them. */
  readonly documentKey: string
  readonly runId: ProcedureRunId | null
  readonly status: ProcedureRunState['status'] | null
  readonly stepId: ProcedureStepId | null
}

export const procedureFollowMark = (documentKey: string, run: ProcedureRunState | null): ProcedureFollowMark => ({
  documentKey,
  runId: run?.runId ?? null,
  status: run?.status ?? null,
  stepId: run?.currentStepId ?? null,
})

export type ProcedureFollowAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'scroll'; readonly stepId: ProcedureStepId }
  | { readonly kind: 'show'; readonly run: ProcedureRunState }
  | { readonly kind: 'wait'; readonly delayMs: number }

type ProcedureFollowMove = Exclude<ProcedureFollowAction, { readonly kind: 'wait' }>

const stay: ProcedureFollowMove = { kind: 'none' }

const aiDrives = (run: ProcedureRunState): boolean => run.status === 'active' && run.driver?.kind === 'ai'

/**
 * The Run a transfer handed an AI-driven Run to: the procedure its current
 * step's decision named, on the same unit, where it is active and an AI agent
 * drives it too. Null for every other Run, and for a destination a person drives.
 */
export const procedureTransferDestination = (
  runs: ReadonlyArray<ProcedureRunState>,
  run: ProcedureRunState,
): ProcedureRunState | null => {
  if (run.status !== 'transferred' || run.driver?.kind !== 'ai' || run.currentStepId === undefined) return null
  const decision = run.stepStates.find(state => state.stepId === run.currentStepId)?.decision
  if (decision?.targetKind !== 'procedure') return null
  const destination = procedureRunFor(runs, { sourceId: run.sourceId, procedureId: decision.target, scope: run.scope })
  return destination !== null && aiDrives(destination) ? destination : null
}

/**
 * What a window does by itself now. Asked to show a Run an AI agent started on
 * its unit, it shows it, or scrolls to its current step where it shows it
 * already. Its own Run, transferred by an AI agent since the window last looked,
 * leads it to the destination; an AI-driven Run whose current step moved, or
 * that an AI agent started on the document shown, scrolls it there. Changes from
 * this window's own write, a document or unit it just loaded, and Runs a person
 * drives or shares move nothing. Every move waits until the person has left the
 * window alone for `idleMs`.
 */
export const procedureFollowAction = (config: {
  readonly runs: ReadonlyArray<ProcedureRunState>
  /** The document shown, by `procedureViewKey`, and its Run on the window's unit. */
  readonly shown: { readonly documentKey: string; readonly run: ProcedureRunState | null }
  readonly mark: ProcedureFollowMark | null
  /** A Run on the window's unit an AI agent started, which the route asked this window to show. */
  readonly request: ProcedureRunState | null
  /** A write of this window's own is on its way: what changes meanwhile is its own doing. */
  readonly ownWrite: boolean
  /** Milliseconds since the person last pointed, wheeled, touched or typed in the window. */
  readonly idleForMs: number
  readonly idleMs?: number
}): ProcedureFollowAction => {
  const move = procedureFollowMove(config)
  const idleMs = config.idleMs ?? procedureFollowIdleMs
  return move.kind !== 'none' && config.idleForMs < idleMs ? { kind: 'wait', delayMs: idleMs - config.idleForMs } : move
}

const procedureFollowMove = (config: Parameters<typeof procedureFollowAction>[0]): ProcedureFollowMove => {
  const { request, shown, mark } = config
  if (request !== null) {
    if (!aiDrives(request)) return stay
    if (shown.run?.runId !== request.runId) return { kind: 'show', run: request }
    return request.currentStepId === undefined ? stay : { kind: 'scroll', stepId: request.currentStepId }
  }
  const run = shown.run
  if (config.ownWrite || mark === null || mark.documentKey !== shown.documentKey || run === null) return stay
  if (mark.runId === run.runId && mark.status === 'active' && run.status === 'transferred') {
    const destination = procedureTransferDestination(config.runs, run)
    return destination === null ? stay : { kind: 'show', run: destination }
  }
  if (!aiDrives(run) || run.currentStepId === undefined) return stay
  return mark.runId === run.runId && mark.stepId === run.currentStepId ? stay : { kind: 'scroll', stepId: run.currentStepId }
}

/** A procedure window the route keeps open for a unit. */
export interface ProcedureSystemWindowEntry {
  readonly id: string
  readonly objectId: ObjectId
  readonly initialProcedureId?: ProcedureId
  /** Counts how often the unit's procedures were opened again; each raises and focuses the open window. */
  readonly focusRequest?: number
  /** The Run an AI agent last started on the unit: the open window shows it, neither raised nor focused. A new object per start. */
  readonly aiStart?: { readonly runId: ProcedureRunId }
}

/**
 * The procedure Runs an AI agent started or resumed in one committed batch:
 * one whose start or resume made an AI agent its driver, or that an AI agent
 * resumed while still driving it. Each is shown once in its unit's procedure
 * window. A batch that closes a Run as transferred hands that Run's driver on
 * to its destination; the window showing the source follows it there
 * (`procedureFollowAction`), so a transfer opens no window.
 */
export const procedureAiStartedRunIds = (events: ReadonlyArray<SimulationRunEventPayload>): ReadonlyArray<ProcedureRunId> => {
  const lifecycle = events.flatMap(event => event.procedureRun === undefined ? [] : [event.procedureRun])
  if (lifecycle.some(event => event.type === 'procedure.run.closed' && event.status === 'transferred')) return []
  const aiDriven = new Set(lifecycle.flatMap(event => event.type === 'procedure.run.driver.changed'
    && event.reason === 'started' && event.driver?.kind === 'ai' ? [event.runId] : []))
  return lifecycle.flatMap(event => {
    if (event.type === 'procedure.run.started') return aiDriven.has(event.run.runId) ? [event.run.runId] : []
    if (event.type === 'procedure.run.resumed') return aiDriven.has(event.runId) || procedureActorIsAi(event.resumedBy) ? [event.runId] : []
    return []
  })
}

/**
 * What a Run read settles of the AI starts awaiting it: each Run it holds is
 * settled, and shown while it is active and an AI agent drives it. A start
 * whose Run the read lacks waits for the next read.
 */
export const procedureAiStartsRead = (
  runs: ReadonlyArray<ProcedureRunState>,
  awaited: ReadonlySet<ProcedureRunId>,
): { readonly settled: ReadonlyArray<ProcedureRunId>; readonly show: ReadonlyArray<ProcedureRunState> } => {
  const read = runs.filter(run => awaited.has(run.runId))
  return { settled: read.map(run => run.runId), show: read.filter(aiDrives) }
}

/**
 * The procedure windows once an AI agent's Run on a unit is shown: the unit's
 * open window shows it in place, neither raised nor focused, else a new window
 * opens on it. A window the person closed opens again only for a later start.
 */
export const procedureWindowsShowingAiStart = (
  windows: ReadonlyArray<ProcedureSystemWindowEntry>,
  config: { readonly objectId: ObjectId; readonly run: ProcedureRunState; readonly newWindowId: () => string },
): ReadonlyArray<ProcedureSystemWindowEntry> => {
  const open = windows.find(entry => entry.objectId === config.objectId)
  if (open) return windows.map(entry => entry === open ? { ...entry, aiStart: { runId: config.run.runId } } : entry)
  return [...windows, { id: config.newWindowId(), objectId: config.objectId, initialProcedureId: config.run.procedureId }]
}
