// The custom-shape register of the OpenBridge policy (owner, 21 Oct 2026;
// apps/world/AGENTS.md "OpenBridge Rules"): every shape an operator display
// draws itself where an OpenBridge component could carry the meaning, with
// its reason, evidence, decision and the phase it ends in. The wiki's
// design-system page mirrors it. A new entry needs the owner's approval, as
// D-19 did; a shape goes once OpenBridge carries its meaning.
//
// openbridge-register.test.ts holds every SVG and drawing canvas in
// src/ui/embed and src/ui/displays to an entry or a surface here, every entry
// to a shape still drawn, and every shadow root, CSS part and OpenBridge
// custom property the embed uses to an internal listed here.
// openbridge-tokens.test.ts checks that each listed internal still exists in
// the installed package.

/** A: no component carries the meaning. B: a licence twin for an OpenBridge-free host. C: a measured defect in the component. D: measured density or speed, with figures. */
export type Reason = 'A' | 'B' | 'C' | 'D'

/**
 * Where a shape stops being drawn: removed by the P0 fix (claude/fix-mimic-vessels);
 * replaced by OpenBridge components before the M1 deploy; deleted with the old
 * renderer (ui/embed/composed-display) at the swap; or kept until OpenBridge
 * carries its meaning.
 */
export type Ends = 'P0 fix' | 'M1' | 'swap' | 'kept'

/** A file under apps/world/src and a text that marks the drawing in it (comments do not count). */
export interface Site {
  readonly file: string
  readonly mark: string
}

/** A shape's site: an svg or canvas mark must sit in an SVG or canvas the test finds; an html or code mark need only be present. */
export interface ShapeSite extends Site {
  readonly drawn: 'svg' | 'canvas' | 'html' | 'code'
}

export type OpenBridgeTag = `obc-${string}` | `obi-${string}`

export interface CustomShape {
  readonly id: string
  readonly draws: string
  readonly sites: ReadonlyArray<ShapeSite>
  /** The OpenBridge elements whose meaning it carries instead, or none. */
  readonly standsInFor: ReadonlyArray<OpenBridgeTag> | 'none'
  /** Null where no reason is on record; such a shape is not kept. */
  readonly reason: Reason | null
  readonly evidence: string
  readonly decision: 'pending owner approval' | { readonly owner: 'approved' | 'removed'; readonly ref: string }
  readonly ends: Ends
}

/** The owner's ruling Q11 (21 Oct 2026): every recommendation in the register approved as listed. */
const APPROVED = { owner: 'approved', ref: 'Q11 (21 Oct): approved as recommended' } as const

