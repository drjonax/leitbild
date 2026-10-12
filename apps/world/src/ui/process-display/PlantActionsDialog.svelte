<script lang="ts">
  import { untrack } from 'svelte'
  import { Play, X } from 'lucide-svelte'
  import type { SimulationRunId } from '../../core/model/index.ts'
  import { runOnMount } from '../svelte-lifecycle.svelte.ts'
  import { readProcessPlantCatalog, type ProcessPlantActionCatalogEntry } from './process-display-client.ts'
  import type { DeckPlant } from './display-deck.ts'

  // The instructor's actions on one Plant: the Pack's scenario and fault
  // catalogue (a turbine trip, a stuck valve, a tube leak), each applied
  // through the validated write path. They are not operator controls, so the
  // dialog says so. It names the Plant it acts on, which is fixed when it
  // opens: the window may step to a display of another Plant meanwhile, and an
  // action must never land on a Plant the instructor did not see named.

  interface Props {
    readonly simulationRunId: SimulationRunId
    readonly plant: DeckPlant
    readonly runningActionId: string | null
    readonly run: (plant: DeckPlant, action: ProcessPlantActionCatalogEntry, parameters: Readonly<Record<string, number>>) => void
    readonly close: () => void
  }

  let { simulationRunId, plant, runningActionId, run, close }: Props = $props()

  const target = untrack(() => plant)
  const runId = untrack(() => simulationRunId)

  let actions = $state<ReadonlyArray<ProcessPlantActionCatalogEntry> | null>(null)
  let loading = $state(false)
  let loadError = $state<string | null>(null)
  let inputs = $state<Record<string, Record<string, number>>>({})
  let dialog = $state<HTMLElement | null>(null)
  let disposed = false

  const loadActions = async (): Promise<void> => {
    if (loading) return
    loading = true
    loadError = null
    try {
      const catalog = await readProcessPlantCatalog(runId)
      if (disposed) return
      actions = catalog.actions
      inputs = Object.fromEntries(catalog.actions.map(action => [
        action.id,
        Object.fromEntries(action.parameters.map(parameter => [parameter.id, parameter.defaultValue])),
      ]))
    } catch (err) {
      if (!disposed) loadError = err instanceof Error ? err.message : String(err)
    } finally {
      if (!disposed) loading = false
    }
  }

  const updateInput = (actionId: string, fieldId: string, value: number): void => {
    inputs = { ...inputs, [actionId]: { ...(inputs[actionId] ?? {}), [fieldId]: value } }
  }

  const keydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    close()
  }

  runOnMount(() => {
    dialog?.focus()
    void loadActions()
    return () => {
      disposed = true
    }
  })
</script>

<div class="process-transient-backdrop" role="presentation" onmousedown={close}>
  <div
    bind:this={dialog}
    class="process-transient-modal"
    role="dialog"
    aria-modal="true"
    aria-label="Instructor actions on {target.label}"
    tabindex="-1"
    onmousedown={(event) => event.stopPropagation()}
    onkeydown={keydown}
  >
    <header class="process-transient-header">
      <div>
        <strong>Instructor actions · {target.label}</strong>
        <span>Scenario events and faults for training, applied to {target.label} through the validated write path. Not operator controls.</span>
      </div>
      <button type="button" aria-label="Close Instructor actions" title="Close" onclick={close}>
        <X size={18} aria-hidden="true" />
      </button>
    </header>
    <div class="process-transient-list">
      {#if loading}
        <p role="status">Loading instructor actions…</p>
      {:else if loadError}
        <p role="alert">{loadError}</p>
        <button type="button" onclick={() => { void loadActions() }}>Retry</button>
      {:else if actions?.length === 0}
        <p>No instructor actions are available for {target.label}.</p>
      {/if}
      {#each actions ?? [] as action (action.id)}
        <article class="process-transient-row">
          <div class="process-transient-copy">
            <strong>{action.title}</strong>
            <span>{action.description}</span>
          </div>
          {#if action.parameters.length > 0}
            <div class="process-transient-fields">
              {#each action.parameters as field (field.id)}
                <label>
                  <span>{field.label}</span>
                  <input
                    type="number"
                    min={field.min}
                    max={field.max}
                    step={field.step}
                    value={(inputs[action.id]?.[field.id] ?? field.defaultValue).toFixed(field.digits)}
                    oninput={(event) => updateInput(action.id, field.id, Number.parseFloat(event.currentTarget.value))}
                  />
                  <small>{field.unit}</small>
                </label>
              {/each}
            </div>
          {/if}
          <button
            type="button"
            class="process-transient-play"
            aria-label="Run {action.title} on {target.label}"
            title="Run {action.title} on {target.label}"
            disabled={runningActionId !== null}
            onclick={() => run(target, action, inputs[action.id] ?? {})}
          >
            <Play size={18} fill="currentColor" aria-hidden="true" />
          </button>
        </article>
      {/each}
    </div>
  </div>
</div>
