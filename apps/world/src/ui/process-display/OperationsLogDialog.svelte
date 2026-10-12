<script lang="ts">
  import { untrack } from 'svelte'
  import { X } from 'lucide-svelte'
  import type { SimulationRunId } from '../../core/model/index.ts'
  import type { OperationsLogRow } from '../embed/composed-display/operation/operation-presenter.ts'
  import { runOnMount } from '../svelte-lifecycle.svelte.ts'
  import type { DeckPlant } from './display-deck.ts'
  import { readOperationsLog } from './window-operations.ts'

  // The operations log of one Plant (plan §4.3): what people and AI agents
  // did to it and proposed, newest first: time, who, equipment, action, the
  // approval chain, and what came of it. Kept apart from the alarm list,
  // which says what the I&C did. It names the Plant it reads, fixed when it
  // opens, and reads again every two seconds while open.

  interface Props {
    readonly simulationRunId: SimulationRunId
    readonly plant: DeckPlant
    readonly close: () => void
  }

  let { simulationRunId, plant, close }: Props = $props()

  const target = untrack(() => plant)
  const runId = untrack(() => simulationRunId)
  const READ_EVERY_MS = 2_000

  let rows = $state.raw<ReadonlyArray<OperationsLogRow> | null>(null)
  let failure = $state<string | null>(null)
  let dialog = $state<HTMLElement | null>(null)

  const keydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    close()
  }

  runOnMount(() => {
    dialog?.focus()
    let stopped = false
    let reading = false
    const read = async (): Promise<void> => {
      if (reading) return
      reading = true
      try {
        const next = await readOperationsLog(runId, target.plantId)
        if (!stopped) { rows = next; failure = null }
      } catch (error) {
        if (!stopped) failure = error instanceof Error ? error.message : String(error)
      } finally {
        reading = false
      }
    }
    void read()
    const timer = setInterval(() => { void read() }, READ_EVERY_MS)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  })
</script>

<div class="process-transient-backdrop" role="presentation" onmousedown={close}>
  <div
    bind:this={dialog}
    class="process-transient-modal operations-log"
    role="dialog"
    aria-modal="true"
    aria-label="Operations log of {target.label}"
    tabindex="-1"
    onmousedown={(event) => event.stopPropagation()}
    onkeydown={keydown}
  >
    <header class="process-transient-header">
      <div>
        <strong>Operations log · {target.label}</strong>
        <span>What people and AI agents did and proposed, newest first; the last 64 commands. What the I&amp;C did is in the alarm list.</span>
      </div>
      <button type="button" aria-label="Close the operations log" title="Close" onclick={close}>
        <X size={18} aria-hidden="true" />
      </button>
    </header>
    <div class="process-transient-list">
      {#if failure !== null}<p role="alert">The operations log cannot be read: {failure}</p>{/if}
      {#if rows === null}
        {#if failure === null}<p role="status">Reading the operations log…</p>{/if}
      {:else if rows.length === 0}
        <p>No person or AI agent has operated anything on {target.label} or proposed anything for it yet.</p>
      {:else}
        <table>
          <thead><tr><th scope="col">Time</th><th scope="col">Who</th><th scope="col">Equipment</th><th scope="col">Action</th><th scope="col">How</th><th scope="col">Result</th></tr></thead>
          <tbody>
            {#each rows as row (row.key)}
              <tr><td class="time">{row.time}</td><td>{row.who}</td><td>{row.equipment}</td><td class="action">{row.action}</td><td>{row.chain}</td><td>{row.result}</td></tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>
  </div>
</div>

<style>
  .operations-log { width: min(980px, calc(100% - 32px)); }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; font-weight: 600; padding: 4px 6px; border-bottom: 1px solid var(--border-divider-color, currentColor); white-space: nowrap; }
  td { padding: 4px 6px; vertical-align: top; border-bottom: 1px solid var(--border-divider-color, transparent); }
  .time { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .action { font-weight: 600; }
</style>
