import type { Face } from './layout/index.ts'
import { openBridgeDevice } from './text-metrics.ts'

// Where a reactor vessel stands in the box the layout gave it. A vessel
// stands taller than wide: in a box wider than that (a hub whose ports the
// layout put on its lower face, along the routes its pipes arrive by), it is
// drawn at the box's height beside its name and rows where they stand
// beside the box, else where most of its pipes arrive, and a pipe that
// reaches the box beside it continues inside the box, up (or down) and across
// to a nozzle on the vessel's side. The box's room is the layout's, so these
// runs cross nothing but one another, which their levels keep them from.

/** A vessel is at most this wide for its height. */
export const VESSEL_ASPECT = 0.6
/** The levels pipes continue at inside the box, this far apart and this far inside the body. */
const LEVEL_PITCH = 12
const LEVEL_INSET = 6

export interface VesselNozzle {
  readonly x: number
  readonly y: number
  readonly face: Face
}

export interface VesselFit {
  /** The vessel's own span across its box, in the box's px. */
  readonly span: { readonly x: number; readonly width: number }
  /** Where pipes reach the vessel, in drawing px: as the layout placed them, or at its side where a pipe continues to it. */
  readonly nozzles: ReadonlyArray<VesselNozzle>
  /** Each port a pipe continues from, and the points it continues along to the vessel, in drawing px. */
  readonly routes: ReadonlyArray<{ readonly from: { readonly x: number; readonly y: number }; readonly points: ReadonlyArray<readonly [number, number]> }>
}

export const fitVessel = (box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }, ports: ReadonlyArray<VesselNozzle>, textSide: Face | null): VesselFit => {
  const width = Math.min(box.width, 2 * Math.floor((box.height * VESSEL_ASPECT) / 2))
  const sideways = ports.filter(port => port.face === 'left' || port.face === 'right')
  const across = ports.filter(port => port.face === 'top' || port.face === 'bottom')
  // Beside the face its sideways pipes reach; else beside its text; else where it takes the most of the pipes that reach its top or bottom.
  const x = width === box.width ? 0
    : sideways.some(port => port.face === 'left') ? 0
      : sideways.some(port => port.face === 'right') ? box.width - width
        : textSide === 'left' ? 0
          : textSide === 'right' ? box.width - width
            : bestWindow(across.map(port => port.x - box.x), width, box.width)
  const inside = (port: VesselNozzle): boolean => port.x - box.x >= x && port.x - box.x <= x + width
  const outside = across.filter(port => !inside(port))
  const bodyTop = box.y + openBridgeDevice.reactorVessel.dome - 2 + openBridgeDevice.reactorVessel.flange
  const bodyBottom = box.y + box.height - openBridgeDevice.reactorVessel.bottomDome
  // A pipe nearer the vessel turns nearer the face it arrives at, so none crosses another's rise.
  const routes = (['bottom', 'top'] as const).flatMap(face => {
    const arriving = [...new Map(outside.filter(port => port.face === face).map(port => [`${port.x},${port.y}`, port])).values()]
      .sort((a, b) => distance(a, box.x + x, width) - distance(b, box.x + x, width))
    const room = Math.max(1, bodyBottom - bodyTop - 2 * LEVEL_INSET)
    const pitch = arriving.length <= 1 ? LEVEL_PITCH : Math.min(LEVEL_PITCH, room / (arriving.length - 1))
    return arriving.map((port, at) => {
      const level = face === 'bottom' ? bodyBottom - LEVEL_INSET - at * pitch : bodyTop + LEVEL_INSET + at * pitch
      const edge = port.x < box.x + x ? box.x + x : box.x + x + width
      return { from: { x: port.x, y: port.y }, points: [[port.x, level], [edge, level]] as ReadonlyArray<readonly [number, number]>, nozzle: { x: edge, y: level, face: (edge === box.x + x ? 'left' : 'right') as Face } }
    })
  })
  const moved = new Set(routes.map(route => `${route.from.x},${route.from.y}`))
  return {
    span: { x, width },
    nozzles: [...ports.filter(port => !moved.has(`${port.x},${port.y}`)), ...routes.map(route => route.nozzle)],
    routes: routes.map(({ from, points }) => ({ from, points })),
  }
}

const distance = (port: VesselNozzle, x0: number, width: number): number =>
  port.x < x0 ? x0 - port.x : port.x - (x0 + width)

/** The start of the window of this width that holds the most of these points, the leftmost of equals. */
const bestWindow = (points: ReadonlyArray<number>, width: number, room: number): number => {
  const starts = [0, room - width, ...points.map(point => Math.min(room - width, Math.max(0, point - width / 2)))].sort((a, b) => a - b)
  const held = (start: number) => points.filter(point => point >= start && point <= start + width).length
  return starts.reduce((best, start) => (held(start) > held(best) ? start : best), starts[0]!)
}
