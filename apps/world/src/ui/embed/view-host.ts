// An embedded view's end of World's process display window
// (display-frame-protocol.ts). Framed by the window, a view learns whether it
// is shown, at what zoom and what Back returns to, tells the window how much
// room its content needs, hands zoom gestures made inside it to the window
// instead of zooming the browser page, and asks it to open a display after
// it. A view that no window presents (a page of its own, or a display shown
// inline in a chat answer) is shown at 1:1 and only says once that it
// listens; inline in a chat answer whose page relays to the Workspace's
// window (it says so with the contract's view-host message), it asks that
// page to open a display there.
import { embeddedViewHostMessageSchema, type EmbeddedViewListing, type EmbeddedViewOpenMessage } from '@leitbild/contracts'
import { parseDisplayFramePresentation, type DisplayFrameMessage, type DisplayFrameProposalEntry } from './display-frame-protocol.ts'
import { observeDisplayExtent, type DisplayExtent } from './display-extent.ts'

export interface DisplayPresentation {
  readonly shown: boolean
  readonly zoom: number
  /** For a display its window opened from another: that one's title, which Back returns to. */
  readonly back?: string
}

/** Where a view opens a display it names: its window, or the Workspace's window through the chat page that relays. */
export type DisplayOpening = 'window' | 'relay'

/** How a view is presented until its window says otherwise, and always when it has none. */
export const UNFRAMED_PRESENTATION: DisplayPresentation = { shown: true, zoom: 1 }

export interface ReceivedMessage {
  readonly origin: string
  readonly source: unknown
  readonly data: unknown
}

/** The page a view host runs in; a test passes its own. */
export interface ViewHostPorts {
  /** The window framing this page; null for a page of its own. */
  readonly parent: { readonly postMessage: (message: DisplayFrameMessage | EmbeddedViewOpenMessage, targetOrigin: string) => void } | null
  readonly origin: string
  readonly listen: (receive: (message: ReceivedMessage) => void) => () => void
  /** Says that the framing window sent something this view cannot read. */
  readonly refused: (data: unknown) => void
}

export type ZoomStep = 'in' | 'out' | 'reset'

