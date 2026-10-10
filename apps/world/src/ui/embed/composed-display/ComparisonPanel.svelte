<script lang="ts">
  import type { ComposedComparisonPanel } from '../../../packs/process-plant/displays/compose.ts'
  import { composedDisplayLayout } from '../../../packs/process-plant/displays/composition.ts'
  import type { ComposedDisplaySample } from './composed-display-client.ts'
  import { displayValue, formatQuantity, formatValue, limitKindName, thresholdName } from '../../../packs/process-plant/displays/display-text.ts'
  import { activeThreshold, limitAhead, limitInForce, limitsInForce, median, ratePerMinute, rateText, rateWindowMs, windowText } from './panel-presenters.ts'
  import { limitLabelRanks, stackLabels, type LabelSlot } from './limit-labels.ts'
  import { displayName, fitName } from './pen-style.ts'
  import { panelFont, textMeasure } from './text-measure.ts'
  import { paddedDomain, rawDomain, type TrendPoint, type ValueDomain } from './trend-geometry.ts'

  let { panel, latest, series, range, activeRuleIds }: {
    panel: ComposedComparisonPanel
    latest: ComposedDisplaySample | undefined
    series: ReadonlyMap<string, ReadonlyArray<TrendPoint>>
    range: ValueDomain | null
    activeRuleIds: ReadonlySet<string>
  } = $props()

  let width = $state(520)
  const valueWidth = 220
  // The label column is as wide as its widest label, measured in the panel's
  // font, up to two fifths of the panel; a longer label drops whole words
  // until it fits, so the track never starts under text.
  const LABEL_GAP = 10
  const measures = { primary: textMeasure(panelFont(12, 700)), context: textMeasure(panelFont(12)) }
  const measure = (text: string, primary: boolean): number => (primary ? measures.primary : measures.context)(text)
  const labelled = $derived(panel.pens.map(pen => ({ text: `${displayName(pen)}${pen.command ? ' (demand)' : ''}`, primary: pen.role === 'primary' })))
  const labelWidth = $derived(Math.min(Math.round(width * 0.4), Math.ceil(Math.max(...labelled.map(label => measure(label.text, label.primary)))) + LABEL_GAP))
  const fitted = (label: { readonly text: string; readonly primary: boolean }): string =>
    fitName(label.text, text => measure(text, label.primary) <= labelWidth - LABEL_GAP)
  const scaleStart = $derived(labelWidth)
  const scaleWidth = $derived(Math.max(60, width - labelWidth - valueWidth))

  const valueOf = (path: string): number | undefined => {
    const value = latest?.values.find(entry => entry.path === path)?.value
    return typeof value === 'number' ? value : undefined
  }
  const values = $derived(panel.pens.map(pen => valueOf(String(pen.path))))
  const center = $derived(median(values.filter((value): value is number => value !== undefined)))

  // Position on a fixed, grow-only scale, shown as a pointer: bar lengths from a
  // non-zero origin would exaggerate differences (HMI review).
  const domain = $derived.by((): ValueDomain | null => {
    const raw = rawDomain([
      ...(range === null ? [] : [range.min, range.max]),
      ...panel.thresholds.filter(threshold => threshold.kind !== 'control').map(threshold => threshold.value),
    ])
    return raw === null ? null : paddedDomain(raw)
  })
  const x = (value: number): number => domain === null ? scaleStart : scaleStart + ((value - domain.min) / (domain.max - domain.min)) * scaleWidth
  const row = composedDisplayLayout.comparisonRow
  const top = composedDisplayLayout.comparisonHeader
  const height = $derived(top + row * panel.pens.length)
  const deviation = (value: number): string => {
    if (center === null) return ''
    const difference = value - center
    return Math.abs(difference) < 1e-9 ? '' : `${difference > 0 ? '+' : '−'}${formatValue(displayValue(Math.abs(difference), panel.unit))} vs median`
  }
  const lines = $derived(panel.thresholds.filter(threshold => threshold.kind !== 'control'))
  // The same 30 s window as a 10-minute trend's legend, so one signal never shows two rates.
  const RATE_WINDOW_MS = rateWindowMs(600_000)
  const activeOf = (threshold: (typeof lines)[number]): string | null =>
    threshold.ruleIds.some(ruleId => activeRuleIds.has(ruleId)) ? threshold.severity ?? 'warning' : null
  // As on a trend: a mode-qualified limit that does not act in the current
  // mode is faint and dashed and names its modes; while the mode is not known
  // yet, a qualified one is dashed.
  const lineLook = (threshold: (typeof lines)[number]): 'acting' | 'qualified' | 'idle' =>
    threshold.modeIds === undefined ? 'acting'
      : latest?.mode === undefined ? 'qualified'
        : limitInForce(threshold, latest.mode, activeOf(threshold) !== null) ? 'acting' : 'idle'

  // Limit names over the scale sit at their lines, pushed apart along the head
  // with a leader where two lines are closer than their names are wide ("HI
  // ALM 75" beside "HI TRIP 82"), so they never overlap. Only a head too
  // narrow for all of them folds the least important into a count, with room
  // measured for it (limit-labels.ts). Widths are measured bold, as an active
  // limit is drawn.
  const measureHead = textMeasure(panelFont(10.5, 700))
  const HEAD_GAP = 8
  const LINE_TOP = top - 6
  const headName = (threshold: (typeof lines)[number]): string =>
    `${thresholdName(threshold, panel.unit, { withUnit: false })}${lineLook(threshold) === 'idle' ? ` (${threshold.modeLabel})` : ''}`
  const aheadRuleIds = $derived(new Set(panel.pens.flatMap((pen, index) => {
    const value = values[index]
    const ahead = value === undefined ? null : limitAhead(value, ratePerMinute(series.get(String(pen.path)) ?? [], RATE_WINDOW_MS), limitsInForce(pen.thresholds, latest?.mode, activeRuleIds))
    return ahead === null ? [] : [ahead.threshold.ruleId]
  })))
  const heads = $derived.by(() => {
    if (domain === null) return []
    const ranks = limitLabelRanks(lines.map(threshold => ({
      key: threshold.ruleId,
      value: threshold.value,
      active: activeOf(threshold),
      ahead: threshold.ruleIds.some(ruleId => aheadRuleIds.has(ruleId)),
      inForce: lineLook(threshold) !== 'idle',
    })), center ?? undefined)
    const tight = lines.reduce((sum, threshold) => sum + measureHead(headName(threshold)) + HEAD_GAP, 0) > width
    const slots = lines.map((threshold): LabelSlot => {
      const size = measureHead(`${headName(threshold)}${tight ? ' (+9)' : ''}`) + HEAD_GAP
      return { key: threshold.ruleId, want: x(threshold.value) - size / 2, size, group: threshold.direction, rank: ranks.get(threshold.ruleId)! }
    })
    const byKey = new Map(lines.map(threshold => [threshold.ruleId, threshold]))
    const sizes = new Map(slots.map(slot => [slot.key, slot.size]))
    return stackLabels(slots, { start: 0, end: width }).map(label => {
      const named = byKey.get(label.key)!
      const folded = label.folded.map(key => byKey.get(key)!)
      return {
        key: label.key,
        lineX: x(named.value),
        x: label.start + sizes.get(label.key)! / 2,
        idle: lineLook(named) === 'idle',
        text: `${headName(named)}${folded.length > 0 ? ` (+${folded.length})` : ''}`,
        title: [named, ...folded].map(threshold => `${thresholdName(threshold, panel.unit)}: ${threshold.label}${threshold.modeLabel === undefined ? '' : `, only in ${threshold.modeLabel}`}`).join('\n'),
        active: activeOf(named) ?? folded.map(activeOf).find(active => active !== null) ?? null,
      }
    })
  })