export const customShapes: ReadonlyArray<CustomShape> = [
  // The old renderer: deleted at the swap (P2 architecture §D).
  {
    id: 'reactor-vessel',
    draws: 'The reactor core as its vessel: head, flange, body, bottom, nozzle collars, the level as its fill and the rod banks by inserted length.',
    sites: [
      { file: 'ui/embed/composed-display/mimic/VesselSymbol.svelte', mark: 'class="vessel"', drawn: 'svg' },
      { file: 'ui/embed/composed-display/mimic/vessel-symbol.ts', mark: 'export const vesselGeometry', drawn: 'code' },
    ],
    standsInFor: 'none',
    reason: 'A',
    evidence: 'OpenBridge 2.0.0 has no reactor symbol. Filled and framed in the tokens of obc-automation-tank\'s regular scheme; geometry is a tested pure function (mimic-vessel-symbol, mimic-vessel-fit).',
    decision: { owner: 'approved', ref: 'D-19 (12 Oct): the one exception to OpenBridge components' },
    ends: 'swap',
  },
  {
    id: 'tank-fill-trace',
    draws: 'A tank\'s level over the last minutes, traced over its fill on the fill\'s scale.',
    sites: [{ file: 'ui/embed/composed-display/mimic/MimicPanel.svelte', mark: 'class="box fill-trace"', drawn: 'svg' }],
    standsInFor: ['obc-automation-tank'],
    reason: 'C',
    evidence: 'OpenBridge\'s tank graph (chartMode, chartData) crops its chart in a compact tank: recorded in MimicPanel.svelte and on the wiki (design decisions, traces on vessels). The measurement itself is not on record.',
    decision: APPROVED,
    ends: 'swap',
  },
  {
    id: 'vessel-mini-trace',
    draws: 'A heat exchanger\'s level strip inside its symbol, and the core-exit temperature under the vessel\'s value.',
    sites: [{ file: 'ui/embed/composed-display/mimic/MiniTrace.svelte', mark: 'class="trace"', drawn: 'svg' }],
    standsInFor: ['obc-graph-mini'],
    reason: 'A',
    evidence: 'obc-graph-mini takes data, minY, maxY and chart only: it cannot break its line where nothing was recorded or start where history starts (wiki design-system page).',
    decision: APPROVED,
    ends: 'swap',
  },
  {
    id: 'trend-panel',
    draws: 'Trends: time axes, limit lines with stacked labels, off-span combs, hatched missing history, the advice marker and the ▲ ▼ ◂ ▸ glyphs.',
    sites: [{ file: 'ui/embed/composed-display/TrendPanel.svelte', mark: 'Trend of the last', drawn: 'svg' }],
    standsInFor: ['obc-line-graph', 'obc-area-graph', 'obc-gauge-trend', 'obc-graph-mini'],
    reason: 'A',
    evidence: 'None of OpenBridge 2.0.0\'s line, area, gauge-trend or mini graphs draws limit lines, off-span marks or a break where nothing was recorded (wiki display decision log, corrections).',
    decision: APPROVED,
    ends: 'swap',
  },
  {
    id: 'trend-key',
    draws: 'The trend\'s key: pen swatches and the off-span comb.',
    sites: [
      { file: 'ui/embed/composed-display/PenLegend.svelte', mark: 'class="swatch"', drawn: 'svg' },
      { file: 'ui/embed/composed-display/PenLegend.svelte', mark: 'class="comb-key"', drawn: 'svg' },
    ],
    standsInFor: 'none',
    reason: 'A',
    evidence: 'It keys marks only the custom trend draws (trend-panel).',
    decision: APPROVED,
    ends: 'swap',
  },
  {
    id: 'loop-comparison',
    draws: 'One reading on each loop on a shared scale, with its limit lines, their names and the median.',
    sites: [{ file: 'ui/embed/composed-display/ComparisonPanel.svelte', mark: 'Comparison now', drawn: 'svg' }],
    standsInFor: ['obc-bar-horizontal'],
    reason: 'A',
    evidence: 'Wiki design-system page: no component draws several loops against shared, named limits; obc-bar-horizontal draws one value with its own zones. Grouped values replace it at the swap.',
    decision: APPROVED,
    ends: 'swap',
  },
  {
    id: 'sparkline',
    draws: 'A lead value\'s sparkline in OpenBridge\'s mini-graph frame, drawn by hand.',
    sites: [{ file: 'ui/embed/composed-display/Sparkline.svelte', mark: 'class={`sparkline', drawn: 'svg' }],
    standsInFor: ['obc-graph-mini'],
    reason: 'A',
    evidence: 'obc-graph-mini cannot break its line where nothing was recorded or mark a limit (wiki design-system page).',
    decision: APPROVED,
    ends: 'swap',
  },
  {
    id: 'bus-and-header-straights',
    draws: 'Process and steam headers and electrical buses as connector-diagram\'s large straight segments.',
    sites: [{ file: 'ui/embed/composed-display/mimic/MimicPanel.svelte', mark: "kind: 'straight', connectionId: item.id", drawn: 'code' }],
    standsInFor: ['obc-bus'],
    reason: null,
    evidence: 'Drawn by OpenBridge\'s own pipe renderer, but OpenBridge 2.0.0 has obc-bus for an electrical bus; no component for a process header. No reason on record.',
    decision: APPROVED,
    ends: 'swap',
  },
  {
    id: 'flap-lines',
    draws: 'A device\'s further flap lines under its alarm frame (the action, "+N alarms"), in the flap\'s alert colours.',
    sites: [{ file: 'ui/embed/composed-display/mimic/MimicPanel.svelte', mark: 'flap-line ${alert.status}', drawn: 'html' }],
    standsInFor: ['obc-alert-frame'],
    reason: 'A',
    evidence: 'obc-alert-frame 2.0.0 has one label slot, so its flap holds one line; these lines extend the frame (a second layer) rather than replace it.',
    decision: APPROVED,
    ends: 'swap',
  },
  {
    id: 'abnormal-outline',
    draws: 'The outline of an item not following its command, in OpenBridge\'s enhanced neutral colour, and its key.',
    sites: [
      { file: 'ui/embed/composed-display/mimic/MimicPanel.svelte', mark: '<div class="abnormal"', drawn: 'html' },
      { file: 'ui/embed/composed-display/mimic/MimicPanel.svelte', mark: '<span class="abnormal-key">', drawn: 'html' },
    ],
    standsInFor: 'none',
    reason: null,
    evidence: 'No reason on record. obc-alert-frame means alert severity (D-32); no OpenBridge element was checked for command mismatch.',
    decision: APPROVED,
    ends: 'swap',
  },
  {
    id: 'expected-alarm-key',
    draws: 'The key\'s swatch for an alarm expected after a first-out: a box in the alarm colour at 45 % opacity.',
    sites: [{ file: 'ui/embed/composed-display/mimic/MimicPanel.svelte', mark: '<span class="expected-key">', drawn: 'html' }],
    standsInFor: ['obc-alert-frame'],
    reason: null,
    evidence: 'No reason on record. It keys the faded obc-alert-frame the drawing draws.',
    decision: APPROVED,
    ends: 'swap',
  },
  {
    id: 'symbol-text-stacks',
    draws: 'The text stacks of tanks, heat exchangers, the vessel and headers: tag, value rows (each value an obc-readout-block), state and alarm rows.',
    sites: [{ file: 'ui/embed/composed-display/mimic/MimicPanel.svelte', mark: '<div class="stack"', drawn: 'html' }],
    standsInFor: ['obc-automation-button-readout-stack'],
    reason: null,
    evidence: 'OpenBridge\'s readout stack is its own element, drawn inside obc-automation-button. No reason on record for a stack of its own beside other symbols; widths come from OpenBridge\'s text metrics.',
    decision: APPROVED,
    ends: 'swap',
  },
  {
    id: 'item-popover',
    draws: 'An item\'s popover and pinned overlay: a card in OpenBridge\'s container tokens and floating shadow, with OpenBridge icon buttons and icons.',
    sites: [{ file: 'ui/embed/composed-display/mimic/MimicPopover.svelte', mark: 'class="popover"', drawn: 'html' }],
    standsInFor: ['obc-toggletip'],
    reason: 'A',
    evidence: 'obc-toggletip 2.0.0 has a title, a description, a content slot and two action buttons; it cannot be pinned, dragged, resized or drawn at 1/zoom, which the overlay does.',
    decision: APPROVED,
    ends: 'swap',
  },
  {
    id: 'annunciator-tiles',
    draws: 'Annunciator tiles: a system\'s name with a bar in its worst alert colour, counts in obc-badge, action words, pressed to filter the alarm list.',
    sites: [{ file: 'ui/embed/composed-display/AnnunciatorTiles.svelte', mark: 'class={`tile', drawn: 'html' }],
    standsInFor: ['obc-alert-subsystem-counter'],
    reason: null,
    evidence: 'obc-alert-subsystem-counter has a label and slotted count badges; whether it holds the action words and the filter was never measured. No reason on record.',
    decision: APPROVED,
    ends: 'swap',
  },
  {
    id: 'alarm-list-rows',
    draws: 'The alarm list panel\'s rows: a bar in the alert colour, tag, title, flags and age.',
    sites: [{ file: 'ui/embed/composed-display/AlarmsPanel.svelte', mark: '<li class={`alert-', drawn: 'html' }],
    standsInFor: ['obc-alert-list'],
    reason: null,
    evidence: 'No reason on record. The vignette\'s alerts section replaces it at the swap.',
    decision: APPROVED,
    ends: 'swap',
  },
  {
    id: 'safety-function-chips',
    draws: 'Critical safety function chips in their status-tree colours.',
    sites: [{ file: 'ui/embed/composed-display/SafetyFunctionChips.svelte', mark: 'class={`csf ${safetyFunction.status}`}', drawn: 'html' }],
    standsInFor: 'none',
    reason: null,
    evidence: 'Chips are allowed, but these colour status-tree states with alert tokens and --alert-running-color, against D-32. From the swap a challenged function raises an alert (ruling Q7).',
    decision: APPROVED,
    ends: 'swap',
  },
  {
    id: 'check-glyphs',
    draws: 'The text glyphs ✓ and ○ on a faceplate\'s check rows.',
    sites: [{ file: 'ui/embed/composed-display/faceplate-lines.ts', mark: "row.met === row.of ? '✓' : '○'", drawn: 'code' }],
    standsInFor: ['obi-check-google'],
    reason: null,
    evidence: 'No reason on record; OpenBridge has check icons.',
    decision: APPROVED,
    ends: 'swap',
  },
  {
    id: 'filter-close-glyph',
    draws: 'A native "All ✕" button that clears the alarm list\'s system filter.',
    sites: [{ file: 'ui/embed/composed-display/AlarmsPanel.svelte', mark: 'All ✕', drawn: 'html' }],
    standsInFor: ['obc-button', 'obi-close-google'],
    reason: null,
    evidence: 'No reason on record; OpenBridge has buttons and a close icon.',
    decision: APPROVED,
    ends: 'swap',
  },
  // The vignette renderer (P2).
  {
    id: 'vignette-state-word',
    draws: 'An unknown state\'s word: a dashed box with "?". A known state is OpenBridge\'s obc-status-indicator.',
    sites: [{ file: 'ui/embed/vignette/StateWord.svelte', mark: '<span class="unknown">', drawn: 'html' }],
    standsInFor: ['obc-status-indicator'],
    reason: 'A',
    evidence: 'obc-status-indicator 2.0.0\'s statuses are active, inactive, caution, warning, alarm and running: none says unknown, which channel D draws dashed with "?" (plan §2.7). It extends the indicator rather than replace it.',
    decision: APPROVED,
    ends: 'kept',
  },
  {
    id: 'vignette-trend-strip',
    draws: 'A vignette\'s trend strip: step-and-hold pens told apart by dash, shared limits with their names, ▲ ▼ for limits beyond the scale, and the legend\'s pen swatches.',
    sites: [
      { file: 'ui/embed/vignette/TrendStrip.svelte', mark: 'aria-label={pens.map', drawn: 'svg' },
      { file: 'ui/embed/vignette/TrendStrip.svelte', mark: '<svg width="20" height="8"', drawn: 'svg' },
    ],
    standsInFor: ['obc-line-graph', 'obc-graph-mini'],
    reason: 'A',
    evidence: 'As trend-panel: no OpenBridge graph draws named limits, off-span marks or a break where nothing was recorded.',
    decision: APPROVED,
    ends: 'kept',
  },
  // The main app (OpenBridge-free by licence).
  {
    id: 'alert-priority-glyphs',
    draws: 'The main app\'s alarm strip priority glyphs and colours: hexagon, triangle, circle and square, from the severity table. The embed draws OpenBridge\'s obc-alert-icon instead.',
    sites: [{ file: 'ui/displays/AlertList.svelte', mark: 'viewBox="0 0 12 12"', drawn: 'svg' }],
    standsInFor: ['obi-critical-badge', 'obi-alarm-badge', 'obi-warning-badge', 'obi-caution-badge'],
    reason: 'B',
    evidence: 'The main app loads no OpenBridge (D-03, D-41; T28). Drawn independently, copying no OpenBridge path data; equal to OpenBridge\'s badge shape class and alert colour per palette (T04a). Since 0fdf1122d the vignette\'s alerts section draws obc-alert-icon (Q11).',
    decision: APPROVED,
    ends: 'kept',
  },
]

