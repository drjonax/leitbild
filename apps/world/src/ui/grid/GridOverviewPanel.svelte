<script lang="ts">
  import { Activity, ListTree, X } from 'lucide-svelte'
  import type { OperationalObject, SimulationRunId } from '../../core/model/index.ts'
  import { parseElectricGridObjectData } from '../../packs/electric-grid/model.ts'
  import { querySimulationRunCapability } from '../simulation-run-client.ts'
  import { runOnMount } from '../svelte-lifecycle.svelte.ts'
  import GridAssetBrowser from './GridAssetBrowser.svelte'

  type MapTarget =
    | { readonly kind: 'point'; readonly center: readonly [number, number] }
    | { readonly kind: 'bounds'; readonly bounds: readonly [readonly [number, number], readonly [number, number]] }

  interface Props {
    readonly simulationRunId: SimulationRunId
    readonly objects: ReadonlyArray<OperationalObject>
    readonly onClose: () => void
    readonly onFocusMap?: (target: MapTarget) => void
  }

  const { simulationRunId, objects, onClose, onFocusMap = () => undefined }: Props = $props()

  interface GridOverviewSummary {
    readonly gridId: string
    readonly model: { readonly title: string }
    readonly projection: {
      readonly frequencyHz: number
      readonly totalGenerationMw: number
      readonly servedLoadMw: number
      readonly reserveMarginMw: number
      readonly lowestVoltagePu: number
    }
    readonly constrainedBranches: ReadonlyArray<{ readonly id: string; readonly label: string; readonly state: { readonly loadingPercent: number } }>
    readonly generators: ReadonlyArray<{ readonly id: string; readonly label: string; readonly state: { readonly dispatchMw: number } }>
    readonly affectedLoads: ReadonlyArray<{ readonly id: string; readonly label: string; readonly state: { readonly shedMw: number; readonly serviceState: string } }>
  }

  interface PanelFrame {
    readonly left: number
    readonly top: number
    readonly width: number
    readonly height: number
  }

  interface PanelGesture {
    readonly mode: 'move' | 'resize'
    readonly pointerId: number
    readonly startX: number
    readonly startY: number
    readonly startFrame: PanelFrame
  }

  const storageKey = 'leitbild:grid-overview-panel-frame:v1'
  const marginPx = 12
  const minWidthPx = 360
  const minHeightPx = 260

  let panelElement = $state<HTMLElement | null>(null)
  let frame = $state<PanelFrame | null>(null)
  let gesture = $state<PanelGesture | null>(null)
  let summary = $state<GridOverviewSummary | null>(null)
  let queryError = $state<string | null>(null)
  let selectedGridId = $state<string | null>(null)
  let view = $state<'summary' | 'assets'>('summary')
  let summarySequence = 0

  const gridItems = $derived(objects.flatMap(object => {
    const data = parseElectricGridObjectData(object)
    return data ? [{ object, data }] : []
  }))
  const gridId = $derived(gridItems.some(item => item.object.id === selectedGridId) ? selectedGridId : gridItems[0]?.object.id ?? null)
  const selectedGridItem = $derived(gridItems.find(item => item.object.id === gridId) ?? gridItems[0])
  const system = $derived(summary?.projection ?? selectedGridItem?.data.projection)
  const branches = $derived(summary?.constrainedBranches ?? [])
  const generators = $derived(summary?.generators ?? [])
  const loads = $derived(summary?.affectedLoads ?? [])

  const frequencyClass = $derived(!system
    ? 'idle'
    : system.frequencyHz < 49.85 || system.frequencyHz > 50.15
      ? 'alert'
      : system.frequencyHz < 49.95 || system.frequencyHz > 50.05
        ? 'watch'
        : 'normal')

  const mw = (value: number): string =>
    value.toLocaleString(undefined, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    })

  const parentSize = (): { readonly width: number; readonly height: number } => {
    const rect = panelElement?.parentElement?.getBoundingClientRect()
    return {
      width: rect?.width ?? window.innerWidth,
      height: rect?.height ?? window.innerHeight,
    }
  }

  const clampFrame = (candidate: PanelFrame): PanelFrame => {
    const size = parentSize()
    const maxWidth = Math.max(minWidthPx, size.width - marginPx * 2)
    const maxHeight = Math.max(minHeightPx, size.height - marginPx * 2)
    const width = Math.min(maxWidth, Math.max(minWidthPx, candidate.width))
    const height = Math.min(maxHeight, Math.max(minHeightPx, candidate.height))
    return {
      left: Math.min(Math.max(marginPx, candidate.left), Math.max(marginPx, size.width - width - marginPx)),
      top: Math.min(Math.max(marginPx, candidate.top), Math.max(marginPx, size.height - height - marginPx)),
      width,
      height,
    }
  }

  const defaultFrame = (): PanelFrame => {
    const size = parentSize()
    const width = Math.min(500, Math.max(minWidthPx, size.width * 0.34))
    const height = Math.min(760, Math.max(420, size.height - 36))
    return clampFrame({
      left: Math.max(marginPx, size.width - width - 18),
      top: 18,
      width,
      height,
    })
  }

  const storedFrame = (): PanelFrame | null => {
    try {
      const raw = localStorage.getItem(storageKey)
      if (!raw) return null
      const parsed = JSON.parse(raw) as Partial<PanelFrame>
      if (
        typeof parsed.left !== 'number'
        || typeof parsed.top !== 'number'
        || typeof parsed.width !== 'number'
        || typeof parsed.height !== 'number'
      ) return null
      return clampFrame(parsed as PanelFrame)
    } catch {
      // Local storage is optional UI state; stale/corrupt frames are discarded.
      return null
    }
  }

  const persistFrame = (next: PanelFrame): void => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(next))
    } catch {
      // Local storage is optional UI state; losing it must not affect operation.
    }
  }

  const applyFrame = (next: PanelFrame): PanelFrame => {
    const clamped = clampFrame(next)
    frame = clamped
    return clamped
  }

  // A pointer gesture persists its frame once, when it ends; keyboard steps are discrete moves.
  const applyAndPersistFrame = (next: PanelFrame): void => {
    persistFrame(applyFrame(next))
  }

  const ensureFrame = (): void => {
    frame = storedFrame() ?? defaultFrame()
  }

  const startGesture = (event: PointerEvent, mode: PanelGesture['mode']): void => {
    if (!frame || !panelElement) return
    event.preventDefault()
    panelElement.setPointerCapture(event.pointerId)
    gesture = {
      mode,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startFrame: frame,
    }
  }

  const moveGesture = (event: PointerEvent): void => {
    if (!gesture || event.pointerId !== gesture.pointerId) return
    const dx = event.clientX - gesture.startX
    const dy = event.clientY - gesture.startY
    if (gesture.mode === 'move') {
      applyFrame({
        ...gesture.startFrame,
        left: gesture.startFrame.left + dx,
        top: gesture.startFrame.top + dy,
      })
      return
    }
    applyFrame({
      ...gesture.startFrame,
      width: gesture.startFrame.width + dx,
      height: gesture.startFrame.height + dy,
    })
  }

  const stopGesture = (event: PointerEvent): void => {
    if (!gesture || event.pointerId !== gesture.pointerId) return
    panelElement?.releasePointerCapture(event.pointerId)
    gesture = null
    if (frame) persistFrame(frame)
  }

  const moveFrameByKeyboard = (event: KeyboardEvent): void => {
    if (!frame) return
    const step = event.shiftKey ? 40 : 12
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      applyAndPersistFrame({ ...frame, left: frame.left - step })
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      applyAndPersistFrame({ ...frame, left: frame.left + step })
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      applyAndPersistFrame({ ...frame, top: frame.top - step })
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      applyAndPersistFrame({ ...frame, top: frame.top + step })
    }
  }

  const panelStyle = $derived(frame
    ? `left: ${frame.left}px; top: ${frame.top}px; width: ${frame.width}px; height: ${frame.height}px;`
    : '')

  const chooseGrid = (nextGridId: string): void => {
    selectedGridId = nextGridId
    summary = null
    queryError = null
  }

  const loadSummary = async (): Promise<void> => {
    const requestedGridId = gridId
    if (!requestedGridId) return
    const sequence = ++summarySequence
    try {
      const result = await querySimulationRunCapability<GridOverviewSummary>(
        simulationRunId,
        'world.electric-grid.grid.summary',
        { gridId: requestedGridId },
      )
      if (sequence !== summarySequence || gridId !== requestedGridId) return
      summary = result
      queryError = null
    } catch (error) {
      if (sequence === summarySequence && gridId === requestedGridId) {
        queryError = error instanceof Error ? error.message : String(error)
      }
    }
  }

  $effect(() => {
    selectedGridItem?.object.revision
    void loadSummary()
  })

  runOnMount(() => {
    ensureFrame()
    const parent = panelElement?.parentElement
    if (!parent) return
    const observer = new ResizeObserver(() => {
      frame = clampFrame(frame ?? defaultFrame())
    })
    observer.observe(parent)
    return () => {
      summarySequence += 1
      observer.disconnect()
    }
  })
