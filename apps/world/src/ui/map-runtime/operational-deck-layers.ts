import type { Layer, PickingInfo } from '@deck.gl/core'
import { IconLayer, PathLayer, ScatterplotLayer } from '@deck.gl/layers'
import type { CatalogueSymbolAtlasState } from './catalogue-symbol-atlas.ts'
import { darkStroke, rgba, white } from './colors.ts'
import { ObjectLabelLayer } from './object-label-layer.ts'
import {
  leitbildSymbolAtlasUrl,
  leitbildSymbolIconMapping,
} from './symbol-kit.ts'
import type {
  ColorRgba,
  MapAssignmentHandleFeature,
  MapAssignmentInteraction,
  OperationalPathFeature,
  OperationalPointFeature,
  OperationalRenderSnapshot,
  OperationalSymbolFeature,
  Position3,
} from './types.ts'

export interface OperationalDeckLayerConfig {
  readonly snapshot: OperationalRenderSnapshot
  readonly visibleFamilies: ReadonlySet<string>
  /** Artwork for catalogue icons beyond the compiled atlas; an icon without artwork yet is not drawn. */
  readonly catalogueAtlas: CatalogueSymbolAtlasState
  readonly onObjectSelected: (object: OperationalPointFeature) => void
  readonly onObjectSeen: (object: OperationalPointFeature) => void
  readonly onObjectHover: (object: OperationalPointFeature | null) => void
  readonly assignmentInteraction?: MapAssignmentInteraction
  readonly onAssignmentHandleSelected?: (handle: MapAssignmentHandleFeature) => void
  readonly layerData?: OperationalDeckLayerData
}

export interface OperationalDeckLayerData {
  readonly visiblePaths: ReadonlyArray<OperationalPathFeature>
  readonly visibleAreaSymbols: ReadonlyArray<OperationalSymbolFeature>
  readonly newInfoPoints: ReadonlyArray<OperationalPointFeature>
  readonly placementPoints: ReadonlyArray<{ readonly id: string; readonly position: Position3 }>
  /** Points the compiled atlas draws: every point while no Pack uses another catalogue icon. */
  readonly compiledPoints: ReadonlyArray<OperationalPointFeature>
  /** Points with another catalogue icon whose artwork has arrived. */
  readonly cataloguePoints: ReadonlyArray<OperationalPointFeature>
  readonly labelPoints: ReadonlyArray<OperationalPointFeature>
  readonly compiledAreaSymbols: ReadonlyArray<OperationalSymbolFeature>
  readonly catalogueAreaSymbols: ReadonlyArray<OperationalSymbolFeature>
}

export interface OperationalDeckLayerDataCache {
  readonly dataFor: (
    snapshot: OperationalRenderSnapshot,
    visibleFamilies: ReadonlySet<string>,
    catalogueAtlas: CatalogueSymbolAtlasState,
  ) => OperationalDeckLayerData
  readonly reset: () => void
}

export interface OperationalDeckLayerFactory {
  readonly createLayers: (config: OperationalDeckLayerConfig) => ReadonlyArray<Layer>
  readonly reset: () => void
}

const atlasUrl = leitbildSymbolAtlasUrl()
const iconMapping = leitbildSymbolIconMapping()

const visible = (
  visibleFamilies: ReadonlySet<string>,
  family: string,
): boolean =>
  visibleFamilies.has(family)

export const visibleFamiliesKey = (
  visibleFamilies: ReadonlySet<string>,
): string =>
  [...visibleFamilies].sort().join('|')

const pointFill = (point: OperationalPointFeature): ColorRgba => {
  if (point.muted) return [point.color[0], point.color[1], point.color[2], 132]
  return point.color
}

const haloFill = (point: OperationalPointFeature): ColorRgba => {
  if (point.selected) return rgba(29, 102, 210, 62)
  if (point.highlighted) return rgba(193, 122, 19, 58)
  if (point.statusTone === 'error') return rgba(199, 53, 43, 52)
  return rgba(255, 255, 255, 0)
}

const haloStroke = (point: OperationalPointFeature): ColorRgba => {
  if (point.selected) return rgba(29, 102, 210, 245)
  if (point.highlighted) return rgba(193, 122, 19, 230)
  if (point.statusTone === 'error') return rgba(199, 53, 43, 220)
  return rgba(255, 255, 255, 0)
}

const asPointPicking = (info: PickingInfo<OperationalPointFeature>): OperationalPointFeature | null =>
  info.object ?? null

