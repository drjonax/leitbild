<script lang="ts">
  import type { ComposedFaceplatePanel } from '../../../packs/process-plant/displays/compose.ts'
  import { composedDisplayLayout } from '../../../packs/process-plant/displays/composition.ts'
  import type { ComposedDisplaySample } from './composed-display-client.ts'
  import type { ComposedDisplaySnapshot } from './composed-display-session.ts'
  import { FACEPLATE_SPARKLINE_MS, faceplateLines } from './faceplate-lines.ts'
  import { SPARKLINE_SIZE, sparklineWindowText } from './sparkline.ts'
  import FaceplateLine from './FaceplateLine.svelte'
  import FaceplateLoopTable from './FaceplateLoopTable.svelte'
  import SafetyFunctionChips from './SafetyFunctionChips.svelte'
  import './faceplate-openbridge.ts'

  // An energy end's faceplate under its drawing in its detail: a column per
  // function the derivation heads it by (a first-out group, a critical
  // safety function's chip, a port circuit with the equipment it reaches),
  // each a stack of one-line rows (HF review, HF-02), as tall as World sized
  // it (faceplateHeight), so nothing under it moves as rows come and go.
  let { panel, latest, history, above = 0, stale = false }: {
    panel: ComposedFaceplatePanel
    /** The page's samples are stale: its rows are greyed, as the drawing's states read unknown. */
    stale?: boolean
    latest: ComposedDisplaySample | undefined
    history: Pick<ComposedDisplaySnapshot, 'series' | 'historyMissing' | 'historyErrors'>
    /** The gap above it, where it follows the drawing in the drawing's own column (stacked panels have theirs). */
    above?: number
  } = $props()

  const layout = composedDisplayLayout
  const columns = $derived(latest === undefined ? [] : faceplateLines(panel, latest, history.series))
  const now = $derived(latest === undefined ? Number.NaN : Date.parse(latest.simulationTime))
</script>

<!-- Before the first sample the faceplate keeps its room, empty, so the drawing above it does not move. -->
<section class="faceplate" class:stale aria-label={stale ? 'Faceplate (stale: values not current)' : 'Faceplate'} style={`height:${panel.height}px;margin-top:${above}px;padding:${layout.faceplatePad}px 0;grid-template-columns:repeat(${panel.faceplate.columns.length}, minmax(0, 1fr))`}>
  {#each columns as column, index (index)}
    <div class="column">
      <div class="head" style={`height:${layout.faceplateHead}px`}>
        <div class="titles">
          {#each column.head.parts as part, at (at)}
            {#if part.kind === 'chip'}<SafetyFunctionChips functions={[part.chip]} />{:else}<span class="group" data-text>{part.text}</span>{#if part.since !== undefined}<span class="since" data-text>· {part.since}</span>{/if}{/if}
          {/each}
        </div>
        <div class="sub">
          <span class="equipment" data-text title={column.head.sub}>{column.head.sub}</span>
          {#if column.lines.some(line => line.kind === 'values' && line.sparkline !== null)}
            <!-- Over the sparklines, which end each row: their window, once. -->
            <span class="window" style={`width:${SPARKLINE_SIZE.width}px`} title={`Each sparkline: the last ${sparklineWindowText(FACEPLATE_SPARKLINE_MS)} of the value's recorded history, scaled to its own range`}><span>−{sparklineWindowText(FACEPLATE_SPARKLINE_MS)}</span><span>now</span></span>
          {/if}
        </div>
      </div>
      <ul class="lines" style={`--row:${layout.faceplateRow}px`}>
        {#each column.lines as line, at (at)}
          {#if line.kind === 'loops'}
            <FaceplateLoopTable table={line.table} />
          {:else}
            <FaceplateLine {line} {now} {history} />
          {/if}
        {/each}
      </ul>
    </div>
  {/each}
</section>

<style>
  /* As wide as the drawing's room, never wider: its rows' own widths do not size it (inline-size containment), so it never pushes the column beside the drawing away. */
  .faceplate { display: grid; flex: none; contain: inline-size; border-top: 1px solid var(--border-divider-color); overflow: hidden; }
  /* Columns share the drawing's width; a divider, not a gap, parts them, so each keeps the width World checked it fits (faceplateColumnMin). */
  .column { min-width: 0; padding: 0 10px; border-left: 1px solid var(--border-divider-color); display: flex; flex-direction: column; }
  .column:first-child { border-left: none; padding-left: 0; }
  .head { flex: none; display: flex; flex-direction: column; justify-content: center; gap: 2px; border-bottom: 1px solid var(--border-divider-color); }
  .titles { display: flex; align-items: center; gap: 6px; min-width: 0; height: 18px; white-space: nowrap; }
  /* Head words read as the chips beside them do: upper case, as a first-out group's short label is written. */
  .group { font-size: 12px; font-weight: 700; letter-spacing: 0.03em; text-transform: uppercase; color: var(--element-active-color); white-space: nowrap; }
  .since { margin-left: -2px; font-size: 12px; font-weight: 600; white-space: nowrap; }
  .sub { display: flex; align-items: center; gap: 8px; height: 14px; min-width: 0; font-size: 11px; color: var(--element-neutral-color); }
  .equipment { flex: 1 1 0; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .window { flex: none; display: flex; justify-content: space-between; font-size: 10px; font-variant-numeric: tabular-nums; }
  /* The window is labelled only over a column that draws a sparkline: a row narrow for one gives it up (FaceplateLine). */
  .column:not(:has(:global(svg.sparkline))) .window { visibility: hidden; }
  .lines { list-style: none; margin: 0; padding: 0; min-width: 0; }
  .faceplate.stale .lines { opacity: 0.45; }
</style>
