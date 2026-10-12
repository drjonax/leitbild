import { haversineKm, type LonLat } from './geo.ts'

// Open water on the straight path from a place to a station, measured against the OSM coastline
// (the land/sea boundary). Crossings of the coastline split the path into pieces that are land and
// sea in turn; the station is taken to stand on land, so parity from the station end tells which
// is which. The coastline may run within metres of a waterside station, so crossings that close to
// it are not counted; an odd count then means the place itself lies in the sea (a populated square
// whose centre is offshore), and the sea next to it is not open water between it and the station.

/** Crossings this close to the station end belong to its own shore, km. */
const stationShoreKm = 0.1

// Index cells, degrees: about 2.2 km east–west and north–south at Norwegian latitudes.
const cellLonDeg = 0.04
const cellLatDeg = 0.02

export interface WaterCrossings {
  /** The longest continuous stretch of sea on the straight path from `place` to `station`, km. */
  readonly openWaterKm: (place: LonLat, station: LonLat) => number
}

export const createWaterCrossings = (lines: ReadonlyArray<ReadonlyArray<readonly [number, number]>>): WaterCrossings => {
  const segmentCount = lines.reduce((sum, line) => sum + line.length - 1, 0)
  const ax = new Float64Array(segmentCount)
  const ay = new Float64Array(segmentCount)
  const bx = new Float64Array(segmentCount)
  const by = new Float64Array(segmentCount)
  let count = 0
  for (const line of lines) {
    for (let index = 1; index < line.length; index += 1) {
      ax[count] = line[index - 1]![0]
      ay[count] = line[index - 1]![1]
      bx[count] = line[index]![0]
      by[count] = line[index]![1]
      count += 1
    }
  }
  const cellKey = (cellX: number, cellY: number): number => cellX * 100_000 + cellY
  const cells = new Map<number, number[]>()
  for (let segment = 0; segment < count; segment += 1) {
    const x0 = Math.floor(Math.min(ax[segment]!, bx[segment]!) / cellLonDeg)
    const x1 = Math.floor(Math.max(ax[segment]!, bx[segment]!) / cellLonDeg)
    const y0 = Math.floor(Math.min(ay[segment]!, by[segment]!) / cellLatDeg)
    const y1 = Math.floor(Math.max(ay[segment]!, by[segment]!) / cellLatDeg)
    for (let cellX = x0; cellX <= x1; cellX += 1) {
      for (let cellY = y0; cellY <= y1; cellY += 1) {
        const key = cellKey(cellX, cellY)
        const members = cells.get(key)
        if (members === undefined) cells.set(key, [segment])
        else members.push(segment)
      }
    }
  }
  const visited = new Int32Array(count)
  let query = 0
  return {
    openWaterKm: (place, station) => {
      query += 1
      const lengthKm = haversineKm(place, station)
      if (lengthKm === 0) return 0
      const dx = station[0] - place[0]
      const dy = station[1] - place[1]
      const crossings: number[] = []
      const x0 = Math.floor(Math.min(place[0], station[0]) / cellLonDeg)
      const x1 = Math.floor(Math.max(place[0], station[0]) / cellLonDeg)
      const y0 = Math.floor(Math.min(place[1], station[1]) / cellLatDeg)
      const y1 = Math.floor(Math.max(place[1], station[1]) / cellLatDeg)
      for (let cellX = x0; cellX <= x1; cellX += 1) {
        for (let cellY = y0; cellY <= y1; cellY += 1) {
          for (const segment of cells.get(cellKey(cellX, cellY)) ?? []) {
            if (visited[segment] === query) continue
            visited[segment] = query
            const ex = bx[segment]! - ax[segment]!
            const ey = by[segment]! - ay[segment]!
            const denominator = dx * ey - dy * ex
            if (denominator === 0) continue
            const wx = ax[segment]! - place[0]
            const wy = ay[segment]! - place[1]
            const along = (wx * ey - wy * ex) / denominator
            const onSegment = (wx * dy - wy * dx) / denominator
            // Half-open on the coastline segment, so a vertex shared by two segments counts once.
            if (along >= 0 && along <= 1 && onSegment >= 0 && onSegment < 1 && (1 - along) * lengthKm > stationShoreKm) crossings.push(along)
          }
        }
      }
      if (crossings.length === 0) return 0
      crossings.sort((left, right) => right - left)
      // From the station (land) towards the place: [crossings[0], 1] is land, the next piece sea, …
      const bounds = [1, ...crossings, 0]
      // With an odd count the last piece, at the place, is sea offshore of it: not counted.
      const pieces = crossings.length % 2 === 1 ? bounds.length - 2 : bounds.length - 1
      let longest = 0
      for (let piece = 1; piece < pieces; piece += 2) longest = Math.max(longest, (bounds[piece]! - bounds[piece + 1]!) * lengthKm)
      return longest
    },
  }
}
