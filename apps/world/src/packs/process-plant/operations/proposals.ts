import { z } from 'zod'
import {
  processSignalTagIdSchema,
  processVariableValueSchema,
  variablePathSchema,
  type ProcessSignalTagId,
  type ProcessVariableValue,
  type VariablePath,
} from '../graph/index.ts'
import { operationConsequenceSchema, type OperationConsequence } from './consequence.ts'

// A proposal is an exact command an AI or a person asks a person to approve:
// the one write World validated when it was proposed, with the proposer's
// reason and the published readings it cites as evidence. Approval executes
// that stored write, validated again, under the approver's own command; World
// never regenerates it from the proposer's text. A proposal lapses at a fixed
// plant time, extended once only by a person's explicit command (plan QA-9),
// never by a read; it never lapses within a minute of wall time, so a Run at
// maximum pace leaves a person time to decide. These are pure transitions on
// the Plant's proposal book; the Pack adapter persists the book and journals
// each transition as a durable Run event.

/** Plant time a proposal stands for unless a person extends it (plan §4.4). */
export const PROPOSAL_LIFETIME_MS = 120_000
/** The one extension a person may give it. */
export const PROPOSAL_EXTENSION_MS = 60_000
/** Wall time a proposal stands at least, whatever the Run's pace. */
export const PROPOSAL_WALL_FLOOR_MS = 60_000
export const PROPOSAL_REASON_MAX_LENGTH = 300
export const PROPOSAL_PROCEDURE_STEP_MAX_LENGTH = 120
export const PROPOSAL_EVIDENCE_MAX = 6
/** Closed proposals the book keeps for the operations log; open ones are never dropped. */
export const CLOSED_PROPOSALS_KEPT = 32

/** Who a command comes from, as core tells the Pack from the caller's actor: a person, an AI agent, or the Run itself (scenario, automation). */
export const operationOriginSchema = z.enum(['person', 'ai', 'system'])
export type OperationOrigin = z.infer<typeof operationOriginSchema>

export const proposalStatusSchema = z.enum(['pending', 'approved', 'rejected', 'expired', 'superseded', 'withdrawn'])
export type ProposalStatus = z.infer<typeof proposalStatusSchema>

export const processPlantProposalSchema = z.object({
  /** The id of the command that proposed it. */
  id: z.string().min(1),
  plantId: z.string().min(1),
  /** The exact write approval executes; or, for an actuation reset, the actuation it resets (operations/actuation-reset.ts). */
  write: z.object({ path: variablePathSchema, value: processVariableValueSchema }).strict().optional(),
  /** The actuation, and the commands its effects wrote: the QA-2 hold on them lifts with the reset. */
  reset: z.object({ ruleId: z.string().min(1), label: z.string().min(1), holds: z.array(variablePathSchema) }).strict().optional(),
  /** The drawn item that offers the control (controls.ts), where a person reviews it. */
  item: z.string().min(1),
  /** The control's word for the write ("SHUT", "THROTTLE to 40 %"). */
  word: z.string().min(1),
  /** What it takes away, as the Plant stood when it was proposed (consequence.ts); absent for an operation that stops, shuts or throttles nothing. */
  consequence: operationConsequenceSchema.optional(),
  reason: z.string().min(1).max(PROPOSAL_REASON_MAX_LENGTH),
  procedureStep: z.string().min(1).max(PROPOSAL_PROCEDURE_STEP_MAX_LENGTH).optional(),
  /** The published readings it cites, as they read when it was proposed. */
  evidence: z.array(z.object({ tagId: processSignalTagIdSchema, path: variablePathSchema, value: processVariableValueSchema }).strict()).min(1).max(PROPOSAL_EVIDENCE_MAX),
  proposer: z.object({ actorId: z.string().min(1), origin: z.enum(['person', 'ai']) }).strict(),
  proposedAtElapsedMs: z.number().finite().nonnegative(),
  proposedAtWallMs: z.number().finite().nonnegative(),
  expiresAtElapsedMs: z.number().finite().nonnegative(),
  extended: z.boolean(),
  status: proposalStatusSchema,
  /** How it closed: when, the actor and command that closed it, and why. */
  closed: z.object({
    atElapsedMs: z.number().finite().nonnegative(),
    actorId: z.string().min(1).optional(),
    commandId: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
  }).strict().optional(),
}).strict().refine(proposal => (proposal.write === undefined) !== (proposal.reset === undefined), { message: 'a proposal is either a write or an actuation reset' })
export type ProcessPlantProposal = z.infer<typeof processPlantProposalSchema>

