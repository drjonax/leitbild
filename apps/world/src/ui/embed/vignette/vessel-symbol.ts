// A pressure vessel drawn from the model in OpenBridge's tokens (D-2): its
// head on a flange, its body, its bottom dome, collars where the layout
// brought its pipes, its level as the fill, and where it heats, its core
// region with each part it inserts (a rod bank) hanging into it by its
// inserted length, and what of it stands withdrawn drawn above the region,
// at least ROD_SHOWN long, so a bank out of the core is seen as out, not
// missing. Pure geometry in the box's own px; Vessel.svelte
// draws it. The fill is the level the model reads (a collapsed level over
// the interior, not a water surface), so nothing marks the core's top as
// covered or uncovered.

export interface VesselGeometry {
  readonly dome: string
  readonly flange: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly body: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly bottom: string
  readonly collars: ReadonlyArray<{ readonly x: number; readonly y: number; readonly width: number; readonly height: number }>
  /** The fill's top, and its level line: null where the level is not known (the interior then reads as unknown). */
  readonly fill: { readonly top: number } | null
  readonly core: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
    /** 45° hatch lines inside it, clipped to it. */
    readonly hatch: ReadonlyArray<{ readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number }>
    /**
     * Each part: the length it is inserted, down from the core's top, and
     * the length shown of it withdrawn, up from the core's top; both null
     * where its reading is not known.
     */
    readonly bars: ReadonlyArray<{ readonly x: number; readonly width: number; readonly inserted: number | null; readonly withdrawn: number | null }>
  } | null
}

/** The head's dome and flange, the bottom dome, and a core region's least height, in px (register: reactor-vessel). */
export const VESSEL_SHAPE = { dome: 30, flange: 6, bottomDome: 20, coreBand: 72 } as const
const { dome: DOME, flange: FLANGE, bottomDome: BOTTOM_DOME, coreBand: CORE_BAND } = VESSEL_SHAPE

/** Where the vessel stands in its box: its span across it, its nozzles in drawing px, and its core region, if any. */
export interface VesselDrawing {
  readonly span: { readonly x: number; readonly width: number }
  readonly nozzles: ReadonlyArray<{ readonly x: number; readonly y: number; readonly face: 'top' | 'right' | 'bottom' | 'left' }>
  readonly core: 'band' | 'overlap' | null
}
/** Overlapping its nozzles, a core region takes at least this share of a tall body, so its rods read at a glance. */
const CORE_SHARE = 0.55
/** A collar is this tall across its pipe. */
const COLLAR = 10
/** The core region keeps this far inside the body, per 72 px of width. */
const CORE_INSET = 6
const HATCH_PITCH = 6
/** A part not fully in shows this much of it above the core region (ISA-101 review of run 26c: 2 px ticks at power). */
export const ROD_SHOWN = 12

/**
 * How far a part is in: its reading over its range, from the end it is out
 * at to the end it is fully in at; null where it reads nothing.
 */
export const insertedFraction = (value: number | null, range: { readonly min: number; readonly max: number }, insertedAt: 'min' | 'max'): number | null => {
  if (value === null || !Number.isFinite(value)) return null
  const fraction = insertedAt === 'min' ? (range.max - value) / (range.max - range.min) : (value - range.min) / (range.max - range.min)
  return Math.min(1, Math.max(0, fraction))
}

export const vesselGeometry = (input: {
  /** The box's height; the vessel stands across its span of the box. */
  readonly height: number
  /** The box's place on the drawing: its nozzles are given in drawing px. */
  readonly origin: { readonly x: number; readonly y: number }
  readonly drawing: VesselDrawing
  /** The fill, in percent of the interior; null where it is not known. */
  readonly level: number | null
  /** Each part's inserted fraction (insertedFraction), in its groups. */
  readonly groups: ReadonlyArray<ReadonlyArray<number | null>>
}): VesselGeometry => {
  // The vessel stands in its own span of the box, as wide as that span.
  const { x: left, width: w } = input.drawing.span
  const h = input.height
  const scale = w / 72
  // The body sits inside the span, the head's dome on a flange as wide as the span, wider than the body.
  const inset = 2 + w / 12
  const cx = left + w / 2
  const domeRx = w / 2 - inset / 2
  const bodyTop = DOME - 2 + FLANGE
  const bodyBottom = h - BOTTOM_DOME
  const dome = `M ${cx - domeRx} ${DOME} A ${domeRx} ${DOME} 0 0 1 ${cx + domeRx} ${DOME} Z`
  const bottom = `M ${left + inset} ${bodyBottom} A ${w / 2 - inset} ${BOTTOM_DOME} 0 0 0 ${left + w - inset} ${bodyBottom} Z`
  // A collar where each pipe reaches it, from the span's edge to the body.
  const collars = input.drawing.nozzles.map(nozzle => {
    const x = nozzle.x - input.origin.x
    const y = nozzle.y - input.origin.y
    return nozzle.face === 'left' ? { x: left, y: y - COLLAR / 2, width: inset, height: COLLAR }
      : nozzle.face === 'right' ? { x: left + w - inset, y: y - COLLAR / 2, width: inset, height: COLLAR }
        : nozzle.face === 'top' ? { x: x - COLLAR / 2, y: 0, width: COLLAR, height: inset }
          : { x: x - COLLAR / 2, y: h - inset, width: COLLAR, height: inset }
  })
  // The fill spans the interior from the bottom dome's lowest point to the head's highest.
  const fill = input.level === null ? null : { top: (h - 4) - Math.min(1, Math.max(0, input.level / 100)) * (h - 8) }
  const core = input.drawing.core === null ? null : (() => {
    const x = left + inset + CORE_INSET * scale
    // Overlapping its nozzles, it leaves room above it for its withdrawn parts to show.
    const band = input.drawing.core === 'band' ? CORE_BAND : Math.min(bodyBottom - bodyTop - ROD_SHOWN, Math.max(CORE_BAND, Math.round(CORE_SHARE * (bodyBottom - bodyTop))))
    const y = Math.max(bodyTop, bodyBottom - band)
    const width = w - 2 * (x - left)
    const height = bodyBottom - y
    const hatch = Array.from({ length: Math.ceil((width + height) / HATCH_PITCH) }, (_, index) => {
      const offset = (index + 1) * HATCH_PITCH
      return { x1: x + offset, y1: y, x2: x + offset - height, y2: y + height }
    })
    // The parts in their groups across the core, centred: a bar a 24th of the width, gaps a 36th, groups a 12th apart.
    const bar = w / 24
    const gap = w / 36
    const groupGap = w / 12
    const sizes = input.groups.map(group => group.length * bar + (group.length - 1) * gap)
    let next = cx - (sizes.reduce((sum, size) => sum + size, 0) + (input.groups.length - 1) * groupGap) / 2
    const bars = input.groups.flatMap(group => {
      const placed = group.map((inserted, index) => ({
        x: next + index * (bar + gap),
        width: bar,
        inserted: inserted === null ? null : inserted * height,
        withdrawn: inserted === null ? null : inserted >= 1 ? 0 : Math.min(ROD_SHOWN, y - bodyTop),
      }))
      next += group.length * bar + (group.length - 1) * gap + groupGap
      return placed
    })
    return { x, y, width, height, hatch, bars }
  })()
  return {
    dome,
    flange: { x: left, y: DOME - 2, width: w, height: FLANGE },
    body: { x: left + inset, y: bodyTop, width: w - 2 * inset, height: bodyBottom - bodyTop },
    bottom,
    collars,
    fill,
    core,
  }
}
