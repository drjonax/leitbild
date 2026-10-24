import { describe, expect, test } from 'bun:test'
import { embeddedViewListingSchema, type EmbeddedViewListing } from '@leitbild/contracts'
import type { ObjectId, OperationalObject } from '../src/core/model/index.ts'
import {
  acknowledgeShown,
  answerDeckKey,
  backFrom,
  buildDisplayDeck,
  deckEntryAsset,
  deckSetsOf,
  deckSetSubject,
  mountedDeckEntries,
  newDisplayAnnouncement,
  observeConversation,
  observeListingsForShown,
  observedAssetsOf,
  openedAfter,
  openingAcknowledgement,
  packObserves,
  assetDeckKey,
  requestedDeckEntry,
  setDeckKey,
  shownDeckEntry,
  steppedDeckEntry,
  touchMountedFrames,
  unseenListings,
  type DeckEntry,
  type DeckAsset,
  type DeckRunJoin,
} from '../src/ui/process-display/display-deck.ts'
import { openedListing } from '../src/ui/embed/opened-display.ts'
import { parseDisplayFrameMessage, parseDisplayFramePresentation } from '../src/ui/embed/display-frame-protocol.ts'

const workspaceId = '1e828b43-37fc-4437-aa70-302d7f442ceb'
const runId = 'run-1'

// A vignette an answer composed, about the objects its views name.
const vignetteState = (objectIds: ReadonlyArray<string>): string => JSON.stringify({
  title: 'Pressure check',
  at: { t: '2026-10-10T09:00:00.000Z', clock: 'simulation' },
  views: [{ kind: 'values', refs: objectIds.map(objectId => `${objectId}#pressurizer.pressureMPa`), rows: 2 }],
})

const listing = (key: string, config: { readonly objectIds?: ReadonlyArray<string>; readonly run?: string; readonly state?: string; readonly caption?: string } = {}): EmbeddedViewListing =>
  embeddedViewListingSchema.parse({
    key,
    caption: config.caption ?? `Answer ${key}`,
    envelope: {
      moduleId: 'world',
      viewType: 'display.vignette',
      subject: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: config.run ?? runId },
      title: `Display ${key}`,
      height: 600,
      state: config.state ?? vignetteState(config.objectIds ?? ['unit-a']),
    },
  })

const assets: ReadonlyArray<DeckAsset> = [
  { objectId: 'unit-a' as ObjectId, packId: 'process-plant', label: 'Unit A' },
  { objectId: 'unit-b' as ObjectId, packId: 'process-plant', label: 'Unit B' },
]

const keys = (deck: ReadonlyArray<DeckEntry>): ReadonlyArray<string> => deck.map(entry => entry.key)

const joined: DeckRunJoin = { state: 'joined' }

