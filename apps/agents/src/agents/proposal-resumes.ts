// ============================================================================
// Proposal resumes — an approved proposal continues the procedure it held.
//
// The procedure runner ends its turn on a proposal (a hold); a person approves
// it in World's display window. World records the decision but cannot reach
// Agents, so Agents watches through the Workspace Host. When an answer posts
// whose turn proposed for a procedure (a propose carrying procedureStep, or a
// turn of a procedure-runner Agent that worked a procedure Run), each recorded
// proposal's status is read as its card reads it, every few seconds, until
// World closes it. Approved, the same Agent is asked for one turn in that Room
// (AIAgent.requestTurn) whose transient instruction names what was approved;
// the reply carries the cause and replies to the proposing answer. Rejected,
// expired, superseded or withdrawn ends the watch without a turn.
//
// At most one turn per proposal. No turn when a later turn of the Agent has
// already taken the procedure up since the approval (the person said
// "continue"), while it is answering in that Room the check waits for the
// answer. Watches live in memory for a bounded time; a runtime that stops
// forgets them, and the person continues as before.
// ============================================================================

import type { ExecutionStore, ExecutionCall } from '../core/executions/store.ts'
import type { RoomDirectory } from '../core/rooms/directory.ts'
import type { Room } from '../core/types/room.ts'
import type { AIAgent, RequestedTurn, Team } from '../core/types/agent.ts'
import { PROCEDURE_RUNNER_SKILL, PROPOSAL_RESUME_CAUSE } from '../core/proposal-resume.ts'
import { collectTurnOperations, type TurnOperation } from './operation-claims.ts'
import { PROPOSALS_OPERATION_ID, proposedOperationsOf, type ProposalCardReader, type ProposedOperation, type WorldProposal } from './proposal-cards.ts'
import { asAIAgent } from './shared.ts'

/** Operations of a procedure Run (World); a turn that calls one works a procedure. */
// Dated exception (P0, 2026-10-20): names a World operation id, against the platform rule that Agents discover Capabilities at runtime, until the swap (plan v3.1 §7), when World's procedure Run says which turns drive it.
const PROCEDURE_OPERATION_PREFIX = 'world.procedure.'

// An approval resumes the agent within a few seconds; the display window
// reads the same proposals as often. Reads stop once a proposal closes.
const POLL_MS = 3_000
// A proposal lapses after 2 plant minutes (a person may extend it once), but a
// paused clock keeps it pending; the watch gives up after this much wall time.
const WATCH_MS = 30 * 60_000
// Turns read per page while looking for one that took the procedure up.
const TURNS_PAGE = 20

export interface ProposalResumeDeps {
  readonly rooms: Pick<RoomDirectory, 'getRoom'>
  readonly team: Pick<Team, 'getAgent'>
  readonly executions: Pick<ExecutionStore, 'getTurn' | 'listTurns' | 'listCalls' | 'getCall'>
  /** World's status of each proposal, read through the Host as the proposing agent. */
  readonly readStatus: ProposalCardReader['read']
  readonly pollMs?: number
  readonly watchMs?: number
  readonly now?: () => number
  /** Runs `run` once after `ms`; returns its cancel. */
  readonly setTimer?: (run: () => void, ms: number) => () => void
}

interface Watched {
  readonly operation: ProposedOperation & { readonly outcome: { readonly kind: 'recorded'; readonly proposalId: string } }
  /** When a read last found it pending was sent: the approval came after. */
  pendingSeenAt: number
}

interface Approved {
  readonly operation: Watched['operation']
  readonly proposal: WorldProposal
  readonly pendingSeenAt: number
}

interface Watch {
  readonly turnId: string
  readonly roomId: string
  readonly agentId: string
  readonly answerId: string
  readonly until: number
  readonly watched: Map<string, Watched>
  approved: Approved[]
}

/** A person or agent as an actor id names them: "actor:human:hilde" → "hilde". */
const actorName = (actorId: string): string => actorId.replace(/^actor:(?:human|ai|system|anonymous):/, '')

/** What was approved, as World words the control: "TRIP RX-TRIP", "RESET Manual safety injection". */
const actionWords = (approved: Approved): string =>
  approved.operation.reset === true ? approved.proposal.word : `${approved.proposal.word} ${approved.operation.target}`

const approverOf = (approved: ReadonlyArray<Approved>): string => {
  const actors = [...new Set(approved.map(entry => entry.proposal.closed?.actorId).filter((actor): actor is string => actor !== undefined))]
  return actors.length === 0 ? 'A person' : actors.map(actorName).join(' and ')
}

/** The reply's cause: who approved what. */
const proposalResumeCause = (approved: ReadonlyArray<Approved>): RequestedTurn['cause'] =>
  ({ kind: PROPOSAL_RESUME_CAUSE, name: `${approverOf(approved)} approved ${approved.map(actionWords).join(', ')}` })

