<script lang="ts">
  import type { ComposedTrendStrip, ComposedTrendThreshold } from '../../../packs/process-plant/displays/compose.ts'
  import { displayValue, formatQuantity, limitOrderName, offScale, readingText, shownReading, simulationClock, thresholdFullName, thresholdName, unitLabel } from '../../../packs/process-plant/displays/display-text.ts'
  import {
    limitInScale,
    paddedDomain,
    rawDomain,
    stepPath,
    tickLabels,
    timeTicks,
    valueTicks,
    type ValueDomain,
  } from './trend-geometry.ts'
  import { idleText, limitLabelRanks, limitLines, limitLook, limitSeverity, stackLabels, type LabelSlot } from './limit-labels.ts'
  import type { ComposedDisplaySample } from './composed-display-client.ts'
  import { HOLD_GAP_MS, rateWindowMs, trendReading, type GateStates, type TrendPoint } from '../../../packs/process-plant/displays/trend-reading.ts'
  import { penStroke } from './pen-style.ts'
  import { panelFont, textMeasure } from './text-measure.ts'

  // One strip of a trend: one measurement of parallel equipment on its own
  // value axis. Strips of a trend share the time window; only the bottom one
  // labels the time axis and only the top one names the advice marker.
  let {
    strip,
    horizon,
    horizonMs,
    windowMs,
    series,
    range,
    now,
    issuedAt,
    runStartedAt,
    height,
    timeAxis,
    adviceLabel,
    mode,
    gates,
    activeRuleIds,
  }: {
    strip: ComposedTrendStrip
    horizon: string
    /** The horizon's length; rates over it are read as the legend reads them. */
    horizonMs: number
    /** The time the strip spans: the horizon, or the Run's history when that is shorter. */
    windowMs: number
    series: ReadonlyMap<string, ReadonlyArray<TrendPoint>>
    range: ValueDomain | null
    now: number
    /** When the advice was given; null for a display World generates itself, which marks no advice. */
    issuedAt: number | null
    /** Simulation time the Run started, when known; history cannot reach before it. */
    runStartedAt: number | null
    height: number
    timeAxis: boolean
    adviceLabel: boolean
    /** The Plant's operating mode in the latest sample; undefined before it or where the Plant declares none. */
    mode: ComposedDisplaySample['mode']
    /** The on/off states the strip's gated limits require, as the latest sample reads them. */
    gates: GateStates
    /** I&C rules active now; their threshold labels take the alarm colour while they act in the mode. */
    activeRuleIds: ReadonlySet<string>
  } = $props()

  let width = $state(520)
  // Several strips share the page; each hatch pattern needs its own id.
  const uid = $props.id()
  const patternId = `no-data-${uid}`

  // The strip's pens share one measurement, and so one resolution: readings
  // below it are drawn as 0 and its scale never magnifies them.
  const resolution = $derived(strip.pens.map(pen => pen.resolution).find(value => value !== null) ?? null)
  const shownPoints = (pen: (typeof strip.pens)[number]): ReadonlyArray<TrendPoint> =>
    (series.get(String(pen.path)) ?? []).map(point => ({ t: point.t, v: shownReading(point.v, pen.resolution) }))

  // Trip and alarm thresholds near the values share their scale; farther ones
  // are named at the plot edge they lie beyond. Control set points are marked
  // on the axis only when they fall inside it, to keep the trend quiet. Limits
  // at one value are one line, each with its own label.
  const limitThresholds = $derived(strip.thresholds.filter(threshold => threshold.kind !== 'control'))
  const lines = $derived(limitLines(limitThresholds, mode, gates))
  const drawnLines = $derived(lines.filter(line => limitInScale(line.value, range)))
  const controlThresholds = $derived(strip.thresholds.filter(threshold => threshold.kind === 'control'))

  // Fixed scale: the grow-only range seen since the view opened plus the drawn
  // thresholds. Control set points never widen it.
  const domain = $derived.by((): ValueDomain | null => {
    const raw = rawDomain([
      ...(range === null ? [] : [range.min, range.max]),
      ...drawnLines.map(line => line.value),
    ])
    return raw === null ? null : paddedDomain(raw, resolution)
  })

  // A line's label: its order and value, then what each limit there does,
  // those acting now first and the most severe first (limitLines), one that
  // does not act now with the modes it acts in or the on/off states it waits
  // for in brackets, drawn faint like its line: "LO-LO 20 · AFW START + RX
  // TRIP (Modes 1–2)". Where the gutter is too narrow, whole parts wrap onto
  // rows under it, each led by its "+" or bracket and indented, so a mode
  // never reads as a limit of its own (QA review: the faint "Mode 1").
  const LINE = 12
  /** How far a label's continued rows are indented. */
  const CONTINUED = 8
  const measureLabel = textMeasure(panelFont(10, 700))
  const rowText = (threshold: ComposedTrendThreshold): string => thresholdName(threshold, strip.unit, { withUnit: false })
  interface LabelPart { readonly text: string; readonly member: ComposedTrendThreshold; readonly idle: boolean }
  const labelParts = (line: (typeof lines)[number]): ReadonlyArray<LabelPart> => line.members.flatMap((member, index) => {
    const idle = limitLook(member, mode, gates) === 'idle'
    return [
      { text: `${index === 0 ? '' : '+ '}${member.action}`, member, idle },
      ...(idle ? [{ text: `(${idleText(member, mode)})`, member, idle }] : []),
    ]
  })
  /** The label's rows: its head with as many whole parts as fit the gutter, then the rest, each row as many as fit; a fold count follows the head's row. */
  const labelRows = (head: string, parts: ReadonlyArray<LabelPart>): ReadonlyArray<ReadonlyArray<LabelPart>> => {
    const rows: Array<Array<LabelPart>> = [[]]
    let used = head
    for (const part of parts) {
      const row = rows.at(-1)!
      const next = `${used}${row.length === 0 ? '' : ' '}${part.text}`
      if (row.length === 0 || measureLabel(next) + (rows.length === 1 ? 0 : CONTINUED) <= GUTTER_TEXT) {
        row.push(part)
        used = next
      } else {
        rows.push([part])
        used = part.text
      }
    }
    return rows
  }
  // The right gutter is as wide as its widest label, room for a fold count included, within bounds.
  const GUTTER_MIN = 118
  const GUTTER_MAX = 190
  const gutter = $derived(Math.min(GUTTER_MAX, Math.max(GUTTER_MIN, Math.ceil(Math.max(0, ...limitThresholds.map(threshold => measureLabel(`▲ ${rowText(threshold)} (+9)`)))) + 14)))
  const headOf = (line: (typeof lines)[number], edge: 'above' | 'below' | null): string =>
    `${edge === null ? '' : edge === 'above' ? '▲ ' : '▼ '}${limitOrderName(line.members[0]!)} ${displayValue(line.value, strip.unit)} · `
  const pad = $derived({ left: 44, right: gutter, top: 18, bottom: timeAxis ? 22 : 0 })
  const GUTTER_TEXT = $derived(gutter - 12)

  const windowStart = $derived(now - windowMs)
  const plotWidth = $derived(Math.max(40, width - pad.left - pad.right))
  const plotHeight = $derived(Math.max(24, height - pad.top - pad.bottom))
  const x = (t: number): number => pad.left + ((t - windowStart) / windowMs) * plotWidth
  const y = (v: number): number => domain === null ? pad.top : pad.top + (1 - (v - domain.min) / (domain.max - domain.min)) * plotHeight
  // A plot shrunk to fit the display keeps its tick labels apart with fewer gridlines.
  const ticks = $derived(domain === null ? [] : valueTicks(domain, plotHeight < 60 ? 2 : 3))
  const labels = $derived(tickLabels(ticks.map(tick => displayValue(tick, strip.unit))))

  // The value labels are read against: the latest value of the strip's first pen.
  const current = $derived(strip.pens.map(pen => shownPoints(pen).at(-1)?.v).find(value => value !== undefined))

  // Labels stack down the gutter, each line's block at its line or pushed clear
  // of its neighbour with a leader back to it; a limit off the scale is named
  // at the edge it lies beyond, ▲ or ▼. Only a strip too short for all of them
  // folds the least important lines into a neighbour's count (limit-labels.ts):
  // never one with an active limit, nor the one a value is heading for, while
  // another can give way.
  const labelRoom = $derived({ start: pad.top - LINE, end: pad.top + plotHeight + LINE / 2 })
  // The limit each pen's legend names (trend-reading.ts): what its value heads for or is past.
  const namedRuleIds = $derived(new Set(strip.pens.flatMap(pen => {
    const points = shownPoints(pen)
    const latest = points.at(-1)
    if (latest === undefined) return []
    const limit = trendReading({ value: latest.v, points, windowMs: rateWindowMs(horizonMs), unit: pen.unit, thresholds: pen.thresholds, mode, gates, activeRuleIds, resolution: pen.resolution, ...(pen.limits?.instrumentSpan === undefined ? {} : { span: pen.limits.instrumentSpan }) }).limit
    return limit?.kind === 'margin' || limit?.kind === 'past' ? [limit.margin.threshold.ruleId] : []
  })))
  const edgeOf = (value: number): 'above' | 'below' | null =>
    range === null || limitInScale(value, range) ? null : value > range.max ? 'above' : 'below'
  const severityRank = { critical: 0, warning: 1, notice: 2, info: 3 } as const
  const worst = (severities: ReadonlyArray<string | null>): string | null =>
    severities.filter((severity): severity is keyof typeof severityRank => severity !== null).sort((left, right) => severityRank[left] - severityRank[right])[0] ?? null
  const describe = (threshold: ComposedTrendThreshold): string =>
    `${thresholdFullName(threshold, strip.unit)}: ${threshold.label} (${threshold.signals.join(', ')})${threshold.modeNames === undefined ? '' : `, only in ${threshold.modeNames}`}${threshold.gatedBy === undefined ? '' : `, only while ${threshold.gatedBy.join(' and ')}`}${edgeOf(threshold.value) === null ? '' : ', off this scale'}`
  const thresholdLabels = $derived.by(() => {
    const ranks = limitLabelRanks(lines.map(line => ({
      key: line.key,
      value: line.value,
      active: worst(line.members.map(member => limitSeverity(member, activeRuleIds, mode, gates))),
      ahead: line.members.some(member => member.ruleIds.some(ruleId => namedRuleIds.has(ruleId))),
      inForce: line.look !== 'idle',
    })), current)
    const rowCount = (line: (typeof lines)[number]): number => labelRows(headOf(line, edgeOf(line.value)), labelParts(line)).length
    const slots = lines.map((line): LabelSlot => {
      const edge = edgeOf(line.value)
      const size = rowCount(line) * LINE
      return {
        key: line.key,
        want: edge === 'above' ? labelRoom.start : edge === 'below' ? labelRoom.end - size : y(line.value) - LINE / 2,
        size,
        group: line.members[0]!.direction,
        rank: ranks.get(line.key)!,
      }
    })
    const byKey = new Map(lines.map(line => [line.key, line]))
    return stackLabels(slots, labelRoom).map(label => {
      const line = byKey.get(label.key)!
      const folded = label.folded.map(key => byKey.get(key)!)
      const edge = edgeOf(line.value)
      const foldedSeverity = worst(folded.flatMap(other => other.members.map(member => limitSeverity(member, activeRuleIds, mode, gates))))
      const head = headOf(line, edge)
      const count = folded.length > 0 ? ` (+${folded.reduce((sum, other) => sum + other.members.length, 0)})` : ''
      const worstActive = worst(line.members.map(member => limitSeverity(member, activeRuleIds, mode, gates)))
      const rows = labelRows(head, labelParts(line)).map((parts, index) => ({
        key: `${index}:${parts.map(part => part.text).join(' ')}`,
        y: label.start + index * LINE + LINE / 2,
        continued: index > 0,
        // The head takes the colour of the most severe active limit at the line, or of one folded into it.
        head: index === 0 ? { text: head, severity: worstActive ?? foldedSeverity, idle: line.look === 'idle' } : null,
        parts: parts.map(part => ({ text: part.text, idle: part.idle, severity: part.idle ? null : limitSeverity(part.member, activeRuleIds, mode, gates) })),
        count: index === 0 ? count : '',
      }))
      return {
        key: label.key,
        edge,
        lineY: y(line.value),
        y: label.start + LINE / 2,
        rows,
        title: [...line.members, ...folded.flatMap(other => other.members)].map(describe).join('\n'),
      }
    })
  })

  // Where a reading sits at an end of its instrument's span, the trace says
  // only that the quantity is there or beyond: that stretch is hatched on the
  // span's end, below it or above it.
  const OFF_SCALE_BAND = 8
  const offScaleBands = $derived(strip.pens.flatMap(pen => {
    const span = pen.limits?.instrumentSpan
    if (span === undefined) return []
    const points = shownPoints(pen)
    return points.flatMap((point, index) => {
      const end = offScale(point.v, span)
      const until = Math.min(points[index + 1]?.t ?? now, point.t + HOLD_GAP_MS, now)
      if (end === null || until < windowStart) return []
      return [{ key: `${pen.path}:${point.t}`, end, from: Math.max(point.t, windowStart), until, at: end === 'below' ? span.min : span.max }]
    })
  }))

  // Where the window starts before any recorded value, say why instead of
  // leaving an unexplained blank; a sliver too narrow for words stays unlabelled.
  const firstSampleAt = $derived(Math.min(...strip.pens.map(pen => series.get(String(pen.path))?.[0]?.t ?? Number.POSITIVE_INFINITY)))
  const gapEnd = $derived(Number.isFinite(firstSampleAt) ? Math.min(firstSampleAt, now) : now)
  const showGap = $derived(gapEnd - windowStart > windowMs * 0.05)
  const gapWide = $derived(x(gapEnd) - pad.left > 150)
  const RUN_START_TOLERANCE_MS = 5_000
  const gapText = $derived(runStartedAt !== null && runStartedAt > windowStart && Math.abs(gapEnd - runStartedAt) <= RUN_START_TOLERANCE_MS
    ? `before the Run started (sim ${simulationClock(runStartedAt)})`
    : 'no recorded data')

  // The advice marker's label is hidden when the advice was given just now:
  // the notice line already says so, and the label would sit on the data.
  const adviceVisible = $derived(issuedAt !== null && issuedAt >= windowStart)
  const adviceRecent = $derived(issuedAt !== null && now - issuedAt < windowMs * 0.04)
  const adviceNearLeft = $derived(issuedAt !== null && x(issuedAt) - pad.left < 56)

  const summary = $derived(strip.pens.map(pen => {
    const latest = shownPoints(pen).at(-1)
    return `${pen.name}: ${latest === undefined ? 'no value' : readingText(latest.v, pen.unit, pen.resolution, pen.limits?.instrumentSpan)}`
  }).join('; '))
