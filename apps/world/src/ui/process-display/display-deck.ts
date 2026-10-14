import type { EmbeddedViewListing } from '@leitbild/contracts'
import { processDisplayStatePlantId, processDisplayStateSchema } from '../../packs/process-plant/displays/composition.ts'
import type { DisplayKind } from './display-zoom.ts'

// The displays the one process display window steps through: the unit
// overview of each Process Plant in the Run, in rail order, then the displays
// the conversation's answers composed, oldest first. New answers append, but
// positions do shift: the conversation lists only its 30 most recent displays,
// so the oldest drops off the front, and the overviews are inserted ahead of
// the answers as the Run's Plants load. The window never changes what it shows
// by itself: the shown display stays (and says why) when it leaves the Run or
// the conversation, and a new answer only raises "New".

/** Mounted display frames: the shown one and the three most recently shown. */
export const DISPLAY_DECK_MOUNTED_LIMIT = 4

/** A Process Plant of the Run, as the rail lists it. */
export interface DeckPlant {
  readonly objectId: string
  readonly plantId: string
  readonly label: string
}

interface DeckEntryBase {
  readonly key: string
  readonly title: string
  readonly caption: string
  readonly kind: DisplayKind
}

export interface OverviewDeckEntry extends DeckEntryBase {
  readonly source: 'overview'
  readonly plant: DeckPlant
  /** False once the Plant left the Run while its overview was shown. */
  readonly inRun: boolean
}

export interface AnswerDeckEntry extends DeckEntryBase {
  readonly source: 'answer'
  readonly listing: EmbeddedViewListing
  /** The display is about another Run than the one this window belongs to. */
  readonly otherRun: boolean
  /** False while the conversation does not list it (it left, or was opened before the list caught up). */
  readonly listed: boolean
}

export type DeckEntry = OverviewDeckEntry | AnswerDeckEntry

/** What the window shows, with where it sat in its group so it can stay there when it leaves the list. */
export interface ShownDeckEntry {
  readonly entry: DeckEntry
  readonly groupIndex: number
  /** The conversation listed it since it was shown, so leaving the list means it left the conversation. */
  readonly wasListed: boolean
}

export const UNIT_OVERVIEW_CAPTION = 'Unit overview'
export const LEFT_RUN_CAPTION = 'No longer in this Run'
export const LEFT_CONVERSATION_CAPTION = 'No longer in the conversation'
const OTHER_RUN_SUFFIX = ' · other Run'

export const overviewDeckKey = (simulationRunId: string, plantId: string): string => `overview:${simulationRunId}:${plantId}`

// Agents' keys are its own; a prefix keeps them apart from overview keys.
export const answerDeckKey = (listingKey: string): string => `answer:${listingKey}`

interface ParsedDisplayState {
  readonly kind: DisplayKind
  readonly plantId: string | null
}

// Listings keep their identity until the next list replaces them, so each
// state is parsed once however often the Run's objects change.
const parsedStates = new WeakMap<EmbeddedViewListing, ParsedDisplayState>()

const parseListingState = (listing: EmbeddedViewListing): ParsedDisplayState => {
  const cached = parsedStates.get(listing)
  if (cached) return cached
  let parsed: ParsedDisplayState = { kind: 'advice', plantId: null }
  try {
    const state = processDisplayStateSchema.safeParse(JSON.parse(listing.envelope.state) as unknown)
    // A state World cannot read still opens: its frame says what is wrong. It only names no Plant here.
    if (state.success) parsed = { kind: 'composition' in state.data ? 'advice' : 'generated', plantId: processDisplayStatePlantId(state.data) }
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err
  }
  parsedStates.set(listing, parsed)
  return parsed
}

const overviewEntry = (simulationRunId: string, plant: DeckPlant): OverviewDeckEntry => ({
  source: 'overview',
  key: overviewDeckKey(simulationRunId, plant.plantId),
  title: plant.label,
  caption: UNIT_OVERVIEW_CAPTION,
  kind: 'generated',
  plant,
  inRun: true,
})

