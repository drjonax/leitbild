// ============================================================================
// People Capabilities — the humans in a Workspace, their presence on a Run and
// direct chat between them, published as ordinary Agents Capabilities that the
// Host UI invokes through the Host's capability endpoint.
//
// Dispatched before the Agents runtime lease: these never load Rooms or AI
// Agents and a waiting sync holds no operation lease. Only human actors are
// served; the AI Agents' capability discovery excludes the whole prefix.
// The identity token travels only in the request body and is never echoed,
// logged or returned to anyone but the Person who joined.
// ============================================================================

import { z } from 'zod'
import {
  isoTimestampSchema,
  moduleCapabilityInvocationSchema,
  moduleIdSchema,
  workspaceResourceReferenceSchema,
  type ModuleCapabilityDescriptor,
  type WorkspaceId,
} from '@leitbild/contracts'
import { createModuleCapabilityRegistry } from '@leitbild/module-runtime'
import {
  CONVERSATION_KEEP,
  MAX_SYNC_WAIT_MS,
  MESSAGE_MAX_CODE_POINTS,
  SYNC_ABORTED,
  SYNC_MESSAGE_PAGE,
  peopleError,
  peopleFailureOf,
  type PeopleDirectory,
} from '../core/people/people-directory.ts'
import { PERSON_NAME_INPUT_MAX_LENGTH } from '../core/people/people-names.ts'
import { PEOPLE_CAPABILITY_PREFIX } from '../core/people/people-capability-ids.ts'
import type { WorkspaceRuntimeRegistry } from '../core/workspaces/runtime-registry.ts'

const AGENTS_MODULE_ID = moduleIdSchema.parse('agents')

/** Transport bound on message text before normalisation (trailing whitespace may be trimmed). */
const MESSAGE_INPUT_MAX_LENGTH = 16 * 1024
/** Opaque strings the server hands out (view hash, store id); generous transport bound. */
const OPAQUE_MAX_LENGTH = 128
const CONTROL_CHARACTER = /\p{Cc}/u
/** A token is 43 base64url characters; anything longer cannot be one. */
const TOKEN_INPUT_MAX_LENGTH = 256

// --- Wire schemas ---

const tokenSchema = z.string().max(TOKEN_INPUT_MAX_LENGTH)
  .describe('The identity token agents.people.join returned to this browser. Never put it in a URL.')