export const createViewHost = (ports: ViewHostPorts) => {
  let presentation = UNFRAMED_PRESENTATION
  let presentedByWindow = false
  let relayed = false
  let reported: string | null = null
  let reportedProposals: string | null = null
  const subscribers = new Set<(presentation: DisplayPresentation) => void>()
  const onWindow = new Set<() => void>()
  const openingSubscribers = new Set<(opening: DisplayOpening | null) => void>()
  const post = (message: DisplayFrameMessage | EmbeddedViewOpenMessage): void => ports.parent?.postMessage(message, ports.origin)
  const opening = (): DisplayOpening | null => presentedByWindow ? 'window' : relayed ? 'relay' : null
  const openingChanged = (): void => {
    for (const subscriber of [...openingSubscribers]) subscriber(opening())
  }

  const receive = (message: ReceivedMessage): void => {
    // Only the framing window, on this origin, presents the view.
    if (ports.parent === null || message.source !== ports.parent || message.origin !== ports.origin) return
    // A chat page that relays to the Workspace's window says so once it is hosted.
    if (embeddedViewHostMessageSchema.safeParse(message.data).success) {
      if (relayed) return
      relayed = true
      openingChanged()
      return
    }
    const next = parseDisplayFramePresentation(message.data)
    if (next === null) {
      ports.refused(message.data)
      return
    }
    if (!presentedByWindow) {
      presentedByWindow = true
      for (const started of [...onWindow]) started()
      onWindow.clear()
      openingChanged()
    }
    if (next.shown === presentation.shown && next.zoom === presentation.zoom && next.back === presentation.back) return
    presentation = { shown: next.shown, zoom: next.zoom, ...(next.back === undefined ? {} : { back: next.back }) }
    for (const subscriber of [...subscribers]) subscriber(presentation)
  }

  return {
    framed: ports.parent !== null,
    /** Listens to the framing window and tells it so; it answers with the presentation. Returns the stop. */
    listen: (): (() => void) => {
      if (ports.parent === null) return () => {}
      const stop = ports.listen(receive)
      post({ type: 'world:display-frame-ready' })
      return stop
    },
    current: (): DisplayPresentation => presentation,
    /** Runs `start` once a display window presents this view (at once if one already has). */
    whenPresented: (start: () => void): (() => void) => {
      if (presentedByWindow) { start(); return () => {} }
      onWindow.add(start)
      return () => { onWindow.delete(start) }
    },
    /** Svelte's store contract: called at once with the presentation, then on every change. */
    subscribe: (subscriber: (presentation: DisplayPresentation) => void): (() => void) => {
      subscriber(presentation)
      subscribers.add(subscriber)
      return () => { subscribers.delete(subscriber) }
    },
    /** Tells the framing window the room the content needs, when it changed. */
    reportExtent: (extent: DisplayExtent): void => {
      if (ports.parent === null || !presentedByWindow) return
      const key = `${extent.kind} ${extent.minWidth} ${extent.width} ${extent.height}`
      if (key === reported) return
      reported = key
      post({ type: 'world:display-extent', kind: extent.kind, minWidth: extent.minWidth, width: extent.width, height: extent.height })
    },
    requestZoom: (request: { readonly step: ZoomStep } | { readonly factor: number }): void => {
      if (!presentedByWindow) return
      post('step' in request ? { type: 'world:display-zoom', step: request.step } : { type: 'world:display-zoom', factor: request.factor })
    },
    /** Where a display this view names opens, called at once and on every change; null where it cannot open one. */
    subscribeOpening: (subscriber: (opening: DisplayOpening | null) => void): (() => void) => {
      subscriber(opening())
      openingSubscribers.add(subscriber)
      return () => { openingSubscribers.delete(subscriber) }
    },
    /**
     * Opens a display after this one: in its window, or through the chat page
     * as a listing of the Workspace's window. False where neither is there.
     */
    openDisplay: (request: { readonly state: string; readonly title: string; readonly listing: () => EmbeddedViewListing }): boolean => {
      const where = opening()
      if (where === 'window') post({ type: 'world:display-open', state: request.state, title: request.title })
      else if (where === 'relay') post({ type: 'leitbild:view-open', view: request.listing() })
      return where !== null
    },
    /** Tells the window the pending proposals on the Plant this view operates, when they changed (its toolbar's chip). */
    reportProposals: (entries: ReadonlyArray<DisplayFrameProposalEntry>): void => {
      if (ports.parent === null || !presentedByWindow) return
      const key = JSON.stringify(entries)
      if (key === reportedProposals) return
      reportedProposals = key
      post({ type: 'world:display-proposals', entries })
    },
    /** Back to the display the window opened this one from (DisplayPresentation.back). */
    back: (): void => {
      if (presentedByWindow && presentation.back !== undefined) post({ type: 'world:display-back' })
    },
  }
}

export type ViewHost = ReturnType<typeof createViewHost>

/**
 * Ctrl/Cmd with = (or +), - (or _, with Shift) and 0, the browser's zoom keys,
 * zoom the display instead of the page. The window and every frame it shows
 * read the keys here, so the same keys zoom wherever focus is.
 */
export const zoomStepOfKey = (key: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>): ZoomStep | null => {
  if (!(key.ctrlKey || key.metaKey) || key.altKey) return null
  if (key.key === '=' || key.key === '+') return 'in'
  if (key.key === '-' || key.key === '_') return 'out'
  return key.key === '0' ? 'reset' : null
}

// A trackpad pinch arrives as Ctrl wheel events with small pixel deltas and
// follows the fingers at this rate; one mouse wheel notch (about 100 px, or 3
// lines) is held to about one step of the window's zoom ladder.
const WHEEL_ZOOM_PER_PIXEL = 0.01
const WHEEL_ZOOM_MAX_STEP = 1.25
const WHEEL_LINE_PIXELS = 16
const WHEEL_PAGE_PIXELS = 800

/** The zoom factor of one Ctrl wheel event: wheel or pinch out zooms out. */
export const wheelZoomFactor = (wheel: Pick<WheelEvent, 'deltaY' | 'deltaMode'>): number => {
  const pixels = wheel.deltaY * (wheel.deltaMode === 1 ? WHEEL_LINE_PIXELS : wheel.deltaMode === 2 ? WHEEL_PAGE_PIXELS : 1)
  return Math.min(WHEEL_ZOOM_MAX_STEP, Math.max(1 / WHEEL_ZOOM_MAX_STEP, Math.exp(-pixels * WHEEL_ZOOM_PER_PIXEL)))
}

