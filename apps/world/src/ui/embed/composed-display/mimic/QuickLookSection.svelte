<script lang="ts">
  import type { ComposedDisplayPen } from '../../../../packs/process-plant/displays/compose.ts'
  import { displayValue, formatValue, logarithmicSpan, offScale, positionWord, readingValueText, shownReading, unitLabel } from '../../../../packs/process-plant/displays/display-text.ts'
  import { rateWindowMs, trendReading, type TrendReading } from '../../../../packs/process-plant/displays/trend-reading.ts'
  import AlarmChip from '../AlarmChip.svelte'
  import Sparkline from '../Sparkline.svelte'
  import { sampledGates } from '../panel-presenters.ts'
  import { displayName, fitName } from '../pen-style.ts'
  import { sparklineWindowText } from '../sparkline.ts'
  import { panelFont, textMeasure } from '../text-measure.ts'
  import { QUICK_LOOK_ROW } from './popover.ts'
  import { quickLookValue, type MimicQuickLookSource, type QuickLookState } from './quick-look-source.ts'

  // An item's quick look (vessel-design §C): the lead values World chose for
  // it with the drawing, one 28 px row each: tag · value (bold, its unit, the
  // chip of the limit it is in alarm at) · its trend, every trend on one
  // shared time axis whose window one line under them names. Read while the
  // popover is open (quick-look-source.ts); a sample updates values and lines
  // in place. A valve shows its position only, no trend. In a pinned overlay
  // its trends take the width it is given, text never shrinks, and the rows
  // it has no room for drop from the bottom behind a "+n" line.
  let { source, pens, sparklineMs, activeRuleIds, width, rows = null, trends = true, stale = false }: {
    source: MimicQuickLookSource
    pens: ReadonlyArray<ComposedDisplayPen>
    sparklineMs: number
    activeRuleIds: ReadonlySet<string>
    /** The room it has, in its popover's own px. */
    width: number
    /** How many rows it shows; null for all. */
    rows?: number | null
    /** Whether its rows draw trends: a valve's position needs none. */
    trends?: boolean
    /** The page's samples are stale: its values read as old, as the drawing's do. */
    stale?: boolean
  } = $props()

  let shown = $state.raw<QuickLookState>({ kind: 'loading' })

  // Reading the values is a subscription to the Run, held while the section is drawn and its pens are the same.
  $effect(() => source.open({ pens, sparklineMs }, next => { shown = next }))

  /** The tag and value columns' room: text never shrinks; a label drops whole words to fit its column. */
  const TAG_ROOM = 92
  const VALUE_ROOM = 104
  const GAP = 6
  const TREND_MIN = 64
  const measureName = textMeasure(panelFont(11.5))
  const nameOf = (pen: ComposedDisplayPen): string => pen.tagId !== undefined ? pen.tagId : fitName(displayName(pen), text => measureName(text) <= TAG_ROOM, pen.shorterNames)
  const trendWidth = $derived(Math.max(TREND_MIN, Math.floor(width - TAG_ROOM - VALUE_ROOM - 2 * GAP)))
  const trendSize = $derived({ width: trendWidth, height: QUICK_LOOK_ROW - 4 })
  const visible = $derived(rows === null ? pens : pens.slice(0, Math.max(1, rows)))
  const hidden = $derived(pens.length - visible.length)
  const latest = $derived(shown.kind === 'shown' ? shown.latest : undefined)
  const now = $derived(latest === undefined ? Number.NaN : Date.parse(latest.simulationTime))
  // Outside the validity its equipment declares a reading has no value to show: "—" (quickLookValue).
  const valueOf = (pen: ComposedDisplayPen) => quickLookValue(pen, latest)
  const pointsOf = (pen: ComposedDisplayPen) => (shown.kind === 'shown' ? shown.history.series.get(String(pen.path)) ?? [] : []).map(point => ({ t: point.t, v: shownReading(point.v, pen.resolution) }))
  const readingOf = (pen: ComposedDisplayPen, value: number): TrendReading => trendReading({
    value,
    points: pen.recorded ? pointsOf(pen) : null,
    windowMs: rateWindowMs(sparklineMs),
    unit: pen.unit,
    thresholds: pen.thresholds,
    mode: latest?.mode,
    gates: sampledGates(latest),
    activeRuleIds,
    resolution: pen.resolution,
    ...(pen.limits?.instrumentSpan === undefined ? {} : { span: pen.limits.instrumentSpan }),
  })
  // A value as the detail writes it: at an end of its span only that end, over decades in powers of ten, else to its resolution.
  const valueText = (pen: ComposedDisplayPen, value: number): string => {
    const span = pen.limits?.instrumentSpan
    // A valve's position SHUT or OPEN at the ends of its travel, as its drawing words it.
    const word = pen.position === true ? positionWord(value) : null
    if (word !== null) return word
    const number = offScale(value, span) !== null || logarithmicSpan(span)
      ? readingValueText(value, pen.unit, pen.resolution, span)
      : formatValue(displayValue(value, pen.unit), pen.resolution === null ? null : displayValue(pen.resolution, pen.unit))
    const unit = unitLabel(pen.unit)
    return unit === '' ? number : `${number} ${unit}`
  }
  const limitDrawn = (reading: TrendReading) => reading.limit?.kind === 'margin' || reading.limit?.kind === 'past' ? reading.limit.margin.threshold : null
  const anyTrend = $derived(trends && visible.some(pen => pen.valueKind === 'number'))
  const columns = $derived(`${TAG_ROOM}px ${trends ? `${VALUE_ROOM}px ${trendWidth}px` : 'minmax(0, 1fr)'}`)
  // Old values, the page's or its own last read, are greyed and say so; never shown as current (HMI review of run 26c).
  const old = $derived(stale || (shown.kind === 'shown' && shown.sampleError !== null))
