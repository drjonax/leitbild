<script module lang="ts">
  export type PlantCardAction =
    | 'overview'
    | 'procedures'
    | 'instructor'
    | 'assistant'
    | 'component-graph'
    | 'specification'
    | 'credibility'
    | 'catalog'
</script>

<script lang="ts">
  import { tick } from 'svelte'
  import { ChevronRight, ClipboardList, Ellipsis, FileText, GitBranch, Library, MonitorCog, ShieldCheck, Sparkles, X, Zap } from 'lucide-svelte'
  import StatusDot from '../components/StatusDot.svelte'
  import {
    dockObjectCard,
    placeObjectCard,
    type MapCardFrame,
    type ObjectCardPlacement,
    type ScreenRect,
  } from '../map/object-card-anchor.ts'
  import type { PlantCardView } from './plant-card.ts'

  // A Plant's card on the map: the unit at a glance, and what to open next.
  // It stands beside the unit's icon, never over the map's other units where
  // it can help it, and it is not modal: the map stays live around it. Esc
  // closes it only while focus is inside it, so it never closes a window the
  // reader opened above it.

  interface Props {
    readonly view: PlantCardView
    /** Which unit the card shows: a new one takes focus again. */
    readonly objectId: string
    readonly frame: MapCardFrame | null
    /** Whether this screen may order the Plant: only then does it offer Instructor actions. */
    readonly instructorOffered: boolean
    /** Whether the Host offers the Run's Assistant room on this page. */
    readonly assistantOffered: boolean
    /** Whether the Plant's specification, component graph and credibility evidence can be opened. */
    readonly engineeringOffered: boolean
    readonly onAction: (action: PlantCardAction) => void
    readonly onClose: () => void
  }

  let { view, objectId, frame, instructorOffered, assistantOffered, engineeringOffered, onAction, onClose }: Props = $props()

  const cardWidth = 300
  let section = $state<HTMLElement | null>(null)
  let cardHeight = $state(230)
  let moreOpen = $state(false)
  let focusedFor: string | null = null

  // Things already standing in the map's corner the card docks in, such as the scenario guidance.
  const occupiedCorner = (origin: MapCardFrame['origin']): ReadonlyArray<ScreenRect> =>
    [...document.querySelectorAll('.scenario-guidance')].map(element => {
      const rect = element.getBoundingClientRect()
      return { left: rect.left - origin.x, top: rect.top - origin.y, right: rect.right - origin.x, bottom: rect.bottom - origin.y }
    })

  const placement = $derived.by<ObjectCardPlacement | null>(() => {
    if (frame === null) return null
    return frame.anchor === null
      ? dockObjectCard(frame.clear, occupiedCorner(frame.origin), { width: cardWidth, height: cardHeight })
      : placeObjectCard(frame.anchor, { width: cardWidth, height: cardHeight })
  })

  // Focus moves in once the card stands on the map (a hidden card takes none), and again for another unit.
  $effect(() => {
    if (placement === null || section === null || objectId === focusedFor) return
    focusedFor = objectId
    moreOpen = false
    void tick().then(() => section?.focus({ preventScroll: true }))
  })

  const act = (action: PlantCardAction): void => {
    moreOpen = false
    onAction(action)
  }

  const handleKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    if (moreOpen) {
      moreOpen = false
      return
    }
    onClose()
  }
</script>

<div
  bind:this={section}
  bind:clientHeight={cardHeight}
  class="plant-card"
  class:placed={placement !== null}
  data-side={placement?.side ?? 'none'}
  style:left={placement === null || frame === null ? null : `${frame.origin.x + placement.left}px`}
  style:top={placement === null || frame === null ? null : `${frame.origin.y + placement.top}px`}
  style:width={`${cardWidth}px`}
  role="dialog"
  aria-modal="false"
  aria-labelledby="plant-card-name"
  tabindex="-1"
  onkeydown={handleKeydown}
