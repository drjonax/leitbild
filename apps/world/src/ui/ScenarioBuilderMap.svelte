<script lang="ts">
  import 'maplibre-gl/dist/maplibre-gl.css'
  import { getWorkerUrl, Map as MapLibre, NavigationControl, setWorkerUrl, type GeoJSONSource, type Map as MapLibreMap, type MapMouseEvent } from 'maplibre-gl'
  import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
  import { runOnMount } from './svelte-lifecycle.svelte.ts'
  import type { ScenarioPreview } from '../core/scenarios/authoring-preview.ts'
  import { readMapView, type MapView } from './map-view.ts'

  interface BuilderPoint {
    readonly id: string
    readonly label: string
    readonly coordinates: readonly [number, number]
  }

  interface Props {
    readonly center: readonly [number, number]
    readonly zoom: number
    readonly points: ReadonlyArray<BuilderPoint>
    readonly assets?: ScenarioPreview['assets']
    readonly selectedId: string | null
    readonly placementActive: boolean
    readonly editView: boolean
    readonly onviewchange: (center: [number, number], zoom: number) => void
    readonly onplace: (coordinates: [number, number]) => void
    readonly onselect: (id: string) => void
    readonly onmapview?: (view: MapView) => void
  }

  const { center, zoom, points, assets = [], selectedId, placementActive, editView, onviewchange, onplace, onselect, onmapview = () => {} }: Props = $props()
  let element = $state<HTMLDivElement | null>(null)
  let map = $state<MapLibreMap | null>(null)
  let ready = $state(false)

  const data = () => ({
    type: 'FeatureCollection' as const,
    features: [...assets.flatMap(asset => asset.geometry && (asset.geometry.type !== 'Point' || !points.some(point => point.id === asset.id)) ? [{
      type: 'Feature' as const, id: asset.id, geometry: asset.geometry,
      properties: { id: asset.id, label: asset.label, selected: asset.id === selectedId },
    }] : []), ...points.map(point => ({
      type: 'Feature' as const,
      id: point.id,
      properties: { id: point.id, label: point.label, selected: point.id === selectedId },
      geometry: { type: 'Point' as const, coordinates: [...point.coordinates] },
    }))],
  })

  const updateSource = (): void => {
    const source = map?.getSource('scenario-items') as GeoJSONSource | undefined
    if (source) source.setData(data())
  }

  const handleClick = (event: MapMouseEvent): void => {
    if (!map) return
    if (placementActive) {
      onplace([event.lngLat.lng, event.lngLat.lat])
      return
    }
    const feature = map.queryRenderedFeatures(event.point, { layers: ['scenario-item-circles', 'scenario-item-areas'] })[0]
    const id = feature?.properties?.id
    if (typeof id === 'string') onselect(id)
  }

  runOnMount(() => {
    if (!element) return
    if (getWorkerUrl() !== maplibreWorkerUrl) setWorkerUrl(maplibreWorkerUrl)
    const instance = new MapLibre({
      container: element,
      style: '/map/style.json',
      center: [...center],
      zoom,
      attributionControl: { compact: true },
    })
    map = instance
    instance.addControl(new NavigationControl({ showCompass: false }), 'bottom-right')
    instance.on('load', () => {
      instance.addSource('scenario-items', { type: 'geojson', data: data() })
      instance.addLayer({ id: 'scenario-item-areas', type: 'fill', source: 'scenario-items', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#4188d8', 'fill-opacity': 0.22 } })
      instance.addLayer({ id: 'scenario-item-boundaries', type: 'line', source: 'scenario-items', filter: ['!=', ['geometry-type'], 'Point'], paint: { 'line-color': '#2162a8', 'line-width': 2 } })
      instance.addLayer({
        id: 'scenario-item-circles',
        type: 'circle',
        source: 'scenario-items',
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': ['case', ['get', 'selected'], 9, 7],
          'circle-color': ['case', ['get', 'selected'], '#f59e0b', '#1d66d2'],
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        },
      })
      instance.addLayer({
        id: 'scenario-item-labels',
        type: 'symbol',
        source: 'scenario-items',
        filter: ['==', ['geometry-type'], 'Point'],
        layout: {
          'text-field': ['get', 'label'],
          'text-size': 12,
          'text-offset': [0, 1.2],
          'text-anchor': 'top',
        },
        paint: { 'text-color': '#17202a', 'text-halo-color': '#ffffff', 'text-halo-width': 2 },
      })
      ready = true
      onmapview(readMapView(instance))
    })
    instance.on('click', handleClick)
    instance.on('moveend', () => {
      onmapview(readMapView(instance))
      if (!editView) return
      const next = instance.getCenter()
      onviewchange([...readMapView(instance).center], instance.getZoom())
    })
    const observer = new ResizeObserver(() => instance.resize())
    observer.observe(element)
    return () => {
      observer.disconnect()
      instance.remove()
      map = null
    }
  })

  $effect(() => {
    points
    assets
    selectedId
    ready
    updateSource()
  })
  $effect(() => {
    if (!ready || !map) return
    const current = map.getCenter()
    if (Math.abs(current.lng - center[0]) > 1e-8 || Math.abs(current.lat - center[1]) > 1e-8 || Math.abs(map.getZoom() - zoom) > 0.02) map.jumpTo({ center: [...center], zoom })
  })
</script>

<div class:placing={placementActive} class="scenario-builder-map" bind:this={element} aria-label="Scenario map"></div>
