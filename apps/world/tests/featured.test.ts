import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  moduleDefinitionCollectionSchema,
  moduleFeaturedDefinitionCollectionSchema,
  newWorkspaceId,
  type ModuleFeaturedDefinitionCollection,
} from '@leitbild/contracts'
import { definitionRevisionIdFor } from '@leitbild/module-runtime'
import { createServer } from '../src/core/api/server.ts'
import { handleWorldFeaturedDefinitions, handleWorldModuleApi, worldModuleManifest } from '../src/core/api/workspace-module-api.ts'
import { createWorldModuleState } from '../src/core/workspaces/module-state.ts'
import { createWorldWorkspaceRuntimeRegistry, type WorldWorkspaceRuntimeRegistry } from '../src/core/workspaces/runtime-registry.ts'
import { scenarioDefinitionSchema } from '../src/core/scenarios/definition.ts'
import { builtinScenarioDefinitions } from '../src/scenarios/definitions.ts'
import { builtinFeaturedScenarioDefinitions, featuredScenarioDefinitionsFor, scenarioPreviewPath } from '../src/scenarios/featured.ts'
import { createTestPackRuntimeAdapters, createTestScenarioRuntimeResolver, testScenarioAuthoring } from './helpers.ts'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const operation of cleanup.splice(0).reverse()) await operation()
})

const bundled = builtinScenarioDefinitions.find(scenario => scenario.id === 'halden-offsite-power-restoration')!
const entry = {
  scenarioId: bundled.id,
  summary: 'Four simulated nuclear units lose their grid connection.',
  about: 'A fault cuts four fictional units off the grid. Restore offsite power.',
  tags: ['Nuclear plant + grid', 'Desktop'],
  previews: [{
    alt: 'The grid map after the fault',
    width: 1600,
    height: 1000,
    sources: [{ file: 'offsite-800.0a1b2c3d.webp', width: 800 }, { file: 'offsite-1600.0a1b2c3d.webp', width: 1600 }],
  }],
}
const listedEntry = {
  scenarioId: 'halden-normal-operation',
  summary: 'Four simulated nuclear units run at full power; nothing is scripted.',
  tags: ['Nuclear plant + grid', 'No scripted faults'],
}
const featuredFrom = (source: unknown, listedSource: unknown = []): ModuleFeaturedDefinitionCollection =>
  featuredScenarioDefinitionsFor({ source, listedSource, scenarios: builtinScenarioDefinitions })

// Vite copies src/ui/public into the build unchanged, so a published preview
// path is a file under it.
const publicDir = join(import.meta.dir, '../src/ui/public')

// The pixel size a WebP file declares in its first chunk (lossy, lossless or
// extended), read from the RIFF header.
const webpSize = (bytes: Buffer): { readonly width: number; readonly height: number } => {
  expect(bytes.toString('ascii', 0, 4)).toBe('RIFF')
  expect(bytes.toString('ascii', 8, 12)).toBe('WEBP')
  const chunk = bytes.toString('ascii', 12, 16)
  if (chunk === 'VP8 ') return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
  if (chunk === 'VP8L') {
    const bits = bytes.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  expect(chunk).toBe('VP8X')
  return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 }
}

