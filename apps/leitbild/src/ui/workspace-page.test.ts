import { describe, expect, test } from 'bun:test'
import { featuredDefinitionCatalogSchema, moduleResourceDescriptorSchema } from '@leitbild/contracts'
import {
  confirmsDeletion, CONTINUE_LIMIT, continueItems, deleteConfirmationText, featuredStartRevision,
  openedFromGuide, previewSrc, previewSrcset, PUBLIC_NOTE, sameDefinition, scenarioRowSummary, summaryHasMore, summaryLead, workspaceDemos,
} from './workspace-page.ts'
import { featured, listed, revision, room, run, scenario, WS } from './workspace-page.test-support.ts'

describe('featured demos on the Workspace page', () => {
  const definitions = [scenario('supply-run'), scenario('halden-emergency'), scenario('nordland-corridor-security'), scenario('halden-offsite-power-restoration')]
  const catalog = featuredDefinitionCatalogSchema.parse({
    modules: [{ moduleId: 'world', status: 'ready' }, { moduleId: 'agents', status: 'ready' }],
    definitions: [featured('halden-offsite-power-restoration'), featured('nordland-corridor-security'), featured('halden-emergency')],
    listed: [],
  })
  const ids = (items: ReadonlyArray<{ readonly ref: { readonly id: string } }>): string[] => items.map(item => String(item.ref.id))
  const cardIds = (cards: ReadonlyArray<{ readonly definition: { readonly ref: { readonly id: string } } }>): string[] => ids(cards.map(card => card.definition))

  test('match this Workspace\'s Definitions by identity, in the featured order, and list the rest under More scenarios', () => {
    const demos = workspaceDemos(definitions, catalog)
    expect(cardIds(demos.cards)).toEqual(['halden-offsite-power-restoration', 'nordland-corridor-security', 'halden-emergency'])
    expect(demos.cards.every(card => card.definition.ref.workspaceId === WS)).toBe(true)
    expect(ids(demos.others)).toEqual(['supply-run'])
    expect(demos.unavailable).toEqual([])
  })

  test('a featured demo this Workspace does not hold is not shown, and never invented', () => {
    const demos = workspaceDemos([scenario('supply-run'), scenario('halden-emergency')], catalog)
    expect(cardIds(demos.cards)).toEqual(['halden-emergency'])
    expect(ids(demos.others)).toEqual(['supply-run'])
  })

  test('identity is Module, type and id together', () => {
    expect(sameDefinition({ moduleId: 'world', type: 'world.scenario', id: 'a' }, { moduleId: 'world', type: 'world.scenario', id: 'a' })).toBe(true)
    expect(sameDefinition({ moduleId: 'world', type: 'world.scenario', id: 'a' }, { moduleId: 'world', type: 'world.other', id: 'a' })).toBe(false)
    expect(sameDefinition({ moduleId: 'world', type: 'world.scenario', id: 'a' }, { moduleId: 'agents', type: 'world.scenario', id: 'a' })).toBe(false)
  })

  test('an edited demo is flagged and starts the featured revision', () => {
    const demos = workspaceDemos([scenario('halden-emergency', { currentRevisionId: revision('b') })], catalog)
    expect(demos.cards[0]?.edited).toBe(true)
    expect(featuredStartRevision(demos.cards[0]!)).toBe(revision('a'))
    expect(workspaceDemos([scenario('halden-emergency')], catalog).cards[0]?.edited).toBe(false)
  })

  test('a failed featured outcome is reported per Module and leaves every Definition startable', () => {
    const failedCatalog = featuredDefinitionCatalogSchema.parse({ modules: [{ moduleId: 'world', status: 'failed', failure: { code: 'module_unavailable', message: 'down', retryable: true } }], definitions: [], listed: [] })
    const demos = workspaceDemos(definitions, failedCatalog)
    expect(demos.unavailable.map(String)).toEqual(['world'])
    expect(demos.cards).toEqual([])
    expect(demos.others).toHaveLength(4)
  })

  test('while the featured list is unknown nothing is featured', () => {
    expect(workspaceDemos(definitions, null)).toEqual({ cards: [], others: definitions, unavailable: [] })
  })

  test('previews: srcset by width, src the smallest at least 960 wide', () => {
    const preview = featured('x').previews[0]!
    expect(previewSrcset(preview)).toBe('/assets/world/scenario-previews/x-960.webp 960w, /assets/world/scenario-previews/x-1600.webp 1600w')
    expect(previewSrc(preview)).toBe('/assets/world/scenario-previews/x-960.webp')
    expect(previewSrc(preview, 2000)).toBe('/assets/world/scenario-previews/x-1600.webp')
  })
})

