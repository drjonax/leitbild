// The display chip that stands in place of a ```leitbild-view fence in a posted
// answer. Its main button opens the display in the Workspace's one process
// display window; its Inline button shows the same live display in the answer
// too, below the chip, until the reader hides it. A vignette's chip shows its
// frozen card, the lines the answer cites, and each ⟦k⟧ in the answer becomes
// a chip linked to its line. Neutral and accent colours only; a refusal is not
// a process alarm.
import type { EmbeddedViewListing } from '@leitbild/contracts'
import { icon, type IconName } from '../icon.ts'
import { hideInline, showInline } from './inline.ts'
import { frozenCardText, itemOf, type frozenCard, type TurnCardsRead } from './cards.ts'

/** What a chip shows of its vignette's card: the frozen card, or why it cannot. */
export type ChipCard = ReturnType<typeof frozenCard> | { readonly refused: string }

type ChipState = 'preparing' | 'available' | 'refused' | 'unhosted'

const ROW = 'flex items-stretch gap-2 w-full max-w-[520px]'
const CHIP = 'flex items-center gap-3 flex-1 min-w-0 min-h-[44px] px-3 py-1.5 rounded-md border border-border bg-surface text-left no-underline'
const INTERACTIVE = 'interactive cursor-pointer hover:bg-surface-strong hover:border-accent'
const SIDE_BUTTON = 'shrink-0 inline-flex items-center gap-1 min-h-[44px] px-3 rounded-md border border-border bg-surface text-xs font-medium text-text-muted interactive cursor-pointer hover:bg-surface-strong hover:border-accent hover:text-accent'
const SUBTITLE = 'Live process display · AI-composed'

/** What a chip that offers its display does when the reader asks. */
export interface ChipActions {
  readonly open: (listing: EmbeddedViewListing) => void
  /** Whether the reader asked to see this display inline; kept across re-renders of the answer. */
  readonly inlineShown: (key: string) => boolean
  readonly setInlineShown: (key: string, shown: boolean) => void
}

// A shown chip's listing, so chips rendered before the Host announced itself
// can become Open buttons when it does.
const chipListings = new WeakMap<HTMLElement, EmbeddedViewListing>()
const chipCards = new WeakMap<HTMLElement, ChipCard>()
// The element below a chip that holds its inline display, made on first use.
const inlineSlots = new WeakMap<HTMLElement, HTMLElement>()
let inlineSlotSequence = 0
let cardTextSequence = 0

/**
 * A chip with a frozen card is named by its action alone; the card's title,
 * time, lines and "+N" are its description, which the action's label would
 * otherwise hide from assistive technology. A card that could not be read is
 * described by why.
 */
const nameAndDescribe = (control: HTMLElement, action: string, title: string, card: ChipCard | undefined): void => {
  if (card === undefined) return
  const description = document.createElement('span')
  cardTextSequence += 1
  description.id = `live-view-card-${cardTextSequence}`
  description.className = 'sr-only'
  description.textContent = 'refused' in card ? card.refused : frozenCardText(title, card)
  control.append(description)
  if (!('refused' in card)) control.setAttribute('aria-label', action)
  control.setAttribute('aria-describedby', description.id)
}

const lines = (title: string, subtitle: string, options: { readonly titleTooltip: boolean; readonly wrapSubtitle: boolean; readonly card?: ChipCard }): HTMLElement => {
  const text = document.createElement('span')
  text.className = 'flex-1 min-w-0 flex flex-col leading-tight'
  const first = document.createElement('span')
  first.className = 'block truncate text-[13px] font-semibold text-text-strong'
  first.textContent = title
  if (options.titleTooltip) first.title = title
  const second = document.createElement('span')
  second.className = `block text-[11.5px] text-text-subtle${options.wrapSubtitle ? ' break-words' : ' truncate'}`
  second.textContent = options.card === undefined ? subtitle : 'refused' in options.card ? `${subtitle} · ${options.card.refused}` : options.card.caption
  text.append(first, second)
  if (options.card !== undefined && !('refused' in options.card)) {
    text.append(Object.assign(document.createElement('span'), { className: 'block text-[11.5px] text-text-subtle', textContent: options.card.mark }))
    for (const line of options.card.lines) {
      const row = document.createElement('span')
      row.className = 'block truncate text-[11.5px] text-text-muted rounded'
      row.dataset.cardKey = line.key
      row.textContent = line.text
      text.append(row)
    }
    if (options.card.more > 0) text.append(Object.assign(document.createElement('span'), { className: 'block text-[11.5px] text-text-subtle', textContent: `+${options.card.more}` }))
  }
  return text
}