describe('display deck', () => {
  test('lists the assets\' defaults in rail order, then the answers oldest first', () => {
    const deck = buildDisplayDeck({ simulationRunId: runId, assets, listings: [listing('one'), listing('two')], shown: null })
    expect(keys(deck)).toEqual([
      assetDeckKey(runId, 'unit-a'),
      assetDeckKey(runId, 'unit-b'),
      answerDeckKey('one'),
      answerDeckKey('two'),
    ])
    expect(deck[0]).toMatchObject({ title: 'Unit A', caption: 'Overview', kind: 'generated' })
    expect(deck[2]).toMatchObject({ title: 'Display one', caption: 'Answer one', kind: 'advice' })
  })

  test('captions a display of another Run and keeps the asset\'s tools off it', () => {
    const deck = buildDisplayDeck({ simulationRunId: runId, assets, listings: [listing('one', { run: 'run-2' })], shown: null })
    const entry = deck[2]!
    expect(entry.caption).toBe('Answer one · other Run')
    expect(deckEntryAsset(entry, assets, joined)).toEqual({ ok: false, reason: 'Belongs to another Run' })
  })

  test('acts on the asset an answer names when it is in this Run', () => {
    const deck = buildDisplayDeck({ simulationRunId: runId, assets, listings: [listing('b', { objectIds: ['unit-b'] }), listing('z', { objectIds: ['unit-z'] })], shown: null })
    expect(deckEntryAsset(deck[0]!, assets, joined)).toEqual({ ok: true, asset: assets[0]! })
    expect(deckEntryAsset(deck[2]!, assets, joined)).toEqual({ ok: true, asset: assets[1]! })
    expect(deckEntryAsset(deck[3]!, assets, joined)).toEqual({ ok: false, reason: 'The display names no asset of this Run' })
  })

  test('shows displays while the page opens the Run, with the asset\'s tools off and saying why', () => {
    // Before the Run is opened the page knows none of its assets; the display still opens.
    const deck = buildDisplayDeck({ simulationRunId: runId, assets: [], listings: [listing('one', { objectIds: ['unit-b'] }), listing('far', { run: 'run-2' })], shown: null })
    expect(keys(deck)).toEqual([answerDeckKey('one'), answerDeckKey('far')])
    expect(deckEntryAsset(deck[0]!, [], { state: 'joining' })).toEqual({ ok: false, reason: 'This Run is still opening' })
    expect(deckEntryAsset(deck[0]!, [], { state: 'failed', reason: 'Run run-1 is not loaded' }))
      .toEqual({ ok: false, reason: 'This Run could not be opened: Run run-1 is not loaded' })
    // A display of another Run needs nothing from this one.
    expect(deckEntryAsset(deck[1]!, [], { state: 'joining' })).toEqual({ ok: false, reason: 'Belongs to another Run' })
    // Once opened, the assets arrive and their defaults go ahead of the answers.
    const opened = buildDisplayDeck({ simulationRunId: runId, assets, listings: [listing('one', { objectIds: ['unit-b'] })], shown: null })
    expect(opened.findIndex(entry => entry.key === answerDeckKey('one'))).toBe(2)
    expect(deckEntryAsset(opened[2]!, assets, joined)).toEqual({ ok: true, asset: assets[1]! })
  })

  test('a display whose state is no vignette still opens but names no asset', () => {
    const unreadable = listing('odd', { state: 'not json' })
    const deck = buildDisplayDeck({ simulationRunId: runId, assets, listings: [unreadable], shown: null })
    expect(deck[2]).toMatchObject({ kind: 'advice' })
    expect(deckEntryAsset(deck[2]!, assets, joined)).toEqual({ ok: false, reason: 'The display names no asset of this Run' })
  })

  test('a display about several assets acts on its lead subject\'s, the first it names, and says how many it names', () => {
    const both = listing('both', { objectIds: ['unit-b', 'unit-a'] })
    const deck = buildDisplayDeck({ simulationRunId: runId, assets, listings: [both], shown: null })
    expect(deckEntryAsset(deck[2]!, assets, joined)).toEqual({ ok: true, asset: assets[1]!, among: 2 })
  })

  test('an answer\'s refs name their asset by the object before the #, with its Pack (E2 item 3)', () => {
    const halden = listing('halden', { objectIds: ['unit-b'] })
    expect(halden.envelope.state).toContain('"unit-b#pressurizer.pressureMPa"')
    const deck = buildDisplayDeck({ simulationRunId: runId, assets, listings: [halden], shown: null })
    expect(deckEntryAsset(deck[2]!, assets, joined)).toEqual({ ok: true, asset: { objectId: 'unit-b' as ObjectId, packId: 'process-plant', label: 'Unit B' } })
  })

  test('steps without wrapping and jumps to the ends', () => {
    const deck = buildDisplayDeck({ simulationRunId: runId, assets, listings: [listing('one')], shown: null })
    expect(steppedDeckEntry(deck, deck[0]!.key, 'previous')).toBeNull()
    expect(steppedDeckEntry(deck, deck[0]!.key, 'next')?.key).toBe(deck[1]!.key)
    expect(steppedDeckEntry(deck, deck[2]!.key, 'next')).toBeNull()
    expect(steppedDeckEntry(deck, deck[1]!.key, 'first')?.key).toBe(deck[0]!.key)
    expect(steppedDeckEntry(deck, deck[0]!.key, 'last')?.key).toBe(deck[2]!.key)
  })
})

