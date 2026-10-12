import { mercatorPixels } from './label-placement.ts'
import { statusDiskRadiusPx } from './symbol-kit.ts'
import type { OperationalPointFeature, Position3 } from './types.ts'

/**
 * Map icons fanned out so that icons standing close together never stack
 * into one unreadable blob, whatever Pack draws them: plants a few hundred
 * metres apart, units parked on one depot, an alarm on a switchyard.
 *
 * Icons whose coloured disks would overlap at the map's zoom push each other
 * apart, each as little as it can along the line between them, so a row of
 * plants stays a row and a cluster keeps its shape; icons on one spot first
 * stand on a ring around it. The map draws a thin leader from each moved
 * icon to a dot at its true position. Zooming in until the disks stand apart
 * draws every icon at its true position again.
 *
 * Positions are Web Mercator pixels at the zoom step the labels use
 * (`object-label-layer.ts`): a layout holds while the map pans and changes
 * only when the zoom crosses an eighth step or the icons move. Each step lays
 * out at its lowest zoom, where icons lie closest, so nothing overlaps
 * anywhere within it. The map is drawn north up.
 */

export interface FanItem {
  readonly id: string
  /** The icon's true centre, in pixels. */
  readonly x: number
  readonly y: number
  /** The radius of the icon's coloured disk, in pixels. */
  readonly radiusPx: number
}

export interface FanPlace {
  readonly x: number
  readonly y: number
}

/** Air kept between two icons' disks, in px. */
export const fanGapPx = 4
/** Icons on one spot, up to this many, stand on one ring; more stand on a spiral. */
const ringMax = 8
/** How many rounds icons push each other apart before the layout stops. */
const maxRounds = 120
/** Icons closer than this stand on one spot, in px. */
const onSpotPx = 0.5
/** A push parts two icons this much beyond the air they need, so they settle in few rounds, in px. */
const pushSlackPx = 0.25
/** Two icons this little short of their air count as apart: a fraction of the gap, never a visible overlap, in px. */
const settledPx = 0.5
/** The share of its pushes an icon takes each round: less than all, so pushes from several sides settle rather than overshoot. */
const pushShare = 0.8
/** An icon moved less than this is drawn at its true position, in px. */
const movedPx = 0.5
const goldenAngle = Math.PI * (3 - Math.sqrt(5))

/** The slots of a ring of `count` icons whose centres stand `spacing` apart, clockwise from angle 0. */
const ringSlots = (count: number, spacing: number): ReadonlyArray<FanPlace> => {
  const radius = spacing / (2 * Math.sin(Math.PI / count))
  return Array.from({ length: count }, (_, index) => {
    const angle = 2 * Math.PI * index / count
    return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) }
  })
}

const unitSpiral = (count: number): ReadonlyArray<FanPlace> =>
  Array.from({ length: count }, (_, index) => {
    const radius = Math.sqrt(index + 0.5)
    return { x: radius * Math.cos(index * goldenAngle), y: radius * Math.sin(index * goldenAngle) }
  })

const closestPair = (places: ReadonlyArray<FanPlace>): number => {
  let closest = Infinity
  for (let a = 0; a < places.length; a += 1) {
    for (let b = a + 1; b < places.length; b += 1) closest = Math.min(closest, Math.hypot(places[a]!.x - places[b]!.x, places[a]!.y - places[b]!.y))
  }
  return closest
}

const spiralScale = new Map<number, number>()
/** A sunflower spiral of `count` icons, scaled so its closest two stand `spacing` apart; innermost first. */
const spiralSlots = (count: number, spacing: number): ReadonlyArray<FanPlace> => {
  const unit = unitSpiral(count)
  const scale = spiralScale.get(count) ?? closestPair(unit)
  spiralScale.set(count, scale)
  return unit.map(place => ({ x: place.x * spacing / scale, y: place.y * spacing / scale }))
}

