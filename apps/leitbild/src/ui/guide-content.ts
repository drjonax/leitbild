// The Getting started guide's text (plan v2 §4): 5 chapters of 2–4 cards and
// the Ask page. Host copy only: a demo is linked by its featured Definition key
// (`world:<scenario id>`), never by its title or text, and every image is named
// by its shot id (plan v2 §9), so a recaptured screenshot is a file swap.
// `guide-content.test.ts` holds the copy rules (§4.4, §4.5).

export const GUIDE_PAGE_IDS = ['start', 'world', 'plant', 'ai', 'more', 'ask'] as const
export type GuidePageId = typeof GUIDE_PAGE_IDS[number]

/** Screenshot ids; `assets/guide/<id>-720.webp` and `<id>-1200.webp` exist for each. */
export const GUIDE_SHOT_IDS = [
  'guide-what', 'guide-maps', 'guide-grid', 'guide-einsatz', 'guide-time', 'guide-pwr', 'guide-graphs',
  'guide-displays', 'guide-assistant', 'guide-agents', 'guide-proposals', 'guide-inspect', 'guide-packs', 'guide-wiki',
] as const
export type GuideShotId = typeof GUIDE_SHOT_IDS[number]
export const GUIDE_SHOT_WIDTHS = [720, 1200] as const

/** Simple diagrams drawn for the guide (`assets/guide/<id>.svg`). */
export type GuideDiagramId = 'workspaces' | 'discovery'

export type GuideMedia =
  | { readonly kind: 'shot'; readonly shot: GuideShotId; readonly alt: string }
  | { readonly kind: 'diagram'; readonly diagram: GuideDiagramId; readonly alt: string }
  /** Three short tiles instead of an image ("who it is for"). */
  | { readonly kind: 'audiences'; readonly audiences: ReadonlyArray<{ readonly title: string; readonly text: string }> }

export type GuideAction =
  /** Opens the Demos modal at this featured demo (`world:<id>`), or at its first slide when null. */
  | { readonly kind: 'demo'; readonly label: string; readonly demo: string | null; readonly helper?: string }
  /** Another guide page, e.g. "Ask a question" → the Ask page. */
  | { readonly kind: 'page'; readonly label: string; readonly page: GuidePageId }
  /** The wiki's front page. */
  | { readonly kind: 'wiki'; readonly label: string }

/** A wiki page: `path` as the wiki names it, with an optional `#section`; `title` is that page's own title. */
export interface GuideWikiLink {
  readonly path: string
  readonly title: string
}

export interface GuideCard {
  readonly id: string
  /** H4, ≤ 40 characters. */
  readonly title: string
  readonly body: string
  /** "Why it matters" line. */
  readonly why?: string
  /** "Limits" line. */
  readonly limits?: string
  readonly media: GuideMedia | null
  readonly action?: GuideAction
  /** The first is "Read in the wiki"; further ones are named by their title. */
  readonly wiki: ReadonlyArray<GuideWikiLink>
}

export interface GuideChapter {
  readonly kind: 'chapter'
  readonly id: Exclude<GuidePageId, 'ask'>
  /** Contents, footer and H3. */
  readonly title: string
  /** Contents subtitle. */
  readonly subtitle: string
  readonly intro: string
  readonly cards: ReadonlyArray<GuideCard>
  /** The map credit line closes the chapter that holds map screenshots. */
  readonly mapCredit: boolean
}

export interface GuidePrompt {
  /** The chip's text; also names the new conversation. */
  readonly label: string
  /** What is sent; it starts like the label so the user recognises it in the conversation. */
  readonly prompt: string
}

export interface GuideAskPage {
  readonly kind: 'ask'
  readonly id: 'ask'
  readonly title: string
  readonly subtitle: string
  /** The owner's sentence, the page's H3. */
  readonly heading: string
  readonly intro: string
  readonly prompts: ReadonlyArray<GuidePrompt>
}

export type GuidePage = GuideChapter | GuideAskPage

export const QUESTION_MAX_LENGTH = 500

const wiki = (path: string, title: string): GuideWikiLink => ({ path, title })

