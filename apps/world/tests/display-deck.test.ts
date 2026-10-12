import { describe, expect, test } from 'bun:test'
import { embeddedViewListingSchema, type EmbeddedViewListing } from '@leitbild/contracts'
import {
  acknowledgeShown,
  answerDeckKey,
  buildDisplayDeck,
  deckEntryPlant,
  mountedDeckEntries,
  newDisplayAnnouncement,
  observeConversation,
  observeListingsForShown,
  openingAcknowledgement,
  overviewDeckKey,
  requestedDeckEntry,
  shownDeckEntry,
  steppedDeckEntry,
  touchMountedFrames,
  unseenListings,
  type DeckEntry,
  type DeckPlant,
  type DeckRunJoin,
} from '../src/ui/process-display/display-deck.ts'
import { openedListing } from '../src/ui/embed/opened-display.ts'
import { parseDisplayFrameMessage, parseDisplayFramePresentation } from '../src/ui/embed/display-frame-protocol.ts'

const workspaceId = '1e828b43-37fc-4437-aa70-302d7f442ceb'
const runId = 'run-1'

const advisoryState = (plantId: string): string => JSON.stringify({
  composition: {
    plantId,
    title: 'Pressure check',
    question: 'Is the pressure recovering?',
    need: 'Decide on spray now',
    panels: [{ kind: 'alarms', scope: 'plant' }],
  },
  issuedAt: '2026-10-10T09:00:00.000Z',
  modelDigest: 'a'.repeat(64),
})

const listing = (key: string, config: { readonly plantId?: string; readonly run?: string; readonly state?: string; readonly caption?: string } = {}): EmbeddedViewListing =>
  embeddedViewListingSchema.parse({
    key,
    caption: config.caption ?? `Answer ${key}`,
    envelope: {
      moduleId: 'world',
      viewType: 'process-plant.display',
      subject: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: config.run ?? runId },
      title: `Display ${key}`,
      height: 600,
      state: config.state ?? advisoryState(config.plantId ?? 'unit-a'),
    },
  })

const plants: ReadonlyArray<DeckPlant> = [
  { objectId: 'unit-a', plantId: 'unit-a', label: 'Unit A' },
  { objectId: 'unit-b', plantId: 'unit-b', label: 'Unit B' },
]

const keys = (deck: ReadonlyArray<DeckEntry>): ReadonlyArray<string> => deck.map(entry => entry.key)

const joined: DeckRunJoin = { state: 'joined' }

