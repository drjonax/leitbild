<script lang="ts">
  import type { FleetTally } from '../../../features/displays/compose/model.ts'

  // A set's aggregate header (multiunit plan §3.1): its category and group,
  // how many units it holds now, then a chip per word its Pack tallies
  // (steady words left out), each naming up to three of its units. The
  // words are the Pack's own; World only counts them.
  let { label, group, members, tallies }: {
    label: string
    group?: { readonly label: string; readonly value: string } | undefined
    members: number
    tallies: ReadonlyArray<FleetTally>
  } = $props()
</script>

<div class="set-header">
  <span class="title" title={group === undefined ? label : `${label} · ${group.label} ${group.value}`}>{label}{#if group !== undefined}<span class="group">{` · ${group.label} ${group.value}`}</span>{/if}</span>
  <span class="count">{members} {members === 1 ? 'unit' : 'units'}</span>
  {#each tallies as tally (`${tally.column}:${tally.word}`)}
    <span class="tally" title={`${tally.labels.join(', ')}${tally.count > tally.labels.length ? ` and ${tally.count - tally.labels.length} more` : ''}`}>{tally.count} {tally.word}</span>
  {/each}
</div>

<style>
  .set-header { display: flex; align-items: center; gap: 6px; height: var(--row); min-width: 0; overflow: hidden; white-space: nowrap; }
  .title { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; font-weight: 700; }
  .group { font-weight: 400; color: var(--element-neutral-color); }
  .count { flex: none; color: var(--element-neutral-color); font-variant-numeric: tabular-nums; }
  .tally { flex: none; padding: 0 5px; border: 1px solid var(--border-outline-color); border-radius: 3px; font-variant-numeric: tabular-nums; }
</style>
