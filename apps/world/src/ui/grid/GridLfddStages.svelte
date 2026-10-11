<script lang="ts">
  import type { SimulationRunId } from '../../core/model/index.ts'
  import { gridRearmLfddStageCommandKind, gridRestoreLfddStageCommandKind } from '../../packs/electric-grid/commands/frequency.ts'
  import type { GridIslandsResult } from '../../packs/electric-grid/queries/islands.ts'
  import { invokeSimulationRunCapability } from '../simulation-run-client.ts'

  interface Props {
    readonly simulationRunId: SimulationRunId
    readonly gridId: string
    readonly islands: GridIslandsResult['islands']
    /** Called after an accepted command, so the panel reloads its islands. */
    readonly onChanged: () => void
  }

  const { simulationRunId, gridId, islands, onChanged }: Props = $props()

  let pending = $state<string | null>(null)
  let status = $state<string | null>(null)

  // Islands with a stage that is not armed: latched (operated) or restored but not yet re-armed.
  const latched = $derived(islands.flatMap(island => {
    const stages = island.lfddStages.filter(stage => stage.status !== 'armed')
    return stages.length === 0 ? [] : [{ island, stages }]
  }))

  const send = async (kind: string, islandId: string, stageId: string): Promise<void> => {
    pending = `${kind}|${islandId}|${stageId}`
    try {
      const response = await invokeSimulationRunCapability(simulationRunId, { capabilityId: kind, input: { gridId, islandId, stageId } })
      if (response.kind !== 'command') throw new Error(`Capability ${kind} is not a command`)
      if (!response.result.ok) throw new Error(response.result.reason ?? 'LFDD command rejected')
      status = null
      onChanged()
    } catch (error) {
      status = error instanceof Error ? error.message : String(error)
    } finally {
      pending = null
    }
  }
</script>

{#if latched.length > 0}
  <div class="lfdd">
    <h3>Under-frequency load shedding</h3>
    <p class="hint">An operated stage stays latched until restored; a restored stage stays disarmed until re-armed, so step-wise restoration cannot trip it again.</p>
    {#each latched as entry (entry.island.id)}
      <div class="island">
        <span class="island-name">{entry.island.anchorBus.label}{entry.island.frequencyHz === null ? '' : ` · ${entry.island.frequencyHz.toFixed(3)} Hz`}</span>
        {#each entry.stages as stage (stage.id)}
          <div class="stage" class:operated={stage.status === 'operated'}>
            <span>{stage.id} · {stage.thresholdHz.toFixed(2)} Hz · {stage.status === 'operated' ? `operated, ${stage.disconnectedMw.toLocaleString('en-GB')} MW disconnected` : 'restored, disarmed'}</span>
            {#if stage.status === 'operated'}
              <button type="button" disabled={pending !== null} onclick={() => void send(gridRestoreLfddStageCommandKind, entry.island.id, stage.id)}>Restore feeders</button>
            {:else}
              <button type="button" disabled={pending !== null} onclick={() => void send(gridRearmLfddStageCommandKind, entry.island.id, stage.id)}>Re-arm</button>
            {/if}
          </div>
        {/each}
      </div>
    {/each}
    {#if status}<p class="error">{status}</p>{/if}
  </div>
{/if}

<style>
  .lfdd { margin-bottom: 14px; }
  h3 { margin: 0 0 6px; font-size: 12px; text-transform: uppercase; color: #475569; }
  .hint { margin: 0 0 6px; color: #64748b; font-size: 11px; }
  .island { padding: 4px 0; border-top: 1px solid rgba(148,163,184,.22); font-size: 11px; }
  .island-name { display: block; font-weight: 650; }
  .stage { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 3px 0 3px 8px; border-left: 3px solid #94a3b8; }
  .stage.operated { border-left-color: #dc2626; }
  button { flex: 0 0 auto; padding: 3px 8px; color: inherit; border: 1px solid rgba(148,163,184,.4); border-radius: 999px; background: transparent; cursor: pointer; font-size: 11px; }
  button:disabled { opacity: .5; cursor: default; }
  .error { margin: 4px 0 0; color: #dc2626; font-size: 11px; }
  :global(.dark) h3, :global(.dark) .hint { color: #94a3b8; }
</style>
