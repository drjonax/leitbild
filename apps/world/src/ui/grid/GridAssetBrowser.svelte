<script lang="ts">
  import { ChevronLeft, ChevronRight, LocateFixed, RefreshCw, Search } from 'lucide-svelte'
  import type { SimulationRunId } from '../../core/model/index.ts'
  import {
    gridClearDerateCommandKind,
    gridCloseBranchCommandKind,
    gridDerateBranchCommandKind,
    gridOpenBranchCommandKind,
  } from '../../packs/electric-grid/commands/branch.ts'
  import {
    gridDispatchGeneratorCommandKind,
    gridResetGeneratorTripCommandKind,
    gridSetGeneratorAvailabilityCommandKind,
    gridStartGeneratorCommandKind,
    gridStopGeneratorCommandKind,
    gridTripGeneratorCommandKind,
  } from '../../packs/electric-grid/commands/generator.ts'
  import {
    gridRestoreLoadCommandKind,
    gridSetEvChargingDemandCommandKind,
    gridShedLoadCommandKind,
  } from '../../packs/electric-grid/commands/load.ts'
  import { invokeSimulationRunCapability, querySimulationRunCapability } from '../simulation-run-client.ts'
  import { runOnMount } from '../svelte-lifecycle.svelte.ts'

  type AssetKind = 'bus' | 'branch' | 'generator' | 'load' | 'storage'
  type MapTarget =
    | { readonly kind: 'point'; readonly center: readonly [number, number] }
    | { readonly kind: 'bounds'; readonly bounds: readonly [readonly [number, number], readonly [number, number]] }

  interface AssetListItem {
    readonly id: string
    readonly label: string
    readonly kind: AssetKind
    readonly subkind: string
    readonly status: { readonly tone: 'ready' | 'working' | 'error' | 'idle'; readonly label: string }
    readonly summary: string
    readonly applicableOperationIds: ReadonlyArray<string>
    readonly mapTarget?: MapTarget
  }

  interface AssetDetail extends AssetListItem {
    readonly definition: Readonly<Record<string, unknown>>
    readonly state?: Readonly<Record<string, unknown>>
  }

  interface Props {
    readonly simulationRunId: SimulationRunId
    readonly gridId: string
    readonly refreshRevision: number
    readonly onFocusMap?: (target: MapTarget) => void
  }

  const { simulationRunId, gridId, refreshRevision, onFocusMap = () => undefined }: Props = $props()
  const pageSize = 40
  const kindOptions: ReadonlyArray<{ readonly value: AssetKind | 'all'; readonly label: string }> = [
    { value: 'all', label: 'All' },
    { value: 'bus', label: 'Substations / buses' },
    { value: 'branch', label: 'Lines & transformers' },
    { value: 'generator', label: 'Generation' },
    { value: 'load', label: 'Consumers' },
    { value: 'storage', label: 'Storage' },
  ]

  let kind = $state<AssetKind | 'all'>('all')
  let searchText = $state('')
  let offset = $state(0)
  let total = $state(0)
  let assets = $state<ReadonlyArray<AssetListItem>>([])
  let selectedAssetId = $state<string | null>(null)
  let detail = $state<AssetDetail | null>(null)
  let loading = $state(false)
  let error = $state<string | null>(null)
  let activeOperationId = $state<string | null>(null)
  let commandValue = $state('')
  let commandStatus = $state<string | null>(null)
  let loadSequence = 0
  let searchTimer: ReturnType<typeof setTimeout> | null = null

  const pageNumber = $derived(Math.floor(offset / pageSize) + 1)
  const pageCount = $derived(Math.max(1, Math.ceil(total / pageSize)))

  const queryResult = async (requestKind: string, payload: unknown): Promise<unknown> => {
    return await querySimulationRunCapability(simulationRunId, requestKind, payload)
  }

  const loadDetail = async (assetId: string): Promise<void> => {
    try {
      const result = await queryResult('world.electric-grid.asset.get', { gridId, assetId }) as { readonly asset: AssetDetail }
      if (selectedAssetId !== assetId) return
      detail = result.asset
      error = null
    } catch (err) {
      if (selectedAssetId === assetId) error = err instanceof Error ? err.message : String(err)
    }
  }

  const loadAssets = async (): Promise<void> => {
    const sequence = ++loadSequence
    loading = true
    try {
      const result = await queryResult('world.electric-grid.assets.search', {
        gridId,
        text: searchText,
        ...(kind === 'all' ? {} : { kinds: [kind] }),
        offset,
        limit: pageSize,
      }) as { readonly total: number; readonly assets: ReadonlyArray<AssetListItem> }
      if (sequence !== loadSequence) return
      total = result.total
      assets = result.assets
      if (selectedAssetId && !result.assets.some(asset => asset.id === selectedAssetId)) {
        selectedAssetId = null
        detail = null
      }
      if (selectedAssetId) await loadDetail(selectedAssetId)
      error = null
    } catch (err) {
      if (sequence === loadSequence) error = err instanceof Error ? err.message : String(err)
    } finally {
      if (sequence === loadSequence) loading = false
    }
  }

  const selectAsset = (asset: AssetListItem): void => {
    selectedAssetId = asset.id
    detail = null
    activeOperationId = null
    commandStatus = null
    void loadDetail(asset.id)
  }

  const setKind = (next: AssetKind | 'all'): void => {
    kind = next
    offset = 0
    selectedAssetId = null
    detail = null
    void loadAssets()
  }

  const updateSearch = (value: string): void => {
    searchText = value
    offset = 0
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => void loadAssets(), 220)
  }

  const numericOperation = (operationId: string): boolean => [
    gridDispatchGeneratorCommandKind,
    gridSetGeneratorAvailabilityCommandKind,
    gridDerateBranchCommandKind,
    gridShedLoadCommandKind,
    gridSetEvChargingDemandCommandKind,
  ].includes(operationId)

  const operationLabel = (operationId: string): string => ({
    [gridDispatchGeneratorCommandKind]: 'Set dispatch',
    [gridTripGeneratorCommandKind]: 'Trip',
    [gridSetGeneratorAvailabilityCommandKind]: 'Set availability',
    [gridResetGeneratorTripCommandKind]: 'Reset trip',
    [gridStartGeneratorCommandKind]: 'Start',
    [gridStopGeneratorCommandKind]: 'Stop',
    [gridOpenBranchCommandKind]: 'Open',
    [gridCloseBranchCommandKind]: 'Close',
    [gridDerateBranchCommandKind]: 'Derate',
    [gridClearDerateCommandKind]: 'Clear derate',
    [gridShedLoadCommandKind]: 'Shed load',
    [gridRestoreLoadCommandKind]: 'Restore load',
    [gridSetEvChargingDemandCommandKind]: 'Set EV demand',
  }[operationId] ?? operationId)

  const valueLabel = (operationId: string): string => operationId === gridDerateBranchCommandKind
    ? 'Available fraction (0.05–1)'
    : operationId === gridShedLoadCommandKind
      ? 'Shed to at most (MW)'
      : operationId === gridSetEvChargingDemandCommandKind
        ? 'Demand (MW)'
        : operationId === gridSetGeneratorAvailabilityCommandKind
          ? 'Available capacity (MW)'
          : 'Target (MW)'

  const defaultValueFor = (operationId: string): string => {
    if (!detail) return ''
    if (operationId === gridDerateBranchCommandKind) return '0.8'
    if (operationId === gridShedLoadCommandKind) return String(Math.round(Number(detail.state?.servedMw ?? 0) * 0.9))
    if (operationId === gridDispatchGeneratorCommandKind) return String(detail.state?.targetMw ?? 0)
    if (operationId === gridSetGeneratorAvailabilityCommandKind) return String(detail.state?.availableMw ?? 0)
    if (operationId === gridSetEvChargingDemandCommandKind) return String(detail.state?.nominalDemandMw ?? 0)
    return ''
  }

  const payloadFor = (operationId: string, value: number): Readonly<Record<string, unknown>> => {
    const base = { gridId, assetId: detail!.id }
    if (operationId === gridDispatchGeneratorCommandKind) return { ...base, targetMw: value }
    if (operationId === gridSetGeneratorAvailabilityCommandKind) return { ...base, availableMw: value }
    if (operationId === gridDerateBranchCommandKind) return { ...base, availability: value }
    if (operationId === gridShedLoadCommandKind) return { ...base, targetDemandMw: value }
    if (operationId === gridSetEvChargingDemandCommandKind) return { ...base, demandMw: value }
    return base
  }

  const sendOperation = async (operationId: string): Promise<void> => {
    if (!detail) return
    if (numericOperation(operationId) && activeOperationId !== operationId) {
      activeOperationId = operationId
      commandValue = defaultValueFor(operationId)
      commandStatus = null
      return
    }
    const value = numericOperation(operationId) ? Number(commandValue) : 0
    if (numericOperation(operationId) && !Number.isFinite(value)) {
      commandStatus = 'Enter a valid number'
      return
    }
    commandStatus = 'Sending…'
    try {
      const response = await invokeSimulationRunCapability(simulationRunId, {
        capabilityId: operationId,
        input: payloadFor(operationId, value),
      })
      if (response.kind !== 'command') throw new Error(`Capability ${operationId} is not a command`)
      if (!response.result.ok) throw new Error(response.result.reason ?? 'Command rejected')
      activeOperationId = null
      commandStatus = 'Accepted'
      await loadAssets()
    } catch (err) {
      commandStatus = err instanceof Error ? err.message : String(err)
    }
  }

  const displayValue = (value: unknown): string => {
    if (value === null) return 'null'
    if (typeof value === 'number') return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(3)
    if (typeof value === 'string' || typeof value === 'boolean') return String(value)
    return JSON.stringify(value)
  }

  $effect(() => {
    refreshRevision
    void loadAssets()
  })

  runOnMount(() => {
    return () => {
      if (searchTimer) clearTimeout(searchTimer)
    }
  })
