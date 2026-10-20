// Flow-axis placement: layers and channels stack upstream to downstream. A
// layer's thickness is what its items reserve (symbol, text, frame and flap).
// A channel holds its tracks clear of the symbol faces (so every bend has
// room) and clear of anything reserved (so no pipe touches text): a grid in a
// channel that crossings pass, half a grid in a crossing-free one, where no
// crossing gap needs room beside a bend. A channel with no track keeps the
// text clearance between its layers' reservations and a grid of pipe between
// their faces.
import type { DiagramProfile } from './diagram.ts'
import { ceilTo } from './geometry.ts'
import type { ChannelPlan } from './channels.ts'

/** How far a layer's items reach below and above the layer axis. */
export interface LayerExtent {
  /** Reservations (symbol, text, frame) below and above the axis. */
  readonly lowReserve: number
  readonly highReserve: number
  /** Symbol faces where pipes attach, below and above the axis. */
  readonly lowFace: number
  readonly highFace: number
}

export interface AlongPlacement {
  readonly axis: ReadonlyArray<number>
  /** Per channel, the position of track 0. */
  readonly firstTrack: ReadonlyArray<number>
}

export const placeAlong = (profile: DiagramProfile, extents: ReadonlyArray<LayerExtent>, plan: ChannelPlan): AlongPlacement => {
  const grid = profile.grid
  const outline = profile.pipe.outline
  const axis: number[] = []
  const firstTrack: number[] = []
  // Clearances of a track in a channel: from faces (bend room) and from reservations (pipe off text).
  const faceClear = (channel: number): number => (plan.fine[channel] ? grid / 2 : grid)
  const reserveClear = (channel: number): number => (plan.fine[channel] ? outline / 2 + 2 : grid / 2)
  const trackStep = (channel: number): number => (plan.fine[channel] ? grid / 2 : grid)
  const firstAfter = (channel: number, base: number, extent: LayerExtent): number =>
    ceilTo(Math.max(base + extent.highFace + faceClear(channel), base + extent.highReserve + reserveClear(channel)), trackStep(channel))
  const axisAfter = (channel: number, extent: LayerExtent): number => {
    const last = firstTrack[channel]! + (plan.offset[channel]!.at(-1) ?? 0)
    return ceilTo(Math.max(last + faceClear(channel) + extent.lowFace, last + reserveClear(channel) + extent.lowReserve), grid)
  }
  extents.forEach((extent, layer) => {
    const channel = layer
    const count = plan.tracks[channel]!
    if (layer === 0) {
      firstTrack.push(count > 0 ? 0 : Number.NaN)
      axis.push(count > 0 ? axisAfter(channel, extent) : ceilTo(extent.lowReserve, grid))
      return
    }
    const previous = extents[layer - 1]!
    const base = axis[layer - 1]!
    if (count > 0) {
      firstTrack.push(firstAfter(channel, base, previous))
      axis.push(axisAfter(channel, extent))
    } else {
      firstTrack.push(Number.NaN)
      axis.push(ceilTo(base + Math.max(previous.highReserve + profile.textClearance + extent.lowReserve, previous.highFace + grid + extent.lowFace), grid))
    }
  })
  const last = extents.length
  firstTrack.push(plan.tracks[last]! > 0 ? firstAfter(last, axis[last - 1]!, extents[last - 1]!) : Number.NaN)
  return { axis, firstTrack }
}
