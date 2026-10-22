<script lang="ts">
  import { tick, untrack, type Component } from 'svelte'
  import {
    Check,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    ClipboardList,
    Ellipsis,
    Maximize2,
    Minimize2,
    Minus,
    Plus,
    X,
  } from 'lucide-svelte'
  import type { EmbeddedViewEnvelope, EmbeddedViewListing } from '@leitbild/contracts'
  import type { OperationalObject, SimulationRunId } from '../../core/model/index.ts'
  import type { PackWindowToolsProps } from '../../core/packs/protocol.ts'
  import type { MapFocusTarget } from '../map-runtime/types.ts'
  import { DISPLAY_ZOOM_MAX, DISPLAY_ZOOM_MIN, type DisplayFrameOpen, type DisplayFrameZoomRequest } from '../embed/display-frame-protocol.ts'
  import { openedListing } from '../embed/opened-display.ts'
  import { zoomStepOfKey } from '../embed/view-host.ts'
  import { loadUiPack } from '../pack-loader.ts'
  import ProcedureRunBadges from '../procedures/ProcedureRunBadges.svelte'
  import type { ProcedureRunSummary, ProcedureRunSummaryGroup } from '../procedures/procedure-run-selectors.ts'
  import { statusToneColor } from '../status-presentation.ts'
  import { runOnMount } from '../svelte-lifecycle.svelte.ts'
  import {
    floatingWindowBoundsForDrag,
    normalizeFloatingWindowBounds,
    type FloatingWindowDragMode,
  } from '../window-bounds.ts'
  import { activeWorkspaceId } from '../workspace-context.ts'
  import DisplayFrame from './DisplayFrame.svelte'
  import { defaultDisplayEnvelope, readDefaultDisplay } from './default-display.ts'
  import {
    acknowledgeShown,
    buildDisplayDeck,
    deckEntryAsset,
    mountedDeckEntries,
    newDisplayAnnouncement,
    observeConversation,
    observeListingsForShown,
    openingAcknowledgement,
    requestedDeckEntry,
    shownDeckEntry,
    steppedDeckEntry,
    touchMountedFrames,
    unseenListings,
    type AssetDeckEntry,
    type DeckAcknowledgement,
    type DeckAsset,
    type DeckEntry,
    type DeckRunJoin,
    type DeckStep,
    type DisplayWindowRequest,
    type MountedDeckFrame,
    type ShownDeckEntry,
  } from './display-deck.ts'
  import {
    DISPLAY_ZOOM_SLIDER,
    answerZoomStore,
    displayZoomFromSlider,
    displayZoomPercent,
    initialDisplayZoom,
    isActualSize,
    overviewZoomKey,
    overviewZoomStore,
    reduceDisplayZoom,
    sliderPercentForZoom,
    storedDisplayZoom,
    type DisplayExtent,
    type DisplaySize,
    type DisplayZoomAction,
    type DisplayZoomContext,
    type DisplayZoomState,
    type StoredDisplayZoom,
  } from './display-zoom.ts'
  import { displayWindowMaximiseMessage } from './display-window-messages.ts'
  import {
    readProcessDisplayWindowBounds,
    storeProcessDisplayWindowBounds,
    type ProcessDisplayWindowBounds,
  } from './process-display-layout.ts'

  // The one display window of a Run. It steps through every display the
  // operator can bring up here: World's default display of each asset the Run
  // observes, in rail order, and every display the conversation's answers
  // composed. Each display is live when shown and has its own zoom. Its
  // header carries the tools the shown asset's Pack gives the window
  // (windowTools), and the asset's procedures and status. The window moves,
  // resizes and maximises; it never changes what it shows unless the operator
  // asks, and Esc never closes it (inside a display, Esc is the display's Back).

  interface Props {
    /** The Run of the page, from its address: the window opens without waiting for the page to open the Run. */
    readonly simulationRunId: SimulationRunId
    /** Whether the page has opened the Run; its assets' tools and procedures wait for it. */
    readonly runJoin: DeckRunJoin
    /** The assets the Run observes, in rail order: the window opens each one's World default. */
    readonly assetObjects: ReadonlyArray<OperationalObject>
    /** The conversation's displays, oldest first, as the Host relays them. */
    readonly listings: ReadonlyArray<EmbeddedViewListing>
    readonly request: DisplayWindowRequest
    /** Whether an asset runs computer-based procedures (its Pack scopes them to it). */
    readonly runsProcedures: (object: OperationalObject) => boolean
    readonly procedureSummariesFor: (object: OperationalObject) => ProcedureRunSummaryGroup
    readonly openProcedureSystemAt: (object: OperationalObject, summary?: ProcedureRunSummary) => void
    /** Frames the page's live map (a vignette's "Show on map"). */
    readonly focusMap: (target: MapFocusTarget) => void
    readonly close: () => void
  }

  let {
    simulationRunId,
    runJoin,
    assetObjects,
    listings,
    request,
    runsProcedures,
    procedureSummariesFor,
    openProcedureSystemAt,
    focusMap,
    close,
  }: Props = $props()

  type DefaultView =
    | { readonly state: 'loading' }
    | { readonly state: 'ready'; readonly envelope: EmbeddedViewEnvelope }
    | { readonly state: 'failed'; readonly error: string }

  interface WindowDragState {
    readonly pointerId: number
    readonly mode: FloatingWindowDragMode
    readonly pointerStart: { readonly x: number; readonly y: number }
    readonly origin: ProcessDisplayWindowBounds
  }

  type Popover = 'list' | 'zoom' | 'more'
  type HeaderTier = 'wide' | 'medium' | 'narrow' | 'tiny'

  interface ResizeHandle {
    readonly placement: string
    readonly mode: FloatingWindowDragMode
    readonly label: string
    readonly orientation?: 'horizontal' | 'vertical'
  }

  const resizeHandles: ReadonlyArray<ResizeHandle> = [
    { placement: 'east', mode: 'resize-east', label: 'Resize the display window horizontally', orientation: 'vertical' },
    { placement: 'south', mode: 'resize-south', label: 'Resize the display window vertically', orientation: 'horizontal' },
    { placement: 'north', mode: 'resize-north', label: 'Resize the display window from the top', orientation: 'horizontal' },
    { placement: 'west', mode: 'resize-west', label: 'Resize the display window from the left', orientation: 'vertical' },
    { placement: 'corner', mode: 'resize-south-east', label: 'Resize the display window' },
    { placement: 'corner north-east', mode: 'resize-north-east', label: 'Resize the display window from the top right' },
    { placement: 'corner north-west', mode: 'resize-north-west', label: 'Resize the display window from the top left' },
    { placement: 'corner south-west', mode: 'resize-south-west', label: 'Resize the display window from the bottom left' },
  ]

  const emptyProcedureRunSummaries: ProcedureRunSummaryGroup = { active: [], inactive: [] }
  const windowConstraints = { minWidth: 320, minHeight: 200, margin: 12 } as const
  const zoomWriteDelayMs = 400
  const runId = untrack(() => simulationRunId)
  const overviewZooms = overviewZoomStore()
  const answerZooms = answerZoomStore()
  const windowLabelId = `display-window-title-${Math.random().toString(36).slice(2)}`

  const errorText = (err: unknown): string => err instanceof Error ? err.message : String(err)

  const currentViewport = (): DisplaySize => ({ width: window.innerWidth, height: window.innerHeight })

  let notice = $state<string | null>(null)

  const defaultWindowBounds = (viewport: DisplaySize): ProcessDisplayWindowBounds => ({
    x: windowConstraints.margin,
    y: windowConstraints.margin,
    width: viewport.width - 2 * windowConstraints.margin,
    height: viewport.height - 2 * windowConstraints.margin,
  })

  const rememberedWindowBounds = (): ProcessDisplayWindowBounds => {
    try {
      return readProcessDisplayWindowBounds({ simulationRunId: runId }) ?? defaultWindowBounds(currentViewport())
    } catch (err) {
      notice = `The remembered window position could not be read: ${errorText(err)}`
      return defaultWindowBounds(currentViewport())
    }
  }

  let viewport = $state.raw<DisplaySize>(currentViewport())
  let windowBounds = $state.raw<ProcessDisplayWindowBounds>(rememberedWindowBounds())
  let windowDrag = $state.raw<WindowDragState | null>(null)
  let maximised = $state(false)
  let shown = $state.raw<ShownDeckEntry | null>(null)
  let acknowledgement = $state.raw<DeckAcknowledgement>(openingAcknowledgement(untrack(() => listings)))
  let mountedFrames = $state.raw<ReadonlyArray<MountedDeckFrame>>([])
  let defaultViews = $state.raw<ReadonlyMap<string, DefaultView>>(new Map())
  let zoomStates = $state.raw<ReadonlyMap<string, DisplayZoomState>>(new Map())
  let extents = $state.raw<ReadonlyMap<string, DisplayExtent>>(new Map())
  let framesUp = $state.raw<ReadonlySet<string>>(new Set())
  // A display the window opened from another, or for a request from chat, and the display Back returns to.
  let returnTo = $state.raw<ReadonlyMap<string, DeckEntry>>(new Map())
  let bodySize = $state.raw<DisplaySize | null>(null)
  let popover = $state<Popover | null>(null)
  let listActiveIndex = $state(0)
  let sectionElement = $state<HTMLElement | null>(null)
  let bodyElement = $state<HTMLElement | null>(null)
  let popoverElement = $state<HTMLElement | null>(null)
  let listElement = $state<HTMLElement | null>(null)
  let positionButton = $state<HTMLButtonElement | null>(null)
  let zoomButton = $state<HTMLButtonElement | null>(null)
  let moreButton = $state<HTMLButtonElement | null>(null)
  let showSequence = 0
  let appliedRequest = -1
  let disposed = false
  const pendingZoomWrites = new Map<string, { readonly entry: DeckEntry; readonly state: DisplayZoomState }>()
  let zoomWriteTimer: ReturnType<typeof setTimeout> | null = null

  const assets = $derived<ReadonlyArray<DeckAsset>>(assetObjects.map(object => ({ objectId: object.id, packId: object.packId, label: object.label })))
  const deck = $derived(buildDisplayDeck({ simulationRunId: runId, assets, listings, shown }))
  const current = $derived(shown === null ? null : deck.find(entry => entry.key === shown!.entry.key) ?? null)
  const position = $derived(current === null ? 0 : deck.findIndex(entry => entry.key === current!.key) + 1)
  const hasPrevious = $derived(position > 1)
  const hasNext = $derived(position > 0 && position < deck.length)
  const unseen = $derived(unseenListings(acknowledgement, listings))
  const announcement = $derived(newDisplayAnnouncement(unseen))
  // The asset the shown display is about: its Pack's tools, its procedures and its status dot act on it.
  const assetTarget = $derived(current === null
    ? { ok: false as const, reason: 'No display is shown' }
    : deckEntryAsset(current, assets, runJoin))
  const assetObject = $derived(assetTarget.ok
    ? assetObjects.find(object => object.id === assetTarget.asset.objectId) ?? null
    : null)
  const assetUnavailable = $derived(assetTarget.ok ? null : assetTarget.reason)
  // The procedures control shows for an asset that runs procedures, and, disabled with its reason, while the shown display names none.
  const proceduresShown = $derived(assetObject === null ? assetUnavailable !== null : runsProcedures(assetObject))
  const procedureSummaries = $derived(assetObject !== null && runsProcedures(assetObject) ? procedureSummariesFor(assetObject) : emptyProcedureRunSummaries)
  const statusColor = $derived(assetObject === null ? null : statusToneColor(
    assetObject.operational.priority === 'critical'
      ? 'error'
      : assetObject.operational.priority === 'high'
        ? 'working'
        : assetObject.operational.status === 'normal'
          ? 'ready'
          : 'idle',
  ))
  const currentZoom = $derived(current === null ? null : zoomStates.get(current.key) ?? null)
  const zoomPercent = $derived(currentZoom === null ? 100 : displayZoomPercent(currentZoom.zoom))
  const scaled = $derived(currentZoom !== null && !isActualSize(currentZoom.zoom))
  const currentDefault = $derived(current?.source === 'asset' ? defaultViews.get(current.key) ?? null : null)
  const currentEnvelope = $derived(current === null ? null : envelopeFor(current))
  // A listing this window cannot show (another view type) says so in place of a frame.
  const currentRefusal = $derived(current?.source === 'answer' ? current.refusal : null)
  const connecting = $derived(current !== null && currentDefault?.state !== 'failed' && currentRefusal === null
    && (currentEnvelope === null || !framesUp.has(current.key)))
  const effectiveBounds = $derived<ProcessDisplayWindowBounds>(maximised
    ? {
        x: windowConstraints.margin,
        y: windowConstraints.margin,
        width: Math.max(1, viewport.width - 2 * windowConstraints.margin),
        height: Math.max(1, viewport.height - 2 * windowConstraints.margin),
      }
    : normalizeFloatingWindowBounds(windowBounds, viewport, windowConstraints))
  const tier = $derived<HeaderTier>(effectiveBounds.width >= 900
    ? 'wide'
    : effectiveBounds.width >= 700 ? 'medium' : effectiveBounds.width >= 520 ? 'narrow' : 'tiny')
  const groups = $derived([
    { id: 'assets', label: 'Overviews', entries: deck.filter(entry => entry.source === 'asset') },
    { id: 'answers', label: 'From answers', entries: deck.filter(entry => entry.source === 'answer') },
  ].filter(group => group.entries.length > 0))
  // A frame stays while its display briefly leaves the deck (the chat page reloading empties the list).
  const mountedEntries = $derived(mountedDeckEntries(mountedFrames, deck).flatMap(entry => {
    const envelope = envelopeFor(entry)
    return envelope === null ? [] : [{ entry, envelope }]
  }))

  function envelopeFor(entry: DeckEntry): EmbeddedViewEnvelope | null {
    if (entry.source === 'answer') return entry.refusal === null ? entry.listing.envelope : null
    const view = defaultViews.get(entry.key)
    return view?.state === 'ready' ? view.envelope : null
  }

  const withValue = <V,>(map: ReadonlyMap<string, V>, key: string, value: V): ReadonlyMap<string, V> => new Map(map).set(key, value)

  const withoutKey = <V,>(map: ReadonlyMap<string, V>, key: string): ReadonlyMap<string, V> => {
    if (!map.has(key)) return map
    const next = new Map(map)
    next.delete(key)
    return next
  }

  // --- Zoom ---------------------------------------------------------------

  const zoomContextFor = (entry: DeckEntry): DisplayZoomContext => {
    const extent = extents.get(entry.key) ?? null
    return {
      kind: extent?.kind ?? entry.kind,
      body: bodySize,
      extent,
      envelopeHeight: envelopeFor(entry)?.height ?? (entry.source === 'answer' ? entry.listing.envelope.height : 0),
    }
  }

  const zoomStoreFor = (entry: DeckEntry) => entry.source === 'asset' ? overviewZooms : answerZooms

  const zoomStorageKey = (entry: DeckEntry): string =>
    entry.source === 'asset' ? overviewZoomKey(runId, entry.asset.objectId) : entry.listing.key

  const flushZoomWrites = (): void => {
    zoomWriteTimer = null
    const writes = [...pendingZoomWrites.values()]
    pendingZoomWrites.clear()
    for (const { entry, state } of writes) {
      // A zoom the operator set is remembered; choosing Fit forgets it, so the display reopens at its default.
      const stored = storedDisplayZoom(state)
      try {
        if (stored === null) zoomStoreFor(entry).forget(zoomStorageKey(entry))
        else zoomStoreFor(entry).write(zoomStorageKey(entry), stored)
      } catch (err) {
        notice = `The zoom of ${entry.title} could not be remembered: ${errorText(err)}`
      }
    }
  }

  // Slider drags and pinches change zoom many times a second; only the settled zoom is written.
  const rememberZoom = (entry: DeckEntry, state: DisplayZoomState): void => {
    pendingZoomWrites.set(entry.key, { entry, state })
    if (zoomWriteTimer !== null) clearTimeout(zoomWriteTimer)
    zoomWriteTimer = setTimeout(flushZoomWrites, zoomWriteDelayMs)
  }

  const setZoomState = (key: string, state: DisplayZoomState): void => {
    const previous = zoomStates.get(key)
    if (previous && previous.zoom === state.zoom && previous.fit === state.fit && previous.auto === state.auto && previous.corrections === state.corrections) return
    zoomStates = withValue(zoomStates, key, state)
  }

  const prepareZoom = (entry: DeckEntry): void => {
    const context = zoomContextFor(entry)
    const existing = zoomStates.get(entry.key)
    if (existing) {
      setZoomState(entry.key, reduceDisplayZoom(existing, { type: 'body' }, context))
      return
    }
    let stored: StoredDisplayZoom | null = null
    try {
      stored = zoomStoreFor(entry).read(zoomStorageKey(entry))
    } catch (err) {
      notice = `The remembered zoom of ${entry.title} could not be read: ${errorText(err)}`
    }
    setZoomState(entry.key, initialDisplayZoom(context, stored))
  }

  const changeZoom = (action: DisplayZoomAction): void => {
    const entry = current
    if (entry === null) return
    const state = zoomStates.get(entry.key)
    if (!state) return
    const next = reduceDisplayZoom(state, action, zoomContextFor(entry))
    setZoomState(entry.key, next)
    rememberZoom(entry, next)
  }

  const receiveExtent = (key: string, extent: DisplayExtent): void => {
    const previous = extents.get(key)
    if (previous && previous.kind === extent.kind && previous.minWidth === extent.minWidth && previous.width === extent.width && previous.height === extent.height) return
    extents = withValue(extents, key, extent)
    // A hidden frame keeps its size, so only the shown display's zoom follows; a hidden one refits when shown.
    const entry = current
    const state = entry?.key === key ? zoomStates.get(key) : undefined
    if (entry && state) setZoomState(key, reduceDisplayZoom(state, { type: 'extent' }, zoomContextFor(entry)))
  }

  const receiveZoomRequest = (key: string, zoomRequest: DisplayFrameZoomRequest): void => {
    // A hidden frame cannot have the operator's keys or pointer; only the shown one may zoom.
    if (current?.key !== key) return
    changeZoom('step' in zoomRequest ? { type: 'step', step: zoomRequest.step } : { type: 'scale', factor: zoomRequest.factor })
  }

  const measureBody = (size: DisplaySize): void => {
    if (bodySize !== null && bodySize.width === size.width && bodySize.height === size.height) return
    bodySize = size
    // The shown display follows, even a default whose view is still loading. A hidden
    // one keeps the size it was hidden at and refits when it is shown again (showEntry).
    const entry = current
    const state = entry === null ? undefined : zoomStates.get(entry.key)
    if (entry && state) setZoomState(entry.key, reduceDisplayZoom(state, { type: 'body' }, zoomContextFor(entry)))
  }

  // --- Frames ---------------------------------------------------------------

  const frameUp = (key: string): void => {
    if (!framesUp.has(key)) framesUp = new Set([...framesUp, key])
  }

  const frameDown = (key: string): void => {
    if (framesUp.has(key)) framesUp = new Set([...framesUp].filter(candidate => candidate !== key))
    extents = withoutKey(extents, key)
  }

  // A display shown after another, its Back returning to the one it came from.
  const openAfter = (from: DeckEntry, listing: EmbeddedViewListing): void => {
    const entry = requestedDeckEntry(deck, runId, { kind: 'listing', listing })
    if (entry === null) return
    returnTo = withValue(returnTo, entry.key, from)
    showEntry(entry)
  }

  // A display asks for equipment it names to be opened after it (a safety function chip, a banner label): the
  // window shows it as a display of its own, and its Back returns to the one it came from.
  const frameOpen = (key: string, request: DisplayFrameOpen): void => {
    const from = mountedEntries.find(mounted => mounted.entry.key === key)
    if (from === undefined) return
    let listing: EmbeddedViewListing
    try {
      listing = openedListing({ key, title: from.entry.title, envelope: from.envelope }, request)
    } catch (err) {
      notice = `${request.title} cannot be opened: ${errorText(err)}`
      return
    }
    openAfter(from.entry, listing)
  }

  // A Pack's tools open a subject's World default after the shown display (a proposal's item): Back returns to it.
  const openDefaultAfter = async (subject: string): Promise<void> => {
    const from = current
    if (from === null) return
    let listing: EmbeddedViewListing
    try {
      const envelope = defaultDisplayEnvelope({ workspaceId: activeWorkspaceId(), simulationRunId: runId, view: await readDefaultDisplay(runId, subject) })
      listing = openedListing({ key: from.key, title: from.title, envelope }, { state: envelope.state, title: envelope.title })
    } catch (err) {
      if (!disposed) notice = `${subject} cannot be opened: ${errorText(err)}`
      return
    }
    if (!disposed) openAfter(from, listing)
  }

  const frameBack = (key: string): void => {
    const target = returnTo.get(key)
    if (target === undefined) return
    returnTo = withoutKey(returnTo, key)
    showEntry(deck.find(entry => entry.key === target.key) ?? target)
  }

  const frameProblem = (_key: string, problem: string): void => {
    notice = problem
  }

  const loadDefaultView = async (entry: AssetDeckEntry): Promise<void> => {
    const existing = defaultViews.get(entry.key)
    if (existing && existing.state !== 'failed') return
    defaultViews = withValue(defaultViews, entry.key, { state: 'loading' })
    try {
      const envelope = defaultDisplayEnvelope({ workspaceId: activeWorkspaceId(), simulationRunId: runId, view: await readDefaultDisplay(runId, entry.asset.objectId) })
      if (!disposed) defaultViews = withValue(defaultViews, entry.key, { state: 'ready', envelope })
    } catch (err) {
      if (!disposed) defaultViews = withValue(defaultViews, entry.key, { state: 'failed', error: errorText(err) })
    }
  }

  // --- Deck -----------------------------------------------------------------

  const showEntry = (entry: DeckEntry): void => {
    const nextShown = shownDeckEntry(deck, entry, listings)
    const nextDeck = buildDisplayDeck({ simulationRunId: runId, assets, listings, shown: nextShown })
    showSequence += 1
    shown = nextShown
    const kept = mountedFrames.filter(frame => nextDeck.some(candidate => candidate.key === frame.key))
    // A listing the window cannot show gets no frame, so it never takes a mounted frame's place.
    mountedFrames = entry.source === 'answer' && entry.refusal !== null ? kept : touchMountedFrames(kept, entry, showSequence)
    acknowledgement = acknowledgeShown(acknowledgement, listings, entry)
    prepareZoom(entry)
    if (entry.source === 'asset') void loadDefaultView(entry)
  }

  const step = (direction: DeckStep): void => {
    const next = steppedDeckEntry(deck, current?.key ?? null, direction)
    if (next !== null && next.key !== current?.key) showEntry(next)
  }

  const showNewest = (): void => {
    const newest = unseen[unseen.length - 1]
    const entry = newest === undefined ? null : deck.find(candidate => candidate.source === 'answer' && candidate.listing.key === newest.key)
    if (entry) showEntry(entry)
  }

  const focusWindow = async (): Promise<void> => {
    await tick()
    sectionElement?.focus()
  }

  const applyRequest = (next: DisplayWindowRequest): void => {
    if (next.sequence === appliedRequest) return
    appliedRequest = next.sequence
    const entry = requestedDeckEntry(deck, runId, next.target)
    // A display chat opens that the window does not list (equipment named on an answer's display) returns to what it showed.
    if (entry !== null && entry.source === 'answer' && !entry.listed && current !== null && current.key !== entry.key) returnTo = withValue(returnTo, entry.key, current)
    if (entry !== null) showEntry(entry)
    else {
      notice = 'That asset is not in this Run.'
      if (shown === null && deck[0]) showEntry(deck[0])
    }
    if (next.focus) void focusWindow()
  }

  // Requests come from the rail and, through the Host, from chat.
  $effect(() => {
    const next = request
    untrack(() => applyRequest(next))
  })

  // A new conversation list: another conversation's displays count as seen, and the shown
  // display remembers whether it is still listed and where. Before the DOM updates, so
  // "New" and the announcement never show displays that are not new, even for a moment.
  $effect.pre(() => {
    const next = listings
    untrack(() => {
      let nextAcknowledgement = observeConversation(acknowledgement, next)
      const nextShown = observeListingsForShown(shown, next)
      if (nextShown !== shown) shown = nextShown
      if (nextShown !== null) nextAcknowledgement = acknowledgeShown(nextAcknowledgement, next, nextShown.entry)
      if (nextAcknowledgement !== acknowledgement) acknowledgement = nextAcknowledgement
    })
  })

  // --- Popovers and keys ----------------------------------------------------

  const popoverTrigger = (which: Popover): HTMLElement | null =>
    which === 'list' ? positionButton : which === 'zoom' ? zoomButton : moreButton

  const closePopover = (returnFocus: boolean): void => {
    const which = popover
    if (which === null) return
    popover = null
    if (returnFocus) popoverTrigger(which)?.focus()
  }

  const openList = async (): Promise<void> => {
    if (popover === 'list') {
      closePopover(false)
      return
    }
    popover = 'list'
    listActiveIndex = Math.max(0, position - 1)
    await tick()
    listElement?.focus()
  }

  const togglePopover = (which: Popover): void => {
    popover = popover === which ? null : which
  }

  const chooseFromList = (entry: DeckEntry): void => {
    showEntry(entry)
    closePopover(true)
  }

  const listKeydown = (event: KeyboardEvent): void => {
    const last = deck.length - 1
    if (event.key === 'ArrowDown') listActiveIndex = Math.min(last, listActiveIndex + 1)
    else if (event.key === 'ArrowUp') listActiveIndex = Math.max(0, listActiveIndex - 1)
    else if (event.key === 'Home') listActiveIndex = 0
    else if (event.key === 'End') listActiveIndex = Math.max(0, last)
    else if (event.key === 'Enter' || event.key === ' ') {
      const entry = deck[listActiveIndex]
      if (entry) chooseFromList(entry)
    } else if (event.key === 'Escape') closePopover(true)
    else if (event.key === 'Tab') {
      closePopover(false)
      return
    } else return
    event.preventDefault()
    event.stopPropagation()
  }

  const optionId = (index: number): string => `${windowLabelId}-option-${index}`

  // ←/→ step only while the navigation has focus: the slider and the display keep their own arrows.
  const navigationKeydown = (event: KeyboardEvent): void => {
    const direction: DeckStep | null = event.key === 'ArrowLeft'
      ? 'previous'
      : event.key === 'ArrowRight' ? 'next' : event.key === 'Home' ? 'first' : event.key === 'End' ? 'last' : null
    if (direction === null) return
    event.preventDefault()
    step(direction)
  }

  const windowKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      // Esc closes what the chrome opened, never the window.
      if (popover !== null) {
        event.preventDefault()
        closePopover(true)
      }
      return
    }
    // The same keys as inside a display's frame (view-host.ts).
    const zoomStep = zoomStepOfKey(event)
    if (zoomStep === null || current === null) return
    event.preventDefault()
    changeZoom({ type: 'step', step: zoomStep })
  }

  const percentClicked = (): void => {
    if (tier === 'wide') changeZoom({ type: 'step', step: 'reset' })
    else togglePopover('zoom')
  }

  // --- Window bounds --------------------------------------------------------

  const postToHost = (message: unknown): void => {
    if (window.parent !== window) window.parent.postMessage(message, location.origin)
  }

  const setMaximised = (next: boolean): void => {
    if (maximised === next) return
    maximised = next
    postToHost(displayWindowMaximiseMessage(next))
  }

  const nextBoundsForDrag = (drag: WindowDragState, event: PointerEvent): ProcessDisplayWindowBounds =>
    floatingWindowBoundsForDrag({
      mode: drag.mode,
      origin: drag.origin,
      dx: event.clientX - drag.pointerStart.x,
      dy: event.clientY - drag.pointerStart.y,
    }, viewport, windowConstraints)

  const startWindowDrag = (event: PointerEvent, mode: FloatingWindowDragMode): void => {
    if (event.button !== 0 || maximised) return
    const target = event.target
    if (target instanceof Element && target.closest('button')) return
    event.preventDefault()
    const element = event.currentTarget as Element
    element.setPointerCapture(event.pointerId)
    windowDrag = {
      pointerId: event.pointerId,
      mode,
      pointerStart: { x: event.clientX, y: event.clientY },
      origin: effectiveBounds,
    }
  }

  const updateWindowDrag = (event: PointerEvent): void => {
    const drag = windowDrag
    if (!drag || drag.pointerId !== event.pointerId) return
    windowBounds = nextBoundsForDrag(drag, event)
  }

  const finishWindowDrag = (event: PointerEvent): void => {
    const drag = windowDrag
    if (!drag || drag.pointerId !== event.pointerId) return
    const next = nextBoundsForDrag(drag, event)
    windowBounds = next
    windowDrag = null
    try {
      storeProcessDisplayWindowBounds({ simulationRunId: runId, bounds: next })
    } catch (err) {
      notice = `The window position could not be remembered: ${errorText(err)}`
    }
  }

  // --- The asset's tools and procedures ---------------------------------------

  // The tools the shown asset's Pack gives the window's header, loaded once per Pack; a Pack that gives none adds none.
  let toolsByPack = $state.raw<ReadonlyMap<string, Component<PackWindowToolsProps> | null>>(new Map())
  const toolsPack = $derived(assetTarget.ok ? assetTarget.asset.packId : null)
  $effect(() => {
    const packId = toolsPack
    if (packId === null || untrack(() => toolsByPack.has(packId))) return
    void (async (): Promise<void> => {
      try {
        const load = (await loadUiPack(packId)).ui?.windowTools
        const tools = load === undefined ? null : (await load()).default
        if (!disposed) toolsByPack = withValue(toolsByPack, packId, tools)
      } catch (err) {
        if (!disposed) notice = `The window tools of ${packId} cannot be loaded: ${errorText(err)}`
      }
    })()
  })
  const Tools = $derived(toolsPack === null ? null : toolsByPack.get(toolsPack) ?? null)

  const openProcedures = (summary?: ProcedureRunSummary): void => {
    popover = null
    if (assetObject !== null) openProcedureSystemAt(assetObject, summary)
  }

  runOnMount(() => {
    const resize = (): void => {
      viewport = currentViewport()
    }
    const outside = (event: PointerEvent): void => {
      if (popover === null) return
      const target = event.target
      if (!(target instanceof Node)) return
      if (popoverElement?.contains(target) || popoverTrigger(popover)?.contains(target)) return
      popover = null
    }
    // Focus moving into a display frame leaves no pointer event here.
    const blurred = (): void => {
      popover = null
    }
    const observer = new ResizeObserver(entries => {
      const box = entries[0]?.contentRect
      if (box) measureBody({ width: box.width, height: box.height })
    })
    if (bodyElement) observer.observe(bodyElement)
    window.addEventListener('resize', resize)
    window.addEventListener('blur', blurred)
    document.addEventListener('pointerdown', outside, true)
    return () => {
      disposed = true
      observer.disconnect()
      window.removeEventListener('resize', resize)
      window.removeEventListener('blur', blurred)
      document.removeEventListener('pointerdown', outside, true)
      if (zoomWriteTimer !== null) {
        clearTimeout(zoomWriteTimer)
        flushZoomWrites()
      }
      // The Host gets its split back when the window goes.
      if (maximised) postToHost(displayWindowMaximiseMessage(false))
    }
  })
