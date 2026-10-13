import {
  moduleActivitySchema,
  moduleCapabilityCollectionSchema,
  moduleCapabilityInvocationResultSchema,
  moduleCapabilityInvocationSchema,
  moduleDefinitionCollectionSchema,
  moduleFailureSchema,
  moduleFeaturedDefinitionCollectionSchema,
  moduleIdSchema,
  moduleRegistrationSchema,
  moduleResourceCollectionSchema,
  platformErrorSchema,
  workspaceModuleManifestSchema,
  type ModuleActivity,
  type ModuleCapabilityCollection,
  type ModuleCapabilityInvocation,
  type ModuleCapabilityInvocationResult,
  type ModuleDefinitionCollection,
  type ModuleFailure,
  type ModuleFeaturedDefinitionCollection,
  type ModuleId,
  type ModuleRegistration,
  type ModuleResourceCollection,
  type WorkspaceId,
  type WorkspaceModuleManifest,
} from '@leitbild/contracts'

export type ModuleCallResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ModuleFailure }

export type ModuleOperationResult = ModuleCallResult<undefined>

export interface ModuleGateway {
  readonly list: () => ReadonlyArray<ModuleRegistration>
  readonly has: (moduleId: ModuleId) => boolean
  readonly provision: (moduleId: ModuleId, workspaceId: WorkspaceId) => Promise<ModuleOperationResult>
  readonly remove: (moduleId: ModuleId, workspaceId: WorkspaceId) => Promise<ModuleOperationResult>
  readonly definitions: (moduleId: ModuleId, workspaceId: WorkspaceId) => Promise<ModuleCallResult<ModuleDefinitionCollection>>
  readonly resources: (moduleId: ModuleId, workspaceId: WorkspaceId) => Promise<ModuleCallResult<ModuleResourceCollection>>
  readonly capabilities: (moduleId: ModuleId, workspaceId: WorkspaceId) => Promise<ModuleCallResult<ModuleCapabilityCollection>>
  /** The Definitions a Module features for newcomers; Workspace-independent. */
  readonly featuredDefinitions: (moduleId: ModuleId) => Promise<ModuleCallResult<ModuleFeaturedDefinitionCollection>>
  /** What a Module states is going on in each Workspace; Workspace-independent. */
  readonly activity: (moduleId: ModuleId) => Promise<ModuleCallResult<ModuleActivity>>
  readonly invoke: (moduleId: ModuleId, invocation: ModuleCapabilityInvocation, signal?: AbortSignal) => Promise<ModuleCallResult<ModuleCapabilityInvocationResult>>
}

// A Module that cannot be reached is reported in words people can act on. The
// transport's own text (Bun: "The socket connection was closed unexpectedly…
// pass `verbose: true`…") is kept in details for diagnosis, never as the message.
const moduleNouns: Readonly<Record<string, string>> = { world: 'the simulation', agents: 'the AI agents' }
const lostConnection = (moduleId: ModuleId, action: 'reconnect' | 'check'): string =>
  `Lost the connection to ${moduleNouns[moduleId] ?? `the ${moduleId} Module`}. ${action === 'check'
    ? 'Reload to check whether the action was applied.' : 'Reload to reconnect.'}`
const transportCause = (error: unknown): { readonly cause: string } => ({ cause: error instanceof Error ? error.message : String(error) })

