import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readModalRoute } from './modal-url.ts'
import {
  chapterEyebrow, GUIDE_MAP_CREDIT, GUIDE_PAGE_IDS, GUIDE_PAGES, GUIDE_SHOT_IDS, GUIDE_SHOT_WIDTHS, guideCard, guideDemoKeys,
  guidePage, guideWikiHref, type GuideCard, type GuideChapter,
} from './guide-content.ts'

const chapters = GUIDE_PAGES.filter((page): page is GuideChapter => page.kind === 'chapter')
const cards = chapters.flatMap(page => page.cards)
const askPage = guidePage('ask')
const words = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length

/** Everything a card shows as text. */
const cardText = (card: GuideCard): string[] => [
  card.title, card.body, card.why ?? '', card.limits ?? '',
  ...(card.media?.kind === 'audiences' ? card.media.audiences.flatMap(item => [item.title, item.text]) : []),
  ...(card.media && 'alt' in card.media ? [card.media.alt] : []),
  ...(card.action ? [card.action.label, card.action.kind === 'demo' ? card.action.helper ?? '' : ''] : []),
]
const allText = (): string[] => GUIDE_PAGES.flatMap(page => [
  page.title, page.subtitle, page.intro,
  ...(page.kind === 'chapter' ? page.cards.flatMap(cardText) : [page.heading, ...page.prompts.flatMap(item => [item.label, item.prompt])]),
])

describe('guide structure (plan v2 §4.1)', () => {
  test('6 pages in order, the last one the Ask page', () => {
    expect(GUIDE_PAGES.map(page => page.id)).toEqual([...GUIDE_PAGE_IDS])
    expect(GUIDE_PAGES.at(-1)!.kind).toBe('ask')
    expect(chapters).toHaveLength(5)
  })

  test('every chapter has 2–4 cards, 18 in all, with unique ids', () => {
    for (const page of chapters) {
      expect(page.cards.length).toBeGreaterThanOrEqual(2)
      expect(page.cards.length).toBeLessThanOrEqual(4)
    }
    expect(cards).toHaveLength(18)
    expect(new Set(cards.map(card => card.id)).size).toBe(cards.length)
    for (const card of cards) expect(card.id).toMatch(/^[a-z][a-z0-9-]*$/)
  })

  test('page and card ids survive a deep link', () => {
    for (const page of chapters) {
      for (const card of page.cards) {
        expect(readModalRoute(`?guide=${page.id}&card=${card.id}`)).toEqual({ kind: 'guide', page: page.id, card: card.id })
        expect(guideCard(page, card.id)).toBe(card)
      }
    }
    expect(guideCard(guidePage('plant'), 'no-such-card')).toBeNull()
    expect(guideCard(askPage, 'what')).toBeNull()
  })

  test('only the chapter with map screenshots carries the map credit', () => {
    expect(chapters.filter(page => page.mapCredit).map(page => page.id)).toEqual(['world'])
    expect(GUIDE_MAP_CREDIT.text).toContain('© OpenStreetMap contributors (ODbL)')
    expect(guideWikiHref(GUIDE_MAP_CREDIT.link.path)).toBe('/wiki?path=data-credits.md')
  })

  test('chapter eyebrows are mixed case', () => {
    expect(chapterEyebrow(2)).toBe('Chapter 3 of 6')
  })
})

describe('Ask page (plan v2 §4.3)', () => {
  test('carries the owner’s exact heading and 5 prompts', () => {
    if (askPage.kind !== 'ask') throw new Error('The last page is the Ask page')
    expect(askPage.heading).toBe('If you want to know more, ask the Leitbild Assistant')
    expect(askPage.prompts).toHaveLength(5)
    expect(new Set(askPage.prompts.map(item => item.label)).size).toBe(5)
  })

  test('each prompt starts like its chip, so the user recognises it in the conversation', () => {
    if (askPage.kind !== 'ask') throw new Error('The last page is the Ask page')
    for (const { label, prompt } of askPage.prompts) {
      expect(label.endsWith('?')).toBe(true)
      expect(prompt.split(' ').slice(0, 2)).toEqual(label.split(' ').slice(0, 2))
      // "Getting started: " + the label names the conversation within Agents' 80 characters.
      expect(`Getting started: ${label}`.length).toBeLessThanOrEqual(80)
    }
  })
})

