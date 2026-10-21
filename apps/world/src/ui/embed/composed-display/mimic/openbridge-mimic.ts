// The OpenBridge elements a generated mimic draws with, loaded only when a
// display has a mimic. Importing a module registers its custom element; the
// factories below set every property explicitly (the truthful-state recipes),
// so no OpenBridge default can draw a state the model does not have: no
// "On"/"Off" text, no "000 %", no trend arrow, nothing clickable, and no
// badge but those an operated display sets (updateSymbolOperation). Elements
// are created through OpenBridge's own tag types and properties set with its
// own enums, so a renamed property or value fails the type check on upgrade
// (openbridge-usage.test.ts checks the same against its Custom Elements Manifest).
import { ObcAutomationBadgeMode, ObcAutomationBadgeType } from '@oicl/openbridge-webcomponents/dist/automation/automation-badge/automation-badge.js'
import {
  AutomationButtonOrientation,
  AutomationButtonPositioning,
  AutomationButtonReadoutPosition,
  AutomationButtonState,
  AutomationButtonVariant,
  CircularProgressMode,
  type ObcAutomationButton,
} from '@oicl/openbridge-webcomponents/dist/automation/automation-button/automation-button.js'
import { TankOrientation, TankPositioning, TankType, type ObcAutomationTank } from '@oicl/openbridge-webcomponents/dist/automation/automation-tank/automation-tank.js'
// The steam generators' and condenser's vessel. Nothing but its type is read from it, and a type-only
// import is erased, so the module that defines the element is imported for that alone (openbridge-usage.test.ts).
import '@oicl/openbridge-webcomponents/dist/automation/heat-exchanger/heat-exchanger.js'
import type { ObcHeatExchanger } from '@oicl/openbridge-webcomponents/dist/automation/heat-exchanger/heat-exchanger.js'
import { SpecialtyTankMedium } from '@oicl/openbridge-webcomponents/dist/automation/specialty-tank/abstract-specialty-tank.js'
import { LineMedium } from '@oicl/openbridge-webcomponents/dist/automation/index.js'
import '@oicl/openbridge-webcomponents/dist/automation/valve-analoge-two-way-icon/valve-analog-two-way-icon.js'
import {
  ObcTextboxAlignment,
  ReadoutBlockDataQuality,
  ReadoutBlockSize,
  ReadoutBlockVariant,
  ReadoutValueType,
  type ObcReadoutBlock,
} from '@oicl/openbridge-webcomponents/dist/building-blocks/readout-block/readout-block.js'
import { ObcAlertFrameMode, ObcAlertFrameThickness, ObcAlertFrameType, type ObcAlertFrame } from '@oicl/openbridge-webcomponents/dist/components/alert-frame/alert-frame.js'
import { AutomationButtonReadoutStackSize, type AutomationButtonReadoutStack } from '@oicl/openbridge-webcomponents/dist/components/automation-button-readout-stack/automation-button-readout-stack.js'
import '@oicl/openbridge-webcomponents/dist/components/icon-button/icon-button.js'
import { AlertType } from '@oicl/openbridge-webcomponents/dist/types.js'
// The detail dot's magnifying glass, and a popover's pin, handle and resize corner.
import '@oicl/openbridge-webcomponents/dist/icons/icon-search.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-pin-google.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-pin-selected-google.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-drag-horizontal.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-resize-corner.js'
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
import '@oicl/openbridge-webcomponents/dist/icons/icon-ai.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-ai-pending.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-user.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-command-request.js'
import '@oicl/openbridge-webcomponents/dist/icons/icon-manual.js'
import mimicFontUrl from 'virtual:openbridge-mimic-font'
import { renderSegments, themeFromCss, type Segment, type ThemeVars } from '@oicl/connector-diagram'
import type { MimicIconFamily } from '../../../../packs/process-plant/displays/mimic/presentation.ts'
import type { ItemLook } from '../../../../packs/process-plant/displays/mimic/evaluate.ts'
import type { ItemBadges } from '../operation/operation-presenter.ts'
import { deviceBadgeCorners } from './badge-room.ts'

