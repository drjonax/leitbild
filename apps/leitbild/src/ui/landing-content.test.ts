import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import {
  CREDIT_LINK, CREDIT_TEXT, DEMO_KEYS, FACTS, FOOTER_NOTE, HERO_IMAGE_WIDTHS, HERO_SLIDES, LANDING_TITLE, PLAIN_LINE, TAGLINE,
  heroLinkRoute, heroSrcset, slidesToLoad,
} from './landing-content.ts'
import { readModalRoute } from './modal-url.ts'

// Plan v2 §4.5, narrowed so the product's own honest copy passes.
const banned: ReadonlyArray<readonly [string, RegExp]> = [
  ['any question / anything about', /\bany question\b|\banything about\b/i],
  ['realistic', /realistic/i],
  ['qualified, unless "not a qualified"', /(?<!not a )\bqualified\b/i],
  ['certified, unless "not certified"', /(?<!not )\bcertified\b/i],
  ['live Norway', /live Norway/i],
  ['Ambulance pack and its scenarios', /Ambulance pack|halden-dispatch|halden-weather-response/i],
  ['LD-01 / SM-01', /LD-01|SM-01/],
  ['a speed factor', /\d+(\.\d+)?\s*[x×](?![a-z])/i],
  ['people decide', /people decide/i],
  ['stays under human control', /stays under human control/i],
]
const bannedIn = (text: string): ReadonlyArray<string> => banned.filter(([, pattern]) => pattern.test(text)).map(([name]) => name)
const words = (text: string): number => text.trim().split(/\s+/).length

const allCopy = [
  LANDING_TITLE, TAGLINE.map(part => part.text).join(''), PLAIN_LINE, ...FACTS, CREDIT_TEXT, CREDIT_LINK.label, FOOTER_NOTE,
  ...HERO_SLIDES.flatMap(slide => [slide.eyebrow, slide.title, slide.blurb, slide.alt, slide.link.label]),
]

describe('landing copy', () => {
  test('keeps the owner’s tagline verbatim and the brand in the title', () => {
    expect(TAGLINE.map(part => part.text).join('')).toBe('A modular microworld simulation and AI agent sandbox system')
    expect(LANDING_TITLE.startsWith('Leitbild.ai')).toBe(true)
  })

  test('says what it is above the fold: simulation, AI and a domain (C1), and no sign-in (C2)', () => {
    const fold = [TAGLINE.map(part => part.text).join(''), PLAIN_LINE, ...FACTS].join(' ')
    expect(fold).toMatch(/simulat/i)
    expect(fold).toMatch(/\bAI\b/)
    expect(fold).toMatch(/nuclear|grid|dispatch/i)
    expect(FACTS).toContain('No sign-in')
    expect(FACTS.join(' ')).not.toMatch(/free/i)
  })

  test('passes the banned-phrase test', () => {
    for (const text of allCopy) expect({ text, banned: bannedIn(text) }).toEqual({ text, banned: [] })
  })

  test('the banned-phrase test catches what it should and spares honest limits', () => {
    expect(bannedIn('A realistic plant')).toEqual(['realistic'])
    expect(bannedIn('Not a qualified model of a real plant.')).toEqual([])
    expect(bannedIn('A qualified model')).toEqual(['qualified, unless "not a qualified"'])
    expect(bannedIn('Runs 10x faster')).toEqual(['a speed factor'])
    expect(bannedIn('Runs 2.5 × faster')).toEqual(['a speed factor'])
    expect(bannedIn('Halden dispatch exercise')).toEqual([])
  })

  test('uses path-relative product links (both leitbild.ai and leitbild.app serve)', () => {
    expect(CREDIT_LINK.href).toBe('/wiki?path=data-credits.md')
  })
})