describe('display deck', () => {
  test('lists the overviews in rail order, then the answers oldest first', () => {
    const deck = buildDisplayDeck({ simulationRunId: runId, plants, listings: [listing('one'), listing('two')], shown: null })
    expect(keys(deck)).toEqual([
      overviewDeckKey(runId, 'unit-a'),
      overviewDeckKey(runId, 'unit-b'),
      answerDeckKey('one'),
      answerDeckKey('two'),
    ])
    expect(deck[0]).toMatchObject({ title: 'Unit A', caption: 'Unit overview', kind: 'generated' })
    expect(deck[2]).toMatchObject({ title: 'Display one', caption: 'Answer one', kind: 'advice' })
  })

  test('captions a display of another Run and keeps Plant controls off it', () => {
    const deck = buildDisplayDeck({ simulationRunId: runId, plants, listings: [listing('one', { run: 'run-2' })], shown: null })
    const entry = deck[2]!
    expect(entry.caption).toBe('Answer one · other Run')
    expect(deckEntryPlant(entry, plants, joined)).toEqual({ ok: false, reason: 'Belongs to another Run' })
  })

  test('acts on the Plant an answer names when it is in this Run', () => {
    const deck = buildDisplayDeck({ simulationRunId: runId, plants, listings: [listing('b', { plantId: 'unit-b' }), listing('z', { plantId: 'unit-z' })], shown: null })
    expect(deckEntryPlant(deck[0]!, plants, joined)).toEqual({ ok: true, plant: plants[0]! })
    expect(deckEntryPlant(deck[2]!, plants, joined)).toEqual({ ok: true, plant: plants[1]! })
    expect(deckEntryPlant(deck[3]!, plants, joined)).toEqual({ ok: false, reason: 'Plant unit-z is not in this Run' })
  })

  test('shows displays while the page opens the Run, with Plant controls off and saying why', () => {
    // Before the Run is opened the page knows none of its Plants; the display still opens.
    const deck = buildDisplayDeck({ simulationRunId: runId, plants: [], listings: [listing('one', { plantId: 'unit-b' }), listing('far', { run: 'run-2' })], shown: null })
    expect(keys(deck)).toEqual([answerDeckKey('one'), answerDeckKey('far')])
    expect(deckEntryPlant(deck[0]!, [], { state: 'joining' })).toEqual({ ok: false, reason: 'This Run is still opening' })
    expect(deckEntryPlant(deck[0]!, [], { state: 'failed', reason: 'Run run-1 is not loaded' }))
      .toEqual({ ok: false, reason: 'This Run could not be opened: Run run-1 is not loaded' })
    // A display of another Run needs nothing from this one.
    expect(deckEntryPlant(deck[1]!, [], { state: 'joining' })).toEqual({ ok: false, reason: 'Belongs to another Run' })
    // Once opened, the Plants arrive and their overviews go ahead of the answers.
    const opened = buildDisplayDeck({ simulationRunId: runId, plants, listings: [listing('one', { plantId: 'unit-b' })], shown: null })
    expect(opened.findIndex(entry => entry.key === answerDeckKey('one'))).toBe(2)
    expect(deckEntryPlant(opened[2]!, plants, joined)).toEqual({ ok: true, plant: plants[1]! })
  })

  test('a display World cannot read still opens but names no Plant', () => {
    const unreadable = listing('odd', { state: '{"composition":{}}' })
    const deck = buildDisplayDeck({ simulationRunId: runId, plants, listings: [unreadable], shown: null })
    expect(deck[2]).toMatchObject({ kind: 'advice' })
    expect(deckEntryPlant(deck[2]!, plants, joined)).toEqual({ ok: false, reason: 'The display names no Plant World can read' })
  })

  test('a listed overview or detail is drawn for its frame', () => {
    const overview = listing('overview', { state: JSON.stringify({ overview: { plantId: 'unit-b' } }) })
    const deck = buildDisplayDeck({ simulationRunId: runId, plants, listings: [overview], shown: null })
    expect(deck[2]).toMatchObject({ kind: 'generated' })
    expect(deckEntryPlant(deck[2]!, plants, joined)).toEqual({ ok: true, plant: plants[1]! })
  })

  test('steps without wrapping and jumps to the ends', () => {
    const deck = buildDisplayDeck({ simulationRunId: runId, plants, listings: [listing('one')], shown: null })
    expect(steppedDeckEntry(deck, deck[0]!.key, 'previous')).toBeNull()
    expect(steppedDeckEntry(deck, deck[0]!.key, 'next')?.key).toBe(deck[1]!.key)
    expect(steppedDeckEntry(deck, deck[2]!.key, 'next')).toBeNull()
    expect(steppedDeckEntry(deck, deck[1]!.key, 'first')?.key).toBe(deck[0]!.key)
    expect(steppedDeckEntry(deck, deck[0]!.key, 'last')?.key).toBe(deck[2]!.key)
  })
})

