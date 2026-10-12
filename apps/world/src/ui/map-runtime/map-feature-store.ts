import type { GeoJsonPoint, OperationalObject } from '../../core/model/index.ts'
import { remainingRouteGeometry } from '../../core/model/index.ts'
import type { PackMapFeature, PackObjectPresentation } from '../../core/packs/protocol.ts'
import { colorWithAlpha, hexToRgba, toneColor, white } from './colors.ts'
import { symbolAtlasFor, symbolSizePx } from './symbol-kit.ts'
import {
  lineStringPositions,
  pointPosition,
  type MapFeatureProjectionContext,
  type OperationalPathFeature,
  type OperationalPointFeature,
  type OperationalRenderInput,
  type OperationalRenderSnapshot,
  type OperationalSymbolFeature,
  type Position2,
  type Position3,
  type RenderFamily,
} from './types.ts'

export interface MapFeatureStore {
  readonly update: (input: OperationalRenderInput) => OperationalRenderSnapshot
  readonly updateFamilies: (
    input: OperationalRenderInput,
    families: ReadonlySet<RenderFamily>,
  ) => OperationalRenderSnapshot
  readonly snapshot: () => OperationalRenderSnapshot
}

interface FamilyState<T extends { readonly id: string; readonly signature: string }> {
  readonly items: T[]
  readonly signatures: Map<string, string>
  revision: number
}

const createFamilyState = <T extends { readonly id: string; readonly signature: string }>(): FamilyState<T> => ({
  items: [],
  signatures: new Map(),
  revision: 0,
})

const idsMatch = <T extends { readonly id: string }>(
  left: ReadonlyArray<T>,
  right: ReadonlyArray<T>,
): boolean =>
  left.length === right.length && left.every((item, index) => item.id === right[index]?.id)

const syncFamily = <T extends { readonly id: string; readonly signature: string }>(
  family: FamilyState<T>,
  nextItems: ReadonlyArray<T>,
): void => {
  let changed = !idsMatch(family.items, nextItems)
  if (changed) {
    family.items.splice(0, family.items.length, ...nextItems)
    family.signatures.clear()
    for (const item of nextItems) family.signatures.set(item.id, item.signature)
    family.revision += 1
    return
  }
  for (let index = 0; index < nextItems.length; index += 1) {
    const next = nextItems[index]!
    if (family.signatures.get(next.id) === next.signature) continue
    family.items[index] = next
    family.signatures.set(next.id, next.signature)
    changed = true
  }
  if (changed) family.revision += 1
}

const pointOf = (object: OperationalObject): GeoJsonPoint | null =>
  object.spatial.position?.point ?? null

const rounded = (value: number, digits = 7): string =>
  value.toFixed(digits)

const positionSignature = (position: Position3): string =>
  `${rounded(position[0])},${rounded(position[1])},${rounded(position[2])}`

const pathSignature = (path: ReadonlyArray<Position2>): string =>
  `${path.length}:${path.map(point => `${rounded(point[0])},${rounded(point[1])}`).join('|')}`

const pointPriority = (
  object: OperationalObject,
  presentation: PackObjectPresentation,
): number => {
  if (presentation.status?.tone === 'error') return 90
  if (object.operational.priority === 'critical') return 85
  if (presentation.status?.tone === 'working') return 70
  if (object.kind === 'mobile_entity') return 60
  return 40
}

const presentationTone = (presentation: PackObjectPresentation): NonNullable<PackObjectPresentation['status']>['tone'] =>
  presentation.status?.tone ?? 'idle'

const operationalPointFor = (
  object: OperationalObject,
  presentation: PackObjectPresentation,
  context: MapFeatureProjectionContext,
): OperationalPointFeature | null => {
  const point = pointOf(object)
  if (!point) return null
  if (presentation.mapIconVisible === false) return null
  const tone = presentationTone(presentation)
  const symbolId = presentation.icon
  const symbolAtlas = symbolAtlasFor(symbolId)
  const label = presentation.mapLabel ?? null
  const position = pointPosition(point)
  const selected = object.id === context.selectedControllerId
  const highlighted = context.highlightedObjectIds.has(object.id)
  const hasNewInfo = presentation.noteworthyUpdates === true && context.hasNewInfo(object)
  const muted = presentation.muted === true || context.mutedObjectIds.has(object.id)
  const color = muted ? colorWithAlpha(hexToRgba(presentation.color), 132) : hexToRgba(presentation.color)
  const sizePx = presentation.mapIconSizePx ?? symbolSizePx(symbolId)
  const signature = [
    object.id,
    positionSignature(position),
    symbolId,
    sizePx.toFixed(2),
    presentation.color,
    tone,
    selected ? 's' : '',
    highlighted ? 'h' : '',
    hasNewInfo ? 'n' : '',
    muted ? 'm' : '',
    label ?? '',
  ].join(':')
  return {
    id: object.id,
    object,
    position,
    symbolId,
    symbolAtlas,
    label,
    color,
    statusTone: tone,
    selected,
    highlighted,
    hasNewInfo,
    muted,
    sizePx,
    rotationDeg: 0,
    priority: pointPriority(object, presentation),
    signature,
  }
}