const leadingIcon = (name: IconName, className: string): SVGSVGElement => {
  const glyph = icon(name, { size: 18, className: `shrink-0 ${className}` })
  glyph.setAttribute('aria-hidden', 'true')
  return glyph
}

// Only the chip's row is replaced when its state changes: the inline slot
// below it stays in place, because moving a frame in the DOM reloads it.
const show = (host: HTMLElement, state: ChipState, row: HTMLElement): void => {
  host.dataset.liveView = state
  const current = host.firstElementChild
  if (current !== null && current !== inlineSlots.get(host)) current.replaceWith(row)
  else host.prepend(row)
}

const inlineSlotOf = (host: HTMLElement): HTMLElement => {
  const existing = inlineSlots.get(host)
  if (existing !== undefined) return existing
  const slot = document.createElement('div')
  inlineSlotSequence += 1
  slot.id = `live-view-inline-${inlineSlotSequence}`
  slot.className = 'mt-2 w-full rounded-md border border-border overflow-hidden'
  inlineSlots.set(host, slot)
  return slot
}

const applyInline = (host: HTMLElement, listing: EmbeddedViewListing, shown: boolean): void => {
  const slot = inlineSlotOf(host)
  if (shown) {
    if (slot.parentElement !== host) host.append(slot)
    showInline(slot, listing.envelope)
    return
  }
  hideInline(slot)
  slot.remove()
}

const dropInline = (host: HTMLElement): void => {
  const slot = inlineSlots.get(host)
  if (slot === undefined) return
  hideInline(slot)
  slot.remove()
}

const inlineButton = (host: HTMLElement, listing: EmbeddedViewListing, actions: ChipActions): HTMLButtonElement => {
  const title = listing.envelope.title
  const button = document.createElement('button')
  button.type = 'button'
  button.className = SIDE_BUTTON
  const paint = (): void => {
    const shown = actions.inlineShown(listing.key)
    button.setAttribute('aria-expanded', String(shown))
    // It controls the inline display only while that is in the answer.
    if (shown) button.setAttribute('aria-controls', inlineSlotOf(host).id)
    else button.removeAttribute('aria-controls')
    button.setAttribute('aria-label', `${shown ? 'Hide' : 'Show'} the live display in this answer: ${title}`)
    button.title = shown ? 'Hide the display in this answer' : 'Show the display in this answer'
    const glyph = icon('chevron-down', { size: 14, className: shown ? 'rotate-180' : '' })
    glyph.setAttribute('aria-hidden', 'true')
    button.replaceChildren(glyph, shown ? 'Hide' : 'Inline')
  }
  button.onclick = event => {
    event.stopPropagation()
    const shown = !actions.inlineShown(listing.key)
    actions.setInlineShown(listing.key, shown)
    applyInline(host, listing, shown)
    paint()
  }
  paint()
  return button
}

const offerRow = (host: HTMLElement, listing: EmbeddedViewListing, main: HTMLElement, actions: ChipActions): HTMLElement => {
  const row = document.createElement('div')
  row.className = ROW
  row.append(main, inlineButton(host, listing, actions))
  chipListings.set(host, listing)
  // An answer rendered again shows inline what the reader showed inline before.
  if (actions.inlineShown(listing.key) && inlineSlots.get(host)?.parentElement !== host) applyInline(host, listing, true)
  return row
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
  chip.className = `${CHIP} max-w-[520px] cursor-wait`
  const spinner = leadingIcon('loader-circle', 'text-text-muted animate-spin')
  chip.append(spinner, lines('Preparing display…', SUBTITLE, { titleTooltip: false, wrapSubtitle: false }))
  chipListings.delete(host)
  chipCards.delete(host)
  dropInline(host)
  show(host, 'preparing', chip)
}

export const showAvailable = (host: HTMLElement, listing: EmbeddedViewListing, actions: ChipActions, card = chipCards.get(host)): void => {
  const title = listing.envelope.title
  if (card !== undefined) chipCards.set(host, card)
  const frozen = card !== undefined && !('refused' in card)
  const chip = document.createElement('button')
  chip.type = 'button'
  chip.className = `${CHIP} ${INTERACTIVE}`
  chip.setAttribute('aria-label', `Open live display in the display window: ${title}`)
  const action = document.createElement('span')
  action.className = 'shrink-0 text-xs font-medium text-accent'
  action.textContent = frozen ? 'Open live' : 'Open'
  chip.append(leadingIcon('monitor-cog', 'text-accent'), lines(title, SUBTITLE, { titleTooltip: true, wrapSubtitle: false, ...(card === undefined ? {} : { card }) }), action)
  nameAndDescribe(chip, 'Open live in the display window', title, card)
  chip.onclick = event => {
    event.stopPropagation()
    actions.open(listing)
  }
  show(host, 'available', offerRow(host, listing, chip, actions))
}

