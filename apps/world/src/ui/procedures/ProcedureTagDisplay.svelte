<script lang="ts">
  import { untrack } from 'svelte'
  import type { EmbeddedViewEnvelope, EmbeddedViewListing } from '@leitbild/contracts'
  import type { ProcedureTag, SimulationRunId } from '../../core/model/index.ts'
  import type { PackProcedureContribution } from '../../core/packs/protocol.ts'
  import { runOnMount } from '../svelte-lifecycle.svelte.ts'
  import { activeWorkspaceId } from '../workspace-context.ts'
  import { readProcedureTagValue, type ProcedureTagValidation, type ProcedureTagValue } from './procedure-client.ts'
  import {
    createTagFrameHost,
    procedureTagBindingLine,
    procedureTagDeclared,
    procedureTagDisplayPlan,
    procedureTagDisplaySource,
    procedureTagReadingText,
  } from './procedure-tag-display.ts'
  import { defaultDisplayEnvelope, readDefaultDisplay } from '../process-display/default-display.ts'

  // A clicked procedure tag: World's live default display of the tag on its
  // unit, framed read-only over the procedure, with the tag's reading above
  // it. Where no display can be drawn, the dialog says why.

  interface Props {
    readonly simulationRunId: SimulationRunId
    /** The unit the procedure runs for: the Pack's scope id its tags are read in. */
    readonly plantId: string
    readonly unitLabel: string
    readonly tag: ProcedureTag
    /** The tag's validation against the unit's model; undefined while it has not been checked. */
    readonly validation: ProcedureTagValidation | undefined
    readonly provider: PackProcedureContribution
    readonly close: () => void
    /** Opens the shown display in the Workspace's display window, where one is offered. */
    readonly openInDisplayWindow?: (envelope: EmbeddedViewEnvelope) => void
    /** Opens a view the display asks for (its pop-over's "Open in the display window") in that window, as given. */
    readonly openView?: (view: EmbeddedViewListing) => void
  }

  let { simulationRunId, plantId, unitLabel, tag, validation, provider, close, openInDisplayWindow, openView }: Props = $props()

  // How often the header reads the tag while the dialog is open.
  const READ_EVERY_MS = 2_000

  const titleId = $props.id()
  const plan = $derived(procedureTagDisplayPlan(plantId, tag.id, validation))
  const declared = $derived(procedureTagDeclared(tag))

  let reading = $state<ProcedureTagValue | null>(null)
  let readingError = $state<string | null>(null)
  const bindingLine = $derived(procedureTagBindingLine(validation, reading))

  type DrawPhase =
    | { readonly kind: 'drawing' }
    | { readonly kind: 'refused'; readonly reason: string }
    | { readonly kind: 'shown'; readonly envelope: EmbeddedViewEnvelope; readonly source: string }
  // The display last asked for, by its view and state, and how drawing it went.
  let drawn = $state<{ readonly key: string; readonly phase: DrawPhase } | null>(null)

  let dialog = $state<HTMLElement | null>(null)
  let frameBox = $state<HTMLElement | null>(null)
  let frame = $state<HTMLIFrameElement | null>(null)
  // The frame learns that this page relays what it opens; what it asks to open goes to the display window.
  const frameHost = createTagFrameHost({
    origin: location.origin,
    frame: () => frame?.contentWindow ?? null,
    post: (target, message) => { (target as Window).postMessage(message, location.origin) },
    open: view => { openView?.(view) },
  })
  let disposed = false

  const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

  // Composed first: a display World cannot compose is refused with its reason, never framed empty.
  const draw = async (key: string, subject: string): Promise<void> => {
    try {
      const envelope = defaultDisplayEnvelope({ workspaceId: activeWorkspaceId(), simulationRunId, view: await readDefaultDisplay(simulationRunId, subject) })
      if (!disposed && drawn?.key === key) drawn = { key, phase: { kind: 'shown', envelope, source: procedureTagDisplaySource(envelope) } }
    } catch (error) {
      if (!disposed && drawn?.key === key) drawn = { key, phase: { kind: 'refused', reason: messageOf(error) } }
    }
  }

  // Draws the display the tag names once its frame is laid out, and again only if the tag comes to name another.
  $effect(() => {
    if (plan.kind !== 'display' || frameBox === null) return
    const key = plan.subject
    if (untrack(() => drawn?.key) === key) return
    drawn = { key, phase: { kind: 'drawing' } }
    void draw(key, key)
  })

  let readInFlight = false
  const read = async (): Promise<void> => {
    if (readInFlight || disposed || validation?.status === 'missing') return
    readInFlight = true
    try {
      const value = await readProcedureTagValue(simulationRunId, plantId, tag, provider)
      if (!disposed) {
        reading = value
        readingError = null
      }
    } catch (error) {
      if (!disposed) {
        reading = null
        readingError = messageOf(error)
      }
    } finally {
      readInFlight = false
    }
  }

  runOnMount(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog?.focus()
    void read()
    const timer = setInterval(() => { void read() }, READ_EVERY_MS)
    const receive = (event: MessageEvent): void => frameHost.receive(event)
    window.addEventListener('message', receive)
    return () => {
      disposed = true
      clearInterval(timer)
      window.removeEventListener('message', receive)
      if (opener?.isConnected) opener.focus()
    }
  })

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    event.preventDefault()
    close()
  }

  const shown = $derived(drawn?.phase.kind === 'shown' ? drawn.phase : null)
  // What says only why nothing is drawn takes the room of its words, not a display's.
  const compact = $derived(plan.kind !== 'display' || drawn?.phase.kind === 'refused')
