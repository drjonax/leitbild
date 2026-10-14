import { z } from 'zod'
import { workspaceResourceReferenceSchema } from './resources.ts'

// Same-origin browser messages between the Host and the World page of the Run
// it shows, so that page may offer the Run's Assistant room beside it. The
// Host alone decides whether the Run has an Assistant and which room serves
// it; the World page only offers it once told so and asks for it. The types
// stay outside the embedded view window's `leitbild:view` prefix, whose relay
// refuses every member it does not know.

/** Host -> World page once it listens, and on every change: whether it may offer the Run's Assistant. */
export const runAssistantOfferMessageSchema = z.object({
  type: z.literal('leitbild:run-assistant-offer'),
  available: z.boolean(),
}).strict()
export type RunAssistantOfferMessage = z.infer<typeof runAssistantOfferMessageSchema>

/** World page -> Host: show the Assistant room for this Run beside it, as the Host's own launcher does. */
export const runAssistantOpenMessageSchema = z.object({
  type: z.literal('leitbild:run-assistant-open'),
  run: workspaceResourceReferenceSchema,
}).strict()
export type RunAssistantOpenMessage = z.infer<typeof runAssistantOpenMessageSchema>
