// ============================================================================
// Operation claims — does an answer say it did what its turn only proposed?
//
// On a Plant an AI agent operates by proposing: World records the exact
// command and a person approves it in the display window, or not (plan C1
// §4.4). The answer must never say "I closed the block valve" when the turn
// only proposed it, and never say it proposed what World refused. This check
// reads what the turn's own workspace_call results say happened: a command's
// result carries its commandId, and a proposal is the one command whose
// operation proposes. It is deterministic and errs towards silence: a clause
// that proposes, asks, conditions or looks ahead is not a claim, and a done
// verb in the passive counts only where it names a proposed target.
// ============================================================================

import type { ToolResult } from '../core/types/tool.ts'

/** The operation through which an AI agent proposes a plant command for a person to approve (World). */
export const PROPOSE_OPERATION_ID = 'world.process-plant.control.propose'

/** One operation a workspace_call of this turn issued, with what it returned. */
export interface TurnOperation {
  readonly operationId: string
  readonly input: unknown
  readonly success: boolean
  /** The command's id where it was a command the Module accepted. */
  readonly commandId?: string
  readonly error?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The operations a workspace_call issued, its arguments matched to its results by batch key. */
export const collectTurnOperations = (into: TurnOperation[], tool: string, args: unknown, result: ToolResult): void => {
  if (tool !== 'workspace_call' || !result.success || !isRecord(args) || !Array.isArray(args.calls)) return
  const entries = isRecord(result.data) && Array.isArray(result.data.results) ? result.data.results : []
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.key !== 'string' || typeof entry.operationId !== 'string' || typeof entry.success !== 'boolean') continue
    const call = (args.calls as ReadonlyArray<unknown>).find(candidate => isRecord(candidate) && candidate.key === entry.key)
    const data = entry.data
    const commandId = isRecord(data) && data.ok === true && typeof data.commandId === 'string' ? data.commandId : undefined
    into.push({
      operationId: entry.operationId,
      input: isRecord(call) ? call.input : undefined,
      success: entry.success,
      ...(commandId === undefined ? {} : { commandId }),
      ...(typeof entry.error === 'string' ? { error: entry.error } : {}),
    })
  }
}

// What an operation says done: the equipment's end state or the act.
const DONE = '(?:closed|shut|opened|started|stopped|tripped|isolated|blocked|actuated|reset|executed|operated|throttled|secured|initiated|switched (?:on|off)|turned (?:on|off))'
// "I closed", "we have started", "I've now tripped".
const FIRST_PERSON_DONE = new RegExp(`\\b(?:I|we)(?:'ve|'d| have| had)?\\s+(?:now\\s+|just\\s+|already\\s+|successfully\\s+)?${DONE}\\b`, 'i')
// "MOV-8000A has been closed", "it is now shut", "the valve was closed by me".
const PASSIVE_DONE = new RegExp(`\\b(?:(?:has|have)\\s+(?:now\\s+)?been\\s+${DONE}|(?:is|are)\\s+now\\s+(?:closed|shut|open|running|stopped|tripped|isolated|blocked)|(?:was|were)\\s+${DONE}\\s+(?:by me|by us|on my command))\\b`, 'i')
// A clause that proposes, asks, conditions, denies or looks ahead claims nothing done.
const NOT_A_CLAIM = /\b(?:propos\w*|approv\w*|await\w*|pending|recommend\w*|suggest\w*|request\w*|once|if|when|after|until|unless|will|would|should|could|can|may|might|must|not|never|no longer|cannot|to be)\b|n't\b/i
// "I proposed …", "my proposal …", "a proposal is pending".
const SAYS_PROPOSED = /\b(?:I|we)(?:'ve| have)?\s+(?:just\s+)?(?:proposed|submitted a proposal|put forward)\b|\b(?:my|the|a|this)\s+proposal\s+(?:is|was|has been|awaits|now)\b/i

const clausesOf = (prose: string): ReadonlyArray<string> => prose
  .replace(/```[\s\S]*?(?:```|$)/g, ' ')
  .replace(/[*_`]/g, '')
  .split(/(?<=[.!?])\s+|\n+|;|\s[—–]\s|,\s*(?:but|while|and then|then|so)\s+/i)
  .map(clause => clause.trim())
  .filter(clause => clause.length > 0)

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** How an answer names what a proposal operates: the tag or path it was proposed by, or the rule id of the actuation whose reset it proposes. */
const proposedTarget = (operation: TurnOperation): string | undefined => {
  const input = operation.input
  if (!isRecord(input)) return undefined
  return typeof input.reset === 'string' ? input.reset : typeof input.tagId === 'string' ? input.tagId : typeof input.path === 'string' ? input.path : undefined
}

const firstLine = (error: string | undefined): string => (error ?? 'no reason given').replace(/^simulation_command_rejected:\s*/, '').split('\n')[0]!

/**
 * Where an answer says done what its turn only proposed, or proposed what
 * World refused. A first-person done verb is a claim of an operation the
 * turn did not execute where the turn executed no other command, or where
 * the clause names a proposed target; a passive one only where it names a
 * proposed target.
 */
export const operationClaimIssues = (answer: string, operations: ReadonlyArray<TurnOperation>): ReadonlyArray<string> => {
  const proposals = operations.filter(operation => operation.operationId === PROPOSE_OPERATION_ID)
  if (proposals.length === 0) return []
  const recorded = proposals.filter(operation => operation.success && operation.commandId !== undefined)
  const refused = proposals.filter(operation => !operation.success)
  const executed = operations.filter(operation => operation.operationId !== PROPOSE_OPERATION_ID && operation.success && operation.commandId !== undefined)
  const targets = recorded.flatMap(operation => {
    const target = proposedTarget(operation)
    return target === undefined ? [] : [target]
  })
  const namesProposed = (clause: string): string | undefined =>
    targets.find(target => new RegExp(`(?<![\\w-])${escape(target)}(?![\\w-])`, 'i').test(clause))
  const issues: string[] = []
  for (const clause of clausesOf(answer)) {
    if (recorded.length > 0 && !NOT_A_CLAIM.test(clause)) {
      const named = namesProposed(clause)
      const firstPerson = FIRST_PERSON_DONE.test(clause) && (executed.length === 0 || named !== undefined)
      if (firstPerson || (named !== undefined && PASSIVE_DONE.test(clause))) {
        const what = named ?? targets[0]
        issues.push(`It says "${clause}", but this turn only proposed the operation${what === undefined ? '' : ` of ${what}`}: nothing is executed until a person approves it in the display window. Say it is proposed and awaiting a person's approval.`)
        continue
      }
    }
    if (recorded.length === 0 && refused.length > 0 && SAYS_PROPOSED.test(clause)) {
      issues.push(`It says "${clause}", but World refused the proposal: ${refused.map(operation => firstLine(operation.error)).join('; ')}. Say it was refused and why.`)
    }
  }
  return [...new Set(issues)]
}