/** The slots of a fan of `count` icons around its middle, with their centres at least `spacing` apart. */
export const fanSlots = (count: number, spacing: number): ReadonlyArray<FanPlace> => {
  if (count < 2) return [{ x: 0, y: 0 }]
  return count <= ringMax ? ringSlots(count, spacing) : spiralSlots(count, spacing)
}

const stackOf = (item: FanItem): string => `${Math.round(item.x / onSpotPx)}:${Math.round(item.y / onSpotPx)}`

/** A direction to part two icons on one spot by, the same for the same pair wherever they arrive from. */
const partingAngle = (a: string, b: string): number => {
  let hash = 0
  for (const char of a < b ? a + '|' + b : b + '|' + a) hash = (hash * 31 + char.charCodeAt(0)) | 0
  return (hash >>> 0) * goldenAngle
}

/**
 * Where each icon that must move is drawn instead; an icon that keeps its
 * true position is left out. Icons on one spot first stand on a ring (more
 * than eight on a spiral) around it, clockwise from the top in their draw
 * order; then every two icons whose disks still overlap push each other
 * apart along the line between them until none overlap, so a row of plants
 * stays a row and each icon moves as little as it can.
 */
export const fanOut = (items: ReadonlyArray<FanItem>): ReadonlyMap<string, FanPlace> => {
  // Ids order the work, so the same icons lay out the same whatever order they arrive in; draw order breaks ties on a spot.
  const order = items.map((item, index) => ({ item, index })).sort((a, b) => (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : a.index - b.index))
  const xs = order.map(entry => entry.item.x)
  const ys = order.map(entry => entry.item.y)
  const radii = order.map(entry => entry.item.radiusPx)
  const stacks = new Map<string, number[]>()
  order.forEach((entry, at) => {
    const key = stackOf(entry.item)
    const stack = stacks.get(key)
    if (stack === undefined) stacks.set(key, [at])
    else stack.push(at)
  })
  for (const stack of stacks.values()) {
    if (stack.length < 2) continue
    stack.sort((a, b) => order[a]!.index - order[b]!.index)
    const radius = Math.max(...stack.map(at => radii[at]!))
    const slots = fanSlots(stack.length, 2 * radius + fanGapPx)
    const [x, y] = [xs[stack[0]!]!, ys[stack[0]!]!]
    // The ring starts at the top and runs clockwise (the screen's y points down).
    stack.forEach((at, slot) => {
      xs[at] = x + slots[slot]!.y
      ys[at] = y - slots[slot]!.x
    })
  }
  const maxRadius = radii.reduce((largest, radius) => Math.max(largest, radius), 0)
  const cellPx = 2 * maxRadius + fanGapPx
  // A cell's key as one number: a Web Mercator pixel grid has far fewer than 1e8 cells a side at any zoom.
  const keyOf = (cx: number, cy: number): number => cx * 1e8 + cy
  const cellOf = (at: number): number => keyOf(Math.floor(xs[at]! / cellPx), Math.floor(ys[at]! / cellPx))
  const cellKeys = xs.map((_, at) => cellOf(at))
  const cells = new Map<number, Set<number>>()
  const enter = (at: number): void => {
    const cell = cells.get(cellKeys[at]!)
    if (cell === undefined) cells.set(cellKeys[at]!, new Set([at]))
    else cell.add(at)
  }
  xs.forEach((_, at) => enter(at))
  const shiftX = new Float64Array(xs.length)
  const shiftY = new Float64Array(xs.length)
  const active = new Uint8Array(xs.length).fill(1)
  let moving: ReadonlyArray<number> = xs.map((_, at) => at)
  for (let round = 0; round < maxRounds && moving.length > 0; round += 1) {
    // Every push of a round is measured from where the icons stood at its start, so no push overtakes another and a row keeps its order.
    // Only icons that moved last round can overlap anew; each pair counts once.
    const pushed = new Set<number>()
    for (const a of moving) {
      const [cx, cy] = [Math.floor(xs[a]! / cellPx), Math.floor(ys[a]! / cellPx)]
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (const b of cells.get(keyOf(cx + dx, cy + dy)) ?? []) {
            if (b === a || (active[b] === 1 && b < a)) continue
            const need = radii[a]! + radii[b]! + fanGapPx
            let [ux, uy] = [xs[b]! - xs[a]!, ys[b]! - ys[a]!]
            let distance = Math.hypot(ux, uy)
            if (distance >= need - settledPx) continue
            if (distance < 1e-6) {
              const angle = partingAngle(order[a]!.item.id, order[b]!.item.id)
              ;[ux, uy, distance] = [Math.cos(angle), Math.sin(angle), 0]
            } else {
              ux /= distance
              uy /= distance
            }
            const push = (need - distance) / 2 + pushSlackPx
            shiftX[a] = shiftX[a]! - ux * push
            shiftY[a] = shiftY[a]! - uy * push
            shiftX[b] = shiftX[b]! + ux * push
            shiftY[b] = shiftY[b]! + uy * push
            pushed.add(a)
            pushed.add(b)
          }
        }
      }
    }
    for (const at of moving) active[at] = 0
    for (const at of pushed) {
      xs[at] = xs[at]! + shiftX[at]! * pushShare
      ys[at] = ys[at]! + shiftY[at]! * pushShare
      shiftX[at] = 0
      shiftY[at] = 0
      active[at] = 1
      const key = cellOf(at)
      if (key === cellKeys[at]) continue
      cells.get(cellKeys[at]!)!.delete(at)
      cellKeys[at] = key
      enter(at)
    }
    moving = [...pushed]
  }
  const places = new Map<string, FanPlace>()
  order.forEach((entry, at) => {
    if (Math.hypot(xs[at]! - entry.item.x, ys[at]! - entry.item.y) >= movedPx) places.set(entry.item.id, { x: xs[at]!, y: ys[at]! })
  })
  return places
}

