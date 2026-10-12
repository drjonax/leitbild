/**
 * Where object labels go on the map so they never overlap into unreadable
 * text. Each label tries the slots beside its icon in turn (below, above,
 * right, left) and takes the first whose box overlaps no label placed before
 * it and no other icon; a label with no free slot is not drawn, and its
 * object still shows its card on hover or tap. The selected object places
 * first and always shows its label; then highlighted objects, then higher
 * priority, then shorter labels.
 *
 * Positions are Web Mercator pixels at the map's zoom, so a placement holds
 * while the map pans and changes only with zoom or the labels themselves.
 * The map is drawn north up, which the boxes assume.
 */

export type LabelSlot = 'below' | 'above' | 'right' | 'left'

const slots: ReadonlyArray<LabelSlot> = ['below', 'above', 'right', 'left']

export interface LabelCandidate {
  readonly id: string
  /** The icon's centre, in pixels. */
  readonly x: number
  readonly y: number
  readonly text: string
  readonly iconSizePx: number
  readonly selected: boolean
  readonly highlighted: boolean
  /** Higher places earlier. */
  readonly priority: number
}

/** An icon a label must not cover: every drawn point, labelled or not. */
export interface LabelObstacle {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly iconSizePx: number
}

export const labelFontPx = 11
/** The background's padding around the text, as the label layer draws it. */
export const labelPaddingPx: readonly [number, number] = [3, 1]
/** An average glyph of the label font at 11 px, semibold system UI. */
const glyphWidthPx = 6.4
const lineHeightPx = labelFontPx + 2
/** Air kept between boxes. */
const gapPx = 1

interface Box { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }

/** The label's box: its text and background padding. */
export const labelSize = (text: string): { readonly width: number; readonly height: number } => ({
  width: text.length * glyphWidthPx + 2 * labelPaddingPx[0],
  height: lineHeightPx + 2 * labelPaddingPx[1],
})

/** How the label layer anchors a label in a slot: its pixel offset from the icon's centre and its text alignment. */
export const slotAnchor = (slot: LabelSlot, iconSizePx: number): {
  readonly offset: readonly [number, number]
  readonly textAnchor: 'middle' | 'start' | 'end'
  readonly baseline: 'top' | 'bottom' | 'center'
} => {
  const vertical = iconSizePx * 0.74 + 3
  const horizontal = iconSizePx * 0.62 + 4
  switch (slot) {
    case 'below': return { offset: [0, vertical], textAnchor: 'middle', baseline: 'top' }
    case 'above': return { offset: [0, -vertical], textAnchor: 'middle', baseline: 'bottom' }
    case 'right': return { offset: [horizontal, 0], textAnchor: 'start', baseline: 'center' }
    case 'left': return { offset: [-horizontal, 0], textAnchor: 'end', baseline: 'center' }
  }
}

const boxIn = (candidate: LabelCandidate, slot: LabelSlot): Box => {
  const { width, height } = labelSize(candidate.text)
  const { offset, textAnchor, baseline } = slotAnchor(slot, candidate.iconSizePx)
  const x = candidate.x + offset[0]
  const y = candidate.y + offset[1]
  const left = textAnchor === 'middle' ? x - width / 2 : textAnchor === 'start' ? x - labelPaddingPx[0] : x - width + labelPaddingPx[0]
  const top = baseline === 'top' ? y - labelPaddingPx[1] : baseline === 'bottom' ? y - height + labelPaddingPx[1] : y - height / 2
  return { left, top, right: left + width, bottom: top + height }
}

const iconBox = (obstacle: LabelObstacle): Box => {
  const half = obstacle.iconSizePx / 2
  return { left: obstacle.x - half, top: obstacle.y - half, right: obstacle.x + half, bottom: obstacle.y + half }
}

const overlaps = (a: Box, b: Box): boolean =>
  a.left < b.right + gapPx && b.left < a.right + gapPx && a.top < b.bottom + gapPx && b.top < a.bottom + gapPx

/** A uniform grid over boxes, so a placement checks only its neighbours. */
const createGrid = () => {
  const cellPx = 64
  const cells = new Map<string, Array<{ readonly owner: string; readonly box: Box }>>()
  const keys = (box: Box): string[] => {
    const result: string[] = []
    for (let cx = Math.floor(box.left / cellPx); cx <= Math.floor(box.right / cellPx); cx += 1) {
      for (let cy = Math.floor(box.top / cellPx); cy <= Math.floor(box.bottom / cellPx); cy += 1) result.push(`${cx}:${cy}`)
    }
    return result
  }
  return {
    add: (owner: string, box: Box): void => {
      for (const key of keys(box)) {
        const cell = cells.get(key)
        if (cell === undefined) cells.set(key, [{ owner, box }])
        else cell.push({ owner, box })
      }
    },
    /** Whether the box overlaps a box of another owner. */
    blocked: (owner: string, box: Box): boolean =>
      keys(box).some(key => cells.get(key)?.some(entry => entry.owner !== owner && overlaps(entry.box, box)) === true),
  }
}

const placementOrder = (a: LabelCandidate, b: LabelCandidate): number =>
  Number(b.selected) - Number(a.selected)
  || Number(b.highlighted) - Number(a.highlighted)
  || b.priority - a.priority
  || a.text.length - b.text.length
  || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** The slot each drawn label takes; a label left out has no free slot. */
export const placeLabels = (candidates: ReadonlyArray<LabelCandidate>, obstacles: ReadonlyArray<LabelObstacle>): ReadonlyMap<string, LabelSlot> => {
  const icons = createGrid()
  for (const obstacle of obstacles) icons.add(obstacle.id, iconBox(obstacle))
  const labels = createGrid()
  const placed = new Map<string, LabelSlot>()
  for (const candidate of [...candidates].sort(placementOrder)) {
    const free = slots.find(slot => {
      const box = boxIn(candidate, slot)
      return !labels.blocked(candidate.id, box) && !icons.blocked(candidate.id, box)
    })
    const slot = free ?? (candidate.selected ? 'below' : undefined)
    if (slot === undefined) continue
    placed.set(candidate.id, slot)
    labels.add(candidate.id, boxIn(candidate, slot))
  }
  return placed
}

/** A position in Web Mercator pixels at a zoom, as MapLibre's 512 px world lays it out. */
export const mercatorPixels = (lon: number, lat: number, zoom: number): { readonly x: number; readonly y: number } => {
  const worldPx = 512 * 2 ** zoom
  const clamped = Math.max(-85.0511, Math.min(85.0511, lat))
  const sin = Math.sin(clamped * Math.PI / 180)
  return {
    x: (lon + 180) / 360 * worldPx,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * worldPx,
  }
}