describe('the Run\'s observed assets (E2 item 1)', () => {
  test('a Pack observes where its descriptor declares the observation contribution: the plant, the grid and the weather do, dispatch does not', async () => {
    const { processPlantPackView } = await import('../src/packs/process-plant/ui-pack.ts')
    const { electricGridPackView } = await import('../src/packs/electric-grid/ui-pack.ts')
    const { weatherPack } = await import('../src/packs/weather/pack.ts')
    const { ambulancePackView } = await import('../src/packs/ambulance/ui-pack.ts')
    expect([processPlantPackView, electricGridPackView, weatherPack, ambulancePackView].map(pack => packObserves(pack.descriptor))).toEqual([true, true, true, false])
  })

  test('are listed in rail order, then those the rail does not list, never one whose Pack does not observe', () => {
    const object = (id: string, observes: boolean) => ({ id, observes })
    const all = [object('ambulance-1', false), object('unit-b', true), object('unit-a', true), object('grid', true)]
    expect(observedAssetsOf([all[2]!, all[0]!, all[1]!], all, entry => entry.observes).map(entry => entry.id)).toEqual(['unit-a', 'unit-b', 'grid'])
  })
})

describe('Back (E2, the docs audit)', () => {
  test('a display opened after another returns to it, and each step back returns one further', () => {
    const deck = buildDisplayDeck({ simulationRunId: runId, assets, listings: [listing('one')], shown: null })
    const [overview, , answer] = deck as [DeckEntry, DeckEntry, DeckEntry]
    const element = requestedDeckEntry(deck, runId, { kind: 'listing', listing: listing('element') })!
    const valve = requestedDeckEntry(deck, runId, { kind: 'listing', listing: listing('valve') })!
    let returns = openedAfter(new Map(), element, overview)
    returns = openedAfter(returns, valve, element)
    expect(openedAfter(returns, answer, answer)).toBe(returns)
    const first = backFrom(returns, deck, valve.key)!
    expect(first.to.key).toBe(element.key)
    const second = backFrom(first.returns, deck, element.key)!
    expect(second.to).toBe(overview)
    expect(backFrom(second.returns, deck, overview.key)).toBeNull()
    // A display opened after none has no Back.
    expect(backFrom(new Map(), deck, answer.key)).toBeNull()
  })
})

