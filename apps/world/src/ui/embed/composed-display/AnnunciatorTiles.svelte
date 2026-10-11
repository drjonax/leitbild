<script lang="ts">
  import type { AnnunciatorSystem, DisplayAnnunciation } from '../../../packs/process-plant/displays/annunciators.ts'
  import { composedDisplayLayout } from '../../../packs/process-plant/displays/composition.ts'
  import type { ComposedDisplaySample } from './composed-display-client.ts'
  import { alertTypeOf, annunciatorStates } from './panel-presenters.ts'
  import './openbridge.ts'

  // One tile per annunciator system the Plant declares, always in the place
  // the model gives it, so an operator reads the panel by where it is lit. A
  // quiet tile is grey. A lit one is barred and counted in its worst
  // severity's colour, a filled badge while any is unacknowledged and flat
  // once all are; TRIP and 1st say in words what colour alone cannot. This
  // display cannot acknowledge, so nothing flashes. A tile filters the alarm
  // list to its system.
  let { systems, tileWidth, latest, annunciation, selected, select }: {
    systems: ReadonlyArray<AnnunciatorSystem>
    /** What first out means per rule: a tile says 1st only for a group of more than one rule. */
    annunciation: DisplayAnnunciation
    /** The tiles' least width the server sized the display for; their labels fit it. */
    tileWidth: number
    latest: ComposedDisplaySample | undefined
    selected: string | null
    select: (system: string | null) => void
  } = $props()

  const layout = composedDisplayLayout
  const states = $derived(annunciatorStates(systems, latest?.alarms ?? [], annunciation))

  const described = (state: (typeof states)[number]): string => state.active === 0
    ? `${state.name}: no active alarm`
    : `${state.name}: ${state.active} active${state.unacknowledged > 0 ? `, ${state.unacknowledged} unacknowledged` : ''}${state.trip ? ', trip' : ''}${state.firstOut ? ', first out' : ''}`
</script>

<div class="tiles" role="group" aria-label="Alarms by system" style={`grid-template-columns:repeat(auto-fill,minmax(${tileWidth}px,1fr));gap:${layout.annunciatorGap}px`}>
  {#each states as state, at (state.id)}
    {@const type = state.severity === null ? null : alertTypeOf(state.severity)}
    <button
      type="button"
      class={`tile${type === null ? '' : ` alert-${type}`}`}
      class:selected={selected === state.id}
      style={`height:${layout.annunciatorTile.height}px`}
      aria-pressed={selected === state.id}
      title={`${described(state)}. ${selected === state.id ? 'Show all alarms' : 'Show only its alarms'}`}
      onclick={() => select(selected === state.id ? null : state.id)}
    >
      <span class="label">{systems[at]!.label}</span>
      <span class="counts">
        {#if type !== null}
          <obc-badge type={type} number={state.active} size="regular" variant={state.unacknowledged > 0 ? 'default' : 'flat'}></obc-badge>
          {#if state.trip}<span class="tag">TRIP</span>{/if}
          {#if state.firstOut}<span class="tag">1st</span>{/if}
        {/if}
      </span>
    </button>
  {/each}
</div>

<style>
  .tiles { display: grid; flex: none; }
  /* The bar and padding are the inset the server leaves the name (composedDisplayLayout.annunciatorTile). */
  .tile { box-sizing: border-box; display: flex; flex-direction: column; justify-content: center; gap: 2px; min-width: 0; padding: 2px 6px 2px 6px; border: none; border-left: 4px solid transparent; border-radius: 3px; background: var(--container-section-color); text-align: left; cursor: pointer; }
  .tile.alert-alarm { border-left-color: var(--alert-alarm-color); }
  .tile.alert-warning { border-left-color: var(--alert-warning-color); }
  .tile.alert-caution { border-left-color: var(--alert-caution-color); }
  .tile.selected { outline: 2px solid var(--border-focus-color); outline-offset: -2px; }
  .tile:focus-visible { outline: 2px solid var(--border-focus-color); outline-offset: 1px; }
  .label { font: 370 12px/16px "Noto Sans", system-ui, sans-serif; color: var(--element-neutral-color); white-space: nowrap; }
  .tile:not(.alert-alarm):not(.alert-warning):not(.alert-caution) .label { color: var(--element-inactive-color, var(--element-neutral-color)); }
  .tile[class*='alert-'] .label { color: var(--element-active-color); }
  .counts { display: flex; align-items: center; gap: 6px; height: 16px; }
  .tag { font-size: 10.5px; font-weight: 700; letter-spacing: 0.03em; color: var(--element-active-color); }
</style>
