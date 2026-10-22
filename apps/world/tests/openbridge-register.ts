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
  // Shapes the old renderer drew that the vignette draws too (the old renderer went at the swap, P2 architecture §D).
  {
    id: 'reactor-vessel',
    draws: 'The reactor core as its vessel: head, flange, body, bottom, nozzle collars, the level as its fill and the rod banks by inserted length.',
    sites: [
      { file: 'ui/embed/vignette/vessel-symbol.ts', mark: 'export const vesselGeometry', drawn: 'code' },
      { file: 'ui/embed/vignette/Vessel.svelte', mark: 'class="vessel"', drawn: 'svg' },
    ],
    standsInFor: 'none',
    reason: 'A',
    evidence: 'OpenBridge 2.0.0 has no reactor symbol. Filled and framed in the tokens of obc-automation-tank\'s regular scheme; geometry is a tested pure function (vignette-vessel-symbol).',
    decision: { owner: 'approved', ref: 'D-19 (12 Oct): the one exception to OpenBridge components' },
    ends: 'kept',
  },
  {
    id: 'bus-and-header-straights',
    draws: 'Process and steam headers and electrical buses as connector-diagram\'s large straight segments.',
    sites: [
      { file: 'ui/embed/vignette/flow-symbols.ts', mark: "kind: 'straight', connectionId: node.id", drawn: 'code' },
    ],
    standsInFor: ['obc-bus'],
    reason: 'A',
    evidence: 'Drawn by OpenBridge\'s own pipe renderer, but OpenBridge 2.0.0 has obc-bus for an electrical bus; no component for a process header (A). The old renderer drew its buses so too, with no reason on record; the vignette draws only its headers so, its buses as obc-bus.',
    decision: APPROVED,
    ends: 'kept',
  },
  // The Plant's operating panel (embed only).
  {
    id: 'sparkline',
    draws: 'A reading\'s recent trend as a hand-drawn sparkline, standing in for OpenBridge\'s mini graph: a proposal\'s cited reading, its last ten minutes beside its margin to its limit.',
    sites: [{ file: 'packs/process-plant/ui/displays/operation/ProposalSection.svelte', mark: '<svg class="spark"', drawn: 'svg' }],
    standsInFor: ['obc-graph-mini'],
    reason: 'A',
    evidence: 'obc-graph-mini cannot break its line where nothing was recorded (wiki design-system page). Approved in Q11 for the old renderer\'s lead sparkline (ui/embed/composed-display/Sparkline.svelte, deleted at the swap); the proposal card\'s cited reading, the lead\'s D3 ruling 1 for its evidence, is the same shape for the same reason, and its one site since the swap.',
    decision: APPROVED,
    ends: 'kept',
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
  { file: 'ui/embed/vignette/NetworkTopology.svelte', mark: 'use:lines', paints: 'connector-diagram' },
  { file: 'ui/embed/vignette/FlowTopology.svelte', mark: 'use:lines', paints: 'connector-diagram' },
  { file: 'ui/embed/vignette/lines.ts', mark: "canvas.getContext('2d')", paints: 'connector-diagram' },
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
  used: { file: 'packs/process-plant/ui/displays/operation/ControlSection.svelte', mark: `.execute::part(${name})` },
  defined: { file: 'dist/components/button/button.js', mark: `part="${name}"` },
  why: 'An execute button\'s label wraps onto a second line instead of being cut.',
})

const property = (name: string, element: Internal['element'], used: Site, defined: string, why: string): Internal => ({
  kind: 'property', name, element, used, defined: { file: defined, mark: `var(${name})` }, why,
})

const indicatorType = ['--global-typography-ui-button-font-size', '--global-typography-ui-button-line-height', '--global-typography-ui-body-font-size', '--global-typography-ui-body-line-height']

export const internals: ReadonlyArray<Internal> = [
  part('wrapper'),
  part('visible-wrapper'),
  part('label'),
  ...indicatorType.map(name =>
    property(name, 'obc-status-indicator', { file: 'ui/embed/vignette/StateWord.svelte', mark: `${name}:` }, 'dist/components/status-indicator/status-indicator.css.js', 'The indicator\'s word at a vignette row\'s 13/16 px.')),
  property('--font-family-main', 'every element', { file: 'ui/embed/embed.css', mark: '--font-family-main:' },
    'dist/openbridge.css', 'System faces stand in for Noto Sans, which OpenBridge declares without a fallback.'),
  property('--global-typography-font-family', 'every element', { file: 'ui/embed/embed.css', mark: '--global-typography-font-family:' },
    'dist/components/status-indicator/status-indicator.css.js', 'Components read the family in their shadow roots through this token; re-derived per element so they take the same system faces.'),
]