const routePathFor = (
  object: OperationalObject,
  selectedObjectId: string | null,
): OperationalPathFeature | null => {
  const route = object.spatial.route?.planned
  if (object.kind !== 'mobile_entity' || !route) return null
  const point = pointOf(object)
  const geometry = point && object.spatial.route?.progress
    ? remainingRouteGeometry(route, point, object.spatial.route.progress.segmentIndex)
    : route
  if (!geometry) return null
  const path = lineStringPositions(geometry)
  const selected = object.id === selectedObjectId
  return {
    id: `route:${object.id}`,
    kind: 'route',
    path,
    color: selected ? hexToRgba('#1d66d2') : hexToRgba('#3977d6', 190),
    casingColor: white(184),
    widthPx: selected ? 3.8 : 2.8,
    selected,
    priority: selected ? 80 : 45,
    signature: `route:${object.id}:${selected ? '1' : '0'}:${pathSignature(path)}`,
  }
}

const lineObjectPathFor = (
  object: OperationalObject,
  presentation: PackObjectPresentation,
): OperationalPathFeature | null => {
  if (object.spatial.geometry?.type !== 'LineString') return null
  if (!presentation.mapLineVisible) return null
  const kind = 'object-line'
  const path = lineStringPositions(object.spatial.geometry)
  const tone = presentationTone(presentation)
  const widthPx = 2.5
  return {
    id: `${kind}:${object.id}`,
    kind,
    path,
    color: colorWithAlpha(hexToRgba(presentation.color), 214),
    casingColor: white(150),
    widthPx,
    selected: false,
    priority: tone === 'error' ? 85 : tone === 'working' ? 70 : 35,
    signature: `${kind}:${object.id}:${presentation.color}:${tone}:${pathSignature(path)}`,
  }
}

const areaSymbolFor = (feature: PackMapFeature): OperationalSymbolFeature | null => {
  if (!feature.anchorPoint || !feature.symbol) return null
  const tone = feature.symbol.tone ?? 'idle'
  const symbolId = feature.symbol.icon
  const symbolAtlas = symbolAtlasFor(symbolId)
  const position = pointPosition(feature.anchorPoint)
  const opacity = feature.symbol.opacity ?? 0.92
  const sizePx = (feature.symbol.size ?? 0.82) * symbolSizePx(symbolId)
  return {
    id: `area-symbol:${feature.id}`,
    layerId: feature.layerId ?? 'objects',
    position,
    symbolId,
    symbolAtlas,
    color: colorWithAlpha(toneColor(tone), opacity * 255),
    opacity,
    sizePx,
    summary: feature.summary,
    signature: `area-symbol:${feature.id}:${feature.layerId ?? 'objects'}:${positionSignature(position)}:${symbolId}:${tone}:${opacity}:${sizePx}`,
  }
}

const placementPosition = (point: GeoJsonPoint): Position3 =>
  pointPosition(point)

interface ProjectedObjectFeatures {
  readonly points: ReadonlyArray<OperationalPointFeature>
  readonly objectPaths: ReadonlyArray<OperationalPathFeature>
}

const projectionContextFor = (
  input: OperationalRenderInput,
): MapFeatureProjectionContext => ({
  selectedControllerId: input.selectedControllerId,
  highlightedObjectIds: new Set(input.highlightedObjectIds),
  mutedObjectIds: new Set(input.mutedObjectIds ?? []),
  hiddenObjectCategoryIds: new Set(input.hiddenObjectCategoryIds),
  hasNewInfo: input.hasNewInfo,
  presentationFor: input.presentationFor,
})