</script>

{#snippet readingText()}
  {#if validation?.status === 'missing'}
    <span>No reading: the tag has no signal in this unit's model.</span>
  {:else if reading}
    <span>Reads <b>{procedureTagReadingText(reading)}</b></span>
  {:else if readingError}
    <span class="procedure-tag-display-error">Reading unavailable: {readingError}</span>
  {:else}
    <span>Reading…</span>
  {/if}
{/snippet}

<div class="procedure-tag-display-backdrop" role="presentation" onmousedown={close}>
  <div
    bind:this={dialog}
    class="procedure-tag-display"
    class:compact
    role="dialog"
    aria-modal="true"
    aria-labelledby={titleId}
    tabindex="-1"
    onmousedown={(event) => event.stopPropagation()}
    onkeydown={onKeydown}
  >
    <header class="procedure-tag-display-header">
      <div class="procedure-tag-display-identity">
        <h2 id={titleId}>{tag.id}</h2>
        {#if tag.description}<span class="procedure-tag-display-description">{tag.description}</span>{/if}
        <span class="procedure-tag-display-unit">{unitLabel}</span>
      </div>
      <div class="procedure-tag-display-reading" aria-live="polite">
        <span class="procedure-tag-display-value">
          {#if validation?.status === 'missing'}—{:else if reading}{procedureTagReadingText(reading)}{:else if readingError}unavailable{:else}…{/if}
        </span>
        <small title={bindingLine}>{bindingLine}</small>
      </div>
      <div class="procedure-tag-display-actions">
        {#if openInDisplayWindow && shown}
          <button type="button" onclick={() => { if (shown) openInDisplayWindow(shown.envelope) }}>Open in display window</button>
        {/if}
        <button type="button" class="procedure-tag-display-close" aria-label="Close" onclick={close}>×</button>
      </div>
    </header>
    <div class="procedure-tag-display-body">
      {#if plan.kind === 'display' && drawn?.phase.kind === 'refused'}
        <div class="procedure-tag-display-message">
          <strong>No process display: {drawn.phase.reason}</strong>
          {@render readingText()}
        </div>
      {:else if plan.kind === 'display'}
        <div class="procedure-tag-display-frame" bind:this={frameBox}>
          {#if drawn?.phase.kind === 'shown'}
            <!-- No display window presents it, so it shows no Pack controls; this dialog relays what it opens (its pop-over's "Open in the display window") to the Workspace's display window. -->
            <iframe
              bind:this={frame}
              src={drawn.phase.source}
              title={drawn.phase.envelope.title}
              allow="camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'"
              referrerpolicy="same-origin"
            ></iframe>
          {:else}
            <p class="procedure-tag-display-message" role="status">Drawing the process display…</p>
          {/if}
        </div>
      {:else}
        <div class="procedure-tag-display-message">
          <strong>{plan.message}</strong>
          {#if declared}<span>The procedure declares: {declared}</span>{/if}
          {#if plan.kind !== 'not-in-model'}{@render readingText()}{/if}
        </div>
      {/if}
    </div>
  </div>
</div>