const placementPointObjects = (
  points: ReadonlyArray<Position3>,
): ReadonlyArray<{ readonly id: string; readonly position: Position3 }> =>
  points.map((position, index) => ({ id: `placement:${index}`, position }))

const deckPath = (
  path: OperationalPathFeature,
): number[] =>
  path.path as unknown as number[]

const pathCasingWidth = (path: OperationalPathFeature): number => (path.kind === 'object-line' ? 0 : path.widthPx + 4)

const pathFamilyIsVisible = (path: OperationalPathFeature, visibleFamilies: ReadonlySet<string>): boolean => {
  if (path.kind === 'route') return visible(visibleFamilies, 'routes')
  return visible(visibleFamilies, 'objects')
}

const emptyPaths: ReadonlyArray<OperationalPathFeature> = []
const emptyPoints: ReadonlyArray<OperationalPointFeature> = []
const emptySymbols: ReadonlyArray<OperationalSymbolFeature> = []
const emptyPlacementPoints: ReadonlyArray<{ readonly id: string; readonly position: Position3 }> = []

/** Splits features by atlas; with no catalogue icon the compiled list is the input itself, so nothing changes for it. */
const byAtlas = <T extends { readonly symbolId: string; readonly symbolAtlas: 'compiled' | 'catalogue' }>(
  features: ReadonlyArray<T>,
  catalogueAtlas: CatalogueSymbolAtlasState,
  empty: ReadonlyArray<T>,
): { readonly compiled: ReadonlyArray<T>; readonly catalogue: ReadonlyArray<T> } => {
  if (!features.some(feature => feature.symbolAtlas === 'catalogue')) return { compiled: features, catalogue: empty }
  return {
    compiled: features.filter(feature => feature.symbolAtlas === 'compiled'),
    catalogue: catalogueAtlas.url === null ? empty : features.filter(feature => feature.symbolAtlas === 'catalogue' && Object.hasOwn(catalogueAtlas.mapping, feature.symbolId)),
  }
}

export const createOperationalDeckLayerDataCache = (): OperationalDeckLayerDataCache => {
  let pathsRevision = -1
  let pathsVisibleKey = ''
  let visiblePaths: ReadonlyArray<OperationalPathFeature> = emptyPaths
  let pointsRevision = -1
  let newInfoPoints: ReadonlyArray<OperationalPointFeature> = emptyPoints
  let placementRevision = -1
  let symbolsRevision = -1
  let symbolsVisibleKey = ''
  let visibleAreaSymbols: ReadonlyArray<OperationalSymbolFeature> = []
  let placementPoints: ReadonlyArray<{ readonly id: string; readonly position: Position3 }> = emptyPlacementPoints
  let atlasRevision = -1
  let pointsByAtlas: { readonly compiled: ReadonlyArray<OperationalPointFeature>; readonly catalogue: ReadonlyArray<OperationalPointFeature> } = { compiled: emptyPoints, catalogue: emptyPoints }
  let labelPoints: ReadonlyArray<OperationalPointFeature> = emptyPoints
  let areaSymbolsByAtlas: { readonly compiled: ReadonlyArray<OperationalSymbolFeature>; readonly catalogue: ReadonlyArray<OperationalSymbolFeature> } = { compiled: emptySymbols, catalogue: emptySymbols }

  const reset = (): void => {
    pathsRevision = -1
    pathsVisibleKey = ''
    visiblePaths = emptyPaths
    pointsRevision = -1
    newInfoPoints = emptyPoints
    placementRevision = -1
    symbolsRevision = -1
    symbolsVisibleKey = ''
    visibleAreaSymbols = []
    placementPoints = emptyPlacementPoints
    atlasRevision = -1
    pointsByAtlas = { compiled: emptyPoints, catalogue: emptyPoints }
    labelPoints = emptyPoints
    areaSymbolsByAtlas = { compiled: emptySymbols, catalogue: emptySymbols }
  }

  return {
    dataFor: (snapshot, visibleFamilies, catalogueAtlas) => {
      const nextVisibleKey = visibleFamiliesKey(visibleFamilies)
      const atlasChanged = atlasRevision !== catalogueAtlas.revision
      atlasRevision = catalogueAtlas.revision
      if (symbolsRevision !== snapshot.revisions.areaSymbols || symbolsVisibleKey !== nextVisibleKey || atlasChanged) {
        symbolsRevision = snapshot.revisions.areaSymbols
        symbolsVisibleKey = nextVisibleKey
        visibleAreaSymbols = snapshot.areaSymbols.filter(symbol => visible(visibleFamilies, symbol.layerId))
        areaSymbolsByAtlas = byAtlas(visibleAreaSymbols, catalogueAtlas, emptySymbols)
      }
      if (pathsRevision !== snapshot.revisions.paths || pathsVisibleKey !== nextVisibleKey) {
        pathsRevision = snapshot.revisions.paths
        pathsVisibleKey = nextVisibleKey
        visiblePaths = snapshot.paths.filter(path => pathFamilyIsVisible(path, visibleFamilies))
      }
      if (pointsRevision !== snapshot.revisions.points || atlasChanged) {
        pointsRevision = snapshot.revisions.points
        newInfoPoints = snapshot.points.filter(point => point.hasNewInfo)
        pointsByAtlas = byAtlas(snapshot.points, catalogueAtlas, emptyPoints)
        labelPoints = snapshot.points.some(point => point.label !== null) ? snapshot.points.filter(point => point.label !== null) : emptyPoints
      }
      if (placementRevision !== snapshot.revisions.placement) {
        placementRevision = snapshot.revisions.placement
        placementPoints = snapshot.placementPoints.length === 0
          ? emptyPlacementPoints
          : placementPointObjects(snapshot.placementPoints)
      }
      return {
        visiblePaths,
        visibleAreaSymbols,
        newInfoPoints,
        placementPoints,
        compiledPoints: pointsByAtlas.compiled,
        cataloguePoints: pointsByAtlas.catalogue,
        labelPoints,
        compiledAreaSymbols: areaSymbolsByAtlas.compiled,
        catalogueAreaSymbols: areaSymbolsByAtlas.catalogue,
      }
    },
    reset,
  }
}

