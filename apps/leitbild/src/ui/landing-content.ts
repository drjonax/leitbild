// The landing page's own words and hero slides (plan v2 §3, copy style §4.4).
// Host copy only: demos are linked by their Definition key, never described
// here. Titles, summaries and previews of demos come from the Modules'
// featured catalogue at runtime.

import type { ModalRoute } from './modal-url.ts'

export const LANDING_TITLE = 'Leitbild.ai — microworld simulation and AI agent sandbox'

/** The owner's tagline, verbatim; the bold parts are rendered as <strong>. */
export const TAGLINE = [
  { text: 'A modular ' },
  { text: 'microworld simulation', strong: true },
  { text: ' and ' },
  { text: 'AI agent sandbox', strong: true },
  { text: ' system' },
] as const satisfies ReadonlyArray<{ readonly text: string; readonly strong?: boolean }>

/** The plain line under the tagline; also the page's meta description. */
export const PLAIN_LINE = 'Simulate a nuclear plant, Norway’s power grid and emergency dispatch in your browser, and work with AI agents that observe, explain and propose actions.'

export const FACTS = ['No sign-in', 'Desktop or iPad', 'Open source'] as const

export const CREDIT_TEXT = 'Map and grid data © OpenStreetMap contributors (ODbL) and others'
export const CREDIT_LINK = { label: 'Credits', href: '/wiki?path=data-credits.md' } as const

export const FOOTER_NOTE = 'Fictional scenarios and reference models. Not operational guidance.'
/** Leitbild's own code is MIT; the plant displays bundle OpenBridge, which is AGPL-3.0-only (NOTICE.md says which parts and where their source is). */
export const LICENCE_LINK = { label: 'Licences: MIT, AGPL display parts', href: 'https://github.com/michaelhil/leitbild/blob/main/NOTICE.md' } as const

/** Featured demos the hero links to, by `demoKey`. Their copy comes from the catalogue. */
export const DEMO_KEYS = {
  offsite: 'world:halden-offsite-power-restoration',
  nordland: 'world:nordland-corridor-security',
  dispatch: 'world:halden-emergency',
} as const

export type HeroLink =
  | { readonly kind: 'demo'; readonly demo: string; readonly label: string }
  | { readonly kind: 'guide'; readonly page: string; readonly card: string; readonly label: string }

export interface HeroSlide {
  readonly id: string
  /** Mixed case; CSS uppercases it. */
  readonly eyebrow: string
  readonly title: string
  /** ≤ 18 words. */
  readonly blurb: string
  /** Describes what the image shows; ≤ 140 characters, never the title again. */
  readonly alt: string
  /** File stem in `assets/landing/`: `<image>-960.webp` and `<image>-1600.webp` (plan v2 §9). */
  readonly image: string
  /** Exactly one link per slide. */
  readonly link: HeroLink
}

export const HERO_IMAGE_WIDTHS = [960, 1600] as const
export const HERO_IMAGE_HEIGHT_960 = 600

export const HERO_SLIDES: ReadonlyArray<HeroSlide> = [
  {
    id: 'ask-plant',
    eyebrow: 'Nuclear plant · Assistant',
    title: 'Ask about the plant',
    blurb: 'Ask the Assistant about a simulated nuclear plant; answers can include a live display built from the model.',
    alt: 'Halden Unit 1’s live display after loss of offsite power, beside the Assistant’s written assessment of the event.',
    image: 'hero-ask-plant',
    link: { kind: 'demo', demo: DEMO_KEYS.offsite, label: 'Try the Halden demo' },
  },
  {
    id: 'two-futures',
    eyebrow: 'Power grid · What-if',
    title: 'Two futures, one grid',
    blurb: 'A line trips in a model of northern Norway’s grid: copy the simulation, fix one copy, compare outcomes.',
    alt: 'Northern Norway on the map after a line trip, with tripped lines in red and the grid panel listing alarms.',
    image: 'hero-two-futures',
    link: { kind: 'demo', demo: DEMO_KEYS.nordland, label: 'Try the northern grid demo' },
  },
  {
    id: 'generated',
    eyebrow: 'Nuclear plant · Displays',
    title: 'Generated, not drawn',
    blurb: 'Plant screens are generated from the simulation model, never drawn by hand, for every unit and situation.',
    alt: 'A generated overview of a reactor unit just after a trip: turbine off line, bypass open, coolant loops with pumps and steam generators.',
    image: 'hero-generated',
    link: { kind: 'guide', page: 'plant', card: 'displays', label: 'How it works' },
  },
  {
    id: 'einsatz',
    eyebrow: 'Emergency dispatch · Einsatz',
    title: 'Dispatch by touch',
    blurb: 'Send ambulances, patrol cars and fire engines to fictional calls by touch, alone or as a team.',
    alt: 'A dispatch board over a map of Halden: a divert decision awaiting confirmation, the call list and free units.',
    image: 'hero-einsatz',
    link: { kind: 'demo', demo: DEMO_KEYS.dispatch, label: 'Try the dispatch demo' },
  },
  {
    id: 'proposes',
    eyebrow: 'Nuclear plant · Human control',
    title: 'AI proposes, a person approves',
    blurb: 'By default, an AI agent only proposes plant operations; nothing happens until a person approves it.',
    alt: 'A valve on a live plant display with an AI proposal to shut it, waiting beside Approve and Reject buttons.',
    image: 'hero-proposes',
    link: { kind: 'guide', page: 'ai', card: 'proposals', label: 'How it works' },
  },
  {
    id: 'inspect',
    eyebrow: 'AI · Inspection',
    title: 'See inside every answer',
    blurb: 'Open any AI answer to see the instructions, tool calls and evidence that went into it.',
    alt: 'The Prompt and Generation Inspector with one tool call open: the wiki search the AI ran and its query.',
    image: 'hero-inspect',
    link: { kind: 'guide', page: 'more', card: 'inspect', label: 'How it works' },
  },
]

/** The modal a hero link opens. */
export const heroLinkRoute = (link: HeroLink): ModalRoute =>
  link.kind === 'demo' ? { kind: 'demos', demo: link.demo } : { kind: 'guide', page: link.page, card: link.card }

/** srcset for a hero image, given the URL of each width. */
export const heroSrcset = (urls: ReadonlyMap<number, string>): string =>
  HERO_IMAGE_WIDTHS.map(width => {
    const url = urls.get(width)
    if (url === undefined) throw new Error(`Missing hero image width ${width}`)
    return `${url} ${width}w`
  }).join(', ')

export const HERO_IMAGE_SIZES = '(max-width: 900px) 96vw, 880px'

/**
 * Which slides may load their image now (plan v2 C12): slide 1 at once, every
 * slide that has been shown, and, once the page has loaded and gone idle, the
 * one after the current slide, so a rotation never shows an empty frame.
 * Under Save-Data nothing is fetched ahead.
 */
export const slidesToLoad = (state: {
  readonly count: number
  readonly current: number
  readonly shown: ReadonlySet<number>
  readonly idle: boolean
  readonly saveData: boolean
}): ReadonlySet<number> => {
  const load = new Set([0, state.current, ...state.shown])
  if (state.idle && !state.saveData && state.count > 0) load.add((state.current + 1) % state.count)
  return load
}