describe('the shown display', () => {
  test('stays where it was, captioned, when it leaves the conversation', () => {
    const listings = [listing('one'), listing('two'), listing('three')]
    const before = buildDisplayDeck({ simulationRunId: runId, assets, listings, shown: null })
    const shown = shownDeckEntry(before, before[3]!, listings)
    expect(shown).toMatchObject({ groupIndex: 1, wasListed: true })

    const after = buildDisplayDeck({ simulationRunId: runId, assets, listings: [listing('one'), listing('three')], shown })
    expect(keys(after).slice(2)).toEqual([answerDeckKey('one'), answerDeckKey('two'), answerDeckKey('three')])
    expect(after[3]).toMatchObject({ caption: 'No longer in the conversation', listed: false })

    // Without it shown, it is simply gone.
    expect(keys(buildDisplayDeck({ simulationRunId: runId, assets, listings: [listing('one'), listing('three')], shown: null }))).not.toContain(answerDeckKey('two'))
  })

  test('opened from an answer before the list caught up, it keeps its own caption', () => {
    const opened = listing('new')
    const deck = buildDisplayDeck({ simulationRunId: runId, assets, listings: [listing('one')], shown: null })
    const entry = requestedDeckEntry(deck, runId, { kind: 'listing', listing: opened })!
    let shown = shownDeckEntry(deck, entry, [listing('one')])
    expect(shown).toMatchObject({ groupIndex: 1, wasListed: false })
    expect(buildDisplayDeck({ simulationRunId: runId, assets, listings: [listing('one')], shown })[3]).toMatchObject({ caption: 'Answer new' })

    // Once listed, leaving the list means it left the conversation.
    shown = observeListingsForShown(shown, [listing('one'), opened])!
    expect(shown).toMatchObject({ groupIndex: 1, wasListed: true })
    expect(buildDisplayDeck({ simulationRunId: runId, assets, listings: [], shown })[2]).toMatchObject({ caption: 'No longer in the conversation' })
  })

  test('a default whose asset left the Run stays shown with its tools off', () => {
    const before = buildDisplayDeck({ simulationRunId: runId, assets, listings: [], shown: null })
    const shown = shownDeckEntry(before, before[1]!, [])
    const after = buildDisplayDeck({ simulationRunId: runId, assets: [assets[0]!], listings: [], shown })
    expect(after[1]).toMatchObject({ caption: 'No longer in this Run', inRun: false })
    expect(deckEntryAsset(after[1]!, [assets[0]!], joined)).toEqual({ ok: false, reason: 'Unit B is no longer in this Run' })
  })

  test('a rail request opens that asset\'s default, a chat request the listed display', () => {
    const one = listing('one')
    const deck = buildDisplayDeck({ simulationRunId: runId, assets, listings: [one], shown: null })
    expect(requestedDeckEntry(deck, runId, { kind: 'asset', objectId: 'unit-b' })?.key).toBe(assetDeckKey(runId, 'unit-b'))
    expect(requestedDeckEntry(deck, runId, { kind: 'asset', objectId: 'unit-z' })).toBeNull()
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

    const deck = buildDisplayDeck({ simulationRunId: runId, assets, listings: later, shown: null })
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
  const entries = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map(key => [key, buildDisplayDeck({ simulationRunId: runId, assets: [], listings: [listing(key)], shown: null })[0]!]))

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
    let deck = buildDisplayDeck({ simulationRunId: runId, assets, listings, shown: null })
    let frames = touchMountedFrames([], deck[2]!, 1)
    frames = touchMountedFrames(frames, deck[3]!, 2)
    frames = touchMountedFrames(frames, deck[0]!, 3)
    const shown = shownDeckEntry(deck, deck[0]!, listings)

    // The chat page reloads: the Host lists nothing until its list arrives again.
    deck = buildDisplayDeck({ simulationRunId: runId, assets, listings: [], shown })
    expect(keys(deck)).toEqual([assetDeckKey(runId, 'unit-a'), assetDeckKey(runId, 'unit-b')])
    expect(keys(mountedDeckEntries(frames, deck))).toEqual([answerDeckKey('one'), answerDeckKey('two'), assetDeckKey(runId, 'unit-a')])
    expect(steppedDeckEntry(deck, deck[1]!.key, 'next')).toBeNull()
    expect(steppedDeckEntry(deck, deck[1]!.key, 'last')?.key).toBe(assetDeckKey(runId, 'unit-b'))

    // The list is back: the frames show the deck's own entries again.
    const back = [listing('one'), listing('two')]
    deck = buildDisplayDeck({ simulationRunId: runId, assets, listings: back, shown })
    const mounted = mountedDeckEntries(frames, deck)
    expect(mounted[0]).toBe(deck[2]!)
    expect(mounted[0]).toMatchObject({ source: 'answer', listing: back[0] })
  })
})

