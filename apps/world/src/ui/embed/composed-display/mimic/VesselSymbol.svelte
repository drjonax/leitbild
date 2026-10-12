<script lang="ts">
  import type { MimicDrawnItem } from '../../../../packs/process-plant/displays/mimic/mimic-model.ts'
  import { insertedFraction, vesselGeometry } from './vessel-symbol.ts'
  import type { SampleIndex } from '../../../../packs/process-plant/displays/mimic/evaluate.ts'

  // A reactor vessel (vessel-symbol.ts) in OpenBridge's instrument tokens:
  // no hot or cold colour, no safety-function colour. Its alarm frame and
  // abnormal outline are the drawing's, around its box, as for any symbol.
  let { item, level, index }: {
    item: MimicDrawnItem & { readonly vessel: NonNullable<MimicDrawnItem['vessel']> }
    /** Its fill in percent of the interior; null where the level is not known. */
    level: number | null
    index: SampleIndex
  } = $props()

  const reading = (path: string): number | null => {
    const entry = index.get(path)
    return entry !== undefined && typeof entry.value === 'number' && entry.quality !== 'outside-hard-range' ? entry.value : null
  }
  const insertion = $derived(item.binding.insertion)
  const shape = $derived(vesselGeometry({
    height: item.box.height,
    origin: { x: item.box.x, y: item.box.y },
    drawing: item.vessel,
    level,
    groups: insertion === undefined ? [] : insertion.groups.map(group => group.map(part => insertedFraction(reading(part.path), part.range, insertion.insertedAt))),
  }))
  const id = $derived(`vessel-${item.id}`)
</script>

<svg class="vessel" width={item.box.width} height={item.box.height} viewBox={`0 0 ${item.box.width} ${item.box.height}`} aria-hidden="true">
  <defs>
    <clipPath id={`${id}-inside`}>
      <path d={shape.dome} />
      <rect x={shape.body.x} y={shape.body.y - 1} width={shape.body.width} height={shape.body.height + 2} />
      <path d={shape.bottom} />
    </clipPath>
    {#if shape.core !== null}
      <clipPath id={`${id}-core`}><rect x={shape.core.x} y={shape.core.y} width={shape.core.width} height={shape.core.height} /></clipPath>
    {/if}
  </defs>
  <g clip-path={`url(#${id}-inside)`}>
    <rect class={shape.fill === null ? 'unknown' : 'empty'} x="0" y="0" width={item.box.width} height={item.box.height} />
    {#if shape.fill !== null}
      <rect class="liquid" x="0" y={shape.fill.top} width={item.box.width} height={item.box.height - shape.fill.top} />
      <line class="level" x1="0" x2={item.box.width} y1={shape.fill.top + 0.5} y2={shape.fill.top + 0.5} />
    {/if}
  </g>
  {#if shape.core !== null}
    {@const core = shape.core}
    <g clip-path={`url(#${id}-core)`}>
      {#each core.hatch as line, at (at)}<line class="hatch" x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} />{/each}
    </g>
    <rect class="core" x={core.x + 0.5} y={core.y + 0.5} width={core.width - 1} height={core.height - 1} />
    {#each core.bars as bar, at (at)}
      {#if bar.inserted === null || bar.withdrawn === null}
        <rect class="bar-unknown" x={bar.x} y={core.y} width={bar.width} height={core.height} />
      {:else}
        <!-- Withdrawn above the core region, quiet; inserted into it, bright: a tripped core reads at a glance. -->
        {#if bar.withdrawn > 0}<rect class="bar-out" x={bar.x} y={core.y - bar.withdrawn} width={bar.width} height={bar.withdrawn} />{/if}
        {#if bar.inserted > 0}<rect class="bar" x={bar.x} y={core.y} width={bar.width} height={bar.inserted} />{/if}
      {/if}
    {/each}
  {/if}
  <path class="outline" d={shape.dome} />
  <rect class="outline" x={shape.body.x + 0.5} y={shape.body.y} width={shape.body.width - 1} height={shape.body.height} />
  <path class="outline" d={shape.bottom} />
  <rect class="flange" x={shape.flange.x} y={shape.flange.y} width={shape.flange.width} height={shape.flange.height} rx="1" />
  {#each shape.collars as collar, at (at)}<rect class="collar" x={collar.x} y={collar.y} width={collar.width} height={collar.height} />{/each}
</svg>

<style>
  .vessel { display: block; overflow: visible; }
  /* Filled and framed as OpenBridge fills and frames its tanks (its linear indicators' regular scheme), so the vessel is
     no brighter than any other on a normal display (ISA-101; HMI review of run 26c). */
  .empty { fill: var(--instrument-frame-secondary-color); }
  /* A level the drawing does not know: OpenBridge's static fill, never an empty vessel. */
  .unknown { fill: var(--container-section-color); }
  .liquid { fill: var(--instrument-regular-tertiary-color); }
  .level { stroke: var(--instrument-regular-secondary-color); stroke-width: 1; }
  .outline { fill: none; stroke: var(--instrument-frame-tertiary-color); stroke-width: 1.5; }
  .flange, .collar { fill: var(--instrument-frame-tertiary-color); stroke: var(--instrument-frame-tertiary-color); stroke-width: 1; }
  .core { fill: none; stroke: var(--instrument-frame-tertiary-color); stroke-width: 1; }
  .hatch { stroke: var(--instrument-frame-tertiary-color); stroke-width: 1; opacity: 0.25; }
  .bar-out { fill: var(--instrument-regular-secondary-color); }
  .bar { fill: var(--instrument-regular-primary-color); }
  .bar-unknown { fill: none; stroke: var(--instrument-regular-primary-color); stroke-width: 1; stroke-dasharray: 2 2; }
</style>