/** What a proposal operates, so proposals on the same thing supersede each other: a command's path, or an actuation's reset. */
type ProposalTarget = { readonly path: VariablePath } | { readonly ruleId: string }

const targetKey = (target: ProposalTarget): string => 'path' in target ? `write:${target.path}` : `reset:${target.ruleId}`

const proposalTarget = (proposal: Pick<ProcessPlantProposal, 'write' | 'reset'>): ProposalTarget =>
  proposal.write !== undefined ? { path: proposal.write.path } : { ruleId: proposal.reset!.ruleId }

export const processPlantProposalBookSchema = z.object({
  proposals: z.array(processPlantProposalSchema),
}).strict()
export type ProcessPlantProposalBook = z.infer<typeof processPlantProposalBookSchema>

export const emptyProposalBook: ProcessPlantProposalBook = { proposals: [] }

/** Plant time and wall time, as the adapter reads them when it acts. */
export interface ProposalClock {
  readonly elapsedMs: number
  readonly wallMs: number
}

export interface ProposalWrite {
  readonly path: VariablePath
  readonly value: ProcessVariableValue
}

export type ProposalTransitionType = 'recorded' | 'extended' | Exclude<ProposalStatus, 'pending'>

/** A change to one proposal, for the durable Run event the adapter journals. */
export interface ProposalTransition {
  readonly type: ProposalTransitionType
  readonly proposal: ProcessPlantProposal
}

export interface ProposalStep {
  readonly ok: boolean
  /** Why it was refused, in the words the refusal returns. */
  readonly reason?: string
  readonly book: ProcessPlantProposalBook
  readonly transitions: ReadonlyArray<ProposalTransition>
  /** The stored write an approval executes, through the one validated queued write path. */
  readonly execute?: ProposalWrite
  /** The actuation an approved reset proposal resets, by rule id. */
  readonly executeReset?: string
}

/** What a proposal is checked against: the controls on offer, the I&C's own validation, and the published readings. */
export interface ProposalPorts {
  /** The offered control option the write is, on the item that offers it; else why it is not offered. */
  readonly offered: (write: ProposalWrite) => { readonly ok: true; readonly item: string; readonly word: string; readonly consequence?: OperationConsequence } | { readonly ok: false; readonly reason: string }
  /** The write as the I&C would validate it now (validateProcessPlantControlWrite). */
  readonly validate: (write: ProposalWrite) => { readonly accepted: true } | { readonly accepted: false; readonly reason: string }
  /** A published reading by tag, with its value now. */
  readonly reading: (tagId: ProcessSignalTagId) => { readonly ok: true; readonly path: VariablePath; readonly value: ProcessVariableValue } | { readonly ok: false; readonly reason: string }
  /** An actuation's reset as offered now, on the drawn item a person reviews it on; else why it is not offered (actuation-reset.ts). */
  readonly resettable: (ruleId: string) => { readonly ok: true; readonly item: string; readonly word: string; readonly label: string; readonly holds: ReadonlyArray<VariablePath> } | { readonly ok: false; readonly reason: string }
}

export interface ProposeRequest {
  /** The proposing command's id: the proposal's id. */
  readonly id: string
  readonly plantId: string
  /** The write it proposes; or `reset`, the actuation whose reset it proposes, by rule id. */
  readonly write?: ProposalWrite
  readonly reset?: string
  readonly reason: string
  readonly procedureStep?: string
  readonly evidence: ReadonlyArray<ProcessSignalTagId>
  readonly proposer: { readonly actorId: string; readonly origin: OperationOrigin }
  readonly at: ProposalClock
}

export type ProposalDecision = 'approve' | 'reject' | 'extend' | 'withdraw'

export interface DecideRequest {
  readonly proposalId: string
  readonly decision: ProposalDecision
  readonly decider: { readonly actorId: string; readonly origin: OperationOrigin }
  /** The deciding command's id: an approval's write is journaled under it. */
  readonly commandId: string
  readonly reason?: string
  readonly at: ProposalClock
}

const refused = (book: ProcessPlantProposalBook, reason: string, transitions: ReadonlyArray<ProposalTransition> = []): ProposalStep => ({ ok: false, reason, book, transitions })

/** Whether a pending proposal has lapsed: its plant time is up, and a minute of wall time has passed since it was proposed. */
export const proposalLapsed = (proposal: ProcessPlantProposal, at: ProposalClock): boolean =>
  proposal.status === 'pending' && at.elapsedMs >= proposal.expiresAtElapsedMs && at.wallMs >= proposal.proposedAtWallMs + PROPOSAL_WALL_FLOOR_MS

