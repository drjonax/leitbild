<script lang="ts">
  import { numberText, unitSymbol, type Observation } from '../../../core/observation/model.ts'
  import type { BandPoint, SetBand, VignetteValue } from '../../../features/displays/compose/model.ts'
  import { underTitle } from './format.ts'
  import { valueLook } from './readout.ts'
  import { BEYOND_BOTTOM_INSET, BEYOND_TOP_Y, stripDrawing, type DrawnSeries } from './trend.ts'

  // One trend strip (architecture B): its pens step-and-hold over the trend's
  // window for the hold served with their record, told apart by dash; the
  // time before the record starts hatched; the limits all of them share;
  // beside it a legend row per pen with its value now. The last strip of a
  // trend carries the time axis on the row below it. A set's strip draws its
  // band under its pens, its legend row giving the band's span now.
  let { pens, title, series, observations, now, horizonMs, rows, axis, band }: {
    pens: ReadonlyArray<VignetteValue>
    /** The vignette's title: a pen's name drops the object it names. */
    title: string
    series: ReadonlyMap<string, DrawnSeries>
    observations: ReadonlyArray<Observation>
    now: number
    horizonMs: number
    /** The plot's rows (at least one per pen); the axis takes one more. */
    rows: number
    axis: boolean
    /** A set's band: its points, how many units it spans and its span now. */
    band?: { readonly points: ReadonlyArray<BandPoint>; readonly now: SetBand } | undefined
  } = $props()

  const id = $props.id()
  const hatch = `unrecorded-${id}`
  let width = $state(0)
  let height = $state(0)
  const drawing = $derived(width > 0 && height > 0 && Number.isFinite(now) ? stripDrawing({ pens, series, observations, now, horizonMs, width, height, ...(band === undefined ? {} : { band: band.points }) }) : null)
  // A narrow plot names every second or third time, always "now", so no two names touch.
  const AXIS_LABEL_PX = 56
  const span = $derived.by(() => {
    if (band === undefined || pens[0] === undefined) return ''
    const { unit, quantity, decades } = pens[0]
    const text = (value: number): string => numberText(value, unit, quantity, decades === true)
    return `${text(band.now.min)}–${text(band.now.max)}${unitSymbol(unit) === '' ? '' : ` ${unitSymbol(unit)}`}`
  })
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
        {#if drawing.unrecorded !== null}
          <!-- Before the record starts nothing is known: hatched, never drawn as if a value held. -->
          <defs><pattern id={hatch} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line class="hatch" x1="0" y1="0" x2="0" y2="6" /></pattern></defs>
          <rect class="unrecorded" x="0" y="0" width={drawing.unrecorded.width} {height} fill={`url(#${hatch})`}><title>No record yet</title></rect>
        {/if}
        {#each drawing.values as tick (tick.label)}<line class="grid" x1="0" x2={width} y1={tick.y} y2={tick.y} />{/each}
        {#each drawing.limits as limit (limit.id)}<line class={`limit ${limit.priority}`} x1="0" x2={width} y1={limit.y} y2={limit.y}><title>{limit.label}</title></line>{/each}
        <!-- Names over the lines, each on its halo. -->
        {#each drawing.values as tick (tick.label)}<text class="tick" x="2" y={tick.y - 2}>{tick.label}</text>{/each}
        {#each drawing.limits as limit (limit.id)}{#if limit.labelY !== null}<text class="tick" x={width - 2} y={limit.labelY} text-anchor="end">{limit.label}</text>{/if}{/each}
        {#each drawing.beyond as limit (limit.id)}<text class="tick" x={width - 2} y={limit.edge === 'top' ? BEYOND_TOP_Y : height - BEYOND_BOTTOM_INSET} text-anchor="end">{limit.edge === 'top' ? '▲' : '▼'} {limit.label}</text>{/each}
        {#if drawing.band !== null}<path class="band" d={drawing.band.area} /><path class="band-median" d={drawing.band.median} />{/if}
        {#each drawing.pens as pen (pen.ref)}<path class={`pen ${pen.tone ?? ''}`} d={pen.path} stroke-dasharray={pen.dash === '' ? undefined : pen.dash} />{/each}
      </svg>
    {/if}
  </div>
  <ul class="legend">
    {#each pens as pen, index (pen.ref)}
      {@const look = valueLook(pen, observations, pen.ref)}
      <li title={look.title}>
        <svg width="20" height="8" aria-hidden="true"><line class="pen" x1="0" x2="20" y1="4" y2="4" stroke-dasharray={drawing?.pens[index]?.dash || undefined} /></svg>
        <span class="name">{underTitle(pen.label, title)}</span>
        <span class={`now ${look.tone ?? ''}`}>{look.text}{look.unit === '' ? '' : ` ${look.unit}`}</span>
      </li>
    {/each}
    {#if band !== undefined}
      <li title={`Min ${band.now.minAt}, max ${band.now.maxAt}`}>
        <svg class="band-key" width="20" height="8" aria-hidden="true"><rect class="band" x="0" y="0" width="20" height="8" /><line class="band-median" x1="0" x2="20" y1="4" y2="4" /></svg>
        <span class="name">{band.now.count} units, median line</span>
        <span class="now">{span}</span>
      </li>
    {/if}
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
  .hatch { stroke: var(--border-divider-color); stroke-width: 1; }
  /* A halo in the strip's own background keeps a name legible where limit lines and traces run through it. */
  .tick { fill: var(--element-neutral-color); font-size: 12px; paint-order: stroke; stroke: var(--container-section-color); stroke-width: 3px; stroke-linejoin: round; }
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
  /* A band is the span of values, not a reading: the pens' hue, faint, its median a thin neutral line. */
  .band { fill: var(--element-active-color); fill-opacity: 0.18; stroke: none; }
  .band-median { fill: none; stroke: var(--element-neutral-color); stroke-width: 1; }
  .legend { list-style: none; margin: 0; padding: 0; }
  .legend li { display: flex; align-items: center; gap: 6px; height: var(--row); min-width: 0; white-space: nowrap; }
  .legend svg { flex: none; }
  .name { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--element-neutral-color); }
  .now { flex: none; font-variant-numeric: tabular-nums; }
  .now.caution, .now.warning, .now.alarm, .now.critical { font-weight: 700; color: var(--display-alert-text); }
  .axis { position: relative; height: var(--row); color: var(--element-neutral-color); font-size: 12px; }
  .axis span { position: absolute; top: 4px; white-space: nowrap; }
</style>
