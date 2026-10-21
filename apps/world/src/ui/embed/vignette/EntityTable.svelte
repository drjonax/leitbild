<script lang="ts">
  import { columnHead, entityCell } from './collection.ts'
  import type { EntityRow, VignetteSection } from '../../../features/displays/compose/model.ts'

  // Objects as a table (architecture B2): a column per core slot present,
  // rows as the composer sorted them (urgency, worst alert, Run order), the
  // last row counting those not shown. Urgency and status are words in a box;
  // only a row's worst alert takes its priority's colour.
  let { section, rows, more }: { section: Extract<VignetteSection, { kind: 'entity' }>; rows: ReadonlyArray<EntityRow>; more: number } = $props()
</script>

<div class="scroll"><table class="entities" style:min-width={`${(section.columns.length + 1) * 88}px`}>
  <thead><tr><th scope="col">Object</th>{#each section.columns as column (column)}<th scope="col">{columnHead(column, section.near)}</th>{/each}</tr></thead>
  <tbody>
    {#each rows as row (row.objectId)}
      <tr class:closed={row.closed === true}>
        <th scope="row" title={row.label}>{row.label}</th>
        {#each section.columns as column (column)}
          {@const cell = entityCell(row, column)}
          <td class={cell.tone ?? ''} title={cell.title}>{#if cell.boxed}<span class="box">{cell.text}</span>{:else}{cell.text}{/if}</td>
        {/each}
      </tr>
    {/each}
    {#if rows.length === 0}<tr><td class="none" colspan={section.columns.length + 1}>None in this Run now</td></tr>{/if}
    {#if more > 0}<tr><td class="none" colspan={section.columns.length + 1}>+{more} more</td></tr>{/if}
  </tbody>
</table></div>

<style>
  /* Too narrow for its columns (a phone), the table scrolls sideways rather than cutting every cell. */
  .scroll { overflow-x: auto; }
  .entities { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { height: var(--row); padding: 0 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: left; font-weight: 400; }
  thead th { color: var(--element-neutral-color); font-size: 12px; }
  tbody tr + tr { border-top: 1px solid var(--border-divider-color); }
  .box { padding: 0 5px; border: 1px solid var(--border-outline-color); border-radius: 3px; }
  .closed { color: var(--element-neutral-color); }
  .none { color: var(--element-neutral-color); }
  td.caution, td.warning, td.alarm, td.critical { font-weight: 700; color: var(--display-alert-text); border-left: 3px solid; }
  td.caution { border-left-color: var(--display-caution-mark); }
  td.warning { border-left-color: var(--display-warning-mark); }
  td.alarm { border-left-color: var(--display-alarm-mark); }
  td.critical { border-left-color: var(--display-critical-mark); }
</style>