/** The zoom step a layout is made for: the labels' eighth steps (`object-label-layer.ts`). */
export const fanZoomOf = (zoom: number): number => Math.floor(zoom * 8) / 8

/** A Web Mercator pixel at a zoom, back in degrees (`label-placement.ts`, `mercatorPixels`). */
export const lonLatOfPixels = (x: number, y: number, zoom: number): readonly [number, number] => {
  const worldPx = 512 * 2 ** zoom
  return [x / worldPx * 360 - 180, Math.atan(Math.sinh(Math.PI - 2 * Math.PI * y / worldPx)) * 180 / Math.PI]
}

/** A moved icon's leader: from where it is drawn to where it truly is. */
export interface PointLeader {
  readonly id: string
  readonly drawnAt: Position3
  readonly trueAt: Position3
}

export interface DeclutteredPoints {
  /** The points as drawn, in draw order: the input itself when no icon moves. */
  readonly points: ReadonlyArray<OperationalPointFeature>
  readonly leaders: ReadonlyArray<PointLeader>
  /** Where each moved object's icon is drawn, by object id. */
  readonly drawnAt: ReadonlyMap<string, Position3>
}

/** The operational points as the map draws them at a zoom step, fanned out where their icons would overlap. */
export const declutterPoints = (points: ReadonlyArray<OperationalPointFeature>, zoom: number): DeclutteredPoints => {
  const places = fanOut(points.map(point => ({
    ...mercatorPixels(point.position[0], point.position[1], zoom),
    id: point.id,
    radiusPx: statusDiskRadiusPx(point.sizePx),
  })))
  if (places.size === 0) return { points, leaders: [], drawnAt: new Map() }
  const drawnAt = new Map<string, Position3>()
  const leaders: PointLeader[] = []
  const drawn = points.map(point => {
    const place = places.get(point.id)
    if (place === undefined) return point
    const [lon, lat] = lonLatOfPixels(place.x, place.y, zoom)
    const position: Position3 = [lon, lat, point.position[2]]
    drawnAt.set(point.id, position)
    leaders.push({ id: point.id, drawnAt: position, trueAt: point.position })
    return { ...point, position }
  })
  return { points: drawn, leaders, drawnAt }
}
