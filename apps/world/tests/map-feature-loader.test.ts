import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SimulationRunId, IsoTimestamp, OperationalObject } from '../src/core/model/index.ts'
import { geoPointFromLonLat } from '../src/core/model/index.ts'
import {
  createWorldPackDescriptor,
  emptyPackScenarioConfigSchema,
  type WorldPack,
  type PackMapFeature,
  type PackMapFeatureQuery,
} from '../src/core/packs/protocol.ts'
import { createMapFeatureLoader } from '../src/ui/app/map-feature-loader.ts'
import type { SimulationRunRequestOptions } from '../src/ui/simulation-run-client.ts'
import { createActivePackViews } from '../src/core/packs/active-views.ts'

const generatedAt = '2026-05-30T00:00:00.000Z' as IsoTimestamp

const viewport = {
  type: 'Polygon',
  coordinates: [[
    geoPointFromLonLat(10, 59).coordinates,
    geoPointFromLonLat(11, 59).coordinates,
    geoPointFromLonLat(11, 60).coordinates,
    geoPointFromLonLat(10, 60).coordinates,
    geoPointFromLonLat(10, 59).coordinates,
  ]],
} as const

const featureFor = (id: string): PackMapFeature => ({
  id,
  categoryId: 'weather',
  geometry: viewport,
  color: '#2563eb',
  summary: id,
})

const delay = async (ms: number): Promise<void> => {
  await new Promise<void>(resolve => {
    setTimeout(resolve, ms)
  })
}

const createPack = (requests: ReadonlyArray<PackMapFeatureQuery>): WorldPack => ({
  descriptor: createWorldPackDescriptor({
    id: 'weather-test',
    version: '1.0.0',
    name: 'Weather Test',
    description: 'Test Pack.',
    contributions: ['presentation'],
  }),
  scenarioConfigSchema: emptyPackScenarioConfigSchema,
  presentation: {
    categories: [],
    mapFeatures: () => [featureFor('sync-feature')],
    mapFeatureQueries: () => requests,
    presentObject: () => ({
      categoryId: 'weather',
      icon: 'weather',
      color: '#2563eb',
      summary: '',
      fields: [],
      status: { tone: 'ready', label: 'Ready', indicator: { shape: 'dot' } },
    }),
  },
})