describe('the shown display', () => {
  test('stays where it was, captioned, when it leaves the conversation', () => {
    const listings = [listing('one'), listing('two'), listing('three')]
    const before = buildDisplayDeck({ simulationRunId: runId, plants, listings, shown: null })
    const shown = shownDeckEntry(before, before[3]!, listings)
    expect(shown).toMatchObject({ groupIndex: 1, wasListed: true })

    const after = buildDisplayDeck({ simulationRunId: runId, plants, listings: [listing('one'), listing('three')], shown })
    expect(keys(after).slice(2)).toEqual([answerDeckKey('one'), answerDeckKey('two'), answerDeckKey('three')])
    expect(after[3]).toMatchObject({ caption: 'No longer in the conversation', listed: false })

    // Without it shown, it is simply gone.
    expect(keys(buildDisplayDeck({ simulationRunId: runId, plants, listings: [listing('one'), listing('three')], shown: null }))).not.toContain(answerDeckKey('two'))
  })

  test('opened from an answer before the list caught up, it keeps its own caption', () => {
    const opened = listing('new')
    const deck = buildDisplayDeck({ simulationRunId: runId, plants, listings: [listing('one')], shown: null })
    const entry = requestedDeckEntry(deck, runId, { kind: 'listing', listing: opened })!
    let shown = shownDeckEntry(deck, entry, [listing('one')])
    expect(shown).toMatchObject({ groupIndex: 1, wasListed: false })
    expect(buildDisplayDeck({ simulationRunId: runId, plants, listings: [listing('one')], shown })[3]).toMatchObject({ caption: 'Answer new' })

    // Once listed, leaving the list means it left the conversation.
    shown = observeListingsForShown(shown, [listing('one'), opened])!
    expect(shown).toMatchObject({ groupIndex: 1, wasListed: true })
    expect(buildDisplayDeck({ simulationRunId: runId, plants, listings: [], shown })[2]).toMatchObject({ caption: 'No longer in the conversation' })
  })

  test('an overview whose Plant left the Run stays shown with its Plant controls off', () => {
    const before = buildDisplayDeck({ simulationRunId: runId, plants, listings: [], shown: null })
    const shown = shownDeckEntry(before, before[1]!, [])
    const after = buildDisplayDeck({ simulationRunId: runId, plants: [plants[0]!], listings: [], shown })
    expect(after[1]).toMatchObject({ caption: 'No longer in this Run', inRun: false })
    expect(deckEntryPlant(after[1]!, [plants[0]!], joined)).toEqual({ ok: false, reason: 'The Plant is no longer in this Run' })
  })

  test('a rail request opens that Plant overview, a chat request the listed display', () => {
    const one = listing('one')
    const deck = buildDisplayDeck({ simulationRunId: runId, plants, listings: [one], shown: null })
    expect(requestedDeckEntry(deck, runId, { kind: 'overview', objectId: 'unit-b' })?.key).toBe(overviewDeckKey(runId, 'unit-b'))
    expect(requestedDeckEntry(deck, runId, { kind: 'overview', objectId: 'unit-z' })).toBeNull()
    expect(requestedDeckEntry(deck, runId, { kind: 'listing', listing: one })).toBe(deck[2]!)
  })
})

