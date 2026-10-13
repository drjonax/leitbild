import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { moduleFeaturedDefinitionCollectionSchema, type ModuleFeaturedDefinitionCollection } from '@leitbild/contracts'
import { definitionRevisionIdFor } from '@leitbild/module-runtime'
import { z } from 'zod'
import { scenarioDefinitionSchema, type ScenarioDefinition } from '../core/scenarios/definition.ts'
import { builtinScenarioDefinitions } from './definitions.ts'

/**
 * Where World serves featured preview images. The files live in
 * `src/ui/public/assets/world/scenario-previews/`, which Vite copies without
 * hashing, so each file name carries its own content hash.
 */
export const scenarioPreviewPath = '/assets/world/scenario-previews/'

// featured.json names bundled Scenarios by id and carries only the demo copy
// and the previews. The title and the exact revision come from the bundled
// Scenario itself; the wire contract bounds every field.
const featuredScenarioSourceSchema = z.array(z.object({
  scenarioId: z.string().min(1).max(128),
  summary: z.string(),
  about: z.string(),
  tags: z.array(z.string()),
  previews: z.array(z.object({
    alt: z.string(),
    width: z.number(),
    height: z.number(),
    sources: z.array(z.object({
      file: z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.webp$/),
      width: z.number(),
    }).strict()),
  }).strict()),
}).strict())

// listed.json names other bundled Scenarios World lists for quick access
// beside the demos, in its order, with a one-sentence summary and one or two
// tags; the title and the revision come from the bundled Scenario, as above.
const listedScenarioSourceSchema = z.array(z.object({
  scenarioId: z.string().min(1).max(128),
  summary: z.string(),
  tags: z.array(z.string()),
}).strict())

/**
 * The featured Scenarios World publishes, in featured.json order, and the
 * Scenarios it lists beside them, in listed.json order. Every entry must name
 * a bundled Scenario, and a listed one must not also be featured; its
 * revision id is the one every Workspace seeds for that Scenario, computed
 * here from the bundled document.
 */
export const featuredScenarioDefinitionsFor = (config: {
  readonly source: unknown
  readonly listedSource: unknown
  readonly scenarios: ReadonlyArray<ScenarioDefinition>
}): ModuleFeaturedDefinitionCollection => {
  const scenarios = new Map(config.scenarios.map(scenario => [scenario.id, scenario]))
  const bundled = (kind: 'Featured' | 'Listed', id: string) => {
    const scenario = scenarios.get(id)
    if (scenario === undefined) throw new Error(`${kind} Scenario is not bundled: ${id}`)
    return {
      definition: { moduleId: 'world', type: 'world.scenario', id: scenario.id },
      revisionId: definitionRevisionIdFor(scenarioDefinitionSchema, scenario),
      title: scenario.title,
    }
  }
  const featured = featuredScenarioSourceSchema.parse(config.source)
  const featuredIds = new Set(featured.map(entry => entry.scenarioId))
  return moduleFeaturedDefinitionCollectionSchema.parse({
    definitions: featured.map(entry => ({
      ...bundled('Featured', entry.scenarioId),
      summary: entry.summary,
      about: entry.about,
      tags: entry.tags,
      previews: entry.previews.map(preview => ({
        ...preview,
        sources: preview.sources.map(source => ({ path: `${scenarioPreviewPath}${source.file}`, width: source.width })),
      })),
    })),
    listed: listedScenarioSourceSchema.parse(config.listedSource).map(entry => {
      if (featuredIds.has(entry.scenarioId)) throw new Error(`Listed Scenario is also featured: ${entry.scenarioId}`)
      return { ...bundled('Listed', entry.scenarioId), summary: entry.summary, tags: entry.tags }
    }),
  })
}

const readBundledJson = (file: string): unknown =>
  JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), file), 'utf8')) as unknown

export const builtinFeaturedScenarioDefinitions = featuredScenarioDefinitionsFor({
  source: readBundledJson('featured.json'),
  listedSource: readBundledJson('listed.json'),
  scenarios: builtinScenarioDefinitions,
})
