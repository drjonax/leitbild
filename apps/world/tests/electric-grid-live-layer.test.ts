import { describe, expect, test } from 'bun:test'
import { norwayRuntimeTestOperatingPointRef } from './fixtures/grid-operating-point.ts'
import { expression, latest, validateStyleMin } from '@maplibre/maplibre-gl-style-spec'
import type { ActorId, CommandEnvelope, CommandId, IsoTimestamp, ObjectId, SimulationRunId } from '../src/core/model/index.ts'
import { layerIdsMatching } from '../src/core/packs/layer-id-glob.ts'
import type { PackLiveFeatureState, PackLiveMapLayerSpec } from '../src/core/packs/protocol.ts'
import type { PackMapTheme } from '../src/core/packs/reference-style.ts'
import { gridOpenBranchCommandKind } from '../src/packs/electric-grid/commands/branch.ts'
import { gridTripGeneratorCommandKind } from '../src/packs/electric-grid/commands/generator.ts'
import { gridTripHvdcCommandKind } from '../src/packs/electric-grid/commands/hvdc.ts'
import { gridDefinitionSchema } from '../src/packs/electric-grid/config.ts'
import { norwayGridModelRef, nordicFrequencyAutomationRef } from '../src/packs/electric-grid/definition-refs.ts'
import { compileGridDefinition } from '../src/packs/electric-grid/definitions.ts'
import { answerElectricGridQuery, electricGridQueryCapabilities } from '../src/packs/electric-grid/queries/index.ts'
import { createGridMapGeometry, createGridMapGeometryQuery } from '../src/packs/electric-grid/queries/map-geometry.ts'
import { createGridMapStateQuery } from '../src/packs/electric-grid/queries/map-state.ts'
import { applyGridCommand } from '../src/packs/electric-grid/runtime/apply-command.ts'
import { createGridRuntimeInstance, type GridRuntimeInstance } from '../src/packs/electric-grid/runtime/instance.ts'
import { advanceGrid } from '../src/packs/electric-grid/runtime/solver.ts'
import { electricGridPackView } from '../src/packs/electric-grid/ui-pack.ts'
import {
  gridAssetItemId,
  gridLiveLayerGroupId,
  gridLiveMapLayer,
  gridLiveStateLegend,
  gridOverviewPanelId,
  gridReferenceContextColor,
  parseGridAssetItemId,
} from '../src/packs/electric-grid/ui/grid-live-layer.ts'
import { gridMapPalette } from '../src/packs/electric-grid/ui/grid-map-palette.ts'
import { gridNorwayStyle } from '../src/packs/electric-grid/ui/grid-norway-style.ts'
import { recolorPaintValue } from '../src/ui/map-runtime/pack-live-layer.ts'
import { corridorDefinition, corridorModel, steppedGrid } from './fixtures/grid-corridor.ts'

const themes: ReadonlyArray<PackMapTheme> = ['light', 'dark']
const at = '2026-01-01T10:00:00.000Z' as IsoTimestamp
const specs = (theme: PackMapTheme): ReadonlyArray<PackLiveMapLayerSpec> => gridLiveMapLayer.layersFor({ theme })
const spec = (id: string, theme: PackMapTheme = 'light'): PackLiveMapLayerSpec => specs(theme).find(candidate => candidate.id === id)!

const containsToken = (value: unknown, token: string): boolean =>
  value === token || (Array.isArray(value) && value.some(item => containsToken(item, token)))

/** Evaluates one paint property the way MapLibre does, for a feature with properties and feature-state. */
const paintAt = (layer: PackLiveMapLayerSpec, property: string, zoom: number, properties: Record<string, unknown>, featureState: PackLiveFeatureState): unknown => {
  const specification = (latest as unknown as Record<string, Record<string, unknown>>)[`paint_${layer.type}`]![property]
  const compiled = expression.createPropertyExpression(layer.paint[property] as never, specification as never)
  if (compiled.result !== 'success') throw new Error(`${layer.id} ${property}: ${JSON.stringify(compiled.value)}`)
  return compiled.value.evaluate({ zoom } as never, { type: 2, properties } as never, featureState as never)
}

