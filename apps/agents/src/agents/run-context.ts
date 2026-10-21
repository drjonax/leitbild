/**
 * The Run context an Agent reads before each turn (plan v3.1 §2.4,
 * architecture A4). The Room Scope's context publishers are those operations
 * a Module marks `publishes: ['context']`. Exactly one in scope is read;
 * otherwise exactly one among the focused subjects; otherwise the turn gets a
 * one-line note, never a guess. A refusal or a 3 s timeout is a note too. The
 * read goes through the Host broker as the Agent, is never cached across
 * turns and is not stored: the turn's model reads it, no record keeps it.
 */
import type { WorkspaceSubjectReference } from '@leitbild/contracts'
import type { createContextPublisherLookup } from '../tools/built-in/workspace-capability-tools.ts'

const TIMEOUT_MS = 3_000

/** The text a turn's context shows: the Run context, or the note saying why there is none; none without a publisher in scope. */
export type RunContextFetcher = (
  roomId: string,
  focused: ReadonlyArray<WorkspaceSubjectReference>,
  caller: { readonly id: string; readonly name: string },
  signal: AbortSignal,
) => Promise<string | undefined>

const keyOf = (ref: { readonly workspaceId: string; readonly moduleId: string; readonly type: string; readonly id: string }): string =>
  `${ref.workspaceId}:${ref.moduleId}:${ref.type}:${ref.id}`

export const createRunContextFetcher = (
  sources: Pick<ReturnType<typeof createContextPublisherLookup>, 'publishers' | 'read'>,
  timeoutMs = TIMEOUT_MS,
): RunContextFetcher => async (roomId, focused, caller, signal) => {
  const deadline = AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
  // The bound holds even for a source that ignores its signal.
  const bounded = <T>(work: Promise<T>): Promise<T> => Promise.race([work, new Promise<never>((_, reject) => {
    if (deadline.aborted) reject(deadline.reason)
    deadline.addEventListener('abort', () => reject(deadline.reason), { once: true })
  })])
  const note = (reason: string): string => `Run context not loaded: ${reason}`
  try {
    const publishers = await bounded(sources.publishers(roomId, deadline))
    if (publishers.length === 0) return undefined
    const focusedKeys = new Set(focused.flatMap(subject => 'revisionId' in subject ? [] : [keyOf(subject)]))
    const inFocus = publishers.filter(publisher => focusedKeys.has(keyOf(publisher.resource)))
    const chosen = publishers.length === 1 ? publishers[0] : inFocus.length === 1 ? inFocus[0] : undefined
    if (!chosen) return note(`${publishers.length} Runs in scope, ${inFocus.length === 0 ? 'none' : inFocus.length} focused`)
    const read = await bounded(sources.read(chosen, caller, deadline))
    if (!read.ok) return note(read.refusal.error ?? 'the Run refused it')
    const { text, at, clock } = read.context
    return `Run ${chosen.resource.id} as of ${at} (${clock} time):\n${text}`
  } catch (error) {
    if (signal.aborted) throw error
    if (deadline.aborted) return note(`World did not answer within ${timeoutMs / 1000} s`)
    return note(error instanceof Error ? error.message : String(error))
  }
}
