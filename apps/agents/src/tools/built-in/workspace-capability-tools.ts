import { z } from 'zod'
import { viewRefFor } from '../../core/render-validators/view-fence.ts'
import { embeddedViewFor } from '../../core/render-validators/view-envelope.ts'
import {
  capabilityIdSchema,
  definitionTypeSchema,
  moduleIdSchema,
  resourceTypeSchema,
  publishedContextSchema,
  workspaceCapabilityCatalogSchema,
  workspaceDefinitionCatalogSchema,
  workspaceDefinitionRevisionReferenceSchema,
  workspaceResourceCatalogSchema,
  workspaceResourceReferenceSchema,
  type CapabilityId,
  type ModuleCapabilityDescriptor,
  type ModuleDefinitionDescriptor,
  type ModuleResourceDescriptor,
  type EmbeddedViewPublication,
  type PublishedContext,
  type WorkspaceDefinitionRevisionReference,
  type WorkspaceId,
  type WorkspaceResourceReference,
  type WorkspaceRoomScope,
} from '@leitbild/contracts'
import type { Tool, ToolContext, ToolResult } from '../../core/types/tool.ts'
import { isPeopleCapabilityId } from '../../core/people/people-capability-ids.ts'
import { cardLines, entryCard, type TurnCards } from '../../agents/answer-cards.ts'

export interface WorkspaceCapabilityToolsDeps {
  readonly workspaceId: WorkspaceId
  readonly hostBaseUrl: string
  readonly getRoomScope: (roomId: string) => WorkspaceRoomScope | undefined
  readonly fetchImpl?: typeof fetch
}

export const WORKSPACE_CAPABILITY_TOOL_NAMES = ['workspace_explore', 'workspace_call'] as const

// Transport and context safeguards, not a behavioral quota. Agents decide how
// much evidence a task needs; Pack-owned operations own domain pagination.
const HOST_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_PAGE_SIZE = 30
// A page carrying schemas holds about 2 KB per operation (World's operations
// with input schemas: 0.8-5.6 KB), re-sent on every later model call of the
// turn: by default it holds what a focused search needs, and always every
// exact ID asked for.
const DEFAULT_SCHEMA_PAGE_SIZE = 5
const MAX_PAGE_SIZE = 100
const MAX_READ_BATCH_SIZE = 12
// One chat line: room for a procedure step's decision with its deciding
// values, as long as the basis World records for a transition.
const MAX_SAY_LENGTH = 300

const failure = (code: string, message: string, details?: Record<string, unknown>): ToolResult => ({
  success: false,
  error: `${code}: ${message}`,
  data: { code, ...(details === undefined ? {} : { details }) },
})

const origin = (raw: string): string => {
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Workspace Host URL must use http or https')
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('Workspace Host URL must be an origin')
  return url.origin
}

const requestSignal = (signal?: AbortSignal): AbortSignal =>
  AbortSignal.any([AbortSignal.timeout(HOST_REQUEST_TIMEOUT_MS), ...(signal ? [signal] : [])])

