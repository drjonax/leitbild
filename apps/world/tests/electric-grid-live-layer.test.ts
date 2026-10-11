import { describe, expect, test } from 'bun:test'
import { norwayRuntimeTestOperatingPointRef } from './fixtures/grid-operating-point.ts'
import { expression, latest, validateStyleMin } from '@maplibre/maplibre-gl-style-spec'
import type { ActorId, CommandEnvelope, CommandId, IsoTimestamp, ObjectId, SimulationRunId } from '../src/core/model/index.ts'
import { layerIdsMatching } from '../src/core/packs/layer-id-glob.ts'
import type { PackLiveFeatureState, PackLiveMapLayerSpec } from '../src/core/packs/protocol.ts'
import type { PackMapTheme } from '../src/core/packs/reference-style.ts'
import { gridOpenBranchCommandKind } from '../src/packs/electric-grid/commands/branch.ts'
import { gridTripGeneratorCommandKind } from '../src/packs/electric-grid/commands/generator.ts'
import { gridDefinitionSchema } from '../src/packs/electric-grid/config.ts'
import { norwayGridModelRef, nordicFrequencyAutomationRef } from '../src/packs/electric-grid/definition-refs.ts'
import { compileGridDefinition } from '../src/packs/electric-grid/definitions.ts'
import { answerElectricGridQuery, electricGridQueryCapabilities } from '../src/packs/electric-grid/queries/index.ts'
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
    expect(specs('light').filter(layer => layer.interactive).map(layer => layer.id)).toEqual(['branch-casing', 'branch-line', 'buses', 'loads', 'generators'])
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
    const assetCount = norway.model.buses.length + norway.model.branches.length + norway.model.generators.length + loadMarkers
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
    expect(state.labels.length).toBeLessThanOrEqual(20)
    // The largest energised island keeps the plain stroke; every other island takes a categorical colour.
    const busesPerIsland = rawState.islands.map((_, island) => rawState.buses.island.filter(candidate => candidate === island).length)
    const mainIsland = busesPerIsland.indexOf(Math.max(...busesPerIsland.filter((_, island) => rawState.islands[island]!.energized)))
    const busFids = geometry.features.filter(feature => feature.properties.kind === 'bus').map(feature => feature.fid)
    busFids.forEach((fid, bus) => {
      const island = state.featureStates.get(fid)!.island as number
      if (rawState.buses.island[bus] === mainIsland) expect(island).toBe(-1)
      else expect(island).toBeGreaterThanOrEqual(0)
    })
    const branchCard = state.hoverCard(0)!
    expect(branchCard.title).toBe(norway.model.branches[0]!.label)
    expect(branchCard.fields.find(field => field.key === 'path')!.value).toBe('Mapped route')
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
    const loadings = state.labels.map(label => label.properties.loading as number)
    expect(loadings).toEqual([...loadings].sort((left, right) => right - left))
    expect(loadings.every(loading => loading >= 70)).toBe(true)
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
