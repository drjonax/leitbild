// The Agents people Capabilities as the Host UI sees them (CONTRACT "Capabilities").
// Every wire shape the people client sends or reads is in this one file, so a
// later adjustment of the Agents contract is a one-file change here.
//
// Results are validated strictly on arrival, as Agents publishes them: a
// missing, mistyped or unknown field is a contract error and is shown as one.
// The Host and Agents deploy together, so there is no tolerance for other shapes.

import { moduleCapabilityInvocationResultSchema, platformErrorSchema } from '@leitbild/contracts'
import { z } from 'zod'

export const PEOPLE_CAPABILITY = {
  join: 'agents.people.join',
  sync: 'agents.people.sync',
  rename: 'agents.people.rename',
  conversationRead: 'agents.people.conversation.read',
  markRead: 'agents.people.conversation.mark-read',
  send: 'agents.people.message.send',
  leave: 'agents.people.leave',
} as const

/** The Capability whose presence in the catalog turns the header control on. */
export const PEOPLE_SYNC_CAPABILITY_ID = PEOPLE_CAPABILITY.sync

/** The longest hold `agents.people.sync` accepts (`waitMs` 0..20000). */
export const SYNC_WAIT_MAX_MS = 20_000

export const personSchema = z.object({ id: z.string().min(1), name: z.string().min(1) }).strict()
export type PersonWire = z.infer<typeof personSchema>

export const messageSchema = z.object({
  seq: z.number().int().positive(),
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  text: z.string().min(1),
  sentAt: z.string().min(1),
}).strict()
export type MessageWire = z.infer<typeof messageSchema>

export const conversationSummarySchema = z.object({
  with: personSchema,
  here: z.boolean(),
  lastSeq: z.number().int().positive(),
  lastSentAt: z.string().min(1),
  unread: z.number().int().nonnegative(),
}).strict()
export type ConversationSummaryWire = z.infer<typeof conversationSummarySchema>

export const syncResultSchema = z.object({
  storeId: z.string().min(1),
  serverNow: z.string().min(1),
  presenceWarming: z.boolean(),
  me: personSchema,
  present: z.array(personSchema),
  conversations: z.array(conversationSummarySchema),
  messages: z.array(messageSchema),
  cursor: z.number().int().nonnegative(),
  more: z.boolean(),
  view: z.string().min(1),
}).strict()
export type SyncResultWire = z.infer<typeof syncResultSchema>

export const joinResultSchema = z.object({ token: z.string().min(1), me: personSchema, preferredNameAccepted: z.boolean() }).strict()
export type JoinResultWire = z.infer<typeof joinResultSchema>

export const renameResultSchema = z.object({ me: personSchema }).strict()
export type RenameResultWire = z.infer<typeof renameResultSchema>

export const conversationReadResultSchema = z.object({
  with: personSchema,
  messages: z.array(messageSchema),
  readThrough: z.object({ me: z.number().int().nonnegative(), them: z.number().int().nonnegative() }).strict(),
}).strict()
export type ConversationReadWire = z.infer<typeof conversationReadResultSchema>

export const markReadResultSchema = z.object({ unread: z.number().int().nonnegative() }).strict()
export type MarkReadResultWire = z.infer<typeof markReadResultSchema>

export const sendResultSchema = z.object({ message: messageSchema, replayed: z.boolean() }).strict()
export type SendResultWire = z.infer<typeof sendResultSchema>

export const leaveResultSchema = z.object({ left: z.literal(true) }).strict()

/** The Run being viewed, passed through opaquely (Agents never interprets World types). */
export interface ViewingReference {
  readonly workspaceId: string
  readonly moduleId: string
  readonly type: string
  readonly id: string
}

export interface SyncInput {
  readonly token: string
  readonly screen: string
  readonly viewing: ViewingReference
  readonly after?: number
  readonly view?: string
  readonly storeId?: string
  readonly waitMs: number
}

/** The error codes the people client branches on (CONTRACT "Capabilities" and the Host's module errors). */
export const PEOPLE_ERROR = {
  tokenInvalid: 'person_token_invalid',
  nameInvalid: 'person_name_invalid',
  nameTaken: 'person_name_taken',
  rateLimited: 'people_rate_limited',
  limitReached: 'people_limit_reached',
  humanRequired: 'people_human_required',
  personNotFound: 'person_not_found',
  messageEmpty: 'message_empty',
  messageTooLong: 'message_too_long',
  /** A NUL or another forbidden control character. */
  messageInvalidCharacters: 'message_invalid_characters',
  messageToSelf: 'message_to_self',
  idempotencyConflict: 'idempotency_conflict',
  workspaceClosing: 'workspace_closing',
  /** Agents' people store failed; retryable. */
  peopleUnavailable: 'people_unavailable',
  conversationWithSelf: 'conversation_with_self',
  moduleUnavailable: 'module_unavailable',
  moduleOutcomeUnknown: 'module_outcome_unknown',
  moduleNotReady: 'module_not_ready',
} as const

/** `details.reason` of `person_name_invalid`. */
export type NameInvalidReason = 'empty' | 'too_long' | 'invalid_characters'

/** The Host's invoke path for one Capability of one Workspace. */
export const invokePath = (workspaceId: string, capabilityId: string): string =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/capabilities/${encodeURIComponent(capabilityId)}/invoke`

/** The Host's invoke body. People are always invoked as a human; the token travels only in `input`. */
export const invokeBody = (input: unknown, idempotencyKey?: string): string => JSON.stringify({
  input,
  actor: { kind: 'human' },
  ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
})

/** The Host wraps a Capability's result as `{ result }` (the platform's own schema). */
export const invocationEnvelopeSchema = moduleCapabilityInvocationResultSchema

/** The Host's error body, `{ error: { code, message, requestId?, retryable?, details? } }` (the platform's own schema). */
export const errorEnvelopeSchema = platformErrorSchema
