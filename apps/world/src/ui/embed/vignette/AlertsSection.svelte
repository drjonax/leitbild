<script lang="ts">
  import type { AlertRow } from '../../../features/displays/alerts/rows.ts'
  import AlertList from '../../displays/AlertList.svelte'
  import type { Palette } from '../../displays/severity.ts'
  import { sectionLines } from './alerts.ts'

  // A vignette's alerts (architecture B): the shared alert rows of its
  // objects, or of the whole Run, worst first, one line each, drawn by the
  // strip's AlertList; what does not fit its rows is counted on the last.
  let { rows, objectIds, room, palette }: {
    rows: ReadonlyArray<AlertRow>
    objectIds: ReadonlyArray<string> | 'run'
    /** The section's rows: one for its head, the rest for lines. */
    room: number
    palette: Palette
  } = $props()

  const shown = $derived(sectionLines(rows, objectIds, Math.max(1, room - 1)))
  const count = $derived(shown.lines.length + shown.more)
</script>

<section class="alerts" aria-label="Alerts">
  <h2>{objectIds === 'run' ? 'Alerts in the Run' : 'Alerts'} · {count === 0 ? 'none' : count}</h2>
  {#if count > 0}<AlertList lines={shown.lines} {palette} />{/if}
  {#if shown.more > 0}<p class="more">+{shown.more} more</p>{/if}
</section>

<style>
  h2 { margin: 0; height: var(--row); line-height: var(--row); font-size: 12px; font-weight: 600; color: var(--element-neutral-color); text-transform: uppercase; letter-spacing: 0.04em; }
  /* One row per alert, never wrapped: a frame of fixed height shows the section whole. */
  .alerts :global(.alert-list) { gap: 0; }
  .alerts :global(.line) { flex-wrap: nowrap; align-items: center; height: var(--row); overflow: hidden; white-space: nowrap; }
  .alerts :global(.line > span) { flex: none; }
  .alerts :global(.line > span:nth-last-child(1)) { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .more { margin: 0; height: var(--row); line-height: var(--row); color: var(--element-neutral-color); }
</style>
