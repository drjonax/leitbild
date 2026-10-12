<script lang="ts" generics="T">
  // APG carousel shared by the landing hero, the Demos modal and the Workspace
  // page on phones. Rotation rules live in carousel.ts; this file only wires
  // browser events to the controller. Pickers follow the APG tabs pattern (one
  // Tab stop, ←/→/Home/End). Keep `items` stable; re-key the component if the
  // number of items changes.
  import { onMount, tick, type Snippet } from 'svelte'
  import Icon from './Icon.svelte'
  import {
    CAROUSEL_INTERVAL_MS, createCarousel, pickerKeyTarget, pickerLabel, slideLabel, swipeDirection, toggleLabel,
    type CarouselInput, type CarouselSnapshot,
  } from './carousel.ts'

  interface Props {
    items: ReadonlyArray<T>
    /** The carousel's accessible name, e.g. "Leitbild highlights". */
    label: string
    /** Each slide's title, used in "2 of 6: title" and the picker labels. */
    itemTitle: (item: T) => string
    /** One slide's content (image + caption). */
    slide: Snippet<[item: T, index: number]>
    /** Thumbnail content for a picker (`nav: 'thumbs'`); the title is added below it. */
    thumb?: Snippet<[item: T, index: number]>
    /** 'dots' everywhere, or thumbnails at ≥ 1081 px with dots below that. */
    nav?: 'dots' | 'thumbs'
    /** hero: framed card, controls inside the caption band at ≥ 1181 px. panel: unframed, controls in a row below. */
    variant?: 'hero' | 'panel'
    /** Word in the picker labels: "Show slide 2 of 6: …" / "Show demo 2 of 3: …". */
    noun?: string
    /** Start stopped: opened by keyboard (`click.detail === 0`) or by deep link. Reduced motion always starts stopped. */
    startStopped?: boolean
    initialIndex?: number
    intervalMs?: number
    /** Hold while less than half the carousel is on screen. */
    observeVisibility?: boolean
    /** A line under the carousel (the map credit). */
    credit?: Snippet
    onindexchange?: (index: number, item: T) => void
  }

  let {
    items, label, itemTitle, slide, thumb, nav = 'dots', variant = 'hero', noun = 'slide',
    startStopped = false, initialIndex = 0, intervalMs = CAROUSEL_INTERVAL_MS, observeVisibility = false,
    credit, onindexchange,
  }: Props = $props()

  const uid = `car-${Math.random().toString(36).slice(2, 8)}`
  const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  // Created once: the item count and the start state are read at mount.
  // svelte-ignore state_referenced_locally
  const controller = createCarousel({ count: items.length, intervalMs, initialIndex, startStopped: startStopped || reducedMotion })
  let view = $state<CarouselSnapshot>(controller.snapshot())
  let root = $state<HTMLElement | null>(null)
  let pickers = $state<HTMLElement | null>(null)

  /** Stop rotation (e.g. while a demo launches). */
  export function stop(): void { controller.stop() }
  export function play(): void { controller.play() }
  /** Show a slide without counting as user navigation (deep links); rotation state is unchanged. */
  export function show(index: number): void { controller.goTo(index, view.stopped ? 'keyboard' : 'pointer') }
  export function current(): number { return view.index }

  const inputOf = (event: MouseEvent): CarouselInput => event.detail === 0 ? 'keyboard' : 'pointer'

  const onPickerKey = async (event: KeyboardEvent): Promise<void> => {
    const target = pickerKeyTarget(event.key, view.index, items.length)
    if (target === null) return
    event.preventDefault()
    controller.goTo(target, 'keyboard')
    await tick()
    pickers?.querySelector<HTMLElement>(`[data-index="${target}"]`)?.focus()
  }

  const onFocusIn = (event: FocusEvent): void => {
    const target = event.target
    if (target instanceof Element && target.matches(':focus-visible')) controller.keyboardFocus()
  }

  let swipeStart: { x: number; y: number; type: string } | null = null
  const onPointerDown = (event: PointerEvent): void => {
    swipeStart = event.pointerType === 'mouse' ? null : { x: event.clientX, y: event.clientY, type: event.pointerType }
  }
  const onPointerUp = (event: PointerEvent): void => {
    if (swipeStart === null) return
    const direction = swipeDirection(swipeStart, { x: event.clientX, y: event.clientY }, swipeStart.type)
    swipeStart = null
    if (direction === 1) controller.next('pointer')
    if (direction === -1) controller.previous('pointer')
  }
  // Hover holds only for a real mouse: iPad taps emulate enter without a leave.
  const onPointerEnter = (event: PointerEvent): void => { if (event.pointerType === 'mouse') controller.hold('hover') }
  const onPointerLeave = (event: PointerEvent): void => { if (event.pointerType === 'mouse') controller.release('hover') }

  onMount(() => {
    let lastIndex = view.index
    const unsubscribe = controller.subscribe(next => {
      view = next
      if (next.index !== lastIndex) {
        lastIndex = next.index
        const item = items[next.index]
        if (item !== undefined) onindexchange?.(next.index, item)
      }
    })
    const onVisibility = (): void => { if (document.hidden) controller.hold('hidden'); else controller.release('hidden') }
    document.addEventListener('visibilitychange', onVisibility)
    onVisibility()
    let observer: IntersectionObserver | null = null
    if (observeVisibility && root && typeof IntersectionObserver === 'function') {
      observer = new IntersectionObserver(([entry]) => {
        if (entry && entry.intersectionRatio < .5) controller.hold('offscreen'); else controller.release('offscreen')
      }, { threshold: [0, .5, 1] })
      observer.observe(root)
    }
    return () => {
      unsubscribe()
      document.removeEventListener('visibilitychange', onVisibility)
      observer?.disconnect()
      controller.destroy()
    }
  })
