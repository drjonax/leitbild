import type { Map as MapLibreMap } from 'maplibre-gl'

// Minimal ordered MapLibre style double for layer registration tests. Insertion
// follows MapLibre: `addLayer(spec, before)` places the layer directly below
// `before` and throws when `before` does not exist; a source cannot be removed
// while a layer uses it. `emit` stands in for MapLibre firing a map event.

export interface FakeStyleLayer {
  readonly id: string
  readonly type: string
  readonly source?: string
  readonly spec: Record<string, unknown>
  visibility: 'visible' | 'none'
}

export const leitbildBaseLayers: ReadonlyArray<{ readonly id: string; readonly type: string; readonly source?: string }> = [
  { id: 'background', type: 'background' },
  { id: 'overview-land', type: 'fill', source: 'world-overview' },
  { id: 'water', type: 'fill', source: 'leitbild-osm' },
  { id: 'road', type: 'line', source: 'leitbild-osm' },
  { id: 'boundary', type: 'line', source: 'leitbild-osm' },
  { id: 'poi-emergency', type: 'symbol', source: 'leitbild-osm' },
  { id: 'road-label', type: 'symbol', source: 'leitbild-osm' },
  { id: 'place-label', type: 'symbol', source: 'leitbild-osm' },
]

export const leitbildBaseMetadata = { 'leitbild:baseSources': ['leitbild-osm', 'world-overview'] }

export const createFakeMapStyle = (options: {
  readonly baseLayers?: ReadonlyArray<{ readonly id: string; readonly type: string; readonly source?: string }>
  readonly metadata?: unknown
} = {}) => {
  const layers: FakeStyleLayer[] = (options.baseLayers ?? leitbildBaseLayers).map(layer => ({
    ...layer,
    spec: { ...layer },
    visibility: 'visible',
  }))
  const sources = new Map<string, Record<string, unknown>>()
  const listeners = new Map<string, Set<(event: unknown) => void>>()
  const metadata = options.metadata === undefined ? leitbildBaseMetadata : options.metadata
  const map = {
    on: (type: string, listener: (event: unknown) => void) => {
      const forType = listeners.get(type) ?? new Set()
      forType.add(listener)
      listeners.set(type, forType)
    },
    off: (type: string, listener: (event: unknown) => void) => {
      listeners.get(type)?.delete(listener)
    },
    getStyle: () => ({ version: 8, metadata, layers: layers.map(layer => ({ ...layer.spec, id: layer.id, type: layer.type })) }),
    getLayer: (id: string) => layers.find(layer => layer.id === id),
    getSource: (id: string) => sources.get(id),
    addSource: (id: string, spec: Record<string, unknown>) => {
      if (sources.has(id)) throw new Error(`source ${id} exists`)
      sources.set(id, spec)
    },
    addLayer: (spec: Record<string, unknown> & { readonly id: string; readonly type: string; readonly source?: string }, before?: string) => {
      if (layers.some(layer => layer.id === spec.id)) throw new Error(`layer ${spec.id} exists`)
      const layout = spec.layout as Record<string, unknown> | undefined
      const visibility = layout?.visibility === 'none' ? 'none' : 'visible'
      const entry: FakeStyleLayer = { id: spec.id, type: spec.type, ...(spec.source === undefined ? {} : { source: spec.source }), spec, visibility }
      if (before === undefined) {
        layers.push(entry)
        return
      }
      const index = layers.findIndex(layer => layer.id === before)
      if (index < 0) throw new Error(`before layer ${before} does not exist`)
      layers.splice(index, 0, entry)
    },
    removeLayer: (id: string) => {
      const index = layers.findIndex(layer => layer.id === id)
      if (index < 0) throw new Error(`layer ${id} does not exist`)
      layers.splice(index, 1)
    },
    removeSource: (id: string) => {
      if (!sources.has(id)) throw new Error(`source ${id} does not exist`)
      const user = layers.find(layer => layer.source === id)
      if (user) throw new Error(`source ${id} is used by layer ${user.id}`)
      sources.delete(id)
    },
    getLayoutProperty: (id: string, property: string) => {
      const layer = layers.find(candidate => candidate.id === id)
      if (!layer) throw new Error(`layer ${id} does not exist`)
      return property === 'visibility' ? layer.visibility : (layer.spec.layout as Record<string, unknown> | undefined)?.[property]
    },
    setLayoutProperty: (id: string, property: string, value: unknown) => {
      const layer = layers.find(candidate => candidate.id === id)
      if (!layer) throw new Error(`layer ${id} does not exist`)
      if (property === 'visibility' && (value === 'visible' || value === 'none')) layer.visibility = value
    },
  }
  const emit = (type: string, event: unknown): void => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener(event)
  }
  return { map: map as unknown as MapLibreMap, layers, sources, emit, listenerCount: (type: string) => listeners.get(type)?.size ?? 0 }
}

export const layerOrder = (layers: ReadonlyArray<FakeStyleLayer>): ReadonlyArray<string> => layers.map(layer => layer.id)
