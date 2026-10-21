<script lang="ts">
  import { unitSymbol, type Observation } from '../../../core/observation/model.ts'
  import type { VignetteSection } from './model.ts'
  import { valueLook } from './readout.ts'
  import Readout from './Readout.svelte'
  import StateWord from './StateWord.svelte'

  // Parallel values as one table (architecture B): a column per quantity, a
  // line per element, as the composer grouped them; each cell reads as its
  // own readout or state, its limit chip shortened to the order word.
  let { section, observations }: { section: Extract<VignetteSection, { kind: 'grouped' }>; observations: ReadonlyArray<Observation> } = $props()
</script>

<table class="grouped" style:--columns={section.quantities.length}>
  <thead>
    <tr><th scope="col"></th>{#each section.quantities as quantity, index (index)}<th scope="col">{quantity.label}{unitSymbol(quantity.unit) === '' ? '' : ` (${unitSymbol(quantity.unit)})`}</th>{/each}</tr>
  </thead>
  <tbody>
    {#each section.lines as line (line.element.id)}
      <tr>
        <th scope="row" title={line.element.label}>{line.element.shortLabel ?? line.element.label}</th>
        {#each line.values as value, index (index)}
          <td>
            {#if value !== null}
              {@const look = valueLook(value, observations, value.ref)}
              {#if look.kind === 'state'}<StateWord {look} />{:else}<Readout look={{ ...look, unit: '' }} />{/if}
            {/if}
          </td>
        {/each}
      </tr>
    {/each}
  </tbody>
</table>

<style>
  .grouped { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { height: var(--row); padding: 0 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 400; }
  thead th { text-align: right; color: var(--element-neutral-color); font-size: 12px; }
  tbody th { text-align: left; color: var(--element-neutral-color); }
  tbody tr + tr { border-top: 1px solid var(--border-divider-color); }
</style>
