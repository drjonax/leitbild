<script lang="ts">
  import { vesselGeometry, type VesselDrawing } from './vessel-symbol.ts'

  // The registered vessel shape (register: reactor-vessel) in OpenBridge's
  // instrument tokens: its level as the fill, and where the drawing binds its
  // parts' positions, each part hanging into its core region by its inserted
  // length. A level not known fills it as unknown, never as empty.
  let { id, width, height, origin, drawing, level, parts }: {
    id: string
    width: number
    height: number
    origin: { readonly x: number; readonly y: number }
    drawing: VesselDrawing
    level: number | null
    parts: ReadonlyArray<number | null>
  } = $props()

  const shape = $derived(vesselGeometry({ height, origin, drawing, level, groups: parts.length === 0 ? [] : [parts] }))
  const clip = $derived(`vessel-${id}`)
</script>

<svg class="vessel" {width} {height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
  <defs>
    <clipPath id={`${clip}-inside`}>
      <path d={shape.dome} />
      <rect x={shape.body.x} y={shape.body.y - 1} width={shape.body.width} height={shape.body.height + 2} />
      <path d={shape.bottom} />
    </clipPath>
  </defs>
  <g clip-path={`url(#${clip}-inside)`}>
    <rect class={shape.fill === null ? 'unknown' : 'empty'} x="0" y="0" {width} {height} />
    {#if shape.fill !== null}
      <rect class="liquid" x="0" y={shape.fill.top} {width} height={height - shape.fill.top} />
      <line class="level" x1="0" x2={width} y1={shape.fill.top + 0.5} y2={shape.fill.top + 0.5} />
    {/if}
  </g>
  {#if shape.core !== null}
    {@const core = shape.core}
    <rect class="core" x={core.x + 0.5} y={core.y + 0.5} width={core.width - 1} height={core.height - 1} />
    {#each core.bars as bar, at (at)}
      {#if bar.inserted === null || bar.withdrawn === null}
        <rect class="bar-unknown" x={bar.x} y={core.y} width={bar.width} height={core.height} />
      {:else}
        {#if bar.withdrawn > 0}<rect class="bar-out" x={bar.x} y={core.y - bar.withdrawn} width={bar.width} height={bar.withdrawn} />{/if}
        {#if bar.inserted > 0}<rect class="bar" x={bar.x} y={core.y} width={bar.width} height={bar.inserted} />{/if}
      {/if}
    {/each}
  {/if}
  <path class="outline" d={shape.dome} />
  <rect class="outline" x={shape.body.x + 0.5} y={shape.body.y} width={shape.body.width - 1} height={shape.body.height} />
  <path class="outline" d={shape.bottom} />
  <rect class="flange" x={shape.flange.x} y={shape.flange.y} width={shape.flange.width} height={shape.flange.height} rx="1" />
  {#each shape.collars as collar, at (at)}<rect class="flange" x={collar.x} y={collar.y} width={collar.width} height={collar.height} />{/each}
</svg>

<style>
  .vessel { display: block; overflow: visible; }
  /* Filled and framed as OpenBridge fills and frames its tanks, no brighter than any other vessel (ISA-101). */
  .empty { fill: var(--instrument-frame-secondary-color); }
  .unknown { fill: var(--container-section-color); }
  .liquid { fill: var(--instrument-regular-tertiary-color); }
  .level { stroke: var(--instrument-regular-secondary-color); stroke-width: 1; }
  .outline { fill: none; stroke: var(--instrument-frame-tertiary-color); stroke-width: 1.5; }
  .flange { fill: var(--instrument-frame-tertiary-color); stroke: var(--instrument-frame-tertiary-color); stroke-width: 1; }
  .core { fill: none; stroke: var(--instrument-frame-tertiary-color); stroke-width: 1; }
  .bar-out { fill: var(--instrument-regular-secondary-color); }
  .bar { fill: var(--instrument-regular-primary-color); }
  .bar-unknown { fill: none; stroke: var(--instrument-regular-primary-color); stroke-width: 1; stroke-dasharray: 2 2; }
</style>
