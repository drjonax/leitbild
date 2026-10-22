<script lang="ts">
  import { untrack } from 'svelte'
  import { ClipboardList, Gamepad2, MonitorCog, Settings2, X } from 'lucide-svelte'
  import type { OperationalObject } from '../core/model/index.ts'
  import type { PackObjectField, PackObjectPresentation, PackObjectStatusPresentation } from '../core/packs/protocol.ts'
  import IconButton from './components/IconButton.svelte'
  import InlineConfirmation from './components/InlineConfirmation.svelte'
  import StatusIndicator from './components/StatusIndicator.svelte'
  import { processPlantIdForObject } from '../packs/process-plant/model.ts'
  import ProcedureRunBadges from './procedures/ProcedureRunBadges.svelte'
  import type { ProcedureRunSummary, ProcedureRunSummaryGroup } from './procedures/procedure-run-selectors.ts'

  const emptyProcedureRunSummaries: ProcedureRunSummaryGroup = { active: [], inactive: [] }

  interface Props {
    readonly object: OperationalObject
    readonly presentation: PackObjectPresentation
    readonly statusPresentation: PackObjectStatusPresentation
    readonly selected: boolean
    /** Its card is open: the row reads as selected and its tooltip stays away from the card. */
    readonly cardOpen?: boolean
    readonly hasNewInfo: boolean
    readonly visibleFields: ReadonlyArray<PackObjectField>
    readonly markSeen: (object: OperationalObject) => void
    readonly selectObject: (object: OperationalObject) => void
    /** Absent where this screen may not delete: a role Run's operator-class role sets. */
    readonly deleteObject?: ((object: OperationalObject) => Promise<void>) | undefined
    readonly detailPresentationFor?: ((object: OperationalObject) => PackObjectPresentation | Promise<PackObjectPresentation>) | undefined
    readonly openProcessDisplay?: ((object: OperationalObject) => void) | undefined
    readonly openProcedureSystem?: ((object: OperationalObject) => void) | undefined
    readonly openProcedureSystemAt?: ((object: OperationalObject, summary?: ProcedureRunSummary) => void) | undefined
    readonly openDroneControl?: ((object: OperationalObject) => void) | undefined
    readonly openDroneProfileEditor?: ((object: OperationalObject) => void) | undefined
    readonly procedureSummaries?: ProcedureRunSummaryGroup | undefined
    readonly proceduresVisible: boolean
  }

  let {
    object,
    presentation,
    statusPresentation,
    selected,
    cardOpen = false,
    hasNewInfo,
    visibleFields,
    markSeen,
    selectObject,
    deleteObject,
    detailPresentationFor,
    openProcessDisplay,
    openProcedureSystem,
    openProcedureSystemAt,
    openDroneControl,
    openDroneProfileEditor,
    procedureSummaries = emptyProcedureRunSummaries,
    proceduresVisible,
  }: Props = $props()

  let newInfoBadge: HTMLButtonElement | null = $state(null)
  let newInfoTooltipVisible = $state(false)
  let newInfoTooltipPosition = $state({ left: 0, top: 0, width: 250 })
  let detailPresentation: PackObjectPresentation | null = $state(null)
  let detailPresentationKey: string | null = $state(null)
  let detailObjectId: string | null = $state(null)
  let detailHovered = $state(false)
  let detailFocused = $state(false)
  // Deleting a live object asks first, inside the row.
  let deleteRequestedFor = $state<string | null>(null)
  let deleteToggle = $state<HTMLElement | null>(null)
  const deleteRequested = $derived(deleteRequestedFor === object.id)

  const newInfoSummary = $derived(
    presentation.fields.length === 0
      ? presentation.summary
      : presentation.fields.map(field => `${field.label}: ${field.value}`).join(' · '),
  )
  const currentPresentationKey = $derived(`${object.id}:${object.revision}`)
  const activeDetailPresentation = $derived(
    detailObjectId === object.id && detailPresentation !== null
      ? detailPresentation
      : presentation,
  )

  let loadingDetailKey: string | null = null
  const loadDetailPresentation = async (): Promise<void> => {
    const key = currentPresentationKey
    if ((detailPresentationKey === key && detailPresentation !== null) || loadingDetailKey === key) return
    loadingDetailKey = key
    try {
      const next = await (detailPresentationFor?.(object) ?? presentation)
      if (key !== currentPresentationKey) return
      detailPresentation = next
      detailPresentationKey = key
      detailObjectId = object.id
    } catch (error) {
      if (key !== currentPresentationKey) return
      detailPresentation = { ...presentation, fields: [...presentation.fields, { key: 'context-error', label: 'Context unavailable', value: error instanceof Error ? error.message : String(error) }] }
      detailPresentationKey = key
      detailObjectId = object.id
    } finally { if (loadingDetailKey === key) loadingDetailKey = null }
  }

  $effect(() => {
    if (!detailHovered && !detailFocused) return
    currentPresentationKey
    untrack(() => { void loadDetailPresentation() })
  })

  const showNewInfoTooltip = (): void => {
    if (!newInfoBadge) return
    const rect = newInfoBadge.getBoundingClientRect()
    const margin = 12
    const desiredWidth = 250
    const width = Math.min(desiredWidth, Math.max(180, window.innerWidth - margin * 2))
    const left = Math.min(rect.left, window.innerWidth - width - margin)
    newInfoTooltipPosition = {
      left: Math.max(margin, left),
      top: rect.bottom + 6,
      width,
    }
    newInfoTooltipVisible = true
  }

  const acknowledgeNewInfo = (): void => {
    if (!hasNewInfo) return
    newInfoTooltipVisible = false
    markSeen(object)
  }

  const processDisplayAvailable = $derived(object.packId === 'process-plant' && openProcessDisplay !== undefined)
  const processSystemIdAvailable = $derived(processPlantIdForObject(object) !== null)
  const procedureSystemAvailable = $derived(
    object.packId === 'process-plant'
      && openProcedureSystem !== undefined
      && processSystemIdAvailable,
  )
  const droneControlAvailable = $derived(object.packId === 'drone' && openDroneControl !== undefined)
  const droneProfileEditorAvailable = $derived(object.packId === 'drone' && openDroneProfileEditor !== undefined)
  const confirmDelete = (): void => {
    deleteRequestedFor = null
    if (!deleteObject) throw new Error(`Deleting ${object.label} is not offered on this screen`)
    void deleteObject(object)
  }

  const openProcedureSummary = (summary: ProcedureRunSummary): void => {
    if (openProcedureSystemAt) {
      openProcedureSystemAt(object, summary)
      return
    }
    openProcedureSystem?.(object)
  }
