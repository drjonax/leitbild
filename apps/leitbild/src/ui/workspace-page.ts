// What the Workspace page shows (plan v2 §6), as pure functions over the
// Host's catalogue responses: the featured demos this Workspace holds, the
// other Definitions under "More scenarios", what to continue, and the typed
// name that confirms a delete. The Svelte files only render these.

import type {
  FeaturedDefinitionCatalog,
  ModuleDefinitionDescriptor,
  ModuleFeaturedDefinition,
  ModuleResourceDescriptor,
  ResourceSummaryItem,
} from '@leitbild/contracts'

export const PUBLIC_NOTE = 'Public: anyone can see, open, change or delete this Workspace.'
/** The guide hands a conversation over with `?agents=<room>&from=guide`; the shell then links back. */
export const FROM_GUIDE = { param: 'from', value: 'guide' } as const

export const openedFromGuide = (search: string | URLSearchParams): boolean =>
  new URLSearchParams(search).get(FROM_GUIDE.param) === FROM_GUIDE.value

interface DefinitionIdentity {
  readonly moduleId: string
  readonly type: string
  readonly id: string
}

export const sameDefinition = (left: DefinitionIdentity, right: DefinitionIdentity): boolean =>
  left.moduleId === right.moduleId && left.type === right.type && left.id === right.id

export interface FeaturedCard {
  readonly featured: ModuleFeaturedDefinition
  /** This Workspace's own Definition with the featured identity. */
  readonly definition: ModuleDefinitionDescriptor
  /** The Workspace edited the demo: Start runs the featured (original) revision. */
  readonly edited: boolean
}

export interface WorkspaceDemos {
  /** Featured ∩ this Workspace's Definitions, in the Module's featured order. */
  readonly cards: ReadonlyArray<FeaturedCard>
  /** Every other Definition, in catalogue order: the "More scenarios" list. */
  readonly others: ReadonlyArray<ModuleDefinitionDescriptor>
  /** Modules whose featured list failed; their demos stay in `others`. */
  readonly unavailable: ReadonlyArray<string>
}

/**
 * Splits this Workspace's Definitions into the featured demo cards and the
 * rest. `catalog` is null while it loads or when it could not be read; then
 * nothing is featured and every Definition stays startable from the list.
 */
export const workspaceDemos = (
  definitions: ReadonlyArray<ModuleDefinitionDescriptor>,
  catalog: Pick<FeaturedDefinitionCatalog, 'modules' | 'definitions'> | null,
): WorkspaceDemos => {
  if (catalog === null) return { cards: [], others: definitions, unavailable: [] }
  const cards = catalog.definitions.flatMap(featured => {
    const definition = definitions.find(candidate => sameDefinition(candidate.ref, featured.definition))
    return definition === undefined ? [] : [{ featured, definition, edited: definition.currentRevisionId !== featured.revisionId }]
  })
  return {
    cards,
    others: definitions.filter(definition => !cards.some(card => card.definition === definition)),
    unavailable: catalog.modules.filter(outcome => outcome.status === 'failed').map(outcome => outcome.moduleId),
  }
}

/** The revision a card starts: the featured one, also when this Workspace edited the demo (plan v2 §5.3 step 4). */
export const featuredStartRevision = (card: FeaturedCard): string => card.featured.revisionId

/** "image 960w, image 1600w" for a featured preview. */
export const previewSrcset = (preview: ModuleFeaturedDefinition['previews'][number]): string =>
  [...preview.sources].sort((left, right) => left.width - right.width).map(source => `${source.path} ${source.width}w`).join(', ')

/** The smallest source at least `width` wide (else the largest), for `src`. */
export const previewSrc = (preview: ModuleFeaturedDefinition['previews'][number], width = 960): string => {
  const sources = [...preview.sources].sort((left, right) => left.width - right.width)
  return (sources.find(source => source.width >= width) ?? sources[sources.length - 1]!).path
}

