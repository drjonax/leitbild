// ============================================================================
// Proposal cards — what became of the operations an answer's turn proposed.
//
// An AI agent operates plant equipment by proposing it; a person approves in
// World's display window (plan C1 §4.4). The answer of the proposing turn
// carries a card with the action, its target and World's live status, read
// from World (control.proposals), never from the agent's prose. The turn's
// own execution evidence says what it proposed: each successful propose
// call's command id is the proposal's id, and its result keeps the exact
// Resource it went to. Reads go through the Workspace Host as the proposing
// agent, who may read its own proposals.
// ============================================================================

import { z } from 'zod'
import { workspaceResourceReferenceSchema, type WorkspaceId, type WorkspaceResourceReference } from '@leitbild/contracts'
import type { ExecutionCall } from '../core/executions/store.ts'
import { PROPOSE_OPERATION_ID } from './operation-claims.ts'

/** The operation that reads a Plant's proposals with World's review of the pending ones. */
export const PROPOSALS_OPERATION_ID = 'world.process-plant.control.proposals'

/** One propose call of a turn: what it proposed and what World answered. */
export interface ProposedOperation {
  readonly callId: string
  readonly key: string
  readonly plantId: string
  /** The tag or path it names the command by; for an actuation's reset, the actuation's rule id. */
  readonly target: string
  /** Whether it proposes a latched actuation's reset, which writes no value, rather than a write. */
  readonly reset?: true
  readonly value: unknown
  readonly reason?: string
  readonly procedureStep?: string
  readonly evidence: ReadonlyArray<string>
  readonly outcome:
    | { readonly kind: 'recorded'; readonly proposalId: string; readonly resource: WorkspaceResourceReference }
    | { readonly kind: 'refused'; readonly reason: string }
}

const proposeInputSchema = z.object({
  plantId: z.string().min(1),
  tagId: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  reset: z.string().min(1).optional(),
  // A write's value; a reset writes none.
  value: z.unknown().optional(),
  reason: z.string().optional(),
  procedureStep: z.string().optional(),
  evidence: z.array(z.string()).default([]),
})

const callsSchema = z.object({ calls: z.array(z.object({ key: z.string(), operationId: z.string(), input: z.unknown() })) })
const resultsSchema = z.object({
  results: z.array(z.object({
    key: z.string(),
    operationId: z.string(),
    success: z.boolean(),
    data: z.unknown().optional(),
    error: z.string().optional(),
    target: z.object({ kind: z.string(), ref: z.unknown() }).optional(),
  })),
})
const commandResultSchema = z.object({ ok: z.literal(true), commandId: z.string().min(1) })

/**
 * The operations a turn proposed, in call order: from each workspace_call's
 * arguments and results, matched by batch key. A propose call whose input
 * World could not have taken (no plant, no command named) is not a proposal.
 */
export const proposedOperationsOf = (calls: ReadonlyArray<ExecutionCall>): ReadonlyArray<ProposedOperation> => calls.flatMap(call => {
  if (call.tool !== 'workspace_call' || call.result?.success !== true) return []
  const args = callsSchema.safeParse(call.arguments)
  const results = resultsSchema.safeParse(call.result.data)
  if (!args.success || !results.success) return []
  return results.data.results.flatMap((entry): ReadonlyArray<ProposedOperation> => {
    if (entry.operationId !== PROPOSE_OPERATION_ID) return []
    const input = proposeInputSchema.safeParse(args.data.calls.find(candidate => candidate.key === entry.key)?.input)
    // A write names its command by tag or path and a value; a reset names the actuation alone.
    const target = !input.success ? undefined : input.data.reset ?? (input.data.value === undefined ? undefined : input.data.tagId ?? input.data.path)
    if (!input.success || target === undefined) return []
    const base = {
      callId: call.id,
      key: entry.key,
      plantId: input.data.plantId,
      target,
      ...(input.data.reset === undefined ? {} : { reset: true as const }),
      value: input.data.value,
      ...(input.data.reason === undefined ? {} : { reason: input.data.reason }),
      ...(input.data.procedureStep === undefined ? {} : { procedureStep: input.data.procedureStep }),
      evidence: input.data.evidence,
    }
    if (!entry.success) return [{ ...base, outcome: { kind: 'refused', reason: (entry.error ?? 'refused without a reason').replace(/^simulation_command_rejected:\s*/, '') } }]
    const command = commandResultSchema.safeParse(entry.data)
    const resource = entry.target?.kind === 'resource' ? workspaceResourceReferenceSchema.safeParse(entry.target.ref) : undefined
    if (!command.success || resource === undefined || !resource.success) {
      throw new Error(`Proposal evidence of call ${call.id}/${entry.key} lacks its command id or the Resource it went to`)
    }
    return [{ ...base, outcome: { kind: 'recorded', proposalId: command.data.commandId, resource: resource.data } }]
  })
})