const close = (proposal: ProcessPlantProposal, status: Exclude<ProposalStatus, 'pending'>, closed: NonNullable<ProcessPlantProposal['closed']>): ProcessPlantProposal =>
  ({ ...proposal, status, closed })

// Keeps every open proposal and the most recent closed ones, in the order they were proposed.
const bounded = (proposals: ReadonlyArray<ProcessPlantProposal>): ProcessPlantProposalBook => {
  const closed = proposals.filter(proposal => proposal.status !== 'pending')
  const dropped = new Set(closed.slice(0, Math.max(0, closed.length - CLOSED_PROPOSALS_KEPT)).map(proposal => proposal.id))
  return { proposals: proposals.filter(proposal => !dropped.has(proposal.id)) }
}

const replaced = (book: ProcessPlantProposalBook, changes: ReadonlyArray<ProcessPlantProposal>): ReadonlyArray<ProcessPlantProposal> => {
  const byId = new Map(changes.map(proposal => [proposal.id, proposal]))
  return book.proposals.map(proposal => byId.get(proposal.id) ?? proposal)
}

/** Lapses every pending proposal whose time is up: at each advance, and before a decision is taken. */
export const expireProposals = (book: ProcessPlantProposalBook, at: ProposalClock): { readonly book: ProcessPlantProposalBook; readonly transitions: ReadonlyArray<ProposalTransition> } => {
  const lapsed = book.proposals.filter(proposal => proposalLapsed(proposal, at))
    .map(proposal => close(proposal, 'expired', { atElapsedMs: at.elapsedMs, reason: 'Expired before a person decided' }))
  if (lapsed.length === 0) return { book, transitions: [] }
  return { book: bounded(replaced(book, lapsed)), transitions: lapsed.map(proposal => ({ type: 'expired', proposal })) }
}

/**
 * Records a proposal once the write is a control on offer, the I&C allows it
 * now, and every cited reading is published. It supersedes the proposer's
 * own pending proposal on the same equipment; another proposer's stands
 * beside it.
 */
export const proposeOperation = (book: ProcessPlantProposalBook, request: ProposeRequest, ports: ProposalPorts): ProposalStep => {
  if (request.proposer.origin === 'system') return refused(book, 'Only a person or an AI agent proposes an operation')
  if (book.proposals.some(proposal => proposal.id === request.id)) return refused(book, `Proposal ${request.id} is already recorded`)
  const reason = request.reason.trim()
  if (reason.length === 0 || reason.length > PROPOSAL_REASON_MAX_LENGTH) return refused(book, `A proposal's reason is 1 to ${PROPOSAL_REASON_MAX_LENGTH} characters`)
  const procedureStep = request.procedureStep?.trim()
  if (procedureStep !== undefined && (procedureStep.length === 0 || procedureStep.length > PROPOSAL_PROCEDURE_STEP_MAX_LENGTH)) {
    return refused(book, `A proposal's procedure step is 1 to ${PROPOSAL_PROCEDURE_STEP_MAX_LENGTH} characters`)
  }
  const tags = [...new Set(request.evidence)]
  if (tags.length === 0 || tags.length > PROPOSAL_EVIDENCE_MAX) return refused(book, `A proposal cites 1 to ${PROPOSAL_EVIDENCE_MAX} published readings as evidence`)
  if ((request.write === undefined) === (request.reset === undefined)) return refused(book, 'A proposal is either a write or an actuation reset')
  const operation = (() => {
    if (request.reset !== undefined) {
      const reset = ports.resettable(request.reset)
      return reset.ok ? { ok: true as const, item: reset.item, word: reset.word, reset: { ruleId: request.reset, label: reset.label, holds: [...reset.holds] } } : { ok: false as const, reason: reset.reason }
    }
    const offered = ports.offered(request.write!)
    if (!offered.ok) return { ok: false as const, reason: `Not offered to operators: ${offered.reason}` }
    const validation = ports.validate(request.write!)
    if (!validation.accepted) return { ok: false as const, reason: validation.reason }
    return { ok: true as const, item: offered.item, word: offered.word, write: request.write!, ...(offered.consequence === undefined ? {} : { consequence: offered.consequence }) }
  })()
  if (!operation.ok) return refused(book, operation.reason)
  const evidence: Array<ProcessPlantProposal['evidence'][number]> = []
  for (const tagId of tags) {
    const reading = ports.reading(tagId)
    if (!reading.ok) return refused(book, reading.reason)
    evidence.push({ tagId, path: reading.path, value: reading.value })
  }
  const proposal = processPlantProposalSchema.parse({
    id: request.id,
    plantId: request.plantId,
    ...('write' in operation ? { write: operation.write } : { reset: operation.reset }),
    item: operation.item,
    word: operation.word,
    ...('consequence' in operation ? { consequence: operation.consequence } : {}),
    reason,
    ...(procedureStep === undefined ? {} : { procedureStep }),
    evidence,
    proposer: { actorId: request.proposer.actorId, origin: request.proposer.origin },
    proposedAtElapsedMs: request.at.elapsedMs,
    proposedAtWallMs: request.at.wallMs,
    expiresAtElapsedMs: request.at.elapsedMs + PROPOSAL_LIFETIME_MS,
    extended: false,
    status: 'pending',
  })
  const target = targetKey(proposalTarget(proposal))
  const superseded = book.proposals
    .filter(candidate => candidate.status === 'pending' && targetKey(proposalTarget(candidate)) === target && candidate.proposer.actorId === request.proposer.actorId)
    .map(candidate => close(candidate, 'superseded', { atElapsedMs: request.at.elapsedMs, actorId: request.proposer.actorId, commandId: request.id, reason: 'Superseded by a newer proposal from the same proposer' }))
  return {
    ok: true,
    book: bounded([...replaced(book, superseded), proposal]),
    transitions: [...superseded.map(candidate => ({ type: 'superseded' as const, proposal: candidate })), { type: 'recorded', proposal }],
  }
}