export const answerDeckEntry = (simulationRunId: string, listing: EmbeddedViewListing): AnswerDeckEntry => {
  const otherRun = listing.envelope.subject.id !== simulationRunId
  return {
    source: 'answer',
    key: answerDeckKey(listing.key),
    title: listing.envelope.title,
    caption: `${listing.caption}${otherRun ? OTHER_RUN_SUFFIX : ''}`,
    kind: parseListingState(listing).kind,
    listing,
    otherRun,
    listed: true,
  }
}

const insertAt = <T>(items: ReadonlyArray<T>, index: number, item: T): ReadonlyArray<T> => {
  const at = Math.max(0, Math.min(items.length, index))
  return [...items.slice(0, at), item, ...items.slice(at)]
}

/** Overviews in rail order, then the answers' displays oldest first, with the shown entry kept where it was. */
export const buildDisplayDeck = (input: {
  readonly simulationRunId: string
  readonly plants: ReadonlyArray<DeckPlant>
  readonly listings: ReadonlyArray<EmbeddedViewListing>
  readonly shown: ShownDeckEntry | null
}): ReadonlyArray<DeckEntry> => {
  let overviews: ReadonlyArray<DeckEntry> = input.plants.map(plant => overviewEntry(input.simulationRunId, plant))
  let answers: ReadonlyArray<DeckEntry> = input.listings.map(listing => answerDeckEntry(input.simulationRunId, listing))
  const shown = input.shown
  if (shown !== null) {
    const { entry } = shown
    if (entry.source === 'overview' && !overviews.some(candidate => candidate.key === entry.key)) {
      overviews = insertAt(overviews, shown.groupIndex, { ...entry, caption: LEFT_RUN_CAPTION, inRun: false })
    }
    if (entry.source === 'answer' && !answers.some(candidate => candidate.key === entry.key)) {
      const caption = shown.wasListed
        ? `${LEFT_CONVERSATION_CAPTION}${entry.otherRun ? OTHER_RUN_SUFFIX : ''}`
        : answerDeckEntry(input.simulationRunId, entry.listing).caption
      answers = insertAt(answers, shown.groupIndex, { ...entry, caption, listed: false })
    }
  }
  return [...overviews, ...answers]
}

/** Where an entry sits within its group (overviews or answers). */
export const deckGroupIndex = (deck: ReadonlyArray<DeckEntry>, key: string): number => {
  const entry = deck.find(candidate => candidate.key === key)
  if (!entry) return 0
  return deck.filter(candidate => candidate.source === entry.source).findIndex(candidate => candidate.key === key)
}

/** The entry the window shows from now on. */
export const shownDeckEntry = (
  deck: ReadonlyArray<DeckEntry>,
  entry: DeckEntry,
  listings: ReadonlyArray<EmbeddedViewListing>,
): ShownDeckEntry => ({
  entry,
  groupIndex: deck.some(candidate => candidate.key === entry.key)
    ? deckGroupIndex(deck, entry.key)
    : entry.source === 'answer' ? listings.length : deck.filter(candidate => candidate.source === 'overview').length,
  wasListed: entry.source === 'answer' && listings.some(listing => listing.key === entry.listing.key),
})

/** A new list arrived: the shown entry remembers whether and where the conversation lists it. */
export const observeListingsForShown = (
  shown: ShownDeckEntry | null,
  listings: ReadonlyArray<EmbeddedViewListing>,
): ShownDeckEntry | null => {
  if (shown === null || shown.entry.source !== 'answer') return shown
  const listingKey = shown.entry.listing.key
  const index = listings.findIndex(listing => listing.key === listingKey)
  if (index < 0) return shown
  if (shown.wasListed && shown.groupIndex === index) return shown
  return { ...shown, groupIndex: index, wasListed: true }
}

export type DeckStep = 'first' | 'previous' | 'next' | 'last'

/** Stepping stops at the ends: from the first overview, back never lands on the newest answer. */
export const steppedDeckEntry = (deck: ReadonlyArray<DeckEntry>, currentKey: string | null, step: DeckStep): DeckEntry | null => {
  if (deck.length === 0) return null
  if (step === 'first') return deck[0]!
  if (step === 'last') return deck[deck.length - 1]!
  const index = deck.findIndex(entry => entry.key === currentKey)
  if (index < 0) return deck[0]!
  const next = step === 'previous' ? index - 1 : index + 1
  return next < 0 || next >= deck.length ? null : deck[next]!
}

