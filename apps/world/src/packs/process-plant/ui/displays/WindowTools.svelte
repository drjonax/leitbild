<script lang="ts">
  import { ChevronDown, History, X, Zap } from 'lucide-svelte'
  import type { PackWindowToolsProps } from '../../../../core/packs/protocol.ts'
  import { invokeSimulationRunCapability } from '../../../../ui/simulation-run-client.ts'
  import { runOnMount } from '../../../../ui/svelte-lifecycle.svelte.ts'
  import { processPlantActionInvokeCommandKind } from '../../command-kinds.ts'
  import type { ProcessPlantActionCatalogEntry } from '../plant-client.ts'
  import type { ProposalListEntry } from './operation/operation-presenter.ts'
  import OperationsLogDialog from './window/OperationsLogDialog.svelte'
  import PlantActionsDialog from './window/PlantActionsDialog.svelte'
  import ProposalsChip from './window/ProposalsChip.svelte'
  import { readPendingProposals, readWindowPlant, type WindowPlant } from './window/window-operations.ts'

  // The Plant's tools in the display window's header, for the Plant whose
  // display the window shows (PackUiContribution.windowTools): its pending
  // proposals with their count, read every two seconds (QA-10), each opening
  // its item's World default after the shown display, where the item's
  // pop-over carries the card; the operations log; and, apart under their own
  // label, the Instructor's scenario events and faults, which are not operator
  // actions. The window keeps one of these per Plant it shows.

  let { runId, objectId, openDisplay }: PackWindowToolsProps = $props()

  const PROPOSALS_EVERY_MS = 2_000
  const menuId = $props.id()

  let plant = $state.raw<WindowPlant | null>(null)
  let unavailable = $state<string | null>(null)
  let proposals = $state.raw<ReadonlyArray<ProposalListEntry>>([])
  let menuOpen = $state(false)
  let actionsOpen = $state(false)
  let logOpen = $state(false)
  let runningActionId = $state<string | null>(null)
  // What became of the last Instructor action or read: sent reads neutral, accepted as success, anything else as an error.
  let notice = $state<{ readonly text: string; readonly tone: 'neutral' | 'success' | 'error' } | null>(null)
  let menuButton = $state<HTMLButtonElement | null>(null)
  let logButton = $state<HTMLButtonElement | null>(null)
  let menuElement = $state<HTMLElement | null>(null)
  let disposed = false

  const errorText = (err: unknown): string => err instanceof Error ? err.message : String(err)

  $effect(() => {
    const plantId = objectId
    plant = null
    unavailable = null
    proposals = []
    readWindowPlant(runId, plantId).then(
      read => { if (!disposed && objectId === plantId) plant = read },
      err => { if (!disposed && objectId === plantId) unavailable = `The Plant cannot be read: ${errorText(err)}` },
    )
    let reading = false
    const read = async (): Promise<void> => {
      if (reading) return
      reading = true
      try {
        proposals = await readPendingProposals(runId, plantId)
      } catch (err) {
        notice = { text: `Pending proposals cannot be read: ${errorText(err)}`, tone: 'error' }
      } finally {
        reading = false
      }
    }
    void read()
    const timer = setInterval(() => { void read() }, PROPOSALS_EVERY_MS)
    return () => clearInterval(timer)
  })

  const closeMenu = (returnFocus: boolean): void => {
    if (!menuOpen) return
    menuOpen = false
    if (returnFocus) menuButton?.focus()
  }

  const openActions = (): void => {
    menuOpen = false
    if (plant !== null) actionsOpen = true
  }

  const closeActions = (): void => {
    actionsOpen = false
    menuButton?.focus()
  }

  const closeLog = (): void => {
    logOpen = false
    logButton?.focus()
  }

  const keydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !menuOpen) return
    event.preventDefault()
    event.stopPropagation()
    closeMenu(true)
  }

  // The display samples the Plant every second, so an action shows there without a reload; the notice says what
  // became of it: sent, then accepted or refused with the Plant's reason, or why it could not be sent.
  const runAction = async (target: WindowPlant, action: ProcessPlantActionCatalogEntry, parameters: Readonly<Record<string, number>>): Promise<void> => {
    if (runningActionId !== null) return
    actionsOpen = false
    runningActionId = action.id
    const named = `Instructor action "${action.title}" on ${target.label}`
    notice = { text: `${named}: sent…`, tone: 'neutral' }
    try {
      const response = await invokeSimulationRunCapability(runId, {
        capabilityId: processPlantActionInvokeCommandKind,
        input: { plantId: target.plantId, actionId: action.id, parameters },
      })
      if (response.kind !== 'command') throw new Error(`${processPlantActionInvokeCommandKind} is not a command`)
      if (!disposed) notice = response.result.ok ? { text: `${named}: accepted.`, tone: 'success' } : { text: `${named}: refused. ${response.result.reason}`, tone: 'error' }
    } catch (err) {
      if (!disposed) notice = { text: `${named} could not be sent: ${errorText(err)}`, tone: 'error' }
    } finally {
      if (!disposed) runningActionId = null
    }
  }

  runOnMount(() => {
    const outside = (event: PointerEvent): void => {
      const target = event.target
      if (!menuOpen || !(target instanceof Node)) return
      if (menuElement?.contains(target) || menuButton?.contains(target)) return
      menuOpen = false
    }
    document.addEventListener('pointerdown', outside, true)
    return () => {
      disposed = true
      document.removeEventListener('pointerdown', outside, true)
    }
  })
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="display-window-plant" role="group" aria-label="Plant" onkeydown={keydown}>
  <ProposalsChip entries={proposals} open={entry => openDisplay(`${objectId}#${entry.item}`)} />
  <button
    bind:this={logButton}
    type="button"
    class="display-window-button"
    aria-label={plant !== null ? `Operations log of ${plant.label}` : `Operations log unavailable: ${unavailable ?? 'the Plant is still being read'}`}
    title={plant !== null ? `Operations log of ${plant.label}: what people and AI agents did and proposed` : (unavailable ?? '')}
    aria-disabled={plant === null}
    onclick={() => { if (plant !== null) logOpen = true }}
  >
    <History size={17} aria-hidden="true" />
  </button>
