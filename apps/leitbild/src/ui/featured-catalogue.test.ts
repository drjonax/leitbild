import { describe, expect, test } from 'bun:test'
import type { FeaturedDefinitionCatalog, ModuleFeaturedDefinition } from '@leitbild/contracts'
import {
  catalogueView, deepLinkedDemo, DEEP_LINK_NOT_FEATURED_TEXT, demoTagIcon, DEMOS_UNAVAILABLE_TEXT, FEATURED_PATH, NO_DEMOS_TEXT,
  readFeaturedCatalogue,
} from './featured-catalogue.ts'
import { fakeFetch, hostError, json } from './host-fetch-fake.test-support.ts'

// Test fixtures only: the product reads the Modules' own featured catalogue.
const KEY = 'world:halden-offsite-power-restoration'
const featured = (id = 'halden-offsite-power-restoration'): ModuleFeaturedDefinition => ({
  definition: { moduleId: 'world', type: 'world.scenario', id },
  revisionId: `revision-${'a'.repeat(32)}`,
  title: 'Halden: loss of offsite power',
  summary: 'Four simulated nuclear units lose their grid connection.',
  about: 'A fixture about text.',
  tags: ['Nuclear plant + grid', 'Desktop'],
  previews: [{ alt: 'The Halden map after the fault.', width: 1600, height: 1000, sources: [{ path: '/assets/world/scenario-previews/offsite.webp', width: 1600 }] }],
} as ModuleFeaturedDefinition)
const catalogue = (definitions: ReadonlyArray<ModuleFeaturedDefinition> = [featured()], world: 'ready' | 'failed' = 'ready') => ({
  modules: [
    world === 'ready'
      ? { moduleId: 'world', status: 'ready' }
      : { moduleId: 'world', status: 'failed', failure: { code: 'module_unavailable', message: 'World did not answer', retryable: true } },
    { moduleId: 'agents', status: 'ready' },
  ],
  definitions: world === 'ready' ? definitions : [],
})

describe('the featured catalogue on the Demos surfaces', () => {
  test('is read from the Modules’ endpoint, needs no Workspace, and is validated', async () => {
    const host = fakeFetch().on('GET', FEATURED_PATH, json(catalogue()))
    const read = await readFeaturedCatalogue(host.fetch)
    expect(read.definitions[0]?.title).toBe('Halden: loss of offsite power')
    expect(host.calls.map(call => `${call.method} ${call.path}`)).toEqual(['GET /api/featured-definitions'])
    const broken = fakeFetch().on('GET', FEATURED_PATH, json({ modules: [], definitions: [{ title: 'x' }] }))
    await expect(readFeaturedCatalogue(broken.fetch)).rejects.toThrow()
    const down = fakeFetch().on('GET', FEATURED_PATH, hostError(503, 'workspace_capacity_exceeded', 'full'))
    await expect(readFeaturedCatalogue(down.fetch)).rejects.toMatchObject({ status: 503 })
  })

  test('passes the caller’s abort signal', async () => {
    const host = fakeFetch().on('GET', FEATURED_PATH, json(catalogue()))
    const controller = new AbortController()
    await readFeaturedCatalogue(host.fetch, controller.signal)
    expect(host.calls[0]?.signal).toBe(controller.signal)
  })

  test('an empty catalogue says so honestly; a failed Module says demos are unavailable', () => {
    expect(catalogueView(catalogue([]) as FeaturedDefinitionCatalog)).toEqual({ demos: [], empty: NO_DEMOS_TEXT })
    expect(catalogueView(catalogue([], 'failed') as FeaturedDefinitionCatalog)).toEqual({ demos: [], empty: DEMOS_UNAVAILABLE_TEXT })
    expect(catalogueView(catalogue() as FeaturedDefinitionCatalog).demos).toHaveLength(1)
  })

  test('tag chips get a device, players, time or domain icon', () => {
    expect(['Nuclear plant + grid', 'Event at 2 min', 'Desktop', 'iPad or desktop', '1–2 players', '30 min'].map(demoTagIcon))
      .toEqual(['layers', 'clock', 'screen', 'tablet', 'users', 'clock'])
  })

  test('a deep link opens its demo, or the first one with a notice when it is unknown', () => {
    const demos = [featured('nordland-corridor-security'), featured()]
    expect(deepLinkedDemo(demos, KEY)).toEqual({ index: 1, notice: null })
    expect(deepLinkedDemo(demos, null)).toEqual({ index: 0, notice: null })
    expect(deepLinkedDemo(demos, 'world:gone')).toEqual({ index: 0, notice: DEEP_LINK_NOT_FEATURED_TEXT })
  })
})