describe('new displays', () => {
  test('flags displays that arrive after the window opened until the newest is seen', () => {
    const opening = [listing('one')]
    let acknowledgement = openingAcknowledgement(opening)
    const later = [...opening, listing('two', { caption: 'Answer 14:05:12' }), listing('three', { caption: 'Answer 14:06:40' })]
    expect(unseenListings(acknowledgement, opening)).toEqual([])
    expect(unseenListings(acknowledgement, later).map(entry => entry.key)).toEqual(['two', 'three'])
    expect(newDisplayAnnouncement(unseenListings(acknowledgement, later))).toBe('New display from Answer 14:06:40: Display three')

    const deck = buildDisplayDeck({ simulationRunId: runId, plants, listings: later, shown: null })
    acknowledgement = acknowledgeShown(acknowledgement, later, deck[3]!)
    expect(unseenListings(acknowledgement, later).map(entry => entry.key)).toEqual(['three'])
    acknowledgement = acknowledgeShown(acknowledgement, later, deck[4]!)
    expect(unseenListings(acknowledgement, later)).toEqual([])
    expect(newDisplayAnnouncement([])).toBe('')
  })

  test('a list that empties and refills (the chat reloaded) brings nothing new', () => {
    const opening = [listing('one'), listing('two')]
    let acknowledgement = openingAcknowledgement(opening)
    acknowledgement = observeConversation(acknowledgement, [])
    expect(unseenListings(acknowledgement, [])).toEqual([])
    acknowledgement = observeConversation(acknowledgement, opening)
    expect(unseenListings(acknowledgement, opening)).toEqual([])
    // The same conversation, reloaded with a display added meanwhile: that one is new.
    const grown = [...opening, listing('three')]
    acknowledgement = observeConversation(observeConversation(acknowledgement, []), grown)
    expect(unseenListings(acknowledgement, grown).map(entry => entry.key)).toEqual(['three'])
  })

  test('after a room switch the new room\'s displays are not new; those added while it goes on are', () => {
    const room = [listing('one'), listing('two')]
    let acknowledgement = openingAcknowledgement(room)
    // The Host empties the list, then the other room's list arrives: no display in common.
    acknowledgement = observeConversation(acknowledgement, [])
    const otherRoom = [listing('x', { caption: 'Answer 09:12:00' }), listing('y', { caption: 'Answer 09:14:30' })]
    acknowledgement = observeConversation(acknowledgement, otherRoom)
    expect(unseenListings(acknowledgement, otherRoom)).toEqual([])
    expect(newDisplayAnnouncement(unseenListings(acknowledgement, otherRoom))).toBe('')

    const answered = [...otherRoom, listing('z', { caption: 'Answer 10:01:05' })]
    acknowledgement = observeConversation(acknowledgement, answered)
    expect(unseenListings(acknowledgement, answered).map(entry => entry.key)).toEqual(['z'])
    expect(newDisplayAnnouncement(unseenListings(acknowledgement, answered))).toBe('New display from Answer 10:01:05: Display z')

    // A switch without the empty list in between is a switch too.
    const third = [listing('p')]
    acknowledgement = observeConversation(acknowledgement, third)
    expect(unseenListings(acknowledgement, third)).toEqual([])
  })

  test('the first display of a conversation that had none when the window opened is new', () => {
    let acknowledgement = openingAcknowledgement([])
    const first = [listing('one')]
    acknowledgement = observeConversation(acknowledgement, first)
    expect(unseenListings(acknowledgement, first).map(entry => entry.key)).toEqual(['one'])
  })
})

describe('mounted frames', () => {
  const entries = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map(key => [key, buildDisplayDeck({ simulationRunId: runId, plants: [], listings: [listing(key)], shown: null })[0]!]))

  test('keep their mount order and drop the least recently shown beyond four', () => {
    let frames = touchMountedFrames([], entries.a!, 1)
    frames = touchMountedFrames(frames, entries.b!, 2)
    frames = touchMountedFrames(frames, entries.c!, 3)
    frames = touchMountedFrames(frames, entries.d!, 4)
    frames = touchMountedFrames(frames, entries.a!, 5)
    expect(frames.map(frame => frame.key)).toEqual(['answer:a', 'answer:b', 'answer:c', 'answer:d'])
    frames = touchMountedFrames(frames, entries.e!, 6)
    expect(frames.map(frame => frame.key)).toEqual(['answer:a', 'answer:c', 'answer:d', 'answer:e'])
  })

  test('outlive their displays leaving the list for a moment, without being stepped to', () => {
    const listings = [listing('one'), listing('two')]
    let deck = buildDisplayDeck({ simulationRunId: runId, plants, listings, shown: null })
    let frames = touchMountedFrames([], deck[2]!, 1)
    frames = touchMountedFrames(frames, deck[3]!, 2)
    frames = touchMountedFrames(frames, deck[0]!, 3)
    const shown = shownDeckEntry(deck, deck[0]!, listings)

    // The chat page reloads: the Host lists nothing until its list arrives again.
    deck = buildDisplayDeck({ simulationRunId: runId, plants, listings: [], shown })
    expect(keys(deck)).toEqual([overviewDeckKey(runId, 'unit-a'), overviewDeckKey(runId, 'unit-b')])
    expect(keys(mountedDeckEntries(frames, deck))).toEqual([answerDeckKey('one'), answerDeckKey('two'), overviewDeckKey(runId, 'unit-a')])
    expect(steppedDeckEntry(deck, deck[1]!.key, 'next')).toBeNull()
    expect(steppedDeckEntry(deck, deck[1]!.key, 'last')?.key).toBe(overviewDeckKey(runId, 'unit-b'))

    // The list is back: the frames show the deck's own entries again.
    const back = [listing('one'), listing('two')]
    deck = buildDisplayDeck({ simulationRunId: runId, plants, listings: back, shown })
    const mounted = mountedDeckEntries(frames, deck)
    expect(mounted[0]).toBe(deck[2]!)
    expect(mounted[0]).toMatchObject({ source: 'answer', listing: back[0] })
  })
})