</div>
<!-- The instructor's tools sit apart from the operator's, under their own label: injecting a fault is not an operator action. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="display-window-instructor" role="group" aria-label="Instructor" onkeydown={keydown}>
  <button
    bind:this={menuButton}
    type="button"
    class="display-window-instructor-button"
    aria-haspopup="menu"
    aria-expanded={menuOpen}
    aria-controls={menuOpen ? menuId : undefined}
    title="Instructor tools: scenario events and faults"
    onclick={() => { menuOpen = !menuOpen }}
  >
    <Zap size={15} aria-hidden="true" />
    <span>Instructor</span>
    <ChevronDown size={14} aria-hidden="true" />
  </button>
  {#if menuOpen}
    <div bind:this={menuElement} id={menuId} class="display-window-popover instructor" role="menu" aria-label="Instructor">
      <button
        type="button"
        class="display-window-menu-item"
        role="menuitem"
        title={plant !== null ? '' : (unavailable ?? '')}
        aria-disabled={plant === null}
        onclick={openActions}
      >
        <Zap size={16} aria-hidden="true" />
        <span>{plant !== null ? `Scenario events and faults on ${plant.label}…` : `Scenario events and faults: ${unavailable ?? 'the Plant is still being read'}`}</span>
      </button>
    </div>
  {/if}
</div>

{#if notice !== null}
  <div class="process-display-notice tools-notice" class:neutral={notice.tone === 'neutral'} class:success={notice.tone === 'success'} role="status">
    <span>{notice.text}</span>
    <button type="button" aria-label="Dismiss" onclick={() => { notice = null }}><X size={16} aria-hidden="true" /></button>
  </div>
{/if}

{#if logOpen && plant !== null}
  <OperationsLogDialog simulationRunId={runId} {plant} close={closeLog} />
{/if}

{#if actionsOpen && plant !== null}
  <PlantActionsDialog
    simulationRunId={runId}
    {plant}
    {runningActionId}
    run={(target, action, parameters) => { void runAction(target, action, parameters) }}
    close={closeActions}
  />
{/if}

<style>
  /* Below the header, over the display, as the window's own notices stand. */
  .tools-notice { top: 50px; }
</style>