/** The text widths the server reserved were measured in OpenBridge's Noto Sans, so the mimic loads its glyphs (mimic-font.ts). */
export const loadMimicFont = async (): Promise<void> => {
  if ([...document.fonts].some(face => face.family.replace(/"/g, '') === 'Noto Sans')) return
  const face = new FontFace('Noto Sans', `url(${mimicFontUrl})`, { weight: '100 900' })
  document.fonts.add(face)
  await face.load()
}

export type AlertStatus = 'alarm' | 'warning' | 'caution'

const ALERT_TYPE: Readonly<Record<AlertStatus, AlertType>> = { alarm: AlertType.Alarm, warning: AlertType.Warning, caution: AlertType.Caution }

// The glyphs a device draws: OpenBridge's two-way valve icon, which shows an opening, or an obi icon.
const VALVE_ICON = 'obc-valve-analog-two-way-icon'
type GlyphTag = typeof VALVE_ICON | `obi-${string}`

/** The glyph for a device's family and look, as OpenBridge draws it. */
const glyph = (family: MimicIconFamily, look: ItemLook, orientation: 'horizontal' | 'vertical'): { readonly tag: GlyphTag; readonly value?: number } | null => {
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
      return { tag: VALVE_ICON, value: Math.round(Math.min(1, Math.max(0, open)) * 100) }
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
export const createDevice = (readoutSize: 'small' | 'regular'): ObcAutomationButton => {
  const device = document.createElement('obc-automation-button')
  device.variant = AutomationButtonVariant.regular
  device.positioning = AutomationButtonPositioning.point
  device.readoutSize = readoutSize === 'small' ? AutomationButtonReadoutStackSize.small : AutomationButtonReadoutStackSize.regular
  device.showReadoutStack = true
  device.activated = false
  device.progress = false
  device.hasBadgeSpacer = false
  return device
}

export const updateDevice = (
  device: ObcAutomationButton,
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
  device.readoutPosition = config.textSide === 'right' ? AutomationButtonReadoutPosition.right : AutomationButtonReadoutPosition.bottom
  device.tag = config.tag
  device.state = isOn(look) ? AutomationButtonState.open : AutomationButtonState.closed
  device.static = look.state.kind === 'unknown' || look.state.kind === 'none' || look.notMeasured || family === 'valve-check' || family === 'battery'
  device.orientation = config.orientation === 'vertical' && !family.startsWith('pump') ? AutomationButtonOrientation.verticalRight : AutomationButtonOrientation.horizontal
  // No digit count: OpenBridge fills a value row's unused digits with dim
  // hinted zeros, so 35 % at three digits read "035 %". The server reserves
  // the row's width for three digits itself (compile-mimic.ts).
  device.readouts = config.rows.map((row): AutomationButtonReadoutStack => row.type === 'value'
    ? { type: 'value', value: row.value, nDigits: 0, unit: row.unit, direction: 'none', icon: 'none' }
    : { type: row.emphasis ? 'state-on' : 'state-off', value: row.text, hasIcon: false })
  device.alert = config.alert !== null
  if (config.alert !== null) {
    device.alertFrameStatus = ALERT_TYPE[config.alert.status]
    device.alertFrameType = ObcAlertFrameType.BottomFlip
    // Steady: a chat display has no acknowledgement.
    device.alertFrameMode = ObcAlertFrameMode.ackedActive
    device.alertFrameThickness = ObcAlertFrameThickness.Small
    device.showAlertCategoryIcon = true
    device.showAlertIcon = false
  }
  const current = device.querySelector<HTMLElement>('[slot="icon"]')
  if (icon === null) current?.remove()
  else if (current?.tagName.toLowerCase() !== icon.tag) {
    current?.remove()
    const next = document.createElement(icon.tag)
    next.slot = 'icon'
    next.setAttribute('usecsscolor', '')
    device.append(next)
  }
  // The valve icon is only ever the device's icon slot.
  const valve = device.querySelector(VALVE_ICON)
  if (valve !== null && icon?.value !== undefined) {
    valve.value = icon.value
    valve.closed = icon.value === 0
  }
  const label = device.querySelector('[slot="alert-label"]')
  if (config.alert === null) label?.remove()
  else {
    const flap = label ?? Object.assign(document.createElement('span'), { slot: 'alert-label' })
    flap.textContent = config.alert.label
    if (label === null) device.append(flap)
  }
}

/**
 * What an operated display's symbol carries (plan §4.3, QA-8/QA-10), in
 * OpenBridge's own badges: in one corner who acts on it (an enhanced
 * AI-pending badge while a proposal waits, else who operated it last: a
 * person, an AI agent, or both for a person's approval of an AI proposal); in
 * the other what holds it (interlock while a protection actuation holds one
 * of its commands, else command-locked while another screen's command
 * travels). Quiet regular and enhanced badges, never an alert badge.
 */
export const operationBadges = (badges: ItemBadges | null): { readonly who: ReadonlyArray<HTMLElement>; readonly hold: ReadonlyArray<HTMLElement> } => {
  if (badges === null) return { who: [], hold: [] }
  const iconBadge = (mode: ObcAutomationBadgeMode, icon: `obi-${string}`): HTMLElement => {
    const badge = document.createElement('obc-automation-badge')
    badge.mode = mode
    const glyphElement = document.createElement(icon)
    glyphElement.setAttribute('usecsscolor', '')
    badge.append(glyphElement)
    return badge
  }
  const typed = (type: ObcAutomationBadgeType): HTMLElement => {
    const badge = document.createElement('obc-automation-badge')
    badge.mode = ObcAutomationBadgeMode.Regular
    badge.type = type
    return badge
  }
  const { Regular, Enhanced } = ObcAutomationBadgeMode
  const attribution = badges.attribution?.text
  const who = badges.proposal !== null ? [iconBadge(Enhanced, badges.proposal.text === 'AI ?' ? 'obi-ai-pending' : 'obi-command-request')]
    : attribution === undefined ? []
      : attribution === 'OP·AI' ? [iconBadge(Regular, 'obi-user'), iconBadge(Regular, 'obi-ai')]
        : [iconBadge(Regular, attribution === 'AI' ? 'obi-ai' : 'obi-user')]
  const hold = badges.interlock !== null ? [typed(ObcAutomationBadgeType.Interlock)] : badges.commandLocked !== null ? [typed(ObcAutomationBadgeType.CommandLocked)] : []
  // A person's setting under a standing actuation ("Throttled under …"): OpenBridge's manual badge, beside who acted, where it has room.
  const manual = badges.throttled !== null && who.length < 2 ? [iconBadge(Regular, 'obi-manual')] : []
  return { who: [...who, ...manual], hold }
}

const badgesKey = (badges: ItemBadges | null): string =>
  JSON.stringify([badges?.proposal?.text ?? null, badges?.attribution?.text ?? null, badges?.interlock !== null && badges?.interlock !== undefined, badges?.commandLocked !== null && badges?.commandLocked !== undefined, badges?.throttled?.text ?? null])

/**
 * A device's operation state: activated while a command for it is selected;
 * its progress ring while a person's or an AI agent's command travels; and its
 * badges in the two corners away from its text, so they never take the room
 * its text stack was laid out in (hasBadgeSpacer stays false: nothing moves).
 */
export const updateSymbolOperation = (device: ObcAutomationButton, operation: { readonly activated: boolean; readonly badges: ItemBadges | null; readonly textSide: 'right' | 'bottom' }): void => {
  device.activated = operation.activated
  const progress = operation.badges?.progress ?? null
  device.progress = progress !== null
  if (progress !== null) {
    device.progressMode = progress.mode === 'determinate' ? CircularProgressMode.determinate : CircularProgressMode.indeterminate
    device.progressValue = progress.mode === 'determinate' ? progress.value : 0
  }
  const key = `${badgesKey(operation.badges)}|${operation.textSide}`
  if (device.dataset.badges === key) return
  device.dataset.badges = key
  for (const old of device.querySelectorAll('[slot^="badge-"]')) old.remove()
  const corners = deviceBadgeCorners(operation.textSide)
  const { who, hold } = operationBadges(operation.badges)
  for (const badge of who) { badge.slot = corners.who; device.append(badge) }
  for (const badge of hold) { badge.slot = corners.hold; device.append(badge) }
}

/** A vessel's badges, in the top corners of the box it is drawn in: who acts on it left, what holds it right. */
export const updateVesselOperation = (corners: { readonly who: HTMLElement; readonly hold: HTMLElement }, badges: ItemBadges | null): void => {
  const key = badgesKey(badges)
  if (corners.who.dataset.badges === key) return
  corners.who.dataset.badges = key
  const { who, hold } = operationBadges(badges)
  corners.who.replaceChildren(...who)
  corners.hold.replaceChildren(...hold)
}

/** An `obc-automation-tank` filling its box; its fill is the level, or static when the model draws none. */
const TANK_TYPE: Readonly<Record<'generic' | 'atmospheric' | 'pressurized', TankType>> = { generic: TankType.generic, atmospheric: TankType.atmospheric, pressurized: TankType.pressurized }

export const createTank = (type: 'generic' | 'atmospheric' | 'pressurized'): ObcAutomationTank => {
  const tank = document.createElement('obc-automation-tank')
  tank.type = TANK_TYPE[type]
  tank.orientation = TankOrientation.vertical
  tank.positioning = TankPositioning.button
  tank.setAttribute('positioning', TankPositioning.button)
  tank.compact = true
  tank.setAttribute('compact', '')
  tank.medium = LineMedium.normal
  tank.max = 100
  tank.showTrendSymbol = false
  tank.clickable = false
  tank.tag = ''
  // Values sit beside the tank; an empty slot keeps a static tank from printing its capacity.
  tank.append(Object.assign(document.createElement('span'), { slot: 'readout' }))
  return tank
}

/** A tank's fill, and its program's marker where its level stands off it (`program`; null hides it). */
export const updateTank = (tank: ObcAutomationTank, level: number | null, program: number | null = null): void => {
  tank.static = level === null
  tank.toggleAttribute('static', level === null)
  tank.value = level === null ? 0 : Math.min(100, Math.max(0, level))
  tank.autoAtSetpoint = false
  tank.atSetpoint = false
  tank.setpoint = level === null || program === null ? undefined : Math.min(100, Math.max(0, program))
}

export const createHeatExchanger = (): ObcHeatExchanger => {
  const exchanger = document.createElement('obc-heat-exchanger')
  exchanger.positioning = TankPositioning.button
  exchanger.setAttribute('positioning', TankPositioning.button)
  // `graphic`, never `medium`: hot and cold colours at rest would claim temperatures.
  exchanger.medium = SpecialtyTankMedium.graphic
  exchanger.static = false
  exchanger.clickable = false
  exchanger.showIcon = true
  exchanger.tag = ''
  return exchanger
}

/** A readout block for a value with decimals (the readout stack shows integers only). */
export const createReadoutBlock = (): ObcReadoutBlock => {
  const block = document.createElement('obc-readout-block')
  block.variant = ReadoutBlockVariant.value
  block.size = ReadoutBlockSize.small
  block.alignment = ObcTextboxAlignment.Right
  block.hintedZeros = false
  return block
}

/**
 * A readout block's value: a number, or at an end of its instrument's span
 * the text that says only where the quantity is ("<0"), in OpenBridge's
 * low-integrity style, as a readout shows it.
 */
export const updateReadoutBlock = (block: ObcReadoutBlock, value: number | null, fractionDigits: number, maxDigits: number, offScale: string | null = null): void => {
  block.valueType = offScale === null ? ReadoutValueType.number : ReadoutValueType.text
  block.value = offScale ?? value
  // A Lit property is cleared by setting it to undefined (deleting it would keep its value), which its optional declaration omits.
  const clearable: { dataQuality?: ReadoutBlockDataQuality | undefined } = block
  clearable.dataQuality = offScale === null ? undefined : ReadoutBlockDataQuality.lowIntegrity
  block.fractionDigits = fractionDigits
  block.maxDigits = maxDigits
}

/** A standalone frame for items that are not automation buttons (tanks, heat exchangers, headers). */
export const createAlertFrame = (): ObcAlertFrame => {
  const frame = document.createElement('obc-alert-frame')
  frame.type = ObcAlertFrameType.BottomFlip
  frame.mode = ObcAlertFrameMode.ackedActive
  frame.thickness = ObcAlertFrameThickness.Small
  frame.showAlertCategoryIcon = true
  frame.showIcon = false
  frame.append(Object.assign(document.createElement('span'), { slot: 'label' }))
  return frame
}

export const updateAlertFrame = (frame: ObcAlertFrame, status: AlertStatus, label: string): void => {
  frame.status = ALERT_TYPE[status]
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

// The largest canvas every browser allocates (iOS Safari: 4096 x 4096), and as
// much memory as one drawing should hold; a larger drawing is drawn coarser.
const MAX_CANVAS_PIXELS = 4096 * 4096

/**
 * Draws the pipes on a canvas sized for the device pixel ratio times the zoom
 * the display window paints the view at, so a magnified drawing stays sharp.
 * Where a theme draws the flow chevron in the pipe's own colour (dusk), the
 * chevrons are drawn again with the pipe fill as their halo and the background
 * as their body, so they stay visible without forking OpenBridge's renderer.
 */
export const drawPipes = (canvas: HTMLCanvasElement, width: number, height: number, segments: ReadonlyArray<Segment>, zoom: number): void => {
  const ratio = Math.min((window.devicePixelRatio || 1) * zoom, Math.sqrt(MAX_CANVAS_PIXELS / (width * height)))
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
