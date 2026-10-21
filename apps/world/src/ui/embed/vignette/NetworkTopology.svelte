<script lang="ts">
  import type { Observation } from '../../../core/observation/model.ts'
  import type { VignetteSection } from './model.ts'
  import { networkDrawing } from './network.ts'

  // A network topology (architecture B2): the SVG of the server's ELK
  // layout at one grid unit a row, scrolled sideways where it is wider than
  // its frame, never scaled below its 12 px text. Its attribution closes it.
  let { section, observations }: { section: Extract<VignetteSection, { kind: 'topology' }>; observations: ReadonlyArray<Observation> } = $props()

  const drawing = $derived(networkDrawing(section, observations))
</script>

<div class="network">
  <svg width={drawing.width} height={drawing.height} role="img" aria-label="Network topology">
    {#each drawing.groups as group (group.id)}
      <rect class="group" x={group.x} y={group.y} width={group.width} height={group.height} rx="4" /><text class="group-label" x={group.x + 4} y={group.y + 14}>{group.label}</text>
    {/each}
    {#each drawing.edges as edge (edge.id)}<path class="edge" d={edge.path} />{/each}
    {#each drawing.nodes as node (node.id)}
      <g class={`node ${node.tone ?? ''}`} class:off={node.conducting === false}>
        <title>{node.title}{node.reading === null ? '' : ` · ${node.reading}`}</title>
        {#if node.shape === 'bar'}
          {#if node.bar !== null}<line class="bar" x1={node.bar.x1} x2={node.bar.x2} y1={node.bar.y1} y2={node.bar.y2} />{/if}
          <text x={node.x + 2} y={node.y + 14}>{node.name}</text>
        {:else if node.shape === 'switch'}
          <rect class="switch" class:closed={node.conducting === true} x={node.x + node.width / 2 - 6} y={node.y + 4} width="12" height="12" />
          <text x={node.x + node.width / 2} y={node.y + 30} text-anchor="middle">{node.name}</text>
        {:else if node.shape === 'stop'}
          <text class="stop" x={node.x + 2} y={node.y + 16}>{node.name}</text>
        {:else}
          <rect class="box" x={node.x + 0.5} y={node.y + 0.5} width={node.width - 1} height={node.height - 1} rx="3" />
          <text x={node.x + 3} y={node.y + 15}>{node.name}</text>
          {#if node.reading !== null && node.height >= 40}<text class="reading" x={node.x + 3} y={node.y + 34}>{node.reading}</text>{/if}
        {/if}
      </g>
    {/each}
  </svg>
</div>
{#if section.attribution !== undefined}<p class="attribution">{section.attribution}</p>{/if}

<style>
  .network { overflow-x: auto; overflow-y: hidden; }
  svg { display: block; }
  text { font-size: 12px; fill: var(--element-active-color); }
  .group { fill: none; stroke: var(--border-divider-color); }
  .group-label, .stop { fill: var(--element-neutral-color); }
  .edge { fill: none; stroke: var(--element-neutral-color); stroke-width: 1.5; }
  .bar { stroke: var(--element-active-color); stroke-width: 4; }
  .box, .switch { fill: var(--container-section-color); stroke: var(--element-active-color); stroke-width: 1; }
  .switch.closed { fill: var(--element-active-color); }
  .reading { font-variant-numeric: tabular-nums; }
  .off .box, .off .switch, .off .bar { stroke-dasharray: 4 3; }
  .caution .box, .caution .switch { stroke: var(--alert-caution-color); stroke-width: 2; }
  .warning .box, .warning .switch { stroke: var(--alert-warning-color); stroke-width: 2; }
  .alarm .box, .alarm .switch { stroke: var(--alert-alarm-color); stroke-width: 2; }
  .critical .box, .critical .switch { stroke: var(--alert-critical-color); stroke-width: 2; }
  .caution .bar { stroke: var(--alert-caution-color); }
  .warning .bar { stroke: var(--alert-warning-color); }
  .alarm .bar { stroke: var(--alert-alarm-color); }
  .critical .bar { stroke: var(--alert-critical-color); }
  .attribution { margin: 0; height: var(--row); line-height: var(--row); font-size: 12px; color: var(--element-neutral-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