/**
 * A decision on a pending proposal. Only a person approves, rejects or
 * extends one; its proposer may withdraw it. An approval validates the
 * stored write again and hands it back to execute under the approver's
 * command; refused, the proposal stays pending. An approved write supersedes
 * the other pending proposals on the same equipment.
 */
export const decideProposal = (book: ProcessPlantProposalBook, request: DecideRequest, ports: Pick<ProposalPorts, 'validate' | 'resettable'>): ProposalStep => {
  const expired = expireProposals(book, request.at)
  const proposal = expired.book.proposals.find(candidate => candidate.id === request.proposalId)
  if (proposal === undefined) return refused(expired.book, `No proposal ${request.proposalId} on this Plant`, expired.transitions)
  if (proposal.status !== 'pending') return refused(expired.book, `Proposal ${proposal.id} is already ${proposal.status}`, expired.transitions)
  const by = { atElapsedMs: request.at.elapsedMs, actorId: request.decider.actorId, commandId: request.commandId }
  const reason = request.reason?.trim()
  if (reason !== undefined && (reason.length === 0 || reason.length > PROPOSAL_REASON_MAX_LENGTH)) {
    return refused(expired.book, `A decision's reason is 1 to ${PROPOSAL_REASON_MAX_LENGTH} characters`, expired.transitions)
  }
  const withReason = reason === undefined ? by : { ...by, reason }
  if (request.decision === 'withdraw') {
    if (request.decider.actorId !== proposal.proposer.actorId) return refused(expired.book, 'Only its proposer withdraws a proposal', expired.transitions)
    const withdrawn = close(proposal, 'withdrawn', withReason)
    return { ok: true, book: bounded(replaced(expired.book, [withdrawn])), transitions: [...expired.transitions, { type: 'withdrawn', proposal: withdrawn }] }
  }
  if (request.decider.origin !== 'person') return refused(expired.book, `Only a person may ${request.decision} a proposal`, expired.transitions)
  if (request.decision === 'extend') {
    if (proposal.extended) return refused(expired.book, `Proposal ${proposal.id} has already been extended once`, expired.transitions)
    const extendedProposal = { ...proposal, extended: true, expiresAtElapsedMs: proposal.expiresAtElapsedMs + PROPOSAL_EXTENSION_MS }
    return { ok: true, book: { proposals: [...replaced(expired.book, [extendedProposal])] }, transitions: [...expired.transitions, { type: 'extended', proposal: extendedProposal }] }
  }
  if (request.decision === 'reject') {
    const rejected = close(proposal, 'rejected', withReason)
    return { ok: true, book: bounded(replaced(expired.book, [rejected])), transitions: [...expired.transitions, { type: 'rejected', proposal: rejected }] }
  }
  const check = permitted(proposal, ports)
  if (!check.accepted) return refused(expired.book, check.reason, expired.transitions)
  const approved = close(proposal, 'approved', withReason)
  const target = targetKey(proposalTarget(proposal))
  const superseded = expired.book.proposals
    .filter(candidate => candidate.status === 'pending' && candidate.id !== proposal.id && targetKey(proposalTarget(candidate)) === target)
    .map(candidate => close(candidate, 'superseded', { ...by, reason: `Superseded by the approval of proposal ${proposal.id}` }))
  return {
    ok: true,
    book: bounded(replaced(expired.book, [approved, ...superseded])),
    transitions: [...expired.transitions, { type: 'approved', proposal: approved }, ...superseded.map(candidate => ({ type: 'superseded' as const, proposal: candidate }))],
    ...(proposal.write !== undefined ? { execute: proposal.write } : { executeReset: proposal.reset!.ruleId }),
  }
}

