// The OpenBridge elements a generated mimic draws with, loaded only when a
// display has a mimic. Importing a module registers its custom element; the
// factories below set every property explicitly (the truthful-state recipes),
// so no OpenBridge default can draw a state the model does not have: no
// "On"/"Off" text, no "000 %", no trend arrow, no badges, nothing clickable.
import '@oicl/openbridge-webcomponents/dist/automation/automation-button/automation-button.js'
import '@oicl/openbridge-webcomponents/dist/automation/automation-tank/automation-tank.js'
import '@oicl/openbridge-webcomponents/dist/automation/heat-exchanger/heat-exchanger.js'
import '@oicl/openbridge-webcomponents/dist/automation/valve-analoge-two-way-icon/valve-analog-two-way-icon.js'
import '@oicl/openbridge-webcomponents/dist/building-blocks/readout-block/readout-block.js'
import '@oicl/openbridge-webcomponents/dist/components/alert-frame/alert-frame.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-pump-on-horizontal.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-pump-off-horizontal.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-pump-static-horizontal.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-pump-on-vertical.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-pump-off-vertical.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-pump-static-vertical.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-twoway-digital-open.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-twoway-digital-closed.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-twoway-digital-static.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-twoway-digital-non-return.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-sources-01.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-sources-01-on.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-sources-01-off.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-transformer-01.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-transformer-01-on.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-transformer-01-off.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-diesel-generator-ac-on.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-diesel-generator-ac-off.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-diesel-generator-ac-static.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-electric-generator-ac-on.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-electric-generator-ac-off.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-electric-generator-ac-static.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-converter-dcac.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-converter-dcac-on.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-converter-dcac-off.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-battery-vertical-75.js'
import mimicFontUrl from 'virtual:openbridge-mimic-font'
import { renderSegments, themeFromCss, type Segment, type ThemeVars } from '@oicl/connector-diagram'
import type { MimicIconFamily } from '../../../../packs/process-plant/displays/mimic/presentation.ts'
import type { ItemLook } from '../../../../packs/process-plant/displays/mimic/evaluate.ts'
import { openBridgeDevice, textWidth } from '../../../../packs/process-plant/displays/mimic/text-metrics.ts'

/**
 * The flap names the most severe active alarm and counts the others (" +2")
 * where the reserved frame has room; the alarms panel lists every one.
 */
export const flapLabel = (label: string, others: number, frameWidth: number): string => {
  if (others === 0) return label
  const counted = `${label} +${others}`
  return textWidth('alertLabel', counted) + openBridgeDevice.flapLabelInset <= frameWidth ? counted : label
}