/** Answers' displays the operator has had in view, or that were there when the window opened. */
export interface DeckAcknowledgement {
  readonly keys: ReadonlySet<string>
  /** The displays the last list that listed any had: the conversation the window follows; null until a list has listed one. */
  readonly conversation: ReadonlySet<string> | null
}

// Enough for many room switches in one window session; the oldest are forgotten first.
const ACKNOWLEDGED_LIMIT = 500

const withKeys = (current: ReadonlySet<string>, added: ReadonlyArray<string>): ReadonlySet<string> => {
  if (added.every(key => current.has(key))) return current
  const next = [...current, ...added.filter(key => !current.has(key))]
  return new Set(next.slice(Math.max(0, next.length - ACKNOWLEDGED_LIMIT)))
}

export const openingAcknowledgement = (listings: ReadonlyArray<EmbeddedViewListing>): DeckAcknowledgement => ({
  keys: withKeys(new Set(), listings.map(listing => listing.key)),
  conversation: listings.length === 0 ? null : new Set(listings.map(listing => listing.key)),
})

/**
 * A new list arrived. Only displays added while the same conversation goes
 * on are new. A list that keeps none of the displays the conversation last
 * listed is another conversation's (the chat switched rooms, and the Host
 * empties the list in between): its displays were there before the operator
 * came to them, so they count as seen. An empty list ends nothing, so the
 * chat page reloading its room brings back the same conversation.
 */
export const observeConversation = (
  acknowledgement: DeckAcknowledgement,
  listings: ReadonlyArray<EmbeddedViewListing>,
): DeckAcknowledgement => {
  if (listings.length === 0) return acknowledgement
  const keys = listings.map(listing => listing.key)
  const previous = acknowledgement.conversation
  const unchanged = previous !== null && previous.size === keys.length && keys.every(key => previous.has(key))
  if (unchanged) return acknowledgement
  const switched = previous !== null && !keys.some(key => previous.has(key))
  return {
    keys: switched ? withKeys(acknowledgement.keys, keys) : acknowledgement.keys,
    conversation: new Set(keys),
  }
}

/**
 * The operator has an entry in view. Reaching the newest answer acknowledges
 * every answer before it too: "New" is about whether the newest was seen.
 */
export const acknowledgeShown = (
  acknowledgement: DeckAcknowledgement,
  listings: ReadonlyArray<EmbeddedViewListing>,
  entry: DeckEntry,
): DeckAcknowledgement => {
  if (entry.source !== 'answer') return acknowledgement
  const newest = listings[listings.length - 1]
  const keys = newest?.key === entry.listing.key
    ? listings.map(listing => listing.key)
    : [entry.listing.key]
  const next = withKeys(acknowledgement.keys, keys)
  return next === acknowledgement.keys ? acknowledgement : { ...acknowledgement, keys: next }
}

/** Answers listed after the window opened that the operator has not had in view, oldest first. */
export const unseenListings = (
  acknowledgement: DeckAcknowledgement,
  listings: ReadonlyArray<EmbeddedViewListing>,
): ReadonlyArray<EmbeddedViewListing> => listings.filter(listing => !acknowledgement.keys.has(listing.key))

/** The polite announcement for the newest unseen display. */
export const newDisplayAnnouncement = (unseen: ReadonlyArray<EmbeddedViewListing>): string => {
  const newest = unseen[unseen.length - 1]
  return newest === undefined ? '' : `New display from ${newest.caption}: ${newest.envelope.title}`
}

/**
 * A mounted frame, in the order frames were mounted so none moves (moving an
 * iframe reloads it). It keeps the entry it was last shown as, so its frame
 * outlives the entry leaving the deck: the Host empties the conversation's
 * list whenever the chat page loads, and the list returns a moment later.
 */
export interface MountedDeckFrame {
  readonly key: string
  readonly entry: DeckEntry
  readonly lastShown: number
}