export const GUIDE_PAGES: ReadonlyArray<GuidePage> = [
  {
    kind: 'chapter', id: 'start', title: 'Start here', subtitle: 'What it is, who it is for',
    intro: 'What Leitbild is, who it is for, and where your work lives.',
    mapCredit: false,
    cards: [
      {
        id: 'what', title: 'What Leitbild is',
        body: 'Leitbild is a sandbox in your browser for simulated microworlds (a nuclear power plant, a model of Norway’s power grid, emergency dispatch) where people and AI agents work side by side. Simulations run without AI, and the AI can answer questions without a simulation.',
        why: 'Set up a situation, speed it up, copy it, and see how people and AI reason about it.',
        media: { kind: 'shot', shot: 'guide-what', alt: 'The Halden power complex on the map of Norway, its plants listed in the side rail and the grid panel on the right.' },
        action: { kind: 'demo', label: 'Try a demo', demo: null },
        wiki: [wiki('index.md', 'Leitbild'), wiki('concepts.md', 'Leitbild concepts')],
      },
      {
        id: 'why', title: 'Why it exists, and who it is for',
        body: 'Real plants, grids and emergency services cannot be paused, copied or experimented on, and AI assistants are hard to trust when you cannot see what they used. Leitbild puts people and AI agents in the same simulated situation and shows what each AI answer used.',
        limits: 'Research and training models, not certified engineering or operational tools.',
        media: {
          kind: 'audiences', audiences: [
            { title: 'Researchers', text: 'Study how people and AI reason and act, and inspect each AI step.' },
            { title: 'Engineers and students', text: 'Operate a plant model and a grid model whose limits are documented.' },
            { title: 'Trainers', text: 'Run dispatch exercises with roles on several screens.' },
          ],
        },
        wiki: [wiki('index.md#who-it-is-for', 'Who it is for')],
      },
      {
        id: 'workspaces', title: 'Workspaces',
        body: 'A Workspace holds the scenarios you can start, your running simulations (Runs) and your AI conversations. There are no accounts: anyone can create one, and each has its own address to bookmark or share. Workspaces are public: anyone can see, open, change or delete them.',
        why: 'An experiment’s Runs and conversations stay together under one link.',
        media: { kind: 'diagram', diagram: 'workspaces', alt: 'A Workspace at its own address holds World (scenarios, Runs, what-if copies) and Agents (conversations, the Assistant, your AI agents).' },
        action: { kind: 'demo', label: 'Try a demo', demo: null, helper: 'A demo creates a Workspace for you.' },
        wiki: [wiki('getting-started.md', 'Getting started'), wiki('user-interface/index.md', 'User interface')],
      },
    ],
  },
  {
    kind: 'chapter', id: 'world', title: 'The simulated world', subtitle: 'Map, grid, dispatch, time',
    intro: 'One map, a national grid model, a dispatch engine, and a clock you control.',
    mapCredit: true,
    cards: [
      {
        id: 'maps', title: 'One map for every world',
        body: 'Every simulation is shown on the same map of Norway, with its assets, live overlays such as grid loading, and reference layers. Leitbild builds and hosts this base map itself from OpenStreetMap and other open data.',
        why: 'Plant, grid and dispatch share one geographic picture, and a new Pack gets the same map.',
        media: { kind: 'shot', shot: 'guide-maps', alt: 'The Oslofjord on the map, with transmission lines coloured by their live loading and the grid panel beside them.' },
        wiki: [wiki('world/maps.md', 'Maps'), wiki('world/packs/electric-grid/map-overlay.md', 'Grid map overlay')],
      },
      {
        id: 'grid', title: 'The electricity grid',
        body: 'A simulation model of Norway’s transmission grid (132 kV and above), compiled from open data, with links to neighbouring countries and the rest of the Nordic grid in simplified form. It computes flows, frequency and protection trips as it runs; in the Halden scenarios it is connected to four simulated nuclear units.',
        why: 'Trip a line or a power station and watch frequency respond, or find which single outage the grid cannot survive (N-1).',
        limits: 'Demand and generation come from measured reference hours, not from today’s grid.',
        media: { kind: 'shot', shot: 'guide-grid', alt: 'The grid panel after a generator trip: the grid frequency below its setpoint and a list of new alarms.' },
        action: { kind: 'demo', label: 'Try the northern grid demo', demo: 'world:nordland-corridor-security' },
        wiki: [wiki('world/packs/electric-grid/index.md', 'Electric grid'), wiki('world/packs/electric-grid/model-and-data.md', 'Model and data')],
      },
      {
        id: 'einsatz', title: 'Einsatz',
        body: 'Einsatz (German for a call-out) is Leitbild’s dispatch and command engine. Ambulances, patrol cars, fire engines, trucks or tanks: every unit type, call and role comes from the scenario, not from code. Tap a call, then its suggested unit; teams split roles across screens, and each side sees only what its own units detect.',
        why: 'One engine for emergency-service, logistics and military exercises, built for teams.',
        limits: 'The exercises are fictional, and the Assistant is not available in exercises with roles.',
        media: { kind: 'shot', shot: 'guide-einsatz', alt: 'The dispatch board over Halden: waiting calls ranked by priority, and units driving their routes on the map.' },
        action: { kind: 'demo', label: 'Try the dispatch demo', demo: 'world:halden-emergency' },
        wiki: [wiki('world/packs/einsatz/index.md', 'Einsatz'), wiki('world/roles-and-sides.md', 'Roles and sides')],
      },
      {
        id: 'time', title: 'Faster than realtime, and what-if copies',
        body: 'Each simulation has its own clock: pause it, run it at maximum pace, or fast-forward by a set number of minutes. Copy a running simulation and the copy starts paused at the same moment, with its own clock and history. Try something different in it and compare.',
        why: 'Skip the slow parts and compare “what if we had done X” side by side.',
        limits: 'How much faster depends on the model; live data feeds cannot be fast-forwarded.',
        media: { kind: 'shot', shot: 'guide-time', alt: 'The fast-forward dialog over the map: one-tap buttons for one, two or five simulated minutes.' },
        action: { kind: 'demo', label: 'Try the northern grid demo', demo: 'world:nordland-corridor-security' },
        wiki: [wiki('world/time-and-copies.md', 'Time and copies')],
      },
    ],
  },
  {
    kind: 'chapter', id: 'plant', title: 'The nuclear plant', subtitle: 'PWR, graphs, displays',
    intro: 'A four-loop reference nuclear plant (PWR), the component graph it is built from, and displays generated from it.',
    mapCredit: false,
    cards: [
      {
        id: 'pwr', title: 'The nuclear plant (PWR)',
        body: 'A simulated pressurised-water reactor (PWR) with four coolant loops, modelled component by component: pumps, valves, steam generators, turbine and electrical supply. The Halden scenarios place four fictional units on the map, connected to the grid. Emergency procedures open beside the plant and keep your place as you work.',
        why: 'Watch and operate a whole plant through a turbine trip, a loss of offsite power or a tube leak, alone or with AI.',
        limits: 'A detailed reference model, not a qualified model of a real plant.',
        media: { kind: 'shot', shot: 'guide-pwr', alt: 'A generated overview of one unit: four coolant loops with their pumps and steam generators, the turbine and the reactor.' },
        action: { kind: 'demo', label: 'Try the Halden demo', demo: 'world:halden-offsite-power-restoration' },
        wiki: [wiki('world/packs/process-plant/index.md', 'Process Plant'), wiki('archive/pwr-reference-model/index.md', 'PWR reference model')],
      },
      {
        id: 'graphs', title: 'Plant component graphs',
        body: 'Each plant is a graph of components and their connections, more than a hundred in the four-loop model. From any plant you can open the full component graph, the authored specification and links to the code behind each component. Displays and AI answers trace back to this model.',
        why: 'Nothing is a black box: you can check where a displayed value comes from.',
        media: { kind: 'shot', shot: 'guide-graphs', alt: 'Part of a unit’s component graph: boxes for pumps, valves and steam generators joined by their connections.' },
        wiki: [wiki('world/packs/process-plant/inspection.md', 'Displays and source inspection')],
      },
      {
        id: 'displays', title: 'Displays generated from the model',
        body: 'Plant screens are not drawn by hand: Leitbild generates an overview for every unit from its model. When you ask the AI about the plant, it can compose a display for that question (trends against alarm limits, the relevant flow path), fed live by the simulation, and states the question it answers.',
        why: 'One visual language adapts to any plant or situation, and you see the evidence the AI points at.',
        limits: 'Every display is marked “not an operating display”.',
        media: { kind: 'shot', shot: 'guide-displays', alt: 'A display the AI composed for a tube-leak question: secondary radiation and leak rate trending against their alarm limits.' },
        wiki: [wiki('world/packs/process-plant/displays/live-operator-displays.md', 'Live operator displays')],
      },
    ],
  },
  {
    kind: 'chapter', id: 'ai', title: 'AI agents', subtitle: 'Assistant, agents, discovery',
    intro: 'AI that finds its own way through the simulation, and the controls that keep it in check.',
    mapCredit: false,
    cards: [
      {
        id: 'assistant', title: 'The Leitbild Assistant',
        body: 'A built-in AI assistant you can ask about Leitbild, about a running simulation, or for help building a scenario. It looks things up in the wiki and the product’s source code, and explores the simulation through the same operations people use. Answers cite their sources.',
        limits: 'It does not browse the web, and an answer can take up to two minutes.',
        media: { kind: 'shot', shot: 'guide-assistant', alt: 'An Assistant answer in a conversation, with links to the wiki pages and source files it used.' },
        action: { kind: 'page', label: 'Ask a question', page: 'ask' },
        wiki: [wiki('agents/index.md', 'Agents')],
      },
      {
        id: 'agents', title: 'AI agents you configure',
        body: 'For each agent you choose the model, persona, tools and skills; for each conversation, which Packs it uses and how much of the Workspace it may see. For each simulation you can block specific operations, and you can re-run a finished answer on another model to compare.',
        why: 'Control what an agent can see and do, and compare models on the same question.',
        media: { kind: 'shot', shot: 'guide-agents', alt: 'An agent’s answer about core cooling after a pump trip, with the model it used and a live display it composed.' },
        wiki: [wiki('agents/index.md', 'Agents'), wiki('agents/model-comparisons.md', 'Comparing models on a task')],
      },
      {
        id: 'discovery', title: 'Progressive discovery',
        body: 'The AI is not handed everything up front. It starts from your question, asks the Workspace what exists and what it may do, reads only what it needs, and stops when the evidence is enough. The Inspector shows each of these steps.',
        why: 'Answers stay focused on current data, and new Packs work with the AI without AI-specific code.',
        media: { kind: 'diagram', diagram: 'discovery', alt: 'From a question, the AI explores what exists, reads only what it needs, follows references, and answers with evidence.' },
        wiki: [wiki('agents/discovery.md', 'Discovering a simulation')],
      },
      {
        id: 'proposals', title: 'AI proposes, a person approves',
        body: 'On the plant, an AI agent does not operate equipment itself. It proposes an operation; the proposal appears on the equipment and in the chat, and nothing happens until a person approves or rejects it. Elsewhere, such as on the grid, you can block what an agent may do in each simulation.',
        why: 'A person stays accountable for every plant operation, which research on human–AI teamwork needs.',
        media: { kind: 'shot', shot: 'guide-proposals', alt: 'A proposal from an AI agent on a steam valve, waiting for a person to approve or reject it.' },
        wiki: [wiki('world/packs/process-plant/displays/operating-equipment.md', 'Operating plant equipment')],
      },
    ],
  },
  {
    kind: 'chapter', id: 'more', title: 'Trust and going further', subtitle: 'Inspection, limits, building, wiki',
    intro: 'See how answers were made, know the limits, build your own, and read further.',
    mapCredit: false,
    cards: [
      {
        id: 'inspect', title: 'Inspect every AI answer',
        body: 'Every AI answer has an ⓘ button that opens the Prompt & Generation Inspector: the instructions and context that went into each model call, every tool call with its arguments and results, and token and cost figures.',
        why: 'See why the AI said what it said, and which evidence it used.',
        media: { kind: 'shot', shot: 'guide-inspect', alt: 'The Prompt & Generation Inspector: sections for the instructions, the context and each tool call of one answer.' },
        wiki: [wiki('agents/context-and-inspection.md', 'Context and inspection')],
      },
      {
        id: 'limits', title: 'Limits and data sources',
        body: 'Leitbild’s models are for research and training. The PWR is not a qualified model of a real plant, the grid is built from open data rather than today’s grid, and the dispatch exercises are fictional. Data comes from OpenStreetMap, NVE, Elhub, Kartverket, SSB and Energy-Charts (ENTSO-E), among others; Leitbild’s code and documentation are MIT-licensed.',
        media: null,
        wiki: [wiki('index.md', 'Leitbild'), wiki('world/packs/electric-grid/model-and-data.md', 'Model and data'), wiki('data-credits.md', 'Map and data credits')],
      },
      {
        id: 'packs', title: 'Packs and scenarios',
        body: 'Leitbild is modular. Each domain (process plant, electric grid, Einsatz dispatch, weather) is a Pack that adds its own equipment, models and operations. A scenario combines Packs into a situation with a starting state and a timeline; build your own in the scenario editor, or ask the Assistant to draft one.',
        why: 'New domains plug in without rebuilding the platform, and the AI discovers them as it works.',
        media: { kind: 'shot', shot: 'guide-packs', alt: 'The side rail of a running simulation, grouping its process plants, electric grid and weather areas by Pack.' },
        wiki: [wiki('world/packs/index.md', 'World packs'), wiki('world/scenarios.md', 'Composing scenarios')],
      },
      {
        id: 'wiki', title: 'The wiki',
        body: 'Leitbild is documented in one open wiki, which the Assistant reads too. Its sections: Leitbild (getting started, concepts, architecture), World (scenarios, time and copies, roles, one area per Pack), Agents (how the AI finds information), User interface, and Archive (the PWR reference handbook and procedures).',
        why: 'One source of truth for people and AI, with search and a Feedback link on every page.',
        media: { kind: 'shot', shot: 'guide-wiki', alt: 'The documentation’s front page: its sections listed on the left, a search field and the page text.' },
        action: { kind: 'wiki', label: 'Open the wiki' },
        wiki: [],
      },
    ],
  },
  {
    kind: 'ask', id: 'ask', title: 'Ask the Leitbild Assistant', subtitle: 'Anything this guide does not cover',
    heading: 'If you want to know more, ask the Leitbild Assistant',
    intro: 'It answers from the Leitbild wiki, the product’s source and your Workspace’s simulations, and shows what it used.',
    prompts: [
      {
        label: 'What can I try in my first ten minutes?',
        prompt: 'What can I try in Leitbild in my first ten minutes? Point me to the demos and wiki pages that fit.',
      },
      {
        label: 'What are the nuclear plant model’s limits?',
        prompt: 'What are the limits of Leitbild’s nuclear plant (PWR) model, how faithful is it to a real plant, and where is that documented?',
      },
      {
        label: 'Where does the grid data come from?',
        prompt: 'Where does Leitbild’s Norwegian grid model come from, and how close are its flows to measured data?',
      },
      {
        label: 'How can I see what went into an answer?',
        prompt: 'How can I see exactly what went into one of your answers?',
      },
      {
        label: 'How do I run Einsatz on several iPads?',
        prompt: 'How do I run an Einsatz exercise with several people on their own iPads?',
      },
    ],
  },
]