export const createOperationalDeckLayerFactory = (): OperationalDeckLayerFactory => {
  const dataCache = createOperationalDeckLayerDataCache()
  return {
    createLayers: config => createOperationalDeckLayers({
      ...config,
      layerData: dataCache.dataFor(config.snapshot, config.visibleFamilies, config.catalogueAtlas),
    }),
    reset: dataCache.reset,
  }
}

export const createOperationalDeckLayers = (config: OperationalDeckLayerConfig): ReadonlyArray<Layer> => {
  const snapshot = config.snapshot
  const visibleFamilies = config.visibleFamilies
  const assignmentInteraction = config.assignmentInteraction ?? { revision: 0, active: false, anchor: null, pointer: null, handles: [] }
  const layerData = config.layerData ?? createOperationalDeckLayerDataCache().dataFor(snapshot, visibleFamilies, config.catalogueAtlas)
  const visiblePaths = layerData.visiblePaths
  const catalogueAtlas = config.catalogueAtlas
  const onSymbolClick = (info: PickingInfo<OperationalPointFeature>): void => {
    const point = asPointPicking(info)
    if (!point) return
    config.onObjectSeen(point)
    config.onObjectSelected(point)
  }
  const onSymbolHover = (info: PickingInfo<OperationalPointFeature>): void => {
    config.onObjectHover(asPointPicking(info))
  }
  return [
    new PathLayer<{ readonly path: ReadonlyArray<Position3> }>({
      id: 'leitbild-assignment-preview-line',
      data: assignmentInteraction.active && assignmentInteraction.anchor && assignmentInteraction.pointer
        ? [{ path: [assignmentInteraction.anchor, assignmentInteraction.pointer] }]
        : [],
      pickable: false,
      getPath: entry => entry.path as unknown as number[],
      getColor: rgba(38, 117, 216, 220),
      getWidth: 2,
      widthUnits: 'pixels',
      capRounded: true,
      updateTriggers: { getPath: assignmentInteraction.revision },
    }),
    new ScatterplotLayer<{ readonly position: Position3 }>({
      id: 'leitbild-assignment-crosshair',
      data: assignmentInteraction.active && assignmentInteraction.pointer ? [{ position: assignmentInteraction.pointer }] : [],
      pickable: false,
      radiusUnits: 'pixels',
      lineWidthUnits: 'pixels',
      stroked: true,
      filled: false,
      getPosition: entry => entry.position,
      getRadius: 11,
      getLineColor: rgba(38, 117, 216, 245),
      getLineWidth: 2.5,
      updateTriggers: { getPosition: assignmentInteraction.revision },
    }),
    new IconLayer<MapAssignmentHandleFeature>({
      id: 'leitbild-assignment-handles',
      data: assignmentInteraction.handles,
      pickable: true,
      visible: !assignmentInteraction.active,
      iconAtlas: atlasUrl,
      iconMapping,
      sizeUnits: 'pixels',
      getIcon: () => 'git-branch-plus',
      getPosition: handle => handle.position,
      getPixelOffset: [15, -15],
      getColor: white(250),
      getSize: 30,
      onClick: info => { if (info.object) config.onAssignmentHandleSelected?.(info.object) },
      updateTriggers: { getPosition: assignmentInteraction.revision },
    }),
    new PathLayer<OperationalPathFeature>({
      id: 'leitbild-operational-path-casing',
      data: visiblePaths,
      pickable: false,
      visible: visiblePaths.length > 0,
      getPath: deckPath,
      getColor: path => path.casingColor,
      getWidth: pathCasingWidth,
      widthUnits: 'pixels',
      jointRounded: true,
      capRounded: true,
      updateTriggers: {
        getPath: snapshot.revisions.paths,
        getColor: snapshot.revisions.paths,
        getWidth: snapshot.revisions.paths,
      },
    }),
    new PathLayer<OperationalPathFeature>({
      id: 'leitbild-operational-paths',
      data: visiblePaths,
      pickable: true,
      visible: visiblePaths.length > 0,
      getPath: deckPath,
      getColor: path => path.color,
      getWidth: path => path.widthPx,
      widthUnits: 'pixels',
      jointRounded: true,
      capRounded: true,
      updateTriggers: {
        getPath: snapshot.revisions.paths,
        getColor: snapshot.revisions.paths,
        getWidth: snapshot.revisions.paths,
      },
    }),
    new ScatterplotLayer<OperationalPointFeature>({
      id: 'leitbild-object-halos',
      data: snapshot.points,
      pickable: false,
      visible: visible(visibleFamilies, 'objects'),
      radiusUnits: 'pixels',
      lineWidthUnits: 'pixels',
      stroked: true,
      filled: true,
      getPosition: point => point.position,
      getRadius: point => point.selected || point.highlighted || point.statusTone === 'error' ? 18 : 0,
      getFillColor: haloFill,
      getLineColor: haloStroke,
      getLineWidth: point => point.selected || point.highlighted ? 2.5 : point.statusTone === 'error' ? 2 : 0,
      updateTriggers: {
        getPosition: snapshot.revisions.points,
        getRadius: snapshot.revisions.points,
        getFillColor: snapshot.revisions.points,
        getLineColor: snapshot.revisions.points,
        getLineWidth: snapshot.revisions.points,
      },
    }),
    new ScatterplotLayer<OperationalPointFeature>({
      id: 'leitbild-object-status-disks',
      data: snapshot.points,
      pickable: false,
      visible: visible(visibleFamilies, 'objects'),
      radiusUnits: 'pixels',
      lineWidthUnits: 'pixels',
      stroked: true,
      filled: true,
      getPosition: point => point.position,
      getRadius: point => point.sizePx * 0.74,
      getFillColor: pointFill,
      getLineColor: darkStroke(185),
      getLineWidth: 1,
      updateTriggers: {
        getPosition: snapshot.revisions.points,
        getRadius: snapshot.revisions.points,
        getFillColor: snapshot.revisions.points,
      },
    }),
    new IconLayer<OperationalPointFeature>({
      id: 'leitbild-object-symbols',
      data: layerData.compiledPoints,
      pickable: true,
      visible: visible(visibleFamilies, 'objects'),
      iconAtlas: atlasUrl,
      iconMapping,
      sizeUnits: 'pixels',
      getIcon: point => point.symbolId,
      getPosition: point => point.position,
      getColor: point => point.muted ? white(150) : white(245),
      getSize: point => point.sizePx,
      getAngle: point => point.rotationDeg,
      onClick: onSymbolClick,
      onHover: onSymbolHover,
      updateTriggers: {
        getIcon: snapshot.revisions.points,
        getPosition: snapshot.revisions.points,
        getColor: snapshot.revisions.points,
        getSize: snapshot.revisions.points,
        getAngle: snapshot.revisions.points,
      },
    }),
    ...(catalogueAtlas.url !== null && layerData.cataloguePoints.length > 0
      ? [new IconLayer<OperationalPointFeature>({
          id: 'leitbild-object-catalogue-symbols',
          data: layerData.cataloguePoints,
          pickable: true,
          visible: visible(visibleFamilies, 'objects'),
          iconAtlas: catalogueAtlas.url,
          iconMapping: catalogueAtlas.mapping,
          sizeUnits: 'pixels',
          getIcon: point => point.symbolId,
          getPosition: point => point.position,
          getColor: point => point.muted ? white(150) : white(245),
          getSize: point => point.sizePx,
          getAngle: point => point.rotationDeg,
          onClick: onSymbolClick,
          onHover: onSymbolHover,
          updateTriggers: {
            getIcon: [snapshot.revisions.points, catalogueAtlas.revision],
            getPosition: snapshot.revisions.points,
            getColor: snapshot.revisions.points,
            getSize: snapshot.revisions.points,
            getAngle: snapshot.revisions.points,
          },
        })]
      : []),
    ...(layerData.labelPoints.length > 0
      ? [new ObjectLabelLayer({
          id: 'leitbild-object-labels',
          data: layerData.labelPoints,
          obstacles: snapshot.points,
          // A label is part of its object: a click or hover on it acts on the object, never on the ground beneath.
          pickable: true,
          visible: visible(visibleFamilies, 'objects'),
          getColor: point => point.muted ? rgba(40, 46, 56, 150) : rgba(24, 28, 36, 245),
          backgroundColor: white(215),
          onClick: onSymbolClick,
          onHover: onSymbolHover,
        })]
      : []),
    new ScatterplotLayer<OperationalPointFeature>({
      id: 'leitbild-object-new-info',
      data: layerData.newInfoPoints,
      pickable: false,
      visible: visible(visibleFamilies, 'objects'),
      radiusUnits: 'pixels',
      lineWidthUnits: 'pixels',
      stroked: true,
      filled: true,
      getPosition: point => [point.position[0], point.position[1], point.position[2] + 1],
      getRadius: 5,
      getFillColor: rgba(199, 53, 43, 245),
      getLineColor: white(245),
      getLineWidth: 1.5,
      updateTriggers: {
        getPosition: snapshot.revisions.points,
      },
    }),
    new IconLayer<OperationalSymbolFeature>({
      id: 'leitbild-area-symbols',
      data: layerData.compiledAreaSymbols,
      pickable: false,
      iconAtlas: atlasUrl,
      iconMapping,
      sizeUnits: 'pixels',
      getIcon: symbol => symbol.symbolId,
      getPosition: symbol => symbol.position,
      getColor: symbol => symbol.color,
      getSize: symbol => symbol.sizePx,
      updateTriggers: {
        getIcon: snapshot.revisions.areaSymbols,
        getPosition: snapshot.revisions.areaSymbols,
        getColor: snapshot.revisions.areaSymbols,
        getSize: snapshot.revisions.areaSymbols,
      },
    }),
    ...(catalogueAtlas.url !== null && layerData.catalogueAreaSymbols.length > 0
      ? [new IconLayer<OperationalSymbolFeature>({
          id: 'leitbild-area-catalogue-symbols',
          data: layerData.catalogueAreaSymbols,
          pickable: false,
          iconAtlas: catalogueAtlas.url,
          iconMapping: catalogueAtlas.mapping,
          sizeUnits: 'pixels',
          getIcon: symbol => symbol.symbolId,
          getPosition: symbol => symbol.position,
          getColor: symbol => symbol.color,
          getSize: symbol => symbol.sizePx,
          updateTriggers: {
            getIcon: [snapshot.revisions.areaSymbols, catalogueAtlas.revision],
            getPosition: snapshot.revisions.areaSymbols,
            getColor: snapshot.revisions.areaSymbols,
            getSize: snapshot.revisions.areaSymbols,
          },
        })]
      : []),
    new ScatterplotLayer<{ readonly id: string; readonly position: Position3 }>({
      id: 'leitbild-placement-preview',
      data: layerData.placementPoints,
      pickable: false,
      visible: snapshot.placementPoints.length > 0,
      radiusUnits: 'pixels',
      lineWidthUnits: 'pixels',
      stroked: true,
      filled: true,
      getPosition: point => point.position,
      getRadius: 7,
      getFillColor: rgba(29, 102, 210, 235),
      getLineColor: white(245),
      getLineWidth: 3,
      updateTriggers: {
        getPosition: snapshot.revisions.placement,
      },
    }),
  ]
}
