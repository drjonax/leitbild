// The room an embedded display's content needs, in the frame's own CSS pixels
// (DisplayFrameExtent in display-frame-protocol.ts). Advice is as tall as its
// content and stretches in width down to the narrowest width that shows its
// drawing whole. A generated display is drawn for its frame and needs the
// frame plus whatever its scrollers cannot show.
import type { DisplayFrameExtent } from './display-frame-protocol.ts'

export type DisplayExtent = Omit<DisplayFrameExtent, 'type'>

/** Advice without a drawing still needs this much width for its trends, readouts and alarms. */
export const ADVICE_MIN_WIDTH = 360

export interface ScrollerMetrics {
  readonly scrollWidth: number
  readonly clientWidth: number
  readonly scrollHeight: number
  readonly clientHeight: number
}

export const adviceExtent = (content: {
  readonly width: number
  readonly height: number
  /** The natural width of the widest drawing; 0 without one. */
  readonly widestDrawing: number
  /** The card's horizontal padding around its panels. */
  readonly padding: number
}): DisplayExtent => ({
  kind: 'advice',
  minWidth: Math.ceil(Math.max(ADVICE_MIN_WIDTH, content.widestDrawing === 0 ? 0 : content.widestDrawing + content.padding)),
  width: Math.ceil(content.width),
  height: Math.ceil(content.height),
})

/** The frame plus the largest overflow of any scroller; a generated display needs no less than that to show without scrolling. */
export const generatedExtent = (viewport: { readonly width: number; readonly height: number }, scrollers: ReadonlyArray<ScrollerMetrics>): DisplayExtent => {
  const width = Math.ceil(viewport.width + Math.max(0, ...scrollers.map(scroller => scroller.scrollWidth - scroller.clientWidth)))
  const height = Math.ceil(viewport.height + Math.max(0, ...scrollers.map(scroller => scroller.scrollHeight - scroller.clientHeight)))
  return { kind: 'generated', minWidth: width, width, height }
}

// Content settles (a sample re-rendered, a drawing arrived) before its room is measured.
const EXTENT_SETTLE_MS = 150
// A generated display's scrollers: its panels and the drawing's viewport.
const GENERATED_SCROLLERS = '.panels, .mimic-panel .viewport'
// An advice drawing at its natural size (MimicPanel scales it inside, by transform).
const ADVICE_DRAWINGS = '.mimic-panel .drawing'

/**
 * Measures the card whenever its content or size changes and reports the
 * room it needs once things settle; the reporter drops repeats. Nothing is
 * reported while the view connects (`drawing` undefined), nor for a generated
 * drawing measured in a frame of another size than the one it was drawn for:
 * a new drawing for the frame is on its way, and the window must not fit its
 * zoom to the one it replaces.
 */
export const observeDisplayExtent = (config: {
  readonly kind: 'advice' | 'generated'
  readonly card: HTMLElement
  /** What the view draws now, a new value for every drawing; undefined while it connects. */
  readonly drawing: () => object | undefined
  readonly report: (extent: DisplayExtent) => void
}): (() => void) => {
  const { card } = config
  let timer: ReturnType<typeof setTimeout> | undefined
  let drawnFor: { readonly drawing: object; readonly width: number; readonly height: number } | null = null
  const watched = new Set<Element>()

  const measure = (): DisplayExtent | null => {
    const drawing = config.drawing()
    if (drawing === undefined) return null
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    if (config.kind === 'advice') {
      const style = getComputedStyle(card)
      const box = card.getBoundingClientRect()
      return adviceExtent({
        width: box.width,
        height: box.height,
        widestDrawing: Math.max(0, ...[...card.querySelectorAll<HTMLElement>(ADVICE_DRAWINGS)].map(element => element.offsetWidth)),
        padding: Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight),
      })
    }
    if (drawnFor?.drawing !== drawing) drawnFor = { drawing, ...viewport }
    if (drawnFor.width !== viewport.width || drawnFor.height !== viewport.height) return null
    return generatedExtent(viewport, [...card.querySelectorAll<HTMLElement>(GENERATED_SCROLLERS)])
  }

  const settle = (): void => {
    watch()
    const extent = measure()
    if (extent !== null && extent.width >= 1 && extent.height >= 1) config.report(extent)
  }
  const schedule = (): void => {
    clearTimeout(timer)
    timer = setTimeout(settle, EXTENT_SETTLE_MS)
  }
  const resized = new ResizeObserver(schedule)
  // Any re-render may change the room: a sample, a drawing for a new size, the drawing's fonts arriving.
  const changed = new MutationObserver(schedule)

  // A generated display's scrollers do not change size when their content does, so their content is watched too.
  const watch = (): void => {
    const scrollers = config.kind === 'generated' ? [...card.querySelectorAll(GENERATED_SCROLLERS)] : []
    const next = new Set<Element>([card, ...scrollers, ...scrollers.flatMap(scroller => [...scroller.children])])
    for (const element of watched) {
      if (next.has(element)) continue
      resized.unobserve(element)
      watched.delete(element)
    }
    for (const element of next) {
      if (watched.has(element)) continue
      resized.observe(element)
      watched.add(element)
    }
  }

  watch()
  changed.observe(card, { childList: true, subtree: true, attributes: true, characterData: true })
  schedule()
  return () => {
    clearTimeout(timer)
    resized.disconnect()
    changed.disconnect()
  }
}
