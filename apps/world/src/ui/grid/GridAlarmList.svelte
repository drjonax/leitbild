<script lang="ts">
  import { BellOff, Check, LocateFixed, RefreshCw } from 'lucide-svelte'
  import { untrack } from 'svelte'
  import type { SimulationRunId } from '../../core/model/index.ts'
  import { gridAlarmLifecycleCommandKind } from '../../packs/electric-grid/commands/alarm.ts'
  import type { GridAlarmsListResult } from '../../packs/electric-grid/queries/alarms.ts'
  import {
    gridAlarmFilterStates,
    gridAlarmIdsToAcknowledge,
    gridAlarmRows,
    gridAlarmShelveDurations,
    type GridAlarmFilter,
    type GridAlarmLifecycleAction,
  } from '../../packs/electric-grid/ui/operator-alarms.ts'
  import { invokeSimulationRunCapability, querySimulationRunCapability } from '../simulation-run-client.ts'

  interface Props {
    readonly simulationRunId: SimulationRunId
    readonly gridId: string
    /** The Grid object's revision: the list refreshes when it changes, never on a timer. */
    readonly refreshRevision: number
    /** Time zone alarm times are shown in. */
    readonly timeZone: string
    readonly onLocate: (assetId: string) => void
  }

  const { simulationRunId, gridId, refreshRevision, timeZone, onLocate }: Props = $props()
  const pageLimit = 200
  const filters: ReadonlyArray<{ readonly value: GridAlarmFilter; readonly label: string }> = [
    { value: 'active', label: 'Active' },
    { value: 'unacknowledged', label: 'Unacknowledged' },
    { value: 'shelved', label: 'Shelved' },
    { value: 'all', label: 'All' },
  ]

  let filter = $state<GridAlarmFilter>('active')
  let result = $state<GridAlarmsListResult | null>(null)
  let error = $state<string | null>(null)
  let pending = $state<string | null>(null)
  let shelveSeconds = $state(gridAlarmShelveDurations[0]!.seconds)
  let loadSequence = 0

  const rows = $derived(result === null ? [] : gridAlarmRows(result.alarms, timeZone))
  const acknowledgeable = $derived(gridAlarmIdsToAcknowledge(rows))

  const load = async (): Promise<void> => {
    const sequence = ++loadSequence
    const states = gridAlarmFilterStates[filter]
    try {
      const answer = await querySimulationRunCapability<GridAlarmsListResult>(simulationRunId, 'world.electric-grid.alarms.list', {
        gridId,
        ...(states === null ? {} : { states }),
        limit: pageLimit,
      })
      if (sequence !== loadSequence) return
      result = answer
      error = null
    } catch (err) {
      if (sequence === loadSequence) error = err instanceof Error ? err.message : String(err)
    }
  }

  const setFilter = (next: GridAlarmFilter): void => {
    filter = next
    void load()
  }

  const lifecycle = async (alarmIds: ReadonlyArray<string>, action: GridAlarmLifecycleAction): Promise<void> => {
    if (alarmIds.length === 0) return
    pending = alarmIds.length === 1 ? `${action}:${alarmIds[0]}` : `${action}:all`
    try {
      const response = await invokeSimulationRunCapability(simulationRunId, {
        capabilityId: gridAlarmLifecycleCommandKind,
        input: { gridId, alarmIds, action, ...(action === 'shelve' ? { shelveSeconds } : {}) },
      })
      if (response.kind !== 'command') throw new Error(`Capability ${gridAlarmLifecycleCommandKind} is not a command`)
      if (!response.result.ok) throw new Error(response.result.reason ?? 'Alarm lifecycle command rejected')
      error = null
      await load()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      pending = null
    }
  }

  const actionLabel: Readonly<Record<GridAlarmLifecycleAction, string>> = { acknowledge: 'Ack', shelve: 'Shelve', unshelve: 'Unshelve' }

  $effect(() => {
    refreshRevision
    untrack(() => void load())
  })
</script>

