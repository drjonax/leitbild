// Paging for reading material (the Getting started guide): no rotation, no
// memory. Pure functions over an index so a component keeps one `$state`.

export interface PagerView<Id extends string> {
  readonly index: number
  readonly count: number
  readonly id: Id
  readonly previousId: Id | null
  readonly nextId: Id | null
  readonly isFirst: boolean
  readonly isLast: boolean
  /** "2 / 6" */
  readonly position: string
}

/** Index of a page id or number, clamped; an unknown id is page 1. */
export const pageIndex = <Id extends string>(ids: ReadonlyArray<Id>, target: Id | number | string | null | undefined): number => {
  if (ids.length === 0) throw new Error('A pager needs at least one page')
  if (typeof target === 'number') return Math.min(ids.length - 1, Math.max(0, Math.trunc(target)))
  const found = target == null ? -1 : ids.indexOf(target as Id)
  return found === -1 ? 0 : found
}

export const pagerView = <Id extends string>(ids: ReadonlyArray<Id>, index: number): PagerView<Id> => {
  const current = pageIndex(ids, index)
  return {
    index: current,
    count: ids.length,
    id: ids[current]!,
    previousId: current > 0 ? ids[current - 1]! : null,
    nextId: current < ids.length - 1 ? ids[current + 1]! : null,
    isFirst: current === 0,
    isLast: current === ids.length - 1,
    position: `${current + 1} / ${ids.length}`,
  }
}

export interface PagerKeyEvent {
  readonly key: string
  readonly altKey: boolean
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly shiftKey: boolean
  readonly isComposing?: boolean
  readonly target: EventTarget | null
}

/** True for inputs, textareas, selects and editable content, where arrows belong to the field. */
export const isTextEntryTarget = (target: EventTarget | null): boolean => {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return false
  if (target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return true
  return false
}

/** ←/→ page when focus is not in a field and no modifier is held. */
export const pagerKeyIntent = (event: PagerKeyEvent): 'previous' | 'next' | null => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return null
  if (isTextEntryTarget(event.target)) return null
  if (event.key === 'ArrowLeft') return 'previous'
  if (event.key === 'ArrowRight') return 'next'
  return null
}
