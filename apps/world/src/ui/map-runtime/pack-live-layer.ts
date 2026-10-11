import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'
import type { OperationalObject } from '../../core/model/index.ts'
import type {
  PackLiveFeatureState,
  PackLiveMapFeature,
  PackLiveMapGeometry,
  PackLiveMapHoverCard,
  PackLiveMapLayer,
  PackLiveMapLayerSpec,
  PackLiveMapReferenceContext,
  PackLiveMapState,
  PackMapFeatureQuery,
  PackMapFeatureSelection,
} from '../../core/packs/protocol.ts'
import type { PackMapAppearance, PackReferenceDatasetStyle } from '../../core/packs/reference-style.ts'
import { referenceLayerIdPrefix } from '../map/reference-layer-factory.ts'

// Generic renderer for Pack live map layers. Per source object it keeps one GeoJSON source
// (feature ids promoted from `fid`), a small label source, and the Pack's layers inserted
// below the base-map labels. Geometry is fetched once per geometry key; state is fetched only
// when the object's revision changes while the layer is shown and the page is visible, and
// only changed feature-state values reach MapLibre.

/** The MapLibre surface this renderer uses; tests drive it with a fake. */
export interface LiveMapPort {
  getStyle(): { readonly layers: ReadonlyArray<{ readonly id: string; readonly type: string }> }
  getSource(id: string): unknown
  addSource(id: string, source: { readonly type: 'geojson'; readonly data: GeoJSON.FeatureCollection; readonly promoteId?: string; readonly attribution?: string }): void
  removeSource(id: string): void
  getLayer(id: string): unknown
  addLayer(layer: Record<string, unknown>, beforeId?: string): void
  removeLayer(id: string): void
  setLayoutProperty(layerId: string, name: 'visibility', value: 'visible' | 'none'): void
  setPaintProperty(layerId: string, name: string, value: unknown): void
  setFeatureState(target: { readonly source: string; readonly id: number }, state: Readonly<Record<string, unknown>>): void
  removeFeatureState(target: { readonly source: string; readonly id?: number }, key?: string): void
  hasImage(id: string): boolean
  addImage(id: string, image: ImageData, options: { readonly pixelRatio: number }): void
  removeImage(id: string): void
  queryRenderedFeatures(point: { readonly x: number; readonly y: number }, options: { readonly layers: Array<string> }): ReadonlyArray<{ readonly id?: string | number | undefined; readonly source: string }>
  on(type: 'mousemove' | 'click', listener: (event: LiveMapPointerEvent) => void): void
  on(type: 'styledata', listener: () => void): void
  off(type: 'mousemove' | 'click', listener: (event: LiveMapPointerEvent) => void): void
  off(type: 'styledata', listener: () => void): void
}

const ports = new WeakMap<MapLibreMap, LiveMapPort>()

/** The port over a MapLibre map; one per map, so identity checks hold across syncs. */
export const maplibreLiveMapPort = (map: MapLibreMap): LiveMapPort => {
  const existing = ports.get(map)
  if (existing) return existing
  const port: LiveMapPort = {
    getStyle: () => map.getStyle(),
    getSource: id => map.getSource(id),
    addSource: (id, source) => { map.addSource(id, { ...source, data: source.data }) },
    removeSource: id => { map.removeSource(id) },
    getLayer: id => map.getLayer(id),
    addLayer: (layer, beforeId) => { map.addLayer(layer as unknown as Parameters<MapLibreMap['addLayer']>[0], beforeId) },
    removeLayer: id => { map.removeLayer(id) },
    setLayoutProperty: (layerId, name, value) => { map.setLayoutProperty(layerId, name, value) },
    // Paint values come from Pack styles, which MapLibre validates when they are set.
    setPaintProperty: (layerId, name, value) => { map.setPaintProperty(layerId, name as Parameters<MapLibreMap['setPaintProperty']>[1], value as Parameters<MapLibreMap['setPaintProperty']>[2]) },
    setFeatureState: (target, state) => { map.setFeatureState(target, state) },
    removeFeatureState: (target, key) => { map.removeFeatureState(target, key) },
    hasImage: id => map.hasImage(id),
    addImage: (id, image, options) => { map.addImage(id, image, options) },
    removeImage: id => { map.removeImage(id) },
    queryRenderedFeatures: (point, options) => map.queryRenderedFeatures([point.x, point.y], options),
    on: (type: 'mousemove' | 'click' | 'styledata', listener: (event: LiveMapPointerEvent) => void) => { map.on(type, listener) },
    off: (type: 'mousemove' | 'click' | 'styledata', listener: (event: LiveMapPointerEvent) => void) => { map.off(type, listener) },
  }
  ports.set(map, port)
  return port
}

