<script lang="ts">
  import type { ComposedComparisonPanel } from '../../../packs/process-plant/displays/compose.ts'
  import { composedDisplayLayout } from '../../../packs/process-plant/displays/composition.ts'
  import type { ComposedDisplaySample } from './composed-display-client.ts'
  import { chipName, limitOrderName, thresholdFullName } from '../../../packs/process-plant/displays/display-text.ts'
  import { displayValue, formatValue, logarithmicSpan, readingText, shownReading, unitLabel } from '../../../packs/process-plant/quantity-text.ts'
  import { expectedOfRule, median, sampledGates } from './panel-presenters.ts'
  import type { DisplayAnnunciation } from '../../../packs/process-plant/displays/annunciators.ts'
  import { COMPARISON_HISTORY_MS, ratePerMinute, rateText, rateWindowMs, trendReading, windowText, type TrendPoint } from '../../../packs/process-plant/displays/trend-reading.ts'
  import { limitLabelParts, limitLabelRanks, limitLines, limitSeverity, stackLabels, type LabelSlot } from './limit-labels.ts'
  import { displayName, fitName } from './pen-style.ts'
  import { panelFont, textMeasure } from './text-measure.ts'
  import { paddedDomain, rawDomain, type ValueDomain } from './trend-geometry.ts'

  let { panel, latest, series, range, activeRuleIds, annunciation }: {
    panel: ComposedComparisonPanel
    latest: ComposedDisplaySample | undefined
    series: ReadonlyMap<string, ReadonlyArray<TrendPoint>>
    range: ValueDomain | null
    activeRuleIds: ReadonlySet<string>
    /** What the I&C declares of its alarms: a limit state whose alarms are all expected after a first-out is faded. */
    annunciation: DisplayAnnunciation
  } = $props()

  let width = $state(520)
  const valueWidth = 220
  // The label column is as wide as its widest label, measured in the panel's
  // font, up to two fifths of the panel; a longer label drops whole words
  // until it fits, so the track never starts under text.
  const LABEL_GAP = 10
  const measures = { primary: textMeasure(panelFont(12, 700)), context: textMeasure(panelFont(12)) }
  const measure = (text: string, primary: boolean): number => (primary ? measures.primary : measures.context)(text)
  // A demand and a value only the simulator computes say so after their name, whatever room is left.
  const suffix = (pen: (typeof panel.pens)[number]): string => `${pen.command ? ' (demand)' : ''}${pen.simulatorOnly ? ' (SIM)' : ''}`
  const labelled = $derived(panel.pens.map(pen => ({ text: `${displayName(pen)}${suffix(pen)}`, shorter: pen.shorterNames.map(name => `${name}${suffix(pen)}`), primary: pen.role === 'primary' })))
  const labelWidth = $derived(Math.min(Math.round(width * 0.4), Math.ceil(Math.max(...labelled.map(label => measure(label.text, label.primary)))) + LABEL_GAP))
  const fitted = (label: { readonly text: string; readonly shorter: ReadonlyArray<string>; readonly primary: boolean }): string =>
    fitName(label.text, text => measure(text, label.primary) <= labelWidth - LABEL_GAP, label.shorter)
  const scaleStart = $derived(labelWidth)
  const scaleWidth = $derived(Math.max(60, width - labelWidth - valueWidth))

  // Readings as shown: below its resolution a reading is 0.
  const valueOf = (pen: (typeof panel.pens)[number]): number | undefined => {
    const value = latest?.values.find(entry => entry.path === String(pen.path))?.value
    return typeof value === 'number' ? shownReading(value, pen.resolution) : undefined
  }
  const values = $derived(panel.pens.map(valueOf))
  const resolution = $derived(panel.pens.map(pen => pen.resolution).find(value => value !== null) ?? null)
  const shownPoints = (pen: (typeof panel.pens)[number]): ReadonlyArray<TrendPoint> =>
    (series.get(String(pen.path)) ?? []).map(point => ({ t: point.t, v: shownReading(point.v, pen.resolution) }))
  const center = $derived(median(values.filter((value): value is number => value !== undefined)))

  // Position on a fixed, grow-only scale, shown as a pointer: bar lengths from a
  // non-zero origin would exaggerate differences (HMI review).
  const span = $derived(panel.pens.map(pen => pen.limits?.instrumentSpan ?? pen.limits?.hardRange).find(value => value !== undefined))
  const domain = $derived.by((): ValueDomain | null => {
    const limits = panel.thresholds.filter(threshold => threshold.kind !== 'control').map(threshold => threshold.value)
    const raw = range ?? rawDomain(limits)
    return raw === null ? null : paddedDomain(raw, resolution, { span: logarithmicSpan(span) ? undefined : span, limits })
  })
  const x = (value: number): number => domain === null ? scaleStart : scaleStart + ((value - domain.min) / (domain.max - domain.min)) * scaleWidth
  const row = composedDisplayLayout.comparisonRow
  const top = composedDisplayLayout.comparisonHeader
  const height = $derived(top + row * panel.pens.length)
  const deviation = (value: number): string => {
    if (center === null) return ''
    const difference = value - center
    const shown = displayValue(Math.abs(difference), panel.unit)
    const step = resolution === null ? null : displayValue(resolution, panel.unit)
    return Math.abs(difference) < (resolution ?? 1e-9) ? '' : `${difference > 0 ? '+' : '−'}${formatValue(shown, step)} vs median`
  }
  // As on a trend: limits at one value are one line; a mode-qualified limit
  // that does not act in the current mode is faint and dashed and names its
  // modes, even with a value past it; while the mode is not known yet, a
  // qualified one is dashed.
  const mode = $derived(latest?.mode)
  const gates = $derived(sampledGates(latest))
  const lines = $derived(limitLines(panel.thresholds, mode, gates))
  // The same 30 s window as a 10-minute trend's legend, so one signal never shows two rates.
  const RATE_WINDOW_MS = rateWindowMs(COMPARISON_HISTORY_MS)
  const severityRank = { critical: 0, warning: 1, notice: 2, info: 3 } as const
  const activeOf = (line: (typeof lines)[number]): string | null =>
    line.members.map(member => limitSeverity(member, activeRuleIds, mode, gates)).filter((severity): severity is keyof typeof severityRank => severity !== null)
      .sort((left, right) => severityRank[left] - severityRank[right])[0] ?? null

  // Limit names over the scale sit at their lines, pushed apart along the head
  // with a leader where two lines are closer than their names are wide ("HI
  // ALM 75" beside "HI TRIP 82"), so they never overlap. Only a head too
  // narrow for all of them folds the least important into a count, with room
  // measured for it (limit-labels.ts). Widths are measured bold, as an active
  // limit is drawn.
  const measureHead = textMeasure(panelFont(10.5, 700))
  const HEAD_GAP = 8
  const LINE_TOP = top - 6
  // One name per line: its order and value, then what the limits there do,
  // each action once, one that does not act in the current mode with its
  // modes (limitLabelParts): "LO-LO 20 · AFW START + RX TRIP (Modes 1–2)".
  const headName = (line: (typeof lines)[number]): string =>
    `${limitOrderName(line.members[0]!)} ${displayValue(line.value, panel.unit)} · ${limitLabelParts(line, lines, mode, gates).map(part => `${part.text}${part.waits === '' ? '' : ` (${part.waits})`}`).join(' ')}`
  // The limit each value's reading names (trend-reading.ts): what it heads for or is past.
  const namedRuleIds = $derived(new Set(panel.pens.flatMap((pen, index) => {
    const value = values[index]
    if (value === undefined) return []
    const limit = trendReading({ value, points: shownPoints(pen), windowMs: RATE_WINDOW_MS, unit: pen.unit, thresholds: pen.thresholds, mode, gates, activeRuleIds, resolution: pen.resolution, ...(pen.limits?.instrumentSpan === undefined ? {} : { span: pen.limits.instrumentSpan }) }).limit
    return limit?.kind === 'margin' || limit?.kind === 'past' ? [limit.margin.threshold.ruleId] : []
  })))
  const heads = $derived.by(() => {
    if (domain === null) return []
    const ranks = limitLabelRanks(lines.map(line => ({
      key: line.key,
      value: line.value,
      active: activeOf(line),
      ahead: line.members.some(member => member.ruleIds.some(ruleId => namedRuleIds.has(ruleId))),
      inForce: line.look !== 'idle',
    })), center ?? undefined)
    const tight = lines.reduce((sum, line) => sum + measureHead(headName(line)) + HEAD_GAP, 0) > width
    const slots = lines.map((line): LabelSlot => {
      const size = measureHead(`${headName(line)}${tight ? ' (+9)' : ''}`) + HEAD_GAP
      return { key: line.key, want: x(line.value) - size / 2, size, group: line.members[0]!.direction, rank: ranks.get(line.key)! }
    })
    const byKey = new Map(lines.map(line => [line.key, line]))
    const sizes = new Map(slots.map(slot => [slot.key, slot.size]))
    return stackLabels(slots, { start: 0, end: width }).map(label => {
      const named = byKey.get(label.key)!
      const folded = label.folded.map(key => byKey.get(key)!)
      return {
        key: label.key,
        lineX: x(named.value),
        x: label.start + sizes.get(label.key)! / 2,
        idle: named.look === 'idle',
        text: `${headName(named)}${folded.length > 0 ? ` (+${folded.length})` : ''}`,
        title: [named, ...folded].flatMap(line => line.members).map(threshold => `${thresholdFullName(threshold, panel.unit)}: ${threshold.label}${threshold.modeNames === undefined ? '' : `, only in ${threshold.modeNames}`}`).join('\n'),
        active: activeOf(named) ?? folded.map(activeOf).find(active => active !== null) ?? null,
      }
    })
  })