</script>

{#if system}
  <section
    bind:this={panelElement}
    class="grid-overview"
    aria-label="Electric grid overview"
    style={panelStyle}
    onpointermove={moveGesture}
    onpointerup={stopGesture}
    onpointercancel={stopGesture}
  >
    <header class="overview-titlebar">
      <div
        class="overview-drag-handle"
        role="button"
        tabindex="0"
        aria-label="Move grid overview panel"
        onpointerdown={(event) => startGesture(event, 'move')}
        onkeydown={moveFrameByKeyboard}
      >
        <div>
          <p class="eyebrow">Electric grid</p>
          <h2>{summary?.model.title ?? selectedGridItem?.object.label ?? 'Grid overview'}</h2>
        </div>
        <div class="frequency" class:alert={frequencyClass === 'alert'} class:watch={frequencyClass === 'watch'}>
          <span>{system.frequencyHz.toFixed(3)}</span>
          <small>Hz</small>
        </div>
      </div>
      <button
        class="close-button"
        type="button"
        aria-label="Close grid overview panel"
        title="Close grid overview panel"
        onpointerdown={(event) => event.stopPropagation()}
        onclick={(event) => {
          event.stopPropagation()
          onClose()
        }}
      >
        <X size={17} strokeWidth={1.9} />
      </button>
    </header>

    <div class="panel-navigation">
      <div class="view-tabs" role="tablist" aria-label="Grid panel view">
        <button type="button" class:active={view === 'summary'} onclick={() => { view = 'summary' }}><Activity size={13} />Overview</button>
        <button type="button" class:active={view === 'assets'} onclick={() => { view = 'assets' }}><ListTree size={13} />Assets</button>
      </div>
      {#if gridItems.length > 1}
        <label>Grid
          <select value={gridId ?? ''} onchange={(event) => chooseGrid(event.currentTarget.value)}>
            {#each gridItems as item}<option value={item.object.id}>{item.object.label}</option>{/each}
          </select>
        </label>
      {/if}
    </div>

    {#if view === 'summary'}
      <div class="summary-view">
        <div class="metric-grid">
          <div class="metric">
            <span>Generation</span>
            <strong>{mw(system.totalGenerationMw)} MW</strong>
          </div>
          <div class="metric">
            <span>Served load</span>
            <strong>{mw(system.servedLoadMw)} MW</strong>
          </div>
          <div class="metric">
            <span>Reserve</span>
            <strong>{mw(system.reserveMarginMw)} MW</strong>
          </div>
          <div class="metric">
            <span>Lowest voltage</span>
            <strong>{system.lowestVoltagePu.toFixed(3)} pu</strong>
          </div>
        </div>

        <div class="split">
          <div>
            <h3>Constrained corridors</h3>
            {#each branches as branch}
              <div class="row">
                <span>{branch.label}</span>
                <strong>{Math.round(branch.state.loadingPercent)}%</strong>
              </div>
            {/each}
          </div>
          <div>
            <h3>Generation stack</h3>
            {#each generators as generator}
              <div class="row">
                <span>{generator.label}</span>
                <strong>{mw(generator.state.dispatchMw)} MW</strong>
              </div>
            {/each}
          </div>
        </div>

        <div class="supply">
          <h3>Consumer supply</h3>
          {#each loads as load}
            <div class="row" class:problem={load.state.serviceState !== 'normal'}>
              <span>{load.label}</span>
              <strong>{Math.round(load.state.shedMw)} MW shed</strong>
            </div>
          {/each}
        </div>
      </div>
    {:else if gridId}
      {#key gridId}
        <GridAssetBrowser {simulationRunId} {gridId} refreshRevision={selectedGridItem?.object.revision ?? 0} {onFocusMap} />
      {/key}
    {/if}
    {#if queryError}<p class="query-error">{queryError}</p>{/if}
    <button
      class="resize-grip"
      type="button"
      aria-label="Resize grid overview panel"
      title="Resize grid overview panel"
      onpointerdown={(event) => startGesture(event, 'resize')}
    ></button>
  </section>
{/if}

<style>
  .grid-overview {
    position: absolute;
    z-index: 12;
    display: flex;
    overflow: hidden;
    flex-direction: column;
    /* Opaque theme surface: a backdrop blur over the live map is recomputed on every map frame. */
    color: var(--text);
    background: var(--panel);
    border: 1px solid var(--border);
    box-shadow: 0 18px 44px rgba(15, 23, 42, 0.18);
    border-radius: 6px;
    padding: 16px;
    box-sizing: border-box;
    min-width: 360px;
    min-height: 260px;
  }

  .panel-navigation {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 10px;
  }

  .view-tabs { display: flex; gap: 5px; }
  .view-tabs button { display: inline-flex; align-items: center; gap: 5px; padding: 5px 8px; color: inherit; border: 1px solid rgba(148, 163, 184, .4); border-radius: 5px; background: transparent; cursor: pointer; font-size: 11px; }
  .view-tabs button.active { border-color: #3b82f6; background: rgba(59, 130, 246, .12); }
  .panel-navigation label { display: flex; align-items: center; gap: 5px; color: #64748b; font-size: 10px; }
  .panel-navigation select { max-width: 180px; padding: 4px 6px; color: inherit; border: 1px solid rgba(148, 163, 184, .4); border-radius: 4px; background: transparent; font: inherit; }
  .summary-view { min-height: 0; overflow: auto; }

  .overview-titlebar {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 14px;
  }

  .overview-drag-handle {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 18px;
    cursor: grab;
    touch-action: none;
    user-select: none;
  }

  .overview-drag-handle:active {
    cursor: grabbing;
  }

  .close-button {
    display: inline-grid;
    place-items: center;
    flex: 0 0 auto;
    width: 28px;
    height: 28px;
    border: 1px solid transparent;
    border-radius: 4px;
    color: #64748b;
    background: transparent;
    cursor: pointer;
  }

  .close-button:hover,
  .close-button:focus-visible {
    color: #0f172a;
    background: rgba(148, 163, 184, 0.14);
    border-color: rgba(148, 163, 184, 0.28);
    outline: none;
  }

  :global(.dark) .close-button {
    color: #94a3b8;
  }

  :global(.dark) .close-button:hover,
  :global(.dark) .close-button:focus-visible {
    color: #f8fafc;
    background: rgba(148, 163, 184, 0.16);
  }

  .eyebrow {
    margin: 0 0 3px;
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0;
    text-transform: uppercase;
    color: #64748b;
  }

  h2, h3 {
    margin: 0;
    letter-spacing: 0;
  }

  h2 {
    font-size: 19px;
    line-height: 1.15;
  }

  h3 {
    font-size: 12px;
    text-transform: uppercase;
    color: #475569;
    margin-bottom: 8px;
  }

  :global(.dark) h3,
  :global(.dark) .eyebrow {
    color: #94a3b8;
  }

  .frequency {
    min-width: 108px;
    text-align: right;
    color: #047857;
  }

  .frequency.watch {
    color: #b45309;
  }

  .frequency.alert {
    color: #dc2626;
  }

  .frequency span {
    display: block;
    font-size: 32px;
    line-height: 0.95;
    font-weight: 800;
  }

  .frequency small {
    font-weight: 800;
    font-size: 12px;
  }

  .metric-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
    margin-bottom: 14px;
  }

  .metric {
    border: 1px solid rgba(148, 163, 184, 0.35);
    border-radius: 4px;
    padding: 8px;
    min-width: 0;
  }

  .metric span,
  .row span {
    display: block;
    font-size: 11px;
    color: #64748b;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  :global(.dark) .metric span,
  :global(.dark) .row span {
    color: #94a3b8;
  }

  .metric strong {
    display: block;
    margin-top: 4px;
    font-size: 13px;
  }

  .split {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
    margin-bottom: 14px;
  }

  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
    align-items: baseline;
    padding: 5px 0;
    border-top: 1px solid rgba(148, 163, 184, 0.22);
  }

  .row strong {
    font-size: 12px;
  }

  .row.problem strong {
    color: #dc2626;
  }

  .resize-grip {
    position: absolute;
    right: 4px;
    bottom: 4px;
    width: 20px;
    height: 20px;
    border: 0;
    border-radius: 3px;
    background:
      linear-gradient(135deg, transparent 48%, rgba(100, 116, 139, 0.75) 50%, transparent 52%) 5px 11px / 10px 10px no-repeat,
      linear-gradient(135deg, transparent 48%, rgba(100, 116, 139, 0.55) 50%, transparent 52%) 10px 6px / 10px 10px no-repeat;
    cursor: nwse-resize;
    touch-action: none;
  }

  .resize-grip:hover,
  .resize-grip:focus-visible {
    outline: none;
    background-color: rgba(37, 99, 235, 0.08);
  }

  @media (max-width: 900px) {
    .grid-overview {
      left: 12px;
      top: 12px;
      width: calc(100vw - 24px);
      height: min(70vh, 640px);
      min-width: 0;
    }

    .metric-grid,
    .split {
      grid-template-columns: 1fr 1fr;
    }
  }
</style>