export interface LiveMapPointerEvent {
  readonly point: { readonly x: number; readonly y: number }
  readonly lngLat: { readonly lng: number; readonly lat: number }
}

export interface PackLiveMapLayerBinding {
  readonly packId: string
  readonly layer: PackLiveMapLayer
}

export interface LiveMapHover extends PackLiveMapHoverCard {
  readonly lngLat: readonly [number, number]
}

export interface PackLiveLayerSyncInput {
  readonly map: LiveMapPort
  readonly bindings: ReadonlyArray<PackLiveMapLayerBinding>
  readonly objects: ReadonlyArray<OperationalObject>
  readonly appearance: PackMapAppearance
  /** Layer-group visibility as the layers panel holds it; absent groups use their default. */
  readonly groupVisible: (groupId: string) => boolean
  readonly referenceStyles: ReadonlyArray<PackReferenceDatasetStyle>
  /** The selected item per surface panel; selected features carry feature-state `selected`. */
  readonly selections: Readonly<Record<string, string | null>>
}

export interface PackLiveLayerControllerConfig {
  readonly query: (request: PackMapFeatureQuery, signal: AbortSignal) => Promise<unknown>
  readonly rasterize: (svg: string) => Promise<ImageData>
  readonly documentHidden: () => boolean
  readonly onSelect: (selection: PackMapFeatureSelection) => void
  readonly onHover: (hover: LiveMapHover | null) => void
  readonly onError: (message: string) => void
}

export interface PackLiveLayerController {
  readonly sync: (input: PackLiveLayerSyncInput) => void
  readonly destroy: () => void
}

/** Feature-state keys the renderer owns; Pack state mappers must not set them. */
const hoverKey = 'hover'
const selectedKey = 'selected'
const segmentPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
// Image ids are `<layer id>:<name>`, both lowercase segments.
const imagePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/
// Pack artwork is drawn at 2× and shown at half size, like Pack feature icons.
const imagePixelRatio = 2

export const liveLayerIdPrefix = 'live:'

const featureCollection = (features: ReadonlyArray<PackLiveMapFeature>): GeoJSON.FeatureCollection => ({
  type: 'FeatureCollection',
  features: features.map(feature => ({
    type: 'Feature',
    geometry: feature.geometry as unknown as GeoJSON.Geometry,
    properties: { ...feature.properties, fid: feature.fid },
  })),
})

/** The first base-map label: live layers sit above reference context and below map text. */
export const liveLayerAnchorId = (style: ReturnType<LiveMapPort['getStyle']>): string | undefined =>
  style.layers.find(layer => layer.type === 'symbol' && !layer.id.startsWith(referenceLayerIdPrefix) && !layer.id.startsWith(liveLayerIdPrefix))?.id