</script>

<section bind:this={root} class="lb-carousel {variant}" class:rotating={!view.stopped} class:held={view.held}
  class:thumbs={nav === 'thumbs' && thumb !== undefined} aria-roledescription="carousel" aria-label={label}
  style:--car-interval={`${intervalMs}ms`} onfocusin={onFocusIn} onpointerenter={onPointerEnter} onpointerleave={onPointerLeave}
>
  <div class="frame">
    <div class="controls">
      <button class="car-btn toggle" type="button" aria-controls={`${uid}-viewport`} aria-label={toggleLabel(view.stopped)}
        title={view.stopped ? 'Play' : 'Pause'} onclick={() => controller.toggle()}
      ><Icon name={view.stopped ? 'play' : 'pause'} /></button>
      <button class="car-btn" type="button" aria-controls={`${uid}-viewport`} aria-label={`Previous ${noun}`}
        onclick={event => controller.previous(inputOf(event))}><Icon name="left" /></button>
      <div bind:this={pickers} class="pickers" role="tablist" aria-label={`Choose a ${noun}`} tabindex="-1" onkeydown={onPickerKey}>
        {#each items as item, index (index)}
          {@const active = index === view.index}
          <button class="picker" type="button" role="tab" data-index={index} id={`${uid}-tab-${index}`}
            aria-selected={active} aria-controls={`${uid}-slide-${index}`} tabindex={active ? 0 : -1}
            aria-label={pickerLabel(index, items.length, itemTitle(item), noun)}
            onclick={event => controller.goTo(index, inputOf(event))}
          >
            {#if thumb}<span class="thumb" aria-hidden="true">{@render thumb(item, index)}<span class="thumb-title">{itemTitle(item)}</span
              >{#if active}{#key view.cycle}<span class="bar"><i></i></span>{/key}{/if}</span>{/if}
            <span class="dot" aria-hidden="true">{#if active}{#key view.cycle}<span class="bar"><i></i></span>{/key}{/if}</span>
          </button>
        {/each}
      </div>
      <button class="car-btn" type="button" aria-controls={`${uid}-viewport`} aria-label={`Next ${noun}`}
        onclick={event => controller.next(inputOf(event))}><Icon name="right" /></button>
      <span class="count" aria-hidden="true">{view.index + 1} / {items.length}</span>
    </div>
    <!-- Swipe is a pointer-only shortcut; Prev/Next and the pickers are the accessible controls. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="viewport" id={`${uid}-viewport`} aria-live={view.live}
      onpointerdown={onPointerDown} onpointerup={onPointerUp} onpointercancel={() => { swipeStart = null }}
    >
      {#each items as item, index (index)}
        {@const active = index === view.index}
        <div class="slide" class:active id={`${uid}-slide-${index}`} role="group" aria-roledescription="slide"
          aria-label={slideLabel(index, items.length, itemTitle(item))} inert={!active} aria-hidden={!active}
        >{@render slide(item, index)}</div>
      {/each}
    </div>
  </div>
  {#if credit}<div class="credit">{@render credit()}</div>{/if}
</section>

<style>
  .lb-carousel { position: relative; min-width: 0; --car-controls-reserve: 0px; }
  .frame { position: relative; display: flex; flex-direction: column; overflow: hidden; }
  .hero .frame { border: 1px solid var(--lb-line); border-radius: var(--lb-r-xl); background: var(--lb-surface); box-shadow: var(--lb-shadow-md); }
  .viewport { position: relative; display: grid; touch-action: pan-y; }
  .slide { grid-area: 1 / 1; display: grid; min-width: 0; opacity: 0; visibility: hidden;
    transition: opacity 300ms ease-out, visibility 0s linear 300ms; }
  .slide.active { opacity: 1; visibility: visible; transition: opacity 300ms ease-out, visibility 0s; }

  .controls { order: 2; display: flex; align-items: center; gap: 8px; padding: 8px 12px 12px 14px; }
  .panel .controls { border-top: 1px solid var(--lb-line); }
  .car-btn { display: inline-grid; place-items: center; flex: none; width: 44px; height: 44px; min-height: 44px; padding: 0;
    border: 1px solid transparent; border-radius: var(--lb-r-md); background: transparent; color: var(--lb-ink-2); cursor: pointer;
    transition: background var(--lb-t-fast) var(--lb-ease), color var(--lb-t-fast) var(--lb-ease); }
  .car-btn:hover { color: var(--lb-ink); background: rgba(23, 32, 25, .06); border-color: transparent; }
  .car-btn:focus-visible, .picker:focus-visible { outline: 2px solid var(--lb-focus); outline-offset: 2px; }

  .pickers { display: flex; align-items: center; gap: 2px; min-width: 0; }
  .pickers:focus { outline: none; }
  .picker { position: relative; display: grid; place-items: center; flex: none; width: 28px; height: 44px; min-height: 44px; padding: 0;
    border: 0; border-radius: var(--lb-r-sm); background: transparent; cursor: pointer; }
  .picker[aria-selected="true"] { width: 44px; }
  .dot { position: relative; display: block; width: 8px; height: 8px; border-radius: var(--lb-r-pill); background: var(--lb-control); overflow: hidden;
    transition: width var(--lb-t-base) var(--lb-ease), background var(--lb-t-base); }
  .picker:hover .dot { background: var(--lb-ink-2); }
  /* Active pill: a ≥ 3:1 outline so "current" never depends on the progress fill (a11y should-fix 6). */
  .picker[aria-selected="true"] .dot { width: 32px; background: var(--lb-surface); box-shadow: inset 0 0 0 1.5px var(--lb-control); }
  .bar { position: absolute; inset: 0; display: block; overflow: hidden; border-radius: inherit; pointer-events: none; }
  .bar i { display: block; width: 100%; height: 100%; background: var(--lb-accent); transform-origin: left; transform: scaleX(1); }
  .rotating .bar i { transform: scaleX(0); animation: car-progress var(--car-interval, 5000ms) linear forwards; }
  .held .bar i { animation-play-state: paused; }
  @keyframes car-progress { from { transform: scaleX(0); } to { transform: scaleX(1); } }

  .thumb { display: none; }
  .count { margin-left: auto; padding-right: 6px; white-space: nowrap; font-size: var(--lb-fs-micro); font-variant-numeric: tabular-nums; color: var(--lb-ink-3); }
  .credit { margin: 10px 4px 0; font-size: var(--lb-fs-micro); color: var(--lb-ink-3); }
  .credit :global(a) { color: inherit; }

  /* Demos: thumbnails at ≥ 1081 px, dots below that. */
  @media (min-width: 1081px) {
    .thumbs .pickers { gap: 8px; }
    .thumbs .picker, .thumbs .picker[aria-selected="true"] { width: 128px; height: auto; place-items: stretch; padding: 0;
      border: 1px solid var(--lb-line); background: var(--lb-surface); text-align: left; overflow: hidden; }
    .thumbs .picker[aria-selected="true"] { border-color: var(--lb-brand-700); box-shadow: 0 0 0 1px var(--lb-brand-700); }
    .thumbs .dot { display: none; }
    .thumbs .thumb { position: relative; display: block; }
    .thumb :global(img) { display: block; width: 100%; aspect-ratio: 16 / 10; object-fit: cover; object-position: center top; opacity: .82; }
    .picker:hover .thumb :global(img), .picker[aria-selected="true"] .thumb :global(img) { opacity: 1; }
    .thumb-title { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; height: 2.5em; box-sizing: content-box;
      padding: 4px 7px 6px; overflow: hidden; color: var(--lb-ink-2); font-size: .6875rem; font-weight: 600; line-height: 1.25; }
    .thumb .bar { inset: 0 0 auto; height: 3px; border-radius: 0; }
  }
  /* Hero: controls sit inside the caption band, bottom right; captions reserve the room. */
  @media (min-width: 1181px) {
    .hero { --car-controls-reserve: 360px; }
    .hero .controls { position: absolute; right: 14px; bottom: 14px; padding: 0; }
  }
  @media (max-width: 700px) {
    .count { display: none; }
    .picker { width: 24px; }
    .picker[aria-selected="true"] { width: 40px; }
  }
  @media (pointer: coarse) {
    .car-btn { width: 48px; height: 48px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .slide, .slide.active, .dot { transition: none; }
    .rotating .bar i { animation-duration: var(--car-interval, 5000ms); }
  }
  @media (forced-colors: active) {
    .dot { border: 1px solid CanvasText; background: Canvas; }
    .picker[aria-selected="true"] .dot { background: Highlight; }
    .bar i { background: Highlight; forced-color-adjust: none; }
    .thumbs .picker[aria-selected="true"] { outline: 2px solid Highlight; }
  }
</style>