</script>

<div
  class:selected={selected || cardOpen}
  class:has-new-info={hasNewInfo}
  class:muted={presentation.muted === true}
  class="object-row"
  role="button"
  tabindex="0"
  onmouseenter={() => { detailHovered = true }}
  onmouseleave={() => { detailHovered = false }}
  onfocus={() => { detailFocused = true }}
  onblur={() => { detailFocused = false }}
  onclick={() => selectObject(object)}
  onkeydown={(event) => {
    if (event.target !== event.currentTarget) return
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    selectObject(object)
  }}
>
  <div class="object-row-main">
    <span class="object-status">
      <StatusIndicator tone={statusPresentation.tone} label={statusPresentation.label} indicator={statusPresentation.indicator} />
    </span>
    <span class="object-row-content">
      <span class="row-title">
        <span
          class="row-title-text"
        >
          <span class="row-label">{object.label}</span>
          {#if !cardOpen}
            <span class="row-tooltip">
              <strong>{object.label}</strong>
              {#each activeDetailPresentation.fields as field}<span>{field.label}: {field.value}</span>{/each}
            </span>
          {/if}
        </span>
        {#if hasNewInfo}
          <button
            bind:this={newInfoBadge}
            class="new-info-dot"
            type="button"
            aria-label="Acknowledge new information for {object.label}"
            onmouseenter={showNewInfoTooltip}
            onfocus={showNewInfoTooltip}
            onclick={(event) => {
              event.stopPropagation()
              acknowledgeNewInfo()
            }}
            onmouseleave={acknowledgeNewInfo}
            onblur={acknowledgeNewInfo}
          >
            new
          </button>
        {/if}
        {#if processDisplayAvailable}
          <IconButton
            label="Open process display for {object.label}"
            title="Open process display"
            icon={MonitorCog}
            size={13}
            variant="bare"
            onClick={() => openProcessDisplay?.(object)}
          />
        {/if}
        {#if procedureSystemAvailable}
          <IconButton
            label="Open procedures for {object.label}"
            title="Open procedures"
            icon={ClipboardList}
            size={13}
            variant="bare"
            onClick={() => openProcedureSystem?.(object)}
          />
        {/if}
        {#if droneControlAvailable}
          <IconButton
            label="Open drone flight window for {object.label}"
            title="Drone flight window"
            icon={Gamepad2}
            size={13}
            variant="bare"
            onClick={() => openDroneControl?.(object)}
          />
        {/if}
        {#if droneProfileEditorAvailable}
          <IconButton
            label="Open drone profile editor for {object.label}"
            title="Drone profile editor"
            icon={Settings2}
            size={13}
            variant="bare"
            onClick={() => openDroneProfileEditor?.(object)}
          />
        {/if}
      </span>
    </span>
  </div>
  {#if deleteObject}
    <span class="row-delete-toggle" bind:this={deleteToggle}>
      <IconButton
        label="Delete {object.label}"
        title="Delete {object.label}"
        icon={X}
        size={13}
        variant="bare"
        onClick={() => { deleteRequestedFor = deleteRequested ? null : object.id }}
      />
    </span>
  {/if}
  {#if visibleFields.length > 0}
    <div class="object-row-details">
      {#each visibleFields as field (field.key)}
        <span class="object-meta"><strong>{field.label}:</strong> {field.value}</span>
      {/each}
    </div>
  {/if}
  {#if proceduresVisible && procedureSystemAvailable}
    <div class="object-row-procedures">
      <span>Procedures</span>
      <ProcedureRunBadges
        summaries={procedureSummaries}
        mode="rail"
        onOpen={openProcedureSummary}
      />
    </div>
  {/if}
</div>

<!-- Outside the row: a press on the question must not select the row, and a
     group of buttons must not sit inside the row's role="button". -->
{#if deleteRequested && deleteObject}
  <div class="row-delete-confirm">
    <InlineConfirmation
      question="Delete {object.label}?"
      confirmLabel="Delete"
      opener={deleteToggle}
      confirm={confirmDelete}
      cancel={() => { deleteRequestedFor = null }}
    />
  </div>
{/if}

{#if hasNewInfo && newInfoTooltipVisible}
  <div
    class="new-info-tooltip"
    style:left="{newInfoTooltipPosition.left}px"
    style:top="{newInfoTooltipPosition.top}px"
    style:width="{newInfoTooltipPosition.width}px"
  >
    <strong>New information</strong>
    <span>{newInfoSummary}</span>
  </div>
{/if}

<style>
  .row-delete-toggle {
    display: inline-flex;
  }

  /* Sits under its row in the rail, indented to the row's label. */
  .row-delete-confirm {
    padding: 4px 4px 5px 31px;
  }
</style>