const getJson = async (fetchImpl: typeof fetch, url: string, signal?: AbortSignal, etag?: string): Promise<Response> => {
  try {
    return await fetchImpl(url, { signal: requestSignal(signal), headers: { Accept: 'application/json', ...(etag ? {'If-None-Match':etag} : {}) } })
  } catch (error) {
    throw new Error(`Workspace Host is unreachable: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

const readHostError = async (response: Response): Promise<ToolResult> => {
  const body = await response.json().catch(() => undefined) as { error?: { code?: unknown; message?: unknown; retryable?: unknown; details?: unknown } } | undefined
  const code = typeof body?.error?.code === 'string' ? body.error.code : 'workspace_host_request_failed'
  const message = typeof body?.error?.message === 'string' ? body.error.message : `Workspace Host returned HTTP ${response.status}`
  return failure(code, message, {
    status: response.status,
    retryable: body?.error?.retryable === true,
    ...(body?.error?.details && typeof body.error.details === 'object' ? { hostDetails: body.error.details as Record<string, unknown> } : {}),
  })
}

// A Module refuses input that does not match an operation's schema with
// invalid_request (World: the schema's issues). The refusal then carries that
// schema from the catalog this call already read, so the next call can be
// corrected without a schema search. The bound keeps a refusal small: it holds
// 72 of World's 75 schemas (display.compose's is 2.9 KB); scenario authoring
// schemas (15 KB) are named for an explicit read instead.
const MAX_REFUSAL_SCHEMA_BYTES = 4096

/** An operation's schema as the model reads it: every constraint, without the dialect URI each one repeats. */
const schemaForModel = (schema: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
  const { $schema: _dialect, ...constraints } = schema
  return constraints
}

const refusedInputSchema = (refusal: ToolResult, operation: ModuleCapabilityDescriptor): Record<string, unknown> => {
  if ((refusal.data as { code?: unknown }).code !== 'invalid_request') return {}
  const inputSchema = schemaForModel(operation.inputSchema)
  const bytes = new TextEncoder().encode(JSON.stringify(inputSchema)).byteLength
  return bytes <= MAX_REFUSAL_SCHEMA_BYTES
    ? { inputSchema }
    : { inputSchemaOmitted: `${bytes} bytes; read it with workspace_explore view=operations, operationIds ["${operation.id}"], includeInputSchema true` }
}

const optionalFilter = (value: unknown): unknown =>
  typeof value === 'string' && (value.trim().length === 0 || value.trim() === '*') ? undefined : value

const referenceKey = (ref: { workspaceId?: string; moduleId: string; type: string; id: string }): string =>
  `${ref.workspaceId ?? ''}:${ref.moduleId}:${ref.type}:${ref.id}`

type WorkspaceTarget =
  | { readonly kind: 'resource'; readonly ref: WorkspaceResourceReference }
  | { readonly kind: 'definition'; readonly ref: WorkspaceDefinitionRevisionReference }

const parseTarget = (value: unknown, workspaceId: WorkspaceId): WorkspaceTarget | undefined => {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('target must be one exact target returned by workspace_explore')
  const raw = value as Record<string, unknown>
  if (raw.kind !== 'resource' && raw.kind !== 'definition') throw new Error('target.kind must be resource or definition')
  if (Object.keys(raw).some(key => !['kind', 'ref'].includes(key))) throw new Error('target must be one exact target returned by workspace_explore')
  const parsed = raw.kind === 'resource'
    ? workspaceResourceReferenceSchema.parse(raw.ref)
    : workspaceDefinitionRevisionReferenceSchema.parse(raw.ref)
  if (parsed.workspaceId !== workspaceId) throw new Error('target belongs to another Workspace')
  return raw.kind === 'resource'
    ? { kind: 'resource', ref: parsed as WorkspaceResourceReference }
    : { kind: 'definition', ref: parsed as WorkspaceDefinitionRevisionReference }
}

const selectedCollectionMembers = (
  scope: Extract<WorkspaceRoomScope, { kind: 'collection' }>,
  resources: ReadonlyArray<ModuleResourceDescriptor>,
): ReadonlyArray<WorkspaceResourceReference> => {
  const collectionKey = referenceKey(scope.collection)
  const collection = resources.find(resource => referenceKey(resource.ref) === collectionKey)
  const members = new Map<string, WorkspaceResourceReference>()
  for (const link of collection?.links ?? []) if (link.rel === 'contains') members.set(referenceKey(link.ref), link.ref)
  for (const resource of resources) {
    if (resource.links.some(link => link.rel === 'member-of' && referenceKey(link.ref) === collectionKey)) {
      members.set(referenceKey(resource.ref), resource.ref)
    }
  }
  if (scope.members.mode === 'selected') {
    const selected = new Set(scope.members.only.map(referenceKey))
    return [...members.values()].filter(member => selected.has(referenceKey(member)))
  }
  const excluded = new Set(scope.members.except.map(referenceKey))
  return [...members.values()].filter(member => !excluded.has(referenceKey(member)))
}

interface ResolvedScope {
  readonly scope: WorkspaceRoomScope
  readonly resources: ReadonlyArray<ModuleResourceDescriptor>
  readonly definitions: ReadonlyArray<ModuleDefinitionDescriptor>
  readonly resourceKeys: ReadonlySet<string>
  readonly definitionKeys: ReadonlySet<string>
}

export const resolveScope = (
  scope: WorkspaceRoomScope,
  resources: ReadonlyArray<ModuleResourceDescriptor>,
  definitions: ReadonlyArray<ModuleDefinitionDescriptor>,
): ResolvedScope => {
  if (scope.kind === 'workspace') {
    return {
      scope,
      resources,
      definitions,
      resourceKeys: new Set(resources.map(resource => referenceKey(resource.ref))),
      definitionKeys: new Set(definitions.map(definition => referenceKey(definition.ref))),
    }
  }
  const references = scope.kind === 'resource'
    ? [scope.resource]
    : [scope.collection, ...selectedCollectionMembers(scope, resources)]
  const resourceKeys = new Set(references.map(referenceKey))
  const scopedResources = resources.filter(resource => resourceKeys.has(referenceKey(resource.ref)))
  const definitionKeys = new Set(scopedResources.flatMap(resource => resource.sourceDefinition ? [referenceKey(resource.sourceDefinition)] : []))
  return {
    scope,
    resources: scopedResources,
    // A running Resource pins a revision, not the library's moving head.
    definitions: scopedResources.flatMap(resource => {
      const source = resource.sourceDefinition
      if (!source) return []
      const descriptor = definitions.find(definition => referenceKey(definition.ref) === referenceKey(source))
      return descriptor ? [{ ...descriptor, currentRevisionId: source.revisionId }] : []
    }).filter((definition, index, all) => all.findIndex(other =>
      referenceKey(other.ref) === referenceKey(definition.ref) && other.currentRevisionId === definition.currentRevisionId) === index),
    resourceKeys,
    definitionKeys,
  }
}

const requireRoomScope = (context: ToolContext, deps: WorkspaceCapabilityToolsDeps): WorkspaceRoomScope | ToolResult => {
  if (!context.roomId) return failure('room_context_required', 'Workspace access requires a current Room')
  return deps.getRoomScope(context.roomId) ?? failure('room_scope_unavailable', 'The current Room has no valid scope')
}

const isToolResult = (value: WorkspaceRoomScope | ToolResult): value is ToolResult => 'success' in value

const targetInScope = (target: WorkspaceTarget | undefined, resolved: ResolvedScope): ToolResult | undefined => {
  if (target === undefined) return resolved.scope.kind === 'workspace'
    ? undefined
    : failure('workspace_operation_out_of_scope', 'This Room is scoped to Resources, not the whole Workspace')
  const allowed = target.kind === 'resource'
    ? resolved.resourceKeys.has(referenceKey(target.ref))
    : resolved.definitionKeys.has(referenceKey(target.ref)) && (resolved.scope.kind === 'workspace'
      || resolved.definitions.some(definition => referenceKey(definition.ref) === referenceKey(target.ref)
        && definition.currentRevisionId === target.ref.revisionId))
  return allowed ? undefined : failure('target_out_of_scope', 'The requested target is outside the current Room Scope', { target, scope: resolved.scope })
}

const applicabilityFailure = (
  operation: ModuleCapabilityDescriptor | undefined,
  target: WorkspaceTarget | undefined,
  resources: ReadonlyArray<ModuleResourceDescriptor>,
  definitions: ReadonlyArray<ModuleDefinitionDescriptor>,
): ToolResult | undefined => {
  if (!operation) return failure('operation_not_advertised', 'The Workspace does not advertise this operation')
  if (operation.scope.kind === 'workspace') return target === undefined
    ? undefined
    : failure('operation_scope_mismatch', 'This Workspace operation does not accept a target')
  if (target === undefined) return failure('target_required', 'This operation requires an exact target')
  if (operation.scope.kind !== target.kind) return failure('operation_scope_mismatch', `This operation requires a ${operation.scope.kind} target`)
  if (target.kind === 'resource') {
    const descriptor = resources.find(resource => referenceKey(resource.ref) === referenceKey(target.ref))
    if (!descriptor) return failure('resource_not_found', 'The target Resource is not advertised by the Workspace')
    if (operation.scope.kind !== 'resource' || operation.scope.resourceType !== target.ref.type || !descriptor.capabilityIds.includes(operation.id)) {
      return failure('operation_not_available', 'The target Resource does not advertise this operation')
    }
    return undefined
  }
  const descriptor = definitions.find(definition => referenceKey(definition.ref) === referenceKey(target.ref))
  if (!descriptor) return failure('definition_not_found', 'The target Definition is not advertised by the Workspace')
  // Revision existence is owned by the Module, not by the current-head catalog.
  if (operation.scope.kind !== 'definition' || operation.scope.definitionType !== target.ref.type || !descriptor.capabilityIds.includes(operation.id)) {
    return failure('operation_not_available', 'The target Definition does not advertise this operation')
  }
  return undefined
}

const onlyApplicableTarget = (
  operation: ModuleCapabilityDescriptor | undefined,
  resolved: ResolvedScope,
): WorkspaceTarget | undefined => {
  if (!operation || operation.scope.kind === 'workspace') return undefined
  const operationScope = operation.scope
  if (operationScope.kind === 'resource') {
    const matches = resolved.resources.filter(resource =>
      resource.ref.type === operationScope.resourceType && resource.capabilityIds.includes(operation.id))
    return matches.length === 1 ? { kind: 'resource', ref: matches[0]!.ref } : undefined
  }
  const matches = resolved.definitions.filter(definition =>
    definition.ref.type === operationScope.definitionType && definition.capabilityIds.includes(operation.id))
  return matches.length === 1
    ? { kind: 'definition', ref: { ...matches[0]!.ref, revisionId: matches[0]!.currentRevisionId } }
    : undefined
}

const compactDefinition = (definition: ModuleDefinitionDescriptor) => {
  const { ref, currentRevisionId, capabilityIds, deleteCapabilityId: _deleteCapabilityId, ...descriptor } = definition
  return { ...descriptor, target: { kind: 'definition', ref: { ...ref, revisionId: currentRevisionId } }, operationCount: capabilityIds.length }
}

const compactResource = (resource: ModuleResourceDescriptor) => {
  const { ref, capabilityIds, deleteCapabilityId: _deleteCapabilityId, renameCapabilityId: _renameCapabilityId, ...descriptor } = resource
  return { ...descriptor, target: { kind: 'resource', ref }, operationCount: capabilityIds.length }
}

const textTerms = (value: string): ReadonlyArray<string> =>
  [...new Set(value.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter(term => term.length >= 2) ?? [])]

/** The words an operation is found by: its name (id and title) and everything said about it. */
const operationTerms = (operation: ModuleCapabilityDescriptor): { readonly name: ReadonlySet<string>; readonly all: ReadonlySet<string> } => ({
  name: new Set(textTerms(`${operation.id} ${operation.title}`)),
  all: new Set(textTerms([
    operation.id,
    operation.title,
    operation.description,
    operation.moduleId,
    operation.kind,
    operation.risk,
    ...(operation.searchTerms ?? []),
  ].join(' '))),
})

/**
 * An operation id passed as a query names that operation, exactly as
 * `operationIds` does. Read as words it would split into its namespace
 * ("world", "process", "plant", …), which every operation of its Pack shares,
 * and match them all: five ids as queries returned 30 operations with their
 * schemas, 52 KB re-sent on every later model call of the turn.
 */
const isOperationIdQuery = (query: string): boolean => capabilityIdSchema.safeParse(query).success

// Okapi BM25's customary constants: how fast a match saturates, and how much
// an operation's vocabulary size discounts it.
const BM25_K1 = 1.2
const BM25_B = 0.75

/**
 * How well a query's words match a field of an operation, by Okapi BM25 over
 * the operations being searched: a rare word says a lot about which operation
 * is meant, a word every candidate shares ("world", a Pack's own name) almost
 * nothing, and a match in a large vocabulary (an operation listing every
 * action it invokes) less than one in a short description. An operation named
 * for the words asked for ranks first, then by all it says. Ranking only: any
 * matched word still selects an operation.
 */
const bm25 = (operations: ReadonlyArray<ReadonlySet<string>>): ((terms: ReadonlySet<string>, matched: ReadonlyArray<string>) => number) => {
  const frequency = new Map<string, number>()
  for (const terms of operations) for (const term of terms) frequency.set(term, (frequency.get(term) ?? 0) + 1)
  const averageSize = operations.reduce((sum, terms) => sum + terms.size, 0) / Math.max(1, operations.length)
  const idf = (term: string): number => {
    const count = frequency.get(term) ?? 0
    return Math.log((operations.length - count + 0.5) / (count + 0.5) + 1)
  }
  return (terms, matched) => matched.reduce((sum, term) =>
    sum + idf(term) * (BM25_K1 + 1) / (1 + BM25_K1 * (1 - BM25_B + BM25_B * terms.size / averageSize)), 0)
}

const targetInputSchema = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('resource'),ref:workspaceResourceReferenceSchema}).strict(),
  z.object({kind:z.literal('definition'),ref:workspaceDefinitionRevisionReferenceSchema}).strict(),
])
const exploreInputSchema = z.object({
  view:z.enum(['scope','operations']).default('scope').describe('scope lists exact Resources and Definition revisions; operations searches their available reads and changes. Each view has its own pagination.'),
  target:targetInputSchema.optional().describe('An exact discovered target, unchanged. Omit to search across the current Room Scope; browser focus does not widen scope.'),
  moduleId:z.string().optional(), resourceType:z.string().optional(), definitionType:z.string().optional(),
  queries:z.array(z.string().trim().min(1).max(256)).max(8).default([]).describe('Alternative plain-language operation searches, ranked by word overlap. Searches operation descriptions, not asset names or live state. A query that is an operation ID is read as that exact ID. Use view=operations.'),
  operationIds:z.array(capabilityIdSchema).max(24).default([]).describe('Exact known operation IDs. May be combined with queries; results matching either are returned, with exact IDs first.'),
  includeInputSchema:z.boolean().default(false).describe('Include callable input schemas for returned operations. Request with a focused search or known IDs; omitted by default for compact browsing.'),
  includeOutputSchema:z.boolean().default(false).describe('Include output schemas when needed to interpret results. Usually leave off; these can be large.'),
  offset:z.number().int().nonnegative().default(0).describe('Continue the same view and filters from this result offset.'),
  limit:z.number().int().min(1).max(MAX_PAGE_SIZE).optional().describe(`Maximum entries in this page; hasMore indicates additional results. Default ${DEFAULT_PAGE_SIZE}, or with schemas ${DEFAULT_SCHEMA_PAGE_SIZE} plus every exact ID asked for.`),
}).strict()
const callInputSchema = z.object({
  calls:z.array(z.object({
    key:z.string().trim().min(1).max(64).describe('Unique label within this request, echoed with its result.'),
    operationId:capabilityIdSchema,
    target:targetInputSchema.optional().describe('Exact discovered Resource or Definition-revision target. If omitted, resolves only when one eligible target is in scope; Workspace operations take no target.'),
    input:z.unknown().describe('Arguments matching the operation input schema. Reuse known schemas; discover unfamiliar ones before guessing parameters.'),
    expectedRevision:z.number().int().nonnegative().optional().describe('Supply only when the operation supports a current revision precondition.'),
    idempotencyKey:z.string().min(1).max(256).optional().describe('Retry key only for operations advertising acceptsIdempotencyKey. Verify unknown change outcomes rather than blindly retrying.'),
    say:z.string().trim().min(1).max(MAX_SAY_LENGTH).optional().describe('A short line for the person, posted to this conversation as your own message once this call succeeds, before your answer: e.g. a procedure step you decided and why, or a plant operation you made. Never for reads.'),
  }).strict()).min(1).max(MAX_READ_BATCH_SIZE).describe('One read or change, or a batch of independent reads. Results follow request order; concurrent reads are not an atomic snapshot.'),
}).strict()

const catalogPath = (workspacePath: string, kind: 'capabilities' | 'definitions' | 'resources'): string => `${workspacePath}/${kind}`

/**
 * What the model reads of a workspace_call result. A published view's `state`
 * is opaque to every embedder (contracts embedded-views.ts), and its completed
 * envelope is execution evidence the display window resolves by viewRef: the
 * model presents a view by reference only, so neither is repeated in its
 * context (a composed display carried its state twice, about 8 KB). A card
 * reads as its lines, re-keyed into the turn's keys (answer-cards.ts), so
 * call this once per result. The rest of the result stays. Every check reads
 * the raw result, the turn's cards or the execution store, never this text:
 * the view fence, citation and answer-consistency checks (evaluation.ts),
 * what a turn did (operation-claims.ts), proposal cards and the display window.
 */
export const workspaceCallResultForModel = (result: ToolResult, cards: TurnCards): ToolResult => {
  if (!result.success) return result
  const { results } = result.data as { readonly results: ReadonlyArray<Readonly<Record<string, unknown>>> }
  return { ...result, data: { results: results.map(entry => {
    const carried = entryCard(entry)
    if (!Object.hasOwn(entry, 'embeddedView') && carried === undefined) return entry
    const { embeddedView: _evidence, data, ...rest } = entry
    // An envelope is completed only from a valid publication in data.view (embeddedViewFor).
    const { view, card: _card, ...fields } = data as { readonly view?: EmbeddedViewPublication; readonly card?: unknown } & Readonly<Record<string, unknown>>
    const shown = view === undefined ? {} : { view: Object.hasOwn(entry, 'embeddedView') ? withoutState(view) : view }
    return { ...rest, data: { ...fields, ...shown, ...(carried === undefined ? {} : { card: cardLines(cards.add(carried.card)) }) } }
  }) } }
}

const withoutState = ({ state: _opaque, ...publication }: EmbeddedViewPublication) => publication

// The Workspace's published catalogs, read through the Host. Revalidated on
// every access: a parsed operation catalog is reused only when the Host
// confirms the exact same content; membership and policy stay live.
const createCatalogReader = (deps: WorkspaceCapabilityToolsDeps) => {
  const fetchImpl = deps.fetchImpl ?? fetch
  const workspacePath = `${origin(deps.hostBaseUrl)}/api/workspaces/${encodeURIComponent(deps.workspaceId)}`
  let operationCache: { etag: string; catalog: ReturnType<typeof workspaceCapabilityCatalogSchema.parse> } | undefined
  const loadOperations = async (signal: AbortSignal | undefined) => {
    const cached = operationCache
    const response = await getJson(fetchImpl, catalogPath(workspacePath, 'capabilities'), signal, cached?.etag)
    if (response.status === 304) {
      if (!cached) throw new Error('Host returned 304 without a cached operation catalog')
      return cached.catalog
    }
    if (!response.ok) throw await readHostError(response)
    const published = workspaceCapabilityCatalogSchema.parse(await response.json())
    // Agents' own People Capabilities serve the humans of a Workspace through
    // the Host UI; its AI Agents never discover or invoke them.
    const catalog = { ...published, capabilities: published.capabilities.filter(operation => !isPeopleCapabilityId(operation.id)) }
    const etag = response.headers.get('etag')
    operationCache = etag ? {etag,catalog} : undefined
    return catalog
  }
  const loadPublished = async (signal: AbortSignal | undefined) => {
    const [definitionResponse, resourceResponse, operations] = await Promise.all([
      getJson(fetchImpl, catalogPath(workspacePath, 'definitions'), signal),
      getJson(fetchImpl, catalogPath(workspacePath, 'resources'), signal),
      loadOperations(signal),
    ])
    for (const response of [definitionResponse, resourceResponse]) {
      if (!response.ok) throw await readHostError(response)
    }
    return {
      definitions: workspaceDefinitionCatalogSchema.parse(await definitionResponse.json()),
      resources: workspaceResourceCatalogSchema.parse(await resourceResponse.json()),
      operations,
    }
  }
  return { fetchImpl, workspacePath, loadPublished }
}

/**
 * The operations within a Room's Scope whose results publish an embedded view
 * an Agent can present with its answer, as their owning Module declares it
 * (the descriptor's `publishes` marker), never by a known operation id. A
 * Room whose Scope reaches none cannot be shown a display.
 */
export const createViewPublisherLookup = (deps: WorkspaceCapabilityToolsDeps) => {
  const reader = createCatalogReader(deps)
  return async (roomId: string, signal?: AbortSignal): Promise<ReadonlyArray<CapabilityId>> => {
    const scope = deps.getRoomScope(roomId)
    if (scope === undefined) throw new Error(`Room ${roomId} has no valid scope`)
    const catalogs = await (async () => {
      try { return await reader.loadPublished(signal) }
      catch (error) {
        // The Host refusal arrives as a tool failure; this lookup is not a tool.
        if (error && typeof error === 'object' && 'success' in error) throw new Error((error as ToolResult).error ?? 'Workspace Host request failed')
        throw error
      }
    })()
    const resolved = resolveScope(scope, catalogs.resources.resources, catalogs.definitions.definitions)
    const reachable = new Set(resolved.resources.flatMap(resource => resource.capabilityIds))
    return catalogs.operations.capabilities
      .filter(operation => operation.publishes?.includes('embedded-view') === true && reachable.has(operation.id))
      .map(operation => operation.id)
  }
}

/** A Resource in a Room's Scope and the operation its Module marks as publishing that Resource's context. */
export interface ContextPublisher {
  readonly operationId: CapabilityId
  readonly resource: WorkspaceResourceReference
}

/**
 * The context publishers within a Room's Scope (the descriptor's `publishes:
 * ['context']` marker, never a known operation id) and their read, invoked
 * through the Host broker as the Agent, so its restrictions apply
 * (agents/run-context.ts chooses one, never by guessing).
 */
export const createContextPublisherLookup = (deps: WorkspaceCapabilityToolsDeps) => {
  const { fetchImpl, workspacePath, loadPublished } = createCatalogReader(deps)
  return {
    publishers: async (roomId: string, signal?: AbortSignal): Promise<ReadonlyArray<ContextPublisher>> => {
      const scope = deps.getRoomScope(roomId)
      if (scope === undefined) throw new Error(`Room ${roomId} has no valid scope`)
      const catalogs = await (async () => {
        try { return await loadPublished(signal) }
        catch (error) {
          if (error && typeof error === 'object' && 'success' in error) throw new Error((error as ToolResult).error ?? 'Workspace Host request failed')
          throw error
        }
      })()
      const marked = catalogs.operations.capabilities.filter(operation => operation.publishes?.includes('context') === true)
      return resolveScope(scope, catalogs.resources.resources, catalogs.definitions.definitions).resources.flatMap(resource =>
        marked.filter(operation => resource.capabilityIds.includes(operation.id)).map(operation => ({ operationId: operation.id, resource: resource.ref })))
    },
    read: async (publisher: ContextPublisher, caller: { readonly id: string; readonly name: string }, signal?: AbortSignal): Promise<{ readonly ok: true; readonly context: PublishedContext['context'] } | { readonly ok: false; readonly refusal: ToolResult }> => {
      const response = await fetchImpl(`${workspacePath}/capabilities/${encodeURIComponent(publisher.operationId)}/invoke`, {
        method: 'POST', signal: requestSignal(signal), headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ resource: publisher.resource, input: {}, actor: { kind: 'ai', id: caller.id, displayName: caller.name } }),
      })
      if (!response.ok) return { ok: false, refusal: await readHostError(response) }
      return { ok: true, context: publishedContextSchema.parse(((await response.json()) as { result?: unknown }).result).context }
    },
  }
}

export const createWorkspaceCapabilityTools = (deps: WorkspaceCapabilityToolsDeps): ReadonlyArray<Tool> => {
  const { fetchImpl, workspacePath, loadPublished } = createCatalogReader(deps)

  const loadCatalogs = async (context: ToolContext) => {
    const catalogs = await loadPublished(context.signal)
    const { operations } = catalogs
    if (!context.comparison) return catalogs
    const captured = context.comparison
    const liveScope = requireRoomScope(context, deps)
    if (isToolResult(liveScope)) throw liveScope
    const current = resolveScope(liveScope, catalogs.resources.resources, catalogs.definitions.definitions)
    // A single-resource Room keeps its reference even after that Resource is
    // deleted, so validate actual catalog membership, not declared scope keys.
    const availableResources = new Set(current.resources.map(resource => referenceKey(resource.ref)))
    const availableDefinitions = new Set(current.definitions.map(definition => referenceKey(definition.ref)))
    if (captured.resourceKeys.some(key => !availableResources.has(key))) throw new Error('comparison_scope_changed: a captured Resource was deleted or is no longer accessible')
    if (captured.definitionKeys.some(key => !availableDefinitions.has(key))) throw new Error('comparison_scope_changed: a captured Definition was deleted or is no longer accessible')
    const resourceKeys = new Set(captured.resourceKeys)
    const definitionKeys = new Set(captured.definitionKeys)
    const capabilities = operations.capabilities.filter(op => op.risk === 'read' && !op.comparisonUnavailableReason)
    const operationIds = new Set(capabilities.map(operation => operation.id))
    return {
      resources: { ...catalogs.resources, resources: current.resources.filter(resource => resourceKeys.has(referenceKey(resource.ref))).map(resource => {
        const { inspectionCapabilityId, deleteCapabilityId, renameCapabilityId, sourceDefinition, ...rest } = resource
        return {
          ...rest,
          capabilityIds: resource.capabilityIds.filter(id => operationIds.has(id)),
          links: resource.links.filter(link => resourceKeys.has(referenceKey(link.ref))),
          ...(sourceDefinition && definitionKeys.has(referenceKey(sourceDefinition)) ? { sourceDefinition } : {}),
          ...(inspectionCapabilityId && operationIds.has(inspectionCapabilityId) ? { inspectionCapabilityId } : {}),
          ...(deleteCapabilityId && operationIds.has(deleteCapabilityId) ? { deleteCapabilityId } : {}),
          ...(renameCapabilityId && operationIds.has(renameCapabilityId) ? { renameCapabilityId } : {}),
        }
      }) },
      definitions: { ...catalogs.definitions, definitions: current.definitions.filter(definition => definitionKeys.has(referenceKey(definition.ref))).map(definition => {
        const { inspectionCapabilityId, primaryCapabilityId, deleteCapabilityId, ...rest } = definition
        return {
          ...rest,
          capabilityIds: definition.capabilityIds.filter(id => operationIds.has(id)),
          ...(inspectionCapabilityId && operationIds.has(inspectionCapabilityId) ? { inspectionCapabilityId } : {}),
          ...(primaryCapabilityId && operationIds.has(primaryCapabilityId) ? { primaryCapabilityId } : {}),
          ...(deleteCapabilityId && operationIds.has(deleteCapabilityId) ? { deleteCapabilityId } : {}),
        }
      }) },
      operations: { ...operations, capabilities },
    }
  }

  const explore: Tool = {
    name: 'workspace_explore',
    description: 'Discover scoped Resources and Definitions, or search their available read/change operations. Request input schemas directly with a focused search; reuse known targets and operations without mandatory rediscovery.',
    usage: 'Choose scope for exact targets or operations for callable behavior. Focused operation searches can include input schemas in the same call; schemas are omitted unless requested. Focus indicates attention and never expands Room Scope.',
    returns: 'The current Room Scope, focused subjects, exact targets, compact metadata, and/or matching operations. Returned targets can be passed unchanged to workspace_call.',
    parameters: z.toJSONSchema(exploreInputSchema, { io: 'input' }),
    execute: async (rawParams, context) => {
      const validated = exploreInputSchema.safeParse(rawParams)
      if (!validated.success) return failure('invalid_tool_input', validated.error.message)
      const params = validated.data
      const roomScope = requireRoomScope(context, deps)
      if (isToolResult(roomScope)) return roomScope
      try {
        const view = params.view
        const target = parseTarget(params.target, deps.workspaceId)
        const moduleId = optionalFilter(params.moduleId) === undefined ? undefined : moduleIdSchema.parse(params.moduleId)
        const resourceType = optionalFilter(params.resourceType) === undefined ? undefined : resourceTypeSchema.parse(params.resourceType)
        const definitionType = optionalFilter(params.definitionType) === undefined ? undefined : definitionTypeSchema.parse(params.definitionType)
        const { offset } = params
        const queries = params.queries.filter(query => !isOperationIdQuery(query))
        const operationIds = [...new Set([...params.operationIds, ...params.queries.filter(isOperationIdQuery)])]

        const catalogs = await loadCatalogs(context)
        const currentScope = requireRoomScope(context, deps)
        if (isToolResult(currentScope)) return currentScope
        const resolved = resolveScope(currentScope, catalogs.resources.resources, catalogs.definitions.definitions)
        const scopeIssue = targetInScope(target, resolved)
        if (target !== undefined && scopeIssue) return scopeIssue
        const focusedSubjects = (context.focusedSubjects ?? []).filter(subject =>
          'revisionId' in subject
            ? targetInScope({kind:'definition',ref:subject}, resolved) === undefined
            : resolved.resourceKeys.has(referenceKey(subject)))

        const resources = resolved.resources.filter(resource =>
          definitionType === undefined
          && (target === undefined || (target.kind === 'resource' && referenceKey(resource.ref) === referenceKey(target.ref)))
          && (moduleId === undefined || resource.ref.moduleId === moduleId)
          && (resourceType === undefined || resource.ref.type === resourceType))
        const definitions = resolved.definitions.filter(definition =>
          resourceType === undefined
          && (target === undefined || (target.kind === 'definition' && referenceKey(definition.ref) === referenceKey(target.ref)))
          && (moduleId === undefined || definition.ref.moduleId === moduleId)
          && (definitionType === undefined || definition.ref.type === definitionType))

        const exactIds = new Set(operationIds)
        const relevantIds = target === undefined
          ? new Set([
              ...resources.flatMap(resource => resource.capabilityIds),
              ...definitions.flatMap(definition => definition.capabilityIds),
              ...(resolved.scope.kind === 'workspace' && resourceType === undefined && definitionType === undefined
                ? catalogs.operations.capabilities.filter(operation => operation.scope.kind === 'workspace').map(operation => operation.id)
                : []),
            ])
          : new Set(target.kind === 'resource'
              ? catalogs.resources.resources.find(resource => referenceKey(resource.ref) === referenceKey(target.ref))?.capabilityIds ?? []
              : catalogs.definitions.definitions.find(definition => referenceKey(definition.ref) === referenceKey(target.ref))?.capabilityIds ?? [])
        const candidates = catalogs.operations.capabilities
          .filter(operation => relevantIds.has(operation.id))
          .filter(operation => moduleId === undefined || operation.moduleId === moduleId)
          .filter(operation => target === undefined || applicabilityFailure(operation, target, catalogs.resources.resources, catalogs.definitions.definitions) === undefined)
          .map(operation => ({ operation, terms: operationTerms(operation) }))
        const nameRelevance = bm25(candidates.map(candidate => candidate.terms.name))
        const relevance = bm25(candidates.map(candidate => candidate.terms.all))
        const matches = new Map(candidates.map(({ operation, terms }) => [operation.id, queries.flatMap(query => {
          const words = textTerms(query)
          const matched = words.filter(term => terms.all.has(term))
          return matched.length === 0 ? [] : [{
            query, matched,
            nameScore: nameRelevance(terms.name, words.filter(term => terms.name.has(term))),
            score: relevance(terms.all, matched),
          }]
        })]))
        const noSelector = operationIds.length === 0 && queries.length === 0
        const byId = (left: ModuleCapabilityDescriptor, right: ModuleCapabilityDescriptor): number => left.id.localeCompare(right.id)
        const exact = candidates.map(candidate => candidate.operation).filter(operation => exactIds.has(operation.id)).sort(byId)
        // Each query is its own search: the page takes the best match of
        // every query before the second best of any, so one broad query
        // cannot crowd out what another one asked for.
        const rankings = queries.map(query => candidates
          .flatMap(({ operation }) => matches.get(operation.id)!.filter(match => match.query === query).map(match => ({ operation, ...match })))
          .sort((left, right) => right.nameScore - left.nameScore || right.score - left.score || byId(left.operation, right.operation))
          .map(entry => entry.operation))
        const searched = Array.from({ length: Math.max(0, ...rankings.map(ranking => ranking.length)) }, (_, rank) =>
          rankings.flatMap(ranking => ranking[rank] === undefined ? [] : [ranking[rank]]))
          .flat()
        const operations = noSelector
          ? candidates.map(candidate => candidate.operation).sort(byId)
          : [...new Set([...exact, ...searched])]
        // An exact ID this Room cannot reach is named, never left to look like an empty search.
        const unavailableOperationIds = operationIds.filter(id => !operations.some(operation => operation.id === id))
        const limit = params.limit ?? (params.includeInputSchema ? Math.max(DEFAULT_SCHEMA_PAGE_SIZE, exactIds.size) : DEFAULT_PAGE_SIZE)
        const combined = view === 'scope'
          ? [...definitions.map(value => ({ kind: 'definition' as const, value })), ...resources.map(value => ({ kind: 'resource' as const, value }))]
          : operations.map(value => ({ kind: 'operation' as const, value }))
        const page = combined.slice(offset, offset + limit)
        return { success: true, data: {
          workspaceId: deps.workspaceId,
          scope: resolved.scope,
          ...(context.comparison ? { comparison: { mode: 'live-read-only', scope: 'captured targets only; new family members are not included' } } : {}),
          focusedSubjects,
          ...(target === undefined ? {} : { target }),
          total: combined.length,
          offset,
          returned: page.length,
          hasMore: offset + page.length < combined.length,
          ...(view === 'operations' && unavailableOperationIds.length > 0 ? { unavailableOperationIds } : {}),
          definitions: page.filter(item => item.kind === 'definition').map(item => compactDefinition(item.value as ModuleDefinitionDescriptor)),
          resources: page.filter(item => item.kind === 'resource').map(item => compactResource(item.value as ModuleResourceDescriptor)),
          operations: page.filter(item => item.kind === 'operation').map(item => {
            const operation = item.value as ModuleCapabilityDescriptor
            const { id, inputSchema, outputSchema, searchTerms: _searchTerms, ...descriptor } = operation
            const matched = matches.get(id)!
            const matchedTerms = [...new Set(matched.flatMap(match => match.matched))]
            return {
              ...descriptor,
              operationId: id,
              ...(queries.length > 0 ? { matchedQueries: matched.map(match => match.query) } : {}),
              ...(matchedTerms.length > 0 ? { matchedTerms } : {}),
              ...(params.includeInputSchema === true ? { inputSchema: schemaForModel(inputSchema) } : {}),
              ...(params.includeOutputSchema === true ? { outputSchema: schemaForModel(outputSchema) } : {}),
            }
          }),
        } }
      } catch (error) {
        if (error && typeof error === 'object' && 'success' in error) return error as ToolResult
        return failure('workspace_exploration_failed', error instanceof Error ? error.message : String(error))
      }
    },
  }

  const call: Tool = {
    name: 'workspace_call',
    description: 'Call discovered operations; batch only independent reads. A missing Resource or Definition target resolves only when exactly one eligible target is in scope; otherwise choose an exact discovered target.',
    usage: 'Use exact operation IDs and targets returned by workspace_explore. Reads and changes use the same call shape. Batch only independent reads; issue changes separately. Supply idempotencyKey only when the discovered operation advertises acceptsIdempotencyKey. A change may carry `say`: once it succeeds, that line is posted to the Room as the Agent\'s own progress message while its turn continues; a read carrying it is refused. A target Module enforces current run restrictions and safety checks.',
    returns: 'Results in request order. Each result contains either data or a structured error such as out-of-scope, restricted, stale, or invalid input.',
    parameters: z.toJSONSchema(callInputSchema, { io: 'input' }),
    execute: async (rawParams, context) => {
      const validated = callInputSchema.safeParse(rawParams)
      if (!validated.success) return failure('invalid_tool_input', validated.error.message)
      const params = validated.data
      const roomScope = requireRoomScope(context, deps)
      if (isToolResult(roomScope)) return roomScope
      try {
        const calls = params.calls.map(entry => ({
          ...entry, target: parseTarget(entry.target, deps.workspaceId),
        }))
        if (new Set(calls.map(call => call.key)).size !== calls.length) return failure('invalid_tool_input', 'Batch keys must be unique')
        const catalogs = await loadCatalogs(context)
        const currentScope = requireRoomScope(context, deps)
        if (isToolResult(currentScope)) return currentScope
        const resolved = resolveScope(currentScope, catalogs.resources.resources, catalogs.definitions.definitions)
        const prepared = calls.map(entry => {
          const operation = catalogs.operations.capabilities.find(candidate => candidate.id === entry.operationId)
          return {
            ...entry,
            target: entry.target ?? onlyApplicableTarget(operation, resolved),
            operation,
          }
        })
        if (prepared.length > 1 && prepared.some(entry => entry.operation?.risk !== 'read')) {
          return failure('batch_requires_read_operations', 'Only read operations may be batched')
        }
        const results = await Promise.all(prepared.map(async entry => {
          const issue = applicabilityFailure(entry.operation, entry.target, catalogs.resources.resources, catalogs.definitions.definitions)
            ?? targetInScope(entry.target, resolved)
          if (issue) return { key: entry.key, operationId: entry.operationId, success: false, error: issue.error, details: issue.data }
          if (entry.idempotencyKey !== undefined && entry.operation?.acceptsIdempotencyKey !== true) {
            return {
              key: entry.key,
              operationId: entry.operationId,
              success: false,
              error: 'idempotency_not_supported: This operation does not advertise caller-supplied retry keys',
            }
          }
          // A line says what a change did; a read changes nothing to report.
          // Refused before invocation, like a retry key, so the other reads of
          // a batch still run.
          if (entry.say !== undefined && entry.operation?.risk === 'read') {
            return {
              key: entry.key,
              operationId: entry.operationId,
              success: false,
              error: 'say_not_for_reads: say reports a change; call this read again without say',
            }
          }
          try {
            const response = await fetchImpl(`${workspacePath}/capabilities/${encodeURIComponent(entry.operationId)}/invoke`, {
              method: 'POST',
              signal: requestSignal(context.signal),
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
              body: JSON.stringify({
                ...(entry.target?.kind === 'definition' ? { definition: entry.target.ref } : {}),
                ...(entry.target?.kind === 'resource' ? { resource: entry.target.ref } : {}),
                ...(entry.expectedRevision === undefined ? {} : { expectedRevision: entry.expectedRevision }),
                ...(entry.idempotencyKey === undefined ? {} : { idempotencyKey: entry.idempotencyKey }),
                input: entry.input,
                actor: { kind: 'ai', id: context.callerId, displayName: context.callerName },
              }),
            })
            if (!response.ok) {
              const result = await readHostError(response)
              // The operation is advertised: applicabilityFailure refused an unadvertised one before invocation.
              return { key: entry.key, operationId: entry.operationId, success: false, error: result.error, details: result.data, ...refusedInputSchema(result, entry.operation!) }
            }
            const body = await response.json() as { result?: unknown }
            if (!Object.hasOwn(body, 'result')) return { key: entry.key, operationId: entry.operationId, success: false, error: 'workspace_host_contract_invalid: Workspace Host response omitted result' }
            // A Module may publish a view of its result. The envelope is
            // completed with the exact Resource this call targeted and kept as
            // execution evidence; the model presents it by reference only.
            const view = entry.target?.kind === 'resource' ? embeddedViewFor(body.result, entry.target.ref) : { kind: 'none' as const }
            return {
              key: entry.key,
              operationId: entry.operationId,
              // The exact target the call went to, kept as evidence: an answer's later reads (a proposal's status) go to the same one.
              ...(entry.target === undefined ? {} : { target: entry.target }),
              success: true,
              data: body.result,
              ...(view.kind === 'invalid' ? { viewError: view.error } : {}),
              ...(view.kind === 'view' ? {
                embeddedView: view.envelope,
                ...(context.executionCallId === undefined
                  ? { viewError: 'this executor keeps no execution evidence, so the view cannot be shown' }
                  : { viewRef: viewRefFor(context.executionCallId, entry.key) }),
              } : {}),
            }
          } catch (error) {
            return { key: entry.key, operationId: entry.operationId, success: false, error: `workspace_outcome_unknown: ${error instanceof Error ? error.message : String(error)}` }
          }
        }))
        // The line of each call that succeeded, in request order; a refused
        // or unknown outcome posts nothing. It needs no execution evidence.
        const progress = prepared.flatMap((entry, index) => entry.say !== undefined && results[index]!.success ? [entry.say] : [])
        return { success: true, data: { results }, ...(progress.length === 0 ? {} : { progress }) }
      } catch (error) {
        if (error && typeof error === 'object' && 'success' in error) return error as ToolResult
        return failure('invalid_tool_input', error instanceof Error ? error.message : String(error))
      }
    },
  }

  return [explore, call]
}
