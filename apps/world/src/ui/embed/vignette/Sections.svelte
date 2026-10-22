<script lang="ts">
  import type { SimulationRunId } from '../../../core/model/index.ts'
  import type { VignetteSection, VignetteView } from '../../../features/displays/compose/model.ts'
  import type { Palette } from '../../displays/severity.ts'
  import { slotLook } from './collection.ts'
  import type { OpenedFrom } from './popover.ts'
  import { underTitle } from './format.ts'
  import { VIGNETTE_ROW_PX } from './grid.ts'
  import { valueLook } from './readout.ts'
  import type { VignetteSnapshot } from './vignette-client.ts'
  import AlertsSection from './AlertsSection.svelte'
  import EntityTable from './EntityTable.svelte'
  import FlowTopology from './FlowTopology.svelte'
  import GroupedValues from './GroupedValues.svelte'
  import MapFocus from './MapFocus.svelte'
  import NetworkTopology from './NetworkTopology.svelte'
  import Readout from './Readout.svelte'
  import StateWord from './StateWord.svelte'
  import TrendStrip from './TrendStrip.svelte'

  // A vignette's sections, each within the rows the composer allotted: in its
  // frame (Vignette.svelte), stacked, or in a window frame (`beside`, Q20) its
  // flow drawing beside a column of the others; or in an element's pop-over
  // (ElementPopover.svelte), which leaves out its topologies: it stands beside
  // the drawing it opened from.
  let { view, snapshot, palette, frozen, runId, from, drawings = true }: {
    view: VignetteView
    snapshot: VignetteSnapshot
    palette: Palette
    frozen: boolean
    runId: SimulationRunId
    /** The display these sections stand in, as an element's pop-over names it when it opens the element elsewhere. */
    from: OpenedFrom
    drawings?: boolean
  } = $props()

  const latest = $derived(snapshot.latest)
  const observations = $derived(latest?.observations ?? [])
  const now = $derived(latest === undefined ? Number.NaN : Date.parse(latest.at.at))
  /** The flow drawing a window frame stands beside its column; -1 without one. */
  const drawing = $derived(view.sections.findIndex(section => section.kind === 'topology' && section.family === 'flow'))
</script>

{#snippet one(section: VignetteSection, index: number)}
  {#if drawings || section.kind !== 'topology'}
    <div class="section" style:height={`${section.rows * VIGNETTE_ROW_PX}px`}>
      {#if section.kind === 'values'}
        {#each section.values as value (value.ref)}
          {@const look = valueLook(value, observations, value.ref)}
          {#if look.kind === 'state'}<StateWord {look} label={underTitle(value.label, view.title)} />{:else}<Readout {look} label={underTitle(value.label, view.title)} />{/if}
        {/each}
      {:else if section.kind === 'grouped'}
        <GroupedValues {section} {observations} />
      {:else if section.kind === 'trend'}
        {#each section.strips as pens, strip (strip)}
          <TrendStrip {pens} title={view.title} series={snapshot.series} {observations} {now} horizonMs={section.horizonMs} rows={Math.max(3, pens.length)} axis={strip === section.strips.length - 1} />
        {/each}
      {:else if section.kind === 'alerts'}
        <AlertsSection rows={latest?.alerts ?? []} {section} room={section.rows} />
      {:else if section.kind === 'entity'}
        <EntityTable {section} rows={latest?.entities[index]?.rows ?? []} more={latest?.entities[index]?.more ?? 0} />
      {:else if section.kind === 'slots'}
        {#each section.slots as slot (slot.key)}
          <!-- Core slots and telemetry carry no observation priority: they read neutral. -->
          {@const look = slotLook(slot, latest?.slots[section.objectId]?.[slot.key])}
          {#if look.kind === 'state'}<StateWord {look} label={underTitle(slot.label, view.title)} />{:else}<Readout {look} label={underTitle(slot.label, view.title)} />{/if}
        {/each}
      {:else if section.kind === 'map'}
        <MapFocus frame={latest?.maps[index]} />
      {:else if section.family === 'flow'}
        <FlowTopology {section} {observations} alerts={latest?.alerts ?? []} {palette} {frozen} {runId} {from} />
      {:else}
        <NetworkTopology {section} {observations} {palette} />
      {/if}
    </div>
  {/if}
{/snippet}

{#if view.beside === true && drawing >= 0}
  <!-- A window frame (Q20): the drawing at its own width, every other view in a column beside it. -->
  <div class="beside">
    <div class="drawing">{@render one(view.sections[drawing]!, drawing)}</div>
    <div class="column">
      {#each view.sections as section, index (index)}{#if index !== drawing}{@render one(section, index)}{/if}{/each}
    </div>
  </div>
{:else}
  {#each view.sections as section, index (index)}{@render one(section, index)}{/each}
{/if}

<style>
  .section { overflow: hidden; }
  .beside { display: flex; gap: 16px; align-items: flex-start; overflow-x: auto; }
  .drawing { flex: none; }
  .column { flex: 0 0 360px; min-width: 0; }
</style>