describe('a display opened from another', () => {
  // C1 plan E5: a safety function chip or a banner label on an answer's display names equipment; the window shows its
  // detail as a display of its own, captioned with where it came from, and its Back returns there.
  const detail = JSON.stringify({ detail: { plantId: 'unit-a', components: ['sgA', 'sgB'] } })

  test('is a self-contained listing on the same Run, with a stable key and a caption saying where it came from', () => {
    const from = listing('advice')
    const opened = openedListing({ key: answerDeckKey('advice'), title: from.envelope.title, envelope: from.envelope }, { state: detail, title: 'Heat sink: deciding equipment' })
    expect(opened.envelope).toEqual({ ...from.envelope, title: 'Heat sink: deciding equipment', state: detail })
    expect(opened.caption).toBe('From Display advice')
    expect(openedListing({ key: answerDeckKey('advice'), title: from.envelope.title, envelope: from.envelope }, { state: detail, title: 'Other' }).key).toBe(opened.key)
    expect(openedListing({ key: answerDeckKey('other'), title: from.envelope.title, envelope: from.envelope }, { state: detail, title: 'Other' }).key).not.toBe(opened.key)
    // The window shows it though the conversation does not list it, as a generated display.
    const deck = buildDisplayDeck({ simulationRunId: runId, plants, listings: [from], shown: null })
    const entry = requestedDeckEntry(deck, runId, { kind: 'listing', listing: opened })!
    expect(entry).toMatchObject({ source: 'answer', kind: 'generated', listed: false, caption: 'From Display advice' })
    const shown = shownDeckEntry(deck, entry, [from])
    expect(keys(buildDisplayDeck({ simulationRunId: runId, plants, listings: [from], shown }))).toContain(entry.key)
  })

  test('a frame asks for it, and for Back, only in the protocol\'s exact words', () => {
    expect(parseDisplayFrameMessage({ type: 'world:display-open', state: detail, title: 'Reactor Core' })).toEqual({ type: 'world:display-open', state: detail, title: 'Reactor Core' })
    expect(parseDisplayFrameMessage({ type: 'world:display-open', state: detail })).toBeNull()
    expect(parseDisplayFrameMessage({ type: 'world:display-open', state: '', title: 'Reactor Core' })).toBeNull()
    expect(parseDisplayFrameMessage({ type: 'world:display-open', state: detail, title: 'x'.repeat(121) })).toBeNull()
    expect(parseDisplayFrameMessage({ type: 'world:display-back' })).toEqual({ type: 'world:display-back' })
    expect(parseDisplayFrameMessage({ type: 'world:display-back', to: 'x' })).toBeNull()
    expect(parseDisplayFramePresentation({ type: 'world:display-frame', shown: true, zoom: 1, back: 'Display advice' })).toEqual({ type: 'world:display-frame', shown: true, zoom: 1, back: 'Display advice' })
    expect(parseDisplayFramePresentation({ type: 'world:display-frame', shown: true, zoom: 1, back: '' })).toBeNull()
  })
})
