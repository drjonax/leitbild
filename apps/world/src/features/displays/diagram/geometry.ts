// Grid arithmetic and the two orientations. Layout runs in abstract axes: `f`
// along the flow (downstream increases) and `c` across it (lane order
// increases). Only the last step maps them to screen x/y.
import type { Face } from './diagram.ts'

export type Orientation = 'leftToRight' | 'bottomToTop'
export const ORIENTATIONS: ReadonlyArray<Orientation> = ['leftToRight', 'bottomToTop']

/** A face in abstract axes: `-f` faces upstream, `+f` downstream, `-c`/`+c` across. */
export type AxisFace = '-f' | '+f' | '-c' | '+c'

export interface AxisBox {
  readonly f0: number
  readonly f1: number
  readonly c0: number
  readonly c1: number
}

export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export type Point = readonly [number, number]

// Values are sums of integers and halves; the epsilon only absorbs float noise.
const EPSILON = 1e-6
export const ceilTo = (value: number, step: number): number => Math.ceil(value / step - EPSILON) * step
export const floorTo = (value: number, step: number): number => Math.floor(value / step + EPSILON) * step
export const roundTo = (value: number, step: number): number => Math.round(value / step) * step
export const onStep = (value: number, step: number): boolean => Math.abs(value / step - Math.round(value / step)) < EPSILON

const SCREEN_FACES: Readonly<Record<Orientation, Readonly<Record<AxisFace, Face>>>> = {
  leftToRight: { '-f': 'left', '+f': 'right', '-c': 'top', '+c': 'bottom' },
  bottomToTop: { '-f': 'bottom', '+f': 'top', '-c': 'left', '+c': 'right' },
}

export const screenFace = (orientation: Orientation, face: AxisFace): Face => SCREEN_FACES[orientation][face]

export const axisFace = (orientation: Orientation, face: Face): AxisFace => {
  const faces = SCREEN_FACES[orientation]
  const found = (Object.keys(faces) as AxisFace[]).find(key => faces[key] === face)
  if (found === undefined) throw new Error(`no axis face for ${face}`)
  return found
}

/** Screen point before the final translation; bottom-to-top flips f so flow runs up. */
export const toScreen = (orientation: Orientation, f: number, c: number): Point =>
  orientation === 'leftToRight' ? [f, c] : [c, -f]

export const toScreenRect = (orientation: Orientation, box: AxisBox): Rect =>
  orientation === 'leftToRight'
    ? { x: box.f0, y: box.c0, width: box.f1 - box.f0, height: box.c1 - box.c0 }
    : { x: box.c0, y: -box.f1, width: box.c1 - box.c0, height: box.f1 - box.f0 }

export const rectsOverlap = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width - EPSILON && b.x < a.x + a.width - EPSILON && a.y < b.y + b.height - EPSILON && b.y < a.y + a.height - EPSILON

export const grow = (rect: Rect, by: number): Rect => ({ x: rect.x - by, y: rect.y - by, width: rect.width + 2 * by, height: rect.height + 2 * by })

export const translateRect = (rect: Rect, dx: number, dy: number): Rect => ({ x: rect.x + dx, y: rect.y + dy, width: rect.width, height: rect.height })