describe('Continue', () => {
  test('live Runs first, then paused Runs, then conversations, newest first; nothing without a page', () => {
    const items = continueItems([
      room('r1', '2026-10-12T21:59:00.000Z'),
      run('paused-new', 'Paused', '2026-10-12T21:50:00.000Z'),
      run('running-old', 'Running', '2026-10-12T20:00:00.000Z'),
      run('fast', 'Fast-forward · 4.0×', '2026-10-12T21:00:00.000Z'),
      run('broken', 'Unavailable', '2026-10-12T21:58:00.000Z'),
      run('hidden', 'Running', '2026-10-12T21:59:00.000Z', { uiPath: null }),
    ])
    expect(items.map(item => String(item.resource.ref.id))).toEqual(['fast', 'running-old', 'paused-new', 'broken', 'r1'])
    expect(items.map(item => item.kind)).toEqual(['running', 'running', 'paused', 'unavailable', 'conversation'])
    expect(items[0]?.status).toBe('Fast-forward · 4.0×')
    expect(items.at(-1)?.status).toBe('Conversation')
    expect(CONTINUE_LIMIT).toBe(3)
  })

  test('cards carry at most two facts: when, and who or how much', () => {
    const [runItem, roomItem] = continueItems([run('a', 'Running', '2026-10-12T20:00:00.000Z'), room('b', '2026-10-12T20:00:00.000Z')])
    expect(runItem?.facts.map(fact => fact.key)).toEqual(['started-at', 'viewer-count'])
    expect(roomItem?.facts.map(fact => fact.key)).toEqual(['message-count', 'last-activity-at'])
  })

  test('Run families, Agents and other Resources are not continued', () => {
    const family = moduleResourceDescriptorSchema.parse({
      ref: { workspaceId: WS, moduleId: 'world', type: 'world.run-family', id: 'f' }, title: 'Family', capabilityIds: [], observedAt: '2026-10-12T22:00:00.000Z',
    })
    expect(continueItems([family])).toEqual([])
  })
})

describe('scenario rows', () => {
  const long = 'A summer weekday evening.  The 132 kV network serving southern Stavanger goes dark. Restore it from local hydro.'

  test('show the first sentence, with More when there is more to read', () => {
    expect(summaryLead(long)).toBe('A summer weekday evening.')
    expect(summaryHasMore(long)).toBe(true)
    expect(summaryLead('Short and done.')).toBe('Short and done.')
    expect(summaryHasMore('Short and done.')).toBe(false)
    expect(summaryLead('No full stop at all')).toBe('No full stop at all')
    expect(summaryLead(undefined)).toBe('')
    expect(summaryHasMore(undefined)).toBe(false)
  })

  test('a single sentence too long for one line still offers More', () => {
    const sentence = `${'word '.repeat(30).trim()}.`
    expect(summaryLead(sentence)).toBe(sentence)
    expect(summaryHasMore(sentence)).toBe(true)
  })

  test('a scenario a Module lists reads by its listed summary, as in the Demos modal, with More for its description', () => {
    const quiet = listed('halden-normal-operation')
    const entries = [quiet, listed('supply-run')]
    expect(scenarioRowSummary(scenario('halden-normal-operation', { description: long }), entries)).toEqual({ lead: quiet.summary, more: true })
    expect(scenarioRowSummary(scenario('halden-normal-operation'), entries)).toEqual({ lead: quiet.summary, more: false })
    expect(scenarioRowSummary(scenario('rogaland-black-start', { description: long }), entries))
      .toEqual({ lead: 'A summer weekday evening.', more: true })
    expect(scenarioRowSummary(scenario('halden-normal-operation', { description: long }), []))
      .toEqual({ lead: 'A summer weekday evening.', more: true })
  })

  test('a listed scenario stays in More scenarios and never becomes a demo card', () => {
    const catalog = featuredDefinitionCatalogSchema.parse({
      modules: [{ moduleId: 'world', status: 'ready' }, { moduleId: 'agents', status: 'ready' }],
      definitions: [featured('halden-offsite-power-restoration')],
      listed: [listed('halden-normal-operation')],
    })
    const demos = workspaceDemos([scenario('halden-offsite-power-restoration'), scenario('halden-normal-operation')], catalog)
    expect(demos.cards.map(card => String(card.definition.ref.id))).toEqual(['halden-offsite-power-restoration'])
    expect(demos.others.map(definition => String(definition.ref.id))).toEqual(['halden-normal-operation'])
  })
})

describe('delete confirmation', () => {
  test('needs the exact name, or the short id of an unnamed Workspace', () => {
    const named = { id: WS, name: 'Grid study' }
    expect(deleteConfirmationText(named)).toBe('Grid study')
    expect(confirmsDeletion('Grid study', named)).toBe(true)
    expect(confirmsDeletion('  Grid study ', named)).toBe(true)
    expect(confirmsDeletion('grid study', named)).toBe(false)
    expect(confirmsDeletion('Grid', named)).toBe(false)
    expect(confirmsDeletion('', named)).toBe(false)
    const unnamed = { id: 'b56b1d2e-0000-4000-8000-000000000000', name: null }
    expect(deleteConfirmationText(unnamed)).toBe('b56b1d')
    expect(confirmsDeletion('b56b1d', unnamed)).toBe(true)
    expect(confirmsDeletion('Untitled Workspace · b56b1d', unnamed)).toBe(false)
  })

  test('the public note says anyone can delete', () => {
    expect(PUBLIC_NOTE).toBe('Public: anyone can see, open, change or delete this Workspace.')
  })
})

describe('guide hand-off', () => {
  test('a conversation opened from the guide is marked with from=guide', () => {
    expect(openedFromGuide('?agents=room-1&from=guide')).toBe(true)
    expect(openedFromGuide(new URLSearchParams({ agents: 'room-1' }))).toBe(false)
    expect(openedFromGuide('?from=wiki')).toBe(false)
  })
})
