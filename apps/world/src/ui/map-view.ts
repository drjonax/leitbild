import type { Map as MapLibreMap } from 'maplibre-gl'
export interface MapView {
  /** The camera's centre: the centre of the part of the map its padding leaves clear. */
  readonly center: readonly [number, number]
  readonly bounds: readonly [number, number, number, number]
  readonly zoom: number
  /** Degrees clockwise from north up. */
  readonly bearing: number
}
export const readMapView = (map: MapLibreMap): MapView => {
  const area = map.getBounds(), point = map.getCenter()
  const wrap = (value: number) => ((value + 180) % 360 + 360) % 360 - 180
  const global = area.getEast() - area.getWest() >= 360
  return { center: [wrap(point.lng), point.lat], bounds: [global ? -180 : wrap(area.getWest()), area.getSouth(), global ? 180 : wrap(area.getEast()), area.getNorth()], zoom: map.getZoom(), bearing: map.getBearing() }
}
