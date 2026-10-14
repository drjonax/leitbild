import {
  runAssistantOfferMessageSchema,
  runAssistantOpenMessageSchema,
  type RunAssistantOpenMessage,
} from '@leitbild/contracts'
import { issueText } from './process-display/display-window-messages.ts'

// The Run's Assistant room is the Host's: it decides whether this Run offers
// one and which room serves it. The run page offers it only once the Host
// (this page's parent, same origin) says it may, and asks the Host to show it;
// it never opens or creates a room itself. The Host says so after the page's
// display window ready message and again on every change.

export type RunAssistantOffer =
  | { readonly kind: 'offer'; readonly available: boolean }
  /** An offer of ours that must not be used; the reason is shown, never swallowed. */
  | { readonly kind: 'rejected'; readonly reason: string }

interface MessageLike {
  readonly origin: string
  readonly source: unknown
  readonly data: unknown
}

interface ExpectedSender {
  readonly origin: string
  readonly parent: unknown
}

/** The Host window this page asks, and the origin it must have. */
export interface RunAssistantHost {
  readonly parent: { postMessage(message: unknown, targetOrigin: string): void }
  readonly origin: string
}

/** Null for messages that are not the Host's Run Assistant offer; they belong to someone else. */
export const readRunAssistantOffer = (event: MessageLike, expected: ExpectedSender): RunAssistantOffer | null => {
  if (event.origin !== expected.origin || event.source !== expected.parent) return null
  const data = event.data
  if (typeof data !== 'object' || data === null) return null
  if ((data as { readonly type?: unknown }).type !== 'leitbild:run-assistant-offer') return null
  const parsed = runAssistantOfferMessageSchema.safeParse(data)
  if (!parsed.success) return { kind: 'rejected', reason: `Assistant offer is invalid: ${issueText(parsed.error.issues)}` }
  return { kind: 'offer', available: parsed.data.available }
}

/** The request for this page's Run, checked with the contract schema. */
export const runAssistantOpenMessage = (run: { readonly workspaceId: string; readonly simulationRunId: string }): RunAssistantOpenMessage =>
  runAssistantOpenMessageSchema.parse({
    type: 'leitbild:run-assistant-open',
    run: { workspaceId: run.workspaceId, moduleId: 'world', type: 'world.simulation-run', id: run.simulationRunId },
  })

/** Asks the Host to show the Assistant room for this page's Run beside it. */
export const requestRunAssistant = (
  run: { readonly workspaceId: string; readonly simulationRunId: string },
  host: RunAssistantHost,
): void => host.parent.postMessage(runAssistantOpenMessage(run), host.origin)
