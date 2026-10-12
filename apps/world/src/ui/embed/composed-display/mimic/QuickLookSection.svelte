<script lang="ts">
  import type { ComposedDisplayPen } from '../../../../packs/process-plant/displays/compose.ts'
  import { displayValue, formatValue, logarithmicSpan, offScale, readingValueText, shownReading, unitLabel } from '../../../../packs/process-plant/displays/display-text.ts'
  import { rateWindowMs, trendReading, type TrendReading } from '../../../../packs/process-plant/displays/trend-reading.ts'
  import AlarmChip from '../AlarmChip.svelte'
  import Sparkline from '../Sparkline.svelte'
  import { sampledGates } from '../panel-presenters.ts'
  import { displayName, fitName } from '../pen-style.ts'
  import { SPARKLINE_SIZE } from '../sparkline.ts'
  import { panelFont, textMeasure } from '../text-measure.ts'
  import { quickLookValue, type MimicQuickLookSource, type QuickLookState } from './quick-look-source.ts'

  // An item's quick look: the lead values World chose for it with the
  // drawing, one line each (name · value in its unit or state words ·
  // sparkline · the limit it is in alarm at), read while the popover is open
  // (quick-look-source.ts). The words, resolution and limit names are the
  // detail's; the detail has the rest.
  let { source, pens, sparklineMs, activeRuleIds }: {
    source: MimicQuickLookSource
    pens: ReadonlyArray<ComposedDisplayPen>
    sparklineMs: number
    activeRuleIds: ReadonlySet<string>
  } = $props()

  let shown = $state.raw<QuickLookState>({ kind: 'loading' })

  // Reading the values is a subscription to the Run, held while the section is drawn.
  $effect(() => source.open({ pens, sparklineMs }, next => { shown = next }))

  /** The name column's room: a tag is never shortened; a label drops whole words to fit. */
  const NAME_ROOM = 104
  const measureName = textMeasure(panelFont(11.5))
  const nameOf = (pen: ComposedDisplayPen): string => pen.tagId !== undefined ? pen.tagId : fitName(displayName(pen), text => measureName(text) <= NAME_ROOM, pen.shorterNames)
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
    const number = offScale(value, span) !== null || logarithmicSpan(span)
      ? readingValueText(value, pen.unit, pen.resolution, span)
      : formatValue(displayValue(value, pen.unit), pen.resolution === null ? null : displayValue(pen.resolution, pen.unit))
    const unit = unitLabel(pen.unit)
    return unit === '' ? number : `${number} ${unit}`
  }
  const limitDrawn = (reading: TrendReading) => reading.limit?.kind === 'margin' || reading.limit?.kind === 'past' ? reading.limit.margin.threshold : null
</script>

<ul class="rows" style={`grid-template-columns:${NAME_ROOM}px minmax(0, 1fr) ${SPARKLINE_SIZE.width}px max-content`}>
  {#each pens as pen (pen.path)}
    {@const entry = valueOf(pen)}
    {@const value = typeof entry?.value === 'number' ? shownReading(entry.value, pen.resolution) : entry?.value}
    {@const reading = typeof value === 'number' ? readingOf(pen, value) : null}
    <li>
      <span class="name" class:tag={pen.tagId !== undefined} title={`${displayName(pen)} · ${pen.label}`}>{nameOf(pen)}</span>
      {#if typeof value === 'boolean'}
        <!-- A state in the words the model gives its two states, as the detail writes it. -->
        <span class="value state">{value ? pen.states?.on : pen.states?.off}</span>
      {:else if typeof value === 'number'}
        <span class="value" class:low={reading?.offScale !== null}>{valueText(pen, value)}</span>
      {:else}
        <span class="value" title={entry?.quality === 'outside-hard-range' ? 'outside range' : 'not read yet'}>{entry?.quality === 'outside-hard-range' ? 'outside range' : '—'}</span>
      {/if}
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
        />
      {:else}
        <span class="no-line"></span>
      {/if}
      <span class="margin">{#if reading?.inAlarm}<AlarmChip threshold={reading.inAlarm} compact />{/if}</span>
    </li>
  {/each}
</ul>
{#if shown.kind === 'shown' && shown.sampleError !== null}<p class="note">Showing the last received values. {shown.sampleError}</p>{/if}

<style>
  .note { margin: 2px 0 0; font-size: 10.5px; line-height: 14px; color: var(--element-neutral-color); }
  .rows { list-style: none; margin: 0; padding: 0; display: grid; column-gap: 6px; row-gap: 2px; align-items: center; }
  li { display: contents; }
  .name { font-size: 11.5px; color: var(--element-neutral-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* A tag is whole or not shown at all: never an ellipsis through it. */
  .name.tag { text-overflow: clip; }
  .value { justify-self: end; font-size: 13px; font-variant-numeric: tabular-nums; white-space: nowrap; color: var(--element-active-color); }
  .value.state { font-size: 12px; }
  /* At an end of its span a reading says only where the quantity is, in low-integrity style. */
  .value.low { color: var(--element-neutral-color); font-style: italic; }
  .no-line { width: 0; }
  .margin { min-width: 0; }
</style>