/** The zoom gestures of one animation frame become one request, so the window resizes the frame once a frame. */
export const createZoomAccumulator = (config: {
  readonly request: (factor: number) => void
  readonly nextFrame: (flush: () => void) => void
}): ((factor: number) => void) => {
  let pending = 1
  let scheduled = false
  const flush = (): void => {
    const factor = pending
    pending = 1
    scheduled = false
    if (factor !== 1 && Number.isFinite(factor) && factor > 0) config.request(factor)
  }
  return factor => {
    pending *= factor
    if (scheduled) return
    scheduled = true
    config.nextFrame(flush)
  }
}

export interface ViewportSize {
  readonly width: number
  readonly height: number
}

/**
 * Whether a page can be seen, as far as it can tell from inside its frame:
 * its tab is visible, its viewport has room (a frame inside a collapsed or
 * display:none pane has none), and its root intersects the top-level
 * viewport (null until the browser has said).
 */
export const pageOnScreen = (page: { readonly tabVisible: boolean; readonly viewport: ViewportSize; readonly intersecting: boolean | null }): boolean =>
  page.tabVisible && page.viewport.width > 0 && page.viewport.height > 0 && page.intersecting !== false

/** The page's visibility (pageOnScreen) and its changes, from the ports a browser page or a test gives. */
export const createPageVisibility = (ports: {
  readonly tabVisible: () => boolean
  readonly onTabVisibility: (changed: () => void) => () => void
  readonly viewport: () => ViewportSize
  readonly onResize: (changed: () => void) => () => void
  /** Reports whether the page's root intersects the top-level viewport, on every change; returns the stop. */
  readonly observeIntersection: (report: (intersecting: boolean) => void) => () => void
}) => {
  let intersecting: boolean | null = null
  const listeners = new Set<() => void>()
  const changed = (): void => { for (const listener of [...listeners]) listener() }
  let stops: Array<() => void> = []
  return {
    visible: (): boolean => pageOnScreen({ tabVisible: ports.tabVisible(), viewport: ports.viewport(), intersecting }),
    /** Calls `listener` whenever the page may have become visible or hidden; returns the stop. */
    listen: (listener: () => void): (() => void) => {
      if (listeners.size === 0) {
        stops = [
          ports.onTabVisibility(changed),
          ports.onResize(changed),
          ports.observeIntersection(next => {
            intersecting = next
            changed()
          }),
        ]
      }
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size > 0) return
        for (const stop of stops) stop()
        stops = []
        intersecting = null
      }
    },
  }
}

/** The view samples only while it can be seen: its page can be seen (pageOnScreen) and its window shows it. */
export const trackVisibility = (config: {
  readonly host: Pick<ViewHost, 'subscribe'>
  readonly documentVisible: () => boolean
  readonly onDocumentVisibility: (changed: () => void) => () => void
  readonly setVisible: (visible: boolean) => void
}): (() => void) => {
  let shown = UNFRAMED_PRESENTATION.shown
  let visible: boolean | null = null
  const apply = (): void => {
    const next = shown && config.documentVisible()
    if (next === visible) return
    visible = next
    config.setVisible(next)
  }
  const unsubscribe = config.host.subscribe(presentation => {
    shown = presentation.shown
    apply()
  })
  const stop = config.onDocumentVisibility(apply)
  return () => {
    unsubscribe()
    stop()
  }
}

/**
 * The operator acts on a view through its window: stepping to it shows it, and
 * zooming it changes its scale. Either counts as attention to the view, as
 * input inside it does, so a view the operator returns to resumes sampling.
 */
export const followPresentation = (config: {
  readonly host: Pick<ViewHost, 'subscribe'>
  readonly presented: () => void
}): (() => void) => {
  let previous: DisplayPresentation | null = null
  return config.host.subscribe(presentation => {
    const before = previous
    previous = presentation
    if (before === null || !presentation.shown) return
    if (!before.shown || before.zoom !== presentation.zoom) config.presented()
  })
}

let pageHost: ViewHost | undefined

