<script lang="ts">
  import type { FaceplateLoopTable } from './faceplate-lines.ts'

  // Parallel loops as one aligned table (HF review, HF-02): a head line, then
  // a line per loop, each as tall as a faceplate row; numbers in tabular
  // figures, right-aligned, the unit once in the head. A column no rule that
  // judges it acts on in this mode is idle: faint, as an idle limit is.
  let { table }: { table: FaceplateLoopTable } = $props()
</script>

<li class="table">
  <table>
    <thead>
      <tr>
        <th class="loop"></th>
        {#each table.columns as column, index (index)}
          <!-- A long head wraps after its slashes and hyphens, two lines to its row, so the table keeps to its column. -->
          <th class:idle={column.idle} title={column.title}><span data-text>{column.head.replaceAll('/', '/\u200b')}{column.unit === '' ? '' : ` ${column.unit}`}</span></th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each table.rows as row (row.loop)}
        <tr>
          <th class="loop" scope="row" data-text>{row.loop}</th>
          {#each row.cells as cell, index (index)}
            <td class:idle={table.columns[index]!.idle} class={cell.alert === null ? '' : `alert ${cell.alert}`} title={cell.title} data-text>{cell.text}</td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
</li>

<style>
  .table { list-style: none; }
  table { border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  tr { height: var(--row); }
  th, td { padding: 0 0 0 10px; text-align: right; font-weight: 400; }
  thead th { font-size: 11px; line-height: 13px; white-space: normal; vertical-align: bottom; color: var(--element-neutral-color); }
  th.loop { padding-left: 0; text-align: left; color: var(--element-neutral-color); min-width: 1.5em; }
  .idle { opacity: 0.6; }
  /* A cell an I&C limit acts on takes its colour and weight, as everywhere an alarm shows. */
  /* A cell in alert: bold, readable text with a bar in its alert colour (embed.css), never written in it. */
  .alert { font-weight: 700; color: var(--display-alert-text); box-shadow: inset 3px 0 0 var(--display-caution-mark); }
  .alert.alarm { box-shadow: inset 3px 0 0 var(--display-alarm-mark); }
  .alert.warning { box-shadow: inset 3px 0 0 var(--display-warning-mark); }
</style>
