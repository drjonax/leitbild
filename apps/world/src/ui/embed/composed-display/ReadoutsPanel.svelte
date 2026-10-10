<script lang="ts">
  import type { ComposedReadoutsPanel } from '../../../packs/process-plant/displays/compose.ts'
  import { composedDisplayLayout } from '../../../packs/process-plant/displays/composition.ts'
  import type { ComposedDisplaySample } from './composed-display-client.ts'
  import { displayValue, marginText, nearestThresholdMargin, unitLabel, valueDigits } from '../../../packs/process-plant/displays/display-text.ts'
  import { activeThreshold } from './panel-presenters.ts'
  import { displayName, fitName } from './pen-style.ts'
  import { panelFont, textMeasure } from './text-measure.ts'
  import AlarmChip from './AlarmChip.svelte'
  import './openbridge.ts'

  // A unit overview's column lists its lead values one per row, each row as tall as its three lines, with room for whole names.
  let { panel, latest, activeRuleIds, column = false }: {
    panel: ComposedReadoutsPanel
    latest: ComposedDisplaySample | undefined
    activeRuleIds: ReadonlySet<string>
    column?: boolean
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
  const sampled = (path: string) => latest?.values.find(entry => entry.path === path)
  const rows = $derived(Math.ceil(panel.pens.length / (column ? 1 : composedDisplayLayout.readoutsPerRow)))
  const size = $derived(column
    ? `height:${rows * composedDisplayLayout.overviewReadoutRow}px;grid-template-columns:minmax(0, 1fr);grid-auto-rows:${composedDisplayLayout.overviewReadoutRow - ROW_GAP}px;`
    : `height:${rows * composedDisplayLayout.readoutsRow}px;grid-template-columns:repeat(${composedDisplayLayout.readoutsPerRow}, minmax(0, 1fr));`)
</script>

<ul class="readouts" style={size}>
  {#each panel.pens as pen (pen.path)}
    {@const entry = sampled(String(pen.path))}
    {@const value = entry?.value}
    {@const margin = typeof value === 'number' ? nearestThresholdMargin(value, pen.thresholds) : null}
    {@const inAlarm = activeThreshold(pen.thresholds, activeRuleIds)}
    <li class:primary={pen.role === 'primary'} title={`${pen.label} · ${pen.role}`}>
      <span class="head" title={`${displayName(pen)}${pen.command ? ' · operator or automation demand, not a measured state' : ` · ${pen.label}`}`}><span class="name" bind:clientWidth={rooms[String(pen.path)]}>{named(String(pen.path), displayName(pen))}</span>{#if pen.command}<span class="demand">demand</span>{/if}{#if inAlarm !== null}<AlarmChip threshold={inAlarm} />{/if}</span>
      {#if typeof value === 'boolean'}
        <!-- A state names its equipment, so a row of alike states (two buses) cannot be confused. -->
        <span class="state" title={pen.described}>{value ? pen.described : `Not ${pen.described.charAt(0).toLowerCase()}${pen.described.slice(1)}`}</span>
      {:else}
        <obc-readout
          value={typeof value === 'number' ? displayValue(value, pen.unit) : null}
          off={typeof value !== 'number'}
          offText="—"
          unit={unitLabel(pen.unit)}
          fractionDigits={typeof value === 'number' ? valueDigits(displayValue(value, pen.unit)) : 0}
          size="small"
        ></obc-readout>
      {/if}
      {#if margin !== null}
        <span class="margin" class:beyond={margin.margin < 0}>{marginText(margin, pen.unit)}</span>
      {:else if entry?.quality === 'outside-hard-range'}
        <span class="margin beyond">outside range</span>
      {/if}
    </li>
  {/each}
</ul>

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
</style>
