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
    gridBlockHvdcCommandKind,
    gridDeblockHvdcCommandKind,
    gridResetHvdcTripCommandKind,
    gridSetHvdcSetpointCommandKind,
    gridTripHvdcCommandKind,
  } from '../../packs/electric-grid/commands/hvdc.ts'
  import {
    gridRestoreLoadCommandKind,
    gridSetEvChargingDemandCommandKind,
    gridShedLoadCommandKind,
  } from '../../packs/electric-grid/commands/load.ts'
  import { electricGridDestructiveCommandKinds } from '../../packs/electric-grid/commands/index.ts'
  import { gridResetBranchProtectionCommandKind } from '../../packs/electric-grid/commands/protection.ts'
  import { gridHvdcSetpointGuidance, gridShedLoadPlan, type GridShedLoadPlan } from '../../packs/electric-grid/ui/operator-commands.ts'
  import { invokeSimulationRunCapability, querySimulationRunCapability } from '../simulation-run-client.ts'
  import { untrack } from 'svelte'
  import { runOnMount } from '../svelte-lifecycle.svelte.ts'

  type AssetKind = 'bus' | 'branch' | 'generator' | 'load' | 'storage' | 'hvdc'
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
    /** An HVDC link's shared ramp limit, or null. */
    readonly rampGroup?: { readonly id: string; readonly linkIds: ReadonlyArray<string>; readonly rampMwPerMinute: number } | null
  }

  interface Props {
    readonly simulationRunId: SimulationRunId
    readonly gridId: string
    readonly refreshRevision: number
    /** The selected asset; the panel owns it so the map can select and highlight it too. */
    readonly selectedAssetId: string | null
    readonly onSelectAsset: (assetId: string | null) => void
    readonly onFocusMap?: (target: MapTarget) => void
  }

  const { simulationRunId, gridId, refreshRevision, selectedAssetId, onSelectAsset, onFocusMap = () => undefined }: Props = $props()
  const pageSize = 40
  const kindOptions: ReadonlyArray<{ readonly value: AssetKind | 'all'; readonly label: string }> = [
    { value: 'all', label: 'All' },
    { value: 'bus', label: 'Substations / buses' },
    { value: 'branch', label: 'Lines & transformers' },
    { value: 'generator', label: 'Generation' },
    { value: 'load', label: 'Consumers' },
    { value: 'storage', label: 'Storage' },
    { value: 'hvdc', label: 'HVDC links' },
  ]

  let kind = $state<AssetKind | 'all'>('all')
  let searchText = $state('')
  let offset = $state(0)
  let total = $state(0)
  let assets = $state<ReadonlyArray<AssetListItem>>([])
  let detail = $state<AssetDetail | null>(null)
  let loading = $state(false)
  let loaded = $state(false)
  let error = $state<string | null>(null)
  let activeOperationId = $state<string | null>(null)
  let commandValue = $state('')
  let commandStatus = $state<string | null>(null)
  let commandEmergency = $state(false)
  let pendingConfirmation = $state<{ readonly operationId: string; readonly value: number; readonly emergency: boolean } | null>(null)
  let loadSequence = 0
  let searchTimer: ReturnType<typeof setTimeout> | null = null

  const numberField = (fields: Readonly<Record<string, unknown>> | undefined, key: string): number => {
    const value = fields?.[key]
    if (typeof value !== 'number') throw new Error(`${detail?.id ?? 'asset'} reports no ${key}`)
    return value
  }

  // Shed-load's interruptible limit and emergency flag, checked as the operator types.
  const shedPlan = $derived.by((): GridShedLoadPlan | null => {
    if (activeOperationId !== gridShedLoadCommandKind || detail === null || detail.kind !== 'load') return null
    return gridShedLoadPlan({
      label: detail.label,
      priority: String(detail.definition.priority),
      criticalMw: numberField(detail.definition, 'criticalMw'),
      interruptibleMw: numberField(detail.definition, 'interruptibleMw'),
      demandMw: numberField(detail.state, 'demandMw'),
      modelledDemandMw: numberField(detail.state, 'modelledDemandMw'),
      nominalDemandMw: numberField(detail.state, 'nominalDemandMw'),
    }, Number(commandValue), commandEmergency)
  })

  const rampGroupOf = (asset: AssetDetail): { readonly id: string; readonly rampMwPerMinute: number; readonly linkCount: number } | null => {
    if (asset.rampGroup === undefined) throw new Error(`${asset.id} reports no rampGroup`)
    return asset.rampGroup === null ? null : { id: asset.rampGroup.id, rampMwPerMinute: asset.rampGroup.rampMwPerMinute, linkCount: asset.rampGroup.linkIds.length }
  }

  // An HVDC set-point's sign, limit and ramp, within its shared ramp group.
  const hvdcGuidance = $derived.by(() => {
    if (activeOperationId !== gridSetHvdcSetpointCommandKind || detail === null || detail.kind !== 'hvdc') return null
    return gridHvdcSetpointGuidance({
      label: detail.label,
      ratingMw: numberField(detail.definition, 'ratingMw'),
      rampMwPerMinute: numberField(detail.definition, 'rampMwPerMinute'),
      transferMw: numberField(detail.state, 'transferMw'),
      setpointMw: numberField(detail.state, 'setpointMw'),
      rampGroup: rampGroupOf(detail),
    }, commandValue.trim() === '' ? null : Number(commandValue))
  })

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

  /** Background refreshes on a new revision keep the list still; only user-initiated loads show the spinner. */
  const loadAssets = async (userInitiated: boolean): Promise<void> => {
    const sequence = ++loadSequence
    if (userInitiated) loading = true
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
      loaded = true
      error = null
    } catch (err) {
      if (sequence === loadSequence) error = err instanceof Error ? err.message : String(err)
    } finally {
      if (sequence === loadSequence) loading = false
    }
  }

  const selectAsset = (asset: AssetListItem): void => {
    onSelectAsset(asset.id)
  }

  const setKind = (next: AssetKind | 'all'): void => {
    kind = next
    offset = 0
    void loadAssets(true)
  }

  const updateSearch = (value: string): void => {
    searchText = value
    offset = 0
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => void loadAssets(true), 220)
  }

  const numericOperation = (operationId: string): boolean => [
    gridDispatchGeneratorCommandKind,
    gridSetGeneratorAvailabilityCommandKind,
    gridDerateBranchCommandKind,
    gridShedLoadCommandKind,
    gridSetEvChargingDemandCommandKind,
    gridSetHvdcSetpointCommandKind,
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
    [gridSetHvdcSetpointCommandKind]: 'Set transfer',
    [gridBlockHvdcCommandKind]: 'Block',
    [gridDeblockHvdcCommandKind]: 'Deblock',
    [gridTripHvdcCommandKind]: 'Trip',
    [gridResetHvdcTripCommandKind]: 'Reset trip',
    [gridResetBranchProtectionCommandKind]: 'Reset protection',
  }[operationId] ?? operationId)

  const valueLabel = (operationId: string): string => operationId === gridDerateBranchCommandKind
    ? 'Available fraction (0.05–1)'
    : operationId === gridShedLoadCommandKind
      ? 'Shed to at most (MW)'
      : operationId === gridSetEvChargingDemandCommandKind
        ? 'Demand (MW)'
        : operationId === gridSetGeneratorAvailabilityCommandKind
          ? 'Available capacity (MW)'
          : operationId === gridSetHvdcSetpointCommandKind
            ? 'Set-point (MW): + exports from Norway, − imports'
            : 'Target (MW)'

  const defaultValueFor = (operationId: string): string => {
    if (!detail) return ''
    if (operationId === gridDerateBranchCommandKind) return '0.8'
    if (operationId === gridShedLoadCommandKind) return String(Math.round(Number(detail.state?.servedMw ?? 0) * 0.9))
    if (operationId === gridDispatchGeneratorCommandKind) return String(detail.state?.targetMw ?? 0)
    if (operationId === gridSetGeneratorAvailabilityCommandKind) return String(detail.state?.availableMw ?? 0)
    if (operationId === gridSetEvChargingDemandCommandKind) return String(detail.state?.nominalDemandMw ?? 0)
    if (operationId === gridSetHvdcSetpointCommandKind) return String(detail.state?.setpointMw ?? 0)
    return ''
  }

  const payloadFor = (operationId: string, value: number, emergency: boolean): Readonly<Record<string, unknown>> => {
    const base = { gridId, assetId: detail!.id }
    if (operationId === gridDispatchGeneratorCommandKind) return { ...base, targetMw: value }
    if (operationId === gridSetGeneratorAvailabilityCommandKind) return { ...base, availableMw: value }
    if (operationId === gridDerateBranchCommandKind) return { ...base, availability: value }
    if (operationId === gridShedLoadCommandKind) return { ...base, targetDemandMw: value, emergency }
    if (operationId === gridSetEvChargingDemandCommandKind) return { ...base, demandMw: value }
    if (operationId === gridSetHvdcSetpointCommandKind) return { ...base, setpointMw: value }
    return base
  }

  const confirmationText = (confirmation: { readonly operationId: string; readonly value: number }): string =>
    confirmation.operationId === gridShedLoadCommandKind && shedPlan !== null
      ? shedPlan.confirmation
      : `${operationLabel(confirmation.operationId)} ${detail?.label ?? ''}${numericOperation(confirmation.operationId) ? ` to ${confirmation.value.toLocaleString()} MW` : ''}? This disconnects supply or generation at once.`

  const sendOperation = async (operationId: string): Promise<void> => {
    if (!detail) return
    pendingConfirmation = null
    if (numericOperation(operationId) && activeOperationId !== operationId) {
      activeOperationId = operationId
      commandValue = defaultValueFor(operationId)
      commandEmergency = false
      commandStatus = null
      return
    }
    if (!numericOperation(operationId)) activeOperationId = null
    const value = numericOperation(operationId) ? Number(commandValue) : 0
    if (numericOperation(operationId) && !Number.isFinite(value)) {
      commandStatus = 'Enter a valid number'
      return
    }
    // The guidance below the form already names what the runtime would reject and how to change it; nothing is sent.
    const problem = operationId === gridShedLoadCommandKind ? shedPlan?.problem : operationId === gridSetHvdcSetpointCommandKind ? hvdcGuidance?.problem : null
    if (problem) {
      commandStatus = null
      return
    }
    const emergency = operationId === gridShedLoadCommandKind && commandEmergency
    if (electricGridDestructiveCommandKinds.has(operationId)) {
      pendingConfirmation = { operationId, value, emergency }
      commandStatus = null
      return
    }
    await invokeOperation(operationId, value, emergency)
  }

  const invokeOperation = async (operationId: string, value: number, emergency: boolean): Promise<void> => {
    if (!detail) return
    pendingConfirmation = null
    commandStatus = 'Sending…'
    try {
      const response = await invokeSimulationRunCapability(simulationRunId, {
        capabilityId: operationId,
        input: payloadFor(operationId, value, emergency),
      })
      if (response.kind !== 'command') throw new Error(`Capability ${operationId} is not a command`)
      if (!response.result.ok) throw new Error(`Rejected: ${response.result.reason ?? 'no reason given'}`)
      activeOperationId = null
      commandStatus = 'Accepted'
      await Promise.all([loadAssets(false), loadDetail(detail.id)])
    } catch (err) {
      commandStatus = err instanceof Error ? err.message : String(err)
    }
  }

  type Fields = Readonly<Record<string, unknown>>
  const valueOf = (fields: Fields | undefined, key: string): unknown => fields?.[key]
  const formatted = (value: unknown, unit = '', digits = 0): string => {
    if (typeof value === 'number') return `${value.toLocaleString(undefined, { maximumFractionDigits: digits })}${unit === '' ? '' : ` ${unit}`}`
    if (typeof value === 'string') return value.replaceAll('_', ' ')
    if (typeof value === 'boolean') return value ? 'Yes' : 'No'
    if (Array.isArray(value)) return value.length === 0 ? 'None' : value.join(', ')
    return value === null ? 'None' : 'Not reported'
  }
  const percentOf = (fraction: unknown): unknown => typeof fraction === 'number' ? fraction * 100 : fraction

  /** A tripped branch's relay operation and what restores it; otherwise its thermal state. */
  const protectionText = (protection: unknown): string => {
    const value = protection as { readonly thermalLevel: number; readonly trip: { readonly element: string; readonly loadingPercent: number } | null } | undefined
    if (value === undefined) return 'Not reported'
    if (value.trip !== null) return `Tripped by its ${value.trip.element} element at ${value.trip.loadingPercent.toFixed(0)} %: Reset protection, then Close`
    return `Armed · thermal level ${value.thermalLevel.toFixed(2)} (1 = continuous rating)`
  }

  /** The fields an operator reads first, per asset kind; the full records stay under Raw data. */
  const keyFieldsFor = (asset: AssetDetail): ReadonlyArray<{ readonly label: string; readonly value: string }> => {
    const definition = asset.definition
    const state = asset.state
    const field = (label: string, value: string) => ({ label, value })
    if (asset.kind === 'branch') return [
      field('Loading', formatted(valueOf(state, 'loadingPercent'), '%', 1)),
      field('Flow', `${formatted(valueOf(state, 'flowMw'), 'MW')} (positive from ${formatted(valueOf(definition, 'fromBusId'))})`),
      field('Switching', formatted(valueOf(state, 'state'))),
      field('Protection', protectionText(valueOf(state, 'protection'))),
      field('Available rating', formatted(percentOf(valueOf(state, 'availability')), '%')),
      field('Rating', `${formatted(valueOf(definition, 'ratingMw'), 'MW')} · emergency ${formatted(valueOf(definition, 'emergencyRatingMw'), 'MW')}`),
      field('Voltage', formatted(valueOf(definition, 'nominalKv'), 'kV')),
      field('From → to', `${formatted(valueOf(definition, 'fromBusId'))} → ${formatted(valueOf(definition, 'toBusId'))}`),
    ]
    if (asset.kind === 'generator') return [
      field('State', formatted(valueOf(state, 'state'))),
      field('Dispatch', `${formatted(valueOf(state, 'dispatchMw'), 'MW')} → target ${formatted(valueOf(state, 'targetMw'), 'MW')}`),
      field('Available', `${formatted(valueOf(state, 'availableMw'), 'MW')} of ${formatted(valueOf(definition, 'capacityMw'), 'MW')}`),
      field('Reserve', formatted(valueOf(state, 'reserveMw'), 'MW')),
      field('Kind', formatted(valueOf(definition, 'kind'))),
      field('Bus', formatted(valueOf(definition, 'busId'))),
    ]
    if (asset.kind === 'load') return [
      field('Service', formatted(valueOf(state, 'serviceState'))),
      field('Served', `${formatted(valueOf(state, 'servedMw'), 'MW', 1)} of ${formatted(valueOf(state, 'demandMw'), 'MW', 1)}`),
      field('Shed', `${formatted(valueOf(state, 'shedMw'), 'MW', 1)} (manual ${formatted(valueOf(state, 'curtailedMw'), 'MW', 1)}, LFDD ${formatted(valueOf(state, 'lfddShedMw'), 'MW', 1)})`),
      field('Priority', formatted(valueOf(definition, 'priority'))),
      field('Interruptible', formatted(valueOf(definition, 'interruptibleMw'), 'MW', 1)),
      field('Critical', formatted(valueOf(definition, 'criticalMw'), 'MW', 1)),
      field('Bus', formatted(valueOf(definition, 'busId'))),
    ]
    if (asset.kind === 'hvdc') return [
      field('State', formatted(valueOf(state, 'state'))),
      field('Transfer', `${formatted(valueOf(state, 'transferMw'), 'MW')} → set-point ${formatted(valueOf(state, 'setpointMw'), 'MW')} (positive exports)`),
      field('Losses', formatted(valueOf(state, 'lossesMw'), 'MW', 1)),
      field('Rating', `±${formatted(valueOf(definition, 'ratingMw'), 'MW')} · ramp ${formatted(valueOf(definition, 'rampMwPerMinute'), 'MW/min')}`),
      field('From → to', `${formatted(valueOf(definition, 'fromBusId'))} → ${formatted(valueOf(definition, 'toBusId'))}`),
    ]
    if (asset.kind === 'bus') return [
      field('Voltage', state === undefined ? 'Not solved' : valueOf(state, 'voltageModel') === 'not-converged'
        ? 'Unknown: AC load flow did not converge'
        : `${formatted(valueOf(state, 'voltagePu'), 'pu', 3)}${valueOf(state, 'voltageModel') === 'external' ? ' (held by its external system)' : ''}`),
      field('Frequency', state === undefined ? 'Not solved' : formatted(valueOf(state, 'frequencyHz'), 'Hz', 3)),
      field('Island', state === undefined ? 'Not solved' : valueOf(state, 'voltageModel') === 'external' ? 'None: its ties are open, its external system holds it' : formatted(valueOf(state, 'islandId'))),
      field('Nominal', formatted(valueOf(definition, 'nominalKv'), 'kV')),
    ]
    return [
      field('State', formatted(valueOf(state, 'state'))),
      field('Charge', formatted(percentOf(valueOf(state, 'stateOfChargeFraction')), '%')),
      field('Dispatch', formatted(valueOf(state, 'dispatchMw'), 'MW')),
      field('Capacity', formatted(valueOf(definition, 'capacityMwh'), 'MWh')),
    ]
  }

  $effect(() => {
    refreshRevision
    untrack(() => {
      void loadAssets(false)
      // The selection effect loads a newly selected asset; a revision refreshes the one shown.
      if (detail !== null) void loadDetail(detail.id)
    })
  })

  $effect(() => {
    const assetId = selectedAssetId
    untrack(() => {
      activeOperationId = null
      pendingConfirmation = null
      commandStatus = null
      if (detail?.id !== assetId) detail = null
      if (assetId) void loadDetail(assetId)
    })
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
    <button type="button" class="icon-button" title="Refresh assets" aria-label="Refresh assets" onclick={() => void loadAssets(true)}>
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
      {#if assets.length === 0 && loaded && !loading}<p class="empty">No matching assets.</p>{/if}
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
            <button type="button" class="icon-button" title="Locate on map" aria-label="Locate on map" onclick={() => detail?.mapTarget && onFocusMap(detail.mapTarget)}><LocateFixed size={15} /></button>
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
              <label>{valueLabel(activeOperationId)}<input type="text" bind:value={commandValue} /></label>
              {#if activeOperationId === gridShedLoadCommandKind}
                <label class="emergency"><input type="checkbox" bind:checked={commandEmergency} />Emergency</label>
              {/if}
              <button type="button" onclick={() => activeOperationId && void sendOperation(activeOperationId)}>Apply</button>
            </div>
            {#if shedPlan}
              <p class="guidance">{shedPlan.limits}</p>
              {#if shedPlan.problem}<p class="guidance problem">{shedPlan.problem}</p>{/if}
            {/if}
            {#if hvdcGuidance}
              <p class="guidance">{hvdcGuidance.convention}</p>
              {#if hvdcGuidance.problem}<p class="guidance problem">{hvdcGuidance.problem}</p>{:else if hvdcGuidance.outcome}<p class="guidance">{hvdcGuidance.outcome}</p>{/if}
            {/if}
          {/if}
          {#if pendingConfirmation}
            {@const confirmation = pendingConfirmation}
            <div class="confirmation" role="alertdialog" aria-label="Confirm Grid operation">
              <p>{confirmationText(confirmation)}</p>
              <button type="button" class="confirm" onclick={() => void invokeOperation(confirmation.operationId, confirmation.value, confirmation.emergency)}>Confirm</button>
              <button type="button" onclick={() => { pendingConfirmation = null }}>Cancel</button>
            </div>
          {/if}
          {#if commandStatus}<p class="command-status">{commandStatus}</p>{/if}
        {/if}

        <dl class="key-fields">
          {#each keyFieldsFor(detail) as item}
            <dt>{item.label}</dt><dd>{item.value}</dd>
          {/each}
        </dl>
        <details>
          <summary>Raw data</summary>
          <pre>{JSON.stringify({ state: detail.state ?? null, definition: detail.definition }, null, 2)}</pre>
        </details>
      </aside>
    {/if}
  </div>

  <footer class="pagination">
    <span>{total.toLocaleString()} assets</span>
    <span>Page {pageNumber} of {pageCount}</span>
    <button type="button" disabled={offset === 0} aria-label="Previous page" onclick={() => { offset = Math.max(0, offset - pageSize); void loadAssets(true) }}><ChevronLeft size={14} /></button>
    <button type="button" disabled={offset + pageSize >= total} aria-label="Next page" onclick={() => { offset += pageSize; void loadAssets(true) }}><ChevronRight size={14} /></button>
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
  .command-status { margin: 5px 0; color: #64748b; font-size: 10px; overflow-wrap: anywhere; }
  .command-form label.emergency { flex: 0 0 auto; flex-direction: row; align-items: center; gap: 4px; font-size: 11px; }
  .command-form label.emergency input { width: auto; }
  .guidance { margin: 5px 0 0; color: #64748b; font-size: 10px; }
  .guidance.problem { color: #b45309; font-weight: 600; }
  :global(.dark) .guidance { color: #94a3b8; } :global(.dark) .guidance.problem { color: #fbbf24; }
  .confirmation { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 6px; padding: 8px; border: 1px solid rgba(220,38,38,.45); border-radius: 5px; background: rgba(220,38,38,.08); font-size: 11px; }
  .confirmation p { flex: 1 1 100%; margin: 0; }
  .confirmation button { padding: 5px 8px; color: inherit; border: 1px solid rgba(148,163,184,.4); border-radius: 999px; background: transparent; cursor: pointer; font-size: 11px; }
  .confirmation button.confirm { color: #fff; border-color: #dc2626; background: #dc2626; }
  details { margin-top: 9px; font-size: 10px; }
  details pre { max-height: 240px; overflow: auto; margin: 6px 0 0; padding: 6px; border-radius: 4px; background: rgba(148,163,184,.1); font-size: 9px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .key-fields { margin: 10px 0 4px; font-size: 11px; }
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
