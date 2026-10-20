/**
 * The Run context an Agent reads before each turn (plan v3.1 §2.4,
 * architecture A4). The Room Scope's context publishers are those operations
 * a Module marks `publishes: ['context']`. Exactly one in scope is read;
 * otherwise exactly one among the focused subjects; otherwise the turn gets a
 * one-line note, never a guess. A refusal or a 3 s timeout is a note too. The
 * read goes through the Host broker as the Agent, is never cached across
 * turns, and is recorded as the turn's `run_context` execution call.
 */
import type { WorkspaceSubjectReference } from '@leitbild/contracts'
import type { ToolResult } from '../core/types/tool.ts'
import type { ContextPublisher, createContextPublisherLookup } from '../tools/built-in/workspace-capability-tools.ts'

export const RUN_CONTEXT_TOOL = 'run_context'
const TIMEOUT_MS = 3_000

/** The text a turn's context shows and the execution call that records how it was read. */
export interface RunContextFetch {
  readonly text: string
  readonly call: { readonly arguments: unknown; readonly result: ToolResult; readonly startedAt: number }
}

export type RunContextFetcher = (
  roomId: string,
  focused: ReadonlyArray<WorkspaceSubjectReference>,
  caller: { readonly id: string; readonly name: string },
  signal: AbortSignal,
) => Promise<RunContextFetch | undefined>

const keyOf = (ref: { readonly workspaceId: string; readonly moduleId: string; readonly type: string; readonly id: string }): string =>
  `${ref.workspaceId}:${ref.moduleId}:${ref.type}:${ref.id}`

export const createRunContextFetcher = (
  sources: Pick<ReturnType<typeof createContextPublisherLookup>, 'publishers' | 'read'>,
  timeoutMs = TIMEOUT_MS,
): RunContextFetcher => async (roomId, focused, caller, signal) => {
  const startedAt = Date.now()
  const deadline = AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
  // The bound holds even for a source that ignores its signal.
  const bounded = <T>(work: Promise<T>): Promise<T> => Promise.race([work, new Promise<never>((_, reject) => {
    if (deadline.aborted) reject(deadline.reason)
    deadline.addEventListener('abort', () => reject(deadline.reason), { once: true })
  })])
  const note = (reason: string, args: unknown, result: ToolResult = { success: false, error: reason }): RunContextFetch =>
    ({ text: `Run context not loaded: ${reason}`, call: { arguments: args, result, startedAt } })
  let chosen: ContextPublisher | undefined
  try {
    const publishers = await bounded(sources.publishers(roomId, deadline))
    if (publishers.length === 0) return undefined
    const focusedKeys = new Set(focused.flatMap(subject => 'revisionId' in subject ? [] : [keyOf(subject)]))
    const inFocus = publishers.filter(publisher => focusedKeys.has(keyOf(publisher.resource)))
    chosen = publishers.length === 1 ? publishers[0] : inFocus.length === 1 ? inFocus[0] : undefined
    if (!chosen) return note(`${publishers.length} Runs in scope, ${inFocus.length === 0 ? 'none' : inFocus.length} focused`, { publishers: publishers.map(publisher => publisher.resource.id) })
    const args = { operationId: chosen.operationId, resource: chosen.resource }
    const read = await bounded(sources.read(chosen, caller, deadline))
    if (!read.ok) return note(read.refusal.error ?? 'the Run refused it', args, read.refusal)
    const { text, at, clock } = read.context
    return { text: `Run ${chosen.resource.id} as of ${at} (${clock} time):\n${text}`, call: { arguments: args, result: { success: true, data: { context: read.context } }, startedAt } }
  } catch (error) {
    if (signal.aborted) throw error
    const args = chosen === undefined ? {} : { operationId: chosen.operationId, resource: chosen.resource }
    if (deadline.aborted) return note(`World did not answer within ${timeoutMs / 1000} s`, args)
    return note(error instanceof Error ? error.message : String(error), args)
  }
}