/** This page's view host; a page has one framing window, so it has one host. */
export const embeddedDisplayFrame = (): ViewHost => {
  pageHost ??= createViewHost({
    parent: window.parent === window ? null : window.parent,
    origin: location.origin,
    listen: receive => {
      const listener = (event: MessageEvent): void => receive(event)
      window.addEventListener('message', listener)
      return () => window.removeEventListener('message', listener)
    },
    refused: data => console.error('The display window sent a presentation this view cannot read', data),
  })
  return pageHost
}

const listenTo = (target: EventTarget, type: string, listener: (event: Event) => void, options?: AddEventListenerOptions): (() => void) => {
  target.addEventListener(type, listener, options)
  return () => target.removeEventListener(type, listener, options)
}

/**
 * The browser's zoom keys and Ctrl wheel (a trackpad pinch included) zoom the
 * display through its window; the page itself never zooms. Safari reports a
 * trackpad pinch as gesture events carrying the pinch's scale so far.
 */
const forwardZoomGestures = (host: ViewHost): (() => void) => {
  const zoomBy = createZoomAccumulator({ request: factor => host.requestZoom({ factor }), nextFrame: flush => { requestAnimationFrame(flush) } })
  let pinch: number | null = null
  const pinchScale = (event: Event): number | null => {
    const scale = (event as Event & { readonly scale?: unknown }).scale
    return typeof scale === 'number' && Number.isFinite(scale) && scale > 0 ? scale : null
  }
  const stops = [
    listenTo(document, 'keydown', event => {
      const step = zoomStepOfKey(event as KeyboardEvent)
      if (step === null) return
      event.preventDefault()
      host.requestZoom({ step })
    }),
    // Not passive: only a listener that may cancel the wheel keeps the page from zooming.
    listenTo(window, 'wheel', event => {
      const wheel = event as WheelEvent
      if (!wheel.ctrlKey) return
      wheel.preventDefault()
      if (pinch === null) zoomBy(wheelZoomFactor(wheel))
    }, { passive: false }),
    listenTo(document, 'gesturestart', event => {
      event.preventDefault()
      pinch = 1
    }),
    listenTo(document, 'gesturechange', event => {
      event.preventDefault()
      const scale = pinchScale(event)
      if (pinch === null || scale === null) return
      zoomBy(scale / pinch)
      pinch = scale
    }),
    listenTo(document, 'gestureend', event => {
      event.preventDefault()
      pinch = null
    }),
  ]
  return () => { for (const stop of stops) stop() }
}

/**
 * Hosts an embedded display in the window that frames it, from mount to the
 * returned cleanup: the display samples only while it can be seen, tells the
 * window the room its content needs, and passes zoom gestures to the window.
 */
export const hostDisplayFrame = (config: {
  readonly kind: 'advice' | 'generated'
  readonly card: HTMLElement | null
  /** What the view draws now, a new value for every drawing; undefined while it connects. */
  readonly drawing: () => object | undefined
  readonly setVisible: (visible: boolean) => void
  /** The operator stepped to the view or zoomed it in its window. */
  readonly presented: () => void
}): (() => void) => {
  const card = config.card
  if (card === null) throw new Error('An embedded display has no card to measure')
  const host = embeddedDisplayFrame()
  // Gestures and the room needed go to a display window only; a frame no window
  // presents (a chat answer's inline display) zooms and scrolls as any page.
  const windowStops: Array<() => void> = []
  // A frame that is not on screen (its tab hidden, or its pane collapsed by the page around it) asks the Run nothing.
  const page = createPageVisibility({
    tabVisible: () => document.visibilityState === 'visible',
    onTabVisibility: changed => listenTo(document, 'visibilitychange', changed),
    viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
    onResize: changed => listenTo(window, 'resize', changed),
    observeIntersection: report => {
      const observer = new IntersectionObserver(entries => {
        const last = entries.at(-1)
        if (last !== undefined) report(last.isIntersecting)
      })
      observer.observe(document.documentElement)
      return () => observer.disconnect()
    },
  })
  const stops = [
    trackVisibility({
      host,
      documentVisible: page.visible,
      onDocumentVisibility: page.listen,
      setVisible: config.setVisible,
    }),
    followPresentation({ host, presented: config.presented }),
    host.whenPresented(() => {
      windowStops.push(forwardZoomGestures(host), observeDisplayExtent({ kind: config.kind, card, drawing: config.drawing, report: host.reportExtent }))
    }),
    host.listen(),
  ]
  return () => { for (const stop of [...stops, ...windowStops]) stop() }
}
