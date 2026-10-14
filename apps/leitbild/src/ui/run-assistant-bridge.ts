import {
  embeddedViewWindowReadyMessageSchema,
  runAssistantOfferMessageSchema,
  runAssistantOpenMessageSchema,
  type RunAssistantOfferMessage,
  type WorkspaceResourceReference,
} from '@leitbild/contracts'
import { firstIssue } from './view-relay.ts'

// The World page of the shown Run may offer that Run's Assistant room, as the
// Host's own launcher does, and ask the Host to show it. The Host tells the
// page whether it may once the page listens (it says so as its route mounts,
// with the display window's ready message) and again whenever that changes;
// it shows the room only for a request about the shown Run while the Run
// offers its Assistant, and reports every refusal where the operator sees it.
// What it posts is freshly parsed plain data, never UI state.

// The contract's Run Assistant messages share this prefix. Other messages from
// the World frame are not part of this protocol and are not judged here.
const RUN_ASSISTANT_MESSAGE_PREFIX = 'leitbild:run-assistant'

const messageType = (data: unknown): string | null => {
  if (typeof data !== 'object' || data === null) return null
  const type = (data as { readonly type?: unknown }).type
  return typeof type === 'string' ? type : null
}

export const createRunAssistantBridge = (config: {
  /** The Workspace this page shows; a Run of any other Workspace is refused. */
  readonly workspaceId: () => string
  /** The Run the World pane shows, or null without one. */
  readonly worldRunId: () => string | null
  /** Whether the shown Run offers its Assistant, as the Host's own launcher does. */
  readonly available: () => boolean
  readonly postToWorld: (message: RunAssistantOfferMessage) => void
  /** Shows the shown Run's Assistant room, creating it where none serves the Run; it never hides the room. */
  readonly openAssistant: () => Promise<void>
  /** Brings back an Assistant pane that the split collapsed. */
  readonly showAgents: () => void
  readonly reportError: (message: string) => void
}) => {
  // Whether the current World document said it listens.
  let worldListening = false
  // A request while an open is under way is answered by that open, so a
  // second click never creates a second room.
  let opening = false

  const offer = (): RunAssistantOfferMessage =>
    runAssistantOfferMessageSchema.parse({ type: 'leitbild:run-assistant-offer', available: config.available() })

  const refusal = (run: WorkspaceResourceReference): string | null => {
    if (run.workspaceId !== config.workspaceId()) return 'Assistant request refused: the Run belongs to another Workspace'
    if (run.type !== 'world.simulation-run' || run.id !== config.worldRunId()) return 'Assistant request refused: it names a Run other than the one shown'
    if (!config.available()) return 'Assistant could not be opened: this Run offers no Assistant'
    return null
  }

  const open = async (): Promise<void> => {
    opening = true
    try {
      await config.openAssistant()
      config.showAgents()
    } catch (error) {
      config.reportError(`Assistant could not be opened: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      opening = false
    }
  }

  const receiveOpen = (data: unknown): void => {
    const parsed = runAssistantOpenMessageSchema.safeParse(data)
    if (!parsed.success) return config.reportError(`Assistant request refused: ${firstIssue(parsed.error)}`)
    const problem = refusal(parsed.data.run)
    if (problem !== null) return config.reportError(problem)
    if (!opening) void open()
  }

  // The view relay reports a malformed ready message; its page is not taken to listen.
  const receiveReady = (data: unknown): void => {
    if (!embeddedViewWindowReadyMessageSchema.safeParse(data).success) return
    worldListening = true
    config.postToWorld(offer())
  }

  return {
    /** A message whose source is the World frame's window. */
    fromWorld: (data: unknown): void => {
      const type = messageType(data)
      if (type === 'leitbild:view-window-ready') return receiveReady(data)
      if (type === null || !type.startsWith(RUN_ASSISTANT_MESSAGE_PREFIX)) return
      if (type === 'leitbild:run-assistant-open') return receiveOpen(data)
      config.reportError(`Assistant message refused: the World page does not send ${type}`)
    },
    /** Whether the shown Run offers its Assistant may have changed: a listening World page learns it. */
    availabilityChanged: (): void => {
      if (worldListening) config.postToWorld(offer())
    },
    /** The World frame shows another Run or closed: its next document listens only once it says so. */
    worldFrameUnloaded: (): void => {
      worldListening = false
    },
  }
}

export type RunAssistantBridge = ReturnType<typeof createRunAssistantBridge>