describe('copy rules (plan v2 §4.4, §4.5, C16)', () => {
  test('titles ≤ 40 characters; bodies ≤ 55 words; why and limits lines ≤ 25 words', () => {
    for (const card of cards) {
      expect(card.title.length, card.id).toBeLessThanOrEqual(40)
      expect(words(card.body), card.id).toBeLessThanOrEqual(55)
      // Plan copy is used verbatim; its longest "why" lines are 21 and 23 words.
      if (card.why) expect(words(card.why), card.id).toBeLessThanOrEqual(25)
      if (card.limits) expect(words(card.limits), card.id).toBeLessThanOrEqual(25)
    }
  })

  test('at most one number per card (N-1 is a name, not a figure)', () => {
    for (const card of cards) {
      const shown = [card.body, card.why ?? '', card.limits ?? '', ...(card.media?.kind === 'audiences' ? card.media.audiences.map(item => item.text) : [])]
      const numbers = shown.join(' ').replaceAll('N-1', '').match(/\d+(?:[.,]\d+)*/g) ?? []
      expect(numbers.length, `${card.id}: ${numbers.join(', ')}`).toBeLessThanOrEqual(1)
    }
  })

  test('no banned phrases', () => {
    const banned: ReadonlyArray<RegExp> = [
      /any question/i, /anything about/i, /realistic/i, /(?<!not a )qualified/i, /(?<!not )certified/i, /live Norway/i,
      /Ambulance pack/i, /halden-dispatch/, /halden-weather-response/, /LD-01/, /SM-01/, /\d+(\.\d+)?\s*[x×]\b/,
      /people decide/i, /stays under human control/i,
    ]
    for (const text of allText()) for (const pattern of banned) expect(text, `${pattern} in “${text}”`).not.toMatch(pattern)
  })

  test('no jargon the style sheet bans, and no contractions', () => {
    for (const text of allText()) {
      expect(text).not.toMatch(/\bLOOP\b|\bbus\/branch\b|\bCapabilit(y|ies)\b|\bRooms?\b/)
      expect(text).not.toMatch(/\b(can|don|doesn|isn|aren|won|didn|wasn)[’']t\b|\b(it|that|there|what)[’']s\b|[’']re\b|[’']ll\b|[’']ve\b/i)
    }
  })

  test('Workspace, Run and Pack are capitalised as defined terms', () => {
    for (const text of allText()) expect(text).not.toMatch(/\b(workspaces?|packs?)\b/)
  })
})

describe('media (a11y should-fix 9)', () => {
  test('every image has alt text of ≤ 140 characters that does not repeat its card title', () => {
    for (const card of cards) {
      if (!card.media || card.media.kind === 'audiences') continue
      expect(card.media.alt.length, card.id).toBeGreaterThan(20)
      expect(card.media.alt.length, card.id).toBeLessThanOrEqual(140)
      expect(card.media.alt.toLowerCase(), card.id).not.toContain(card.title.toLowerCase())
    }
  })

  test('every shot is used once and has both widths on disk; both diagrams exist', () => {
    const shots = cards.flatMap(card => card.media?.kind === 'shot' ? [card.media.shot] : [])
    expect([...shots].sort()).toEqual([...GUIDE_SHOT_IDS].sort())
    const folder = join(import.meta.dir, 'assets', 'guide')
    for (const shot of GUIDE_SHOT_IDS) for (const width of GUIDE_SHOT_WIDTHS) expect(existsSync(join(folder, `${shot}-${width}.webp`)), `${shot}-${width}`).toBe(true)
    const diagrams = cards.flatMap(card => card.media?.kind === 'diagram' ? [card.media.diagram] : [])
    expect(diagrams.sort()).toEqual(['discovery', 'workspaces'])
    for (const diagram of diagrams) expect(existsSync(join(folder, `${diagram}.svg`)), diagram).toBe(true)
  })
})

describe('links', () => {
  test('wiki links are path-relative, same-tab and keep a section', () => {
    expect(guideWikiHref('world/maps.md')).toBe('/wiki?path=world%2Fmaps.md')
    expect(guideWikiHref('index.md#who-it-is-for')).toBe('/wiki?path=index.md#who-it-is-for')
    for (const card of cards) {
      for (const link of card.wiki) {
        expect(link.path, card.id).toMatch(/^(?:[a-z0-9-]+\/)*[a-z0-9-]+\.md(?:#[a-z0-9-]+)?$/)
        expect(link.title.length, card.id).toBeGreaterThan(0)
      }
      // Every card leads somewhere: the wiki, a demo, the Ask page or the wiki home.
      expect(card.wiki.length + (card.action ? 1 : 0), card.id).toBeGreaterThan(0)
    }
  })

  test('demos are linked by featured Definition key only, never by title', () => {
    expect(guideDemoKeys()).toEqual(['world:nordland-corridor-security', 'world:halden-emergency', 'world:halden-offsite-power-restoration'])
    for (const card of cards) {
      if (card.action?.kind === 'demo' && card.action.demo !== null) expect(card.action.demo).toMatch(/^world:[a-z0-9-]+$/)
      if (card.action?.kind === 'page') expect(GUIDE_PAGE_IDS).toContain(card.action.page)
    }
  })
})
