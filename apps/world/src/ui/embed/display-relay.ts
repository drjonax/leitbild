// The relay between a display popped out into a window of its own and the
// World pages of its Workspace (multiunit plan §4): "Return to panel", and a
// display the pop-out opens, go to the display window of a World page on the
// same Run. A BroadcastChannel reaches only pages of this origin, and survives
// reloading either window; each message is validated and names its Workspace
// and Run.
import {
  embeddedViewFragment,
  embeddedViewListingSchema,
  embeddedViewPath,
  embeddedViewWindowName,
  EMBEDDED_VIEW_WINDOW_FEATURES,
  type EmbeddedViewEnvelope,
  type EmbeddedViewListing,
} from '@leitbild/contracts'
import { digest } from './opened-display.ts'

/** Pops the display out into its window, from the click so pop-up blockers allow it; false where the browser refused. */
export const popOutDisplay = (envelope: EmbeddedViewEnvelope): boolean =>
  window.open(`${embeddedViewPath(envelope)}${embeddedViewFragment(envelope)}`, embeddedViewWindowName(envelope), EMBEDDED_VIEW_WINDOW_FEATURES) !== null

/** A popped-out display as the display window lists it when it returns there. */
export const popOutListing = (envelope: EmbeddedViewEnvelope): EmbeddedViewListing => embeddedViewListingSchema.parse({
  key: `popped-out:${digest(`${envelope.subject.id}\n${envelope.state}`)}`,
  caption: 'Back from its own window',
  envelope,
})

/** A BroadcastChannel reaches only pages of this origin; one channel per Workspace. */
export const displayRelayChannelName = (workspaceId: string): string => `leitbild.world.display-relay:${workspaceId}`

/** How long a pop-out waits for a World page on its Run to take a display. */
export const RELAY_ANSWER_MS = 1_500

/** Pop-out -> World pages: show this display in the display window of its Run ("return": the pop-out then closes). */
export interface DisplayRelayRequest {
  readonly type: 'world:display-relay'
  readonly request: string
  readonly purpose: 'return' | 'open'
  readonly listing: EmbeddedViewListing
}

/** World page -> pop-out: its display window took the request. */
export interface DisplayRelayTaken {
  readonly type: 'world:display-relay-taken'
  readonly request: string
}

const REQUEST_ID = /^[a-z0-9-]{8,64}$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasKeys = (record: Record<string, unknown>, keys: ReadonlyArray<string>): boolean =>
  Object.keys(record).sort().join() === [...keys].sort().join()

/** A relay request about a display of this Workspace; null for anything else. */
export const parseDisplayRelayRequest = (value: unknown, workspaceId: string): DisplayRelayRequest | null => {
  if (!isRecord(value) || value.type !== 'world:display-relay' || !hasKeys(value, ['type', 'request', 'purpose', 'listing'])) return null
  if (typeof value.request !== 'string' || !REQUEST_ID.test(value.request)) return null
  if (value.purpose !== 'return' && value.purpose !== 'open') return null
  const listing = embeddedViewListingSchema.safeParse(value.listing)
  if (!listing.success || listing.data.envelope.subject.workspaceId !== workspaceId) return null
  return { type: 'world:display-relay', request: value.request, purpose: value.purpose, listing: listing.data }
}

export const parseDisplayRelayTaken = (value: unknown): DisplayRelayTaken | null => {
  if (!isRecord(value) || value.type !== 'world:display-relay-taken' || !hasKeys(value, ['type', 'request'])) return null
  return typeof value.request === 'string' && REQUEST_ID.test(value.request) ? { type: 'world:display-relay-taken', request: value.request } : null
}

export interface RelayChannel {
  readonly post: (message: DisplayRelayRequest | DisplayRelayTaken) => void
  readonly listen: (receive: (data: unknown) => void) => () => void
}

export type ScheduleTimer = (run: () => void, delayMs: number) => () => void

/** The pop-out's end: asks for a display to be shown in a display window; true once a World page on its Run took it. */
export const createDisplayRelay = (ports: {
  readonly channel: RelayChannel
  readonly newRequestId: () => string
  readonly schedule: ScheduleTimer
}) => (purpose: DisplayRelayRequest['purpose'], listing: EmbeddedViewListing): Promise<boolean> => new Promise(resolve => {
  const request = ports.newRequestId()
  let cancel = (): void => {}
  const stop = ports.channel.listen(data => {
    if (parseDisplayRelayTaken(data)?.request !== request) return
    stop()
    cancel()
    resolve(true)
  })
  cancel = ports.schedule(() => { stop(); resolve(false) }, RELAY_ANSWER_MS)
  ports.channel.post({ type: 'world:display-relay', request, purpose, listing })
})

/** A World page's end: shows in its display window the displays pop-outs send about its Run, and says so. */
export const answerDisplayRelay = (ports: {
  readonly channel: RelayChannel
  readonly workspaceId: string
  readonly runId: () => string | null
  readonly open: (listing: EmbeddedViewListing) => void
}): (() => void) => ports.channel.listen(data => {
  const message = parseDisplayRelayRequest(data, ports.workspaceId)
  if (message === null || message.listing.envelope.subject.id !== ports.runId()) return
  ports.open(message.listing)
  ports.channel.post({ type: 'world:display-relay-taken', request: message.request })
})

export const browserRelayChannel = (workspaceId: string): RelayChannel => {
  const channel = new BroadcastChannel(displayRelayChannelName(workspaceId))
  return {
    post: message => channel.postMessage(message),
    listen: receive => {
      const listener = (event: MessageEvent): void => receive(event.data)
      channel.addEventListener('message', listener)
      return () => channel.removeEventListener('message', listener)
    },
  }
}

const browserTimer: ScheduleTimer = (run, delayMs) => {
  const handle = setTimeout(run, delayMs)
  return () => clearTimeout(handle)
}

export const browserDisplayRelay = (workspaceId: string): ReturnType<typeof createDisplayRelay> => createDisplayRelay({
  channel: browserRelayChannel(workspaceId),
  newRequestId: () => crypto.randomUUID(),
  schedule: browserTimer,
})