</script>

<ul class="rows" class:old style={`grid-template-columns:${columns};column-gap:${GAP}px;grid-auto-rows:${QUICK_LOOK_ROW}px`}>
  {#each visible as pen (pen.path)}
    {@const entry = valueOf(pen)}
    {@const value = typeof entry?.value === 'number' ? shownReading(entry.value, pen.resolution) : entry?.value}
    {@const reading = typeof value === 'number' ? readingOf(pen, value) : null}
    <li>
      <span class="name" class:tag={pen.tagId !== undefined} title={`${displayName(pen)} · ${pen.label}`}>{nameOf(pen)}</span>
      <span class="value-cell">
        {#if typeof value === 'boolean'}
          <!-- A state in the words the model gives its two states, as the detail writes it. -->
          <!-- A state's words wrap to a second line rather than break mid-word; the title holds them whole. -->
          <span class="value state" title={value ? pen.states?.on : pen.states?.off}>{value ? pen.states?.on : pen.states?.off}</span>
        {:else if typeof value === 'number'}
          <span class="value" class:low={reading?.offScale !== null}>{valueText(pen, value)}</span>
        {:else}
          <span class="value none" title={entry?.quality === 'outside-hard-range' ? 'outside range' : 'not read yet'}>{entry?.quality === 'outside-hard-range' ? 'outside range' : '—'}</span>
        {/if}
        {#if reading?.inAlarm}<AlarmChip threshold={reading.inAlarm} compact />{/if}
      </span>
      {#if trends}
        {#if pen.valueKind === 'number' && shown.kind === 'shown'}
          <Sparkline
            {pen}
            windowMs={sparklineMs}
            points={pointsOf(pen)}
            {now}
            limit={reading === null ? null : limitDrawn(reading)}
            inAlarm={reading?.inAlarm ?? null}
            historyMissing={shown.history.historyMissing.has(String(pen.path))}
            historyError={shown.history.historyErrors.get(String(pen.path))}
            size={trendSize}
            hatched
          />
        {:else}
          <span class="no-line"></span>
        {/if}
      {/if}
    </li>
  {/each}
</ul>
{#if anyTrend}
  <!-- One time axis for every trend above it: their onsets line up. -->
  <p class="axis" aria-hidden="true" style={`margin-left:${TAG_ROOM + VALUE_ROOM + 2 * GAP}px;width:${trendWidth}px`}><span>−{sparklineWindowText(sparklineMs)}</span><span>now</span></p>
{/if}
{#if hidden > 0}<p class="more">+{hidden} more: resize to show</p>{/if}
{#if old}<p class="note stale">STALE: the last received values, not current.{#if shown.kind === 'shown' && shown.sampleError !== null}{' '}{shown.sampleError}{/if}</p>{/if}

<style>
  .note, .more { margin: 0; font-size: 10.5px; line-height: 14px; color: var(--element-neutral-color); }
  .rows { list-style: none; margin: 0; padding: 0; display: grid; align-items: center; }
  li { display: contents; }
  .name { font-size: 11.5px; color: var(--element-neutral-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* A tag is whole or not shown at all: never an ellipsis through it. */
  .name.tag { text-overflow: clip; }
  .value-cell { display: flex; align-items: center; gap: 4px; min-width: 0; max-height: 28px; white-space: nowrap; overflow: hidden; }
  /* The current value carries the row: bold, as the trend's end dot marks it on the line. */
  .value { font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; color: var(--element-active-color); }
  .value.state { font-size: 11px; line-height: 12px; white-space: normal; overflow-wrap: normal; word-break: normal; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; }
  .value.none { font-weight: 400; color: var(--element-neutral-color); }
  /* At an end of its span a reading says only where the quantity is, in low-integrity style. */
  .value.low { color: var(--element-neutral-color); font-style: italic; font-weight: 400; }
  .no-line { width: 0; }
  /* Stale: every value and trace greyed at normal weight, as the drawing draws its states unknown. */
  .rows.old .value { color: var(--element-neutral-color); font-weight: 400; }
  .rows.old :global(.sparkline) { opacity: 0.4; }
  .note.stale { font-weight: 600; color: var(--element-active-color); }
  .axis { display: flex; justify-content: space-between; height: 18px; margin-top: 0; margin-bottom: 0; font-size: 10px; line-height: 14px; color: var(--element-neutral-color); }
</style>
