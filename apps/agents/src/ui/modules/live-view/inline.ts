// A display shown inline in its answer, on the reader's request, as well as
// in the Workspace's process display window. The frame is World's embed page
// at the height the display was published with. It samples only while it can
// be seen: it mounts when its slot scrolls into view and is dropped after the
// slot has been out of view for a while; the slot keeps its height meanwhile,
// so the conversation does not jump.
import type { EmbeddedViewEnvelope } from '@leitbild/contracts'
import { embeddedViewFragment, embeddedViewPath } from '@leitbild/contracts/embedded-view-route'

// Long enough to scroll past and back without reloading the display, short
// enough that a display scrolled out of sight soon stops sampling.
const OFFSCREEN_UNMOUNT_MS = 30_000
// How often slots whose answer left the page are released.
const SWEEP_MS = 2_000

interface InlineSlot {
  readonly slot: HTMLElement
  readonly envelope: EmbeddedViewEnvelope
  readonly observer: IntersectionObserver
  frame: HTMLIFrameElement | null
  offscreenTimer: ReturnType<typeof setTimeout> | undefined
}

const slots = new Map<HTMLElement, InlineSlot>()
let sweepTimer: ReturnType<typeof setInterval> | undefined

const frameFor = (envelope: EmbeddedViewEnvelope): HTMLIFrameElement => {
  const frame = document.createElement('iframe')
  frame.src = embeddedViewPath(envelope) + embeddedViewFragment(envelope)
  frame.title = `Live display: ${envelope.title}`
  frame.style.cssText = `display:block;width:100%;height:${envelope.height}px;border:0;`
  // The chat page may hold camera permission for biometrics; a display never gets it.
  frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'")
  frame.setAttribute('referrerpolicy', 'same-origin')
  return frame
}

const unmount = (inline: InlineSlot): void => {
  clearTimeout(inline.offscreenTimer)
  inline.offscreenTimer = undefined
  inline.frame?.remove()
  inline.frame = null
}

const mount = (inline: InlineSlot): void => {
  clearTimeout(inline.offscreenTimer)
  inline.offscreenTimer = undefined
  if (inline.frame !== null) return
  inline.frame = frameFor(inline.envelope)
  inline.slot.replaceChildren(inline.frame)
}

const onVisibility = (inline: InlineSlot, visible: boolean): void => {
  if (visible) { mount(inline); return }
  if (inline.frame !== null && inline.offscreenTimer === undefined) {
    inline.offscreenTimer = setTimeout(() => unmount(inline), OFFSCREEN_UNMOUNT_MS)
  }
}

const release = (inline: InlineSlot): void => {
  inline.observer.disconnect()
  unmount(inline)
  slots.delete(inline.slot)
  if (slots.size === 0) { clearInterval(sweepTimer); sweepTimer = undefined }
}

const sweep = (): void => {
  for (const inline of [...slots.values()]) if (!inline.slot.isConnected) release(inline)
}

/** Shows the display in `slot` until hideInline; the slot reserves the display's height. */
export const showInline = (slot: HTMLElement, envelope: EmbeddedViewEnvelope): void => {
  const existing = slots.get(slot)
  if (existing !== undefined) release(existing)
  slot.style.height = `${envelope.height}px`
  slot.replaceChildren()
  const inline: InlineSlot = {
    slot,
    envelope,
    frame: null,
    offscreenTimer: undefined,
    observer: new IntersectionObserver(entries => {
      for (const entry of entries) onVisibility(inline, entry.isIntersecting)
    }),
  }
  slots.set(slot, inline)
  inline.observer.observe(slot)
  sweepTimer ??= setInterval(sweep, SWEEP_MS)
}

export const hideInline = (slot: HTMLElement): void => {
  const inline = slots.get(slot)
  if (inline !== undefined) release(inline)
  slot.style.height = ''
  slot.replaceChildren()
}
