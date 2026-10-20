import type { AlertSeverity, Priority } from '../../core/model/alerts.ts'

// The one World severity table (plan v3.1 §2.7, V15), shared by the main app
// and the embed. It imports no OpenBridge: the colours are OpenBridge 2.0.0's
// alert colours as dist/openbridge.css resolves them in each palette (later
// declarations win), and each glyph is the shape of OpenBridge's badge for that
// family. Notice has no hue (bold, neutral bar). An alert without a priority
// shows its severity word neutrally, "priority not declared" (R1): no table
// derives a priority from `severity`, so `critical` is never drawn as emergency.

export type Palette = 'day' | 'dusk' | 'night'
export type SeverityFamily = 'alarm' | 'warning' | 'caution' | 'critical'
export type SeverityGlyph = 'hexagon' | 'triangle' | 'circle' | 'square'

export interface SeverityStyle {
  readonly family: SeverityFamily | null
  readonly glyph: SeverityGlyph | null
  readonly word: string
  /** null: no hue; the host draws it in its neutral text colour. */
  readonly rgb: Readonly<Record<Palette, string>> | null
}

const openBridge: Readonly<Record<SeverityFamily, Readonly<Record<Palette, string>>>> = {
  alarm: { day: 'rgb(227, 0, 25)', dusk: 'rgb(219, 0, 7)', night: 'rgb(185, 0, 0)' },
  warning: { day: 'rgb(254, 148, 19)', dusk: 'rgb(250, 125, 0)', night: 'rgb(147, 68, 0)' },
  caution: { day: 'rgb(255, 219, 66)', dusk: 'rgb(215, 164, 0)', night: 'rgb(107, 89, 0)' },
  critical: { day: 'rgb(196, 36, 183)', dusk: 'rgb(189, 40, 190)', night: 'rgb(195, 48, 196)' },
}

export const severityTable: Readonly<Record<Exclude<Priority, 'none'>, SeverityStyle>> = {
  emergency: { family: 'critical', glyph: 'hexagon', word: 'Emergency', rgb: openBridge.critical },
  alarm: { family: 'alarm', glyph: 'triangle', word: 'Alarm', rgb: openBridge.alarm },
  warning: { family: 'warning', glyph: 'circle', word: 'Warning', rgb: openBridge.warning },
  caution: { family: 'caution', glyph: 'square', word: 'Caution', rgb: openBridge.caution },
  notice: { family: null, glyph: null, word: 'Notice', rgb: null },
}

const severityWords: Readonly<Record<AlertSeverity, string>> = { info: 'Info', warning: 'Warning', critical: 'Critical' }

/** How an alert is drawn: by its declared priority, or neutrally by its severity word where it declares none; `none` asks for no attention and is not drawn. */
export const severityStyle = (priority: Priority | null, severity: AlertSeverity): SeverityStyle | null =>
  priority === null ? { family: null, glyph: null, word: `${severityWords[severity]} · priority not declared`, rgb: null }
    : priority === 'none' ? null : severityTable[priority]
