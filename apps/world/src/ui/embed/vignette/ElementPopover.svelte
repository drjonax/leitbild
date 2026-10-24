<script lang="ts">
  import type { EmbeddedViewEnvelope } from '@leitbild/contracts'
  import type { Component } from 'svelte'
  import { objectIdSchema, type SimulationRunId } from '../../../core/model/index.ts'
  import type { PackElementActionsProps } from '../../../core/packs/protocol.ts'
  import type { Palette } from '../../displays/severity.ts'
  import { defaultDisplayEnvelope, readDefaultDisplay } from '../../process-display/default-display.ts'
  import { runOnMount } from '../../svelte-lifecycle.svelte.ts'
  import { activeWorkspaceId } from '../../workspace-context.ts'
  import { loadEmbedPack } from '../pack-embed-loader.ts'
  import { embeddedDisplayFrame, type DisplayOpening } from '../view-host.ts'
  import { VIGNETTE_ROW_PX } from './grid.ts'
  import { elementOffer, elementParts, openElementDefault, popoverPlacement, popoverRoom, POPOVER_WIDTH, type OpenedFrom } from './popover.ts'
  import Sections from './Sections.svelte'
  import { createVignetteSession, sampleStale, vignetteRoutes, type VignetteSnapshot } from './vignette-client.ts'

  // An element's pop-over (architecture B3) in OpenBridge's toggletip, titled
  // by the element: its World default (the vignette the composer gives it,
  // its topologies left to the drawing it opened from), and under it what
  // its display's place offers (popover.ts elementOffer). In the display
  // window, the element's actions: the panel its Pack contributes to the
  // embed, mounted with the Run, the object and the element. In a chat
  // answer or a procedure tag's dialog, "Open in the display window", which
  // opens the element's default there in one press; in a frame no page hosts,
  // a line saying where it is operated. It stands beside its
  // item, never over it, at 100 % whatever the display's zoom. Focus moves
  // into it; Esc (unless a section claims it) closes it and gives the focus
  // back to the item, and a press outside it and its item closes it. It is
  // never taller than the page on screen (popoverRoom), its title fixed and
  // its body scrolling: in the display window the actions come first
  // (elementParts), so a pending proposal's Approve shows as it opens and the
  // default is scrolled to; elsewhere the default comes first and the way to
  // the display window stays pinned under it.
  let { runId, from, objectId, packId, elementId, name, anchor, text, zoom, palette, onclose }: {
    runId: SimulationRunId
    /** The display it opened from, as a listing of the element's default names it. */
    from: OpenedFrom
    objectId: string
    packId: string
    elementId: string
    name: string
    /** The item it opened from, and the item's text beside it, as the page shows them: it never covers either. */
    anchor: HTMLElement
    text: HTMLElement | null
    zoom: number
    palette: Palette
    onclose: (returnFocus: boolean) => void
  } = $props()

  let card: HTMLElement | undefined = $state()
  let content: HTMLElement | undefined = $state()
  let height = $state(160)
  /** The card's height beyond its content (its title, its padding), in its own px, as last measured. */
  let overhead = $state(0)
  let viewport = $state({ width: window.innerWidth, height: window.innerHeight })
  let snapshot = $state.raw<VignetteSnapshot>({ phase: 'connecting', series: new Map(), bands: new Map(), sampleError: null })
  let failure = $state<string | null>(null)
  let Actions = $state.raw<Component<PackElementActionsProps> | null>(null)
  let opening = $state<DisplayOpening | null>(null)
  const offer = $derived(elementOffer(opening))
  /** The element's default as the display window frames it; null until World composed it. */
  let envelope = $state.raw<EmbeddedViewEnvelope | null>(null)
  let wallNow = $state(Date.now())

  runOnMount(() => {
    let session: ReturnType<typeof createVignetteSession> | null = null
    let closed = false
    let actionsAsked = false
    void readDefaultDisplay(runId, `${objectId}#${elementId}`).then(view => {
      if (closed) return
      envelope = defaultDisplayEnvelope({ workspaceId: activeWorkspaceId(), simulationRunId: runId, view })
      session = createVignetteSession({ runId, state: view.state, routes: vignetteRoutes, onChange: next => { snapshot = next } })
      session.start()
    }, (error: unknown) => { failure = error instanceof Error ? error.message : String(error) })
    // The Pack's actions load only once a display window presents this view: nowhere else is the element operated.
    const stopOpening = embeddedDisplayFrame().subscribeOpening(where => {
      opening = where
      if (elementOffer(where) !== 'actions' || actionsAsked) return
      actionsAsked = true
      void loadEmbedPack(packId).then(contribution => contribution?.elementActions?.()).then(module => { if (!closed && module !== undefined) Actions = module.default })
    })
    const tick = setInterval(() => { wallNow = Date.now() }, 1_000)
    const key = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || (event.target instanceof Element && event.target.closest('[data-claims-escape]') !== null)) return
      event.preventDefault()
      event.stopPropagation()
      onclose(true)
    }
    const down = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (target !== null && !card?.contains(target) && !anchor.contains(target)) onclose(false)
    }
    window.addEventListener('keydown', key, { capture: true })
    document.addEventListener('pointerdown', down, { capture: true })
    const sized = new ResizeObserver(() => {
      if (card === undefined || content === undefined) return
      height = card.offsetHeight
      overhead = card.offsetHeight - content.offsetHeight
    })
    if (card !== undefined) { sized.observe(card); card.focus() }
    const resized = (): void => { viewport = { width: window.innerWidth, height: window.innerHeight } }
    window.addEventListener('resize', resized)
    return () => {
      closed = true
      stopOpening()
      session?.close()
      clearInterval(tick)
      sized.disconnect()
      window.removeEventListener('resize', resized)
      window.removeEventListener('keydown', key, { capture: true })
      document.removeEventListener('pointerdown', down, { capture: true })
    }
  })

  const place = $derived.by(() => {
    const rects = [anchor, ...(text === null ? [] : [text])].map(element => element.getBoundingClientRect())
    const [left, top] = [Math.min(...rects.map(rect => rect.left)), Math.min(...rects.map(rect => rect.top))]
    const item = { x: left, y: top, width: Math.max(...rects.map(rect => rect.right)) - left, height: Math.max(...rects.map(rect => rect.bottom)) - top }
    return popoverPlacement(item, { width: POPOVER_WIDTH, height }, viewport, zoom)
  })
  /** The most its content may take, in its own px: the card's room less its title and padding. */
  const room = $derived(Math.max(0, popoverRoom(viewport, zoom) - overhead))
  const frozen = $derived(snapshot.phase !== 'live' || sampleStale(snapshot, wallNow))
  const openInWindow = (): void => {
    if (envelope !== null && openElementDefault(embeddedDisplayFrame(), from, envelope)) onclose(false)
  }
