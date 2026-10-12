<script lang="ts">
  import type { MimicDrawnItem } from '../../../../packs/process-plant/displays/mimic/mimic-model.ts'
  import type { MimicPopoverContext, MimicPopoverSection } from './popover.ts'

  // An item's popover, or its overlay pinned on the surface (vessel-design
  // §C): an elevated card in OpenBridge's tokens, drawn outside the drawing's
  // and the window's zoom at 1/zoom so it reads at 100 %, at the place its
  // host chose. Its 24 px header names the item, its state word and its
  // active alarm; the pin is its only button. There is no Close and no "Open
  // detail": leaving, Esc or a press outside close a popover, and a press on
  // the item opens its detail. Pinned, the whole header is its handle (drag,
  // or arrow keys: 8 px, Shift 24 px), its corner resizes it (or Shift+Alt
  // and the arrow keys): only its trends widen, and its rows drop whole from
  // the bottom; Esc while it has focus unpins it.
  let { id, item, state, alert, note = null, sections, context, place, zoom, width, pinned, pin, pointer, measured, touched, move, resize }: {
    id: string
    item: MimicDrawnItem
    /** The item's state word as its symbol writes it ("RUN", "SHUT", "ON LINE"); empty where it has none. */
    state: string
    /** Its most severe active alarm in its flap's words, in its alarm's colour; null without one. */
    alert: { readonly status: 'alarm' | 'warning' | 'caution'; readonly text: string } | null
    /** A person's setting under a standing actuation, in World's words ("Throttled under AFW actuation"); null without one. */
    note?: string | null
    sections: ReadonlyArray<MimicPopoverSection>
    context: MimicPopoverContext
    place: { readonly x: number; readonly y: number }
    zoom: number
    width: number
    pinned: boolean
    /** The pin: pins the popover, or closes the overlay. */
    pin: () => void
    /** The pointer entered (true) or left (false) the popover. */
    pointer: (inside: boolean) => void
    /** Its whole height as drawn, in its own px, for the host to place it. */
    measured: (height: number) => void
    /** A press anywhere in an overlay: it comes to the top. */
    touched?: (() => void) | undefined
    /** A drag of its header, by the pointer's travel in the page's px since it began; or a keyboard step (`end`). */
    move?: ((travel: { readonly dx: number; readonly dy: number }, end: boolean) => void) | undefined
    /** A drag of its corner by the pointer's travel since it began; or a keyboard step, in whole rows and px of width. */
    resize?: ((change: { readonly travel: { readonly dx: number; readonly dy: number } } | { readonly step: { readonly width: number; readonly rows: number } }, end: boolean) => void) | undefined
  } = $props()

  const sized = (node: HTMLElement) => {
    const observer = new ResizeObserver(() => measured(node.offsetHeight))
    observer.observe(node)
    return { destroy: () => observer.disconnect() }
  }

  // A drag follows the pointer captured on the header or the corner until it is released.
  const follow = (event: PointerEvent, moved: (travel: { readonly dx: number; readonly dy: number }, end: boolean) => void): void => {
    if (event.button !== 0) return
    if (event.target instanceof Element && event.target.closest('obc-icon-button') !== null) return
    event.preventDefault()
    const target = event.currentTarget as HTMLElement
    target.setPointerCapture(event.pointerId)
    const startX = event.clientX
    const startY = event.clientY
    const travel = (next: PointerEvent) => ({ dx: next.clientX - startX, dy: next.clientY - startY })
    const step = (next: PointerEvent): void => moved(travel(next), false)
    const up = (next: PointerEvent): void => {
      moved(travel(next), true)
      target.removeEventListener('pointermove', step)
      target.removeEventListener('pointerup', up)
      target.removeEventListener('pointercancel', up)
    }
    target.addEventListener('pointermove', step)
    target.addEventListener('pointerup', up)
    target.addEventListener('pointercancel', up)
  }
  const headerDown = (event: PointerEvent): void => { if (pinned && move !== undefined) follow(event, move) }
  const cornerDown = (event: PointerEvent): void => {
    event.stopPropagation()
    if (resize !== undefined) follow(event, (travel, end) => resize!({ travel }, end))
  }
  const ARROWS: Readonly<Record<string, readonly [number, number]>> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
  const headerKey = (event: KeyboardEvent): void => {
    const arrow = ARROWS[event.key]
    if (!pinned || arrow === undefined) return
    event.preventDefault()
    event.stopPropagation()
    if (event.shiftKey && event.altKey) resize?.({ step: { width: 20 * arrow[0], rows: arrow[1] } }, true)
    else move?.({ dx: arrow[0] * (event.shiftKey ? 24 : 8), dy: arrow[1] * (event.shiftKey ? 24 : 8) }, true)
  }
  const overlayKey = (event: KeyboardEvent): void => {
    if (!pinned || event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    pin()
  }
  // Never taller than the window: what does not fit scrolls inside it.
  const bodyStyle = $derived(`max-height:${Math.max(120, (window.innerHeight - 16) * zoom - 40)}px`)
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  {id}
  class="popover"
  class:pinned
  role="region"
  aria-label={`${item.binding.label}: ${pinned ? 'pinned overlay' : context.mode === 'look' ? 'quick look' : 'popover'}`}
  data-claims-escape={pinned ? '' : undefined}
  style={`left:${place.x}px;top:${place.y}px;width:${width}px;transform:scale(${1 / zoom})`}
  onpointerenter={() => pointer(true)}
  onpointerleave={() => pointer(false)}
  onpointerdown={() => touched?.()}
  onkeydown={overlayKey}
  use:sized
>
  <!-- Pinned, the header is the overlay's handle: focusable, moved by the arrow keys. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_static_element_interactions -->
  <header
    class="header"
    tabindex={pinned ? 0 : -1}
    title={pinned ? 'Drag to move (arrow keys: 8 px, Shift: 24 px); Shift+Alt+arrows resize' : undefined}
    onpointerdown={headerDown}
    onkeydown={headerKey}
  >
    {#if pinned}<span class="handle" aria-hidden="true"><obi-drag-horizontal usecsscolor></obi-drag-horizontal></span>{/if}
    <span class="label">{item.binding.label}</span>
    {#if state !== ''}<span class="state">{state}</span>{/if}
    {#if alert !== null}<span class={`chip ${alert.status}`}>{alert.text}</span>{/if}
    {#if note !== null}<span class="note" title={note}>{note}</span>{/if}
    <!-- An obc-icon-button is a button: the native button inside it takes Enter and Space. -->
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <obc-icon-button
      class="pin"
      variant="flat"
      activated={pinned}
      aria-pressed={pinned}
      ariaLabel={pinned ? `Unpin ${item.binding.label}: close the overlay` : `Pin ${item.binding.label} on the surface`}
      title={pinned ? 'Unpin: close the overlay' : 'Pin on the surface'}
      onclick={pin}
    >{#if pinned}<obi-pin-selected-google usecsscolor></obi-pin-selected-google>{:else}<obi-pin-google usecsscolor></obi-pin-google>{/if}</obc-icon-button>
  </header>
  <div class="body" style={bodyStyle}>
    {#each sections as section (section.id)}
      <section aria-label={section.title}>
        {#if sections.length > 1 && section.order !== 20}<h3>{section.title}</h3>{/if}
        {@render section.body(context)}
      </section>
    {/each}
  </div>
  {#if pinned}
    <!-- The corner: drag it to resize the overlay. -->
    <span class="corner" role="presentation" title="Drag to resize (Shift+Alt+arrows)" onpointerdown={cornerDown}><obi-resize-corner usecsscolor></obi-resize-corner></span>
  {/if}
</div>

<style>
  /* OpenBridge's elevated surface: the container colour with the toggletip's shadow. */
  .popover { position: fixed; z-index: 10; transform-origin: 0 0; white-space: normal; box-sizing: border-box; border-radius: 6px; background: var(--container-background-color); box-shadow: 0 4px 16px 0 rgba(0, 0, 0, 0.3); color: var(--element-active-color); font-family: "Noto Sans", system-ui, sans-serif; }
  .popover.pinned { z-index: 9; outline: 1px solid var(--border-outline-color); }
  .header { display: flex; align-items: center; gap: 6px; height: 24px; padding: 0 0 0 8px; border-bottom: 1px solid var(--border-divider-color); font-size: 12px; line-height: 16px; white-space: nowrap; overflow: hidden; }
  .pinned .header { cursor: move; touch-action: none; padding-left: 2px; }
  .header:focus-visible { outline: 2px solid var(--border-focus-color); outline-offset: -2px; }
  .handle { display: inline-flex; width: 20px; height: 20px; flex: none; color: var(--element-neutral-color); }
  .label { font-weight: 600; flex: none; }
  .state { color: var(--element-neutral-color); flex: none; }
  .chip { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; padding: 0 5px; border-radius: 3px; font-size: 11px; line-height: 15px; font-weight: 600; }
  .chip.alarm { background: var(--alert-alarm-color); color: var(--on-alarm-active-color); }
  .chip.warning { background: var(--alert-warning-color); color: var(--on-warning-active-color); }
  .chip.caution { background: var(--alert-caution-color); color: var(--on-caution-active-color); }
  /* The pin fits the 24 px header: OpenBridge's icon button at a 24 px target. */
  .note { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; padding: 0 5px; border: 1px solid var(--border-outline-color); border-radius: 3px; font-size: 11px; line-height: 15px; font-weight: 600; }
  .pin { margin-left: auto; flex: none; height: 24px; --ui-components-button-touch-target-size: 24px; --ui-components-icon-button-visual-target-size: 24px; }
  .body { display: flex; flex-direction: column; gap: 4px; padding: 4px 8px 6px; overflow-y: auto; overscroll-behavior: contain; font-size: 11.5px; line-height: 15px; }
  h3 { margin: 2px 0 0; font-size: 10px; line-height: 13px; font-weight: 600; color: var(--element-neutral-color); text-transform: uppercase; letter-spacing: 0.04em; }
  .corner { position: absolute; right: 1px; bottom: 1px; display: inline-flex; width: 16px; height: 16px; cursor: nwse-resize; touch-action: none; color: var(--element-neutral-color); }
</style>