/** An SVG or canvas that draws no custom shape: OpenBridge's own pipe renderer paints it, or it only measures text. */
export interface Surface extends Site {
  readonly paints: 'connector-diagram' | 'nothing: measures text'
}

export const surfaces: ReadonlyArray<Surface> = [
  { file: 'ui/embed/composed-display/mimic/MimicPanel.svelte', mark: 'class="pipes"', paints: 'connector-diagram' },
  { file: 'ui/embed/composed-display/mimic/MimicPanel.svelte', mark: 'use:keyGlyph', paints: 'connector-diagram' },
  { file: 'ui/embed/composed-display/mimic/openbridge-mimic.ts', mark: "canvas.getContext('2d')", paints: 'connector-diagram' },
  { file: 'ui/embed/vignette/NetworkTopology.svelte', mark: 'use:lines', paints: 'connector-diagram' },
  { file: 'ui/embed/vignette/lines.ts', mark: "canvas.getContext('2d')", paints: 'connector-diagram' },
  { file: 'ui/embed/composed-display/text-measure.ts', mark: "createElement('canvas')", paints: 'nothing: measures text' },
]

/** An OpenBridge internal the embed relies on outside the manifest (policy §5): where it is used, and where the installed package defines it. */
export interface Internal {
  readonly kind: 'part' | 'shadow root' | 'property'
  /** The CSS part, the selector reached in the shadow root, or the custom property. */
  readonly name: string
  readonly element: OpenBridgeTag | 'every element'
  readonly used: Site
  /** A file of the installed @oicl/openbridge-webcomponents (relative to its root) and the text there that defines it. */
  readonly defined: { readonly file: string; readonly mark: string }
  readonly why: string
}

