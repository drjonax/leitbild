<script lang="ts">
  import { Activity, Bell, ListTree, LocateFixed, ShieldAlert, X } from 'lucide-svelte'
  import { untrack } from 'svelte'
  import type { OperationalObject, SimulationRunId } from '../../core/model/index.ts'
  import { parseElectricGridObjectData } from '../../packs/electric-grid/model.ts'
  import type { GridIslandsResult } from '../../packs/electric-grid/queries/islands.ts'
  import { gridAssetItemId, parseGridAssetItemId } from '../../packs/electric-grid/ui/grid-live-layer.ts'
  import { gridCount, gridLocalTimeZone } from '../../packs/electric-grid/ui/operator-alarms.ts'
  import { querySimulationRunCapability } from '../simulation-run-client.ts'
  import { runOnMount } from '../svelte-lifecycle.svelte.ts'
  import GridAlarmList from './GridAlarmList.svelte'
  import GridAssetBrowser from './GridAssetBrowser.svelte'
  import GridContingencyView from './GridContingencyView.svelte'
  import GridLfddStages from './GridLfddStages.svelte'
  import type { MapCover } from '../surface-panel-contract.ts'
  import { gridPanelMapCover } from './panel-cover.ts'

  type MapTarget =
    | { readonly kind: 'point'; readonly center: readonly [number, number] }
    | { readonly kind: 'bounds'; readonly bounds: readonly [readonly [number, number], readonly [number, number]] }

  interface Props {
    readonly simulationRunId: SimulationRunId
    readonly objects: ReadonlyArray<OperationalObject>
    readonly onClose: () => void
    readonly onFocusMap?: (target: MapTarget) => void
    /** `<gridId>#<assetId>` selected on the map or in this panel. */
    readonly selectedItemId?: string | null
    readonly onSelectItem?: (itemId: string | null) => void
    /** The surface keeps the map camera and the alarm strip clear of what this panel covers. */
    readonly onMapCover: (cover: MapCover) => void
  }

  const { simulationRunId, objects, onClose, onFocusMap = () => undefined, selectedItemId = null, onSelectItem = () => undefined, onMapCover }: Props = $props()

  interface GridOverviewSummary {
    readonly gridId: string
    readonly model: { readonly title: string }
    readonly projection: {
      readonly frequencyHz: number | null
      readonly totalGenerationMw: number
      readonly servedLoadMw: number
      readonly reserveMarginMw: number
      readonly voltageModel: 'ac-fdlf'
      readonly voltageMinPu: number | null
      readonly voltageMaxPu: number | null
      readonly statusLabel: string
      readonly activeAlarmCount: number
      readonly islands: ReadonlyArray<{ readonly id: string; readonly energized: boolean; readonly loadMw: number; readonly alarmCount: number }>
    }
    readonly thresholds: { readonly constrainedBranchLoadingPercent: number; readonly overloadLoadingPercent: number }
    readonly constrainedBranchCount: number
    readonly constrainedBranches: ReadonlyArray<{ readonly id: string; readonly label: string; readonly state: { readonly loadingPercent: number } }>
    readonly generators: ReadonlyArray<{ readonly id: string; readonly label: string; readonly state: { readonly dispatchMw: number } }>
    readonly affectedLoadCount: number
    readonly affectedLoads: ReadonlyArray<{ readonly id: string; readonly label: string; readonly state: { readonly unservedMw: number; readonly shedMw: number; readonly serviceState: string } }>
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
  let islands = $state<GridIslandsResult | null>(null)
  let queryError = $state<string | null>(null)
  let selectedGridId = $state<string | null>(null)
  let selectedAssetId = $state<string | null>(null)
  let view = $state<'summary' | 'alarms' | 'contingency' | 'assets'>('summary')
  let summarySequence = 0
  // The last selection this panel applied or reported, so its own report does not re-apply.
  let appliedItemId: string | null = null

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
  // Island alarms as the runtime projection counts them: a de-energised island with demand, or an energised one off the standard frequency range or shedding load.
  const deenergizedIslandCount = $derived(system?.islands.filter(island => !island.energized && island.alarmCount > 0).length ?? 0)
  const frequencyAlarmIslandCount = $derived(system?.islands.filter(island => island.energized && island.alarmCount > 0).length ?? 0)

  const frequencyClass = $derived(!system
    ? 'idle'
    : system.frequencyHz === null
      ? 'alert'
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

  // The panel is drawn only once its Grid's summary arrives; until then it covers nothing.
  $effect(() => {
    const cover = gridPanelMapCover(panelElement === null ? null : frame, parentSize().width)
    untrack(() => onMapCover(cover))
  })

  const panelStyle = $derived(frame
    ? `left: ${frame.left}px; top: ${frame.top}px; width: ${frame.width}px; height: ${frame.height}px;`
    : '')

  const chooseGrid = (nextGridId: string): void => {
    if (selectedGridId === nextGridId) return
    selectedGridId = nextGridId
    selectedAssetId = null
    summary = null
    islands = null
    queryError = null
  }

  /** Selects an asset here and on the map; opening it shows its detail in the Assets view. */
  const selectAsset = (assetId: string | null, open: boolean): void => {
    selectedAssetId = assetId
    if (assetId !== null && open) view = 'assets'
    const itemId = assetId === null || gridId === null ? null : gridAssetItemId(gridId, assetId)
    appliedItemId = itemId
    onSelectItem(itemId)
  }

  /** Highlights an asset on the map and flies to it, staying in the current view. */
  const locateAsset = async (assetId: string): Promise<void> => {
    const requestedGridId = gridId
    if (!requestedGridId) return
    selectAsset(assetId, false)
    try {
      const result = await querySimulationRunCapability<{ readonly asset: { readonly mapTarget?: MapTarget } }>(
        simulationRunId,
        'world.electric-grid.asset.get',
        { gridId: requestedGridId, assetId },
      )
      if (result.asset.mapTarget) onFocusMap(result.asset.mapTarget)
      else queryError = `${assetId} has no map position`
    } catch (error) {
      queryError = error instanceof Error ? error.message : String(error)
    }
  }

  $effect(() => {
    const itemId = selectedItemId
    untrack(() => {
      if (itemId === appliedItemId) return
      appliedItemId = itemId
      if (itemId === null) {
        selectedAssetId = null
        return
      }
      const item = parseGridAssetItemId(itemId)
      if (!gridItems.some(candidate => candidate.object.id === item.gridId)) {
        queryError = `Selected Grid ${item.gridId} is not in this Run`
        return
      }
      chooseGrid(item.gridId)
      selectedAssetId = item.assetId
      view = 'assets'
    })
  })

  const loadSummary = async (): Promise<void> => {
    const requestedGridId = gridId
    if (!requestedGridId) return
    const sequence = ++summarySequence
    try {
      const [result, islandResult] = await Promise.all([
        querySimulationRunCapability<GridOverviewSummary>(simulationRunId, 'world.electric-grid.grid.summary', { gridId: requestedGridId }),
        querySimulationRunCapability<GridIslandsResult>(simulationRunId, 'world.electric-grid.islands.list', { gridId: requestedGridId, limit: 20 }),
      ])
      if (sequence !== summarySequence || gridId !== requestedGridId) return
      summary = result
      islands = islandResult
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
        <div class="frequency" class:alert={frequencyClass === 'alert'} class:watch={frequencyClass === 'watch'} title="Frequency of the largest connected part of the grid">
          <span>{system.frequencyHz === null ? 'De-energised' : system.frequencyHz.toFixed(3)}</span>
          <small>{system.frequencyHz === null ? '' : 'Hz · grid frequency'}</small>
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
        <button type="button" role="tab" aria-selected={view === 'summary'} class:active={view === 'summary'} onclick={() => { view = 'summary' }}><Activity size={13} />Overview</button>
        <button type="button" role="tab" aria-selected={view === 'alarms'} class:active={view === 'alarms'} onclick={() => { view = 'alarms' }}>
          <Bell size={13} />Alarms{#if system.activeAlarmCount > 0}<span class="badge">{system.activeAlarmCount}</span>{/if}
        </button>
        <button type="button" role="tab" aria-selected={view === 'contingency'} class:active={view === 'contingency'} onclick={() => { view = 'contingency' }}><ShieldAlert size={13} />N-1</button>
        <button type="button" role="tab" aria-selected={view === 'assets'} class:active={view === 'assets'} onclick={() => { view = 'assets' }}><ListTree size={13} />Assets</button>
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
            <span>Voltage (AC)</span>
            <strong>{system.voltageMinPu === null || system.voltageMaxPu === null ? 'No converged island' : `${system.voltageMinPu.toFixed(3)}–${system.voltageMaxPu.toFixed(3)} pu`}</strong>
          </div>
        </div>

        <div class="alarms" class:problem={system.activeAlarmCount > 0}>
          <h3>Alarms</h3>
          {#if system.activeAlarmCount === 0}
            <p class="empty-state">No active alarms.</p>
          {:else}
            <p class="alarm-status">{gridCount(system.activeAlarmCount, 'active alarm', 'active alarms')} <button type="button" class="link-button" onclick={() => { view = 'alarms' }}>Open alarm list</button></p>
            <ul>
              {#if summary && summary.constrainedBranchCount > 0}<li>{gridCount(summary.constrainedBranchCount, 'corridor', 'corridors')} at or above {summary.thresholds.constrainedBranchLoadingPercent}% loading</li>{/if}
              {#if summary && summary.affectedLoadCount > 0}<li>{gridCount(summary.affectedLoadCount, 'load', 'loads')} with unserved demand</li>{/if}
              {#if deenergizedIslandCount > 0}<li>{gridCount(deenergizedIslandCount, 'de-energised island', 'de-energised islands')} with demand</li>{/if}
              {#if frequencyAlarmIslandCount > 0}<li>{gridCount(frequencyAlarmIslandCount, 'energised island', 'energised islands')} with active alarms</li>{/if}
            </ul>
          {/if}
        </div>

        {#snippet assetRow(assetId: string, label: string, value: string, problem: boolean)}
          <div class="row linked" class:problem>
            <button type="button" class="row-select" title="Open {label}" onclick={() => selectAsset(assetId, true)}>
              <span>{label}</span>
              <strong>{value}</strong>
            </button>
            <button type="button" class="row-locate" title="Locate {label} on the map" aria-label="Locate {label} on the map" onclick={() => void locateAsset(assetId)}><LocateFixed size={12} /></button>
          </div>
        {/snippet}

        <div class="split">
          <div>
            <h3>Constrained corridors</h3>
            {#each branches as branch (branch.id)}
              {@render assetRow(branch.id, branch.label, `${Math.round(branch.state.loadingPercent)}%`, summary !== null && branch.state.loadingPercent >= summary.thresholds.overloadLoadingPercent)}
            {:else}
              {#if summary}<p class="empty-state">None at or above {summary.thresholds.constrainedBranchLoadingPercent}% loading.</p>{/if}
            {/each}
          </div>
          <div>
            <h3>Generation stack</h3>
            {#each generators as generator (generator.id)}
              {@render assetRow(generator.id, generator.label, `${mw(generator.state.dispatchMw)} MW`, false)}
            {/each}
          </div>
        </div>

        <div class="supply">
          <h3>Consumer supply</h3>
          {#each loads as load (load.id)}
            {@render assetRow(load.id, load.label, `${mw(load.state.unservedMw)} MW unserved`, true)}
          {:else}
            {#if summary}<p class="empty-state">All demand is served.</p>{/if}
          {/each}
        </div>

        {#if islands && gridId}
          <GridLfddStages {simulationRunId} {gridId} islands={islands.islands} onChanged={() => void loadSummary()} />
        {/if}

        {#if islands}
          <div class="islands">
            <h3>Islands ({islands.total})</h3>
            {#each islands.islands as island (island.id)}
              {@render assetRow(
                island.anchorBus.id,
                `${island.anchorBus.label} · ${island.busCount} buses`,
                island.energized
                  ? `${island.frequencyHz === null ? '' : `${island.frequencyHz.toFixed(2)} Hz · `}${mw(island.loadMw)} MW`
                  : 'De-energised',
                !island.energized || island.unservedLoadMw > 0,
              )}
            {/each}
            {#if islands.total > islands.islands.length}<p class="empty-state">{gridCount(islands.total - islands.islands.length, 'smaller island', 'smaller islands')} not shown.</p>{/if}
          </div>
        {/if}
      </div>
    {:else if view === 'alarms' && gridId}
      {#key gridId}
        <GridAlarmList {simulationRunId} {gridId} refreshRevision={selectedGridItem?.object.revision ?? 0} timeZone={gridLocalTimeZone} onLocate={assetId => void locateAsset(assetId)} />
      {/key}
    {:else if view === 'contingency' && gridId}
      {#key gridId}
        <GridContingencyView {simulationRunId} {gridId} revision={selectedGridItem?.object.revision ?? 0} {selectedAssetId} onLocate={assetId => void locateAsset(assetId)} />
      {/key}
    {:else if gridId}
      {#key gridId}
        <GridAssetBrowser {simulationRunId} {gridId} refreshRevision={selectedGridItem?.object.revision ?? 0} {selectedAssetId} onSelectAsset={assetId => selectAsset(assetId, true)} {onFocusMap} />
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
  .badge { min-width: 14px; padding: 0 4px; border-radius: 7px; color: #fff; background: #dc2626; font-size: 10px; font-weight: 700; text-align: center; }
  .link-button { margin-left: 6px; padding: 0; color: #2563eb; border: 0; background: transparent; cursor: pointer; font: inherit; text-decoration: underline; }
  :global(.dark) .link-button { color: #93c5fd; }
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
    white-space: nowrap;
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

  .row.linked {
    grid-template-columns: minmax(0, 1fr) auto;
    padding: 0;
  }

  .row-select {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
    align-items: baseline;
    min-width: 0;
    padding: 5px 0;
    color: inherit;
    text-align: left;
    border: 0;
    background: transparent;
    cursor: pointer;
    font: inherit;
  }

  .row-select:hover span,
  .row-select:focus-visible span {
    color: inherit;
    text-decoration: underline;
  }

  .row-locate {
    display: inline-grid;
    place-items: center;
    padding: 3px;
    color: #64748b;
    border: 0;
    border-radius: 3px;
    background: transparent;
    cursor: pointer;
  }

  .row-locate:hover,
  .row-locate:focus-visible {
    color: inherit;
    background: rgba(148, 163, 184, 0.16);
  }

  .alarms,
  .supply,
  .islands {
    margin-bottom: 14px;
  }

  .alarms ul {
    margin: 4px 0 0;
    padding-left: 16px;
    font-size: 12px;
  }

  .alarm-status {
    margin: 0;
    color: #dc2626;
    font-size: 12px;
    font-weight: 650;
  }

  .empty-state {
    margin: 4px 0;
    color: #64748b;
    font-size: 11px;
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
