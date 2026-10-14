import {
  embeddedViewOpenMessageSchema,
  embeddedViewsMessageSchema,
  type EmbeddedViewListing,
  type EmbeddedViewWindowMaximiseMessage,
  type EmbeddedViewWindowReadyMessage,
} from '@leitbild/contracts'

// What the Host relays to the World page that shows the process display
// window: the conversation's current list of displays and requests to open
// one. Only the Host (this page's parent, same origin) may send them, each is
// validated with the contract schema, and every listed view must be a World
// process display about a Run of this page's Workspace.

// The run page reads these messages before any Pack code loads, so the view
// type is named here rather than imported with the Pack's display schemas
// (a test keeps it equal to the Pack's own constant).
export const PROCESS_DISPLAY_VIEW_TYPE = 'process-plant.display'

export type DisplayWindowHostMessage =
  | { readonly kind: 'views'; readonly views: ReadonlyArray<EmbeddedViewListing> }
  | { readonly kind: 'open'; readonly view: EmbeddedViewListing }
  /** A message of ours that must not be used; the reason is shown, never swallowed. */
  | { readonly kind: 'rejected'; readonly reason: string }

interface MessageLike {
  readonly origin: string
  readonly source: unknown
  readonly data: unknown
}

interface ExpectedSender {
  readonly origin: string
  readonly parent: unknown
  readonly workspaceId: string
}

const listingProblem = (listing: EmbeddedViewListing, workspaceId: string): string | null => {
  const { envelope } = listing
  if (envelope.subject.workspaceId !== workspaceId) return `display ${listing.key} belongs to another Workspace`
  if (envelope.moduleId !== 'world') return `display ${listing.key} is not a World view`
  if (envelope.viewType !== PROCESS_DISPLAY_VIEW_TYPE) return `display ${listing.key} is a ${envelope.viewType}, not a process display`
  if (envelope.subject.type !== 'world.simulation-run') return `display ${listing.key} is not about a Simulation Run`
  return null
}

export const issueText = (issues: ReadonlyArray<{ readonly path: ReadonlyArray<PropertyKey>; readonly message: string }>): string => {
  const issue = issues[0]
  if (!issue) return 'invalid message'
  return issue.path.length === 0 ? issue.message : `${issue.path.map(String).join('.')}: ${issue.message}`
}

/** Null for messages that are not the Host's display messages; they belong to someone else. */
export const readDisplayWindowHostMessage = (event: MessageLike, expected: ExpectedSender): DisplayWindowHostMessage | null => {
  if (event.origin !== expected.origin || event.source !== expected.parent) return null
  const data = event.data
  if (typeof data !== 'object' || data === null) return null
  const type = (data as { readonly type?: unknown }).type
  if (type === 'leitbild:views') {
    const parsed = embeddedViewsMessageSchema.safeParse(data)
    if (!parsed.success) return { kind: 'rejected', reason: `display list is invalid: ${issueText(parsed.error.issues)}` }
    const problem = parsed.data.views.map(view => listingProblem(view, expected.workspaceId)).find(found => found !== null)
    return problem ? { kind: 'rejected', reason: `display list refused: ${problem}` } : { kind: 'views', views: parsed.data.views }
  }
  if (type === 'leitbild:view-open') {
    const parsed = embeddedViewOpenMessageSchema.safeParse(data)
    if (!parsed.success) return { kind: 'rejected', reason: `display request is invalid: ${issueText(parsed.error.issues)}` }
    const problem = listingProblem(parsed.data.view, expected.workspaceId)
    return problem ? { kind: 'rejected', reason: `display request refused: ${problem}` } : { kind: 'open', view: parsed.data.view }
  }
  return null
}

export const displayWindowReadyMessage = (): EmbeddedViewWindowReadyMessage => ({ type: 'leitbild:view-window-ready' })

export const displayWindowMaximiseMessage = (maximised: boolean): EmbeddedViewWindowMaximiseMessage => ({
  type: 'leitbild:view-window-maximise',
  maximised,
})