/** The transient instruction of the resumed turn. How to continue stays in the procedure-runner Skill. */
const proposalResumeInstruction = (approved: ReadonlyArray<Approved>, answerId: string): string => {
  const items = approved.map(entry => {
    const step = entry.operation.procedureStep === undefined ? '' : ` for ${entry.operation.procedureStep}`
    return `${actionWords(entry)} on Plant ${entry.operation.plantId}${step}`
  })
  return `[Proposal approved] ${approverOf(approved)} approved your ${items.length === 1 ? 'proposal' : 'proposals'} `
    + `${items.join('; ')} (your answer, messageId "${answerId}") in the display window, and World executed it. `
    // This turn starts seconds after the decision, before the plant has
    // responded (probe 2026-10-13: power still 5 % and subcriticality red
    // 10 plant seconds after a trip, so the runner held at E-0 step 1).
    // Dated exception (P0, 2026-10-20): names a World operation id, against the platform rule that Agents discover Capabilities at runtime, until the swap (plan v3.1 §7), when the World proposal vignette carries how to wait.
    + 'The plant may not show its effect yet: where a reading you judge by has not responded, wait in plant seconds '
    + '(world.simulation-run.wait with procedureRunId) before you judge a step or hold on it. '
    + 'Continue the procedure as you would on "continue": read where it stands, say what changed that you did not do, and carry on.'
}

const callsOf = (executions: ProposalResumeDeps['executions'], roomId: string, turnId: string): ReadonlyArray<ExecutionCall> =>
  executions.listCalls(roomId, turnId).flatMap(summary => {
    const call = executions.getCall(roomId, turnId, summary.id)
    return call === undefined ? [] : [call]
  })

const operationsOf = (calls: ReadonlyArray<ExecutionCall>): ReadonlyArray<TurnOperation> => {
  const operations: TurnOperation[] = []
  for (const call of calls) if (call.result !== undefined) collectTurnOperations(operations, call.tool, call.arguments, call.result)
  return operations
}

const worksProcedure = (operations: ReadonlyArray<TurnOperation>): boolean =>
  operations.some(operation => operation.operationId.startsWith(PROCEDURE_OPERATION_PREFIX))