export const showRefused = (host: HTMLElement, code: string, message: string): void => {
  const chip = document.createElement('div')
  chip.className = `${CHIP} max-w-[520px]`
  chip.append(leadingIcon('monitor-off', 'text-text-muted'), lines('Display not shown', `${message} (${code})`, { titleTooltip: false, wrapSubtitle: true }))
  chipListings.delete(host)
  dropInline(host)
  show(host, 'refused', chip)
}

/** Outside the Host no window shows displays: link to the Workspace page with this room; Inline still shows the display here. */
export const showUnhosted = (host: HTMLElement, listing: EmbeddedViewListing, href: string, actions: ChipActions, card?: ChipCard): void => {
  const title = listing.envelope.title
  if (card !== undefined) chipCards.set(host, card)
  const chip = document.createElement('a')
  chip.href = href
  chip.target = '_top'
  chip.className = `${CHIP} ${INTERACTIVE} text-text`
  chip.setAttribute('aria-label', `Open live display in the workspace: ${title}`)
  const action = document.createElement('span')
  action.className = 'shrink-0 inline-flex items-center gap-1 text-xs font-medium text-accent'
  action.append('Open workspace', icon('external-link', { size: 14 }))
  chip.append(leadingIcon('monitor-cog', 'text-accent'), lines(title, 'Process displays open in the Leitbild workspace', { titleTooltip: true, wrapSubtitle: false, ...(card === undefined ? {} : { card }) }), action)
  nameAndDescribe(chip, 'Open live in the workspace', title, card)
  show(host, 'unhosted', offerRow(host, listing, chip, actions))
}

/** Once the Host has announced itself, every chip that linked to the Workspace page opens the display instead. */
export const promoteUnhostedChips = (root: ParentNode, actions: ChipActions): void => {
  for (const host of root.querySelectorAll<HTMLElement>('[data-live-view="unhosted"]')) {
    const listing = chipListings.get(host)
    if (listing === undefined) throw new Error('A display chip linking to the Workspace page lost its listing')
    showAvailable(host, listing, actions)
  }
}

/** The listing of the first chip under `root` that opens its display in the window, if any. */
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

const KEY_TOKEN = /⟦(k\d+)⟧/g

/** A chip for one cited key: its line's words, and a click that brings its frozen line into view; an unknown key says so. */
const keyChip = (container: HTMLElement, key: string, read: TurnCardsRead): HTMLElement => {
  const item = read.kind === 'cards' ? itemOf(read.cards, key) : undefined
  const chip = document.createElement(item === undefined ? 'span' : 'button')
  chip.dataset.cites = key
  chip.className = `inline-flex items-center px-1 mx-0.5 rounded border text-[11px] font-mono leading-tight ${item === undefined ? 'border-dashed border-border-strong text-text-subtle' : 'border-border text-text-muted interactive cursor-pointer hover:border-accent hover:text-accent'}`
  chip.textContent = item === undefined ? `${key}?` : key
  chip.title = item !== undefined ? `${key} · ${item.label} · ${item.reading}` : read.kind === 'refused' ? `${key}: ${read.message}` : `${key} is on no card of this answer`
  if (chip instanceof HTMLButtonElement) {
    chip.type = 'button'
    chip.onclick = event => {
      event.stopPropagation()
      const line = container.querySelector<HTMLElement>(`[data-card-key="${key}"]`)
      if (line === null) return
      line.scrollIntoView({ block: 'nearest' })
      line.classList.add('bg-surface-strong')
      setTimeout(() => line.classList.remove('bg-surface-strong'), 1_500)
    }
  }
  return chip
}

/** Replaces each ⟦k⟧ in an answer's prose (never in code or a display chip) with its key chip. */
export const citeKeys = (container: HTMLElement, read: TurnCardsRead): void => {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  const texts: Text[] = []
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.textContent?.includes('⟦k') && node.parentElement?.closest('code, pre, [data-live-view]') === null) texts.push(node as Text)
  }
  for (const text of texts) {
    const parts: Array<string | HTMLElement> = []
    let last = 0
    for (const match of text.data.matchAll(KEY_TOKEN)) {
      parts.push(text.data.slice(last, match.index), keyChip(container, match[1]!, read))
      last = match.index! + match[0].length
    }
    text.replaceWith(...parts, text.data.slice(last))
  }
}