<div class="alarm-list">
  <div class="alarm-toolbar">
    <div class="filters" role="tablist" aria-label="Alarm filter">
      {#each filters as option}
        <button type="button" role="tab" aria-selected={filter === option.value} class:active={filter === option.value} onclick={() => setFilter(option.value)}>{option.label}</button>
      {/each}
    </div>
    <button type="button" class="icon-button" title="Refresh alarms" aria-label="Refresh alarms" onclick={() => void load()}><RefreshCw size={13} /></button>
  </div>

  {#if result}
    <div class="alarm-counts">
      <span class="count critical" title="Active priority-1 alarms">P1 {result.counts.activeByPriority[1]}</span>
      <span class="count warning" title="Active priority-2 alarms">P2 {result.counts.activeByPriority[2]}</span>
      <span class="count notice" title="Active priority-3 alarms">P3 {result.counts.activeByPriority[3]}</span>
      <span>{result.counts.unacknowledged} unacknowledged · {result.counts.shelved} shelved</span>
    </div>
    <div class="bulk">
      <button type="button" disabled={acknowledgeable.length === 0 || pending !== null} onclick={() => void lifecycle(acknowledgeable, 'acknowledge')}>
        <Check size={12} />Acknowledge {acknowledgeable.length} shown
      </button>
      <label>Shelve for
        <select bind:value={shelveSeconds}>
          {#each gridAlarmShelveDurations as duration}<option value={duration.seconds}>{duration.label}</option>{/each}
        </select>
      </label>
    </div>
  {/if}

  <ul class="rows" aria-label="Grid alarms">
    {#each rows as row (row.id)}
      <li class="alarm {row.tone}" class:cleared={!row.active}>
        <span class="priority" title="Priority {row.priority}">{row.priorityLabel}</span>
        <div class="alarm-body">
          <div class="alarm-head">
            <strong>{row.title}</strong>
            <time title={row.timeDetail}>{row.time}</time>
          </div>
          <div class="alarm-asset">
            <span>{row.assetLabel}</span>
            {#if row.mapAssetId !== null}
              {@const assetId = row.mapAssetId}
              <button type="button" class="locate" title="Locate {row.assetLabel} on the map" aria-label="Locate {row.assetLabel} on the map" onclick={() => onLocate(assetId)}><LocateFixed size={12} /></button>
            {/if}
          </div>
          <p class="message">{row.message}</p>
          <div class="alarm-foot">
            <span class="state">{row.stateLabel}{row.occurrences > 1 ? ` · ${row.occurrences}×` : ''}{row.valueText === null ? '' : ` · ${row.valueText}`}</span>
            <span class="actions">
              {#each row.actions as action}
                <button type="button" disabled={pending !== null} onclick={() => void lifecycle([row.id], action)}>
                  {#if action === 'shelve'}<BellOff size={11} />{/if}{actionLabel[action]}
                </button>
              {/each}
            </span>
          </div>
        </div>
      </li>
    {:else}
      {#if result}<li class="empty">No {filter === 'all' ? '' : `${filter} `}alarms.</li>{/if}
    {/each}
  </ul>
  {#if result && result.total > result.alarms.length}<p class="empty">{result.total - result.alarms.length} more not shown.</p>{/if}
  {#if error}<p class="error">{error}</p>{/if}
</div>

<style>
  .alarm-list { display: flex; min-height: 0; flex: 1; flex-direction: column; gap: 8px; }
  .alarm-toolbar, .bulk, .alarm-counts { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .alarm-toolbar { justify-content: space-between; }
  .filters { display: flex; gap: 4px; flex-wrap: wrap; }
  button { display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; color: inherit; border: 1px solid rgba(148,163,184,.4); border-radius: 999px; background: transparent; cursor: pointer; font-size: 11px; }
  button:disabled { opacity: .45; cursor: default; }
  .filters button.active { border-color: #3b82f6; background: rgba(59,130,246,.12); }
  .icon-button { border-radius: 5px; padding: 5px; }
  .alarm-counts { font-size: 11px; color: #64748b; }
  .count { padding: 1px 6px; border-radius: 3px; font-weight: 700; color: #fff; }
  .count.critical { background: #dc2626; } .count.warning { background: #d97706; } .count.notice { background: #64748b; }
  .bulk label { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: #64748b; }
  .bulk select { padding: 3px 4px; color: inherit; border: 1px solid rgba(148,163,184,.4); border-radius: 4px; background: transparent; font: inherit; }
  .rows { min-height: 0; flex: 1; overflow: auto; margin: 0; padding: 0; list-style: none; border: 1px solid rgba(148,163,184,.35); border-radius: 5px; }
  .alarm { display: grid; grid-template-columns: 30px minmax(0, 1fr); gap: 8px; padding: 8px; border-bottom: 1px solid rgba(148,163,184,.22); border-left: 3px solid transparent; }
  .alarm.critical { border-left-color: #dc2626; } .alarm.warning { border-left-color: #d97706; } .alarm.notice { border-left-color: #94a3b8; }
  .alarm.cleared { opacity: .72; }
  .priority { align-self: start; padding: 2px 0; text-align: center; border-radius: 3px; color: #fff; font-size: 10px; font-weight: 800; }
  .critical .priority { background: #dc2626; } .warning .priority { background: #d97706; } .notice .priority { background: #64748b; }
  .alarm-body { min-width: 0; }
  .alarm-head { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; }
  .alarm-head time { flex: 0 0 auto; color: #64748b; font-variant-numeric: tabular-nums; font-size: 11px; }
  .alarm-asset { display: flex; align-items: center; gap: 4px; min-width: 0; font-size: 11px; color: #64748b; }
  .alarm-asset span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .locate { padding: 2px; border: 0; border-radius: 3px; }
  .locate:hover, .locate:focus-visible { background: rgba(148,163,184,.16); }
  .message { margin: 3px 0; font-size: 11px; overflow-wrap: anywhere; }
  .alarm-foot { display: flex; justify-content: space-between; align-items: center; gap: 6px; flex-wrap: wrap; }
  .state { color: #64748b; font-size: 10px; }
  .actions { display: inline-flex; gap: 4px; }
  .actions button { padding: 2px 7px; font-size: 10px; }
  .empty { margin: 8px; color: #64748b; font-size: 11px; list-style: none; }
  .error { margin: 0; color: #dc2626; font-size: 11px; }
  :global(.dark) .alarm-counts, :global(.dark) .alarm-asset, :global(.dark) .state, :global(.dark) .alarm-head time { color: #94a3b8; }
</style>
