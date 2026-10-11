import type { GeoJsonGeometry, GeoJsonPosition } from '../../../reference-data/types.ts'

// One representative point for a site's footprint: the pole of inaccessibility
// (the interior point farthest from the outline) of a polygon, of the largest
// polygon of a multipolygon, or the point halfway along an unclosed outline.
// Computed in a local equirectangular plane so east-west and north-south
// distances weigh alike at Norwegian latitudes.

type Ring = ReadonlyArray<GeoJsonPosition>
type PlanePoint = readonly [number, number]

interface Plane {
  readonly toPlane: (position: GeoJsonPosition) => PlanePoint
  readonly toLonLat: (point: PlanePoint) => readonly [number, number]
}

const planeAround = (positions: ReadonlyArray<GeoJsonPosition>): Plane => {
  const lats = positions.map(position => position[1])
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2
  const xScale = Math.cos(midLat * Math.PI / 180)
  return {
    toPlane: position => [position[0] * xScale, position[1]],
    toLonLat: point => [point[0] / xScale, point[1]],
  }
}

const ringArea = (ring: ReadonlyArray<PlanePoint>): number => {
  let twiceArea = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    twiceArea += ring[j]![0] * ring[i]![1] - ring[i]![0] * ring[j]![1]
  }
  return twiceArea / 2
}

const segmentDistanceSquared = (point: PlanePoint, a: PlanePoint, b: PlanePoint): number => {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const lengthSquared = dx * dx + dy * dy
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared))
  const px = a[0] + t * dx - point[0]
  const py = a[1] + t * dy - point[1]
  return px * px + py * py
}

/** Distance to the nearest ring edge; positive inside the polygon (even-odd over all rings), negative outside. */
const signedDistance = (point: PlanePoint, rings: ReadonlyArray<ReadonlyArray<PlanePoint>>): number => {
  let inside = false
  let nearestSquared = Number.POSITIVE_INFINITY
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i]!
      const b = ring[j]!
      if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside
      nearestSquared = Math.min(nearestSquared, segmentDistanceSquared(point, a, b))
    }
  }
  return (inside ? 1 : -1) * Math.sqrt(nearestSquared)
}

interface Cell {
  readonly x: number
  readonly y: number
  /** Half the cell's side. */
  readonly half: number
  readonly distance: number
  /** Largest distance any point in the cell can have. */
  readonly potential: number
}

const cellAt = (x: number, y: number, half: number, rings: ReadonlyArray<ReadonlyArray<PlanePoint>>): Cell => {
  const distance = signedDistance([x, y], rings)
  return { x, y, half, distance, potential: distance + half * Math.SQRT2 }
}

/** Binary max-heap of cells by potential. */
const createCellQueue = () => {
  const heap: Cell[] = []
  const swap = (i: number, j: number): void => { const t = heap[i]!; heap[i] = heap[j]!; heap[j] = t }
  return {
    get size(): number { return heap.length },
    push: (cell: Cell): void => {
      heap.push(cell)
      for (let i = heap.length - 1; i > 0;) {
        const parent = (i - 1) >> 1
        if (heap[parent]!.potential >= heap[i]!.potential) break
        swap(i, parent)
        i = parent
      }
    },
    pop: (): Cell => {
      const top = heap[0]!
      const last = heap.pop()!
      if (heap.length > 0) {
        heap[0] = last
        for (let i = 0; ;) {
          const left = 2 * i + 1
          const right = left + 1
          let largest = i
          if (left < heap.length && heap[left]!.potential > heap[largest]!.potential) largest = left
          if (right < heap.length && heap[right]!.potential > heap[largest]!.potential) largest = right
          if (largest === i) break
          swap(i, largest)
          i = largest
        }
      }
      return top
    },
  }
}

// Stop refining once no cell can beat the best point by more than this share of the footprint's shorter side.
const relativePrecision = 1e-3

const halfwayAlong = (line: ReadonlyArray<PlanePoint>): PlanePoint => {
  const lengths = line.slice(1).map((point, index) => Math.hypot(point[0] - line[index]![0], point[1] - line[index]![1]))
  let remaining = lengths.reduce((sum, length) => sum + length, 0) / 2
  for (let i = 0; i < lengths.length; i++) {
    const length = lengths[i]!
    if (remaining <= length && length > 0) {
      const t = remaining / length
      const a = line[i]!
      const b = line[i + 1]!
      return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]
    }
    remaining -= length
  }
  return line[line.length - 1]!
}

const poleOfInaccessibility = (rings: ReadonlyArray<ReadonlyArray<PlanePoint>>): PlanePoint => {
  const outer = rings[0]!
  const xs = outer.map(point => point[0])
  const ys = outer.map(point => point[1])
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const width = Math.max(...xs) - minX
  const height = Math.max(...ys) - minY
  const cellSize = Math.min(width, height)
  // A ring without area has no interior; its outline is all there is.
  if (cellSize === 0 || ringArea(outer) === 0) return halfwayAlong(outer)
  const precision = cellSize * relativePrecision
  const queue = createCellQueue()
  const half = cellSize / 2
  for (let x = minX; x < minX + width; x += cellSize) {
    for (let y = minY; y < minY + height; y += cellSize) queue.push(cellAt(x + half, y + half, half, rings))
  }
  let best = cellAt(minX + width / 2, minY + height / 2, 0, rings)
  while (queue.size > 0) {
    const cell = queue.pop()
    if (cell.distance > best.distance) best = cell
    if (cell.potential - best.distance <= precision) continue
    const quarter = cell.half / 2
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      queue.push(cellAt(cell.x + dx * quarter, cell.y + dy * quarter, quarter, rings))
    }
  }
  return [best.x, best.y]
}

const largestPolygon = (polygons: ReadonlyArray<ReadonlyArray<Ring>>, plane: Plane): ReadonlyArray<Ring> => {
  let largest = polygons[0]!
  let largestArea = -1
  for (const polygon of polygons) {
    const area = Math.abs(ringArea(polygon[0]!.map(plane.toPlane)))
    if (area > largestArea) {
      largest = polygon
      largestArea = area
    }
  }
  return largest
}

export const siteAnchor = (geometry: GeoJsonGeometry): readonly [number, number] => {
  if (geometry.type === 'Point') return [geometry.coordinates[0], geometry.coordinates[1]]
  if (geometry.type === 'LineString') {
    if (geometry.coordinates.length === 0) throw new Error('site anchor: LineString without positions')
    const plane = planeAround(geometry.coordinates)
    return plane.toLonLat(halfwayAlong(geometry.coordinates.map(plane.toPlane)))
  }
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates
  if (polygons.length === 0 || polygons.some(polygon => polygon.length === 0 || polygon[0]!.length === 0)) {
    throw new Error(`site anchor: ${geometry.type} without an outer ring`)
  }
  const plane = planeAround(polygons.flatMap(polygon => polygon[0]!))
  const rings = largestPolygon(polygons, plane).map(ring => ring.map(plane.toPlane))
  return plane.toLonLat(poleOfInaccessibility(rings))
}
