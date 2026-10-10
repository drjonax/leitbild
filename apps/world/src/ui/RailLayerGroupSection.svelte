<script lang="ts">
  import type { PackMapLayerGroup } from '../core/packs/protocol.ts'
  import type { PackMapLegend, PackMapLegendSwatch } from '../core/packs/reference-style.ts'

  interface Props {
    readonly groups: ReadonlyArray<PackMapLayerGroup>
    readonly legends?: ReadonlyArray<PackMapLegend>
    readonly visibility: Readonly<Record<string, boolean>>
    readonly onToggle: (groupId: string) => void
  }

  const { groups, legends = [], visibility, onToggle }: Props = $props()

  const isVisible = (group: PackMapLayerGroup): boolean =>
    visibility[group.id] ?? group.defaultVisible
</script>

{#snippet swatchIcon(swatch: PackMapLegendSwatch)}
  <svg
    class="swatch"
    style:--swatch-light={swatch.color.light}
    style:--swatch-dark={swatch.color.dark}
    width="24"
    height="14"
    viewBox="0 0 24 14"
    aria-hidden="true"
  >
    {#if swatch.symbol === 'line' || swatch.symbol === 'dashed-line'}
      <line
        x1="3"
        y1="7"
        x2="21"
        y2="7"
        stroke="currentColor"
        stroke-width={swatch.sizePx}
        stroke-linecap={swatch.symbol === 'line' ? 'round' : 'butt'}
        stroke-dasharray={swatch.symbol === 'dashed-line' ? `${swatch.sizePx * 2} ${swatch.sizePx}` : undefined}
      />
    {:else if swatch.symbol === 'circle'}
      <circle cx="12" cy="7" r={swatch.sizePx / 2} fill="currentColor" />
    {:else}
      <circle cx="12" cy="7" r={swatch.sizePx / 2} fill="none" stroke="currentColor" stroke-width="1.5" />
    {/if}
  </svg>
{/snippet}

{#if groups.length > 0 || legends.length > 0}
  <section class="rail-layer-groups" aria-label="Map layers">
    <header class="rail-layer-groups-header">Map layers</header>
    <ul class="rail-layer-groups-list">
      {#each groups as group (group.id)}
        <li>
          <label>
            <input
              type="checkbox"
              checked={isVisible(group)}
              onchange={() => onToggle(group.id)}
            />
            {#if group.swatch}{@render swatchIcon(group.swatch)}{/if}
            <span>{group.label}</span>
          </label>
        </li>
      {/each}
    </ul>
    {#each legends as legend (legend.id)}
      <div class="rail-legend" role="group" aria-label={legend.title}>
        <header class="rail-layer-groups-header">{legend.title}</header>
        <ul class="rail-legend-list">
          {#each legend.entries as entry (entry.id)}
            <li>{@render swatchIcon(entry)}<span>{entry.label}</span></li>
          {/each}
        </ul>
      </div>
    {/each}
  </section>
{/if}

<style>
  .rail-layer-groups {
    border-top: 1px solid var(--border);
    padding: 8px 12px 10px;
    font-size: 12px;
    color: var(--text);
  }
  .rail-layer-groups-header {
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--muted);
    text-transform: uppercase;
    font-size: 10px;
    margin-bottom: 6px;
  }
  .rail-layer-groups-list,
  .rail-legend-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .rail-layer-groups-list li,
  .rail-legend-list li {
    margin: 2px 0;
  }
  .rail-layer-groups-list label,
  .rail-legend-list li {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .rail-layer-groups-list label {
    cursor: pointer;
  }
  .rail-layer-groups-list input[type="checkbox"] {
    margin: 0;
  }
  .rail-legend {
    margin-top: 8px;
  }
  .swatch {
    flex: none;
    color: var(--swatch-light);
  }
  :global(:root.dark) .swatch {
    color: var(--swatch-dark);
  }
</style>