describe('MapFeatureLoader', () => {
  test('one failed pack does not erase healthy layers and truncation stays visible', async () => {
    let warnings: ReadonlyArray<string> = []
    let recovered = false
    const loader = createMapFeatureLoader({
      pack: () => createActivePackViews([createPack([{ capabilityId: 'world.weather-test.good', input: {} }, { capabilityId: 'world.weather-test.broken', input: {} }])]),
      objects: () => [], simulationRunId: () => 'run-test' as SimulationRunId, currentTime: () => generatedAt, seenRoleIds: () => null, selectedObjectId: () => null, dataRevision: () => 'r1',
      queryCapability: async (_id, request) => { if (!recovered && request.capabilityId === 'world.weather-test.broken') throw new Error('Test provider failed'); return { features: [featureFor('good')], truncated: !recovered } },
      onWarnings: messages => { warnings = messages },
    })
    expect((await loader({ viewport, zoom: 8 })).map(feature => feature.id)).toEqual(['sync-feature','good'])
    expect(warnings).toHaveLength(2); expect(warnings.join(' ')).toContain('coverage limited'); expect(warnings.join(' ')).toContain('Test provider failed')
    recovered = true
    await loader({ viewport, zoom: 12 })
    expect(warnings).toEqual([])
  })
  test('runs pack map-area queries concurrently and preserves sync features', async () => {
    const requests: ReadonlyArray<PackMapFeatureQuery> = [
      { capabilityId: 'world.weather-test.first', input: {} },
      { capabilityId: 'world.weather-test.second', input: {} },
    ]
    let activeQueries = 0
    let maxActiveQueries = 0
    const queryCapability = async (
      _simulationRunId: SimulationRunId,
      request: PackMapFeatureQuery,
      options?: SimulationRunRequestOptions,
    ): Promise<unknown> => {
      expect(options?.signal).toBeInstanceOf(AbortSignal)
      activeQueries += 1
      maxActiveQueries = Math.max(maxActiveQueries, activeQueries)
      await delay(10)
      activeQueries -= 1
      return { features: [featureFor(`query-feature:${request.capabilityId}`)] }
    }
    const loader = createMapFeatureLoader({
      pack: () => createActivePackViews([createPack(requests)]),
      objects: () => [],
      simulationRunId: () => 'run-test' as SimulationRunId,
      currentTime: () => generatedAt,
      seenRoleIds: () => null,
      selectedObjectId: () => null, dataRevision: () => 'r1',
      queryCapability,
      queryTimeoutMs: 500,
    })

    const features = await loader({ viewport, zoom: 8 })

    expect(maxActiveQueries).toBe(2)
    expect(features.map(feature => feature.id)).toEqual([
      'sync-feature',
      'query-feature:world.weather-test.first',
      'query-feature:world.weather-test.second',
    ])
  })
  test('hands a Pack\'s map features and map-area queries the roles a role Run\'s screen sees, and none in open mode', async () => {
    const asked: Array<readonly [string, ReadonlyArray<string> | undefined]> = []
    const seeing: WorldPack = {
      ...createPack([]),
      presentation: {
        ...createPack([]).presentation,
        mapFeatures: context => { asked.push(['features', context.seenRoleIds]); return context.seenRoleIds?.includes('group:a') === false ? [] : [featureFor('group-a-path')] },
        mapFeatureQueries: context => { asked.push(['queries', context.seenRoleIds]); return [{ capabilityId: 'world.weather-test.area', input: {} }] },
      },
    }
    let seen: ReadonlyArray<string> | null = null
    const loader = createMapFeatureLoader({
      pack: () => createActivePackViews([seeing]),
      objects: () => [],
      simulationRunId: () => 'run-test' as SimulationRunId,
      currentTime: () => generatedAt,
      seenRoleIds: () => seen,
      selectedObjectId: () => null, dataRevision: () => 'r1',
      queryCapability: async () => ({ features: [] }),
    })
    expect((await loader({ viewport, zoom: 8 })).map(feature => feature.id)).toEqual(['group-a-path'])
    seen = ['group:a', 'group:b']
    expect((await loader({ viewport, zoom: 8 })).map(feature => feature.id)).toEqual(['group-a-path'])
    seen = ['group:b']
    expect(await loader({ viewport, zoom: 8 })).toEqual([])
    expect(asked).toEqual([
      ['features', undefined], ['queries', undefined],
      ['features', ['group:a', 'group:b']], ['queries', ['group:a', 'group:b']],
      ['features', ['group:b']], ['queries', ['group:b']],
    ])
  })

  test('hands the object the map selects only to the map features of a Pack that follows the selection, never to another Pack or a query', async () => {
    const asked: Array<readonly [string, string | undefined]> = []
    const following: WorldPack = {
      ...createPack([]),
      presentation: { ...createPack([]).presentation, mapFeaturesFollowSelection: true, mapFeatures: context => { asked.push(['following', context.selectedObjectId]); return [] } },
    }
    const notFollowing: WorldPack = {
      ...createPack([]),
      descriptor: createWorldPackDescriptor({ id: 'other-test', version: '1.0.0', name: 'Other Test', description: 'Test Pack.', contributions: ['presentation'] }),
      presentation: {
        ...createPack([]).presentation,
        mapFeatures: context => { asked.push(['other', context.selectedObjectId]); return [] },
        mapFeatureQueries: context => { asked.push(['queries', context.selectedObjectId]); return [] },
      },
    }
    const views = createActivePackViews([following, notFollowing])
    expect(views.presentation.mapFeaturesFollowSelection).toBe(true)
    expect(createActivePackViews([notFollowing]).presentation.mapFeaturesFollowSelection).toBeUndefined()
    let selected: string | null = null
    const loader = createMapFeatureLoader({
      pack: () => views,
      objects: () => [],
      simulationRunId: () => 'run-test' as SimulationRunId,
      currentTime: () => generatedAt,
      seenRoleIds: () => null,
      selectedObjectId: () => selected,
      dataRevision: () => 'r1',
    })
    await loader({ viewport, zoom: 8 })
    selected = 'unit-1'
    await loader({ viewport, zoom: 8 })
    expect(asked).toEqual([
      ['following', undefined], ['other', undefined], ['queries', undefined],
      ['following', 'unit-1'], ['other', undefined], ['queries', undefined],
    ])
  })

  test('a selection change asks the Run nothing: the synchronous features redraw and the last query results stay; new objects or data ask again', async () => {
    let queries = 0
    let selected: string | null = null
    let objects: ReadonlyArray<OperationalObject> = []
    let revision = 'r1'
    const loader = createMapFeatureLoader({
      pack: () => createActivePackViews([createPack([{ capabilityId: 'world.weather-test.area', input: { layers: ['wind'] } }])]),
      objects: () => objects,
      simulationRunId: () => 'run-test' as SimulationRunId,
      currentTime: () => generatedAt,
      seenRoleIds: () => null,
      selectedObjectId: () => selected,
      dataRevision: () => revision,
      queryCapability: async () => { queries += 1; return { features: [featureFor(`area-${queries}`)] } },
    })
    expect((await loader({ viewport, zoom: 8 })).map(feature => feature.id)).toEqual(['sync-feature', 'area-1'])
    selected = 'drone-1'
    expect((await loader({ viewport, zoom: 8 })).map(feature => feature.id)).toEqual(['sync-feature', 'area-1'])
    selected = null
    expect((await loader({ viewport, zoom: 8 })).map(feature => feature.id)).toEqual(['sync-feature', 'area-1'])
    expect(queries).toBe(1)
    // The same selection again is a refresh for something else, such as the time: it asks.
    await loader({ viewport, zoom: 8 })
    expect(queries).toBe(2)
    selected = 'drone-1'
    objects = [...objects]
    await loader({ viewport, zoom: 8 })
    selected = null
    revision = 'r2'
    await loader({ viewport, zoom: 8 })
    expect(queries).toBe(4)
  })

  test('the World view passes the roles it sees, the object it selects and its data revision to the loader, and reloads Pack map features on a selection change only while a Pack follows it', () => {
    const route = readFileSync(join(import.meta.dir, '..', 'src', 'ui', 'routes', 'ControlSurfaceRoute.svelte'), 'utf8')
    expect(route).toMatch(/createMapFeatureLoader\(\{[^}]*seenRoleIds:\s*\(\)\s*=>\s*seenRoleIds,\s*selectedObjectId:\s*\(\)\s*=>\s*selectedControllerId,\s*dataRevision:\s*\(\)\s*=>\s*mapFeatureDataKey,/)
    expect(route).toMatch(/const\s+mapFeatureDataKey\s*=\s*\$derived\(JSON\.stringify\(\[perspectiveEpoch,\s*packDataRevisions,\s*seenRoleIds\]\)\)/)
    expect(route).toMatch(/const\s+mapFeaturesFollowSelection\s*=\s*\$derived\(activePack\?\.presentation\.mapFeaturesFollowSelection\s*===\s*true\)/)
    expect(route).toMatch(/const\s+mapFeatureRevisionKey\s*=\s*\$derived\(mapFeaturesFollowSelection\s*\?\s*JSON\.stringify\(\[mapFeatureDataKey,\s*selectedControllerId\]\)\s*:\s*mapFeatureDataKey\)/)
  })
})
