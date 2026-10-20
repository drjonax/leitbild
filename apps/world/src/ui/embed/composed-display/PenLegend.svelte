<script lang="ts">
  import { untrack } from 'svelte'
  import type { ComposedDisplayPen } from '../../../packs/process-plant/displays/compose.ts'
  import { composedTrendLegendHeight } from '../../../packs/process-plant/displays/composition.ts'
  import { readingText, shownReading, valueText } from '../../../packs/process-plant/quantity-text.ts'
  import { WIDER_RANGE } from '../../../packs/process-plant/displays/mimic/rows.ts'
  import type { ComposedDisplaySample } from './composed-display-client.ts'
  import { expectedOfRule, sampledGates } from './panel-presenters.ts'
  import type { DisplayAnnunciation } from '../../../packs/process-plant/displays/annunciators.ts'
  import { displayName, fitName, penStroke, roleLabel } from './pen-style.ts'
  import { panelFont, textMeasure } from './text-measure.ts'
  import { changeBesideState, rateText, rateWindowMs, readingStateText, trendReading, turnText, type TrendPoint } from '../../../packs/process-plant/displays/trend-reading.ts'
  import AlarmChip from './AlarmChip.svelte'

  // One row per pen, columns aligned: what it is, its value, how close it is
  // to acting I&C (or the active alarm), and where it is heading. Live rows are
  // signals the Run does not record: current value only, no swatch.
  let { pens, horizonMs, live = false, latest, series, historyMissing, activeRuleIds, annunciation }: {
    pens: ReadonlyArray<ComposedDisplayPen>
    horizonMs: number
    live?: boolean
    latest: ComposedDisplaySample | undefined
    series: ReadonlyMap<string, ReadonlyArray<TrendPoint>>
    historyMissing: ReadonlySet<string>
    activeRuleIds: ReadonlySet<string>
    /** What the I&C declares of its alarms: a chip whose alarms are all expected after a first-out is faded. */
    annunciation: DisplayAnnunciation
  } = $props()

  const sampled = (path: string) => latest?.values.find(entry => entry.path === path)
  // Off its span a reading has no rate; the instrument that reads it over a wider span says where it is.
  const widerText = (pen: ComposedDisplayPen): string | null => {
    const value = pen.wider === undefined ? undefined : sampled(String(pen.wider.path))?.value
    return typeof value === 'number' ? `${WIDER_RANGE} ${readingText(shownReading(value, pen.resolution), pen.unit, pen.resolution, pen.wider!.span)}` : null
  }
  const windowMs = $derived(rateWindowMs(horizonMs))

  // A name takes what the swatch, the column gaps, the value and limit-state
  // columns and a readable rate leave of the legend's width, less its badges,
  // dropping whole words to fit. Value, state and badges are measured as
  // drawn; the columns only ever widen, so names do not reflow with each
  // sample. The swatch, gap and rate minimum are the CSS below.
  const SWATCH = 22
  const COLUMN_GAP = 10
  const RATE_MIN = 90
  const measureName = textMeasure(panelFont(12))
  let legend: HTMLUListElement | undefined = $state()
  let width = $state(0)
  let drawn = $state({ value: 0, state: 0, badge: 0 })
  $effect(() => {
    void latest
    if (legend === undefined) return
    const widest = (selector: string, margin = 0) => Math.max(0, ...[...legend!.querySelectorAll<HTMLElement>(selector)].map(cell => cell.offsetWidth + margin))
    const before = untrack(() => drawn)
    // A badge's margin (the CSS below) is part of what it takes from the name.
    const next = { value: Math.max(before.value, widest('.value')), state: Math.max(before.state, widest('.state')), badge: Math.max(before.badge, widest('.badge', 10)) }
    if (next.value !== before.value || next.state !== before.state || next.badge !== before.badge) drawn = next
  })
  const named = (pen: ComposedDisplayPen, badges: number): string => {
    const room = width - SWATCH - 4 * COLUMN_GAP - drawn.value - drawn.state - RATE_MIN - badges * drawn.badge
    return width === 0 ? displayName(pen) : fitName(displayName(pen), text => measureName(text) <= room, pen.shorterNames)
  }
</script>