</script>

<div class="asset-browser">
  <div class="browser-controls">
    <label class="search-box">
      <Search size={14} />
      <input value={searchText} oninput={(event) => updateSearch(event.currentTarget.value)} placeholder="Search assets" />
    </label>
    <button type="button" class="icon-button" title="Refresh assets" aria-label="Refresh assets" onclick={() => void loadAssets()}>
      <span class:spinning={loading}><RefreshCw size={14} /></span>
    </button>
  </div>

  <div class="kind-tabs" role="tablist" aria-label="Grid asset kind">
    {#each kindOptions as option}
      <button type="button" class:active={kind === option.value} onclick={() => setKind(option.value)}>{option.label}</button>
    {/each}
  </div>

  <div class="browser-body" class:with-detail={detail !== null}>
    <div class="asset-list" aria-label="Grid assets">
      {#if assets.length === 0 && !loading}<p class="empty">No matching assets.</p>{/if}
      {#each assets as asset (asset.id)}
        <button type="button" class="asset-row" class:selected={selectedAssetId === asset.id} onclick={() => selectAsset(asset)}>
          <span class="status-dot {asset.status.tone}" title={asset.status.label}></span>
          <span class="asset-copy">
            <strong>{asset.label}</strong>
            <small>{asset.subkind.replaceAll('_', ' ')} · {asset.summary}</small>
          </span>
        </button>
      {/each}
    </div>

    {#if detail}
      <aside class="asset-detail">
        <div class="detail-heading">
          <div>
            <small>{detail.subkind.replaceAll('_', ' ')}</small>
            <h3>{detail.label}</h3>
            <code>{detail.id}</code>
          </div>
          {#if detail.mapTarget}
            <button type="button" class="icon-button" title="Show on map" aria-label="Show on map" onclick={() => detail?.mapTarget && onFocusMap(detail.mapTarget)}><LocateFixed size={15} /></button>
          {/if}
        </div>
        <p class="detail-summary"><span class="status-dot {detail.status.tone}"></span>{detail.status.label} · {detail.summary}</p>

        {#if detail.applicableOperationIds.length > 0}
          <div class="operations">
            {#each detail.applicableOperationIds as operationId}
              <button type="button" class:active={activeOperationId === operationId} onclick={() => void sendOperation(operationId)}>{operationLabel(operationId)}</button>
            {/each}
          </div>
          {#if activeOperationId}
            <div class="command-form">
              <label>{valueLabel(activeOperationId)}<input type="number" bind:value={commandValue} /></label>
              <button type="button" onclick={() => activeOperationId && void sendOperation(activeOperationId)}>Apply</button>
            </div>
          {/if}
          {#if commandStatus}<p class="command-status">{commandStatus}</p>{/if}
        {/if}

        <details open>
          <summary>Live state</summary>
          <dl>
            {#each Object.entries(detail.state ?? {}) as [key, value]}
              <dt>{key.replaceAll('_', ' ')}</dt><dd>{displayValue(value)}</dd>
            {/each}
          </dl>
        </details>
        <details>
          <summary>Definition & provenance</summary>
          <dl>
            {#each Object.entries(detail.definition) as [key, value]}
              <dt>{key.replaceAll('_', ' ')}</dt><dd>{displayValue(value)}</dd>
            {/each}
          </dl>
        </details>
      </aside>
    {/if}
  </div>

  <footer class="pagination">
    <span>{total.toLocaleString()} assets</span>
    <span>Page {pageNumber} of {pageCount}</span>
    <button type="button" disabled={offset === 0} aria-label="Previous page" onclick={() => { offset = Math.max(0, offset - pageSize); void loadAssets() }}><ChevronLeft size={14} /></button>
    <button type="button" disabled={offset + pageSize >= total} aria-label="Next page" onclick={() => { offset += pageSize; void loadAssets() }}><ChevronRight size={14} /></button>
  </footer>
  {#if error}<p class="error">{error}</p>{/if}
</div>

<style>
  .asset-browser { display: flex; min-height: 0; flex: 1; flex-direction: column; gap: 9px; }
  .browser-controls { display: flex; gap: 7px; }
  .search-box { display: flex; min-width: 0; flex: 1; align-items: center; gap: 6px; padding: 6px 8px; border: 1px solid rgba(148,163,184,.5); border-radius: 5px; background: rgba(255,255,255,.62); }
  :global(.dark) .search-box { background: rgba(15,23,42,.55); }
  .search-box input { min-width: 0; width: 100%; color: inherit; border: 0; outline: 0; background: transparent; font: inherit; }
  .icon-button { display: inline-grid; place-items: center; padding: 6px; color: inherit; border: 1px solid rgba(148,163,184,.45); border-radius: 5px; background: transparent; cursor: pointer; }
  .spinning { display: inline-flex; animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .kind-tabs { display: flex; gap: 5px; overflow-x: auto; padding-bottom: 2px; }
  .kind-tabs button, .operations button, .command-form button { white-space: nowrap; padding: 5px 8px; color: inherit; border: 1px solid rgba(148,163,184,.4); border-radius: 999px; background: transparent; cursor: pointer; font-size: 11px; }
  .kind-tabs button.active, .operations button.active { border-color: #3b82f6; background: rgba(59,130,246,.12); }
  .browser-body { display: grid; min-height: 0; flex: 1; grid-template-columns: minmax(0, 1fr); overflow: hidden; border: 1px solid rgba(148,163,184,.35); border-radius: 5px; }
  .browser-body.with-detail { grid-template-columns: minmax(190px, .9fr) minmax(230px, 1.1fr); }
  .asset-list, .asset-detail { min-height: 0; overflow: auto; }
  .asset-detail { padding: 12px; border-left: 1px solid rgba(148,163,184,.35); }
  .asset-row { display: flex; width: 100%; align-items: flex-start; gap: 8px; padding: 8px 9px; color: inherit; text-align: left; border: 0; border-bottom: 1px solid rgba(148,163,184,.22); background: transparent; cursor: pointer; }
  .asset-row:hover, .asset-row.selected { background: rgba(59,130,246,.08); }
  .asset-copy { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 2px; }
  .asset-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 650; }
  .asset-copy small { overflow: hidden; color: #64748b; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; }
  :global(.dark) .asset-copy small { color: #94a3b8; }
  .status-dot { width: 7px; height: 7px; flex: 0 0 auto; margin-top: 4px; border-radius: 50%; background: #94a3b8; }
  .status-dot.ready { background: #16a34a; } .status-dot.working { background: #d97706; } .status-dot.error { background: #dc2626; } .status-dot.idle { background: #94a3b8; }
  .detail-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
  .detail-heading small { color: #64748b; text-transform: uppercase; font-size: 9px; letter-spacing: .06em; }
  .detail-heading h3 { margin: 2px 0; font-size: 14px; line-height: 1.2; }
  .detail-heading code { display: block; overflow-wrap: anywhere; color: #64748b; font-size: 9px; }
  .detail-summary { display: flex; align-items: center; gap: 6px; margin: 10px 0; font-size: 11px; }
  .detail-summary .status-dot { margin: 0; }
  .operations { display: flex; flex-wrap: wrap; gap: 5px; margin: 8px 0; }
  .command-form { display: flex; align-items: end; gap: 6px; padding: 8px; border-radius: 5px; background: rgba(148,163,184,.1); }
  .command-form label { display: flex; flex: 1; flex-direction: column; gap: 4px; font-size: 10px; }
  .command-form input { width: 100%; box-sizing: border-box; padding: 5px 6px; color: inherit; border: 1px solid rgba(148,163,184,.45); border-radius: 4px; background: transparent; }
  .command-status { margin: 5px 0; color: #64748b; font-size: 10px; }
  details { margin-top: 9px; font-size: 10px; }
  summary { cursor: pointer; font-weight: 650; }
  dl { display: grid; grid-template-columns: minmax(80px,.8fr) minmax(0,1.2fr); gap: 4px 8px; margin: 7px 0; }
  dt { color: #64748b; } dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
  .pagination { display: flex; align-items: center; justify-content: flex-end; gap: 8px; color: #64748b; font-size: 10px; }
  .pagination span:first-child { margin-right: auto; }
  .pagination button { display: inline-grid; place-items: center; padding: 3px; color: inherit; border: 1px solid rgba(148,163,184,.35); border-radius: 4px; background: transparent; cursor: pointer; }
  .pagination button:disabled { opacity: .35; cursor: default; }
  .empty, .error { margin: 12px; color: #64748b; font-size: 11px; }
  .error { color: #dc2626; }
  @media (max-width: 620px) { .browser-body.with-detail { grid-template-columns: 1fr; } .asset-detail { border-top: 1px solid rgba(148,163,184,.35); border-left: 0; } }
</style>
