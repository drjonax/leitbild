import { sameProcedureScope } from '../../core/model/index.ts'
import type {
  ProcedureBranch,
  ProcedureDocument,
  ProcedureId,
  ProcedureRunScope,
  ProcedureRunState,
  ProcedureSourceId,
  ProcedureStep,
  ProcedureStepDecision,
} from '../../core/model/index.ts'

export type ProcedureRunVisualState = 'idle' | 'active' | 'transferred' | 'completed'

export interface ProcedureRunStepProgress {
  readonly stepId: string
  readonly label: string
  readonly name: string
}

export interface ProcedureRunCurrentStep {
  readonly step: ProcedureStep
  readonly progress: ProcedureRunStepProgress
}

export interface ProcedureRunSummary {
  readonly run: ProcedureRunState
  readonly procedureId: ProcedureId
  readonly title: string
  readonly status: Extract<ProcedureRunState['status'], 'active' | 'transferred' | 'completed'>
  readonly step: ProcedureRunStepProgress | null
}

export interface ProcedureRunSummaryGroup {
  readonly active: ReadonlyArray<ProcedureRunSummary>
  readonly inactive: ReadonlyArray<ProcedureRunSummary>
}

export const procedureRunDocumentKey = (run: Pick<ProcedureRunState, 'sourceId' | 'sourceRevision' | 'sourcePath' | 'procedureId'>): string =>
  `${run.sourceId}:${run.sourceRevision}:${run.sourcePath}:${run.procedureId}`

