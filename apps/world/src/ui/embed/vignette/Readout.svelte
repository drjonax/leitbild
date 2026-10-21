<script lang="ts">
  import type { ReadingLook } from './readout.ts'

  // A number on one row (architecture B): its label, the chip of the limit it
  // is past, the value with its unit, what it is heading for, and its limit
  // bar. The value is never written in an alert colour: past a limit it is
  // bold and marked in that colour (embed.css). Without a label it is a cell
  // of a grouped table, without its bar.
  let { look, label }: { look: ReadingLook; label?: string } = $props()

  const BAR = { width: 64, height: 10 }
</script>

<span class="readout" class:doubtful={look.doubtful} class:cell={label === undefined} title={look.title}>
  {#if label !== undefined}<span class="label">{label}</span>{/if}
  {#if look.chip !== null}<span class={`chip ${look.chip.tone ?? 'neutral'}`}>{label === undefined ? look.chip.word : look.chip.text}</span>{/if}
  <span class={`value ${look.tone ?? ''}`} class:emphasis={look.emphasis}>{look.text}{#if look.unit !== ''}<span class="unit">{look.unit}</span>{/if}</span>
  {#if look.note !== null && label !== undefined}<span class="note">{look.note}</span>{/if}
  {#if look.bar !== null && label !== undefined}
    <svg class="bar" width={BAR.width} height={BAR.height} aria-hidden="true">
      <rect class="track" x="0.5" y="2.5" width={BAR.width - 1} height={BAR.height - 5} rx="2" />
      {#each look.bar.ticks as tick (tick.id)}<line class={`tick ${tick.priority}`} x1={tick.at * BAR.width} x2={tick.at * BAR.width} y1="0" y2={BAR.height} />{/each}
      <circle class="marker" cx={Math.min(BAR.width - 3, Math.max(3, look.bar.at * BAR.width))} cy={BAR.height / 2} r="3" />
    </svg>
  {/if}
</span>

<style>
  .readout { display: flex; align-items: center; gap: 6px; min-width: 0; height: var(--row); white-space: nowrap; }
  .label { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--element-neutral-color); }
  .value { flex: none; font-variant-numeric: tabular-nums; }
  .unit { margin-left: 3px; color: var(--element-neutral-color); }
  .emphasis, .value.caution, .value.warning, .value.alarm, .value.critical { font-weight: 700; color: var(--display-alert-text); }
  .value.caution { text-decoration: underline 2px var(--display-caution-mark); text-underline-offset: 3px; }
  .value.warning { text-decoration: underline 2px var(--display-warning-mark); text-underline-offset: 3px; }
  .value.alarm { text-decoration: underline 2px var(--display-alarm-mark); text-underline-offset: 3px; }
  .value.critical { text-decoration: underline 2px var(--display-critical-mark); text-underline-offset: 3px; }
  .note { flex: none; color: var(--element-neutral-color); }
  .doubtful .value { opacity: 0.6; font-style: italic; }
  .chip { flex: none; padding: 0 4px; border: 1px solid; border-radius: 3px; font-weight: 700; letter-spacing: 0.03em; }
  .chip.neutral { color: var(--element-active-color); border-color: var(--border-outline-color); }
  .chip.caution { background: var(--display-caution-fill); color: var(--display-on-caution); border-color: var(--alert-caution-color); }
  .chip.warning { background: var(--display-warning-fill); color: var(--display-on-warning); border-color: var(--alert-warning-color); }
  .chip.alarm { background: var(--display-alarm-fill); color: var(--display-on-alarm); border-color: var(--alert-alarm-color); }
  .chip.critical { background: var(--display-critical-fill); color: var(--display-on-critical); border-color: var(--alert-critical-color); }
  .bar { flex: none; }
  .track { fill: var(--instrument-frame-primary-color); stroke: var(--instrument-frame-tertiary-color); }
  .tick { stroke: var(--element-neutral-color); stroke-width: 2; }
  .tick.caution { stroke: var(--alert-caution-color); }
  .tick.warning { stroke: var(--alert-warning-color); }
  .tick.alarm { stroke: var(--alert-alarm-color); }
  .tick.emergency { stroke: var(--alert-critical-color); }
  .marker { fill: var(--element-active-color); stroke: var(--container-background-color); }
  .cell { justify-content: flex-end; }
  /* A phone keeps the label, the chip and the value; the countdown and the bar give way. */
  @media (max-width: 479px) { .note, .bar { display: none; } }
</style>
