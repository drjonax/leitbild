<script lang="ts">
  import { numberText, unitSymbol, type Observation } from '../../../core/observation/model.ts'
  import type { SetBand, SetColumn, SetSample, VignetteSection } from '../../../features/displays/compose/model.ts'
  import { toneOf, valueLook } from './readout.ts'
  import Readout from './Readout.svelte'
  import StateWord from './StateWord.svelte'

  // Units side by side (multiunit plan §3.1): a column per quantity, a row per
  // unit as the composer chose them, each cell its own readout or state, so a
  // value past a declared limit takes that limit's alert frame and nothing
  // else marks a deviation. A unit that does not measure a quantity says so in
  // its cell. Beyond its rows, the last row is each quantity's band over every
  // unit, its ends named in its title.
  let { section, set, observations }: {
    section: Extract<VignetteSection, { kind: 'compare' }>
    set: Extract<SetSample, { kind: 'compare' }> | undefined
    observations: ReadonlyArray<Observation>
  } = $props()

  const text = (column: SetColumn, value: number): string => numberText(value, column.unit, column.observable?.quantity, column.observable?.decades === true)
  const bandText = (column: SetColumn, band: SetBand): string => `${text(column, band.min)}–${text(column, band.max)}`
  const missing = (at: number): string => {
    const units = set?.missing[at] ?? []
    return units.length === 0 ? '' : ` · not measured on ${units.join(', ')}`
  }
</script>

<table class="compare" style:--columns={section.columns.length}>
  <thead>
    <tr>
      <th scope="col">{set === undefined ? '' : `${set.members} ${set.members === 1 ? 'unit' : 'units'}`}</th>
      {#each section.columns as column, at (at)}<th scope="col" title={`${column.label}${missing(at)}`}>{column.label}{unitSymbol(column.unit) === '' ? '' : ` (${unitSymbol(column.unit)})`}</th>{/each}
    </tr>
  </thead>
  <tbody>
    {#each set?.rows ?? [] as row (row.objectId)}
      <tr>
        <th scope="row" class={toneOf(row.priority ?? undefined) ?? ''} title={row.label}>{row.label}</th>
        {#each row.refs as ref, at (at)}
          {@const column = section.columns[at]}
          <td>
            {#if ref === null}<span class="absent">not measured</span>
            {:else if column?.observable !== undefined}
              {@const look = valueLook({ ...column.observable, label: column.label }, observations, ref)}
              {#if look.kind === 'state'}<StateWord {look} />{:else}<Readout look={{ ...look, unit: '' }} />{/if}
            {/if}
          </td>
        {/each}
      </tr>
    {/each}
    {#if set?.band != null}
      <tr class="band">
        <th scope="row" title={`The span of every unit's value; ${set.more} more units not listed`}>+{set.more} more · span</th>
        {#each set.band as band, at (at)}
          {@const column = section.columns[at]}
          <td title={band === null || column === undefined ? undefined : `min ${band.minAt}, median ${text(column, band.median)}, max ${band.maxAt}`}>{band === null || column === undefined ? '' : bandText(column, band)}</td>
        {/each}
      </tr>
    {/if}
  </tbody>
</table>

<style>
  .compare { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { height: var(--row); padding: 0 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 400; }
  thead th { text-align: right; color: var(--element-neutral-color); font-size: 12px; }
  thead th:first-child { text-align: left; }
  tbody th { text-align: left; }
  td { text-align: right; font-variant-numeric: tabular-nums; }
  /* A drawn divider, not a border: a border would make each row taller than its grid row. */
  tbody tr + tr > * { box-shadow: inset 0 1px 0 var(--border-divider-color); }
  .absent { color: var(--element-neutral-color); font-style: italic; }
  .band th, .band td { color: var(--element-neutral-color); }
  th.caution, th.warning, th.alarm, th.critical { font-weight: 700; color: var(--display-alert-text); border-left: 3px solid; }
  th.caution { border-left-color: var(--display-caution-mark); }
  th.warning { border-left-color: var(--display-warning-mark); }
  th.alarm { border-left-color: var(--display-alarm-mark); }
  th.critical { border-left-color: var(--display-critical-mark); }
</style>
