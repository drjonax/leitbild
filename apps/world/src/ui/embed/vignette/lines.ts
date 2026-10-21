// Lines on a canvas through OpenBridge's connector-diagram renderer, in the
// palette's own pipe colours, sharp at the device pixel ratio times the zoom
// the display window paints at. Where the open line fades into the background
// more than an empty one does (day), it is drawn in its outline colour, as the
// mimic draws its pipes, so a live line never reads lighter than a dead one.
import { renderSegments, themeFromCss, type Segment } from '@oicl/connector-diagram'

// The largest canvas every browser allocates (iOS Safari: 4096 x 4096).
const MAX_CANVAS_PIXELS = 4096 * 4096

const luminance = (colour: string): number => {
  const [r, g, b] = (colour.match(/\d+(\.\d+)?/g) ?? ['0', '0', '0']).slice(0, 3).map(Number).map(channel => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}
const contrast = (left: string, right: string): number => {
  const [high, low] = [luminance(left), luminance(right)].sort((a, b) => b - a)
  return (high! + 0.05) / (low! + 0.05)
}

export const paintLines = (canvas: HTMLCanvasElement, size: { readonly width: number; readonly height: number }, segments: ReadonlyArray<Segment>, zoom: number): void => {
  const ratio = Math.min((window.devicePixelRatio || 1) * zoom, Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, size.width * size.height)))
  canvas.style.width = `${size.width}px`
  canvas.style.height = `${size.height}px`
  canvas.width = Math.round(size.width * ratio)
  canvas.height = Math.round(size.height * ratio)
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('A topology needs a 2D canvas to draw its lines')
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  const root = document.documentElement
  const styles = getComputedStyle(root)
  const palette = themeFromCss(name => styles.getPropertyValue(name), root.dataset.obcTheme)
  const background = styles.getPropertyValue('--container-background-color').trim()
  const theme = contrast(palette.pipeFillColor, background) < contrast(palette.pipeFillInverted, background) ? { ...palette, pipeFillColor: palette.pipeOutlineColor } : palette
  renderSegments(context, [...segments], { theme })
}