</script>

<div class="trend" bind:clientWidth={width}>
  {#if domain === null}
    <p class="trend-empty" style={`height:${height}px`}>No values yet for {strip.pens.map(pen => pen.name).join(', ')}.</p>
  {:else}
    <svg {width} {height} role="img" aria-label={`Trend of the last ${horizon}. ${summary}`}>
      <defs>
        <pattern id={patternId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" class="hatch" />
        </pattern>
      </defs>
      {#if showGap}
        <rect x={pad.left} y={pad.top} width={Math.max(0, x(gapEnd) - pad.left)} height={plotHeight} fill={`url(#${patternId})`} />
        {#if gapWide}
          <text class="gap-label" x={pad.left + (x(gapEnd) - pad.left) / 2} y={pad.top + plotHeight / 2} text-anchor="middle" dominant-baseline="middle">{gapText}</text>
        {/if}
      {/if}
      {#each ticks as tick, index (tick)}
        <line class="grid" x1={pad.left} x2={pad.left + plotWidth} y1={y(tick)} y2={y(tick)} />
        <text class="axis" x={pad.left - 6} y={y(tick)} text-anchor="end" dominant-baseline="middle">{labels[index]}</text>
      {/each}
      <text class="axis unit" x={pad.left - 6} y={pad.top - 7} text-anchor="end">{unitLabel(strip.unit)}</text>
      {#if timeAxis}
        {#each timeTicks(now, windowMs) as tick (tick.t)}
          <text class="axis" x={x(tick.t)} y={height - 6} text-anchor="middle">{tick.label}</text>
        {/each}
      {/if}

      {#each drawnLines as line (line.key)}
        <line
          class={`threshold ${line.kind} ${line.look}`}
          x1={pad.left}
          x2={pad.left + plotWidth}
          y1={y(line.value)}
          y2={y(line.value)}
        ><title>{line.members.map(member => member.label).join('\n')}</title></line>
      {/each}
      {#each offScaleBands as band (band.key)}
        <rect class="offscale" x={x(band.from)} width={Math.max(1, x(band.until) - x(band.from))} y={band.end === 'below' ? y(band.at) : y(band.at) - OFF_SCALE_BAND} height={OFF_SCALE_BAND} fill={`url(#${patternId})`}><title>{band.end} range: the instrument's indication is saturated, the quantity is there or beyond</title></rect>
      {/each}
      {#each thresholdLabels as label (label.key)}
        {#if label.edge === null && Math.abs(label.y - label.lineY) > 2}
          <polyline class="leader" points={`${pad.left + plotWidth},${label.lineY} ${pad.left + plotWidth + 4},${label.lineY} ${pad.left + plotWidth + 8},${label.y}`} />
        {/if}
        {#each label.rows as row (row.key)}
          <text class="threshold-label" x={pad.left + plotWidth + 10 + (row.continued ? CONTINUED : 0)} y={row.y} dominant-baseline="middle"><title>{label.title}</title>{#if row.head !== null}<tspan class={row.head.severity === null ? '' : `active-${row.head.severity}`} class:idle={row.head.idle}>{row.head.text}</tspan>{/if}{#each row.parts as part, index (index)}<tspan class={part.severity === null ? '' : `active-${part.severity}`} class:idle={part.idle}>{index === 0 ? '' : ' '}{part.text}</tspan>{/each}{#if row.count !== ''}<tspan>{row.count}</tspan>{/if}</text>
        {/each}
      {/each}
      {#each controlThresholds.filter(threshold => threshold.value >= domain!.min && threshold.value <= domain!.max) as threshold (threshold.ruleId)}
        <line class="control-mark" x1={pad.left + plotWidth} x2={pad.left + plotWidth + 3} y1={y(threshold.value)} y2={y(threshold.value)}><title>{threshold.label} at {formatQuantity(threshold.value, strip.unit, resolution)} (control set point)</title></line>
      {/each}

      {#if adviceVisible && issuedAt !== null}
        <line class="advice" x1={x(issuedAt)} x2={x(issuedAt)} y1={pad.top} y2={pad.top + plotHeight} />
        {#if adviceLabel && !adviceRecent}
          <text class="advice-label" x={adviceNearLeft ? x(issuedAt) + 3 : x(issuedAt) - 3} y={pad.top - 7} text-anchor={adviceNearLeft ? 'start' : 'end'}>{adviceNearLeft ? '◂ advice' : 'advice ▸'}</text>
        {/if}
      {:else if adviceLabel && issuedAt !== null}
        <text class="advice-label" x={pad.left + 3} y={pad.top - 7}>◂ advice given before this window</text>
      {/if}
      <line class="now" x1={pad.left + plotWidth} x2={pad.left + plotWidth} y1={pad.top} y2={pad.top + plotHeight} />

      {#each strip.pens as pen, index (pen.path)}
        <path
          class="pen"
          d={stepPath(shownPoints(pen), x, y, { start: windowStart, end: now })}
          style={penStroke(pen.role, index)}
        />
      {/each}
    </svg>
  {/if}
</div>

<style>
  .trend { width: 100%; }
  svg { display: block; overflow: visible; }
  .trend-empty { margin: 0; display: flex; align-items: center; color: var(--element-neutral-color); font-size: 13px; }
  .grid { stroke: var(--border-divider-color); stroke-width: 1; }
  .axis { fill: var(--element-neutral-color); font-size: 11px; font-variant-numeric: tabular-nums; }
  .unit { font-weight: 600; }
  .threshold { stroke-width: 1; }
  .threshold.trip { stroke: var(--element-neutral-color); stroke-width: 1.5; }
  .threshold.alarm { stroke: var(--element-neutral-color); stroke-opacity: 0.7; }
  .threshold.qualified { stroke-dasharray: 5 3; }
  /* A limit that does not act in the current mode: present, but plainly not in force. */
  .threshold.idle { stroke-dasharray: 3 4; stroke-opacity: 0.35; }
  .leader { fill: none; stroke: var(--element-neutral-color); stroke-width: 1; stroke-opacity: 0.7; }
  .threshold-label { fill: var(--element-neutral-color); font-size: 10px; font-variant-numeric: tabular-nums; white-space: pre; }
  .threshold-label .idle { fill-opacity: 0.6; }
  /* Colour appears only while the rule behind the line is active, keyed by its severity. */
  .threshold-label .active-critical { fill: var(--alert-alarm-color); font-weight: 700; }
  .threshold-label .active-warning { fill: var(--alert-warning-color); font-weight: 700; }
  .threshold-label .active-notice, .threshold-label .active-info { fill: var(--alert-caution-color); font-weight: 700; }
  .hatch { stroke: var(--border-divider-color); stroke-width: 1; }
  .offscale { stroke: var(--element-neutral-color); stroke-width: 0.5; stroke-opacity: 0.6; }
  .gap-label { fill: var(--element-neutral-color); font-size: 11px; }
  .control-mark { stroke: var(--element-neutral-color); stroke-width: 2; }
  .advice { stroke: var(--element-neutral-color); stroke-dasharray: 2 3; }
  .advice-label { fill: var(--element-neutral-color); font-size: 10.5px; }
  .now { stroke: var(--border-outline-color); }
  .pen { fill: none; stroke-linejoin: round; }
</style>
