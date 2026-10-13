// The Modules' featured demos (plan v2 §5, §6) and the scenarios they list
// beside them, shared by the landing's Demos modal and its More scenarios list,
// the Start demo flow and the Workspace page. The Host keeps no demo or
// scenario list: it reads GET /api/featured-definitions, which each Module
// publishes for itself, and validates it with the contract (loaded lazily, so
// the landing's first paint carries no zod).

import type { FeaturedDefinitionCatalog, ModuleFeaturedDefinition, ModuleListedDefinition } from '@leitbild/contracts'
import { readHostJson } from './launch-workspace.ts'
import { demoKey } from './modal-url.ts'

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export const FEATURED_PATH = '/api/featured-definitions'

export const NO_DEMOS_TEXT = 'No demos are available right now.'
export const DEMOS_UNAVAILABLE_TEXT = 'Demos are unavailable right now.'
export const DEEP_LINK_NOT_FEATURED_TEXT = 'That demo is no longer featured.'
export const NO_SCENARIOS_TEXT = 'No other scenarios are listed right now.'
export const SCENARIOS_UNAVAILABLE_TEXT = 'Scenarios are unavailable right now.'

/**
 * The Modules' featured Definitions. The Host answers with an ETag and
 * `no-cache`, so the browser revalidates a catalogue it already holds.
 */
export const readFeaturedCatalogue = async (fetchImpl: FetchLike, signal?: AbortSignal): Promise<FeaturedDefinitionCatalog> => {
  const response = await fetchImpl(FEATURED_PATH, signal === undefined ? { method: 'GET' } : { method: 'GET', signal })
  const body = await readHostJson(response)
  const { featuredDefinitionCatalogSchema } = await import('@leitbild/contracts')
  return featuredDefinitionCatalogSchema.parse(body)
}

/** What the Demos surfaces show for a catalogue: its demos, or why there are none. */
export const catalogueView = (catalogue: FeaturedDefinitionCatalog, moduleId = 'world'): {
  readonly demos: ReadonlyArray<ModuleFeaturedDefinition>
  readonly empty: string | null
} => {
  const demos = catalogue.definitions.filter(featured => featured.definition.moduleId === moduleId)
  if (demos.length > 0) return { demos, empty: null }
  const outcome = catalogue.modules.find(item => item.moduleId === moduleId)
  return { demos, empty: outcome?.status === 'failed' ? DEMOS_UNAVAILABLE_TEXT : NO_DEMOS_TEXT }
}

/** What the More scenarios list shows for a catalogue: the Module's listed scenarios, or why there are none. */
export const listedView = (catalogue: FeaturedDefinitionCatalog, moduleId = 'world'): {
  readonly scenarios: ReadonlyArray<ModuleListedDefinition>
  readonly empty: string | null
} => {
  const scenarios = catalogue.listed.filter(listed => listed.definition.moduleId === moduleId)
  if (scenarios.length > 0) return { scenarios, empty: null }
  const outcome = catalogue.modules.find(item => item.moduleId === moduleId)
  return { scenarios, empty: outcome?.status === 'failed' ? SCENARIOS_UNAVAILABLE_TEXT : NO_SCENARIOS_TEXT }
}

/** Where `?demos=<key>` opens: that demo's index, or the first with a notice for an unknown key. */
export const deepLinkedDemo = (demos: ReadonlyArray<ModuleFeaturedDefinition>, key: string | null): {
  readonly index: number
  readonly notice: string | null
} => {
  if (key === null) return { index: 0, notice: null }
  const index = demos.findIndex(featured => demoKey(featured.definition) === key)
  return index >= 0 ? { index, notice: null } : { index: 0, notice: DEEP_LINK_NOT_FEATURED_TEXT }
}

/** The icon for a demo's tag chip: device, players, time, or the domain. */
export const demoTagIcon = (tag: string): 'screen' | 'tablet' | 'users' | 'clock' | 'layers' => {
  if (/\biPad\b/i.test(tag)) return 'tablet'
  if (/\bdesktop\b/i.test(tag)) return 'screen'
  if (/\bplayers?\b/i.test(tag)) return 'users'
  if (/\b\d+\s*min\b/i.test(tag)) return 'clock'
  return 'layers'
}
