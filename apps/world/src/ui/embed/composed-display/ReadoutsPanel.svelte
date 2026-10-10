<script lang="ts">
  import type { ComposedReadoutsPanel } from '../../../packs/process-plant/displays/compose.ts'
  import { composedDisplayLayout } from '../../../packs/process-plant/displays/composition.ts'
  import type { ComposedDisplaySample } from './composed-display-client.ts'
  import type { ComposedDisplaySnapshot } from './composed-display-session.ts'
  import { displayValue, marginText, nearestThresholdMargin, unitLabel, valueDigits, type ThresholdMargin } from '../../../packs/process-plant/displays/display-text.ts'
  import { activeThreshold, fitMarginText, limitsInForce } from './panel-presenters.ts'
  import { displayName, fitName } from './pen-style.ts'
  import { panelFont, textMeasure } from './text-measure.ts'
  import { SPARKLINE_SIZE, sparklineWindowText } from './sparkline.ts'
  import AlarmChip from './AlarmChip.svelte'
  import Sparkline from './Sparkline.svelte'
  import './openbridge.ts'

  // A unit overview's column lists its lead values one per row, each row as
  // tall as its three lines, with room for whole names; beside each readout,
  // a sparkline of its recorded history, its window labelled once over them.
  let { panel, latest, activeRuleIds, column = false, history }: {
    panel: ComposedReadoutsPanel
    latest: ComposedDisplaySample | undefined
    activeRuleIds: ReadonlySet<string>
    column?: boolean
    /** In the column: the history behind the sparklines, read when the display opened and extended by each sample. */
    history?: Pick<ComposedDisplaySnapshot, 'series' | 'historyMissing' | 'historyErrors'>
  } = $props()

  /** The row gap (the CSS below). */
  const ROW_GAP = 4
  // A name fills what its line leaves beside a demand badge and an alarm chip
  // (flex: 1 1 0, so its box never depends on its text); it is fitted to that
  // box as measured, dropping whole words.
  const measureName = textMeasure(panelFont(11.5))
  const rooms: Record<string, number> = $state({})
  const named = (path: string, name: string): string => {
    const room = rooms[path] ?? 0
    return room === 0 ? name : fitName(name, text => measureName(text) <= room)
  }
  // A margin takes its row's width, measured as drawn, and drops whole parts
  // to fit it, the mode qualifier first, never cutting a word; its tooltip
  // keeps the whole text.
  const measureMargin = { near: textMeasure(panelFont(11)), beyond: textMeasure(panelFont(11, 600)) }
  const marginRooms: Record<string, number> = $state({})
  const fittedMargin = (path: string, margin: ThresholdMargin, unit: string): string => {
    const room = marginRooms[path] ?? 0
    const measure = margin.margin < 0 ? measureMargin.beyond : measureMargin.near
    return room === 0 ? marginText(margin, unit) : fitMarginText(margin, unit, text => measure(text) <= room)
  }
  const sampled = (path: string) => latest?.values.find(entry => entry.path === path)
  const sparklineMs = $derived(column && history !== undefined ? panel.sparklineMs : undefined)
  const now = $derived(latest === undefined ? Number.NaN : Date.parse(latest.simulationTime))
  const rows = $derived(Math.ceil(panel.pens.length / (column ? 1 : composedDisplayLayout.readoutsPerRow)))
  const size = $derived(column
    ? `height:${rows * composedDisplayLayout.overviewReadoutRow}px;grid-template-columns:minmax(0, 1fr);grid-auto-rows:${composedDisplayLayout.overviewReadoutRow - ROW_GAP}px;`
    : `height:${rows * composedDisplayLayout.readoutsRow}px;grid-template-columns:repeat(${composedDisplayLayout.readoutsPerRow}, minmax(0, 1fr));`)
</script>

