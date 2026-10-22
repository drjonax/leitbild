import {
  embeddedViewOpenMessageSchema,
  embeddedViewsMessageSchema,
  type EmbeddedViewEnvelope,
  type EmbeddedViewListing,
  type EmbeddedViewWindowMaximiseMessage,
  type EmbeddedViewWindowReadyMessage,
} from '@leitbild/contracts'

// What the Host relays to the World page that shows the process display
// window: the conversation's current list of displays and requests to open
// one. Only the Host (this page's parent, same origin) may send them, and each
// is validated with the contract schema. Listings are judged one by one: a
// listing about another Workspace is refused on its own, and a view this
// window cannot show (another view type) is listed with the reason in place of
// a frame. One such listing never refuses the rest of the list.

/** World's vignettes, any object of any Pack (ui/embed/vignette): what the window shows. */
export const VIGNETTE_VIEW_TYPE = 'display.vignette'

/** A listing the window leaves out, and why. */
export interface RefusedListing {
  readonly key: string
  readonly reason: string
}

export type DisplayWindowHostMessage =
  | { readonly kind: 'views'; readonly views: ReadonlyArray<EmbeddedViewListing>; readonly refused: ReadonlyArray<RefusedListing> }
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

/**
 * Why this window cannot show a view, or null where it can: a plain switch on
 * the view type. It shows World's vignettes about a Simulation Run.
 */
export const listingRefusal = (envelope: EmbeddedViewEnvelope): string | null => {
  switch (envelope.viewType) {
    case VIGNETTE_VIEW_TYPE:
      if (envelope.moduleId !== 'world') return `it is a ${envelope.viewType} view published by ${envelope.moduleId}, not by World`
      if (envelope.subject.type !== 'world.simulation-run') return `it is about a ${envelope.subject.type}, not a Simulation Run`
      return null
    default:
      return `it is a ${envelope.viewType} view, which this window does not show`
  }
}

const foreignWorkspace = (listing: EmbeddedViewListing, workspaceId: string): string | null =>
  listing.envelope.subject.workspaceId === workspaceId ? null : `display ${listing.key} belongs to another Workspace`

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
    const views: EmbeddedViewListing[] = []
    const refused: RefusedListing[] = []
    for (const view of parsed.data.views) {
      const problem = foreignWorkspace(view, expected.workspaceId)
      if (problem === null) views.push(view)
      else refused.push({ key: view.key, reason: problem })
    }
    return { kind: 'views', views, refused }
  }
  if (type === 'leitbild:view-open') {
    const parsed = embeddedViewOpenMessageSchema.safeParse(data)
    if (!parsed.success) return { kind: 'rejected', reason: `display request is invalid: ${issueText(parsed.error.issues)}` }
    const problem = foreignWorkspace(parsed.data.view, expected.workspaceId)
    return problem ? { kind: 'rejected', reason: `display request refused: ${problem}` } : { kind: 'open', view: parsed.data.view }
  }
  return null
}

export const displayWindowReadyMessage = (): EmbeddedViewWindowReadyMessage => ({ type: 'leitbild:view-window-ready' })

export const displayWindowMaximiseMessage = (maximised: boolean): EmbeddedViewWindowMaximiseMessage => ({
  type: 'leitbild:view-window-maximise',
  maximised,
})