const normalizeBaseUrl = (value: string): string => {
  const url = new URL(value)
  url.pathname = url.pathname.replace(/\/+$/, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

const failure = <T>(config: ModuleFailure): ModuleCallResult<T> => ({
  ok: false,
  failure: moduleFailureSchema.parse(config),
})

const responseFailure = async <T>(
  response: Response,
  fallback: { readonly code: string; readonly message: string },
): Promise<ModuleCallResult<T>> => {
  const body = await response.json().catch(() => undefined)
  const parsed = platformErrorSchema.safeParse(body)
  return failure({
    code: parsed.success ? parsed.data.error.code : fallback.code,
    message: parsed.success ? parsed.data.error.message : fallback.message,
    status: response.status,
    ...(parsed.success && parsed.data.error.details ? { details: parsed.data.error.details } : {}),
    retryable: parsed.success
      ? (parsed.data.error.retryable ?? response.status >= 500)
      : response.status >= 500,
  })
}

const workspacePath = (pathTemplate: string, workspaceId: WorkspaceId): string =>
  pathTemplate.replaceAll('{workspaceId}', encodeURIComponent(workspaceId))

const expandWorkspacePath = (baseUrl: string, pathTemplate: string, workspaceId: WorkspaceId): string =>
  `${baseUrl}${workspacePath(pathTemplate, workspaceId)}`

const expandInvocationPath = (
  baseUrl: string,
  pathTemplate: string,
  invocation: ModuleCapabilityInvocation,
): string => expandWorkspacePath(baseUrl, pathTemplate, invocation.workspaceId)
  .replaceAll('{capabilityId}', encodeURIComponent(invocation.capabilityId))

export const createModuleGateway = (config: {
  readonly registrations: ReadonlyArray<ModuleRegistration>
  readonly fetch?: typeof fetch
  readonly requestTimeoutMs?: number
}): ModuleGateway => {
  const transport = config.fetch ?? fetch
  const fetchImpl = (input: string, init?: RequestInit): Promise<Response> => transport(input, { ...init,
    signal: AbortSignal.any([AbortSignal.timeout(config.requestTimeoutMs ?? 30_000), ...(init?.signal ? [init.signal] : [])]),
  })
  const registrations = config.registrations.map(registration => moduleRegistrationSchema.parse({
    ...registration,
    internalBaseUrl: normalizeBaseUrl(registration.internalBaseUrl),
  }))
  const byId = new Map(registrations.map(registration => [registration.moduleId, registration]))
  if (byId.size !== registrations.length) throw new Error('Module registrations must have unique ids')
  const manifestCache = new Map<ModuleId, Promise<WorkspaceModuleManifest | ModuleFailure>>()

  const fetchManifest = async (registration: ModuleRegistration): Promise<WorkspaceModuleManifest | ModuleFailure> => {
    let response: Response
    try {
      response = await fetchImpl(`${registration.internalBaseUrl}${registration.manifestPath}`, {
        headers: { Accept: 'application/json' },
      })
    } catch (error) {
      return moduleFailureSchema.parse({
        code: 'module_unavailable',
        message: lostConnection(registration.moduleId, 'reconnect'),
        retryable: true,
        details: transportCause(error),
      })
    }
    if (!response.ok) {
      return moduleFailureSchema.parse({
        code: 'module_discovery_failed',
        message: `Module discovery returned HTTP ${response.status}`,
        retryable: response.status >= 500,
      })
    }
    try {
      const manifest = workspaceModuleManifestSchema.parse(await response.json())
      if (manifest.module.id !== registration.moduleId) {
        return moduleFailureSchema.parse({
          code: 'module_identity_mismatch',
          message: `Module manifest identifies ${manifest.module.id}; expected ${registration.moduleId}`,
          retryable: false,
        })
      }
      return manifest
    } catch (error) {
      return moduleFailureSchema.parse({
        code: 'module_contract_invalid',
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      })
    }
  }

  // A Module manifest is a deployment contract, not Workspace state. Cache
  // successful discovery once per registered Module and discard failures so a
  // temporarily unavailable Module can recover on the next operation.
  const discover = async (registration: ModuleRegistration): Promise<WorkspaceModuleManifest | ModuleFailure> => {
    let pending = manifestCache.get(registration.moduleId)
    if (pending === undefined) {
      pending = fetchManifest(registration)
      manifestCache.set(registration.moduleId, pending)
    }
    const result = await pending
    if ('code' in result) manifestCache.delete(registration.moduleId)
    return result
  }

  const operate = async (moduleId: ModuleId, workspaceId: WorkspaceId, method: 'PUT' | 'DELETE'): Promise<ModuleOperationResult> => {
    const registration = byId.get(moduleId)
    if (!registration) {
      return failure({ code: 'module_not_installed', message: `Module is not installed: ${moduleId}`, retryable: false })
    }
    const manifest = await discover(registration)
    if ('code' in manifest) return { ok: false, failure: manifest }
    const url = expandWorkspacePath(registration.internalBaseUrl, manifest.endpoints.workspace, workspaceId)
    let response: Response
    try {
      response = await fetchImpl(url, {
        method,
        headers: { Accept: 'application/json', ...(method === 'PUT' ? { 'Content-Type': 'application/json' } : {}) },
        ...(method === 'PUT' ? { body: JSON.stringify({ workspaceId }) } : {}),
      })
    } catch (error) {
      return failure({
        code: 'module_unavailable',
        message: lostConnection(moduleId, 'reconnect'),
        retryable: true,
        details: transportCause(error),
      })
    }
    if (!response.ok) {
      return await responseFailure(response, {
        code: method === 'PUT' ? 'module_provision_failed' : 'module_remove_failed',
        message: `Module lifecycle returned HTTP ${response.status}`,
      })
    }
    return { ok: true, value: undefined }
  }

  const readCollection = async <T>(config: {
    readonly moduleId: ModuleId
    readonly endpoint: 'definitions' | 'resources' | 'capabilities' | 'featuredDefinitions' | 'activity'
    readonly path: (manifest: WorkspaceModuleManifest) => string
    readonly parse: (value: unknown) => T
  }): Promise<ModuleCallResult<T>> => {
    const registration = byId.get(config.moduleId)
    if (!registration) return failure({ code: 'module_not_installed', message: `Module is not installed: ${config.moduleId}`, retryable: false })
    const manifest = await discover(registration)
    if ('code' in manifest) return { ok: false, failure: manifest }
    const url = `${registration.internalBaseUrl}${config.path(manifest)}`
    let response: Response
    try {
      response = await fetchImpl(url, { headers: { Accept: 'application/json' } })
    } catch (error) {
      return failure({ code: 'module_unavailable', message: lostConnection(config.moduleId, 'reconnect'), retryable: true, details: transportCause(error) })
    }
    if (!response.ok) {
      return await responseFailure(response, {
        code: 'module_query_failed',
        message: `Module ${config.endpoint} query returned HTTP ${response.status}`,
      })
    }
    try {
      return { ok: true, value: config.parse(await response.json()) }
    } catch (error) {
      return failure({ code: 'module_contract_invalid', message: error instanceof Error ? error.message : String(error), retryable: false })
    }
  }

  const invoke = async (
    moduleId: ModuleId,
    rawInvocation: ModuleCapabilityInvocation,
    signal?: AbortSignal,
  ): Promise<ModuleCallResult<ModuleCapabilityInvocationResult>> => {
    const registration = byId.get(moduleId)
    if (!registration) return failure({ code: 'module_not_installed', message: `Module is not installed: ${moduleId}`, retryable: false })
    const invocation = moduleCapabilityInvocationSchema.parse(rawInvocation)
    const manifest = await discover(registration)
    if ('code' in manifest) return { ok: false, failure: manifest }
    const url = expandInvocationPath(registration.internalBaseUrl, manifest.endpoints.invoke, invocation)
    let response: Response
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        ...(signal ? { signal } : {}),
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(invocation),
      })
    } catch (error) {
      return failure({ code: 'module_outcome_unknown', message: lostConnection(moduleId, 'check'), retryable: false,
        status: 504, details: { outcome: 'unknown', advice: 'Inspect the Resource before retrying this invocation.', ...transportCause(error) } })
    }
    if (!response.ok) {
      return await responseFailure(response, {
        code: 'capability_invocation_failed',
        message: `Module Capability invocation returned HTTP ${response.status}`,
      })
    }
    try {
      return { ok: true, value: moduleCapabilityInvocationResultSchema.parse(await response.json()) }
    } catch (error) {
      return failure({ code: 'module_contract_invalid', message: error instanceof Error ? error.message : String(error), retryable: false })
    }
  }

  return {
    list: () => registrations,
    has: moduleId => byId.has(moduleIdSchema.parse(moduleId)),
    provision: (moduleId, workspaceId) => operate(moduleId, workspaceId, 'PUT'),
    remove: (moduleId, workspaceId) => operate(moduleId, workspaceId, 'DELETE'),
    definitions: (moduleId, workspaceId) => readCollection({
      moduleId,
      endpoint: 'definitions',
      path: manifest => workspacePath(manifest.endpoints.definitions, workspaceId),
      parse: value => moduleDefinitionCollectionSchema.parse(value),
    }),
    resources: (moduleId, workspaceId) => readCollection({
      moduleId,
      endpoint: 'resources',
      path: manifest => workspacePath(manifest.endpoints.resources, workspaceId),
      parse: value => moduleResourceCollectionSchema.parse(value),
    }),
    capabilities: (moduleId, workspaceId) => readCollection({
      moduleId,
      endpoint: 'capabilities',
      path: manifest => workspacePath(manifest.endpoints.capabilities, workspaceId),
      parse: value => moduleCapabilityCollectionSchema.parse(value),
    }),
    featuredDefinitions: moduleId => readCollection({
      moduleId,
      endpoint: 'featuredDefinitions',
      path: manifest => manifest.endpoints.featuredDefinitions,
      parse: value => moduleFeaturedDefinitionCollectionSchema.parse(value),
    }),
    activity: moduleId => readCollection({
      moduleId,
      endpoint: 'activity',
      path: manifest => manifest.endpoints.activity,
      parse: value => moduleActivitySchema.parse(value),
    }),
    invoke,
  }
}