const personIdSchema = z.string().regex(/^person-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
const screenSchema = z.uuid().describe('Random id of this page instance, kept in memory only.')

const personSchema = z.object({ id: personIdSchema, name: z.string().min(1) }).strict()
const messageSchema = z.object({
  seq: z.number().int().positive(),
  id: z.string().regex(/^msg-/),
  from: personIdSchema,
  to: personIdSchema,
  text: z.string().min(1),
  sentAt: isoTimestampSchema,
}).strict()

const joinInputSchema = z.object({
  preferredName: z.string().max(PERSON_NAME_INPUT_MAX_LENGTH).optional()
    .describe('Used when it is a valid name that nobody in this Workspace uses; otherwise the next free UserN.'),
}).strict()
const joinResultSchema = z.object({
  token: z.string().min(1),
  me: personSchema,
  preferredNameAccepted: z.boolean(),
}).strict()

const syncInputSchema = z.object({
  token: tokenSchema,
  screen: screenSchema,
  viewing: workspaceResourceReferenceSchema.describe('The Run this screen shows. Presence is per Run.'),
  after: z.number().int().nonnegative().optional().describe('The cursor of the previous result; absent on the first sync.'),
  view: z.string().min(1).max(OPAQUE_MAX_LENGTH).optional().describe('The view of the previous result.'),
  storeId: z.string().min(1).max(OPAQUE_MAX_LENGTH).optional().describe('The storeId of the previous result.'),
  waitMs: z.number().int().min(0).max(MAX_SYNC_WAIT_MS).describe('How long to wait for a change; 0 answers at once.'),
}).strict()
const syncResultSchema = z.object({
  storeId: z.string().min(1),
  serverNow: isoTimestampSchema,
  presenceWarming: z.boolean(),
  me: personSchema,
  present: z.array(personSchema),
  conversations: z.array(z.object({
    with: personSchema,
    here: z.boolean(),
    lastSeq: z.number().int().positive(),
    lastSentAt: isoTimestampSchema,
    unread: z.number().int().nonnegative(),
  }).strict()),
  messages: z.array(messageSchema).max(SYNC_MESSAGE_PAGE),
  cursor: z.number().int().nonnegative(),
  more: z.boolean(),
  view: z.string().min(1),
}).strict()

const renameInputSchema = z.object({ token: tokenSchema, name: z.string().max(PERSON_NAME_INPUT_MAX_LENGTH) }).strict()
const renameResultSchema = z.object({ me: personSchema }).strict()

const conversationReadInputSchema = z.object({ token: tokenSchema, with: personIdSchema }).strict()
const conversationReadResultSchema = z.object({
  with: personSchema,
  messages: z.array(messageSchema).max(CONVERSATION_KEEP),
  readThrough: z.object({ me: z.number().int().nonnegative(), them: z.number().int().nonnegative() }).strict(),
}).strict()

const markReadInputSchema = z.object({ token: tokenSchema, with: personIdSchema, through: z.number().int().nonnegative() }).strict()
const markReadResultSchema = z.object({ unread: z.number().int().nonnegative() }).strict()

const sendInputSchema = z.object({
  token: tokenSchema,
  to: personIdSchema,
  text: z.string().max(MESSAGE_INPUT_MAX_LENGTH).describe(`1 to ${MESSAGE_MAX_CODE_POINTS} characters after trailing whitespace is trimmed.`),
}).strict()
const sendResultSchema = z.object({ message: messageSchema, replayed: z.boolean() }).strict()

const leaveInputSchema = z.object({ token: tokenSchema, screen: screenSchema }).strict()
const leaveResultSchema = z.object({ left: z.literal(true) }).strict()

// --- Responses ---

const json = (body: unknown, status = 200): Response => Response.json(body, { status })
export const peopleApiError = (
  status: number,
  code: string,
  message: string,
  extra: { readonly retryable?: boolean; readonly details?: Readonly<Record<string, unknown>> } = {},
): Response => json({ error: {
  code,
  message,
  ...(extra.retryable === undefined ? {} : { retryable: extra.retryable }),
  ...(extra.details === undefined ? {} : { details: extra.details }),
} }, status)

const viewingKey = (viewing: z.infer<typeof workspaceResourceReferenceSchema>): string =>
  `${viewing.moduleId}|${viewing.type}|${viewing.id}`

interface PeopleContext {
  readonly directory: PeopleDirectory
  readonly signal: AbortSignal
}

const descriptor = (fields: {
  readonly name: string
  readonly kind: 'command' | 'query'
  readonly title: string
  readonly description: string
  readonly risk: 'read' | 'write'
  readonly idempotent: boolean
  readonly input: z.ZodType
  readonly output: z.ZodType
  readonly acceptsIdempotencyKey?: true
  readonly comparisonUnavailableReason?: string
}) => ({
  id: `${PEOPLE_CAPABILITY_PREFIX}${fields.name}`,
  moduleId: AGENTS_MODULE_ID,
  kind: fields.kind,
  scope: { kind: 'workspace' as const },
  title: fields.title,
  description: `${fields.description} For the people in a Workspace through its Host UI; only human actors are served.`,
  risk: fields.risk,
  idempotent: fields.idempotent,
  ...(fields.acceptsIdempotencyKey === undefined ? {} : { acceptsIdempotencyKey: fields.acceptsIdempotencyKey }),
  ...(fields.comparisonUnavailableReason === undefined ? {} : { comparisonUnavailableReason: fields.comparisonUnavailableReason }),
  inputSchema: z.toJSONSchema(fields.input, { io: 'input' }),
  outputSchema: z.toJSONSchema(fields.output),
})

export const peopleCapabilities = createModuleCapabilityRegistry<PeopleContext, Response>(AGENTS_MODULE_ID, [
  {
    descriptor: descriptor({
      name: 'join', kind: 'command', risk: 'write', idempotent: false,
      title: 'Join as a Person',
      description: 'Creates a Person in this Workspace and returns its identity token once, with a free default name or the preferred name.',
      input: joinInputSchema, output: joinResultSchema,
    }),
    invoke: async ({ directory }, invocation) =>
      json({ result: joinResultSchema.parse(await directory.join(joinInputSchema.parse(invocation.input))) }, 201),
  },
  {
    descriptor: descriptor({
      name: 'sync', kind: 'command', risk: 'write', idempotent: true,
      title: 'Sync People and messages',
      description: 'Marks this screen as viewing a Run and returns who else is here, every conversation with unread counts, and messages after the cursor. With waitMs it waits for a change.',
      input: syncInputSchema, output: syncResultSchema,
    }),
    invoke: async ({ directory, signal }, invocation) => {
      const input = syncInputSchema.parse(invocation.input)
      if (input.viewing.workspaceId !== invocation.workspaceId) {
        throw peopleError({ status: 409, code: 'workspace_scope_mismatch', message: 'The viewed Run belongs to another Workspace' })
      }
      const result = await directory.sync({
        token: input.token,
        screen: input.screen,
        viewingKey: viewingKey(input.viewing),
        waitMs: input.waitMs,
        ...(input.after === undefined ? {} : { after: input.after }),
        ...(input.view === undefined ? {} : { view: input.view }),
        ...(input.storeId === undefined ? {} : { storeId: input.storeId }),
      }, signal)
      // The caller went away; nobody reads this answer.
      if (result === SYNC_ABORTED) return peopleApiError(499, 'request_aborted', 'The caller aborted the sync')
      return json({ result: syncResultSchema.parse(result) })
    },
  },
  {
    descriptor: descriptor({
      name: 'rename', kind: 'command', risk: 'write', idempotent: true,
      title: 'Rename me',
      description: 'Changes this Person\'s name. Names are unique in the Workspace regardless of case.',
      input: renameInputSchema, output: renameResultSchema,
    }),
    invoke: async ({ directory }, invocation) =>
      json({ result: renameResultSchema.parse(directory.rename(renameInputSchema.parse(invocation.input))) }),
  },
  {
    descriptor: descriptor({
      name: 'conversation.read', kind: 'query', risk: 'read', idempotent: true,
      title: 'Read a conversation',
      description: `Reads the last ${CONVERSATION_KEEP} messages between this Person and another, oldest first, with both read markers.`,
      comparisonUnavailableReason: 'Direct messages between people are not Workspace evidence.',
      input: conversationReadInputSchema, output: conversationReadResultSchema,
    }),
    invoke: async ({ directory }, invocation) =>
      json({ result: conversationReadResultSchema.parse(directory.readConversation(conversationReadInputSchema.parse(invocation.input))) }),
  },
  {
    descriptor: descriptor({
      name: 'conversation.mark-read', kind: 'command', risk: 'write', idempotent: true,
      title: 'Mark a conversation read',
      description: 'Moves this Person\'s read marker in a conversation forward to the given sequence number and returns what remains unread.',
      input: markReadInputSchema, output: markReadResultSchema,
    }),
    invoke: async ({ directory }, invocation) =>
      json({ result: markReadResultSchema.parse(directory.markRead(markReadInputSchema.parse(invocation.input))) }),
  },
  {
    descriptor: descriptor({
      name: 'message.send', kind: 'command', risk: 'write', idempotent: false, acceptsIdempotencyKey: true,
      title: 'Send a direct message',
      description: 'Sends a text message to another Person in this Workspace, present or not. Requires an idempotencyKey; a retry with the same key returns the original message.',
      input: sendInputSchema, output: sendResultSchema,
    }),
    invoke: async ({ directory }, invocation) => {
      if (invocation.idempotencyKey === undefined) {
        throw peopleError({ status: 400, code: 'idempotency_key_required', message: 'Sending a message requires an idempotencyKey, reused unchanged on every retry' })
      }
      const sent = await directory.send(sendInputSchema.parse(invocation.input), invocation.idempotencyKey)
      return json({ result: sendResultSchema.parse(sent) }, sent.replayed ? 200 : 201)
    },
  },
  {
    descriptor: descriptor({
      name: 'leave', kind: 'command', risk: 'write', idempotent: true,
      title: 'Leave',
      description: 'Marks this screen as closed, so its Person stops being present unless another screen is open.',
      input: leaveInputSchema, output: leaveResultSchema,
    }),
    invoke: async ({ directory }, invocation) =>
      json({ result: leaveResultSchema.parse(directory.leave(leaveInputSchema.parse(invocation.input))) }),
  },
])

export const peopleCapabilityDescriptors: ReadonlyArray<ModuleCapabilityDescriptor> = peopleCapabilities.descriptors

/**
 * Invokes one People Capability. Validation, refusals and People failures
 * answer here; workspace_closing, Workspace-not-found and invalid input
 * propagate to the Module API's shared error mapping.
 */
export const invokePeopleCapability = async (
  capabilityId: string,
  workspaceId: WorkspaceId,
  raw: unknown,
  registry: WorkspaceRuntimeRegistry,
  signal: AbortSignal,
): Promise<Response> => {
  const metrics = registry.peopleMetrics
  const refuse = (status: number, code: string, message: string, extra: Parameters<typeof peopleApiError>[3] = {}): Response => {
    metrics.reject(code)
    return peopleApiError(status, code, message, extra)
  }
  const invocation = moduleCapabilityInvocationSchema.parse(raw)
  if (invocation.workspaceId !== workspaceId) return refuse(409, 'workspace_scope_mismatch', 'Invocation belongs to another Workspace')
  if (invocation.capabilityId !== capabilityId) return refuse(409, 'capability_scope_mismatch', 'Invocation Capability does not match the route')
  const capability = peopleCapabilityDescriptors.find(candidate => candidate.id === capabilityId)
  if (!capability) return refuse(404, 'capability_not_found', 'Capability not found')
  if (invocation.access.actor.kind !== 'human') {
    return refuse(403, 'people_human_required', 'People and direct messages are for human actors only')
  }
  if (invocation.resource !== undefined || invocation.definition !== undefined) {
    return refuse(409, 'capability_scope_invalid', 'People Capabilities take no Resource or Definition')
  }
  if (invocation.idempotencyKey !== undefined && capability.acceptsIdempotencyKey !== true) {
    return refuse(400, 'idempotency_not_supported', 'This Capability does not support keyed retries')
  }
  // The store keeps the key as text; SQLite's length() stops at NUL, and no
  // client-generated key needs a control character.
  if (invocation.idempotencyKey !== undefined && CONTROL_CHARACTER.test(invocation.idempotencyKey)) {
    return refuse(400, 'invalid_request', 'An idempotencyKey cannot contain control characters')
  }
  try {
    const directory = await registry.peopleFor(workspaceId)
    const response = await peopleCapabilities.invoke(capabilityId, { directory, signal }, invocation)
    if (!response) throw new Error(`People Capability has no handler: ${capabilityId}`)
    return response
  } catch (error) {
    const failure = peopleFailureOf(error)
    if (failure) {
      return refuse(failure.status, failure.code, failure.message, {
        ...(failure.retryable === undefined ? {} : { retryable: failure.retryable }),
        ...(failure.details === undefined ? {} : { details: failure.details }),
      })
    }
    if (error instanceof z.ZodError) { metrics.reject('invalid_request'); throw error }
    if (error instanceof Error && 'code' in error && error.code === 'workspace_closing') { metrics.reject('workspace_closing'); throw error }
    if (error instanceof Error && error.message.includes('Workspace not found:')) { metrics.reject('workspace_not_found'); throw error }
    if (error instanceof Error && 'code' in error && error.code === 'storage_budget_exceeded') { metrics.reject('storage_budget_exceeded'); throw error }
    metrics.inc('storeFailures')
    console.error(`[people] ${capabilityId} failed in Workspace ${workspaceId}: ${error instanceof Error ? error.message : String(error)}`)
    return peopleApiError(500, 'people_unavailable', 'People are temporarily unavailable', { retryable: true })
  }
}
