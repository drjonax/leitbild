import { type GeoJSONSource, type LineLayerSpecification, type Map as MapLibreMap, type MapMouseEvent } from 'maplibre-gl'
import type { PackMapFeature } from '../../core/packs/protocol.ts'
import { loadMapSymbols, rasterizeSymbol } from './map-symbols.ts'

const sourceId = 'leitbild-pack-features'
const layerIds = ['leitbild-pack-fills', 'leitbild-pack-lines', 'leitbild-pack-points', 'leitbild-pack-symbols', 'leitbild-pack-dashed-lines']

/** The dash of a Pack line that asks for one (`lineDashed`), in line widths. */
export const packLineDash: ReadonlyArray<number> = [2, 2]

/** The source data for the visible Pack features, in draw order; a line that asks for a dash carries `dashed`. */
export const packFeatureCollection = (visible: ReadonlyArray<PackMapFeature>): GeoJSON.FeatureCollection => ({
  type: 'FeatureCollection',
  features: visible.map(feature => ({
    type: 'Feature',
    geometry: feature.geometry as unknown as GeoJSON.Geometry,
    properties: { id: feature.id, color: feature.color, opacity: feature.opacity ?? .1, lineColor: feature.lineColor ?? feature.color, lineOpacity: feature.lineOpacity ?? .5, lineWidth: feature.lineWidth ?? 1, dashed: feature.lineDashed === true, icon: feature.geometry.type === 'Point' && feature.symbol ? 'pack-icon:' + feature.symbol.icon : '', size: feature.symbol?.size ?? 1 },
  })),
})

/**
 * The two line layers: solid lines, and dashed ones in a layer of their own,
 * since a dash is no per-feature paint here. Both lie beneath the base map's
 * labels, and the deck overlay draws every operational icon above them.
 */
export const packLineLayers: ReadonlyArray<LineLayerSpecification> = [
  { id: layerIds[1]!, type: 'line', source: sourceId, filter: ['all', ['!=', ['geometry-type'], 'Point'], ['!=', ['get', 'dashed'], true]], paint: { 'line-color': ['get','lineColor'], 'line-width': ['get','lineWidth'], 'line-opacity': ['get','lineOpacity'] } },
  { id: layerIds[4]!, type: 'line', source: sourceId, filter: ['all', ['!=', ['geometry-type'], 'Point'], ['==', ['get', 'dashed'], true]], paint: { 'line-color': ['get','lineColor'], 'line-width': ['get','lineWidth'], 'line-opacity': ['get','lineOpacity'], 'line-dasharray': [...packLineDash] } },
]