>
  <header class="plant-card-header">
    <StatusDot tone={view.tone} label={view.statusLabel} />
    <div class="plant-card-title" aria-live="polite">
      <h2 id="plant-card-name">{view.name}</h2>
      {#if view.mode !== null}<span class="plant-card-mode">{view.mode}</span>{/if}
    </div>
    {#if view.chip !== null}
      <span
        class="plant-card-chip"
        class:tripped={view.chip === 'Tripped'}
        title={view.chip === 'Tripped' ? 'A reactor trip is active' : 'The Plant runtime has not started yet'}
      >{view.chip}</span>
    {/if}
    <button type="button" class="plant-card-close" aria-label="Close {view.name}" title="Close" onclick={onClose}>
      <X size={16} />
    </button>
  </header>
  {#if view.energy !== null}
    <p class="plant-card-energy">{view.energy}</p>
  {/if}

  <div class="plant-card-rows">
    <button type="button" class="plant-card-row" onclick={() => act('overview')} title="Open the unit overview display">
      <MonitorCog size={18} strokeWidth={1.8} />
      <span class="plant-card-label">Overview</span>
      <span class="plant-card-state">
        {#if view.alarms !== null}
          {#if view.alarms.severity !== null}<span class="plant-card-severity {view.alarms.severity}" aria-hidden="true"></span>{/if}
          {view.alarms.text}
        {/if}
      </span>
      <ChevronRight size={14} class="plant-card-chevron" />
    </button>
    <button type="button" class="plant-card-row" onclick={() => act('procedures')} title={view.procedure.title ?? 'Open the procedures of this unit'}>
      <ClipboardList size={18} strokeWidth={1.8} />
      <span class="plant-card-label">Procedures</span>
      <span class="plant-card-state">
        {view.procedure.text}{#if view.procedure.drivenByAi}<span class="plant-card-ai" title="Driven by AI">AI</span>{/if}
      </span>
      <ChevronRight size={14} class="plant-card-chevron" />
    </button>
    {#if instructorOffered}
      <button type="button" class="plant-card-row" onclick={() => act('instructor')} title="Instructor actions: start a scenario event or a fault on this unit">
        <Zap size={18} strokeWidth={1.8} />
        <span class="plant-card-label">Instructor</span>
        <span class="plant-card-state muted">Inject a fault or event</span>
        <ChevronRight size={14} class="plant-card-chevron" />
      </button>
    {/if}
  </div>

  <footer class="plant-card-footer">
    {#if assistantOffered}
      <button type="button" class="plant-card-tool" onclick={() => act('assistant')} title="Open the Run's Assistant room">
        <Sparkles size={16} strokeWidth={1.8} />
        <span>Assistant</span>
      </button>
    {/if}
    <div class="plant-card-more">
      <button
        type="button"
        class="plant-card-tool"
        aria-haspopup="menu"
        aria-expanded={moreOpen}
        onclick={() => { moreOpen = !moreOpen }}
        title="More about this unit"
      >
        <Ellipsis size={16} strokeWidth={1.8} />
        <span>More</span>
      </button>
      {#if moreOpen}
        <div class="plant-card-menu" role="menu">
          {#if engineeringOffered}
            <button type="button" role="menuitem" onclick={() => act('component-graph')}><GitBranch size={15} /> Component graph</button>
            <button type="button" role="menuitem" onclick={() => act('specification')}><FileText size={15} /> Plant specification</button>
            <button type="button" role="menuitem" onclick={() => act('credibility')}><ShieldCheck size={15} /> Model credibility</button>
            <hr />
          {/if}
          <button type="button" role="menuitem" onclick={() => act('catalog')}><Library size={15} /> Plant catalog</button>
        </div>
      {/if}
    </div>
  </footer>
</div>

<style>
  .plant-card {
    position: fixed;
    z-index: 28;
    display: flex;
    flex-direction: column;
    max-width: calc(100vw - 16px);
    color: var(--text);
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 12px 32px rgba(8, 14, 24, 0.32);
    font-size: 13px;
    visibility: hidden;
  }
  .plant-card.placed { visibility: visible; }
  .plant-card:focus { outline: none; }
  .plant-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  .plant-card-header {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto auto;
    align-items: center;
    column-gap: 8px;
    padding: 10px 8px 2px 12px;
  }
  .plant-card-title { min-width: 0; display: flex; flex-direction: column; }
  .plant-card-title h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 650;
    line-height: 1.25;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .plant-card-mode { color: var(--muted); font-size: 12px; line-height: 1.3; }
  .plant-card-chip {
    padding: 2px 7px;
    border-radius: 999px;
    border: 1px solid var(--border);
    color: var(--muted);
    font-size: 11px;
    font-weight: 650;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .plant-card-chip.tripped { color: #fff; background: var(--critical); border-color: var(--critical); }
  .plant-card-close {
    display: inline-grid;
    place-items: center;
    width: 28px;
    height: 28px;
    padding: 0;
    color: var(--muted);
    background: transparent;
    border: 0;
    border-radius: 6px;
    cursor: pointer;
  }
  .plant-card-close:hover { color: var(--text); background: color-mix(in srgb, var(--accent) 8%, transparent); }

  .plant-card-energy {
    margin: 4px 12px 0 30px;
    color: var(--text);
    font-size: 12px;
    line-height: 1.4;
    font-variant-numeric: tabular-nums;
  }

  .plant-card-rows {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin-top: 8px;
    padding: 4px;
    border-top: 1px solid var(--border);
  }
  .plant-card-row {
    display: grid;
    grid-template-columns: 18px 84px minmax(0, 1fr) 14px;
    align-items: center;
    column-gap: 10px;
    min-height: 36px;
    padding: 0 10px;
    color: var(--text);
    text-align: left;
    background: transparent;
    border: 0;
    border-radius: 6px;
    cursor: pointer;
    font: inherit;
  }
  .plant-card-row:hover, .plant-card-row:focus-visible { background: color-mix(in srgb, var(--accent) 8%, transparent); }
  .plant-card-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .plant-card-label { font-size: 13px; font-weight: 600; }
  .plant-card-state {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .plant-card-state.muted { color: var(--muted); }
  .plant-card-row :global(.plant-card-chevron) { color: var(--muted); }
  .plant-card-severity { flex: 0 0 auto; width: 7px; height: 7px; border-radius: 999px; background: var(--accent); }
  .plant-card-severity.critical { background: var(--critical); }
  .plant-card-severity.warning { background: var(--warning); }
  .plant-card-ai {
    padding: 0 4px;
    border-radius: 4px;
    color: var(--accent);
    border: 1px solid color-mix(in srgb, var(--accent) 50%, transparent);
    font-size: 10px;
    font-weight: 650;
  }

  .plant-card-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 4px;
    border-top: 1px solid var(--border);
  }
  .plant-card-more { position: relative; margin-left: auto; }
  .plant-card-tool {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 34px;
    padding: 0 10px;
    color: var(--text);
    background: transparent;
    border: 0;
    border-radius: 6px;
    cursor: pointer;
    font: inherit;
    font-size: 13px;
    font-weight: 600;
  }
  .plant-card-tool:hover, .plant-card-tool:focus-visible, .plant-card-tool[aria-expanded='true'] { background: color-mix(in srgb, var(--accent) 8%, transparent); }
  .plant-card-menu {
    position: absolute;
    right: 0;
    bottom: calc(100% + 4px);
    z-index: 1;
    display: flex;
    flex-direction: column;
    width: 210px;
    padding: 4px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 10px 24px rgba(8, 14, 24, 0.28);
  }
  .plant-card-menu button {
    display: flex;
    align-items: center;
    gap: 9px;
    min-height: 36px;
    padding: 0 10px;
    color: var(--text);
    text-align: left;
    background: transparent;
    border: 0;
    border-radius: 6px;
    cursor: pointer;
    font: inherit;
    font-size: 13px;
  }
  .plant-card-menu button:hover, .plant-card-menu button:focus-visible { background: color-mix(in srgb, var(--accent) 8%, transparent); }
  .plant-card-menu hr { width: 100%; margin: 4px 0; border: 0; border-top: 1px solid var(--border); }

  @media (pointer: coarse) {
    .plant-card-row, .plant-card-menu button { min-height: 44px; }
    .plant-card-tool, .plant-card-close { min-height: 44px; }
    .plant-card-close { width: 44px; }
  }
</style>
