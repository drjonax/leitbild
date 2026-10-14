import type { Layer, PickingInfo } from '@deck.gl/core'
import type { OperationalObject } from '../../core/model/index.ts'
import { IconLayer, PathLayer, ScatterplotLayer } from '@deck.gl/layers'
import type { CatalogueSymbolAtlasState } from './catalogue-symbol-atlas.ts'
import { darkStroke, rgba, white } from './colors.ts'
import { ObjectLabelLayer } from './object-label-layer.ts'
import { declutterPoints, type PointLeader } from './point-declutter.ts'
import {
  leitbildSymbolAtlasUrl,
  leitbildSymbolIconMapping,
  statusDiskRadiusPx,
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
  /**
   * Whether the icons' coloured disks take a click and hover too, not only
   * the glyphs' strokes (`map/map-pointer.ts`, `disksPickFor`): only while
   * the surface picks map targets and the last pointer picks exactly, as a
   * mouse does. A finger or a pen picks within a radius around the strokes,
   * which the disk would widen, and every other surface picks the glyph
   * alone, as it always has.
   */
  readonly disksPick: boolean
  /**
   * Objects whose whole disk takes a mouse click and hover on every surface,
   * not only while it picks targets: those a click opens a card for
   * (`OperationalMap.svelte`, `takesDiskClicks`). Every other disk picks only
   * as `disksPick` says, so it never takes a ground, placement or Pack feature
   * click that used to pass between a glyph's strokes. Null for a finger or
   * a pen, which pick within a radius around the strokes that the disk would
   * widen (`map/map-pointer.ts`).
   */
  readonly diskClicks: ((object: OperationalObject) => boolean) | null
  /** The zoom step the icons are laid out for (`point-declutter.ts`, `fanZoomOf`). */
  readonly zoom: number
  readonly assignmentInteraction?: MapAssignmentInteraction
  readonly onAssignmentHandleSelected?: (handle: MapAssignmentHandleFeature) => void
  readonly layerData?: OperationalDeckLayerData
}

export interface OperationalDeckLayerData {
  readonly visiblePaths: ReadonlyArray<OperationalPathFeature>
  readonly visibleAreaSymbols: ReadonlyArray<OperationalSymbolFeature>
  /** Every point where the map draws its icon, fanned out where icons would overlap (`point-declutter.ts`). */
  readonly points: ReadonlyArray<OperationalPointFeature>
  /** A leader from each fanned icon to its true position. */
  readonly leaders: ReadonlyArray<PointLeader>
  /** Where each fanned object's icon is drawn, by object id. */
  readonly drawnAt: ReadonlyMap<string, Position3>
  /** Counts each new layout of the icons. */
  readonly layoutRevision: number
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
    zoom: number,
  ) => OperationalDeckLayerData
  readonly reset: () => void
}

