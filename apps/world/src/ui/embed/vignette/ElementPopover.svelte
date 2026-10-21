<script lang="ts">
  import type { Component } from 'svelte'
  import { objectIdSchema, type SimulationRunId } from '../../../core/model/index.ts'
  import type { PackElementActionsProps } from '../../../core/packs/protocol.ts'
  import type { Palette } from '../../displays/severity.ts'
  import { runOnMount } from '../../svelte-lifecycle.svelte.ts'
  import { loadEmbedPack } from '../pack-embed-loader.ts'
  import { VIGNETTE_ROW_PX } from './grid.ts'
  import { popoverPlacement, POPOVER_WIDTH } from './popover.ts'
  import Sections from './Sections.svelte'
  import { createVignetteSession, elementDefault, sampleStale, vignetteRoutes, type VignetteSnapshot } from './vignette-client.ts'

  // An element's pop-over (architecture B3) in OpenBridge's toggletip, titled
  // by the element: its World default (the vignette the composer gives it,
  // its topologies left to the drawing it opened from), and under it the
  // element's actions, the panel its Pack contributes to the embed, mounted
  // with the Run, the object and the element. It stands beside its item,
  // never over it, at 100 % whatever the display's zoom. Focus moves into it;
  // Esc (unless a section claims it) closes it and gives the focus back to
  // the item, and a press outside it and its item closes it.
  let { runId, objectId, packId, elementId, name, anchor, text, zoom, palette, onclose }: {
    runId: SimulationRunId
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
  let height = $state(160)
  let snapshot = $state.raw<VignetteSnapshot>({ phase: 'connecting', series: new Map(), sampleError: null })
  let failure = $state<string | null>(null)
  let Actions = $state.raw<Component<PackElementActionsProps> | null>(null)
  let wallNow = $state(Date.now())

  runOnMount(() => {
    let session: ReturnType<typeof createVignetteSession> | null = null
    let closed = false
    void elementDefault(runId, objectId, elementId).then(state => {
      if (closed) return
      session = createVignetteSession({ runId, state, routes: vignetteRoutes, onChange: next => { snapshot = next } })
      session.start()
    }, (error: unknown) => { failure = error instanceof Error ? error.message : String(error) })
    void loadEmbedPack(packId).then(contribution => contribution?.elementActions?.()).then(module => { if (!closed && module !== undefined) Actions = module.default })
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
    const sized = new ResizeObserver(() => { if (card !== undefined) height = card.offsetHeight })
    if (card !== undefined) { sized.observe(card); card.focus() }
    return () => {
      closed = true
      session?.close()
      clearInterval(tick)
      sized.disconnect()
      window.removeEventListener('keydown', key, { capture: true })
      document.removeEventListener('pointerdown', down, { capture: true })
    }
  })

  const place = $derived.by(() => {
    const rects = [anchor, ...(text === null ? [] : [text])].map(element => element.getBoundingClientRect())
    const [left, top] = [Math.min(...rects.map(rect => rect.left)), Math.min(...rects.map(rect => rect.top))]
    const item = { x: left, y: top, width: Math.max(...rects.map(rect => rect.right)) - left, height: Math.max(...rects.map(rect => rect.bottom)) - top }
    return popoverPlacement(item, { width: POPOVER_WIDTH, height }, { width: window.innerWidth, height: window.innerHeight }, zoom)
  })
  const frozen = $derived(snapshot.phase !== 'live' || sampleStale(snapshot, wallNow))
</script>

<div bind:this={card} class="popover" role="dialog" aria-label={`${name}: pop-over`} tabindex="-1" style:left={`${place.x}px`} style:top={`${place.y}px`} style:transform={`scale(${1 / zoom})`}>
  <obc-toggletip variant="raised" title={name} hasContent hasLeadingIcon={false} hasTrailingIcon={false} hasActions={false} customWidth={POPOVER_WIDTH}>
    <div slot="content" class="content" style:--row={`${VIGNETTE_ROW_PX}px`}>
      {#if snapshot.view !== undefined}
        <Sections view={snapshot.view} {snapshot} {palette} {frozen} {runId} drawings={false} />
      {:else}
        <p class="status">{failure ?? (snapshot.phase === 'failed' ? snapshot.failure : 'Reading the element…')}</p>
      {/if}
      {#if Actions !== null}<Actions {runId} objectId={objectIdSchema.parse(objectId)} {elementId} />{/if}
    </div>
  </obc-toggletip>
</div>

<style>
  .popover { position: fixed; z-index: 10; transform-origin: 0 0; outline: none; }
  .content { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
  .status { margin: 0; color: var(--element-neutral-color); }
</style>