const rgb = (hex: string) => [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
const isColor = (value: unknown, hex: string): boolean => {
  const color = value as { r: number; g: number; b: number }
  const [r, g, b] = rgb(hex)
  return Math.abs(color.r - r!) < 0.01 && Math.abs(color.g - g!) < 0.01 && Math.abs(color.b - b!) < 0.01
}

const branchState = (overrides: Partial<Record<string, number | boolean>> = {}): PackLiveFeatureState =>
  ({ live: true, closed: true, energized: true, loading: 40, flowDir: 1, alarm: false, ...overrides })

describe('Grid live layer: MapLibre layers', () => {
  test('are a valid MapLibre style in both themes', () => {
    for (const theme of themes) {
      const errors = validateStyleMin({
        version: 8,
        glyphs: '/map/fonts/{fontstack}/{range}.pbf',
        sources: {
          features: { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, promoteId: 'fid' },
          labels: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
        },
        layers: specs(theme).map(layer => ({
          id: layer.id,
          type: layer.type,
          source: layer.source,
          ...(layer.minzoom === undefined ? {} : { minzoom: layer.minzoom }),
          ...(layer.filter === undefined ? {} : { filter: layer.filter }),
          ...(layer.layout === undefined ? {} : { layout: layer.layout }),
          paint: layer.paint,
        })),
      } as never)
      expect(errors.map(error => error.message)).toEqual([])
    }
  })

  test('never use a constant fractional line-opacity, and their line opacity is 0 or 1', () => {
    for (const layer of specs('light').filter(candidate => candidate.type === 'line')) {
      const opacity = layer.paint['line-opacity']
      if (typeof opacity === 'number') expect([0, 1]).toContain(opacity)
      else expect(containsToken(opacity, 'feature-state')).toBe(true)
      for (const zoom of [4, 5.5, 6, 9, 14]) {
        for (const kv of [132, 420]) {
          for (const alarm of [false, true]) expect([0, 1]).toContain(paintAt(layer, 'line-opacity', zoom, { kind: 'branch', kv }, branchState({ alarm })) as number)
        }
      }
    }
  })

  test('colour branches by loading, switching and energisation', () => {
    for (const theme of themes) {
      const line = spec('branch-line', theme)
      const color = (state: PackLiveFeatureState) => paintAt(line, 'line-color', 8, { kind: 'branch', kv: 420 }, state)
      const expected = theme === 'light'
        ? { normal: '#0f8b8d', watch: '#d99a00', high: '#ea580c', overload: '#d62828', open: '#6b7280', deenergized: '#c3c8cf' }
        : { normal: '#2dd4bf', watch: '#facc15', high: '#fb923c', overload: '#f87171', open: '#9ca3af', deenergized: '#4b5563' }
      expect(isColor(color(branchState({ loading: 69.9 })), expected.normal)).toBe(true)
      expect(isColor(color(branchState({ loading: 70 })), expected.watch)).toBe(true)
      expect(isColor(color(branchState({ loading: 90 })), expected.high)).toBe(true)
      expect(isColor(color(branchState({ loading: 100 })), expected.overload)).toBe(true)
      expect(isColor(color(branchState({ closed: false, loading: 100 })), expected.open)).toBe(true)
      expect(isColor(color(branchState({ energized: false })), expected.deenergized)).toBe(true)
    }
  })

  test('draw a tripped branch red and dashed, unlike a grey open one', () => {
    const line = spec('branch-line')
    const dashes = spec('branch-tripped')
    const tripped = branchState({ closed: false, tripped: true, loading: 0, alarm: true })
    const open = branchState({ closed: false, loading: 0, alarm: true })
    expect(isColor(paintAt(line, 'line-color', 8, { kind: 'branch', kv: 420 }, tripped), '#d62828')).toBe(true)
    expect(isColor(paintAt(line, 'line-color', 8, { kind: 'branch', kv: 420 }, open), '#6b7280')).toBe(true)
    // The casing-coloured dashes break only a tripped line, and stay visible with it below z6.
    expect(dashes.paint['line-dasharray']).toEqual([1.5, 1.5])
    expect(paintAt(dashes, 'line-opacity', 5, { kind: 'branch', kv: 132 }, tripped)).toBe(1)
    expect(paintAt(dashes, 'line-opacity', 8, { kind: 'branch', kv: 420 }, open)).toBe(0)
    expect(paintAt(line, 'line-opacity', 5, { kind: 'branch', kv: 132 }, tripped)).toBe(1)
  })

  test('draw HVDC links dashed in their own colour, grey while blocked and red when tripped, with flow arrows', () => {
    for (const theme of themes) {
      const line = spec('hvdc-line', theme)
      const color = (state: PackLiveFeatureState) => paintAt(line, 'line-color', 6, { kind: 'hvdc' }, { live: true, ...state })
      const expected = theme === 'light' ? { hvdc: '#4338ca', open: '#6b7280', tripped: '#d62828' } : { hvdc: '#a5b4fc', open: '#9ca3af', tripped: '#f87171' }
      expect(isColor(color({}), expected.hvdc)).toBe(true)
      expect(isColor(color({ blocked: true }), expected.open)).toBe(true)
      expect(isColor(color({ tripped: true }), expected.tripped)).toBe(true)
      expect(line.paint['line-dasharray']).toEqual([3, 1.5])
    }
    expect(paintAt(spec('flow-reverse'), 'icon-opacity', 8, { kind: 'hvdc' }, { live: true, flowDir: -1 })).toBe(1)
  })

  test('fill an HVDC-only boundary bus as a terminal, never as a hollow dead bus', () => {
    const buses = spec('buses')
    const terminal = { live: true, energized: false, external: true, island: -1, alarm: false }
    expect(paintAt(buses, 'circle-opacity', 5, { kind: 'bus' }, terminal)).toBe(0)
    expect(paintAt(buses, 'circle-opacity', 8, { kind: 'bus' }, terminal)).toBe(1)
    expect(isColor(paintAt(buses, 'circle-color', 8, { kind: 'bus' }, terminal), '#4338ca')).toBe(true)
    expect(paintAt(buses, 'circle-opacity', 8, { kind: 'bus' }, { ...terminal, external: false })).toBe(0)
  })

  test('below z6 show branches of 300 kV and above plus anything in alarm, so an overloaded 132 kV line is red at z5', () => {
    const line = spec('branch-line')
    const overloaded = branchState({ loading: 104, alarm: true })
    expect(paintAt(line, 'line-opacity', 5, { kind: 'branch', kv: 132 }, branchState())).toBe(0)
    expect(paintAt(line, 'line-opacity', 5, { kind: 'branch', kv: 300 }, branchState())).toBe(1)
    expect(paintAt(line, 'line-opacity', 5, { kind: 'branch', kv: 132 }, overloaded)).toBe(1)
    expect(isColor(paintAt(line, 'line-color', 5, { kind: 'branch', kv: 132 }, overloaded), '#d62828')).toBe(true)
    expect(paintAt(line, 'line-opacity', 6, { kind: 'branch', kv: 132 }, branchState())).toBe(1)
  })

  test('draw flow arrows per direction from feature-state, from z6', () => {
    const forward = spec('flow-forward')
    const reverse = spec('flow-reverse')
    expect(forward.minzoom).toBe(6)
    expect(forward.layout!['icon-image']).toBe('electric-grid:flow-arrow')
    expect(paintAt(forward, 'icon-opacity', 8, { kind: 'branch', kv: 420 }, branchState({ flowDir: 1 }))).toBe(1)
    expect(paintAt(forward, 'icon-opacity', 8, { kind: 'branch', kv: 420 }, branchState({ flowDir: -1 }))).toBe(0)
    expect(paintAt(reverse, 'icon-opacity', 8, { kind: 'branch', kv: 420 }, branchState({ flowDir: -1 }))).toBe(1)
    expect(paintAt(reverse, 'icon-opacity', 8, { kind: 'branch', kv: 420 }, branchState({ flowDir: 0 }))).toBe(0)
    expect(gridLiveMapLayer.imagesFor!({ theme: 'dark' }).map(image => image.id)).toEqual(['electric-grid:flow-arrow'])
  })

  test('size generators by √capacity, fill them by dispatch and stroke tripped units red', () => {
    const generators = spec('generators')
    const radius = (capacityMw: number) => paintAt(generators, 'circle-radius', 8, { kind: 'generator', capacityMw }, { live: true }) as number
    expect(radius(400) - 2).toBeCloseTo(2 * (radius(100) - 2), 6)
    expect(paintAt(generators, 'circle-opacity', 8, { kind: 'generator', capacityMw: 100 }, { live: true, dispatch: 1 })).toBeCloseTo(1, 6)
    expect(paintAt(generators, 'circle-opacity', 8, { kind: 'generator', capacityMw: 100 }, { live: true, dispatch: 0 })).toBeCloseTo(0.15, 6)
    expect(isColor(paintAt(generators, 'circle-stroke-color', 8, { kind: 'generator', capacityMw: 100 }, { live: true, tripped: true, alarm: true }), '#d62828')).toBe(true)
    const loads = spec('loads')
    expect(paintAt(loads, 'circle-opacity', 8, { kind: 'load' }, { live: true, shed: 0.4, energized: true })).toBeCloseTo(0.4, 6)
  })

  test('insert as interactive layers whose ids the Pack layer group toggles', () => {
    const ids = specs('light').map(layer => `live:${gridLiveMapLayer.id}:${encodeURIComponent('grid:norway')}:${layer.id}`)
    const group = electricGridPackView.presentation.mapLayerGroups!.find(candidate => candidate.id === gridLiveLayerGroupId)!
    expect(gridLiveMapLayer.layerGroupId).toBe(gridLiveLayerGroupId)
    expect(layerIdsMatching(ids, group.layerIdPattern)).toEqual(ids)
    expect(specs('light').filter(layer => layer.interactive).map(layer => layer.id)).toEqual(['branch-casing', 'branch-line', 'hvdc-casing', 'hvdc-line', 'buses', 'loads', 'generators'])
    expect(electricGridPackView.presentation.liveMapLayers).toEqual([gridLiveMapLayer])
    expect(electricGridPackView.presentation.mapLegends).toContain(gridLiveStateLegend)
  })
})

describe('Grid live layer: reference context', () => {
  test('mutes reference voltage colours toward the palette grey and keeps label text and halo', () => {
    for (const theme of themes) {
      const palette = gridMapPalette(theme)
      expect(gridReferenceContextColor(palette.text, { theme })).toBe(palette.text)
      expect(gridReferenceContextColor(palette.halo, { theme })).toBe(palette.halo)
      expect(gridReferenceContextColor(palette.voltage.kv420, { theme })).not.toBe(palette.voltage.kv420)
      for (const layer of gridNorwayStyle.layersFor({ theme })) {
        for (const [property, value] of Object.entries(layer.paint)) {
          if (property.endsWith('-color')) expect(() => recolorPaintValue(value, color => gridReferenceContextColor(color, { theme }))).not.toThrow()
        }
      }
    }
    expect(gridLiveMapLayer.referenceContext!.datasetIds).toEqual([gridNorwayStyle.datasetId])
  })
})

const norway = compileGridDefinition(gridDefinitionSchema.parse({
  id: 'grid:norway',
  model: { ref: norwayGridModelRef },
  operatingPoint: { ref: norwayRuntimeTestOperatingPointRef },
  automation: { ref: nordicFrequencyAutomationRef },
}))

/** The query result as the browser receives it: answered, validated by the Host, sent as JSON. */
const wire = (grid: GridRuntimeInstance, capabilityId: string): unknown => JSON.parse(JSON.stringify(
  electricGridQueryCapabilities.find(capability => capability.id === capabilityId)!.output.parse(answerElectricGridQuery({
    request: { capabilityId, input: { gridId: grid.definition.gridId } },
    grids: new Map([[grid.definition.gridId, grid]]),
  })),
))

const command = (grid: GridRuntimeInstance, kind: string, assetId: string): void => {
  const result = applyGridCommand(grid, {
    id: `command:${crypto.randomUUID()}` as CommandId,
    simulationRunId: 'run-grid-live' as SimulationRunId,
    actorId: 'actor:grid-live-test' as ActorId,
    kind,
    targetObjectIds: [grid.definition.gridId as ObjectId],
    payload: { assetId },
    issuedAt: at,
  } satisfies CommandEnvelope)
  if (!result.ok) throw new Error(result.reason)
  advanceGrid(grid, 0, at)
}

describe('Grid live layer: geometry and state from the map queries', () => {
  test('give every asset one stable feature id and a feature-state, and select assets both ways', () => {
    const grid = createGridRuntimeInstance({ definition: norway, at })
    advanceGrid(grid, 0, at)
    const geometry = gridLiveMapLayer.loadGeometry(wire(grid, 'world.electric-grid.map.geometry'))
    // Loads draw one marker per bus.
    const loadMarkers = new Set(norway.model.loads.map(load => load.busId)).size
    const assetCount = norway.model.buses.length + norway.model.branches.length + norway.model.generators.length + loadMarkers + norway.model.hvdcLinks.length
    expect(geometry.features.map(feature => feature.fid)).toEqual(Array.from({ length: assetCount }, (_, fid) => fid))
    for (const feature of geometry.features) {
      expect(Object.keys(feature.properties).every(key => ['kind', 'kv', 'capacityMw'].includes(key))).toBe(true)
      const selection = geometry.selectionFor(feature.fid)!
      expect(selection.panelId).toBe(gridOverviewPanelId)
      expect(parseGridAssetItemId(selection.itemId).gridId).toBe('grid:norway')
      expect(geometry.fidForSelection(selection)).toBe(feature.fid)
    }
    expect(geometry.fidForSelection({ panelId: gridOverviewPanelId, itemId: gridAssetItemId('grid:other', norway.model.buses[0]!.id) })).toBeNull()
    const rawState = wire(grid, 'world.electric-grid.map.state') as { islands: Array<{ energized: boolean }>; buses: { island: number[] } }
    const state = geometry.presentState(rawState)
    expect([...state.featureStates.keys()]).toEqual(geometry.features.map(feature => feature.fid))
    // At most 20 branch labels, and one per HVDC link.
    expect(state.labels.length).toBeLessThanOrEqual(20 + norway.model.hvdcLinks.length)
    // The largest energised island keeps the plain stroke, as do HVDC-only boundary buses outside the
    // AC network; every other island takes a categorical colour.
    const busesPerIsland = rawState.islands.map((_, island) => rawState.buses.island.filter(candidate => candidate === island).length)
    const mainIsland = busesPerIsland.indexOf(Math.max(...busesPerIsland.filter((_, island) => rawState.islands[island]!.energized)))
    const busFids = geometry.features.filter(feature => feature.properties.kind === 'bus').map(feature => feature.fid)
    busFids.forEach((fid, bus) => {
      const island = state.featureStates.get(fid)!.island as number
      if (rawState.buses.island[bus] === mainIsland || norway.index.asynchronousBoundaryBusIds.has(norway.model.buses[bus]!.id)) expect(island).toBe(-1)
      else expect(island).toBeGreaterThanOrEqual(0)
    })
    const branchCard = state.hoverCard(0)!
    expect(branchCard.title).toBe(norway.model.branches[0]!.label)
    const drawnAs = (branchId: string) => state.hoverCard(norway.model.branches.findIndex(branch => branch.id === branchId))!.fields.find(field => field.key === 'path')!.value
    // The first branch in id order is the curated Follo – Lambertseter equivalent; lines follow their mapped routes.
    expect(norway.model.branches[0]!.id).toBe('branch:curated-follo-lambertseter-47kv-equivalent')
    expect(drawnAs(norway.model.branches.find(branch => branch.kind === 'ac_line' && branch.id.startsWith('branch:osm-'))!.id)).toBe('Mapped route')
    expect(drawnAs('branch:curated-follo-lambertseter-47kv-equivalent')).toBe('Network equivalent (not a mapped line)')
    expect(drawnAs(norway.model.branches.find(branch => branch.id.startsWith('branch:transformer-'))!.id)).toBe('Transformer, drawn between its buses')
  })

  test('follow switching and trips, and label the most loaded closed branches', () => {
    const grid = createGridRuntimeInstance({ definition: norway, at })
    advanceGrid(grid, 0, at)
    const geometry = gridLiveMapLayer.loadGeometry(wire(grid, 'world.electric-grid.map.geometry'))
    const branchFid = norway.model.branches.findIndex(branch => branch.kind === 'ac_line' && branch.nominalKv === 420)
    const generatorFid = norway.model.branches.length + norway.model.buses.length
      + norway.model.generators.findIndex(generator => grid.generators.get(generator.id)!.state === 'online')
    command(grid, gridOpenBranchCommandKind, norway.model.branches[branchFid]!.id)
    command(grid, gridTripGeneratorCommandKind, geometry.selectionFor(generatorFid)!.itemId.split('#')[1]!)
    const state = geometry.presentState(wire(grid, 'world.electric-grid.map.state'))
    expect(state.featureStates.get(branchFid)).toMatchObject({ closed: false, flowDir: 0, alarm: true })
    expect(state.featureStates.get(generatorFid)).toMatchObject({ tripped: true, online: false, alarm: true })
    const loadings = state.labels.flatMap(label => {
      const loading = / (\d+) %$/.exec(label.properties.text as string)
      return loading === null ? [] : [Number(loading[1])]
    })
    expect(loadings).toEqual([...loadings].sort((left, right) => right - left))
    expect(loadings.every(loading => loading >= 70)).toBe(true)
  })

  test('show HVDC links with their transfer and trips, and HVDC-only boundary buses as terminals, not dead islands', () => {
    const grid = createGridRuntimeInstance({ definition: norway, at })
    advanceGrid(grid, 0, at)
    const geometry = gridLiveMapLayer.loadGeometry(wire(grid, 'world.electric-grid.map.geometry'))
    const hvdcStart = geometry.features.findIndex(feature => feature.properties.kind === 'hvdc')
    const nordlink = norway.model.hvdcLinks.findIndex(link => link.id === 'hvdc:nordlink')
    const nordlinkFid = hvdcStart + nordlink
    expect(geometry.selectionFor(nordlinkFid)!.itemId).toBe(gridAssetItemId('grid:norway', 'hvdc:nordlink'))
    expect(geometry.features[nordlinkFid]!.geometry.type).toBe('LineString')
    const before = geometry.presentState(wire(grid, 'world.electric-grid.map.state'))
    const transferMw = Math.round(grid.hvdcLinks.get('hvdc:nordlink')!.transferMw)
    expect(before.featureStates.get(nordlinkFid)).toMatchObject({ tripped: false, blocked: false, alarm: false, flowDir: Math.abs(transferMw) > 5 ? Math.sign(transferMw) : 0 })
    expect(before.labels.find(label => (label.properties.text as string).startsWith('NordLink '))!.properties.text)
      .toBe(`NordLink ${Math.abs(transferMw).toLocaleString()} MW ${transferMw >= 0 ? 'export' : 'import'}`)
    // DE, DK1, GB and NL reach Norway only by HVDC: their boundary buses are terminals, never dead islands.
    const busFid = (busId: string) => geometry.features.findIndex(feature => feature.properties.kind === 'bus') + norway.model.buses.findIndex(bus => bus.id === busId)
    for (const busId of ['bus:boundary-DE', 'bus:boundary-DK1', 'bus:boundary-GB', 'bus:boundary-NL']) {
      expect(before.featureStates.get(busFid(busId))).toMatchObject({ external: true, alarm: false, island: -1 })
      expect(before.hoverCard(busFid(busId))!.fields.map(field => field.key)).toEqual(['external', 'role'])
    }
    expect(before.featureStates.get(busFid('bus:boundary-SE3@420'))).toMatchObject({ external: false, energized: true })

    command(grid, gridTripHvdcCommandKind, 'hvdc:nordlink')
    const after = geometry.presentState(wire(grid, 'world.electric-grid.map.state'))
    expect(after.featureStates.get(nordlinkFid)).toMatchObject({ tripped: true, flowDir: 0, alarm: true })
    expect(after.labels.find(label => label.properties.text === 'NordLink tripped')!.properties.tone).toBe('alarm')
    const card = after.hoverCard(nordlinkFid)!
    expect(card.title).toBe('NordLink')
    expect(card.fields.find(field => field.key === 'state')!.value).toBe('Tripped by its converter protection: reset it, then deblock')
    expect(card.fields.find(field => field.key === 'path')!.value).toBe('Mapped cable route')
  })

  test('read a branch its protection tripped as tripped, distinct from one an operator opened', () => {
    // The test corridor with its direct line and B path open: the A path's relays trip it at once.
    const run = steppedGrid(corridorDefinition())
    run.advanceTo(10_000)
    expect(run.command(gridOpenBranchCommandKind, { assetId: 'branch:g-l' }).ok).toBe(true)
    expect(run.command(gridOpenBranchCommandKind, { assetId: 'branch:g-b' }).ok).toBe(true)
    run.advanceTo(12_000)
    expect(run.grid.branches.get('branch:g-a')!.state).toBe('tripped')
    // A hand-built model has no geometry artifact: it draws bus to bus.
    const geometryFor = createGridMapGeometry({ artifactFor: () => null, readArtifact: file => { throw new Error(`no artifact ${file}`) } })
    const answer = (query: ReturnType<typeof createGridMapStateQuery>): unknown => JSON.parse(JSON.stringify(query.capability.output.parse(
      query.answer({ gridId: run.grid.definition.gridId }, new Map([[run.grid.definition.gridId, run.grid]])))))
    const geometry = gridLiveMapLayer.loadGeometry(answer(createGridMapGeometryQuery(geometryFor)))
    const state = geometry.presentState(answer(createGridMapStateQuery(geometryFor)))
    const fid = (branchId: string) => corridorModel.branches.findIndex(branch => branch.id === branchId)
    expect(state.featureStates.get(fid('branch:g-a'))).toMatchObject({ closed: false, tripped: true, flowDir: 0, alarm: true })
    expect(state.featureStates.get(fid('branch:g-b'))).toMatchObject({ closed: false, tripped: false })
    const switching = (branchId: string) => state.hoverCard(fid(branchId))!.fields.find(field => field.key === 'switching')!.value
    expect(switching('branch:g-a')).toBe('Tripped by its protection: reset it, then close')
    expect(switching('branch:g-b')).toBe('Open')
    expect(state.labels.filter(label => label.properties.tone === 'alarm').map(label => label.properties.text)).toEqual(expect.arrayContaining(['branch:g-a tripped']))
    expect(state.labels.some(label => label.properties.text === 'branch:g-b tripped')).toBe(false)
  })

  test('reject a state for another geometry', () => {
    const grid = createGridRuntimeInstance({ definition: norway, at })
    advanceGrid(grid, 0, at)
    const geometry = gridLiveMapLayer.loadGeometry(wire(grid, 'world.electric-grid.map.geometry'))
    const state = wire(grid, 'world.electric-grid.map.state') as { geometryDigest: string }
    expect(gridLiveMapLayer.stateGeometryKey(state)).toBe(geometry.key)
    expect(() => geometry.presentState({ ...state, geometryDigest: '0'.repeat(64) })).toThrow('does not align with geometry')
  })
})
