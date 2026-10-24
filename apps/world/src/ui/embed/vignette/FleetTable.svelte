<script lang="ts">
  import { unitSymbol } from '../../../core/observation/model.ts'
  import type { FleetColumn, SetSample, VignetteSection } from '../../../features/displays/compose/model.ts'
  import { readingLook, toneOf } from './readout.ts'
  import Readout from './Readout.svelte'
  import SetHeader from './SetHeader.svelte'

  // A set of units as a table (multiunit plan §3.1): its aggregate header, a
  // column per member column its Pack declares, a row per unit worst first
  // as the composer sampled them, the last row counting those not shown and
  // how many of them are at caution or above. Numbers read in OpenBridge's
  // readout block; words in a box; only a unit's worst alert takes its
  // priority's mark, on the unit's name.
  let { section, set }: { section: Extract<VignetteSection, { kind: 'fleet' }>; set: Extract<SetSample, { kind: 'fleet' }> | undefined } = $props()

  const look = (column: FleetColumn, value: number) =>
    readingLook(column.label, 'number', undefined, { value, unit: column.unit, ...(column.unit === '1' ? { quantity: 'count' as const } : {}), thresholds: [] })
  const span = $derived(section.columns.length + 1)
</script>

<SetHeader label={section.label} group={section.group} members={set?.members ?? 0} tallies={set?.tallies ?? []} />
<div class="scroll"><table class="fleet" style:min-width={`${span * 88}px`}>
  <thead><tr><th scope="col">Unit</th>{#each section.columns as column (column.key)}<th scope="col" class:number={column.unit !== ''}>{column.label}{unitSymbol(column.unit) === '' ? '' : ` (${unitSymbol(column.unit)})`}</th>{/each}</tr></thead>
  <tbody>
    {#each set?.rows ?? [] as row (row.objectId)}
      <tr>
        <th scope="row" class={toneOf(row.priority ?? undefined) ?? ''} title={row.alert === undefined ? row.label : `${row.label}: ${row.alert.priority ?? 'priority not declared'} · ${row.alert.message}`}>{row.label}</th>
        {#each section.columns as column (column.key)}
          {@const value = row.values[column.key]}
          <td class:number={column.unit !== ''} title={typeof value === 'string' ? value : undefined}>
            {#if typeof value === 'number'}<Readout look={{ ...look(column, value), unit: '' }} />{:else if typeof value === 'string'}<span class="box">{value}</span>{/if}
          </td>
        {/each}
      </tr>
    {/each}
    {#if set !== undefined && set.rows.length === 0}<tr><td class="none" colspan={span}>No units in this set now</td></tr>{/if}
    {#if set !== undefined && set.more > 0}<tr><td class="none" colspan={span}>+{set.more} more{set.moreAtCaution > 0 ? `, ${set.moreAtCaution} at caution or above` : ''}</td></tr>{/if}
  </tbody>
</table></div>

<style>
  /* Too narrow for its columns (a phone), the table scrolls sideways rather than cutting every cell. */
  .scroll { overflow-x: auto; }
  .fleet { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { height: var(--row); padding: 0 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: left; font-weight: 400; }
  .number { text-align: right; }
  thead th { color: var(--element-neutral-color); font-size: 12px; }
  /* A drawn divider, not a border: a border would make each row taller than its grid row. */
  tbody tr + tr > * { box-shadow: inset 0 1px 0 var(--border-divider-color); }
  .box { padding: 0 5px; border: 1px solid var(--border-outline-color); border-radius: 3px; }
  .none { color: var(--element-neutral-color); }
  th.caution, th.warning, th.alarm, th.critical { font-weight: 700; color: var(--display-alert-text); border-left: 3px solid; }
  th.caution { border-left-color: var(--display-caution-mark); }
  th.warning { border-left-color: var(--display-warning-mark); }
  th.alarm { border-left-color: var(--display-alarm-mark); }
  th.critical { border-left-color: var(--display-critical-mark); }
</style>