/** The map credit under the chapter with map screenshots (owner ruling, plan v2 §3). */
export const GUIDE_MAP_CREDIT = {
  text: 'Map and grid data © OpenStreetMap contributors (ODbL) and others',
  link: wiki('data-credits.md', 'Map and data credits'),
} as const

/** Same-tab, path-relative wiki link: `/wiki?path=world%2Fmaps.md`, with `#section` kept. */
export const guideWikiHref = (path: string): string => {
  const hash = path.indexOf('#')
  const page = hash === -1 ? path : path.slice(0, hash)
  return `/wiki?path=${encodeURIComponent(page)}${hash === -1 ? '' : path.slice(hash)}`
}

export const guidePage = (id: GuidePageId): GuidePage => {
  const page = GUIDE_PAGES.find(item => item.id === id)
  if (!page) throw new Error(`Unknown guide page: ${id}`)
  return page
}

/** A card id on a chapter, or null (a deep link to an unknown card opens the page at its top). */
export const guideCard = (page: GuidePage, cardId: string | null): GuideCard | null =>
  page.kind === 'chapter' && cardId !== null ? page.cards.find(card => card.id === cardId) ?? null : null

/** Every featured demo key the guide links to; the catalogue must still feature each one. */
export const guideDemoKeys = (): ReadonlyArray<string> => [...new Set(GUIDE_PAGES.flatMap(page =>
  page.kind === 'chapter'
    ? page.cards.flatMap(card => card.action?.kind === 'demo' && card.action.demo !== null ? [card.action.demo] : [])
    : []))]

/** Chapter heading eyebrow, mixed case ("Chapter 3 of 6"); CSS shows it uppercase. */
export const chapterEyebrow = (index: number): string => `Chapter ${index + 1} of ${GUIDE_PAGES.length}`
