import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  moduleDefinitionCollectionSchema,
  moduleFeaturedDefinitionCollectionSchema,
  newWorkspaceId,
  type ModuleFeaturedDefinitionCollection,
} from '@leitbild/contracts'
import { createServer } from '../src/core/api/server.ts'
import { handleWorldFeaturedDefinitions, handleWorldModuleApi, worldModuleManifest } from '../src/core/api/workspace-module-api.ts'
import { createWorldModuleState } from '../src/core/workspaces/module-state.ts'
import { createWorldWorkspaceRuntimeRegistry, type WorldWorkspaceRuntimeRegistry } from '../src/core/workspaces/runtime-registry.ts'
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
const featuredFrom = (source: unknown): ModuleFeaturedDefinitionCollection =>
  featuredScenarioDefinitionsFor({ source, scenarios: builtinScenarioDefinitions })

describe('World featured Scenarios', () => {
  test('publishes the bundled featured list through a Workspace-independent manifest path', () => {
    expect(worldModuleManifest.endpoints.featuredDefinitions).toBe('/internal/featured-definitions')
    expect(moduleFeaturedDefinitionCollectionSchema.parse(builtinFeaturedScenarioDefinitions)).toEqual(builtinFeaturedScenarioDefinitions)
    const bundledIds = new Set(builtinScenarioDefinitions.map(scenario => scenario.id))
    for (const featured of builtinFeaturedScenarioDefinitions.definitions) expect(bundledIds.has(featured.definition.id)).toBe(true)
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

  test('rejects an entry whose Scenario is not bundled, a duplicate, and a preview that is not a plain WebP name', () => {
    expect(() => featuredFrom([{ ...entry, scenarioId: 'retired-scenario' }])).toThrow('Featured Scenario is not bundled: retired-scenario')
    expect(() => featuredFrom([entry, entry])).toThrow('duplicate featured Definition')
    const withFile = (file: string) => [{ ...entry, previews: [{ ...entry.previews[0]!, sources: [{ file, width: 800 }] }] }]
    for (const file of ['../agents/offsite.webp', 'offsite.png', 'Offsite.webp', 'nested/offsite.webp']) {
      expect(() => featuredFrom(withFile(file))).toThrow()
    }
  })

  test('names the exact revision a fresh Workspace lists for that Scenario', async () => {
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
    const listed = moduleDefinitionCollectionSchema.parse(await (await call(`/internal/workspaces/${workspaceId}/definitions`)).json())
      .definitions.find(definition => definition.ref.id === bundled.id)!
    const [featured] = featuredFrom([entry]).definitions
    const { workspaceId: _workspaceId, ...identity } = listed.ref
    expect(featured?.definition).toEqual(identity)
    expect(featured?.revisionId).toBe(listed.currentRevisionId)
  })

  test('serves the list from bundled memory without touching a Workspace runtime', async () => {
    const featured = featuredFrom([entry])
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
