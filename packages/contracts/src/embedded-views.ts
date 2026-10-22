import { z } from 'zod'
import { moduleIdSchema } from './ids.ts'
import { workspaceResourceReferenceSchema } from './resources.ts'
import {
  EMBEDDED_VIEW_FRAGMENT_KEY,
  EMBEDDED_VIEW_LISTING_MAX,
  EMBEDDED_VIEW_MAX_HEIGHT,
  EMBEDDED_VIEW_MIN_HEIGHT,
  EMBEDDED_VIEW_STATE_MAX_LENGTH,
} from './embedded-view-route.ts'

// A view that its owning Module publishes for another Module to show, e.g. a
// World display an Agents answer composed. The owning Module defines,
// validates and renders `state`; an embedder only reserves space, builds the
// route from these fields and treats `state` as opaque.
export const embeddedViewTypeSchema = z.string()
  .min(3)
  .max(128)
  .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/)
  .brand<'EmbeddedViewType'>()
export type EmbeddedViewType = z.infer<typeof embeddedViewTypeSchema>

// What a Module operation returns when its result can be shown as a view. The
// caller completes the envelope with the exact Resource it invoked, so the
// publishing runtime need not know its own Workspace identity.
const embeddedViewPublicationShape = {
  viewType: embeddedViewTypeSchema,
  title: z.string().min(1).max(120),
  height: z.number().int().min(EMBEDDED_VIEW_MIN_HEIGHT).max(EMBEDDED_VIEW_MAX_HEIGHT),
  state: z.string().min(2).max(EMBEDDED_VIEW_STATE_MAX_LENGTH),
}
export const embeddedViewPublicationSchema = z.object(embeddedViewPublicationShape).strict()
export type EmbeddedViewPublication = z.infer<typeof embeddedViewPublicationSchema>

export const embeddedViewEnvelopeSchema = z.object({
  moduleId: moduleIdSchema,
  subject: workspaceResourceReferenceSchema,
  ...embeddedViewPublicationShape,
}).strict().superRefine((envelope, ctx) => {
  if (envelope.subject.moduleId !== envelope.moduleId) {
    ctx.addIssue({ code: 'custom', path: ['subject', 'moduleId'], message: 'An embedded view subject must belong to the publishing Module' })
  }
})
export type EmbeddedViewEnvelope = z.infer<typeof embeddedViewEnvelopeSchema>

// Same-origin browser messages for the one window that shows a Workspace's
// embedded views. A Module UI lists the views it holds (Agents: the displays
// its answers composed) and asks for one to be opened; the Host validates each
// message, keeps nothing beyond the latest list, and relays it to the Module
// whose page shows the window (World). A listing is self-contained: opening a
// view never depends on an earlier list.
export const embeddedViewListingSchema = z.object({
  // Stable for one view across re-renders and reloads, unique within one list.
  key: z.string().min(1).max(512),
  envelope: embeddedViewEnvelopeSchema,
  // Where the view comes from, as the window's caption says it, e.g. "Answer 14:02:31".
  caption: z.string().min(1).max(120),
}).strict()
export type EmbeddedViewListing = z.infer<typeof embeddedViewListingSchema>

/** The full current list of one publisher, oldest first; it replaces the previous one. */
export const embeddedViewsMessageSchema = z.object({
  type: z.literal('leitbild:views'),
  views: z.array(embeddedViewListingSchema).max(EMBEDDED_VIEW_LISTING_MAX),
}).strict().superRefine((message, ctx) => {
  const keys = new Set<string>()
  message.views.forEach((view, index) => {
    if (keys.has(view.key)) ctx.addIssue({ code: 'custom', path: ['views', index, 'key'], message: 'Listed view keys must be unique' })
    keys.add(view.key)
  })
})
export type EmbeddedViewsMessage = z.infer<typeof embeddedViewsMessageSchema>

/** Asks for the window to show this view, opening the window when it is closed. */
export const embeddedViewOpenMessageSchema = z.object({
  type: z.literal('leitbild:view-open'),
  view: embeddedViewListingSchema,
}).strict()
export type EmbeddedViewOpenMessage = z.infer<typeof embeddedViewOpenMessageSchema>

/** Host -> Module UI on frame load: views listed or opened from this frame reach a window. */
export const embeddedViewHostMessageSchema = z.object({
  type: z.literal('leitbild:view-host'),
}).strict()
export type EmbeddedViewHostMessage = z.infer<typeof embeddedViewHostMessageSchema>

/** Module UI showing the window -> Host once it listens; the Host then sends the latest list and any pending open. */
export const embeddedViewWindowReadyMessageSchema = z.object({
  type: z.literal('leitbild:view-window-ready'),
}).strict()
export type EmbeddedViewWindowReadyMessage = z.infer<typeof embeddedViewWindowReadyMessageSchema>

/** Module UI showing the window -> Host: give the window's pane the whole Workspace area, or restore the split. */
export const embeddedViewWindowMaximiseMessageSchema = z.object({
  type: z.literal('leitbild:view-window-maximise'),
  maximised: z.boolean(),
}).strict()
export type EmbeddedViewWindowMaximiseMessage = z.infer<typeof embeddedViewWindowMaximiseMessageSchema>

export const parseEmbeddedViewFragment = (hash: string): EmbeddedViewEnvelope => {
  const body = hash.startsWith('#') ? hash.slice(1) : hash
  if (!body.startsWith(EMBEDDED_VIEW_FRAGMENT_KEY)) throw new Error('Embedded view fragment must start with view=')
  return embeddedViewEnvelopeSchema.parse(JSON.parse(decodeURIComponent(body.slice(EMBEDDED_VIEW_FRAGMENT_KEY.length))))
}

export {
  embeddedViewFragment,
  embeddedViewPath,
  EMBEDDED_VIEW_LISTING_MAX,
  EMBEDDED_VIEW_MAX_HEIGHT,
  EMBEDDED_VIEW_MIN_HEIGHT,
  EMBEDDED_VIEW_STATE_MAX_LENGTH,
} from './embedded-view-route.ts'