</script>

<div class="comparison" bind:clientWidth={width}>
  <svg {width} {height} role="img" aria-label={`Comparison now: ${panel.pens.map((pen, index) => `${displayName(pen)} ${values[index] === undefined ? 'no value' : readingText(values[index]!, panel.unit, pen.resolution, pen.limits?.instrumentSpan)}`).join('; ')}`}>
    {#if domain !== null}
      {#each lines as line (line.key)}
        <line class={`threshold ${line.look}`} x1={x(line.value)} x2={x(line.value)} y1={LINE_TOP} y2={height}><title>{line.members.map(member => member.label).join('\n')}</title></line>
      {/each}
      {#each heads as head (head.key)}
        {#if Math.abs(head.x - head.lineX) > 2}
          <!-- A name pushed off its line keeps a leader down to it. -->
          <polyline class="leader" points={`${head.x},15 ${head.lineX},${top - 1}`} />
        {/if}
        <text class={`head ${head.active === null ? '' : `active-${head.active}`}`} class:idle={head.idle} x={head.x} y="12" text-anchor="middle"><title>{head.title}</title>{head.text}</text>
      {/each}
      {#if center !== null}
        <line class="median" x1={x(center)} x2={x(center)} y1={top - 2} y2={height} />
      {/if}
    {/if}
    {#each panel.pens as pen, index (pen.path)}
      {@const value = values[index]}
      {@const y = top + index * row}
      {@const reading = value === undefined ? null : trendReading({ value, points: shownPoints(pen), windowMs: RATE_WINDOW_MS, unit: pen.unit, thresholds: pen.thresholds, mode, gates, activeRuleIds, resolution: pen.resolution, ...(pen.limits?.instrumentSpan === undefined ? {} : { span: pen.limits.instrumentSpan }) })}
      {@const inAlarm = reading?.inAlarm ?? null}
      <text class="tag" class:primary={pen.role === 'primary'} x="0" y={y + row / 2} dominant-baseline="middle">{fitted(labelled[index]!)}<title>{labelled[index]!.text} · {pen.label} · {pen.role}{pen.command ? ' · operator or automation demand, not a measured state' : ''}</title></text>
      <line class="track" x1={scaleStart} x2={scaleStart + scaleWidth} y1={y + row / 2} y2={y + row / 2} />
      {#if value !== undefined && domain !== null}
        <path class="pointer" class:primary={pen.role === 'primary'} class:alarm={inAlarm !== null} d={`M${x(value)} ${y + 4} l5 ${row / 2 - 4} l-5 ${row / 2 - 4} l-5 ${-(row / 2 - 4)} z`} />
        <text class="value" x={scaleStart + scaleWidth + 10} y={y + row / 2} dominant-baseline="middle">{readingText(value, panel.unit, pen.resolution, pen.limits?.instrumentSpan)}{#if inAlarm !== null}<tspan class={`state ${inAlarm.severity ?? 'warning'}${expectedOfRule(inAlarm.ruleId, latest?.alarms ?? [], annunciation) === null ? '' : ' expected'}`} dx="6">{chipName(inAlarm)}</tspan>{/if}<tspan class="sub" dx="6">{reading?.offScale == null ? `${deviation(value)} ${rateText(ratePerMinute(shownPoints(pen), RATE_WINDOW_MS), value, panel.unit, { resolution: pen.resolution })}` : `${reading.offScale} range`}</tspan></text>
      {:else}
        <text class="value" x={scaleStart + scaleWidth + 10} y={y + row / 2} dominant-baseline="middle">—</text>
      {/if}
    {/each}
  </svg>
  {#if center !== null && domain !== null}<p class="caption">Scale {formatValue(displayValue(domain.min, panel.unit))}–{formatValue(displayValue(domain.max, panel.unit))} {unitLabel(panel.unit)} · dotted line: median of the {panel.pens.length} signals now · rates over {windowText(RATE_WINDOW_MS)}</p>{/if}
</div>

<style>
  .comparison { width: 100%; }
  svg { display: block; overflow: visible; }
  .head { fill: var(--element-neutral-color); font-size: 10.5px; font-variant-numeric: tabular-nums; }
  .head.active-critical { fill: var(--alert-alarm-color); font-weight: 700; }
  .head.active-warning { fill: var(--alert-warning-color); font-weight: 700; }
  .head.active-notice, .head.active-info { fill: var(--alert-caution-color); font-weight: 700; }
  .tag { fill: var(--element-neutral-color); font-size: 12px; font-variant-numeric: tabular-nums; }
  .tag.primary { fill: var(--element-active-color); font-weight: 700; }
  .track { stroke: var(--border-divider-color); stroke-width: 2; }
  /* Values stand out by shape and weight; alarm colour only while a rule is active. */
  .pointer { fill: var(--element-neutral-color); }
  .pointer.primary { fill: var(--element-active-color); }
  .pointer.alarm { stroke: var(--alert-warning-color); stroke-width: 2; }
  .value { fill: var(--element-active-color); font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .sub { fill: var(--element-neutral-color); font-size: 11px; font-weight: 400; }
  /* Same meaning as the alarm chip elsewhere: shown only while the rule is active. */
  .state { font-size: 10.5px; font-weight: 700; }
  .state.critical { fill: var(--alert-alarm-color); }
  .state.warning { fill: var(--alert-warning-color); }
  .state.notice, .state.info { fill: var(--alert-caution-color); }
  /* Expected after a first-out it followed: faded, as the drawing's frame and the list's row are. */
  .state.expected { opacity: 0.45; }
  .median { stroke: var(--element-neutral-color); stroke-dasharray: 2 3; }
  .threshold { stroke: var(--element-neutral-color); stroke-width: 1.5; }
  .threshold.qualified { stroke-dasharray: 5 3; }
  .threshold.idle { stroke-dasharray: 3 4; stroke-opacity: 0.35; }
  .head.idle { fill-opacity: 0.6; }
  .leader { fill: none; stroke: var(--element-neutral-color); stroke-width: 1; stroke-opacity: 0.7; }
  .caption { margin: 0; font-size: 10.5px; color: var(--element-neutral-color); }
</style>