<ul class="legend" style={`height:${composedTrendLegendHeight(pens.length)}px`} bind:clientWidth={width} bind:this={legend}>
  {#each pens as pen, index (pen.path)}
    {@const entry = sampled(String(pen.path))}
    {@const value = typeof entry?.value === 'number' ? shownReading(entry.value, pen.resolution) : entry?.value}
    {@const points = (series.get(String(pen.path)) ?? []).map(point => ({ t: point.t, v: shownReading(point.v, pen.resolution) }))}
    {@const liveOnly = live || historyMissing.has(String(pen.path))}
    {@const reading = typeof value === 'number' ? trendReading({ value, points: live ? null : points, windowMs, unit: pen.unit, thresholds: pen.thresholds, mode: latest?.mode, gates: sampledGates(latest), activeRuleIds, resolution: pen.resolution, ...(pen.limits?.instrumentSpan === undefined ? {} : { span: pen.limits.instrumentSpan }) }) : null}
    {@const inAlarm = reading?.inAlarm ?? null}
    {@const state = reading === null ? '' : readingStateText(reading, pen.unit, pen.resolution)}
    {@const wider = reading?.offScale != null ? widerText(pen) : null}
    <li>
      {#if live}<span class="swatch live" aria-hidden="true"></span>{:else}<svg class="swatch" width="22" height="8" aria-hidden="true"><line x1="0" x2="22" y1="4" y2="4" style={penStroke(pen.role, index)} /></svg>{/if}
      <span class="name" title={`${displayName(pen)} · ${pen.label} · ${roleLabel[pen.role]}${pen.command ? ' · operator or automation demand, not a measured state' : ''}${live ? ' · not recorded by this Run: current value only' : liveOnly ? ' · no recorded history in this window' : ''}`}>{#if live}<span class="badge">not recorded</span>{/if}{named(pen, (live ? 1 : 0) + (pen.command ? 1 : 0) + (pen.simulatorOnly ? 1 : 0))}{#if pen.command}<span class="badge">demand</span>{/if}{#if pen.simulatorOnly}<span class="badge" title="Computed by the simulator only: no instrument of a real plant reads it">sim</span>{/if}</span>
      <span class="value" class:offscale={reading?.offScale != null}>{typeof value === 'number' ? valueText(value, pen.unit, pen.resolution, pen.limits?.instrumentSpan, pen.position === true) : typeof value === 'boolean' ? (value ? 'ON' : 'OFF') : '—'}</span>
      <span class="state">
        {#if inAlarm !== null}<AlarmChip threshold={inAlarm} expected={expectedOfRule(inAlarm.ruleId, latest?.alarms ?? [], annunciation)} />{/if}
        {#if reading?.offScale != null}<svg class="comb-key" width="13" height="8" role="img" aria-label="drawn on the trend as an upright comb"><title>Off its span: drawn on the trend as this upright comb; no recorded data is hatched diagonally</title>{#each [0.5, 3.5, 6.5, 9.5, 12.5] as at (at)}<line x1={at} x2={at} y1="0" y2="8" />{/each}</svg>{/if}
        {#if state !== ''}<span class:beyond={reading?.offScale != null || reading?.limit?.kind === 'past'}>{state}</span>{/if}
        {#if entry?.quality === 'outside-hard-range'}<span class="beyond">outside range</span>{/if}
      </span>
      <span class="rate" class:wider={wider !== null} title={wider === null ? undefined : `${pen.wider!.tagId ?? pen.wider!.path}: the same quantity on the instrument with the wider span`}>{typeof value === 'number' && reading !== null && !live ? (reading.offScale === null ? (reading.turn !== null ? turnText(reading.turn, pen.unit, pen.resolution, points.at(-1)?.t ?? reading.turn.at.t, pen.limits?.instrumentSpan) : rateText(reading.rate, value, pen.unit, { windowMs, change: changeBesideState(reading), resolution: pen.resolution })) : wider ?? 'off scale: no rate') : ''}{liveOnly && !live ? ' · live only' : ''}</span>
    </li>
  {/each}
</ul>

<style>
  .legend {
    list-style: none; margin: 0; padding: 4px 0 0; overflow: hidden;
    display: grid; grid-template-columns: 22px max-content max-content max-content minmax(90px, 1fr);
    grid-auto-rows: 16px; column-gap: 10px; align-items: center;
  }
  li { display: contents; }
  .badge { margin: 0 5px; padding: 0 4px; border: 1px solid var(--border-outline-color); border-radius: 3px; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.04em; white-space: nowrap; }
  .demand { margin-left: 5px; padding: 0 4px; border: 1px solid var(--border-outline-color); border-radius: 3px; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.04em; }
  .state { display: flex; align-items: center; gap: 6px; }
  .swatch.live { font-size: 9.5px; color: var(--element-neutral-color); text-transform: uppercase; letter-spacing: 0.04em; }
  .name { font-size: 12px; color: var(--element-neutral-color); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .value { font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; text-align: right; }
  .state, .rate { font-size: 11px; color: var(--element-neutral-color); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .rate { overflow: hidden; text-overflow: ellipsis; }
  /* The wider instrument's reading in the rate's place is a value: read as one. */
  .rate.wider { font-size: 12px; font-weight: 600; color: var(--element-active-color); }
  /* Past a limit: bold, readable text marked in caution's colour (embed.css), never written in it. */
  .beyond { color: var(--display-alert-text); font-weight: 600; text-decoration: underline 2px var(--display-caution-mark); text-underline-offset: 2px; }
  /* The trend's off-span comb (TrendPanel), beside the words that say so. */
  .comb-key { flex: none; }
  .comb-key line { stroke: var(--element-neutral-color); stroke-width: 1; stroke-opacity: 0.8; }
  /* A reading at an end of its instrument's span is no value: drawn as low integrity. */
  .value.offscale { font-weight: 400; font-style: italic; }
</style>