export interface OperationalDeckLayerFactory {
  readonly createLayers: (config: OperationalDeckLayerConfig) => ReadonlyArray<Layer>
  /** The points as last drawn, fanned out where icons would overlap, in draw order. */
  readonly drawnPoints: () => ReadonlyArray<OperationalPointFeature>
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
const emptyLeaders: ReadonlyArray<PointLeader> = []
const nothingMoved: ReadonlyMap<string, Position3> = new Map()

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
  let layoutZoom = Number.NaN
  let layoutRevision = 0
  let drawnPoints: ReadonlyArray<OperationalPointFeature> = emptyPoints
  let leaders: ReadonlyArray<PointLeader> = emptyLeaders
  let drawnAt: ReadonlyMap<string, Position3> = nothingMoved
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
    layoutZoom = Number.NaN
    drawnPoints = emptyPoints
    leaders = emptyLeaders
    drawnAt = nothingMoved
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
    dataFor: (snapshot, visibleFamilies, catalogueAtlas, zoom) => {
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
      if (pointsRevision !== snapshot.revisions.points || atlasChanged || layoutZoom !== zoom) {
        pointsRevision = snapshot.revisions.points
        layoutZoom = zoom
        layoutRevision += 1
        const decluttered = declutterPoints(snapshot.points, zoom)
        drawnPoints = decluttered.points
        leaders = decluttered.leaders
        drawnAt = decluttered.drawnAt
        newInfoPoints = drawnPoints.filter(point => point.hasNewInfo)
        pointsByAtlas = byAtlas(drawnPoints, catalogueAtlas, emptyPoints)
        labelPoints = drawnPoints.some(point => point.label !== null) ? drawnPoints.filter(point => point.label !== null) : emptyPoints
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
        points: drawnPoints,
        leaders,
        drawnAt,
        layoutRevision,
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
  let drawnPoints: ReadonlyArray<OperationalPointFeature> = emptyPoints
  return {
    createLayers: config => {
      const layerData = dataCache.dataFor(config.snapshot, config.visibleFamilies, config.catalogueAtlas, config.zoom)
      drawnPoints = layerData.points
      return createOperationalDeckLayers({ ...config, layerData })
    },
    drawnPoints: () => drawnPoints,
    reset: () => {
      dataCache.reset()
      drawnPoints = emptyPoints
    },
  }
}

export const createOperationalDeckLayers = (config: OperationalDeckLayerConfig): ReadonlyArray<Layer> => {
  const snapshot = config.snapshot
  const visibleFamilies = config.visibleFamilies
  const assignmentInteraction = config.assignmentInteraction ?? { revision: 0, active: false, anchor: null, pointer: null, handles: [] }
  const layerData = config.layerData ?? createOperationalDeckLayerDataCache().dataFor(snapshot, visibleFamilies, config.catalogueAtlas, config.zoom)
  const visiblePaths = layerData.visiblePaths
  const points = layerData.points
  const diskClicks = config.diskClicks
  const diskClickPoints = config.disksPick || diskClicks === null ? emptyPoints : points.filter(point => diskClicks(point.object))
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
      // A handle stands on its controller's icon, wherever a fan draws it.
      getPosition: handle => layerData.drawnAt.get(handle.controllerId) ?? handle.position,
      getPixelOffset: [15, -15],
      getColor: white(250),
      getSize: 30,
      onClick: info => { if (info.object) config.onAssignmentHandleSelected?.(info.object) },
      updateTriggers: { getPosition: [assignmentInteraction.revision, layerData.layoutRevision] },
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
    ...(layerData.leaders.length > 0
      ? [
          new PathLayer<PointLeader>({
            id: 'leitbild-object-leader-casing',
            data: layerData.leaders,
            pickable: false,
            visible: visible(visibleFamilies, 'objects'),
            getPath: leader => [leader.drawnAt, leader.trueAt] as unknown as number[],
            getColor: white(190),
            getWidth: 3.5,
            widthUnits: 'pixels',
            capRounded: true,
          }),
          new PathLayer<PointLeader>({
            id: 'leitbild-object-leaders',
            data: layerData.leaders,
            pickable: false,
            visible: visible(visibleFamilies, 'objects'),
            getPath: leader => [leader.drawnAt, leader.trueAt] as unknown as number[],
            getColor: rgba(40, 46, 56, 200),
            getWidth: 1.5,
            widthUnits: 'pixels',
            capRounded: true,
          }),
          new ScatterplotLayer<PointLeader>({
            id: 'leitbild-object-true-positions',
            data: layerData.leaders,
            pickable: false,
            visible: visible(visibleFamilies, 'objects'),
            radiusUnits: 'pixels',
            lineWidthUnits: 'pixels',
            stroked: true,
            filled: true,
            getPosition: leader => leader.trueAt,
            getRadius: 3,
            getFillColor: rgba(40, 46, 56, 230),
            getLineColor: white(235),
            getLineWidth: 1.5,
          }),
        ]
      : []),
    new ScatterplotLayer<OperationalPointFeature>({
      id: 'leitbild-object-halos',
      data: points,
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
      data: points,
      // While the surface picks targets, a mouse click between the glyph's strokes lands on the disk: it is the object's, never the ground's.
      pickable: config.disksPick,
      visible: visible(visibleFamilies, 'objects'),
      radiusUnits: 'pixels',
      lineWidthUnits: 'pixels',
      stroked: true,
      filled: true,
      getPosition: point => point.position,
      getRadius: point => statusDiskRadiusPx(point.sizePx),
      getFillColor: pointFill,
      getLineColor: darkStroke(185),
      getLineWidth: 1,
      ...(config.disksPick ? { onClick: onSymbolClick, onHover: onSymbolHover } : {}),
      updateTriggers: {
        getPosition: snapshot.revisions.points,
        getRadius: snapshot.revisions.points,
        getFillColor: snapshot.revisions.points,
      },
    }),
    // The disks of objects a click opens a card for, drawn transparent and
    // picked: a click anywhere on such a disk is its object's. Not needed
    // while every disk picks.
    ...(diskClickPoints.length > 0
      ? [new ScatterplotLayer<OperationalPointFeature>({
          id: 'leitbild-object-disk-clicks',
          data: diskClickPoints,
          pickable: true,
          visible: visible(visibleFamilies, 'objects'),
          radiusUnits: 'pixels',
          stroked: false,
          filled: true,
          getPosition: point => point.position,
          getRadius: point => statusDiskRadiusPx(point.sizePx),
          getFillColor: rgba(0, 0, 0, 0),
          onClick: onSymbolClick,
          onHover: onSymbolHover,
          updateTriggers: {
            getPosition: snapshot.revisions.points,
            getRadius: snapshot.revisions.points,
          },
        })]
      : []),
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
          obstacles: points,
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