</script>

<div bind:this={card} class="popover" role="dialog" aria-label={`${name}: pop-over`} tabindex="-1" style:left={`${place.x}px`} style:top={`${place.y}px`} style:transform={`scale(${1 / zoom})`}>
  <obc-toggletip variant="raised" title={name} hasContent hasLeadingIcon={false} hasTrailingIcon={false} hasActions={false} customWidth={POPOVER_WIDTH}>
    <div slot="content" class="content" bind:this={content} style:--row={`${VIGNETTE_ROW_PX}px`} style:max-height={`${room}px`}>
      {#each elementParts(offer) as part (part)}
        {#if part === 'default'}
          <div>
            {#if snapshot.view !== undefined}
              <Sections view={snapshot.view} {snapshot} {palette} {frozen} {runId} {from} drawings={false} />
            {:else}
              <p class="status">{failure ?? (snapshot.phase === 'failed' ? snapshot.failure : 'Reading the element…')}</p>
            {/if}
          </div>
        {:else if part === 'actions'}
          <div>{#if Actions !== null}<Actions {runId} objectId={objectIdSchema.parse(objectId)} {elementId} />{/if}</div>
        {:else if part === 'open-in-window'}
          <div class="pinned">
            <!-- An obc-button is a button: the native button inside it takes Enter and Space. -->
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
            <obc-button variant="normal" disabled={envelope === null} title="Operate it there" onclick={openInWindow}>Open in the display window</obc-button>
          </div>
        {:else}
          <p class="status pinned">Operated from the display window.</p>
        {/if}
      {/each}
    </div>
  </obc-toggletip>
</div>

<style>
  .popover { position: fixed; z-index: 10; transform-origin: 0 0; outline: none; }
  /* The body scrolls within the room; its parts keep their height. */
  .content { display: flex; flex-direction: column; gap: 4px; font-size: 13px; overflow-x: hidden; overflow-y: auto; }
  .content > * { flex: none; }
  /* After the default, the way to the display window stays at the body's foot as it scrolls. */
  .pinned { position: sticky; bottom: 0; padding-top: 4px; background: var(--container-background-color); }
  .status { margin: 0; color: var(--element-neutral-color); }
  .pinned obc-button { display: inline-block; }
</style>
