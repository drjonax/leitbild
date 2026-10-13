// Deleting one or many things from the Host pages, for ConfirmDialog.svelte:
// a runner with bounded concurrency that gives every item an explicit
// outcome, the dialog's session (rounds, and no close while deletes run), and
// the count-specific words the dialog shows. Nothing retries on its own:
// "Try again" runs only the items that failed, once more.

import { plainError, plainErrorText } from './error-text.ts'

export type RemoveOutcome =
  | { readonly kind: 'deleted' }
  /** Someone else deleted it first: the result the visitor wanted. */
  | { readonly kind: 'gone' }
  | { readonly kind: 'failed'; readonly text: string }

export interface DeleteItem {
  /** Unique among the items of one dialog. */
  readonly key: string
  /** The name the visitor knows it by. */
  readonly label: string
  /** A short state beside the name in the dialog's list, e.g. "Running". */
  readonly note?: string
}

export interface DeleteFailure<T> {
  readonly item: T
  readonly text: string
}

export interface DeleteResult<T> {
  /** Deleted, or already gone; in the order given. */
  readonly removed: ReadonlyArray<T>
  readonly failed: ReadonlyArray<DeleteFailure<T>>
}

/** Enough to clear a long list quickly without queueing a burst of deletes on the server. */
export const DELETE_CONCURRENCY = 4

/**
 * Whether a refused delete means "someone deleted it first": a 404 whose code
 * is the owner's own "this thing does not exist" code. Any other refusal,
 * including a 404 for an unknown Capability, route or Module (a stale page or
 * a deploy), is a failure, never reported as deleted.
 */
export const isAlreadyGone = (error: unknown, goneCode: string): boolean => {
  const { status, code } = plainError(error)
  return status === 404 && code === goneCode
}

export const deleteEach = async <T>(
  items: ReadonlyArray<T>,
  remove: (item: T) => Promise<RemoveOutcome>,
  options: { readonly concurrency?: number; readonly onprogress?: (done: number, total: number) => void } = {},
): Promise<DeleteResult<T>> => {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? DELETE_CONCURRENCY))
  const outcomes: RemoveOutcome[] = []
  let next = 0
  let done = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      let outcome: RemoveOutcome
      try { outcome = await remove(items[index]!) }
      catch (error) {
        console.error('Delete failed', error)
        outcome = { kind: 'failed', text: plainErrorText(error) }
      }
      outcomes[index] = outcome
      done += 1
      options.onprogress?.(done, items.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return {
    removed: items.filter((_, index) => outcomes[index]!.kind !== 'failed'),
    failed: items.flatMap((item, index) => {
      const outcome = outcomes[index]!
      return outcome.kind === 'failed' ? [{ item, text: outcome.text }] : []
    }),
  }
}

// ---------- The dialog's session ----------

export type DeletePhase = 'confirm' | 'working' | 'failed' | 'done'

export interface DeleteSessionState<T> {
  readonly phase: DeletePhase
  /** This round's items: all of them first, then only the ones that failed. */
  readonly pending: ReadonlyArray<T>
  /** How many of this round have an outcome. */
  readonly done: number
  /** This round's result, once it has one. */
  readonly round: DeleteResult<T> | null
  /** Everything deleted (or already gone) since the session began, over all rounds. */
  readonly removed: ReadonlyArray<T>
}

export interface DeleteSession<T> {
  state(): DeleteSessionState<T>
  /** Deletes this round's items (after a failure: the failed ones); resolves when each has an outcome. */
  start(): Promise<DeleteSessionState<T>>
  /**
   * Whether a close (Cancel, Esc, a phone's Back) may end the dialog now. Not
   * while deletes run: their outcome must still be shown and reported, and a
   * browser lets a page refuse a close only once per user action.
   */
  mayClose(): boolean
}

export const createDeleteSession = <T>(
  items: ReadonlyArray<T>,
  remove: (item: T) => Promise<RemoveOutcome>,
  onchange: (state: DeleteSessionState<T>) => void = () => {},
  options: { readonly concurrency?: number } = {},
): DeleteSession<T> => {
  let current: DeleteSessionState<T> = { phase: 'confirm', pending: [...items], done: 0, round: null, removed: [] }
  const set = (next: Partial<DeleteSessionState<T>>): void => {
    current = { ...current, ...next }
    onchange(current)
  }
  return {
    state: () => current,
    start: async () => {
      if (current.phase === 'working' || current.phase === 'done') return current
      const pending = current.phase === 'failed' ? (current.round?.failed ?? []).map(failure => failure.item) : current.pending
      if (pending.length === 0) return current
      set({ phase: 'working', pending, done: 0, round: null })
      const round = await deleteEach(pending, remove, {
        ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
        onprogress: done => set({ done }),
      })
      set({ phase: round.failed.length === 0 ? 'done' : 'failed', round, removed: [...current.removed, ...round.removed] })
      return current
    },
    mayClose: () => current.phase !== 'working',
  }
}

