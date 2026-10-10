// The display chip that stands in place of a ```leitbild-view fence in a posted
// answer. It never shows the display itself: it asks the Workspace's one
// process display window to open it. Neutral and accent colours only; a
// refusal is not a process alarm.
import type { EmbeddedViewListing } from '@leitbild/contracts'
import { icon, type IconName } from '../icon.ts'

type ChipState = 'preparing' | 'available' | 'refused' | 'unhosted'

const CHIP = 'flex items-center gap-3 w-full max-w-[520px] min-h-[44px] px-3 py-1.5 rounded-md border border-border bg-surface text-left no-underline'
const INTERACTIVE = 'interactive cursor-pointer hover:bg-surface-strong hover:border-accent'
const SUBTITLE = 'Live process display · AI-composed'

// A shown chip's listing, so chips rendered before the Host announced itself
// can become Open buttons when it does.
const chipListings = new WeakMap<HTMLElement, EmbeddedViewListing>()

const lines = (title: string, subtitle: string, options: { readonly titleTooltip: boolean; readonly wrapSubtitle: boolean }): HTMLElement => {
  const text = document.createElement('span')
  text.className = 'flex-1 min-w-0 flex flex-col leading-tight'
  const first = document.createElement('span')
  first.className = 'block truncate text-[13px] font-semibold text-text-strong'
  first.textContent = title
  if (options.titleTooltip) first.title = title
  const second = document.createElement('span')
  second.className = `block text-[11.5px] text-text-subtle${options.wrapSubtitle ? ' break-words' : ' truncate'}`
  second.textContent = subtitle
  text.append(first, second)
  return text
}

const leadingIcon = (name: IconName, className: string): SVGSVGElement => {
  const glyph = icon(name, { size: 18, className: `shrink-0 ${className}` })
  glyph.setAttribute('aria-hidden', 'true')
  return glyph
}

const show = (host: HTMLElement, state: ChipState, chip: HTMLElement): void => {
  host.dataset.liveView = state
  host.replaceChildren(chip)
}

/** The element that replaces the fence's `<pre>`; it keeps its place while the chip changes state. */
export const createChipHost = (): HTMLElement => {
  const host = document.createElement('div')
  host.className = 'my-2'
  return host
}

export const showPreparing = (host: HTMLElement): void => {
  const chip = document.createElement('button')
  chip.type = 'button'
  chip.disabled = true
  chip.className = `${CHIP} cursor-wait`
  const spinner = leadingIcon('loader-circle', 'text-text-muted animate-spin')
  chip.append(spinner, lines('Preparing display…', SUBTITLE, { titleTooltip: false, wrapSubtitle: false }))
  chipListings.delete(host)
  show(host, 'preparing', chip)
}

export const showAvailable = (host: HTMLElement, listing: EmbeddedViewListing, open: (listing: EmbeddedViewListing) => void): void => {
  const title = listing.envelope.title
  const chip = document.createElement('button')
  chip.type = 'button'
  chip.className = `${CHIP} ${INTERACTIVE}`
  chip.setAttribute('aria-label', `Open live display: ${title}`)
  const action = document.createElement('span')
  action.className = 'shrink-0 text-xs font-medium text-accent'
  action.textContent = 'Open'
  chip.append(leadingIcon('monitor-cog', 'text-accent'), lines(title, SUBTITLE, { titleTooltip: true, wrapSubtitle: false }), action)
  chip.onclick = event => {
    event.stopPropagation()
    open(listing)
  }
  chipListings.set(host, listing)
  show(host, 'available', chip)
}

export const showRefused = (host: HTMLElement, code: string, message: string): void => {
  const chip = document.createElement('div')
  chip.className = CHIP
  chip.append(leadingIcon('monitor-off', 'text-text-muted'), lines('Display not shown', `${message} (${code})`, { titleTooltip: false, wrapSubtitle: true }))
  chipListings.delete(host)
  show(host, 'refused', chip)
}

/** Outside the Host nothing shows displays here: say so and link to the Workspace page with this room. */
export const showUnhosted = (host: HTMLElement, listing: EmbeddedViewListing, href: string): void => {
  const title = listing.envelope.title
  const chip = document.createElement('a')
  chip.href = href
  chip.target = '_top'
  chip.className = `${CHIP} ${INTERACTIVE} text-text`
  chip.setAttribute('aria-label', `Open live display in the workspace: ${title}`)
  const action = document.createElement('span')
  action.className = 'shrink-0 inline-flex items-center gap-1 text-xs font-medium text-accent'
  action.append('Open workspace', icon('external-link', { size: 14 }))
  chip.append(leadingIcon('monitor-cog', 'text-accent'), lines(title, 'Process displays open in the Leitbild workspace', { titleTooltip: true, wrapSubtitle: false }), action)
  chipListings.set(host, listing)
  show(host, 'unhosted', chip)
}

/** Once the Host has announced itself, every chip that linked to the Workspace page opens the display instead. */
export const promoteUnhostedChips = (root: ParentNode, open: (listing: EmbeddedViewListing) => void): void => {
  for (const host of root.querySelectorAll<HTMLElement>('[data-live-view="unhosted"]')) {
    const listing = chipListings.get(host)
    if (listing === undefined) throw new Error('A display chip linking to the Workspace page lost its listing')
    showAvailable(host, listing, open)
  }
}

/** The listing of the first chip under `root` that opens its display, if any. */
export const firstAvailableListing = (root: ParentNode): EmbeddedViewListing | null => {
  const host = root.querySelector<HTMLElement>('[data-live-view="available"]')
  return host === null ? null : chipListings.get(host) ?? null
}

/** Fences outside a posted answer (human messages, comparison reruns) never become displays. */
export const fenceNotice = (text: string): HTMLElement => {
  const element = document.createElement('div')
  element.className = 'my-2 px-3 py-2 rounded border border-border text-xs text-text-muted'
  element.textContent = text
  return element
}