// ---------- Continue ----------

export type ContinueKind = 'running' | 'paused' | 'unavailable' | 'conversation'

export interface ContinueItem {
  readonly resource: ModuleResourceDescriptor
  readonly kind: ContinueKind
  /** "Running", "Fast-forward · 4.0×", "Paused", "Conversation". */
  readonly status: string
  /** When it last mattered (Run start, last message), for ordering. */
  readonly at: string | null
  /** At most two facts for the compact card. */
  readonly facts: ReadonlyArray<ResourceSummaryItem>
}

const RUN = 'world.simulation-run'
const ROOM = 'agents.room'
const summaryOf = (resource: ModuleResourceDescriptor, key: string): ResourceSummaryItem | undefined =>
  resource.summary.find(item => item.key === key)
const timestampOf = (resource: ModuleResourceDescriptor, ...keys: string[]): string | null => {
  for (const key of keys) {
    const item = summaryOf(resource, key)
    if (item?.kind === 'timestamp') return item.value
  }
  return null
}
const factsOf = (resource: ModuleResourceDescriptor, keys: ReadonlyArray<string>): ReadonlyArray<ResourceSummaryItem> =>
  keys.flatMap(key => {
    const item = summaryOf(resource, key)
    return item === undefined ? [] : [item]
  }).slice(0, 2)

const runKind = (status: string): ContinueKind =>
  status === 'Paused' ? 'paused' : status === 'Unavailable' ? 'unavailable' : 'running'
const order: Readonly<Record<ContinueKind, number>> = { running: 0, paused: 1, unavailable: 2, conversation: 3 }

/**
 * Runs and conversations a visitor can open from this page: live Runs first,
 * then paused ones, then conversations, each newest first.
 */
export const continueItems = (resources: ReadonlyArray<ModuleResourceDescriptor>): ReadonlyArray<ContinueItem> =>
  resources.flatMap((resource): ContinueItem[] => {
    if (resource.uiPath === undefined) return []
    if (resource.ref.type === RUN) {
      const status = String(summaryOf(resource, 'status')?.value ?? 'Running')
      return [{ resource, kind: runKind(status), status, at: timestampOf(resource, 'started-at'), facts: factsOf(resource, ['started-at', 'viewer-count']) }]
    }
    if (resource.ref.type === ROOM) {
      return [{ resource, kind: 'conversation', status: 'Conversation', at: timestampOf(resource, 'last-activity-at', 'created-at'), facts: factsOf(resource, ['message-count', 'last-activity-at']) }]
    }
    return []
  }).sort((left, right) => order[left.kind] - order[right.kind] || (right.at ?? '').localeCompare(left.at ?? ''))

export const CONTINUE_LIMIT = 3

// ---------- Scenario rows ----------

/** The first sentence of a long description, for the one-line row summary. */
export const summaryLead = (description: string | undefined): string => {
  const text = description?.replace(/\s+/g, ' ').trim() ?? ''
  const sentence = /^(.+?[.!?])(?:\s|$)/.exec(text)
  return sentence?.[1] ?? text
}

/** Whether "More" would reveal anything: more than the lead, or a lead too long for one line. */
export const summaryHasMore = (description: string | undefined): boolean => {
  const text = description?.replace(/\s+/g, ' ').trim() ?? ''
  return text.length > summaryLead(text).length || text.length > 90
}

// ---------- Delete ----------

/** What the visitor types to delete: the name, or the short id of an unnamed Workspace. */
export const deleteConfirmationText = (workspace: { readonly id: string; readonly name: string | null }): string =>
  workspace.name ?? workspace.id.slice(0, 6)

/** Exact after trimming the ends: the point is to make the visitor read the name. */
export const confirmsDeletion = (typed: string, workspace: { readonly id: string; readonly name: string | null }): boolean =>
  typed.trim() === deleteConfirmationText(workspace)
