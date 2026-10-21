<script lang="ts">
  import type { Observation } from '../../../core/observation/model.ts'
  import type { SeriesPoint, VignetteValue } from '../../../features/displays/compose/model.ts'
  import { valueLook } from './readout.ts'
  import { stripDrawing } from './trend.ts'

  // One trend strip (architecture B): its pens step-and-hold over the trend's
  // window, told apart by dash; the limits all of them share; beside it a
  // legend row per pen with its value now. The last strip of a trend carries
  // the time axis on the row below it.
  let { pens, series, observations, now, horizonMs, rows, axis }: {
    pens: ReadonlyArray<VignetteValue>
    series: ReadonlyMap<string, ReadonlyArray<SeriesPoint>>
    observations: ReadonlyArray<Observation>
    now: number
    horizonMs: number
    /** The plot's rows (at least one per pen); the axis takes one more. */
    rows: number
    axis: boolean
  } = $props()

  let width = $state(0)
  let height = $state(0)
  const drawing = $derived(width > 0 && height > 0 && Number.isFinite(now) ? stripDrawing({ pens, series, observations, now, horizonMs, width, height }) : null)
  // A narrow plot names every second or third time, always "now", so no two names touch.
  const AXIS_LABEL_PX = 56
  const times = $derived.by(() => {
    const ticks = drawing?.times ?? []
    const every = Math.max(1, Math.ceil(AXIS_LABEL_PX / (width / Math.max(1, ticks.length - 1))))
    return ticks.filter((_, index) => (ticks.length - 1 - index) % every === 0)
  })
</script>

<div class="strip" style:--plot-rows={rows}>
  <div class="plot" bind:clientWidth={width} bind:clientHeight={height}>
    {#if drawing === null}
      <p class="empty">No recorded values in this window yet</p>
    {:else}
      <svg {width} {height} role="img" aria-label={pens.map(pen => pen.label).join(', ')}>
        {#each drawing.values as tick (tick.label)}<line class="grid" x1="0" x2={width} y1={tick.y} y2={tick.y} /><text class="tick" x="2" y={tick.y - 2}>{tick.label}</text>{/each}
        {#each drawing.limits as limit (limit.id)}<line class={`limit ${limit.priority}`} x1="0" x2={width} y1={limit.y} y2={limit.y}><title>{limit.label}</title></line>{#if limit.labelY !== null}<text class="tick" x={width - 2} y={limit.labelY} text-anchor="end">{limit.label}</text>{/if}{/each}
        {#each drawing.beyond as limit (limit.id)}<text class="tick" x={width - 2} y={limit.edge === 'top' ? 12 : height - 3} text-anchor="end">{limit.edge === 'top' ? '▲' : '▼'} {limit.label}</text>{/each}
        {#each drawing.pens as pen (pen.ref)}<path class={`pen ${pen.tone ?? ''}`} d={pen.path} stroke-dasharray={pen.dash === '' ? undefined : pen.dash} />{/each}
      </svg>
    {/if}
  </div>
  <ul class="legend">
    {#each pens as pen, index (pen.ref)}
      {@const look = valueLook(pen, observations, pen.ref)}
      <li title={look.title}>
        <svg width="20" height="8" aria-hidden="true"><line class="pen" x1="0" x2="20" y1="4" y2="4" stroke-dasharray={drawing?.pens[index]?.dash || undefined} /></svg>
        <span class="name">{pen.label}</span>
        <span class={`now ${look.tone ?? ''}`}>{look.text}{look.unit === '' ? '' : ` ${look.unit}`}</span>
      </li>
    {/each}
  </ul>
  {#if axis}
    <div class="axis">{#each times as tick (tick.label)}<span style:left={`${tick.x}px`} style:transform={tick.x < AXIS_LABEL_PX / 2 ? 'none' : tick.x > width - AXIS_LABEL_PX / 2 ? 'translateX(-100%)' : 'translateX(-50%)'}>{tick.label}</span>{/each}</div>
  {/if}
</div>

<style>
  .strip { display: grid; grid-template-columns: minmax(0, 1fr) minmax(120px, 38%); column-gap: 8px; }
  .plot { height: calc(var(--plot-rows) * var(--row)); min-width: 0; border: 1px solid var(--border-divider-color); border-radius: 3px; background: var(--container-section-color); }
  svg { display: block; overflow: visible; }
  .empty { margin: 0; padding: 4px 6px; color: var(--element-neutral-color); }
  .grid { stroke: var(--border-divider-color); stroke-width: 1; }
  .tick { fill: var(--element-neutral-color); font-size: 12px; }
  .limit { stroke: var(--element-neutral-color); stroke-width: 1; stroke-dasharray: 4 3; }
  .limit.caution { stroke: var(--alert-caution-color); }
  .limit.warning { stroke: var(--alert-warning-color); }
  .limit.alarm { stroke: var(--alert-alarm-color); }
  .limit.emergency { stroke: var(--alert-critical-color); }
  .pen { fill: none; stroke: var(--element-active-color); stroke-width: 1.5; stroke-linejoin: round; }
  .pen.caution { stroke: var(--alert-caution-color); stroke-width: 2; }
  .pen.warning { stroke: var(--alert-warning-color); stroke-width: 2; }
  .pen.alarm { stroke: var(--alert-alarm-color); stroke-width: 2; }
  .pen.critical { stroke: var(--alert-critical-color); stroke-width: 2; }
  .legend { list-style: none; margin: 0; padding: 0; }
  .legend li { display: flex; align-items: center; gap: 6px; height: var(--row); min-width: 0; white-space: nowrap; }
  .legend svg { flex: none; }
  .name { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--element-neutral-color); }
  .now { flex: none; font-variant-numeric: tabular-nums; }
  .now.caution, .now.warning, .now.alarm, .now.critical { font-weight: 700; color: var(--display-alert-text); }
  .axis { position: relative; height: var(--row); color: var(--element-neutral-color); font-size: 12px; }
  .axis span { position: absolute; top: 4px; white-space: nowrap; }
</style>
