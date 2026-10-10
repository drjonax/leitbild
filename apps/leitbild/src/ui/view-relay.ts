import {
  embeddedViewHostMessageSchema,
  embeddedViewOpenMessageSchema,
  embeddedViewsMessageSchema,
  embeddedViewWindowMaximiseMessageSchema,
  embeddedViewWindowReadyMessageSchema,
  type EmbeddedViewHostMessage,
  type EmbeddedViewListing,
  type EmbeddedViewOpenMessage,
  type EmbeddedViewsMessage,
  type WorkspaceResourceReference,
} from '@leitbild/contracts'
import type { ZodError } from 'zod'

// The Host relays the one process display window's messages between the
// Agents frame, which lists the displays its answers composed and asks for one
// to be opened, and the World frame, whose page shows the window. The relay is
// the only validator on that path: every message is parsed with its contract
// schema and must name this page's Workspace, and every refusal is reported
// where the operator sees it. It keeps only the latest list, whether the World
// document listens, and at most one open waiting for it; it never reads a
// view's state. What it posts is freshly parsed plain data, never UI state.

/** How long an open waits for the World page to listen before it is reported as failed. */
export const PENDING_VIEW_OPEN_MS = 30_000

/** The World pane beside the chat: none (chat only), collapsed by the split, or shown. */
export type WorldPane = 'absent' | 'collapsed' | 'shown'

// The contract's window messages share this prefix. Other messages from the
// two frames are not part of the window's protocol and are not judged here.
const VIEW_MESSAGE_PREFIX = 'leitbild:view'

const viewMessageType = (data: unknown): string | null => {
  if (typeof data !== 'object' || data === null) return null
  const type = (data as { readonly type?: unknown }).type
  return typeof type === 'string' && type.startsWith(VIEW_MESSAGE_PREFIX) ? type : null
}

/** The first schema issue and where it is, short enough for the error banner. */
const firstIssue = (error: ZodError): string => {
  const issue = error.issues[0]
  if (issue === undefined) return error.message
  return issue.path.length === 0 ? issue.message : `${issue.path.map(String).join('.')}: ${issue.message}`
}