</script>

<div class="process-display-window-layer">
  <!-- Zoom keys and Esc act while focus is anywhere in the window: the section delegates them from its controls. -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <section
    bind:this={sectionElement}
    class="process-display-window display-window"
    class:maximised
    class:dragging={windowDrag !== null}
    style="left: {effectiveBounds.x}px; top: {effectiveBounds.y}px; width: {effectiveBounds.width}px; height: {effectiveBounds.height}px;"
    tabindex="-1"
    aria-labelledby={windowLabelId}
    onkeydown={windowKeydown}
  >
    <header class="display-window-header">
      <!-- ←/→/Home/End step while focus is on any navigation control. -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div class="display-window-nav" role="group" aria-label="Displays" onkeydown={navigationKeydown}>
        <button
          type="button"
          class="display-window-button"
          aria-label="Previous display"
          title="Previous display"
          aria-disabled={!hasPrevious}
          onclick={() => step('previous')}
        >
          <ChevronLeft size={18} aria-hidden="true" />
        </button>
        <button
          bind:this={positionButton}
          type="button"
          class="display-window-position"
          aria-haspopup="listbox"
          aria-expanded={popover === 'list'}
          aria-label="Display {position} of {deck.length}. Choose a display"
          title="Choose a display"
          onclick={() => { void openList() }}
        >
          <span>{position} / {deck.length}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          class="display-window-button"
          aria-label="Next display"
          title="Next display"
          aria-disabled={!hasNext}
          onclick={() => step('next')}
        >
          <ChevronRight size={18} aria-hidden="true" />
        </button>
        {#if unseen.length > 0}
          <button
            type="button"
            class="display-window-new"
            aria-label="Show the newest display: {unseen[unseen.length - 1]!.envelope.title}"
            title="Show the newest display"
            onclick={showNewest}
          >New ›</button>
        {/if}
      </div>

      <!-- The title strip moves the window; double-click maximises (also ⤢). -->
      <div
        class="display-window-title"
        role="presentation"
        onpointerdown={(event) => startWindowDrag(event, 'move')}
        onpointermove={updateWindowDrag}
        onpointerup={finishWindowDrag}
        onpointercancel={finishWindowDrag}
        ondblclick={() => setMaximised(!maximised)}
      >
        <span
          class="process-display-asset-dot"
          class:unknown={statusColor === null}
          style:background={statusColor}
          title={assetObject === null ? (assetUnavailable ?? '') : `${assetObject.label}: ${assetObject.operational.status}`}
        ></span>
        <strong id={windowLabelId}>{current?.title ?? 'Displays'}</strong>
        {#if current !== null && tier !== 'narrow' && tier !== 'tiny'}
          <span class="display-window-caption">· {current.caption}</span>
        {/if}
      </div>

      <div class="display-window-zoom" role="group" aria-label="Zoom">
        {#if tier !== 'tiny'}
          <button
            type="button"
            class="display-window-button"
            aria-label="Zoom out"
            title="Zoom out"
            disabled={currentZoom === null || currentZoom.zoom <= DISPLAY_ZOOM_MIN}
            onclick={() => changeZoom({ type: 'step', step: 'out' })}
          >
            <Minus size={16} aria-hidden="true" />
          </button>
        {/if}
        {#if tier === 'wide'}
          <input
            class="display-window-slider"
            type="range"
            min={DISPLAY_ZOOM_SLIDER.min}
            max={DISPLAY_ZOOM_SLIDER.max}
            step={DISPLAY_ZOOM_SLIDER.step}
            value={sliderPercentForZoom(currentZoom?.zoom ?? 1)}
            disabled={currentZoom === null}
            aria-label="Zoom"
            aria-valuetext="{zoomPercent} %"
            oninput={(event) => changeZoom({ type: 'set', zoom: displayZoomFromSlider(Number(event.currentTarget.value)) })}
          />
        {/if}
        {#if tier !== 'tiny'}
          <button
            type="button"
            class="display-window-button"
            aria-label="Zoom in"
            title="Zoom in"
            disabled={currentZoom === null || currentZoom.zoom >= DISPLAY_ZOOM_MAX}
            onclick={() => changeZoom({ type: 'step', step: 'in' })}
          >
            <Plus size={16} aria-hidden="true" />
          </button>
        {/if}
        <button
          bind:this={zoomButton}
          type="button"
          class="display-window-percent"
          class:scaled
          aria-label={tier === 'wide' ? `Zoom ${zoomPercent} %. Show at 100 %` : `Zoom ${zoomPercent} %. Zoom options`}
          title={tier === 'wide' ? 'Show at 100 %' : 'Zoom options'}
          aria-haspopup={tier === 'wide' ? undefined : 'dialog'}
          aria-expanded={tier === 'wide' ? undefined : popover === 'zoom'}
          disabled={currentZoom === null}
          onclick={percentClicked}
        >{zoomPercent} %</button>
        {#if tier !== 'tiny'}
          <button
            type="button"
            class="display-window-fit"
            aria-pressed={currentZoom?.fit ?? false}
            title="Fit the display to the window; its text stays readable and the display scrolls where it does not fit"
            disabled={currentZoom === null}
            onclick={() => changeZoom({ type: 'toggle-fit' })}
          >Fit</button>
        {/if}
      </div>

      {#if (tier === 'wide' || tier === 'medium') && proceduresShown}
        <div class="display-window-procedures" role="group" aria-label="Procedures">
          <ProcedureRunBadges summaries={procedureSummaries} onOpen={openProcedures} />
          <button
            type="button"
            class="display-window-button"
            aria-label={assetObject !== null ? `Computer-based procedures for ${assetObject.label}` : `Procedures unavailable: ${assetUnavailable ?? ''}`}
            title={assetObject !== null ? `Computer-based procedures for ${assetObject.label}` : (assetUnavailable ?? '')}
            aria-disabled={assetObject === null}
            onclick={() => openProcedures()}
          >
            <ClipboardList size={17} aria-hidden="true" />
          </button>
        </div>
      {/if}
      {#if Tools !== null && assetTarget.ok}
        {@const asset = assetTarget.asset}
        {#key asset.objectId}
          <Tools runId={runId} objectId={asset.objectId} openDisplay={(subject: string) => { void openDefaultAfter(subject) }} />
        {/key}
      {/if}
      {#if tier === 'wide' || tier === 'medium'}
        <button
          type="button"
          class="display-window-button"
          aria-label={maximised ? 'Restore the display window' : 'Maximise the display window'}
          title={maximised ? 'Restore' : 'Maximise'}
          onclick={() => setMaximised(!maximised)}
        >
          {#if maximised}<Minimize2 size={16} aria-hidden="true" />{:else}<Maximize2 size={16} aria-hidden="true" />{/if}
        </button>
      {:else}
        <button
          bind:this={moreButton}
          type="button"
          class="display-window-button display-window-more"
          aria-label={proceduresShown ? 'More: procedures, maximise' : 'More: maximise'}
          title="More"
          aria-haspopup="true"
          aria-expanded={popover === 'more'}
          onclick={() => togglePopover('more')}
        >
          <Ellipsis size={18} aria-hidden="true" />
          {#if procedureSummaries.active.length > 0}
            <span class="display-window-count" aria-label="{procedureSummaries.active.length} active procedures">{procedureSummaries.active.length}</span>
          {/if}
        </button>
      {/if}
      <button
        type="button"
        class="display-window-button"
        aria-label="Close the display window"
        title="Close"
        onclick={close}
      >
        <X size={19} aria-hidden="true" />
      </button>
    </header>

    <div class="display-window-body" bind:this={bodyElement}>
      {#each mountedEntries as mounted (mounted.entry.key)}
        <DisplayFrame
          entryKey={mounted.entry.key}
          envelope={mounted.envelope}
          title="{mounted.entry.title} · {mounted.entry.caption}"
          shown={mounted.entry.key === current?.key}
          zoom={zoomStates.get(mounted.entry.key)?.zoom ?? 1}
          kind={extents.get(mounted.entry.key)?.kind ?? mounted.entry.kind}
          extent={extents.get(mounted.entry.key) ?? null}
          onUp={frameUp}
          onDown={frameDown}
          onExtent={receiveExtent}
          onZoomRequest={receiveZoomRequest}
          onProblem={frameProblem}
          back={returnTo.get(mounted.entry.key)?.title ?? null}
          onOpen={frameOpen}
          onBack={frameBack}
          onMap={bounds => focusMap({ kind: 'bounds', bounds })}
        />
      {/each}
      {#if current === null}
        <div class="display-window-message">No display to show.</div>
      {:else if currentRefusal !== null}
        <div class="display-window-message" role="status">
          <span><strong>{current.title}</strong> cannot be shown here: {currentRefusal}.</span>
        </div>
      {:else if currentDefault?.state === 'failed' && current.source === 'asset'}
        {@const failedEntry = current}
        <div class="display-window-message error" role="alert">
          <span>{currentDefault.error}</span>
          <button type="button" onclick={() => { void loadDefaultView(failedEntry) }}>Retry</button>
        </div>
      {:else if connecting}
        <div class="display-window-message" role="status">
          <span class="process-display-spinner" aria-hidden="true"></span>
          <span>Connecting to the Run…</span>
        </div>
      {/if}
      {#if notice}
        <div class="process-display-notice" role="status">
          <span>{notice}</span>
          <button type="button" aria-label="Dismiss" onclick={() => { notice = null }}><X size={16} aria-hidden="true" /></button>
        </div>
      {/if}
    </div>

    {#if popover === 'list'}
      <div bind:this={popoverElement} class="display-window-popover list">
        <div
          bind:this={listElement}
          class="display-window-listbox"
          role="listbox"
          tabindex="-1"
          aria-label="Displays"
          aria-activedescendant={optionId(listActiveIndex)}
          onkeydown={listKeydown}
        >
          {#each groups as group (group.id)}
            <div role="group" aria-labelledby="{windowLabelId}-{group.id}">
              <div class="display-window-group-label" id="{windowLabelId}-{group.id}">{group.label}</div>
              {#each group.entries as entry (entry.key)}
                {@const index = deck.indexOf(entry)}
                <!-- The listbox owns the keys (aria-activedescendant); a click picks the option. -->
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <div
                  id={optionId(index)}
                  class="display-window-option"
                  class:active={index === listActiveIndex}
                  role="option"
                  tabindex="-1"
                  aria-selected={entry.key === current?.key}
                  onclick={() => chooseFromList(entry)}
                  onpointermove={() => { listActiveIndex = index }}
                >
                  <span class="display-window-check" aria-hidden="true">{#if entry.key === current?.key}<Check size={14} />{/if}</span>
                  <span class="display-window-option-text">
                    <strong>{entry.title}</strong>
                    <small>{entry.caption}</small>
                  </span>
                </div>
              {/each}
            </div>
          {/each}
        </div>
      </div>
    {:else if popover === 'zoom'}
      <div bind:this={popoverElement} class="display-window-popover zoom" role="dialog" aria-label="Zoom">
        {#if tier === 'tiny'}
          <button type="button" class="display-window-button" aria-label="Zoom out" disabled={currentZoom === null || currentZoom.zoom <= DISPLAY_ZOOM_MIN} onclick={() => changeZoom({ type: 'step', step: 'out' })}>
            <Minus size={16} aria-hidden="true" />
          </button>
        {/if}
        <input
          class="display-window-slider"
          type="range"
          min={DISPLAY_ZOOM_SLIDER.min}
          max={DISPLAY_ZOOM_SLIDER.max}
          step={DISPLAY_ZOOM_SLIDER.step}
          value={sliderPercentForZoom(currentZoom?.zoom ?? 1)}
          disabled={currentZoom === null}
          aria-label="Zoom"
          aria-valuetext="{zoomPercent} %"
          oninput={(event) => changeZoom({ type: 'set', zoom: displayZoomFromSlider(Number(event.currentTarget.value)) })}
        />
        {#if tier === 'tiny'}
          <button type="button" class="display-window-button" aria-label="Zoom in" disabled={currentZoom === null || currentZoom.zoom >= DISPLAY_ZOOM_MAX} onclick={() => changeZoom({ type: 'step', step: 'in' })}>
            <Plus size={16} aria-hidden="true" />
          </button>
        {/if}
        <!-- The readout is the button that opened this popover; this one is an action, and says so. -->
        <button type="button" class="display-window-reset" disabled={currentZoom === null} onclick={() => changeZoom({ type: 'step', step: 'reset' })}>Reset to 100 %</button>
        {#if tier === 'tiny'}
          <button type="button" class="display-window-fit" aria-pressed={currentZoom?.fit ?? false} disabled={currentZoom === null} onclick={() => changeZoom({ type: 'toggle-fit' })}>Fit</button>
        {/if}
      </div>
    {:else if popover === 'more'}
      <div bind:this={popoverElement} class="display-window-popover more" role="group" aria-label="More">
        {#if proceduresShown}
          <ProcedureRunBadges summaries={procedureSummaries} onOpen={openProcedures} />
          <button
            type="button"
            class="display-window-menu-item"
            title={assetObject !== null ? '' : (assetUnavailable ?? '')}
            aria-disabled={assetObject === null}
            onclick={() => openProcedures()}
          >
            <ClipboardList size={16} aria-hidden="true" />
            <span>{assetObject !== null ? `Procedures for ${assetObject.label}` : `Procedures: ${assetUnavailable ?? ''}`}</span>
          </button>
        {/if}
        <button
          type="button"
          class="display-window-menu-item"
          onclick={() => { popover = null; setMaximised(!maximised) }}
        >
          {#if maximised}<Minimize2 size={16} aria-hidden="true" />{:else}<Maximize2 size={16} aria-hidden="true" />{/if}
          <span>{maximised ? 'Restore the window' : 'Maximise the window'}</span>
        </button>
      </div>
    {/if}

    <div class="display-window-live" aria-live="polite">{announcement}</div>

    {#if !maximised}
      {#each resizeHandles as handle (handle.mode)}
        <div
          class="process-display-resize-handle {handle.placement}"
          role="separator"
          aria-orientation={handle.orientation}
          aria-label={handle.label}
          onpointerdown={(event) => startWindowDrag(event, handle.mode)}
          onpointermove={updateWindowDrag}
          onpointerup={finishWindowDrag}
          onpointercancel={finishWindowDrag}
        ></div>
      {/each}
    {/if}
  </section>
</div>
