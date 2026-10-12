import { Popup, type Map as MapLibreMap } from 'maplibre-gl'
import type { GeoJsonPoint, OperationalObject } from '../../core/model/index.ts'
import type { PackObjectField, PackObjectPresentation, PackTargetPreview } from '../../core/packs/protocol.ts'
import { featureHoverCardHtml, objectHoverCardHtml } from './object-hover-card.ts'

export interface MapPopupController {
  readonly show: (object: OperationalObject) => void
  /** Shows a card for a map feature that is not an operational object. */
  readonly showCard: (card: { readonly lngLat: readonly [number, number]; readonly title: string; readonly fields: ReadonlyArray<PackObjectField> }) => void
  readonly hide: () => void
  readonly refresh: (sourceObjects: ReadonlyArray<OperationalObject>) => void
  readonly hoveredObjectId: () => string | null
}

const pointOf = (object: OperationalObject): GeoJsonPoint | null =>
  object.spatial.position?.point ?? null

export const createMapPopupController = (config: {
  readonly getMap: () => MapLibreMap | null
  readonly presentationFor: (object: OperationalObject) => PackObjectPresentation
  readonly hasNewInfo: (object: OperationalObject) => boolean
  readonly targetPreviewFor: (object: OperationalObject) => PackTargetPreview | null
}): MapPopupController => {
  let markerPopup: Popup | null = null
  let hoveredObjectId: string | null = null

  const hoverCardHtml = (object: OperationalObject): string =>
    objectHoverCardHtml({
      object,
      presentation: config.presentationFor(object),
      hasNewInfo: config.hasNewInfo(object),
      targetPreview: config.targetPreviewFor(object),
    })

  const objectById = (
    objectId: string | null,
    sourceObjects: ReadonlyArray<OperationalObject>,
  ): OperationalObject | null => (
    objectId === null
      ? null
      : sourceObjects.find(candidate => candidate.id === objectId) ?? null
  )

  const popup = (): Popup => {
    markerPopup = markerPopup ?? new Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 26,
      className: 'object-popup',
    })
    return markerPopup
  }

  return {
    showCard: (card) => {
      const current = config.getMap()
      if (!current) return
      hoveredObjectId = null
      popup()
        .setLngLat([card.lngLat[0], card.lngLat[1]])
        .setHTML(featureHoverCardHtml(card))
        .addTo(current)
    },
    show: (object) => {
      const current = config.getMap()
      const point = pointOf(object)
      if (!current || !point) return
      hoveredObjectId = object.id
      const [lon, lat] = point.coordinates
      markerPopup = markerPopup ?? new Popup({
        closeButton: false,
        closeOnClick: false,
        offset: 26,
        className: 'object-popup',
      })
      markerPopup
        .setLngLat([lon, lat])
        .setHTML(hoverCardHtml(object))
        .addTo(current)
    },
    hide: () => {
      hoveredObjectId = null
      markerPopup?.remove()
      markerPopup = null
    },
    refresh: (sourceObjects) => {
      const object = objectById(hoveredObjectId, sourceObjects)
      const point = object ? pointOf(object) : null
      if (!markerPopup || !object || !point) return
      const [lon, lat] = point.coordinates
      markerPopup
        .setLngLat([lon, lat])
        .setHTML(hoverCardHtml(object))
    },
    hoveredObjectId: () => hoveredObjectId,
  }
}