describe('hero slides', () => {
  test('six slides with unique ids, titles ≤ 40 characters and blurbs ≤ 18 words', () => {
    expect(HERO_SLIDES).toHaveLength(6)
    expect(new Set(HERO_SLIDES.map(slide => slide.id)).size).toBe(6)
    for (const slide of HERO_SLIDES) {
      expect(slide.title.length).toBeLessThanOrEqual(40)
      expect({ slide: slide.id, words: words(slide.blurb) <= 18 }).toEqual({ slide: slide.id, words: true })
      expect(slide.eyebrow).not.toBe(slide.eyebrow.toUpperCase()) // mixed case in the DOM; CSS uppercases it
    }
  })

  test('every image has alt text that describes it without repeating the title', () => {
    for (const slide of HERO_SLIDES) {
      expect(slide.alt.length).toBeGreaterThan(20)
      expect(slide.alt.length).toBeLessThanOrEqual(140)
      expect(slide.alt.toLowerCase()).not.toContain(slide.title.toLowerCase())
    }
  })

  test('uses the final image names and ships both widths of each', () => {
    expect(HERO_SLIDES.map(slide => slide.image)).toEqual([
      'hero-ask-plant', 'hero-two-futures', 'hero-generated', 'hero-einsatz', 'hero-proposes', 'hero-inspect',
    ])
    for (const slide of HERO_SLIDES) {
      for (const width of HERO_IMAGE_WIDTHS) {
        expect(existsSync(new URL(`./assets/landing/${slide.image}-${width}.webp`, import.meta.url))).toBe(true)
      }
    }
  })

  test('each slide has one link: a featured demo by key, or a guide card', () => {
    const demoKeys = new Set<string>(Object.values(DEMO_KEYS))
    const guidePages = new Set(['start', 'world', 'plant', 'ai', 'more', 'ask'])
    for (const slide of HERO_SLIDES) {
      if (slide.link.kind === 'demo') {
        expect(demoKeys.has(slide.link.demo)).toBe(true)
        expect(slide.link.label).toMatch(/^Try the .+ demo$/)
      } else {
        expect(guidePages.has(slide.link.page)).toBe(true)
        expect(slide.link.label).toBe('How it works')
      }
    }
    // No two demo slides in a row, and no two light display shots in a row (slides 3 and 5 are displays).
    expect(HERO_SLIDES.map(slide => slide.link.kind)).toEqual(['demo', 'demo', 'guide', 'demo', 'guide', 'guide'])
  })

  test('a hero link opens the matching modal route, which survives the URL round trip', () => {
    const offsite = heroLinkRoute(HERO_SLIDES[0]!.link)
    expect(offsite).toEqual({ kind: 'demos', demo: 'world:halden-offsite-power-restoration' })
    expect(readModalRoute('?demos=world:halden-offsite-power-restoration')).toEqual(offsite)
    const displays = heroLinkRoute(HERO_SLIDES[2]!.link)
    expect(displays).toEqual({ kind: 'guide', page: 'plant', card: 'displays' })
    expect(readModalRoute('?guide=plant&card=displays')).toEqual(displays)
  })

  test('srcset names both widths and refuses a missing one', () => {
    expect(heroSrcset(new Map([[960, '/a-960.webp'], [1600, '/a-1600.webp']]))).toBe('/a-960.webp 960w, /a-1600.webp 1600w')
    expect(() => heroSrcset(new Map([[960, '/a-960.webp']]))).toThrow('Missing hero image width 1600')
  })
})

describe('slide image loading (C12)', () => {
  test('loads slide 1 first, the rest after load and idle', () => {
    expect([...slidesToLoad({ count: 6, shown: new Set(), idle: false, saveData: false })]).toEqual([0])
    expect([...slidesToLoad({ count: 6, shown: new Set(), idle: true, saveData: false })]).toEqual([0, 1, 2, 3, 4, 5])
  })

  test('loads a slide as soon as it is shown', () => {
    expect([...slidesToLoad({ count: 6, shown: new Set([3]), idle: false, saveData: false })].sort()).toEqual([0, 3])
  })

  test('preloads nothing under Save-Data', () => {
    expect([...slidesToLoad({ count: 6, shown: new Set([1]), idle: true, saveData: true })].sort()).toEqual([0, 1])
  })
})