describe('a display opened from another', () => {
  // C1 plan E5: a display names equipment (a safety function chip, a proposal's item); the window shows its default as a
  // display of its own, captioned with where it came from, and its Back returns there.
  const detail = vignetteState(['unit-a'])

  test('is a self-contained listing on the same Run, with a stable key and a caption saying where it came from', () => {
    const from = listing('advice')
    const opened = openedListing({ key: answerDeckKey('advice'), title: from.envelope.title, envelope: from.envelope }, { state: detail, title: 'Heat sink: deciding equipment' })
    expect(opened.envelope).toEqual({ ...from.envelope, title: 'Heat sink: deciding equipment', state: detail })
    expect(opened.caption).toBe('From Display advice')
    expect(openedListing({ key: answerDeckKey('advice'), title: from.envelope.title, envelope: from.envelope }, { state: detail, title: 'Other' }).key).toBe(opened.key)
    expect(openedListing({ key: answerDeckKey('other'), title: from.envelope.title, envelope: from.envelope }, { state: detail, title: 'Other' }).key).not.toBe(opened.key)
    // The window shows it though the conversation does not list it.
    const deck = buildDisplayDeck({ simulationRunId: runId, assets, listings: [from], shown: null })
    const entry = requestedDeckEntry(deck, runId, { kind: 'listing', listing: opened })!
    expect(entry).toMatchObject({ source: 'answer', listed: false, caption: 'From Display advice' })
    const shown = shownDeckEntry(deck, entry, [from])
    expect(keys(buildDisplayDeck({ simulationRunId: runId, assets, listings: [from], shown }))).toContain(entry.key)
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

describe('a listing the window cannot show', () => {
  const grid = (key: string): EmbeddedViewListing => embeddedViewListingSchema.parse({
    key,
    caption: `Answer ${key}`,
    envelope: {
      moduleId: 'world',
      viewType: 'electric-grid.display',
      subject: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: runId },
      title: 'Grid around Unit 2',
      height: 600,
      state: '{"grid":{}}',
    },
  })

  test('stays in the deck with its reason, between the displays the window shows', () => {
    const deck = buildDisplayDeck({ simulationRunId: runId, assets, listings: [listing('a'), grid('g'), listing('b')], shown: null })
    expect(keys(deck)).toEqual([assetDeckKey(runId, 'unit-a'), assetDeckKey(runId, 'unit-b'), answerDeckKey('a'), answerDeckKey('g'), answerDeckKey('b')])
    const entry = deck.find(candidate => candidate.key === answerDeckKey('g'))!
    expect(entry).toMatchObject({ source: 'answer', refusal: 'it is a electric-grid.display view, which this window does not show' })
    expect(deck.find(candidate => candidate.key === answerDeckKey('a'))).toMatchObject({ refusal: null })
    expect(deckEntryAsset(entry, assets, { state: 'joined' })).toEqual({ ok: false, reason: 'Not a display this window shows: it is a electric-grid.display view, which this window does not show' })
  })
})

describe('fleets (multi-unit M1.5)', () => {
  const unit = (id: string, cluster: string | undefined) => ({ id, cluster }) as unknown as OperationalObject
  const plants = {
    id: 'process-plants', label: 'Process plants',
    members: { group: { label: 'Cluster', of: (object: OperationalObject) => (object as unknown as { cluster?: string }).cluster }, columns: [], row: () => ({}) },
  }
  const rows = [
    { category: plants, objects: [unit('p1', 'north'), unit('p2', 'south'), unit('p3', 'north'), unit('p4', undefined)] },
    { category: { id: 'sites', label: 'Sites' }, objects: [unit('s1', 'north')] },
  ]
  const sets = deckSetsOf(rows)

  test('one per group a category declares that the Run\'s units are in, in rail order of its first member, never for a category without groups', () => {
    expect(sets).toEqual([
      { categoryId: 'process-plants', categoryLabel: 'Process plants', group: 'north', members: 2 },
      { categoryId: 'process-plants', categoryLabel: 'Process plants', group: 'south', members: 1 },
    ])
    expect(deckSetSubject(sets[0]!)).toEqual({ of: { category: 'process-plants', group: 'north' } })
  })

  test('are pinned ahead of the overviews as generated displays, and act on no single asset', () => {
    const deck = buildDisplayDeck({ simulationRunId: runId, sets, assets, listings: [listing('one')], shown: null })
    expect(keys(deck)).toEqual([
      setDeckKey(runId, sets[0]!), setDeckKey(runId, sets[1]!), assetDeckKey(runId, 'unit-a'), assetDeckKey(runId, 'unit-b'), answerDeckKey('one'),
    ])
    expect(deck[0]).toMatchObject({ source: 'set', title: 'Fleet · north', caption: 'Process plants · 2 units', kind: 'generated', inRun: true })
    expect(deck[1]).toMatchObject({ caption: 'Process plants · 1 unit' })
    expect(deckEntryAsset(deck[0]!, assets, joined)).toEqual({ ok: false, reason: 'A fleet is about every unit of north; open a unit for its tools' })
    expect(steppedDeckEntry(deck, deck[1]!.key, 'next')?.key).toBe(assetDeckKey(runId, 'unit-a'))
  })

  test('a shown fleet whose group empties stays where it was, captioned', () => {
    const before = buildDisplayDeck({ simulationRunId: runId, sets, assets, listings: [], shown: null })
    const shown = shownDeckEntry(before, before[1]!, [])
    expect(shown).toMatchObject({ groupIndex: 1 })
    const after = buildDisplayDeck({ simulationRunId: runId, sets: [sets[0]!], assets, listings: [], shown })
    expect(after[1]).toMatchObject({ key: setDeckKey(runId, sets[1]!), caption: 'No longer in this Run', inRun: false })
  })
})
