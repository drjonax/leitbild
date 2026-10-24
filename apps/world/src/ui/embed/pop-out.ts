// A display popped out into a browser window of its own (multiunit plan §4):
// the same embed route, opened top-level from a click, its display in the URL
// fragment so it survives a reload. It holds its own viewer lease on the Run,
// a Run-scoped WebSocket attached only to a Run that is loaded, while it is
// visible, so the Run stays loaded after its Run page closes. It never loads a
// Run: when the lease is lost (the Run closed or reset by someone else, or the
// connection dropped) it reads FROZEN, then says it is closed.
import type { SimulationRunId } from '../../core/model/index.ts'
import { workspaceApiPath } from '../workspace-context.ts'
import type { ScheduleTimer } from './display-relay.ts'
import { vignetteRoutes } from './vignette/vignette-client.ts'

/** How long a lost lease reads FROZEN before the pop-out says it is closed. */
export const FROZEN_BEFORE_CLOSED_MS = 3_000

export type RunPresenceAnswer = 'loaded' | 'not-loaded' | 'missing'

export type ViewerLeasePhase =
  /** Hidden, or not yet shown: no lease, on the same rules as sampling. */
  | { readonly kind: 'released' }
  | { readonly kind: 'attaching' }
  | { readonly kind: 'held' }
  /** The lease was lost: the display reads FROZEN, and is closed shortly. */
  | { readonly kind: 'lost'; readonly reason: string }
  /** Closed for good; reloading the window attaches again if the Run is still loaded. */
  | { readonly kind: 'closed'; readonly reason: string }

export interface ViewerSocket {
  readonly close: () => void
}

export interface ViewerLeasePorts {
  /** Whether the Run is loaded; never loads it. */
  readonly presence: () => Promise<RunPresenceAnswer>
  /** Opens the Run-scoped WebSocket that attaches only to a loaded Run. */
  readonly connect: (events: { readonly ready: () => void; readonly closed: () => void }) => ViewerSocket
  readonly schedule: ScheduleTimer
}

const NOT_LOADED = 'the Run is not loaded, and a pop-out never opens one'
const MISSING = 'the Run no longer exists'

export const createViewerLease = (ports: ViewerLeasePorts) => {
  let phase: ViewerLeasePhase = { kind: 'released' }
  let visible = false
  let socket: ViewerSocket | null = null
  /** Each attach counts up; a late answer of an earlier one is ignored. */
  let attempt = 0
  let cancelClose: (() => void) | null = null
  const subscribers = new Set<(phase: ViewerLeasePhase) => void>()

  const set = (next: ViewerLeasePhase): void => {
    phase = next
    for (const subscriber of [...subscribers]) subscriber(phase)
  }
  const drop = (): void => {
    attempt += 1
    const open = socket
    socket = null
    open?.close()
  }
  const ended = (): boolean => phase.kind === 'lost' || phase.kind === 'closed'
  const close = (reason: string): void => {
    drop()
    cancelClose?.()
    cancelClose = null
    set({ kind: 'closed', reason })
  }
  const lose = (reason: string): void => {
    if (ended()) return
    drop()
    set({ kind: 'lost', reason })
    cancelClose = ports.schedule(() => { cancelClose = null; close(reason) }, FROZEN_BEFORE_CLOSED_MS)
  }

  const attach = async (): Promise<void> => {
    attempt += 1
    const mine = attempt
    set({ kind: 'attaching' })
    const presence = await ports.presence()
    if (mine !== attempt || ended()) return
    if (presence !== 'loaded') { close(presence === 'missing' ? MISSING : NOT_LOADED); return }
    let readied = false
    socket = ports.connect({
      ready: () => {
        if (mine !== attempt) return
        // A second ready on one connection: the Run was reset, or closed and loaded again.
        if (readied) { lose('the Run was reset or restarted'); return }
        readied = true
        set({ kind: 'held' })
      },
      closed: () => {
        if (mine !== attempt) return
        socket = null
        if (readied) { lose('the connection to the Run was lost'); return }
        // Refused before it held the Run: the Run closed meanwhile, or it admits only screens holding a role.
        void ports.presence().then(now => {
          if (mine !== attempt || ended()) return
          close(now === 'missing' ? MISSING : now === 'not-loaded' ? NOT_LOADED : 'this Run admits only screens holding a role, and a pop-out holds none')
        })
      },
    })
  }

  return {
    current: (): ViewerLeasePhase => phase,
    subscribe: (subscriber: (phase: ViewerLeasePhase) => void): (() => void) => {
      subscriber(phase)
      subscribers.add(subscriber)
      return () => { subscribers.delete(subscriber) }
    },
    /** Holds the lease while the window can be seen, and releases it while it cannot. */
    setVisible: (shown: boolean): void => {
      if (shown === visible) return
      visible = shown
      if (ended()) return
      if (shown) { void attach(); return }
      drop()
      set({ kind: 'released' })
    },
    /** The display found the Run gone (not loaded, or deleted) while this window held it. */
    runGone: (missing: boolean): void => {
      if (phase.kind === 'held') lose(missing ? MISSING : 'the Run was closed')
    },
    stop: (): void => {
      drop()
      cancelClose?.()
      cancelClose = null
    },
  }
}

export type ViewerLease = ReturnType<typeof createViewerLease>

const browserTimer: ScheduleTimer = (run, delayMs) => {
  const handle = setTimeout(run, delayMs)
  return () => clearTimeout(handle)
}

/** The lease as a browser page holds it: World's presence route, and the Run's WebSocket with `attach=loaded`. */
export const browserViewerLease = (runId: SimulationRunId): ViewerLease => createViewerLease({
  presence: async () => {
    const presence = await vignetteRoutes.presence(runId)
    return presence === null ? 'missing' : presence.loaded ? 'loaded' : 'not-loaded'
  },
  connect: events => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${protocol}//${location.host}${workspaceApiPath('/ws')}?simulationRun=${encodeURIComponent(runId)}&attach=loaded`)
    socket.addEventListener('message', event => {
      // Only the ready message matters here; the Run's events are the Run page's business.
      if (typeof event.data === 'string' && (JSON.parse(event.data) as { readonly type?: unknown }).type === 'realtime.ready') events.ready()
    })
    socket.addEventListener('close', () => events.closed())
    return { close: () => socket.close() }
  },
  schedule: browserTimer,
})
