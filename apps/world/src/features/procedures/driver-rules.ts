import type { ActorId, IsoTimestamp, ProcedureBranch, ProcedureRunDriver, ProcedureRunState, ProcedureStep } from '../../core/model/index.ts'
import type { ProcedureTagRead } from './pack-observations.ts'

// Who may work a procedure Run, and which decisions an AI agent may take on
// it. The AI keeps place and advances only along an authored normal branch to
// another step of the same procedure, on readable evidence; a person selects
// every other branch, resets, and takes over by acting. World enforces these
// at commit; the step read reports the same verdicts from the same functions.

/** Who issues a procedure command: an AI agent, a person, or the Run itself (its Scenario timeline). */
export type ProcedureActorKind = 'ai' | 'person' | 'system'

export type ProcedureBranchVerdict =
  | { readonly aiMaySelect: true }
  | { readonly aiMaySelect: false; readonly personOnlyReason: string }

const personOnly = (personOnlyReason: string): ProcedureBranchVerdict => ({ aiMaySelect: false, personOnlyReason })

// What makes a branch a person's: its authored outcome and where it leads.
const personBranchKind = (branch: ProcedureBranch): string | null => {
  const words = [
    ...(branch.outcome === 'rno' ? ['RNO'] : branch.outcome === 'unknown' ? ['unknown-outcome'] : branch.outcome === undefined ? ['unlabelled'] : []),
    ...(branch.targetKind === 'step' ? [] : branch.targetKind === 'procedure' ? ['transfer'] : branch.targetKind === 'end' ? ['END'] : [branch.targetKind]),
  ]
  return words.length === 0 ? null : words.join(' ')
}

const withArticle = (words: string): string => `${/^(?:[aeiou]|RNO)/i.test(words) ? 'an' : 'a'} ${words}`

/**
 * Whether an AI agent may select this branch now, and why not where it may not.
 * `readableTagIds`: the step's tags World read a value for, where they were read.
 */
export const procedureBranchVerdict = (config: {
  readonly run: Pick<ProcedureRunState, 'status' | 'currentStepId'>
  readonly step: ProcedureStep
  readonly branch: ProcedureBranch
  readonly readableTagIds?: ReadonlySet<string>
}): ProcedureBranchVerdict => {
  const { run, step, branch } = config
  const kind = personBranchKind(branch)
  if (kind !== null) return personOnly(`"${branch.label} → ${branch.target}" is ${withArticle(kind)} branch: a person selects it in the procedure window.`)
  if (run.status !== 'active') return personOnly(`The procedure run is ${run.status}; no branch of it can be selected.`)
  if (run.currentStepId !== step.id) {
    return personOnly(`Step ${step.label} is not the run's current step${run.currentStepId === undefined ? '' : ` (${run.currentStepId})`}: an AI agent works only the current step.`)
  }
  if (step.tagIds.length === 0) return personOnly(`Step ${step.label} cites no plant tag World can read: a person decides this step.`)
  if (config.readableTagIds !== undefined && !step.tagIds.some(tagId => config.readableTagIds!.has(tagId))) {
    return personOnly(`None of step ${step.label}'s tags can be read on this plant now: a person decides this step.`)
  }
  return { aiMaySelect: true }
}

const runName = (run: ProcedureRunState): string => `${run.procedureId} on ${run.scope.label ?? run.scope.plantId}`

const drivenBy = (run: ProcedureRunState, driver: ProcedureRunDriver): Error => driver.kind === 'person'
  ? new Error(`A person${driver.label === undefined ? '' : ` (${driver.label})`} drives ${runName(run)} since ${driver.since}: an AI agent only reads it until a person hands it back. Report where the procedure stands and what you would do next.`)
  : new Error(`${driver.label ?? driver.actorId}, another AI agent, drives ${runName(run)} since ${driver.since}: an AI agent changes it only after that agent or a person releases it.`)

/** An AI agent may take a Run nobody drives or one it drives already. */
export const assertAiMayDrive = (run: ProcedureRunState, actorId: ActorId): void => {
  if (run.driver === undefined || (run.driver.kind === 'ai' && run.driver.actorId === actorId)) return
  throw drivenBy(run, run.driver)
}

/** An AI agent changes only a Run it drives. */
export const assertAiDrives = (run: ProcedureRunState, actorId: ActorId): void => {
  if (run.driver === undefined) {
    throw new Error(`Nobody drives ${runName(run)}: claim it with world.procedure.run.drive {"runId":"${run.runId}","action":"claim"} before changing it.`)
  }
  assertAiMayDrive(run, actorId)
}

export const aiResetRefusal = (): Error =>
  new Error('A person resets procedure runs; an AI agent never resets one. Ask the operator to reset it in the procedure window if it must start again.')

export const aiStepCommentLimit = 500

/** An AI agent answers a step by selecting a branch; on a step it records only a comment. */
export const assertAiStepUpdate = (update: {
  readonly assessment?: unknown
  readonly comment?: string
  readonly favorite?: unknown
  readonly currentStepId?: unknown
}): void => {
  if (update.assessment !== undefined || update.favorite !== undefined || update.currentStepId !== undefined) {
    throw new Error('An AI agent records only a comment on a step: it answers a step by selecting a branch (world.procedure.run.transition), and a person changes ticks, favorites and the current step.')
  }
  if (update.comment !== undefined && update.comment.length > aiStepCommentLimit) {
    throw new Error(`An AI agent's step comment is at most ${aiStepCommentLimit} characters.`)
  }
}

/** An AI agent's selection rests on a stated basis and on the step's own tags, each read by World now. */
export const assertAiDecisionEvidence = (config: {
  readonly step: ProcedureStep
  readonly basis?: string
  readonly evidenceTagIds?: ReadonlyArray<string>
  readonly reads: ReadonlyArray<ProcedureTagRead>
}): void => {
  const { step } = config
  if (config.basis === undefined) {
    throw new Error('An AI agent selects a branch only with a basis: the criterion, the values read with units and plant time, and what could not be observed (at most 300 characters).')
  }
  if (config.evidenceTagIds === undefined) {
    throw new Error(`An AI agent cites 1 to 6 of step ${step.label}'s tags as evidenceTagIds (${step.tagIds.join(', ')}); World reads them and records the readings with the decision.`)
  }
  for (const read of config.reads) {
    if (read.binding === 'missing') throw new Error(`«${read.tagId}» is not in the plant model: a person decides step ${step.label} in the procedure window.`)
    if (read.value === undefined) throw new Error(`«${read.tagId}» could not be read (${read.unavailable ?? 'no value'}): a person decides step ${step.label} in the procedure window.`)
  }
}

export const procedureDriver = (config: {
  readonly kind: 'ai' | 'person'
  readonly actorId: ActorId
  readonly label?: string
  readonly since: IsoTimestamp
}): ProcedureRunDriver => ({
  kind: config.kind,
  actorId: config.actorId,
  ...(config.label === undefined ? {} : { label: config.label }),
  since: config.since,
})

export const sameProcedureDriver = (left: ProcedureRunDriver | undefined, right: ProcedureRunDriver | undefined): boolean =>
  left?.kind === right?.kind && left?.actorId === right?.actorId