const part = (name: string): Internal => ({
  kind: 'part', name, element: 'obc-button',
  used: { file: 'ui/embed/composed-display/operation/ControlSection.svelte', mark: `.execute::part(${name})` },
  defined: { file: 'dist/components/button/button.js', mark: `part="${name}"` },
  why: 'An execute button\'s label wraps onto a second line instead of being cut.',
})

const property = (name: string, element: Internal['element'], used: Site, defined: string, why: string): Internal => ({
  kind: 'property', name, element, used, defined: { file: defined, mark: `var(${name})` }, why,
})

const mimic = 'ui/embed/composed-display/mimic/MimicPanel.svelte'
const indicatorType = ['--global-typography-ui-button-font-size', '--global-typography-ui-button-line-height', '--global-typography-ui-body-font-size', '--global-typography-ui-body-line-height']

export const internals: ReadonlyArray<Internal> = [
  part('wrapper'),
  part('visible-wrapper'),
  part('label'),
  {
    kind: 'shadow root', name: 'obc-automation-button-readout-stack', element: 'obc-automation-button',
    used: { file: mimic, mark: "shadowRoot?.querySelector('obc-automation-button-readout-stack')" },
    defined: { file: 'dist/automation/automation-button/automation-button.js', mark: '<obc-automation-button-readout-stack' },
    why: 'The quick-look dot follows a device\'s tag where OpenBridge writes it.',
  },
  {
    kind: 'shadow root', name: '.tag', element: 'obc-automation-button-readout-stack',
    used: { file: mimic, mark: "shadowRoot?.querySelector('.tag')" },
    defined: { file: 'dist/components/automation-button-readout-stack/automation-button-readout-stack.js', mark: 'class="tag"' },
    why: 'The quick-look dot follows a device\'s tag where OpenBridge writes it.',
  },
  property('--obc-can-hover', 'obc-automation-button', { file: mimic, mark: '--obc-can-hover: 0' },
    'dist/automation/automation-button/automation-button.css.js', 'A read-only drawing shows no hover look.'),
  ...['--automation-components-badge-new-size', '--automation-components-badge-new-icon-size', '--automation-components-badge-new-icon-size-flat'].map(name =>
    property(name, 'obc-automation-badge', { file: mimic, mark: `${name}:` }, 'dist/automation/automation-badge/automation-badge.css.js', 'The key\'s badges at the key\'s line height.')),
  ...indicatorType.map(name =>
    property(name, 'obc-status-indicator', { file: 'ui/embed/composed-display/FaceplateLine.svelte', mark: `${name}:` }, 'dist/components/status-indicator/status-indicator.css.js', 'The indicator\'s label at a faceplate row\'s 12/16 px.')),
  ...indicatorType.map(name =>
    property(name, 'obc-status-indicator', { file: 'ui/embed/vignette/StateWord.svelte', mark: `${name}:` }, 'dist/components/status-indicator/status-indicator.css.js', 'The indicator\'s word at a vignette row\'s 13/16 px.')),
  ...['--ui-components-button-touch-target-size', '--ui-components-icon-button-visual-target-size'].map(name =>
    property(name, 'obc-icon-button', { file: 'ui/embed/composed-display/mimic/MimicPopover.svelte', mark: `${name}:` }, 'dist/components/icon-button/icon-button.css.js', 'The pin fits the popover\'s 24 px header.')),
  property('--font-family-main', 'every element', { file: 'ui/embed/embed.css', mark: '--font-family-main:' },
    'dist/openbridge.css', 'System faces stand in for Noto Sans, which OpenBridge declares without a fallback; only a mimic loads the font.'),
  property('--global-typography-font-family', 'every element', { file: 'ui/embed/embed.css', mark: '--global-typography-font-family:' },
    'dist/components/status-indicator/status-indicator.css.js', 'Components read the family in their shadow roots through this token; re-derived per element so they take the same system faces.'),
]
