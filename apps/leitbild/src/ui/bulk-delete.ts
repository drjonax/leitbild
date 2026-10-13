// Deleting one or many things from the Host pages, for ConfirmDialog.svelte:
// a runner with bounded concurrency that gives every item an explicit
// outcome, and the count-specific words the dialog shows. Nothing retries on
// its own: "Try again" runs only the items that failed, once more.

import { plainErrorText } from './error-text.ts'

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

// ---------- Words ----------

export interface Noun {
  readonly one: string
  readonly many: string
}

export const WORKSPACE_NOUN: Noun = { one: 'Workspace', many: 'Workspaces' }
export const SIMULATION_NOUN: Noun = { one: 'simulation', many: 'simulations' }
export const CONVERSATION_NOUN: Noun = { one: 'conversation', many: 'conversations' }
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
      : `${failed} of ${total} ${noun.many} were not deleted`