/** Shows an entry: it is mounted (or stays mounted) and the least recently shown beyond the limit goes. */
export const touchMountedFrames = (
  frames: ReadonlyArray<MountedDeckFrame>,
  entry: DeckEntry,
  shownAt: number,
  limit: number = DISPLAY_DECK_MOUNTED_LIMIT,
): ReadonlyArray<MountedDeckFrame> => {
  const key = entry.key
  const touched = frames.some(frame => frame.key === key)
    ? frames.map(frame => frame.key === key ? { key, entry, lastShown: shownAt } : frame)
    : [...frames, { key, entry, lastShown: shownAt }]
  if (touched.length <= limit) return touched
  const evicted = new Set(
    touched
      .filter(frame => frame.key !== key)
      .sort((left, right) => left.lastShown - right.lastShown)
      .slice(0, touched.length - limit)
      .map(frame => frame.key),
  )
  return touched.filter(frame => !evicted.has(frame.key))
}

/**
 * The entries of the mounted frames, in mount order: the deck's own while the
 * deck has it, else the entry the frame was last shown as. Such a frame stays
 * mounted (hidden) but cannot be stepped to, since stepping walks the deck.
 */
export const mountedDeckEntries = (
  frames: ReadonlyArray<MountedDeckFrame>,
  deck: ReadonlyArray<DeckEntry>,
): ReadonlyArray<DeckEntry> => frames.map(frame => deck.find(entry => entry.key === frame.key) ?? frame.entry)

/** The Plant that instructor actions, procedures and the status dot act on for an entry, or why there is none. */
export type DeckPlantTarget =
  | { readonly ok: true; readonly plant: DeckPlant }
  | { readonly ok: false; readonly reason: string }

/**
 * Whether the page has opened the window's Run. Its Plants, their actions and
 * procedures need the opened Run; a display does not, since it samples its
 * Run itself, so the window shows displays while the Run opens or after it
 * failed to, and says why the Plant controls are off.
 */
export type DeckRunJoin =
  | { readonly state: 'joining' }
  | { readonly state: 'joined' }
  | { readonly state: 'failed'; readonly reason: string }

const runJoinReason = (join: DeckRunJoin): string | null =>
  join.state === 'joined' ? null : join.state === 'joining' ? 'This Run is still opening' : `This Run could not be opened: ${join.reason}`

export const deckEntryPlant = (entry: DeckEntry, plants: ReadonlyArray<DeckPlant>, join: DeckRunJoin): DeckPlantTarget => {
  if (entry.source === 'answer' && entry.otherRun) return { ok: false, reason: 'Belongs to another Run' }
  const waiting = runJoinReason(join)
  if (waiting !== null) return { ok: false, reason: waiting }
  if (entry.source === 'overview') {
    const plant = plants.find(candidate => candidate.objectId === entry.plant.objectId)
    return plant ? { ok: true, plant } : { ok: false, reason: 'The Plant is no longer in this Run' }
  }
  const plantId = parseListingState(entry.listing).plantId
  if (plantId === null) return { ok: false, reason: 'The display names no Plant World can read' }
  const plant = plants.find(candidate => candidate.plantId === plantId)
  return plant ? { ok: true, plant } : { ok: false, reason: `Plant ${plantId} is not in this Run` }
}

/** Opening the window: on a Plant's overview (rail) or on a listed display (chat). */
export type DisplayWindowTarget =
  | { readonly kind: 'overview'; readonly objectId: string }
  | { readonly kind: 'listing'; readonly listing: EmbeddedViewListing }

export interface DisplayWindowRequest {
  /** Distinguishes repeated requests for the same target. */
  readonly sequence: number
  readonly target: DisplayWindowTarget
  /** Opened from the rail: the window takes focus. From chat it must not steal the composer's keys. */
  readonly focus: boolean
  /** Opened from a Plant card's Instructor row: the window opens its Instructor actions on the Plant shown. */
  readonly instructorActions: boolean
}

/** The entry a request opens: the deck's own when present, else the self-contained listing. */
export const requestedDeckEntry = (
  deck: ReadonlyArray<DeckEntry>,
  simulationRunId: string,
  target: DisplayWindowTarget,
): DeckEntry | null => {
  if (target.kind === 'overview') {
    return deck.find(entry => entry.source === 'overview' && entry.plant.objectId === target.objectId) ?? null
  }
  const key = answerDeckKey(target.listing.key)
  return deck.find(entry => entry.key === key) ?? { ...answerDeckEntry(simulationRunId, target.listing), listed: false }
}