export const createViewRelay = (config: {
  /** The Workspace this page shows; a view of any other Workspace is refused. */
  readonly workspaceId: () => string
  readonly worldPane: () => WorldPane
  /**
   * Why the Run may not be opened beside the chat, or null when it may: the
   * Workspace must list it (after reading the catalog again on a miss, since
   * an agent may just have started it) and the shown room's scope contain it.
   */
  readonly runRefusal: (run: WorkspaceResourceReference) => Promise<string | null>
  readonly postToWorld: (message: EmbeddedViewsMessage | EmbeddedViewOpenMessage) => void
  readonly postToAgents: (message: EmbeddedViewHostMessage) => void
  /** Brings a collapsed World pane back beside the chat. */
  readonly showWorld: () => void
  /** The window asks for the whole Workspace area (true) or for the split back (false). */
  readonly maximiseWorld: (maximised: boolean) => void
  /** Opens the Run in a World pane beside the chat, as switching Runs does. */
  readonly openRun: (runId: string) => void
  readonly reportError: (message: string) => void
  /** Calls `expire` after `ms` unless the returned cancel runs first. */
  readonly startTimer: (ms: number, expire: () => void) => () => void
}) => {
  // The latest list of the current Agents document, oldest first.
  let views: ReadonlyArray<EmbeddedViewListing> = []
  // Whether the current World document said it listens.
  let worldListening = false
  // The one open that waits for a World document to listen; a later open replaces it.
  let pending: { readonly view: EmbeddedViewListing; readonly cancel: () => void } | null = null
  // Counts opens, so a Run check still running for an earlier one does nothing.
  let openSequence = 0

  const viewsMessage = (): EmbeddedViewsMessage => embeddedViewsMessageSchema.parse({ type: 'leitbild:views', views })
  const openMessage = (view: EmbeddedViewListing): EmbeddedViewOpenMessage =>
    embeddedViewOpenMessageSchema.parse({ type: 'leitbild:view-open', view })

  const foreign = (view: EmbeddedViewListing): boolean => view.envelope.subject.workspaceId !== config.workspaceId()

  const dropPending = (): void => {
    pending?.cancel()
    pending = null
  }

  const keepPending = (view: EmbeddedViewListing): void => {
    dropPending()
    const cancel = config.startTimer(PENDING_VIEW_OPEN_MS, () => {
      pending = null
      config.reportError(`Display could not be opened: the World page did not answer within ${PENDING_VIEW_OPEN_MS / 1_000} s`)
    })
    pending = { view, cancel }
  }

  const forgetViews = (): void => {
    if (views.length === 0) return
    views = []
    if (worldListening) config.postToWorld(viewsMessage())
  }

  const receiveViews = (data: unknown): void => {
    const parsed = embeddedViewsMessageSchema.safeParse(data)
    if (!parsed.success) return config.reportError(`Display list refused: ${firstIssue(parsed.error)}`)
    if (parsed.data.views.some(foreign)) return config.reportError('Display list refused: a display belongs to another Workspace')
    views = parsed.data.views
    if (worldListening) config.postToWorld(viewsMessage())
  }

  const receiveOpen = (data: unknown): void => {
    const parsed = embeddedViewOpenMessageSchema.safeParse(data)
    if (!parsed.success) return config.reportError(`Display could not be opened: ${firstIssue(parsed.error)}`)
    const view = parsed.data.view
    if (foreign(view)) return config.reportError('Display could not be opened: it belongs to another Workspace')
    const sequence = ++openSequence
    if (config.worldPane() === 'absent') return void openBesideChat(view, sequence)
    deliver(view)
  }

  const deliver = (view: EmbeddedViewListing): void => {
    // A shown World pane keeps its Run: the window shows a display of another Run as it is.
    if (config.worldPane() === 'collapsed') config.showWorld()
    if (!worldListening) return keepPending(view)
    dropPending()
    config.postToWorld(openMessage(view))
  }

  // Chat only: open the display's Run beside the chat, then show the display
  // once its World page listens. A Run that may not be opened there is refused
  // visibly, never opened in a way that closes the chat.
  const openBesideChat = async (view: EmbeddedViewListing, sequence: number): Promise<void> => {
    let refusal: string | null
    try {
      refusal = await config.runRefusal(view.envelope.subject)
    } catch (error) {
      refusal = `Display could not be opened: ${error instanceof Error ? error.message : String(error)}`
    }
    if (sequence !== openSequence) return
    if (refusal !== null) return config.reportError(refusal)
    // A World pane opened meanwhile shows the display as any open would.
    if (config.worldPane() !== 'absent') return deliver(view)
    keepPending(view)
    config.openRun(view.envelope.subject.id)
  }

  const receiveReady = (data: unknown): void => {
    const parsed = embeddedViewWindowReadyMessageSchema.safeParse(data)
    if (!parsed.success) return config.reportError(`Display window message refused: ${firstIssue(parsed.error)}`)
    worldListening = true
    config.postToWorld(viewsMessage())
    if (pending === null) return
    const { view } = pending
    dropPending()
    config.postToWorld(openMessage(view))
  }

  const receiveMaximise = (data: unknown): void => {
    const parsed = embeddedViewWindowMaximiseMessageSchema.safeParse(data)
    if (!parsed.success) return config.reportError(`Display window message refused: ${firstIssue(parsed.error)}`)
    config.maximiseWorld(parsed.data.maximised)
  }

  return {
    /** A message whose source is the Agents frame's window. */
    fromAgents: (data: unknown): void => {
      const type = viewMessageType(data)
      if (type === null) return
      if (type === 'leitbild:views') return receiveViews(data)
      if (type === 'leitbild:view-open') return receiveOpen(data)
      config.reportError(`Display message refused: the Agents page does not send ${type}`)
    },
    /** A message whose source is the World frame's window. */
    fromWorld: (data: unknown): void => {
      const type = viewMessageType(data)
      if (type === null) return
      if (type === 'leitbild:view-window-ready') return receiveReady(data)
      if (type === 'leitbild:view-window-maximise') return receiveMaximise(data)
      config.reportError(`Display message refused: the World page does not send ${type}`)
    },
    /**
     * A new Agents document finished loading: its list starts empty, and it
     * learns that a Host relays what it lists and opens.
     */
    agentsFrameLoaded: (): void => {
      forgetViews()
      config.postToAgents(embeddedViewHostMessageSchema.parse({ type: 'leitbild:view-host' }))
    },
    /** The Agents frame shows another Room or closed: its displays leave the window's list. */
    agentsFrameUnloaded: forgetViews,
    /**
     * The World frame shows another Run or closed. Its next document listens
     * only once it says so, and its window starts unmaximised. A pending open
     * stays for that document or expires.
     */
    worldFrameUnloaded: (): void => {
      worldListening = false
      config.maximiseWorld(false)
    },
    dispose: dropPending,
  }
}

export type ViewRelay = ReturnType<typeof createViewRelay>