// What a card shows of World's proposal record and review; World's own words.
const worldProposalSchema = z.object({
  id: z.string(),
  item: z.string(),
  word: z.string(),
  status: z.enum(['pending', 'approved', 'rejected', 'expired', 'superseded', 'withdrawn']),
  proposer: z.object({ actorId: z.string(), origin: z.string() }),
  expiresAtElapsedMs: z.number(),
  closed: z.object({ atElapsedMs: z.number(), actorId: z.string().optional(), commandId: z.string().optional(), reason: z.string().optional() }).optional(),
})
const worldReviewSchema = z.object({
  permitted: z.boolean(),
  refusal: z.string().optional(),
  evidence: z.array(z.object({ tagId: z.string(), then: z.union([z.number(), z.boolean()]), now: z.union([z.number(), z.boolean()]) })),
  changed: z.boolean(),
})
const proposalsResultSchema = z.object({
  result: z.object({
    plantElapsedMs: z.number(),
    proposals: z.array(z.object({ proposal: worldProposalSchema, review: worldReviewSchema.optional() })),
  }),
})
export type WorldProposal = z.infer<typeof worldProposalSchema>
export type WorldReview = z.infer<typeof worldReviewSchema>

/** A card's data: what the turn proposed, and where World says it stands now. */
export interface ProposalCard extends Omit<ProposedOperation, 'outcome'> {
  readonly outcome:
    | { readonly kind: 'refused'; readonly reason: string }
    | { readonly kind: 'recorded'; readonly proposalId: string; readonly plantElapsedMs: number; readonly proposal: WorldProposal; readonly review?: WorldReview }
    | { readonly kind: 'unreadable'; readonly proposalId: string; readonly reason: string }
}

export interface ProposalCardReaderDeps {
  readonly workspaceId: WorkspaceId
  readonly hostBaseUrl: string
  readonly fetchImpl?: typeof fetch
}

const HOST_READ_TIMEOUT_MS = 10_000

/**
 * Reads each recorded proposal's status from World through the Host, one
 * read per Plant and Resource, as the proposing agent. A read World refuses
 * leaves those cards unreadable with its reason, never a guessed status.
 */
export const createProposalCardReader = (deps: ProposalCardReaderDeps) => {
  const fetchImpl = deps.fetchImpl ?? fetch
  const invokePath = `${new URL(deps.hostBaseUrl).origin}/api/workspaces/${encodeURIComponent(deps.workspaceId)}/capabilities/${encodeURIComponent(PROPOSALS_OPERATION_ID)}/invoke`
  // The Plant's whole book (its pending proposals and its last closed ones), so a proposal it no longer keeps is told apart from a refused read.
  const readPlant = async (resource: WorkspaceResourceReference, plantId: string, agent: { readonly id: string; readonly name: string }) => {
    const response = await fetchImpl(invokePath, {
      method: 'POST',
      signal: AbortSignal.timeout(HOST_READ_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ resource, input: { plantId }, actor: { kind: 'ai', id: agent.id, displayName: agent.name } }),
    })
    const body = await response.json().catch(() => undefined) as { readonly error?: { readonly message?: unknown } } | undefined
    if (!response.ok) return { ok: false as const, reason: typeof body?.error?.message === 'string' ? body.error.message : `Workspace Host returned HTTP ${response.status}` }
    return { ok: true as const, result: proposalsResultSchema.parse(body).result }
  }
  return {
    read: async (operations: ReadonlyArray<ProposedOperation>, agent: { readonly id: string; readonly name: string }): Promise<ReadonlyArray<ProposalCard>> => {
      const groups = new Map<string, { readonly resource: WorkspaceResourceReference; readonly plantId: string }>()
      for (const operation of operations) {
        if (operation.outcome.kind === 'recorded') groups.set(JSON.stringify([operation.outcome.resource, operation.plantId]), { resource: operation.outcome.resource, plantId: operation.plantId })
      }
      const reads = new Map(await Promise.all([...groups].map(async ([key, group]) => [key, await readPlant(group.resource, group.plantId, agent)] as const)))
      return operations.map((operation): ProposalCard => {
        const { outcome, ...proposed } = operation
        if (outcome.kind === 'refused') return { ...proposed, outcome }
        const read = reads.get(JSON.stringify([outcome.resource, operation.plantId]))!
        if (!read.ok) return { ...proposed, outcome: { kind: 'unreadable', proposalId: outcome.proposalId, reason: read.reason } }
        const found = read.result.proposals.find(entry => entry.proposal.id === outcome.proposalId)
        if (found === undefined) return { ...proposed, outcome: { kind: 'unreadable', proposalId: outcome.proposalId, reason: 'the Plant no longer keeps this proposal' } }
        return { ...proposed, outcome: { kind: 'recorded', proposalId: outcome.proposalId, plantElapsedMs: read.result.plantElapsedMs, proposal: found.proposal, ...(found.review === undefined ? {} : { review: found.review }) } }
      })
    },
  }
}
export type ProposalCardReader = ReturnType<typeof createProposalCardReader>
