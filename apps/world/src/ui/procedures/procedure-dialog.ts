import type { Attachment } from 'svelte/attachments'

const focusableSelector = 'button:not(:disabled), a[href], textarea:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'

/**
 * A procedure window dialog: focus lands on its primary action (`data-dialog-primary`)
 * when it opens, Tab stays inside it, Escape cancels it, and focus returns where it was.
 */
export const procedureDialog = (cancel: () => void): Attachment<HTMLElement> => element => {
  const owner = element.ownerDocument
  const previous = owner.activeElement
  const focusables = (): HTMLElement[] => [...element.querySelectorAll<HTMLElement>(focusableSelector)]
  ;(element.querySelector<HTMLElement>('[data-dialog-primary]:not(:disabled)') ?? focusables()[0] ?? element).focus()
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      cancel()
      return
    }
    if (event.key !== 'Tab') return
    const items = focusables()
    const first = items[0]
    const last = items.at(-1)
    if (!first || !last) {
      event.preventDefault()
      return
    }
    const active = owner.activeElement
    if (event.shiftKey && (active === first || !element.contains(active))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (active === last || !element.contains(active))) {
      event.preventDefault()
      first.focus()
    }
  }
  element.addEventListener('keydown', onKeyDown)
  return () => {
    element.removeEventListener('keydown', onKeyDown)
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
  }
}