{#snippet values()}
<ul class="readouts" style={size}>
  {#each panel.pens as pen (pen.path)}
    {@const entry = sampled(String(pen.path))}
    {@const value = entry?.value}
    {@const margin = typeof value === 'number' ? nearestThresholdMargin(value, limitsInForce(pen.thresholds, latest?.mode, activeRuleIds)) : null}
    {@const inAlarm = activeThreshold(pen.thresholds, activeRuleIds)}
    <li class:primary={pen.role === 'primary'} title={`${pen.label} · ${pen.role}`}>
      <span class="head" title={`${displayName(pen)}${pen.command ? ' · operator or automation demand, not a measured state' : ` · ${pen.label}`}`}><span class="name" bind:clientWidth={rooms[String(pen.path)]}>{named(String(pen.path), displayName(pen))}</span>{#if pen.command}<span class="demand">demand</span>{/if}{#if inAlarm !== null}<AlarmChip threshold={inAlarm} />{/if}</span>
      {#if typeof value === 'boolean'}
        <!-- A state names its equipment, so a row of alike states (two buses) cannot be confused. -->
        <span class="state" title={pen.described}>{value ? pen.described : `Not ${pen.described.charAt(0).toLowerCase()}${pen.described.slice(1)}`}</span>
      {:else}
        <span class="reading">
          <obc-readout
            value={typeof value === 'number' ? displayValue(value, pen.unit) : null}
            off={typeof value !== 'number'}
            offText="—"
            unit={unitLabel(pen.unit)}
            fractionDigits={typeof value === 'number' ? valueDigits(displayValue(value, pen.unit)) : 0}
            size="small"
          ></obc-readout>
          {#if sparklineMs !== undefined && history !== undefined && pen.valueKind === 'number'}
            <Sparkline
              {pen}
              windowMs={sparklineMs}
              points={history.series.get(String(pen.path)) ?? []}
              {now}
              value={typeof value === 'number' ? value : undefined}
              {inAlarm}
              historyMissing={history.historyMissing.has(String(pen.path))}
              historyError={history.historyErrors.get(String(pen.path))}
            />
          {/if}
        </span>
      {/if}
      {#if margin !== null}
        <span class="margin" class:beyond={margin.margin < 0} title={marginText(margin, pen.unit)} bind:clientWidth={marginRooms[String(pen.path)]}>{fittedMargin(String(pen.path), margin, pen.unit)}</span>
      {:else if entry?.quality === 'outside-hard-range'}
        <span class="margin beyond">outside range</span>
      {/if}
    </li>
  {/each}
</ul>
{/snippet}

{#if column}
  <!-- The title line (composedDisplayLayout.overviewReadoutsTitle) labels the sparklines' window once, over them. -->
  <section aria-label="Lead values">
    <h2 style={`height:${composedDisplayLayout.overviewReadoutsTitle}px`}>
      <span>Lead values</span>
      {#if sparklineMs !== undefined}
        <span class="window" style={`width:${SPARKLINE_SIZE.width}px`} title={`Each sparkline: the last ${sparklineWindowText(sparklineMs)} of the value's recorded history, scaled to its own range`}><span>−{sparklineWindowText(sparklineMs)}</span><span>now</span></span>
      {/if}
    </h2>
    {@render values()}
  </section>
{:else}
  {@render values()}
{/if}

<style>
  .readouts { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px 12px; /* ROW_GAP */ overflow: hidden; }
  li { display: flex; flex-direction: column; justify-content: center; min-width: 0; padding: 2px 8px; border-left: 2px solid var(--border-divider-color); }
  li.primary { border-left-color: var(--element-active-color); }
  .name { flex: 1 1 0; min-width: 0; font-size: 11.5px; color: var(--element-neutral-color); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* Normal states read as plain text; colour and weight are kept for alarms. */
  .state { font-size: 13.5px; padding: 6px 0; }
  .head { display: flex; align-items: center; gap: 5px; min-width: 0; }
  .demand { flex: none; padding: 0 4px; border: 1px solid var(--border-outline-color); border-radius: 3px; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.04em; }
  .margin { font-size: 11px; color: var(--element-neutral-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .margin.beyond { color: var(--alert-caution-color); font-weight: 600; }
  .reading { display: flex; align-items: center; gap: 8px; min-width: 0; }
  /* Every sparkline ends at the row's right edge, so the window's label over the first lines up with all of them. */
  .reading :global(.sparkline), .reading :global(.none) { margin-left: auto; }
  h2 { margin: 0; display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; font-size: 11px; line-height: 12px; font-weight: 600; color: var(--element-neutral-color); text-transform: uppercase; letter-spacing: 0.04em; }
  /* Over the sparklines: as wide as one, inset by the rows' right padding (8 px). */
  .window { flex: none; display: flex; justify-content: space-between; margin-right: 8px; font-size: 10px; font-weight: 400; text-transform: none; letter-spacing: 0; font-variant-numeric: tabular-nums; }
</style>