</script>

<div class="comparison" bind:clientWidth={width}>
  <svg {width} {height} role="img" aria-label={`Comparison now: ${panel.pens.map((pen, index) => `${displayName(pen)} ${values[index] === undefined ? 'no value' : formatQuantity(values[index]!, panel.unit)}`).join('; ')}`}>
    {#if domain !== null}
      {#each lines as threshold (threshold.ruleId)}
        <line class={`threshold ${lineLook(threshold)}`} x1={x(threshold.value)} x2={x(threshold.value)} y1={LINE_TOP} y2={height}><title>{threshold.label}</title></line>
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
      {@const inAlarm = activeThreshold(pen.thresholds, activeRuleIds)}
      <text class="tag" class:primary={pen.role === 'primary'} x="0" y={y + row / 2} dominant-baseline="middle">{fitted(labelled[index]!)}<title>{labelled[index]!.text} · {pen.label} · {pen.role}{pen.command ? ' · operator or automation demand, not a measured state' : ''}</title></text>
      <line class="track" x1={scaleStart} x2={scaleStart + scaleWidth} y1={y + row / 2} y2={y + row / 2} />
      {#if value !== undefined && domain !== null}
        <path class="pointer" class:primary={pen.role === 'primary'} class:alarm={inAlarm !== null} d={`M${x(value)} ${y + 4} l5 ${row / 2 - 4} l-5 ${row / 2 - 4} l-5 ${-(row / 2 - 4)} z`} />
        <text class="value" x={scaleStart + scaleWidth + 10} y={y + row / 2} dominant-baseline="middle">{formatQuantity(value, panel.unit)}{#if inAlarm !== null}<tspan class={`state ${inAlarm.severity ?? 'warning'}`} dx="6">{limitKindName(inAlarm)}</tspan>{/if}<tspan class="sub" dx="6">{deviation(value)} {rateText(ratePerMinute(series.get(String(pen.path)) ?? [], RATE_WINDOW_MS), value, panel.unit)}</tspan></text>
      {:else}
        <text class="value" x={scaleStart + scaleWidth + 10} y={y + row / 2} dominant-baseline="middle">—</text>
      {/if}
    {/each}
  </svg>
  {#if center !== null && domain !== null}<p class="caption">Scale {formatValue(displayValue(domain.min, panel.unit))}–{formatQuantity(domain.max, panel.unit)} · dotted line: median of the {panel.pens.length} signals now · rates over {windowText(RATE_WINDOW_MS)}</p>{/if}
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
  .median { stroke: var(--element-neutral-color); stroke-dasharray: 2 3; }
  .threshold { stroke: var(--element-neutral-color); stroke-width: 1.5; }
  .threshold.qualified { stroke-dasharray: 5 3; }
  .threshold.idle { stroke-dasharray: 3 4; stroke-opacity: 0.35; }
  .head.idle { fill-opacity: 0.6; }
  .leader { fill: none; stroke: var(--element-neutral-color); stroke-width: 1; stroke-opacity: 0.7; }
  .caption { margin: 0; font-size: 10.5px; color: var(--element-neutral-color); }
</style>