/** Same colours, muted: each colour literal in a paint value passes through `color`. */
export const recolorPaintValue = (value: unknown, color: (value: string) => string): unknown => {
  if (typeof value === 'string') return /^(#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\))$/i.test(value) ? color(value) : value
  if (Array.isArray(value)) return value.map(item => recolorPaintValue(item, color))
  return value
}

/** The feature-state changes that turn `previous` into `next`; null when nothing changed. */
export const featureStateChanges = (
  previous: PackLiveFeatureState | undefined,
  next: PackLiveFeatureState,
): { readonly set: Readonly<Record<string, number | boolean>>; readonly removed: ReadonlyArray<string> } | null => {
  const set: Record<string, number | boolean> = {}
  let changed = false
  for (const [key, value] of Object.entries(next)) {
    if (previous?.[key] === value) continue
    set[key] = value
    changed = true
  }
  const removed = previous === undefined ? [] : Object.keys(previous).filter(key => !(key in next))
  return changed || removed.length > 0 ? { set, removed } : null
}

interface Installation {
  readonly map: LiveMapPort
  readonly theme: PackMapAppearance['theme']
  readonly layerIds: ReadonlyArray<string>
  readonly interactiveLayerIds: ReadonlyArray<string>
}

interface Instance {
  readonly key: string
  readonly binding: PackLiveMapLayerBinding
  readonly objectId: string
  readonly sourceId: string
  readonly labelSourceId: string
  readonly layerIdPrefix: string
  geometry: PackLiveMapGeometry | null
  state: PackLiveMapState | null
  requestedRevision: number | null
  abort: AbortController | null
  installation: Installation | null
  installing: boolean
  applied: Map<number, PackLiveFeatureState>
  labelSignature: string
  selectedFid: number | null
  shown: boolean | null
}

const requireOwnCapability = (binding: PackLiveMapLayerBinding, request: PackMapFeatureQuery): PackMapFeatureQuery => {
  if (!request.capabilityId.startsWith(`world.${binding.packId}.`)) {
    throw new Error(`Pack ${binding.packId} live map layer ${binding.layer.id} uses foreign Capability ${request.capabilityId}`)
  }
  return request
}

const validateSpecs = (layer: PackLiveMapLayer, specs: ReadonlyArray<PackLiveMapLayerSpec>): void => {
  const seen = new Set<string>()
  for (const spec of specs) {
    if (!segmentPattern.test(spec.id)) throw new Error(`live map layer ${layer.id} spec id ${spec.id} must be one lowercase segment`)
    if (seen.has(spec.id)) throw new Error(`live map layer ${layer.id} declares spec ${spec.id} twice`)
    seen.add(spec.id)
  }
}

const geoJsonSource = (map: LiveMapPort, sourceId: string): Pick<GeoJSONSource, 'setData'> => {
  const source = map.getSource(sourceId) as Partial<Pick<GeoJSONSource, 'setData'>> | undefined
  if (typeof source?.setData !== 'function') throw new Error(`live map source ${sourceId} is not a GeoJSON source`)
  return source as Pick<GeoJSONSource, 'setData'>
}

export const createPackLiveLayerController = (config: PackLiveLayerControllerConfig): PackLiveLayerController => {
  const instances = new Map<string, Instance>()
  const referenceMarks = new WeakMap<object, 'full' | 'context'>()
  let input: PackLiveLayerSyncInput | null = null
  let attachedMap: LiveMapPort | null = null
  let hovered: { readonly instance: Instance; readonly fid: number; readonly lngLat: readonly [number, number] } | null = null

  const groupShown = (instance: Instance): boolean => input !== null && input.groupVisible(instance.binding.layer.layerGroupId)
  /** Installed on this map in the current theme; a style reload drops the sources with the old style. */
  const installedOn = (instance: Instance, map: LiveMapPort): boolean =>
    instance.installation !== null
    && instance.installation.map === map
    && instance.installation.theme === input?.appearance.theme
    && map.getSource(instance.sourceId) !== undefined

  const report = (error: unknown): void => config.onError(error instanceof Error ? error.message : String(error))

  const showHoverCard = (): void => {
    const card = hovered?.instance.state?.hoverCard(hovered.fid) ?? null
    config.onHover(hovered === null || card === null ? null : { ...card, lngLat: hovered.lngLat })
  }

  const setHover = (next: typeof hovered): void => {
    const map = attachedMap
    if (hovered && map && installedOn(hovered.instance, map)) map.setFeatureState({ source: hovered.instance.sourceId, id: hovered.fid }, { [hoverKey]: false })
    hovered = next
    if (next && map) map.setFeatureState({ source: next.instance.sourceId, id: next.fid }, { [hoverKey]: true })
    showHoverCard()
  }

  const interactiveTargets = (map: LiveMapPort): { readonly layers: Array<string>; readonly bySource: Map<string, Instance> } => {
    const layers: string[] = []
    const bySource = new Map<string, Instance>()
    for (const instance of instances.values()) {
      if (!installedOn(instance, map) || !groupShown(instance)) continue
      layers.push(...instance.installation!.interactiveLayerIds)
      bySource.set(instance.sourceId, instance)
    }
    return { layers, bySource }
  }

  const featureAt = (event: LiveMapPointerEvent): { readonly instance: Instance; readonly fid: number } | null => {
    const map = attachedMap
    if (!map) return null
    const targets = interactiveTargets(map)
    if (targets.layers.length === 0) return null
    for (const feature of map.queryRenderedFeatures(event.point, { layers: targets.layers })) {
      const instance = targets.bySource.get(feature.source)
      if (instance && typeof feature.id === 'number') return { instance, fid: feature.id }
    }
    return null
  }

  const onMouseMove = (event: LiveMapPointerEvent): void => {
    const hit = featureAt(event)
    if (!hit) {
      if (hovered) setHover(null)
      return
    }
    if (hovered && hovered.instance === hit.instance && hovered.fid === hit.fid) return
    setHover({ ...hit, lngLat: [event.lngLat.lng, event.lngLat.lat] })
  }

  const onClick = (event: LiveMapPointerEvent): void => {
    const hit = featureAt(event)
    const selection = hit?.instance.geometry?.selectionFor(hit.fid) ?? null
    if (selection) config.onSelect(selection)
  }

  const referenceSpecs = new WeakMap<PackReferenceDatasetStyle, { readonly theme: string; readonly specs: ReturnType<PackReferenceDatasetStyle['layersFor']> }>()
  const applyReferenceContext = (): void => {
    const map = attachedMap
    if (!input || !map) return
    const appearance = input.appearance
    const contexts: PackLiveMapReferenceContext[] = []
    for (const instance of instances.values()) {
      const context = instance.binding.layer.referenceContext
      if (context && installedOn(instance, map) && groupShown(instance)) contexts.push(context)
    }
    for (const style of input.referenceStyles) {
      const context = contexts.find(candidate => candidate.datasetIds.includes(style.datasetId))
      const wanted = context ? 'context' : 'full'
      let cached = referenceSpecs.get(style)
      if (!cached || cached.theme !== appearance.theme) {
        cached = { theme: appearance.theme, specs: style.layersFor(appearance) }
        referenceSpecs.set(style, cached)
      }
      for (const spec of cached.specs) {
        const layerId = `${referenceLayerIdPrefix}${style.datasetId}:${spec.id}`
        const layer = map.getLayer(layerId)
        if (typeof layer !== 'object' || layer === null) continue
        // A freshly registered reference layer carries its full colours.
        if ((referenceMarks.get(layer) ?? 'full') === wanted) continue
        for (const [property, value] of Object.entries(spec.paint)) {
          if (!property.endsWith('-color')) continue
          map.setPaintProperty(layerId, property, context ? recolorPaintValue(value, color => context.color(color, appearance)) : value)
        }
        referenceMarks.set(layer, wanted)
      }
    }
  }

  const onStyleData = (): void => {
    try {
      applyReferenceContext()
    } catch (error) {
      report(error)
    }
  }

  const attach = (map: LiveMapPort): void => {
    if (attachedMap === map) return
    detach()
    attachedMap = map
    map.on('mousemove', onMouseMove)
    map.on('click', onClick)
    map.on('styledata', onStyleData)
  }

  const detach = (): void => {
    if (!attachedMap) return
    attachedMap.off('mousemove', onMouseMove)
    attachedMap.off('click', onClick)
    attachedMap.off('styledata', onStyleData)
    attachedMap = null
  }

  const applySelection = (instance: Instance, map: LiveMapPort): void => {
    if (!input || !instance.geometry) return
    let fid: number | null = null
    for (const [panelId, itemId] of Object.entries(input.selections)) {
      if (itemId === null) continue
      fid = instance.geometry.fidForSelection({ panelId, itemId })
      if (fid !== null) break
    }
    if (fid === instance.selectedFid) return
    if (instance.selectedFid !== null) map.setFeatureState({ source: instance.sourceId, id: instance.selectedFid }, { [selectedKey]: false })
    if (fid !== null) map.setFeatureState({ source: instance.sourceId, id: fid }, { [selectedKey]: true })
    instance.selectedFid = fid
  }

  /** Brings MapLibre's feature-state and labels in line with the instance's latest state. */
  const applyState = (instance: Instance, map: LiveMapPort): void => {
    const state = instance.state!
    for (const [fid, next] of state.featureStates) {
      if (hoverKey in next || selectedKey in next) throw new Error(`live map layer ${instance.binding.layer.id} sets reserved feature-state on ${fid}`)
      const changes = featureStateChanges(instance.applied.get(fid), next)
      if (changes === null) continue
      if (Object.keys(changes.set).length > 0) map.setFeatureState({ source: instance.sourceId, id: fid }, changes.set)
      for (const key of changes.removed) map.removeFeatureState({ source: instance.sourceId, id: fid }, key)
      instance.applied.set(fid, next)
    }
    for (const fid of [...instance.applied.keys()]) {
      if (state.featureStates.has(fid)) continue
      map.removeFeatureState({ source: instance.sourceId, id: fid })
      instance.applied.delete(fid)
    }
    const labelSignature = JSON.stringify(state.labels)
    if (labelSignature !== instance.labelSignature) {
      geoJsonSource(map, instance.labelSourceId).setData(featureCollection(state.labels))
      instance.labelSignature = labelSignature
    }
    applySelection(instance, map)
    if (hovered?.instance === instance) showHoverCard()
  }

  const setShown = (instance: Instance, map: LiveMapPort): void => {
    const shown = groupShown(instance)
    if (instance.shown === shown) return
    for (const layerId of instance.installation!.layerIds) map.setLayoutProperty(layerId, 'visibility', shown ? 'visible' : 'none')
    instance.shown = shown
    if (!shown && hovered?.instance === instance) setHover(null)
  }

  const removeFromMap = (instance: Instance): void => {
    const installation = instance.installation
    instance.installation = null
    instance.shown = null
    instance.selectedFid = null
    instance.applied = new Map()
    instance.labelSignature = ''
    if (!installation) return
    const map = installation.map
    for (const layerId of [...installation.layerIds].reverse()) if (map.getLayer(layerId) !== undefined) map.removeLayer(layerId)
    for (const sourceId of [instance.sourceId, instance.labelSourceId]) if (map.getSource(sourceId) !== undefined) map.removeSource(sourceId)
  }

  const install = async (instance: Instance): Promise<void> => {
    if (!input || instance.installing) return
    const { map, appearance } = input
    instance.installing = true
    try {
      removeFromMap(instance)
      const layer = instance.binding.layer
      const images = layer.imagesFor?.(appearance) ?? []
      for (const image of images) {
        if (!imagePattern.test(image.id) || !image.id.startsWith(`${layer.id}:`)) throw new Error(`live map layer ${layer.id} image ${image.id} must be named ${layer.id}:<name>`)
      }
      const rasterized = await Promise.all(images.map(async image => ({ id: image.id, data: await config.rasterize(image.svg) })))
      if (!input || input.map !== map || input.appearance.theme !== appearance.theme || instances.get(instance.key) !== instance) return
      for (const image of rasterized) {
        if (map.hasImage(image.id)) map.removeImage(image.id)
        map.addImage(image.id, image.data, { pixelRatio: imagePixelRatio })
      }
      const specs = layer.layersFor(appearance)
      validateSpecs(layer, specs)
      map.addSource(instance.sourceId, { type: 'geojson', data: featureCollection(instance.geometry!.features), promoteId: 'fid', attribution: layer.attribution })
      map.addSource(instance.labelSourceId, { type: 'geojson', data: featureCollection(instance.state!.labels) })
      instance.labelSignature = JSON.stringify(instance.state!.labels)
      const anchor = liveLayerAnchorId(map.getStyle())
      const layerIds: string[] = []
      const interactiveLayerIds: string[] = []
      for (const spec of specs) {
        const layerId = `${instance.layerIdPrefix}${spec.id}`
        map.addLayer({
          id: layerId,
          type: spec.type,
          source: spec.source === 'features' ? instance.sourceId : instance.labelSourceId,
          ...(spec.minzoom === undefined ? {} : { minzoom: spec.minzoom }),
          ...(spec.filter === undefined ? {} : { filter: spec.filter }),
          layout: { ...spec.layout, visibility: groupShown(instance) ? 'visible' : 'none' },
          paint: spec.paint,
        }, anchor)
        layerIds.push(layerId)
        if (spec.interactive === true) interactiveLayerIds.push(layerId)
      }
      instance.installation = { map, theme: appearance.theme, layerIds, interactiveLayerIds }
      instance.shown = groupShown(instance)
      applyState(instance, map)
      applyReferenceContext()
    } catch (error) {
      report(error)
    } finally {
      instance.installing = false
    }
  }

  const fetchState = async (instance: Instance, object: OperationalObject): Promise<void> => {
    const { binding } = instance
    instance.abort?.abort(new Error('superseded by a newer revision'))
    const controller = new AbortController()
    instance.abort = controller
    instance.requestedRevision = object.revision
    const query = (request: PackMapFeatureQuery): Promise<unknown> => config.query(requireOwnCapability(binding, request), controller.signal)
    try {
      const { layer } = binding
      let geometry = instance.geometry
      let stateResult: unknown
      if (geometry === null) {
        const [geometryResult, firstState] = await Promise.all([query(layer.geometryQuery(object)), query(layer.stateQuery(object))])
        geometry = layer.loadGeometry(geometryResult)
        stateResult = firstState
      } else {
        stateResult = await query(layer.stateQuery(object))
      }
      if (geometry.key !== layer.stateGeometryKey(stateResult)) {
        geometry = layer.loadGeometry(await query(layer.geometryQuery(object)))
        // The model can change between the two reads; one more state read realigns them.
        if (geometry.key !== layer.stateGeometryKey(stateResult)) stateResult = await query(layer.stateQuery(object))
      }
      const state = geometry.presentState(stateResult)
      if (controller.signal.aborted || instances.get(instance.key) !== instance) return
      const geometryChanged = geometry !== instance.geometry
      instance.geometry = geometry
      instance.state = state
      const map = input?.map
      if (!map) return
      if (!installedOn(instance, map) || geometryChanged) {
        await install(instance)
        return
      }
      applyState(instance, map)
    } catch (error) {
      if (controller.signal.aborted) return
      report(error)
    } finally {
      if (instance.abort === controller) instance.abort = null
    }
  }

  const teardown = (instance: Instance): void => {
    instance.abort?.abort(new Error('live map layer removed'))
    if (hovered?.instance === instance) setHover(null)
    removeFromMap(instance)
    instances.delete(instance.key)
  }

  const refresh = (instance: Instance, object: OperationalObject, map: LiveMapPort): void => {
    if (instance.geometry && instance.state && !installedOn(instance, map)) void install(instance)
    if (installedOn(instance, map)) {
      setShown(instance, map)
      applySelection(instance, map)
    }
    if (!groupShown(instance) || config.documentHidden()) return
    if (instance.requestedRevision === object.revision) return
    void fetchState(instance, object)
  }

  return {
    sync: next => {
      input = next
      attach(next.map)
      const wanted = new Map<string, { readonly binding: PackLiveMapLayerBinding; readonly object: OperationalObject }>()
      for (const binding of next.bindings) {
        if (!segmentPattern.test(binding.layer.id)) throw new Error(`live map layer id ${binding.layer.id} must be one lowercase segment`)
        for (const object of binding.layer.sourceObjects(next.objects)) wanted.set(`${binding.layer.id}|${object.id}`, { binding, object })
      }
      for (const instance of [...instances.values()]) {
        if (!wanted.has(instance.key) || wanted.get(instance.key)!.binding.layer !== instance.binding.layer) teardown(instance)
      }
      for (const [key, { binding, object }] of wanted) {
        let instance = instances.get(key)
        if (!instance) {
          const objectSegment = encodeURIComponent(object.id)
          instance = {
            key,
            binding,
            objectId: object.id,
            sourceId: `${liveLayerIdPrefix}${binding.layer.id}:${objectSegment}`,
            labelSourceId: `${liveLayerIdPrefix}${binding.layer.id}:${objectSegment}:labels`,
            layerIdPrefix: `${liveLayerIdPrefix}${binding.layer.id}:${objectSegment}:`,
            geometry: null,
            state: null,
            requestedRevision: null,
            abort: null,
            installation: null,
            installing: false,
            applied: new Map(),
            labelSignature: '',
            selectedFid: null,
            shown: null,
          }
          instances.set(key, instance)
        }
        refresh(instance, object, next.map)
      }
      applyReferenceContext()
    },
    destroy: () => {
      for (const instance of [...instances.values()]) teardown(instance)
      detach()
      input = null
    },
  }
}