// Whether a proposal's operation is allowed now: its write as the I&C validates it, or its reset as offered.
const permitted = (proposal: ProcessPlantProposal, ports: Pick<ProposalPorts, 'validate' | 'resettable'>): { readonly accepted: true } | { readonly accepted: false; readonly reason: string } => {
  if (proposal.write !== undefined) return ports.validate(proposal.write)
  const reset = ports.resettable(proposal.reset!.ruleId)
  return reset.ok ? { accepted: true } : { accepted: false, reason: reset.reason }
}

/** A command a person or an AI agent executed on the same equipment, or the same actuation's reset, supersedes the pending proposals for it. */
export const supersedeByCommand = (
  book: ProcessPlantProposalBook,
  command: ProposalTarget & { readonly commandId: string; readonly actorId: string; readonly at: ProposalClock },
): { readonly book: ProcessPlantProposalBook; readonly transitions: ReadonlyArray<ProposalTransition> } => {
  const target = targetKey(command)
  const superseded = book.proposals
    .filter(candidate => candidate.status === 'pending' && targetKey(proposalTarget(candidate)) === target)
    .map(candidate => close(candidate, 'superseded', { atElapsedMs: command.at.elapsedMs, actorId: command.actorId, commandId: command.commandId, reason: 'Superseded by a command on the same equipment' }))
  if (superseded.length === 0) return { book, transitions: [] }
  return { book: bounded(replaced(book, superseded)), transitions: superseded.map(proposal => ({ type: 'superseded', proposal })) }
}

/** A pending proposal as a person reviews it now: whether the I&C allows it, and how its evidence moved since it was proposed. */
export interface ProposalReview {
  readonly permitted: boolean
  readonly refusal?: string
  readonly evidence: ReadonlyArray<{ readonly tagId: ProcessSignalTagId; readonly then: ProcessVariableValue; readonly now: ProcessVariableValue }>
  /** Some cited reading moved since it was proposed: "plant changed since proposed". */
  readonly changed: boolean
}

/** Read-only: validates the stored write, or checks the reset is still offered, and reads its evidence again, changing nothing. */
export const reviewProposal = (proposal: ProcessPlantProposal, ports: Pick<ProposalPorts, 'validate' | 'reading' | 'resettable'>): ProposalReview => {
  const validation = permitted(proposal, ports)
  const evidence = proposal.evidence.map(cited => {
    const reading = ports.reading(cited.tagId)
    if (!reading.ok) throw new Error(`proposal ${proposal.id} cites a reading the Plant no longer publishes: ${reading.reason}`)
    return { tagId: cited.tagId, then: cited.value, now: reading.value }
  })
  return {
    permitted: validation.accepted,
    ...(validation.accepted ? {} : { refusal: validation.reason }),
    evidence,
    changed: evidence.some(entry => entry.then !== entry.now),
  }
}

/** The durable Run event a transition is journaled as: its signal type and payload. */
export const proposalEvent = (transition: ProposalTransition): { readonly type: string; readonly payload: Readonly<Record<string, unknown>> } => ({
  type: `process-plant.proposal.${transition.type}`,
  payload: {
    proposalId: transition.proposal.id,
    plantId: transition.proposal.plantId,
    ...(transition.proposal.write !== undefined ? { path: transition.proposal.write.path, value: transition.proposal.write.value } : { reset: transition.proposal.reset!.ruleId }),
    item: transition.proposal.item,
    word: transition.proposal.word,
    status: transition.proposal.status,
    proposer: transition.proposal.proposer,
    expiresAtElapsedMs: transition.proposal.expiresAtElapsedMs,
    ...(transition.proposal.closed === undefined ? {} : { closed: transition.proposal.closed }),
  },
})
