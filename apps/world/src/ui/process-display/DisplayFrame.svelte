<script lang="ts">
  import { untrack } from 'svelte'
  import { embeddedViewFragment, embeddedViewPath, type EmbeddedViewEnvelope } from '@leitbild/contracts'
  import {
    parseDisplayFrameMessage,
    type DisplayFrameExtent,
    type DisplayFrameOpen,
    type DisplayFramePresentation,
    type DisplayFrameZoomRequest,
  } from '../embed/display-frame-protocol.ts'
  import { runOnMount } from '../svelte-lifecycle.svelte.ts'
  import {
    displayFrameGeometry,
    presentedFrameGeometry,
    type DisplayExtent,
    type DisplayFrameGeometry,
    type DisplayKind,
  } from './display-zoom.ts'

  // One display in the process display window: its own page in a frame, so
  // OpenBridge's styles stay with the drawing and it samples the Run itself.
  // Frames of displays shown recently stay mounted and are hidden, never
  // removed from layout, so returning to one is instant and it keeps its
  // drill-down. A hidden frame keeps the size it was hidden at, so resizing
  // the window never has it drawn again; shown, it takes the window's size.
  // The window tells each frame whether it is shown and at what zoom; it
  // listens only to this frame's own page.

  interface Props {
    readonly entryKey: string
    readonly envelope: EmbeddedViewEnvelope
    readonly title: string
    readonly shown: boolean
    readonly zoom: number
    readonly kind: DisplayKind
    readonly extent: DisplayExtent | null
    /** For a display the window opened from another: that one's title, which the display's Back returns to. */
    readonly back: string | null
    /** The frame's page listens (or loaded): it can be shown without leaving a blank. */
    readonly onUp: (key: string) => void
    /** The frame went away; its extent and readiness go with it. */
    readonly onDown: (key: string) => void
    readonly onExtent: (key: string, extent: DisplayExtent) => void
    readonly onZoomRequest: (key: string, request: DisplayFrameZoomRequest) => void
    readonly onProblem: (key: string, problem: string) => void
    /** The display asks for another to be opened after it. */
    readonly onOpen: (key: string, request: DisplayFrameOpen) => void
    /** The display's Back, to the one it was opened from. */
    readonly onBack: (key: string) => void
  }

  let { entryKey, envelope, title, shown, zoom, kind, extent, back, onUp, onDown, onExtent, onZoomRequest, onProblem, onOpen, onBack }: Props = $props()

  // A frame's page is fixed for its life; a new envelope is a new entry.
  const source = untrack(() => `${embeddedViewPath(envelope)}${embeddedViewFragment(envelope)}`)
  const key = untrack(() => entryKey)

  let frame = $state<HTMLIFrameElement | null>(null)
  let layer = $state<HTMLElement | null>(null)
  let ready = $state(false)
  let layerWidth = $state(0)
  let layerHeight = $state(0)

  const windowGeometry = $derived(displayFrameGeometry({
    kind,
    zoom,
    body: { width: layerWidth, height: layerHeight },
    extent,
    envelopeHeight: envelope.height,
  }))
  // The geometry last given to the frame; a hidden frame keeps it until it is shown again.
  let presented: DisplayFrameGeometry | null = null
  const geometry = $derived.by(() => {
    presented = presentedFrameGeometry(presented, windowGeometry, shown)
    return presented
  })

  const present = (): void => {
    const target = frame?.contentWindow
    if (!target) return
    const presentation: DisplayFramePresentation = { type: 'world:display-frame', shown, zoom, ...(back === null ? {} : { back }) }
    target.postMessage(presentation, location.origin)
  }

  // The frame hears every change of what it is shown at, once it listens.
  $effect(() => {
    void shown
    void zoom
    void back
    if (ready) untrack(present)
  })

  const toExtent = (message: DisplayFrameExtent): DisplayExtent => ({
    kind: message.kind,
    minWidth: message.minWidth,
    width: message.width,
    height: message.height,
  })

  runOnMount(() => {
    const receive = (event: MessageEvent): void => {
      if (event.origin !== location.origin || frame === null || event.source !== frame.contentWindow) return
      const message = parseDisplayFrameMessage(event.data)
      if (message === null) {
        const type = typeof event.data === 'object' && event.data !== null ? (event.data as { readonly type?: unknown }).type : undefined
        if (typeof type === 'string' && type.startsWith('world:display')) onProblem(key, `The display sent an unreadable ${type} message.`)
        return
      }
      if (message.type === 'world:display-frame-ready') {
        // A first ready is answered by the effect below; a page that starts listening again is answered here.
        if (ready) present()
        else ready = true
        onUp(key)
        return
      }
      if (message.type === 'world:display-extent') {
        onExtent(key, toExtent(message))
        return
      }
      if (message.type === 'world:display-open') {
        onOpen(key, message)
        return
      }
      if (message.type === 'world:display-back') {
        onBack(key)
        return
      }
      onZoomRequest(key, message)
    }
    // The content box: an advice layer that starts to scroll loses its scrollbar's width.
    const observer = new ResizeObserver(entries => {
      const box = entries[0]?.contentRect
      if (!box) return
      layerWidth = box.width
      layerHeight = box.height
    })
    if (layer) observer.observe(layer)
    window.addEventListener('message', receive)
    return () => {
      observer.disconnect()
      window.removeEventListener('message', receive)
      onDown(key)
    }
  })
</script>

<div
  class="display-frame-layer"
  class:scrolls={geometry.bodyScrolls}
  class:hidden={!shown}
  aria-hidden={!shown}
  bind:this={layer}
>
  <!-- Created once the layer has a size, so the page first lays out for real room; never re-created after. -->
  {#if frame !== null || (layerWidth > 0 && layerHeight > 0)}
    <div class="display-frame-box" style:width="{geometry.boxWidth}px" style:height="{geometry.boxHeight}px">
      <!-- The chat page may hold camera permission for biometrics; a display never gets it. -->
      <iframe
        bind:this={frame}
        class="display-frame"
        src={source}
        {title}
        allow="camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'"
        referrerpolicy="same-origin"
        style:width="{geometry.frameWidth}px"
        style:height="{geometry.frameHeight}px"
        style:transform="scale({zoom})"
        onload={() => onUp(key)}
      ></iframe>
    </div>
  {/if}
</div>