const projectObjects = (
  input: OperationalRenderInput,
  context: MapFeatureProjectionContext,
): ProjectedObjectFeatures => {
  const points: OperationalPointFeature[] = []
  const objectPaths: OperationalPathFeature[] = []
  for (const object of input.objects) {
    const presentation = context.presentationFor(object)
    if (context.hiddenObjectCategoryIds.has(presentation.categoryId)) continue
    const point = operationalPointFor(object, presentation, context)
    if (point) points.push(point)
    // A route belongs to its object's icon: an object the Pack does not draw draws no route either.
    const route = presentation.mapIconVisible === false ? null : routePathFor(object, input.selectedControllerId)
    if (route) objectPaths.push(route)
    const line = lineObjectPathFor(object, presentation)
    if (line) objectPaths.push(line)
  }
  return {
    points: points.sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id)),
    objectPaths,
  }
}

const projectPackAreaSymbols = (
  features: ReadonlyArray<PackMapFeature>,
): ReadonlyArray<OperationalSymbolFeature> =>
  features.flatMap(feature => {
    const symbol = areaSymbolFor(feature)
    return symbol ? [symbol] : []
  })

const sortPaths = (
  paths: ReadonlyArray<OperationalPathFeature>,
): ReadonlyArray<OperationalPathFeature> =>
  [...paths].sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))

const projectFeatures = (
  input: OperationalRenderInput,
): {
  readonly points: ReadonlyArray<OperationalPointFeature>
  readonly paths: ReadonlyArray<OperationalPathFeature>
  readonly areaSymbols: ReadonlyArray<OperationalSymbolFeature>
  readonly placementPoints: ReadonlyArray<Position3>
} => {
  const objectFeatures = projectObjects(input, projectionContextFor(input))
  const areaSymbols = projectPackAreaSymbols(input.packFeatures)
  return {
    points: objectFeatures.points,
    paths: sortPaths(objectFeatures.objectPaths),
    areaSymbols,
    placementPoints: input.placementPoints.map(placementPosition),
  }
}

export const createMapFeatureStore = (): MapFeatureStore => {
  const points = createFamilyState<OperationalPointFeature>()
  const paths = createFamilyState<OperationalPathFeature>()
  const areaSymbols = createFamilyState<OperationalSymbolFeature>()
  let placementPoints: ReadonlyArray<Position3> = []
  let placementRevision = 0

  const currentSnapshot = (): OperationalRenderSnapshot => ({
    points: points.items,
    paths: paths.items,
    areaSymbols: areaSymbols.items,
    placementPoints,
    revisions: {
      points: points.revision,
      paths: paths.revision,
      areaSymbols: areaSymbols.revision,
      placement: placementRevision,
    },
  })

  const syncPlacement = (nextPlacementPoints: ReadonlyArray<Position3>): void => {
    const nextPlacementSignature = nextPlacementPoints.map(positionSignature).join('|')
    const currentPlacementSignature = placementPoints.map(positionSignature).join('|')
    if (nextPlacementSignature !== currentPlacementSignature) {
      placementPoints = nextPlacementPoints
      placementRevision += 1
    }
  }

  const updateAll = (input: OperationalRenderInput): OperationalRenderSnapshot => {
    const next = projectFeatures(input)
    syncFamily(points, next.points)
    syncFamily(paths, next.paths)
    syncFamily(areaSymbols, next.areaSymbols)
    syncPlacement(next.placementPoints)
    return currentSnapshot()
  }

  return {
    update: updateAll,
    updateFamilies: (input, families) => {
      const context = projectionContextFor(input)
      const shouldUpdatePoints = families.has('operational-points')
      const shouldUpdatePaths = families.has('operational-paths')
      const shouldUpdateAreas = families.has('operational-areas')
      const shouldUpdateObjects = shouldUpdatePoints || shouldUpdatePaths
      const objectFeatures = shouldUpdateObjects ? projectObjects(input, context) : null

      if (shouldUpdatePoints && objectFeatures) {
        syncFamily(points, objectFeatures.points)
      }
      if (shouldUpdatePaths && objectFeatures) {
        syncFamily(paths, sortPaths(objectFeatures.objectPaths))
      }
      if (shouldUpdateAreas) {
        syncFamily(areaSymbols, projectPackAreaSymbols(input.packFeatures))
      }
      if (families.has('placement')) {
        syncPlacement(input.placementPoints.map(placementPosition))
      }
      return currentSnapshot()
    },
    snapshot: currentSnapshot,
  }
}