export const createProposalResumes = (deps: ProposalResumeDeps) => {
  const pollMs = deps.pollMs ?? POLL_MS
  const watchMs = deps.watchMs ?? WATCH_MS
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? ((run, ms) => {
    const timer = setTimeout(run, ms)
    timer.unref?.()
    return () => clearTimeout(timer)
  })
  const watches = new Map<string, Watch>()
  // A turn links each message it posts; its proposals are watched once.
  const watchedTurns = new Set<string>()
  let cancelTimer: (() => void) | undefined
  let running: Promise<void> | undefined
  let disposed = false

  const end = (watch: Watch, why?: string): void => {
    watches.delete(watch.turnId)
    if (why !== undefined) console.warn(`[proposal-resume] No resume for turn ${watch.turnId} in room ${watch.roomId}: ${why}`)
  }

  // Whether a turn of the Agent in the Room that started after `since` has
  // taken the procedure up itself: worked its Run or read the proposals.
  const tookUpSince = (watch: Watch, since: number): boolean => {
    let before: { readonly startedAt: number; readonly id: string } | undefined
    for (;;) {
      const page = deps.executions.listTurns(watch.roomId, { limit: TURNS_PAGE, ...(before === undefined ? {} : { before }) })
      for (const turn of page) {
        if (turn.startedAt <= since) return false
        if (turn.agentId !== watch.agentId || turn.id === watch.turnId) continue
        const operations = operationsOf(callsOf(deps.executions, watch.roomId, turn.id))
        if (worksProcedure(operations) || operations.some(operation => operation.operationId === PROPOSALS_OPERATION_ID)) return true
      }
      if (page.length < TURNS_PAGE) return false
      before = page.at(-1)!
    }
  }

  const resume = (watch: Watch, room: Room, ai: AIAgent): void => {
    // A paused Room runs no Agent, and an answer in progress may be the one
    // that takes the procedure up: ask again on a later read.
    if (room.paused) return
    if (ai.state.get() === 'generating' && ai.state.getContext() === room.profile.id) return
    const since = Math.max(...watch.approved.map(entry => entry.pendingSeenAt))
    if (tookUpSince(watch, since)) {
      console.info(`[proposal-resume] ${ai.name} already continued in room ${watch.roomId} after the approval; no resume for turn ${watch.turnId}`)
      watch.approved = []
      return
    }
    const result = ai.requestTurn!(room.profile.id, {
      instruction: proposalResumeInstruction(watch.approved, watch.answerId),
      inReplyTo: [watch.answerId],
      cause: proposalResumeCause(watch.approved),
      requireView: false,
    })
    // Another requested turn waits in the Room: ask again on a later read.
    if (result.kind === 'refused' && result.reason === 'pending') return
    if (result.kind === 'refused') console.warn(`[proposal-resume] ${ai.name} was not resumed in room ${watch.roomId}: ${result.message}`)
    watch.approved = []
  }

  const read = async (watch: Watch, ai: AIAgent): Promise<void> => {
    const sentAt = now()
    const cards = await deps.readStatus([...watch.watched.values()].map(entry => entry.operation), { id: ai.id, name: ai.name })
    for (const card of cards) {
      if (card.outcome.kind === 'refused') continue
      const entry = watch.watched.get(card.outcome.proposalId)
      if (entry === undefined) continue
      if (card.outcome.kind === 'unreadable') {
        watch.watched.delete(card.outcome.proposalId)
        console.warn(`[proposal-resume] Stopped watching proposal ${card.outcome.proposalId}: ${card.outcome.reason}`)
        continue
      }
      const proposal = card.outcome.proposal
      if (proposal.status === 'pending') {
        entry.pendingSeenAt = sentAt
        continue
      }
      watch.watched.delete(card.outcome.proposalId)
      if (proposal.status === 'approved') watch.approved.push({ operation: entry.operation, proposal, pendingSeenAt: entry.pendingSeenAt })
    }
  }

  const step = async (watch: Watch): Promise<void> => {
    if (now() > watch.until) return end(watch, 'its proposals were not decided in time')
    const room = deps.rooms.getRoom(watch.roomId)
    if (room === undefined) return end(watch, 'the room no longer exists')
    const agent = deps.team.getAgent(watch.agentId)
    const ai = agent === undefined ? undefined : asAIAgent(agent)
    if (ai?.requestTurn === undefined) return end(watch, 'its agent can no longer take requested turns')
    if (!room.hasMember(ai.id) || room.isMuted(ai.id)) return end(watch, `${ai.name} is no longer an unmuted member of the room`)
    // A manual Room's person activates its agents; an approval does not.
    if (room.deliveryMode === 'manual') return end(watch, 'the room delivers manually')
    if (watch.watched.size > 0) {
      try {
        await read(watch, ai)
      } catch (error) {
        // The Host did not answer; read again next time.
        console.warn(`[proposal-resume] Could not read proposals of turn ${watch.turnId}:`, error)
      }
      if (disposed) return
    }
    if (watch.approved.length > 0) resume(watch, room, ai)
    if (watch.watched.size === 0 && watch.approved.length === 0) end(watch)
  }

  const tick = (): Promise<void> => {
    running ??= (async () => {
      for (const watch of [...watches.values()]) {
        if (disposed) return
        try {
          await step(watch)
        } catch (error) {
          end(watch, `unexpected error: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    })().finally(() => { running = undefined })
    return running
  }

  const schedule = (): void => {
    if (disposed || cancelTimer !== undefined || watches.size === 0) return
    cancelTimer = setTimer(() => {
      cancelTimer = undefined
      void tick().then(schedule)
    }, pollMs)
  }

  return {
    /**
     * An answer of `executionTurnId` was posted. Watches the turn's recorded
     * proposals made for a procedure. Never throws: the answer is delivered.
     */
    answered: (input: { readonly executionTurnId: string; readonly roomId: string; readonly messageId: string }): void => {
      if (disposed || watchedTurns.has(input.executionTurnId)) return
      try {
        const turn = deps.executions.getTurn(input.roomId, input.executionTurnId)
        // A turn that failed or was cancelled did not end on a hold.
        if (turn?.status !== 'completed') return
        const calls = callsOf(deps.executions, turn.roomId, turn.id)
        const recorded = proposedOperationsOf(calls)
          .filter((operation): operation is Watched['operation'] => operation.outcome.kind === 'recorded')
        if (recorded.length === 0) return
        const agent = deps.team.getAgent(turn.agentId)
        const runner = agent !== undefined && asAIAgent(agent)?.getSkills().includes(PROCEDURE_RUNNER_SKILL) === true
          && worksProcedure(operationsOf(calls))
        const forProcedure = recorded.filter(operation => operation.procedureStep !== undefined || runner)
        if (forProcedure.length === 0) return
        const startedAt = now()
        watchedTurns.add(turn.id)
        watches.set(turn.id, {
          turnId: turn.id,
          roomId: turn.roomId,
          agentId: turn.agentId,
          answerId: input.messageId,
          until: startedAt + watchMs,
          watched: new Map(forProcedure.map(operation => [operation.outcome.proposalId, { operation, pendingSeenAt: turn.finishedAt ?? startedAt }])),
          approved: [],
        })
        schedule()
      } catch (error) {
        console.error(`[proposal-resume] Could not watch the proposals of turn ${input.executionTurnId}:`, error)
      }
    },
    /** Reads every watch once; the timer calls it, tests may too. */
    tick,
    /** The turns whose proposals are watched now. */
    watching: (): ReadonlyArray<string> => [...watches.keys()],
    dispose: (): void => {
      disposed = true
      cancelTimer?.()
      cancelTimer = undefined
      watches.clear()
    },
  }
}
export type ProposalResumes = ReturnType<typeof createProposalResumes>