/** The text widths the server reserved were measured in OpenBridge's Noto Sans, so the mimic loads its glyphs (mimic-font.ts). */
export const loadMimicFont = async (): Promise<void> => {
  if ([...document.fonts].some(face => face.family.replace(/"/g, '') === 'Noto Sans')) return
  const face = new FontFace('Noto Sans', `url(${mimicFontUrl})`, { weight: '100 900' })
  document.fonts.add(face)
  await face.load()
}

type Props = Record<string, unknown>
const element = <T extends HTMLElement>(tag: string): T & Props => document.createElement(tag) as T & Props

export type AlertStatus = 'alarm' | 'warning' | 'caution'

/** The glyph for a device's family and look, as OpenBridge draws it. */
const glyph = (family: MimicIconFamily, look: ItemLook, orientation: 'horizontal' | 'vertical'): { readonly tag: string; readonly value?: number } | null => {
  const kind = look.state.kind
  const unknown = kind === 'unknown' || kind === 'none'
  const axis = orientation === 'vertical' ? 'vertical' : 'horizontal'
  const onOff = (on: boolean) => (on ? 'on' : 'off')
  switch (family) {
    case 'pump':
      return { tag: `obi-pump-${unknown ? 'static' : onOff(kind === 'running')}-${axis}` }
    case 'valve-analog':
    case 'valve-digital': {
      if (kind !== 'position') return { tag: 'obi-twoway-digital-static' }
      const open = look.state.fraction
      if (family === 'valve-digital' && open < 0.05) return { tag: 'obi-twoway-digital-closed' }
      if (family === 'valve-digital' && open > 0.95) return { tag: 'obi-twoway-digital-open' }
      // A modulating valve, or an isolating one caught between its ends, shows its opening.
      return { tag: 'obc-valve-analog-two-way-icon', value: Math.round(Math.min(1, Math.max(0, open)) * 100) }
    }
    case 'valve-check':
      return { tag: 'obi-twoway-digital-non-return' }
    case 'source':
      return { tag: unknown ? 'obi-sources-01' : `obi-sources-01-${onOff(kind === 'energized')}` }
    case 'transformer':
      return { tag: unknown ? 'obi-transformer-01' : `obi-transformer-01-${onOff(kind === 'energized')}` }
    case 'converter':
      return { tag: unknown ? 'obi-converter-dcac' : `obi-converter-dcac-${onOff(kind === 'energized')}` }
    case 'diesel-generator':
      return { tag: `obi-diesel-generator-ac-${unknown ? 'static' : onOff(kind === 'running')}` }
    case 'generator':
      return { tag: `obi-electric-generator-ac-${unknown ? 'static' : onOff(kind === 'running')}` }
    case 'battery':
      return { tag: 'obi-battery-vertical-75' }
    // No OpenBridge breaker glyph shows "position unknown", and an open-switch glyph would claim one: no glyph.
    // The breaker's first readout row says its contacts (CLOSED, OPEN, ?).
    case 'breaker':
      return null
  }
}

const isOn = (look: ItemLook): boolean =>
  look.state.kind === 'running' || look.state.kind === 'energized' || look.state.kind === 'passing' || look.state.kind === 'flowing' || look.state.kind === 'closed'
  || (look.state.kind === 'position' && look.state.fraction >= 0.05)

export interface DeviceRows {
  /** OpenBridge readout rows: integer values with units, and state words. */
  readonly rows: ReadonlyArray<{ readonly type: 'value'; readonly value: number; readonly unit: string } | { readonly type: 'state'; readonly text: string; readonly emphasis: boolean }>
}

/**
 * An `obc-automation-button` positioned by its symbol centre, with its text
 * stack beside or below it, in the readout size the drawing was laid out for
 * (chat: small 11.5 px rows; the unit overview: regular 16 px rows).
 */
export const createDevice = (readoutSize: 'small' | 'regular'): HTMLElement & Props => {
  const device = element('obc-automation-button')
  device.variant = 'regular'
  device.positioning = 'point'
  device.readoutSize = readoutSize
  device.showReadoutStack = true
  device.activated = false
  device.progress = false
  device.hasBadgeSpacer = false
  return device
}

export const updateDevice = (
  device: HTMLElement & Props,
  family: MimicIconFamily,
  look: ItemLook,
  config: {
    readonly tag: string
    readonly orientation: 'horizontal' | 'vertical'
    readonly textSide: 'right' | 'bottom'
    readonly rows: DeviceRows['rows']
    readonly alert: { readonly status: AlertStatus; readonly label: string } | null
  },
): void => {
  const icon = glyph(family, look, config.orientation)
  device.readoutPosition = config.textSide
  device.tag = config.tag
  device.state = isOn(look) ? 'open' : 'closed'
  device.static = look.state.kind === 'unknown' || look.state.kind === 'none' || look.notMeasured || family === 'valve-check' || family === 'battery'
  device.orientation = config.orientation === 'vertical' && !family.startsWith('pump') ? 'verticalRight' : 'horizontal'
  // No digit count: OpenBridge fills a value row's unused digits with dim
  // hinted zeros, so 35 % at three digits read "035 %". The server reserves
  // the row's width for three digits itself (compile-mimic.ts).
  device.readouts = config.rows.map(row => row.type === 'value'
    ? { type: 'value', value: row.value, nDigits: 0, unit: row.unit, direction: 'none', icon: 'none' }
    : { type: row.emphasis ? 'state-on' : 'state-off', value: row.text, hasIcon: false })
  device.alert = config.alert !== null
  if (config.alert !== null) {
    device.alertFrameStatus = config.alert.status
    device.alertFrameType = 'bottom-flip'
    // Steady: a chat display has no acknowledgement.
    device.alertFrameMode = 'acked-active'
    device.alertFrameThickness = 'small'
    device.showAlertCategoryIcon = true
    device.showAlertIcon = false
  }
  const current = device.querySelector('[slot="icon"]') as (HTMLElement & Props) | null
  if (icon === null) current?.remove()
  else if (current?.tagName.toLowerCase() !== icon.tag) {
    current?.remove()
    const next = element(icon.tag)
    next.slot = 'icon'
    next.setAttribute('usecsscolor', '')
    device.append(next)
  }
  const shown = device.querySelector('[slot="icon"]') as (HTMLElement & Props) | null
  if (shown !== null && icon?.value !== undefined) {
    shown.value = icon.value
    shown.closed = icon.value === 0
  }
  const label = device.querySelector('[slot="alert-label"]')
  if (config.alert === null) label?.remove()
  else {
    const flap = label ?? Object.assign(document.createElement('span'), { slot: 'alert-label' })
    flap.textContent = config.alert.label
    if (label === null) device.append(flap)
  }
}

/** An `obc-automation-tank` filling its box; its fill is the level, or static when the model draws none. */
export const createTank = (type: 'generic' | 'atmospheric' | 'pressurized'): HTMLElement & Props => {
  const tank = element('obc-automation-tank')
  tank.type = type
  tank.orientation = 'vertical'
  tank.positioning = 'button'
  tank.setAttribute('positioning', 'button')
  tank.compact = true
  tank.setAttribute('compact', '')
  tank.medium = 'normal'
  tank.max = 100
  tank.showTrendSymbol = false
  tank.clickable = false
  tank.tag = ''
  // Values sit beside the tank; an empty slot keeps a static tank from printing its capacity.
  tank.append(Object.assign(document.createElement('span'), { slot: 'readout' }))
  return tank
}

export const updateTank = (tank: HTMLElement & Props, level: number | null): void => {
  tank.static = level === null
  tank.toggleAttribute('static', level === null)
  tank.value = level === null ? 0 : Math.min(100, Math.max(0, level))
}

export const createHeatExchanger = (): HTMLElement & Props => {
  const exchanger = element('obc-heat-exchanger')
  exchanger.positioning = 'button'
  exchanger.setAttribute('positioning', 'button')
  // `graphic`, never `medium`: hot and cold colours at rest would claim temperatures.
  exchanger.medium = 'graphic'
  exchanger.static = false
  exchanger.clickable = false
  exchanger.showIcon = true
  exchanger.tag = ''
  return exchanger
}

/** A readout block for a value with decimals (the readout stack shows integers only). */
export const createReadoutBlock = (): HTMLElement & Props => {
  const block = element('obc-readout-block')
  block.variant = 'value'
  block.size = 'small'
  block.alignment = 'right'
  block.hintedZeros = false
  return block
}

export const updateReadoutBlock = (block: HTMLElement & Props, value: number | null, fractionDigits: number, maxDigits: number): void => {
  block.value = value
  block.fractionDigits = fractionDigits
  block.maxDigits = maxDigits
}

/** A standalone frame for items that are not automation buttons (tanks, heat exchangers, headers). */
export const createAlertFrame = (): HTMLElement & Props => {
  const frame = element('obc-alert-frame')
  frame.type = 'bottom-flip'
  frame.mode = 'acked-active'
  frame.thickness = 'small'
  frame.showAlertCategoryIcon = true
  frame.showIcon = false
  frame.append(Object.assign(document.createElement('span'), { slot: 'label' }))
  return frame
}

export const updateAlertFrame = (frame: HTMLElement & Props, status: AlertStatus, label: string): void => {
  frame.status = status
  const slot = frame.querySelector('[slot="label"]')
  if (slot !== null) slot.textContent = label
}

/** OpenBridge's pipe palette for the current theme. */
export const pipeTheme = (): ThemeVars => {
  const root = document.documentElement
  const styles = getComputedStyle(root)
  return themeFromCss(name => styles.getPropertyValue(name), root.dataset.obcTheme)
}

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

/**
 * Draws the pipes on a canvas sized for the device pixel ratio. Where a theme
 * draws the flow chevron in the pipe's own colour (dusk), the chevrons are
 * drawn again with the pipe fill as their halo and the background as their
 * body, so they stay visible without forking OpenBridge's renderer.
 */
export const drawPipes = (canvas: HTMLCanvasElement, width: number, height: number, segments: ReadonlyArray<Segment>): void => {
  const ratio = window.devicePixelRatio || 1
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
  canvas.width = Math.round(width * ratio)
  canvas.height = Math.round(height * ratio)
  const context = canvas.getContext('2d')
  if (context === null) return
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  context.clearRect(0, 0, width, height)
  const background = getComputedStyle(document.documentElement).getPropertyValue('--container-background-color').trim()
  const palette = pipeTheme()
  // Flow must read as the heavier line. Where a palette's open pipe fades into
  // the background more than its empty pipe does (day), the open pipe is drawn
  // solid in its own outline colour.
  const theme = contrast(palette.pipeFillColor, background) < contrast(palette.pipeFillInverted, background)
    ? { ...palette, pipeFillColor: palette.pipeOutlineColor }
    : palette
  renderSegments(context, [...segments], { theme, clear: false })
  if (contrast(theme.pipeOutlineColor, theme.pipeFillColor) < 3) {
    renderSegments(context, segments.filter(segment => segment.kind === 'direction'), {
      theme: { ...theme, pipeOutlineColor: background || theme.pipeDirectionHalo, pipeDirectionHalo: theme.pipeFillColor },
      clear: false,
    })
  }
}

export { renderSegments }