/** One native map source for Pack geometry. Evidence remains a Pack record, not a fake operational object. */
export const createPackFeatureLayer = (onSelect: (selection: NonNullable<PackMapFeature['selection']>) => void, onError: (message: string) => void) => {
  let map: MapLibreMap | null = null
  let byId = new Map<string, PackMapFeature>()
  let signature = '', generation = 0, pending: Promise<void> | null = null
  let selectedId = ''
  let wantedIcons = new Set<string>()
  const registered = new Set<string>()
  const showRegisteredIcons = () => {
    if (map?.getLayer(layerIds[3]!)) map.setFilter(layerIds[3]!, ['all', ['==', ['geometry-type'], 'Point'], ['in', ['get', 'icon'], ['literal', [...registered].map(id => 'pack-icon:' + id)]]])
  }
  const syncIcons = () => {
    if (!map || pending) return
    const target = map, ticket = generation
    let reused = false
    for (const id of wantedIcons) if (target.hasImage('pack-icon:' + id) && !registered.has(id)) { registered.add(id); reused = true }
    if (reused) showRegisteredIcons()
    const missing = [...wantedIcons].filter(id => !target.hasImage('pack-icon:' + id))
    if (!missing.length) return
    pending = (async () => {
      try {
        const symbols = await loadMapSymbols(missing)
        for (const id of missing) {
          const svg = symbols.get(id)
          if (!svg) throw new Error('No map artwork for icon: ' + id)
          const image = await rasterizeSymbol(svg)
          if (map !== target || generation !== ticket || !target.getSource(sourceId)) return
          if (wantedIcons.has(id) && !target.hasImage('pack-icon:' + id)) {
            target.addImage('pack-icon:' + id, image, { pixelRatio: 2 })
            registered.add(id)
            showRegisteredIcons()
          }
        }
      } catch (error) { if (map === target) onError(String(error)) }
      finally {
        pending = null
        // A style or icon selection may have changed while artwork was loading.
        if (map && (generation !== ticket || [...wantedIcons].some(id => !missing.includes(id) && !map!.hasImage('pack-icon:' + id)))) syncIcons()
      }
    })()
  }
  const click = (event: MapMouseEvent) => {
    if (!map) return
    const selected = map.queryRenderedFeatures(event.point, { layers: layerIds.filter(id => map!.getLayer(id)) }).map(feature => byId.get(String(feature.properties.id))).find(feature => feature?.selection)
    if (selected?.selection) {
      selectedId = selected.id
      map.setPaintProperty(layerIds[1]!, 'line-width', ['case', ['==', ['get','id'], selectedId], ['+', ['get','lineWidth'], 2], ['get','lineWidth']])
      map.setPaintProperty(layerIds[2]!, 'circle-stroke-width', ['case', ['==', ['get','id'], selectedId], 4, 1])
      onSelect(selected.selection)
    }
  }
  const attach = (next: MapLibreMap) => {
    if (map === next) return
    map?.off('click', click)
    map = next; signature = ''; generation++; registered.clear(); map.on('click', click)
  }
  return {
    update(next: MapLibreMap, features: ReadonlyArray<PackMapFeature>, visibleLayers: ReadonlySet<string>) {
      attach(next)
      const visible = features.filter(feature => visibleLayers.has(feature.layerId ?? 'objects')).sort((a,b) => (a.sortKey ?? 0) - (b.sortKey ?? 0))
      byId = new Map(visible.map(feature => [feature.id, feature]))
      wantedIcons = new Set(visible.filter(feature => feature.geometry.type === 'Point' && feature.symbol).map(feature => feature.symbol!.icon))
      const data = packFeatureCollection(visible)
      const nextSignature = JSON.stringify(data)
      const source = next.getSource(sourceId) as GeoJSONSource | undefined
      if (source) {
        if (signature !== nextSignature) { source.setData(data); signature = nextSignature }
        const unused = [...registered].filter(id => !wantedIcons.has(id))
        for (const id of unused) registered.delete(id)
        if (unused.length) showRegisteredIcons()
        for (const id of unused) if (next.hasImage('pack-icon:' + id)) next.removeImage('pack-icon:' + id)
        syncIcons(); return
      }
      generation++; signature = nextSignature; registered.clear()
      next.addSource(sourceId, { type: 'geojson', data })
      const beforeLabels = next.getStyle().layers.find(layer => layer.type === 'symbol')?.id
      next.addLayer({ id: layerIds[0]!, type: 'fill', source: sourceId, filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': ['get','color'], 'fill-opacity': ['get','opacity'] } }, beforeLabels)
      for (const layer of packLineLayers) next.addLayer(layer, beforeLabels)
      next.addLayer({ id: layerIds[2]!, type: 'circle', source: sourceId, filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': ['case', ['!=', ['get','icon'], ''], 13, 6], 'circle-color': ['get','color'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 1, 'circle-opacity': .9 } })
      // Admit a symbol only once its artwork exists. A missing-image expression can
      // cache an empty result and never rediscover artwork registered asynchronously.
      next.addLayer({ id: layerIds[3]!, type: 'symbol', source: sourceId, filter: ['==', ['get', 'icon'], ''], layout: { 'icon-image': ['get','icon'], 'icon-size': ['*', .8, ['get','size']], 'icon-allow-overlap': true, 'icon-ignore-placement': true } })
      syncIcons()
    },
    destroy() { map?.off('click', click); map = null; generation++; byId.clear(); registered.clear(); wantedIcons.clear() },
  }
}