/** A machine id as words: "verify-reactor-trip" reads "Verify reactor trip". */
export const procedureHumanisedId = (id: string): string => {
  const words = id.split(/[-_\s]+/).filter(word => word.length > 0).join(' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** A step's name: its authored title, else its id in words when the heading only numbered it. */
export const procedureStepDisplayName = (step: ProcedureStep): string => {
  const fallback = `Step ${step.label}`
  return step.title.trim() === fallback ? procedureHumanisedId(step.id) : step.title
}

export const procedureStepHoverLabel = (step: ProcedureStep): string =>
  `Step ${step.label}: ${procedureStepDisplayName(step)}`

export const procedureStepById = (
  document: ProcedureDocument,
  stepId: string,
): ProcedureStep | null =>
  document.steps.find(step => step.id === stepId) ?? null

export const procedureFirstStep = (
  document: ProcedureDocument,
): ProcedureStep | null =>
  document.steps[0] ?? null

export const procedureStepReferenceText = (
  document: ProcedureDocument,
  step: ProcedureStep,
): string =>
  `${document.procedureId}, step ${step.label}: ${procedureStepDisplayName(step)}`

const progressForStep = (step: ProcedureStep): ProcedureRunStepProgress => ({
  stepId: step.id,
  label: step.label,
  name: procedureStepDisplayName(step),
})

export const procedureBranchActionText = (config: {
  readonly currentDocument: ProcedureDocument
  readonly branch: ProcedureBranch
  readonly targetDocument?: ProcedureDocument
}): string => {
  if (config.branch.targetKind === 'step') {
    const targetStep = procedureStepById(config.currentDocument, config.branch.target)
    return targetStep
      ? `Go to ${procedureStepReferenceText(config.currentDocument, targetStep)}`
      : `Go to ${config.currentDocument.procedureId}, step ?: ${config.branch.target}`
  }

  if (config.branch.targetKind === 'procedure') {
    const targetStep = config.targetDocument ? config.branch.targetStepId
      ? procedureStepById(config.targetDocument, config.branch.targetStepId)
      : procedureFirstStep(config.targetDocument) : null
    return targetStep && config.targetDocument
      ? `Go to ${procedureStepReferenceText(config.targetDocument, targetStep)}`
      : `Go to ${config.branch.target}, step ${config.branch.targetStepId ?? '1'}`
  }

  return config.branch.target
}

/** What a confirmation for a branch on a step that is not the Run's current step says, and its action. */
export interface ProcedureOffPathConfirmation {
  readonly title: string
  readonly body: string
  readonly action: string
}

/**
 * A branch on another step than the current one moves the Run off its path:
 * the confirmation names where the Run stands and where the branch takes it.
 */
export const procedureOffPathConfirmation = (config: {
  readonly document: ProcedureDocument
  readonly current: ProcedureStep
  readonly from: ProcedureStep
  readonly branch: ProcedureBranch
}): ProcedureOffPathConfirmation => {
  const { document, current, from, branch } = config
  const procedure = document.procedureId
  const decision = `Selecting “${branch.label}” on step ${from.label} records that decision`
  if (branch.targetKind === 'step') {
    const target = procedureStepById(document, branch.target)
    const label = target?.label ?? branch.target
    return {
      title: `Move ${procedure} from step ${current.label} to step ${label}?`,
      body: `${decision} and makes step ${label}${target ? ` (${procedureStepDisplayName(target)})` : ''} the current step.`,
      action: `Move ${procedure} to step ${label}`,
    }
  }
  if (branch.targetKind === 'retry') {
    return {
      title: `Move ${procedure} from step ${current.label} back to step ${from.label}?`,
      body: `${decision} and makes step ${from.label} the current step again.`,
      action: `Move ${procedure} to step ${from.label}`,
    }
  }
  const verb = branch.targetKind === 'abort' ? 'Abort' : 'End'
  return {
    title: `${verb} ${procedure} from step ${from.label}? It is at step ${current.label}.`,
    body: `${decision} and closes ${procedure} although its current step is ${current.label}.`,
    action: `${verb} ${procedure}`,
  }
}

export const procedureRunFor = (
  runs: ReadonlyArray<ProcedureRunState>,
  config: {
    readonly sourceId?: ProcedureSourceId
    readonly procedureId: ProcedureId
    readonly scope: ProcedureRunScope
  },
): ProcedureRunState | null => {
  const candidates = runs.filter(run =>
    run.procedureId === config.procedureId
      && (config.sourceId === undefined || run.sourceId === config.sourceId)
      && sameProcedureScope(run.scope, config.scope),
  )
  return candidates.find(run => run.status === 'active')
    ?? candidates.find(run => run.status === 'transferred')
    ?? candidates.find(run => run.status === 'completed')
    ?? null
}

export const procedureRunVisualStateFor = (
  runs: ReadonlyArray<ProcedureRunState>,
  config: {
    readonly sourceId?: ProcedureSourceId
    readonly procedureId: ProcedureId
    readonly scope: ProcedureRunScope
  },
): ProcedureRunVisualState => {
  const run = procedureRunFor(runs, config)
  if (run?.status === 'active') return 'active'
  if (run?.status === 'transferred') return 'transferred'
  if (run?.status === 'completed') return 'completed'
  return 'idle'
}

export const furthestTouchedStep = (
  run: ProcedureRunState,
  document: ProcedureDocument | undefined,
): ProcedureRunStepProgress | null => {
  const touchedStepIds = new Set(run.stepStates
    .filter(step => step.assessment !== 'blank')
    .map(step => step.stepId))
  if (touchedStepIds.size === 0) return null
  if (!document) {
    const lastTouched = findLast(run.stepStates, step => step.assessment !== 'blank')
    return lastTouched ? { stepId: lastTouched.stepId, label: lastTouched.stepId, name: lastTouched.stepId } : null
  }
  const furthest = findLast(document.steps, step => touchedStepIds.has(step.id))
  return furthest ? progressForStep(furthest) : null
}

export const procedureCurrentStep = (
  run: ProcedureRunState,
  document: ProcedureDocument | undefined,
): ProcedureRunCurrentStep | null => {
  if (!document) return null
  if (run.currentStepId !== undefined) {
    const currentStep = procedureStepById(document, run.currentStepId)
    if (currentStep) return { step: currentStep, progress: progressForStep(currentStep) }
  }
  const furthest = furthestTouchedStep(run, document)
  if (furthest !== null) {
    const step = procedureStepById(document, furthest.stepId)
    if (step) return { step, progress: furthest }
  }
  const firstStep = procedureFirstStep(document)
  return firstStep && run.status === 'active'
    ? { step: firstStep, progress: progressForStep(firstStep) }
    : null
}

export const procedureRunSummaryFor = (
  run: ProcedureRunState,
  document: ProcedureDocument | undefined,
): ProcedureRunSummary | null => {
  if (run.status !== 'active' && run.status !== 'transferred' && run.status !== 'completed') return null
  return {
    run,
    procedureId: run.procedureId,
    title: document?.title ?? run.title,
    status: run.status,
    step: procedureCurrentStep(run, document)?.progress ?? furthestTouchedStep(run, document),
  }
}

export const procedureRunSummariesForScope = (
  runs: ReadonlyArray<ProcedureRunState>,
  scope: ProcedureRunScope,
  documents: ReadonlyMap<string, ProcedureDocument>,
): ProcedureRunSummaryGroup => {
  const summaries = runs
    .filter(run => sameProcedureScope(run.scope, scope))
    .map(run => procedureRunSummaryFor(run, documents.get(procedureRunDocumentKey(run))))
    .filter((summary): summary is ProcedureRunSummary => summary !== null)
  return {
    active: summaries.filter(summary => summary.status === 'active'),
    inactive: summaries.filter(summary => summary.status === 'completed' || summary.status === 'transferred'),
  }
}

export const procedureRunSummaryText = (summary: ProcedureRunSummary): string =>
  `${summary.procedureId}:${summary.step?.label ?? '-'}`

export const procedureRunSummaryTitle = (summary: ProcedureRunSummary): string =>
  `${summary.procedureId} - ${summary.title}\n${summary.status}\nStep ${summary.step?.label ?? '-'}: ${summary.step?.name ?? 'not started'}${
    summary.run.driver?.kind === 'ai' ? `\nDriven by AI: ${procedureActorLabel(summary.run.driver.actorId, summary.run.driver.label)}` : ''}`

/** An AI agent's actor id; World gives every AI actor this prefix. */
export const procedureActorIsAi = (actorId: string): boolean => actorId.startsWith('actor:ai:')

/** Who an actor is in the window: the name the request carried, else "AI" or the id's last part. */
export const procedureActorLabel = (actorId: string, label?: string): string => {
  if (label !== undefined) return label
  if (procedureActorIsAi(actorId)) return 'AI'
  const name = actorId.split(':').at(-1) ?? actorId
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/** A Run timestamp as the plant clock writes it ("10:14:45", or "10:14"): the Run's clock is UTC. */
export const procedurePlantTime = (iso: string, precision: 'seconds' | 'minutes' = 'seconds'): string => {
  const time = /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2})(:\d{2})/.exec(iso)
  if (!time) throw new Error(`procedure time is not an ISO timestamp: ${iso}`)
  return precision === 'minutes' ? time[1]! : `${time[1]}${time[2]}`
}

/** Who drives an active Run, as the window's driver band says it. */
export interface ProcedureDriverView {
  readonly kind: 'ai' | 'person'
  readonly label: string
  /** When the driver took the Run, as the Run's UTC clock writes it. */
  readonly since: string
  /** Steps whose latest decision the driving AI made. */
  readonly aiSteps: number
  /** The AI a person driving can hand the Run back to: the latest AI that decided a step. */
  readonly handBackTo: string | null
}

export const procedureDriverView = (run: ProcedureRunState | null): ProcedureDriverView | null => {
  const driver = run?.status === 'active' ? run.driver : undefined
  if (!run || !driver) return null
  const decisions = run.stepStates.flatMap(state => state.decision === undefined ? [] : [state.decision])
  const latestAi = decisions.filter(decision => procedureActorIsAi(decision.selectedBy))
    .sort((left, right) => left.simulationTime.localeCompare(right.simulationTime)).at(-1)
  return {
    kind: driver.kind,
    label: procedureActorLabel(driver.actorId, driver.label),
    since: procedurePlantTime(driver.since, 'minutes'),
    aiSteps: driver.kind === 'ai' ? decisions.filter(decision => decision.selectedBy === driver.actorId).length : 0,
    handBackTo: latestAi === undefined ? null : procedureActorLabel(latestAi.selectedBy, latestAi.selectedByLabel),
  }
}

/** Where a decision led, as short as a summary row needs: a step number, a procedure, or END. */
export const procedureDecisionTargetText = (document: ProcedureDocument, decision: ProcedureStepDecision): string =>
  decision.targetKind === 'step' ? procedureStepById(document, decision.target)?.label ?? decision.target : decision.target

/** How a taken branch is coloured: by its declared outcome, or plainly taken where it declares none. */
export const procedureDecisionTone = (decision: ProcedureStepDecision): 'normal' | 'rno' | 'unknown' | 'taken' =>
  decision.outcome ?? 'taken'

/**
 * One row of the procedure document. The current step and open steps show in full;
 * a decided step folds to its summary; untouched steps a branch jumped over fold into one row.
 */
export type ProcedureStepRow =
  | { readonly kind: 'step'; readonly step: ProcedureStep; readonly role: 'current' | 'decided' | 'open' }
  | {
    readonly kind: 'bypassed'
    readonly steps: ReadonlyArray<ProcedureStep>
    readonly from: ProcedureStep
    readonly to: ProcedureStep
  }

export const procedureStepRows = (
  document: ProcedureDocument,
  run: ProcedureRunState | null,
): ReadonlyArray<ProcedureStepRow> => {
  const states = new Map((run?.stepStates ?? []).map(state => [state.stepId, state]))
  const currentId = run?.status === 'active' ? procedureCurrentStep(run, document)?.step.id : undefined
  const indexById = new Map(document.steps.map((step, index) => [step.id, index]))
  const rows: ProcedureStepRow[] = []
  let jump: { readonly from: ProcedureStep; readonly toIndex: number } | undefined
  let bypassed: ProcedureStep[] = []
  const flush = (): void => {
    if (bypassed.length > 0 && jump) rows.push({ kind: 'bypassed', steps: bypassed, from: jump.from, to: document.steps[jump.toIndex]! })
    bypassed = []
  }
  document.steps.forEach((step, index) => {
    if (jump && index >= jump.toIndex) { flush(); jump = undefined }
    const state = states.get(step.id)
    const touched = state !== undefined && (state.decision !== undefined || state.assessment !== 'blank')
    if (jump && !touched && step.id !== currentId) {
      bypassed.push(step)
      return
    }
    flush()
    rows.push({ kind: 'step', step, role: step.id === currentId ? 'current' : state?.decision ? 'decided' : 'open' })
    const decision = state?.decision
    const target = decision?.targetKind === 'step' ? indexById.get(decision.target) : undefined
    if (target !== undefined && target > index + 1) jump = { from: step, toIndex: target }
  })
  flush()
  return rows
}

/** Step labels as short ranges in document order: "5–10, 12". */
export const procedureStepRangeText = (steps: ReadonlyArray<ProcedureStep>, document: ProcedureDocument): string => {
  const indices = steps.map(step => document.steps.indexOf(step)).filter(index => index >= 0).sort((left, right) => left - right)
  const ranges: Array<[number, number]> = []
  for (const index of indices) {
    const last = ranges.at(-1)
    if (last && index === last[1] + 1) last[1] = index
    else ranges.push([index, index])
  }
  return ranges.map(([start, end]) => start === end
    ? document.steps[start]!.label
    : `${document.steps[start]!.label}–${document.steps[end]!.label}`).join(', ')
}

const findLast = <T>(
  values: ReadonlyArray<T>,
  predicate: (value: T) => boolean,
): T | undefined => {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index]
    if (value !== undefined && predicate(value)) return value
  }
  return undefined
}
