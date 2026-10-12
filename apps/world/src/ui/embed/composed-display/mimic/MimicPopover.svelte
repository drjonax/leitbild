<script lang="ts">
  import type { MimicDrawnItem } from '../../../../packs/process-plant/displays/mimic/mimic-model.ts'
  import type { MimicPopoverContext, MimicPopoverSection } from './popover.ts'

  // An item's popover: OpenBridge's toggletip, drawn outside the drawing's
  // and the window's zoom at 1/zoom so it reads at 100 %, at the place its
  // host chose beside the item. Its sections stand in order under their
  // titles; "Open detail" opens the item's detail, as a click on it does,
  // and "Close" closes it, as Esc does.
  let { id, item, flap, sections, context, place, zoom, width, open, close, pointer, measured }: {
    id: string
    item: MimicDrawnItem
    /** The item's most severe active alarm in its flap's words, as the drawing frames it; empty without one. */
    flap: string
    sections: ReadonlyArray<MimicPopoverSection>
    context: MimicPopoverContext
    place: { readonly x: number; readonly y: number }
    zoom: number
    width: number
    open: ((item: MimicDrawnItem) => void) | undefined
    close: () => void
    /** The pointer entered (true) or left (false) the popover. */
    pointer: (inside: boolean) => void
    /** Its height as drawn, in its own px, for the host to place it. */
    measured: (height: number) => void
  } = $props()

  // The toggletip's own events, by name.
  const listen = (host: HTMLElement, handlers: Readonly<Record<string, () => void>>) => {
    let current = handlers
    const names = Object.keys(handlers)
    const listener = (event: Event): void => current[event.type]?.()
    for (const name of names) host.addEventListener(name, listener)
    return { update: (next: typeof handlers) => { current = next }, destroy: () => { for (const name of names) host.removeEventListener(name, listener) } }
  }
  const sized = (host: HTMLElement) => {
    const observer = new ResizeObserver(() => measured(host.offsetHeight))
    observer.observe(host)
    return { destroy: () => observer.disconnect() }
  }
</script>

<div
  {id}
  class="popover"
  role="region"
  aria-label={`${item.binding.label}: quick look`}
  style={`left:${place.x}px;top:${place.y}px;width:${width}px;transform:scale(${1 / zoom})`}
  onpointerenter={() => pointer(true)}
  onpointerleave={() => pointer(false)}
  use:sized
>
  <obc-toggletip
    title={item.binding.label}
    variant="normal"
    hasContent={true}
    hasTrailingIcon={false}
    hasLeadingIcon={false}
    hasActions={open !== undefined}
    primaryButtonLabel="Open detail"
    secondaryButtonLabel="Close"
    customWidth={width}
    use:listen={{ 'primary-action': () => { if (open !== undefined) open(item) }, 'secondary-action': close }}
  >
    <!-- Never taller than the window: its sections scroll inside it (a pending proposal, a quick look and the controls together). -->
    <div slot="content" class="sections" style={`max-height:${Math.max(160, (window.innerHeight - 16) * zoom - 112)}px`}>
      {#if flap !== ''}<p class="flap">{flap}</p>{/if}
      {#each sections as section (section.id)}
        <section aria-label={section.title}>
          <h3>{section.title}</h3>
          {@render section.body(context)}
        </section>
      {/each}
    </div>
  </obc-toggletip>
</div>

<style>
  .popover { position: fixed; z-index: 10; transform-origin: 0 0; white-space: normal; }
  .sections { display: flex; flex-direction: column; gap: 6px; overflow-y: auto; overscroll-behavior: contain; }
  /* Its most severe active alarm, in its frame's words, on one line under its name. */
  .flap { margin: -4px 0 0; font-size: 12px; line-height: 16px; font-weight: 600; color: var(--element-active-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  h3 { margin: 0 0 2px; font-size: 11px; line-height: 14px; font-weight: 600; color: var(--element-neutral-color); text-transform: uppercase; letter-spacing: 0.04em; }
</style>
