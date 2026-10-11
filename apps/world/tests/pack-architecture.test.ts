import { describe,expect,test } from 'bun:test'
import { geoPointFromLonLat,nowIso,type AdapterId,type ObjectId,type OperationalObject,type PackId } from '../src/core/model/index.ts'
import { createActivePackViews } from '../src/core/packs/active-views.ts'
import { createPackPresentationComposer } from '../src/core/packs/presentation-composer.ts'
import { packField,packStatus } from '../src/core/packs/presentation.ts'
import { createWorldPackDescriptor,emptyPackScenarioConfigSchema,type PackObjectPresentation,type WorldPack } from '../src/core/packs/protocol.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { weatherPack } from '../src/packs/weather/pack.ts'
import { weatherSimRuntimeId } from '../src/packs/weather/sim/constants.ts'
import { fixturePack,fixturePackId,fixtureRuntimeId } from './fixtures/fixture-pack.ts'
import { responseScenario } from './fixtures/scenarios.ts'

describe('pack architecture', () => {
  test('active Pack views reject ambiguous surfaces without inventing a composite Pack', () => {
    expect(() => createActivePackViews([fixturePack, fixturePack])).toThrow('duplicate Pack ids')

    const activeViews = createActivePackViews([fixturePack, weatherPack])

    expect(activeViews.creation?.createObjectTypes.map(type => type.id).sort()).toEqual([
      'weather_area',
      'weather_probe',
    ].sort())
    expect(() => activeViews.creation?.defaultObjectLabel('missing', { objects: [] })).toThrow('unknown create object type')
  })

  test('active Pack contextual fields are detail-tier only so map and rail summaries stay cheap', () => {
    const at = nowIso()
    const object: OperationalObject = {
      id: 'object:contextual-field-target' as ObjectId,
      kind: 'facility',
      packId: 'base-pack' as PackId,
      label: 'Contextual field target',
      lifecycle: 'active',
      revision: 0,
      spatial: {
        position: {
          point: geoPointFromLonLat(10, 59),
          observedAt: at,
        },
        frame: { kind: 'wgs84' },
      },
      operational: {
        status: 'nominal',
        priority: 'normal',
        mode: 'simulated',
      },
      alerts: [],
      provenance: {
        source: 'simulator',
        adapterId: 'adapter:test' as AdapterId,
        externalId: 'object:contextual-field-target',
      },
      timestamps: {
        createdAt: at,
        updatedAt: at,
      },
      packData: {},
    }
    let contextualFieldCalls = 0
    const basePack: WorldPack = {
      descriptor: createWorldPackDescriptor({
        id: 'base-pack', version: '1.0.0', name: 'Base Pack', description: 'Test Pack.', contributions: ['presentation'],
      }),
      scenarioConfigSchema: emptyPackScenarioConfigSchema,
      presentation: {
        categories: [{ id: 'base', label: 'Base', emptyLabel: 'No base objects', matches: candidate => candidate.packId === 'base-pack' }],
        presentObject: (): PackObjectPresentation => ({
          categoryId: 'base',
          icon: 'grid',
          color: '#64748b',
          summary: 'base',
          status: packStatus('ready', 'Ready'),
          fields: [packField('base', 'Base', 'yes')],
        }),
      },
    }
    const enrichmentPack: WorldPack = {
      ...basePack,
      descriptor: createWorldPackDescriptor({
        id: 'enrichment-pack', version: '1.0.0', name: 'Enrichment Pack', description: 'Test Pack.', contributions: ['presentation'],
      }),
      presentation: {
        ...basePack.presentation,
        categories: [],
        contextualFields: () => {
          contextualFieldCalls += 1
          return [packField('contextual', 'Contextual', 'yes')]
        },
      },
    }
    const activeViews = createActivePackViews([basePack, enrichmentPack])

    const summaryPresentation = activeViews.presentation.presentObject(object, { objects: [object] })
    expect(contextualFieldCalls).toBe(0)
    expect(summaryPresentation.fields.map(field => field.key)).toEqual(['base'])

    const mapPresentation = activeViews.presentation.presentObject(object, {
      objects: [object],
      tier: 'map',
    })
    expect(contextualFieldCalls).toBe(0)
    expect(mapPresentation.fields.map(field => field.key)).toEqual(['base'])

    const detailPresentation = activeViews.presentation.presentObject(object, {
      objects: [object],
      tier: 'detail',
    })
    expect(contextualFieldCalls).toBe(1)
    expect(detailPresentation.fields.map(field => field.key)).toEqual(['base', 'contextual'])
  })

  test('active Pack views aggregate map-area feature activation layers once', () => {
    const packWithWeatherLayer: WorldPack = {
      ...fixturePack,
      descriptor: createWorldPackDescriptor({
        id: 'weather-layer-one', version: '1.0.0', name: 'Weather Layer One', description: 'Test Pack.', contributions: ['presentation'],
      }),
      presentation: { ...fixturePack.presentation, categories: [], mapFeatureLayers: ['weather'] },
    }
    const secondPackWithWeatherLayer: WorldPack = {
      ...weatherPack,
      descriptor: createWorldPackDescriptor({
        id: 'weather-layer-two', version: '1.0.0', name: 'Weather Layer Two', description: 'Test Pack.', contributions: ['presentation'],
      }),
      presentation: { ...weatherPack.presentation, categories: [], mapFeatureLayers: ['weather'] },
    }

    const activeViews = createActivePackViews([packWithWeatherLayer, secondPackWithWeatherLayer])

    expect(activeViews.presentation.mapFeatureLayers).toEqual(['weather'])
  })

  test('presentation composer caches by tier and exposes pack object indexes', () => {
    let presentCalls = 0
    let indexedWeatherObjectCount = -1
    const object = responseScenario.initialObjects.find(candidate => candidate.packId === fixturePackId)
    if (!object) throw new Error('scenario missing fixture object')
    const weatherObject = {
      ...object,
      id: 'weather:indexed-presenter' as ObjectId,
      packId: 'weather' as PackId,
    }
    const objects = [object, weatherObject]
    const currentTime = nowIso()
    const pack: WorldPack = {
      descriptor: createWorldPackDescriptor({
        id: fixturePackId, version: '1.0.0', name: 'Indexed Presenter', description: 'Test Pack.', contributions: ['presentation'],
      }),
      scenarioConfigSchema: emptyPackScenarioConfigSchema,
      presentation: {
        categories: [{
          id: 'units',
          label: 'Units',
          emptyLabel: 'No units',
          matches: candidate => candidate.id === object.id,
        }],
        presentObject: (_candidate, context): PackObjectPresentation => {
          presentCalls += 1
          indexedWeatherObjectCount = context.objectsForPack?.('weather').length ?? -1
          return {
            categoryId: 'units',
            icon: 'square',
            color: '#16834f',
            summary: context.tier ?? 'summary',
            fields: [packField('tier', 'Tier', context.tier ?? 'summary')],
          }
        },
      },
    }
    const activeViews = createActivePackViews([pack])
    const composer = createPackPresentationComposer({
      getContext: () => ({
        pack: activeViews,
        objects,
        currentTime,
      }),
      nowMs: () => 0,
    })

    expect(composer.present(object).summary).toBe('summary')
    expect(composer.present(object).summary).toBe('summary')
    expect(composer.present(object, { tier: 'map' }).summary).toBe('map')
    expect(presentCalls).toBe(2)
    expect(indexedWeatherObjectCount).toBe(1)
    expect(composer.diagnostics().tiers.summary.cacheHits).toBe(1)
    expect(composer.diagnostics().tiers.map.cacheMisses).toBe(1)
    composer.reset()
    expect(composer.diagnostics().cacheSize).toBe(0)
    expect(composer.diagnostics().tiers.summary.calls).toBe(0)
  })

  test('weather inspection reads the authoritative runtime instead of reconstructing conditions in the browser', () => {
    const object = responseScenario.initialObjects.find((candidate) => candidate.packId === fixturePackId)!
    const requests = weatherPack.presentation.contextualFieldQueries?.(object) ?? []
    expect(requests.map((request) => request.capabilityId)).toEqual(['world.weather.sample-at-point'])
    expect(requests[0]?.input).toEqual({ point: object.spatial.position?.point })
    expect(weatherPack.presentation.contextualFields).toBeUndefined()
  })

  test('scenario catalog resolves scenario packs to internal pack runtimes', () => {
    const catalog = createScenarioRuntimeResolver({
      packs: [fixturePack, weatherPack],
    })
    const runtime = catalog.resolve(responseScenario)

    expect(runtime.scenario.packs).toEqual(['fixture', 'weather'])
    expect(runtime?.runtimes.map(runtime => runtime.runtimeId).sort()).toEqual([
      fixtureRuntimeId,
      weatherSimRuntimeId,
    ].sort())
    expect(runtime?.runtimeConfigByRuntimeId).toEqual({
      [fixtureRuntimeId]: fixturePack.scenarioConfigSchema.parse({}),
      [weatherSimRuntimeId]: weatherPack.scenarioConfigSchema.parse({ gridResolution: 8 }),
    })
  })

  test('keeps runtime-free Packs active without inventing no-op runtimes', () => {
    const passivePack: WorldPack = {
      descriptor: createWorldPackDescriptor({
        id: 'passive', version: '1.0.0', name: 'Passive', description: 'Test Pack.', contributions: ['presentation'],
      }),
      scenarioConfigSchema: emptyPackScenarioConfigSchema,
      presentation: {
        categories: [],
        presentObject: () => { throw new Error('passive Pack does not own objects') },
      },
    }
    const scenario = {
      ...responseScenario,
      id: 'passive-only',
      title: 'Passive only',
      packs: ['passive'],
      packRuntimes: {},
      packConfigs: {},
      recording: [],
      initialObjects: [],
      view: { ...responseScenario.view, rail: { sections: [] } },
    }
    const runtime = createScenarioRuntimeResolver({ packs: [passivePack] }).resolve(scenario)

    expect(runtime?.packs).toEqual([passivePack])
    expect(runtime?.runtimes).toEqual([])
  })

  test('scenario catalog rejects runtime selections outside the owning Pack', () => {
    expect(() => createScenarioRuntimeResolver({
      packs: [fixturePack, weatherPack],
    }).resolve({
        ...responseScenario,
        id: 'bad-runtime-override',
        packRuntimes: {
          fixture: weatherSimRuntimeId,
        },
    })).toThrow('runtime weather.local is not registered by pack fixture')
  })
})