// ---------- Words ----------

export interface Noun {
  readonly one: string
  readonly many: string
}

export const WORKSPACE_NOUN: Noun = { one: 'Workspace', many: 'Workspaces' }
export const SIMULATION_NOUN: Noun = { one: 'simulation', many: 'simulations' }
export const CONVERSATION_NOUN: Noun = { one: 'conversation', many: 'conversations' }
export const SCENARIO_NOUN: Noun = { one: 'scenario', many: 'scenarios' }
export const ITEM_NOUN: Noun = { one: 'item', many: 'items' }

/** "Workspace", "5 Workspaces"; none selected reads "Workspaces". */
export const countedNoun = (noun: Noun, count: number): string =>
  count === 1 ? noun.one : count === 0 ? noun.many : `${count} ${noun.many}`

/** "Delete Workspace", "Delete 5 Workspaces", "Delete simulation", "Delete 3 simulations". */
export const deleteLabel = (noun: Noun, count: number): string => `Delete ${countedNoun(noun, count)}`

/** The dialog's title: the name of the one item, or the count. */
export const deleteTitle = (noun: Noun, items: ReadonlyArray<DeleteItem>): string =>
  items.length === 1 ? `Delete ${items[0]!.label}?` : `Delete ${items.length} ${noun.many}?`

/** For the live region while deletes run. */
export const progressText = (noun: Noun, done: number, total: number): string =>
  total === 1 ? `Deleting the ${noun.one}…` : `Deleting ${total} ${noun.many}… ${done} of ${total} done`

/** The heading once some deletes failed. */
export const failureTitle = (noun: Noun, failed: number, total: number): string =>
  total === 1 ? `The ${noun.one} was not deleted`
    : failed === total ? `None of the ${total} ${noun.many} were deleted`
      : `${failed} of ${total} ${noun.many} ${failed === 1 ? 'was' : 'were'} not deleted`

/** Under the failure heading: what this round did delete, and that the rest is still there. */
export const failureBody = (round: DeleteResult<unknown>): string =>
  `${round.removed.length > 0 ? `${round.removed.length} deleted. ` : ''}${round.failed.length === 1 ? 'This one is still there:' : 'These are still there:'}`

/** The live region's line once the dialog has closed. */
export const deletedText = (noun: Noun, removed: ReadonlyArray<DeleteItem>): string =>
  removed.length === 0 ? '' : removed.length === 1 ? `Deleted ${removed[0]!.label}.` : `Deleted ${removed.length} ${noun.many}.`

// ---------- Selection ----------

export type SelectAllState = 'none' | 'some' | 'all'

/** The "Select all" box for the items shown (a search may hide some). */
export const selectAllState = (shown: ReadonlyArray<{ readonly key: string }>, selected: ReadonlySet<string>): SelectAllState => {
  const count = shown.filter(item => selected.has(item.key)).length
  return count === 0 ? 'none' : count === shown.length ? 'all' : 'some'
}

/** Ticking "Select all" adds every shown item; unticking it removes them. Items a search hides keep their state. */
export const toggleAll = (shown: ReadonlyArray<{ readonly key: string }>, selected: ReadonlySet<string>): ReadonlySet<string> => {
  const next = new Set(selected)
  if (selectAllState(shown, selected) === 'all') for (const item of shown) next.delete(item.key)
  else for (const item of shown) next.add(item.key)
  return next
}

/** Ticks or unticks one item. */
export const toggleOne = (selected: ReadonlySet<string>, key: string): ReadonlySet<string> => {
  const next = new Set(selected)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

/** The selection that still exists after a reload. */
export const keepExisting = (selected: ReadonlySet<string>, items: ReadonlyArray<{ readonly key: string }>): ReadonlySet<string> =>
  new Set(items.filter(item => selected.has(item.key)).map(item => item.key))