const words = (text: string): number => text.split(/\s+/).filter(Boolean).length
// A sentence ends in . ! or ? (optionally closed by a quote or bracket) before
// a space and a capital, so "4.4 GW" stays inside its sentence.
const sentences = (text: string): string[] => {
  const parts = text.split(/(?<=[.!?]["”’)]?)\s+(?=[A-Z“"])/)
  for (const part of parts) expect(part).toMatch(/[.!?]["”’)]?$/)
  return parts
}

// Phrases the newcomer copy never uses: over-claims, retired demos and
// internal plant ids, and speed-up factors such as "130×" (the speed-up
// depends on the model, so no factor is promised).
const bannedPhrases: ReadonlyArray<RegExp> = [
  /any question|anything about/i,
  /realistic/i,
  /(?<!not a )qualified/i,
  /(?<!not )certified/i,
  /live Norway/i,
  /Ambulance pack|halden-dispatch|halden-weather-response/i,
  /LD-01|SM-01/i,
  /\d+(?:\.\d+)?\s*[x×](?![a-z0-9])/i,
  /people decide/i,
  /stays under human control/i,
]

// Plain words for newcomers: no grid or plant jargon, no platform terms, and
// "simulation" rather than the defined term Run, which the demo copy never
// introduces.
const jargon: ReadonlyArray<RegExp> = [
  /busbar|switchyard|four-loop|LFDD|under-frequency|N-1|\bbus(?:es)?\b|\bbranch(?:es)?\b|\bLOOP\b/i,
  /Capabilit(?:y|ies)|\bRooms?\b|\bModules?\b/,
  /\b(?:a|the|this|that|your|each|both|every)\s+Runs?\b|\bRuns\b/,
]

describe('World featured Scenarios', () => {
  test('publishes the bundled featured list through a Workspace-independent manifest path', () => {
    expect(worldModuleManifest.endpoints.featuredDefinitions).toBe('/internal/featured-definitions')
    expect(moduleFeaturedDefinitionCollectionSchema.parse(builtinFeaturedScenarioDefinitions)).toEqual(builtinFeaturedScenarioDefinitions)
    const bundledIds = new Set(builtinScenarioDefinitions.map(scenario => scenario.id))
    for (const featured of builtinFeaturedScenarioDefinitions.definitions) expect(bundledIds.has(featured.definition.id)).toBe(true)
  })

  test('features the three curated demos in order, each titled by its bundled Scenario', () => {
    expect(builtinFeaturedScenarioDefinitions.definitions.map(featured => featured.definition.id)).toEqual([
      'halden-offsite-power-restoration',
      'nordland-corridor-security',
      'halden-emergency',
    ] as never)
    for (const featured of builtinFeaturedScenarioDefinitions.definitions) {
      const scenario = builtinScenarioDefinitions.find(candidate => candidate.id === featured.definition.id)!
      expect(featured.definition).toEqual({ moduleId: 'world', type: 'world.scenario', id: scenario.id } as never)
      expect(featured.title).toBe(scenario.title)
    }
  })

  test('keeps each demo\'s copy short, plain and free of banned phrases', () => {
    for (const featured of builtinFeaturedScenarioDefinitions.definitions) {
      const label = featured.definition.id
      expect({ label, sentences: sentences(featured.summary).length }).toEqual({ label, sentences: 1 })
      expect(words(featured.summary)).toBeLessThanOrEqual(25)
      const about = sentences(featured.about)
      expect(about.join(' ')).toBe(featured.about)
      expect(about.length).toBeGreaterThanOrEqual(3)
      expect(about.length).toBeLessThanOrEqual(4)
      expect(words(featured.about)).toBeLessThanOrEqual(80)
      // The last sentence says what the demo shows about Leitbild.
      expect(about.at(-1)).toMatch(/\bshows\b.*\bLeitbild/)
      for (const preview of featured.previews) {
        expect(preview.alt.length).toBeGreaterThan(0)
        expect(preview.alt.length).toBeLessThanOrEqual(140)
        expect(preview.alt.toLowerCase()).not.toContain(featured.title.toLowerCase())
      }
      const texts = [featured.summary, featured.about, ...featured.tags, ...featured.previews.map(preview => preview.alt)]
      for (const text of texts) {
        for (const pattern of [...bannedPhrases, ...jargon]) expect({ label, text, match: pattern.exec(text)?.[0] }).toEqual({ label, text, match: undefined })
      }
    }
  })

  test('serves every preview from a World asset whose name carries its content hash and whose pixels match its declared size', () => {
    for (const featured of builtinFeaturedScenarioDefinitions.definitions) {
      for (const preview of featured.previews) {
        for (const source of preview.sources) {
          expect(source.path.startsWith(scenarioPreviewPath)).toBe(true)
          const file = source.path.slice(scenarioPreviewPath.length)
          expect(file).toStartWith(`${featured.definition.id}-${source.width}.`)
          const bytes = readFileSync(join(publicDir, source.path))
          // A new capture gets a new name, so no browser keeps an old preview.
          const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 8)
          expect(file).toBe(`${featured.definition.id}-${source.width}.${hash}.webp`)
          expect(webpSize(bytes)).toEqual({ width: source.width, height: Math.round(source.width * preview.height / preview.width) })
          expect(bytes.byteLength).toBeLessThanOrEqual(200_000)
        }
        expect(preview.sources.map(source => source.width)).toContain(preview.width)
      }
    }
  })

  test('takes the title from the bundled Scenario and maps preview files into World assets', () => {
    const [featured] = featuredFrom([entry]).definitions
    expect(featured?.title).toBe(bundled.title)
    expect(featured?.definition).toEqual({ moduleId: 'world', type: 'world.scenario', id: bundled.id } as never)
    expect(featured?.previews[0]?.sources.map(source => source.path)).toEqual([
      `${scenarioPreviewPath}offsite-800.0a1b2c3d.webp`,
      `${scenarioPreviewPath}offsite-1600.0a1b2c3d.webp`,
    ])
    expect(() => featuredFrom([{ ...entry, title: 'Copied title' }])).toThrow()
  })

  test('lists three other Scenarios beside the demos in order, each titled by its bundled Scenario', () => {
    const featuredIds = new Set(builtinFeaturedScenarioDefinitions.definitions.map(featured => String(featured.definition.id)))
    expect(builtinFeaturedScenarioDefinitions.listed.map(listed => listed.definition.id)).toEqual([
      'halden-normal-operation',
      'nordic-frequency-event',
      'supply-run',
    ] as never)
    for (const listed of builtinFeaturedScenarioDefinitions.listed) {
      const scenario = builtinScenarioDefinitions.find(candidate => candidate.id === listed.definition.id)!
      expect(listed.definition).toEqual({ moduleId: 'world', type: 'world.scenario', id: scenario.id } as never)
      expect(listed.title).toBe(scenario.title)
      expect(featuredIds.has(String(listed.definition.id))).toBe(false)
    }
  })

  test('keeps each listed summary short, plain and free of banned phrases', () => {
    for (const listed of builtinFeaturedScenarioDefinitions.listed) {
      const label = listed.definition.id
      expect(listed.summary.length).toBeLessThanOrEqual(200)
      expect(sentences(listed.summary).join(' ')).toBe(listed.summary)
      for (const text of [listed.summary, ...listed.tags]) {
        for (const pattern of [...bannedPhrases, ...jargon]) expect({ label, text, match: pattern.exec(text)?.[0] }).toEqual({ label, text, match: undefined })
      }
    }
  })

  test('takes a listed title and revision from the bundled Scenario and rejects one that is not bundled, featured, long or untagged', () => {
    const quiet = builtinScenarioDefinitions.find(scenario => scenario.id === 'halden-normal-operation')!
    const [listed] = featuredFrom([entry], [listedEntry]).listed
    expect(listed).toEqual({
      definition: { moduleId: 'world', type: 'world.scenario', id: quiet.id },
      revisionId: definitionRevisionIdFor(scenarioDefinitionSchema, quiet),
      title: quiet.title,
      summary: listedEntry.summary,
      tags: listedEntry.tags,
    } as never)
    expect(() => featuredFrom([entry], [{ ...listedEntry, title: 'Copied title' }])).toThrow()
    expect(() => featuredFrom([entry], [{ ...listedEntry, scenarioId: 'retired-scenario' }])).toThrow('Listed Scenario is not bundled: retired-scenario')
    expect(() => featuredFrom([entry], [{ ...listedEntry, scenarioId: entry.scenarioId }])).toThrow(`Listed Scenario is also featured: ${entry.scenarioId}`)
    expect(() => featuredFrom([entry], [listedEntry, listedEntry])).toThrow('duplicate listed Definition')
    expect(() => featuredFrom([entry], [{ ...listedEntry, summary: 'x'.repeat(201) }])).toThrow()
    expect(() => featuredFrom([entry], [{ ...listedEntry, tags: [] }])).toThrow()
    expect(() => featuredFrom([entry], [{ ...listedEntry, tags: ['a', 'b', 'c'] }])).toThrow()
  })

  test('rejects an entry whose Scenario is not bundled, a duplicate, and a preview that is not a plain WebP name', () => {
    expect(() => featuredFrom([{ ...entry, scenarioId: 'retired-scenario' }])).toThrow('Featured Scenario is not bundled: retired-scenario')
    expect(() => featuredFrom([entry, entry])).toThrow('duplicate featured Definition')
    const withFile = (file: string) => [{ ...entry, previews: [{ ...entry.previews[0]!, sources: [{ file, width: 800 }] }] }]
    for (const file of ['../agents/offsite.webp', 'offsite.png', 'Offsite.webp', 'nested/offsite.webp']) {
      expect(() => featuredFrom(withFile(file))).toThrow()
    }
  })

  test('names the exact revision a fresh Workspace lists for each featured and listed Scenario', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'world-featured-'))
    const registry = createWorldWorkspaceRuntimeRegistry({
      dataDir,
      moduleState: createWorldModuleState({ dataDir }),
      scenarioRuntimeResolver: createTestScenarioRuntimeResolver(),
      ...testScenarioAuthoring(),
      scenarioDefinitions: builtinScenarioDefinitions,
      runtimeAdapters: createTestPackRuntimeAdapters(),
    })
    cleanup.push(() => rm(dataDir, { recursive: true, force: true }), () => registry.shutdown())
    const workspaceId = newWorkspaceId()
    const call = async (path: string, init?: RequestInit) => {
      const request = new Request(`http://world.test${path}`, init)
      return (await handleWorldModuleApi(request, new URL(request.url), registry))!
    }
    expect((await call(`/internal/workspaces/${workspaceId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId }),
    })).status).toBe(201)
    const listed = moduleDefinitionCollectionSchema.parse(await (await call(`/internal/workspaces/${workspaceId}/definitions`)).json()).definitions
    const { definitions: featuredList, listed: listedList } = builtinFeaturedScenarioDefinitions
    for (const featured of [...featuredList, ...listedList]) {
      const descriptor = listed.find(definition => definition.ref.id === featured.definition.id)!
      const { workspaceId: _workspaceId, ...identity } = descriptor.ref
      expect(featured.definition).toEqual(identity)
      expect(featured.revisionId).toBe(descriptor.currentRevisionId)
    }
  })

  test('serves the list from bundled memory without touching a Workspace runtime', async () => {
    const featured = featuredFrom([entry], [listedEntry])
    expect(featured.listed).toHaveLength(1)
    const route = handleWorldFeaturedDefinitions(
      new Request('http://world.test/internal/featured-definitions'),
      new URL('http://world.test/internal/featured-definitions'),
      featured,
    )
    expect(await route?.json()).toEqual(featured)

    const touched: string[] = []
    const workspaces = new Proxy({ shutdown: async () => undefined } as unknown as WorldWorkspaceRuntimeRegistry, {
      get: (target, key, receiver) => {
        if (key !== 'shutdown') touched.push(String(key))
        return Reflect.get(target, key, receiver)
      },
    })
    const uiDistPath = await mkdtemp(join(tmpdir(), 'world-featured-ui-'))
    const server = createServer({ workspaces, featuredDefinitions: featured, port: 0, bindHost: '127.0.0.1', uiDistPath, mapArtifacts: { rootDir: uiDistPath } })
    cleanup.push(() => rm(uiDistPath, { recursive: true, force: true }), () => server.stop())
    const response = await fetch(`http://127.0.0.1:${server.port}${worldModuleManifest.endpoints.featuredDefinitions}`)
    expect(response.status).toBe(200)
    expect(moduleFeaturedDefinitionCollectionSchema.parse(await response.json())).toEqual(featured)
    expect(touched).toEqual([])
  })
})
