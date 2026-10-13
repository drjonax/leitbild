import {
  capabilityIdSchema,
  coreModuleIds,
  createWorkspaceInputSchema,
  featuredDefinitionCatalogSchema,
  moduleIdSchema,
  moduleProvisioningStateSchema,
  renameWorkspaceInputSchema,
  workspaceCapabilityCatalogSchema,
  workspaceDefinitionCatalogSchema,
  workspaceDefinitionRevisionReferenceSchema,
  workspaceActivityCatalogSchema,
  workspaceIdSchema,
  workspaceResourceCatalogSchema,
  workspaceResourceReferenceSchema,
  type AccessContext,
  type CapabilityId,
  type CreateWorkspaceInput,
  type FeaturedDefinitionCatalog,
  type InvokeCapabilityInput,
  type ModuleId,
  type ModuleProvisioningState,
  type RenameWorkspaceInput,
  type Workspace,
  type WorkspaceActivityCatalog,
  type WorkspaceActivityEntry,
  type WorkspaceCapabilityCatalog,
  type WorkspaceDefinitionCatalog,
  type WorkspaceId,
  type WorkspaceResourceCatalog,
} from '@leitbild/contracts'
import { hostError } from './errors.ts'
import type { ModuleGateway, ModuleOperationResult } from './module-gateway.ts'
import type { WorkspaceStore } from './store.ts'

export interface WorkspaceHost {
  readonly list: () => ReadonlyArray<Workspace>
  readonly get: (id: WorkspaceId) => Workspace | undefined
  readonly create: (input: CreateWorkspaceInput) => Promise<Workspace>
  readonly rename: (id: WorkspaceId, input: RenameWorkspaceInput) => Workspace
  readonly delete: (id: WorkspaceId) => Promise<void>
  readonly retryModule: (id: WorkspaceId, moduleId: ModuleId) => Promise<Workspace>
  readonly definitions: (id: WorkspaceId, moduleId?: ModuleId) => Promise<WorkspaceDefinitionCatalog>
  readonly resources: (id: WorkspaceId, moduleId?: ModuleId) => Promise<WorkspaceResourceCatalog>
  readonly capabilities: (id: WorkspaceId, moduleId?: ModuleId) => Promise<WorkspaceCapabilityCatalog>
  /** Every installed Module's featured and listed Definitions, with one outcome per Module; no Workspace involved. */
  readonly featuredDefinitions: () => Promise<FeaturedDefinitionCatalog>
  /**
   * What every installed Module states is going on in each Workspace the Host
   * knows, with one outcome per Module; the Host shows it without reading it.
   */
  readonly activity: () => Promise<WorkspaceActivityCatalog>
  readonly invoke: (id: WorkspaceId, capabilityId: CapabilityId, input: InvokeCapabilityInput, access: AccessContext, signal?: AbortSignal) => Promise<import('@leitbild/contracts').ModuleCapabilityInvocationResult>
  readonly installedModuleIds: () => ReadonlyArray<ModuleId>
}

const provisioningState = (
  moduleId: ModuleId,
  status: ModuleProvisioningState['status'],
  result?: ModuleOperationResult,
): ModuleProvisioningState => moduleProvisioningStateSchema.parse({
  moduleId,
  status,
  ...(result?.ok === false ? { failure: result.failure } : {}),
  updatedAt: new Date().toISOString(),
})

export const createWorkspaceHost = (config: {
  readonly store: WorkspaceStore
  readonly modules: ModuleGateway
}): WorkspaceHost => {
  const installedModuleIds = config.modules.list().map(registration => registration.moduleId)
  for (const moduleId of coreModuleIds) {
    if (!config.modules.has(moduleId)) throw new Error(`Core Module is not installed: ${moduleId}`)
  }

  const requireWorkspace = (id: WorkspaceId): Workspace => {
    const workspace = config.store.get(id)
    if (!workspace) throw hostError({ status: 404, code: 'workspace_not_found', message: 'Workspace not found' })
    return workspace
  }

  const requireInstalledModule = (moduleId: ModuleId): void => {
    if (!config.modules.has(moduleId)) {
      throw hostError({ status: 404, code: 'module_not_installed', message: `Module is not installed: ${moduleId}` })
    }
  }

  const provision = async (workspaceId: WorkspaceId, moduleId: ModuleId): Promise<Workspace> => {
    const result = await config.modules.provision(moduleId, workspaceId)
    return config.store.setModuleState(
      workspaceId,
      provisioningState(moduleId, result.ok ? 'ready' : 'provision_failed', result),
    )!
  }

  // A Module holding work for a Workspace the Host does not know is an orphan: it is
  // left out of the answer, and said once per Module and Workspace so it can be found.
  const reportedOrphans = new Set<string>()
  const reportOrphan = (moduleId: ModuleId, workspaceId: WorkspaceId): void => {
    const key = `${moduleId}:${workspaceId}`
    if (reportedOrphans.has(key)) return
    reportedOrphans.add(key)
    console.warn(`Module ${moduleId} reports activity for a Workspace the Host does not know: ${workspaceId}`)
  }

  const unavailableModuleFailure = (item: ModuleProvisioningState) => item.failure ?? {
    code: 'module_not_ready',
    message: `Module lifecycle is ${item.status}`,
    retryable: item.status === 'provisioning' || item.status === 'removing',
  }

  const invokeCapability = async (
    rawId: WorkspaceId,
    rawCapabilityId: CapabilityId,
    rawInput: InvokeCapabilityInput,
    access: AccessContext,
    signal?: AbortSignal,
  ): Promise<import('@leitbild/contracts').ModuleCapabilityInvocationResult> => {
    const id = workspaceIdSchema.parse(rawId)
    const capabilityId = capabilityIdSchema.parse(rawCapabilityId)
    const workspace = requireWorkspace(id)
    const separator = capabilityId.indexOf('.')
    const moduleId = moduleIdSchema.parse(capabilityId.slice(0, separator))
    const active = workspace.modules.find(item => item.moduleId === moduleId)
    if (!active || active.status !== 'ready') {
      throw hostError({ status: 409, code: 'module_not_ready', message: `Capability Module is not ready in this Workspace: ${moduleId}` })
    }
    const resource = rawInput.resource === undefined ? undefined : workspaceResourceReferenceSchema.parse(rawInput.resource)
    const definition = rawInput.definition === undefined ? undefined : workspaceDefinitionRevisionReferenceSchema.parse(rawInput.definition)
    if (resource !== undefined && (resource.workspaceId !== id || resource.moduleId !== moduleId)) {
      throw hostError({ status: 400, code: 'resource_scope_mismatch', message: 'Selected Resource does not belong to the Capability Module and Workspace' })
    }
    if (definition !== undefined && (definition.workspaceId !== id || definition.moduleId !== moduleId)) {
      throw hostError({ status: 400, code: 'definition_scope_mismatch', message: 'Selected Definition does not belong to the Capability Module and Workspace' })
    }
    const result = await config.modules.invoke(moduleId, {
      workspaceId: id,
      capabilityId,
      ...(definition === undefined ? {} : { definition }),
      ...(resource === undefined ? {} : { resource }),
      ...(rawInput.expectedRevision === undefined ? {} : { expectedRevision: rawInput.expectedRevision }),
      ...(rawInput.idempotencyKey === undefined ? {} : { idempotencyKey: rawInput.idempotencyKey }),
      input: rawInput.input,
      access,
    }, signal)
    if (!result.ok) {
      throw hostError({
        status: result.failure.status ?? 502,
        code: result.failure.code,
        message: result.failure.message,
        retryable: result.failure.retryable,
        details: { ...result.failure.details, moduleId, capabilityId },
      })
    }
    return result.value
  }

  return {
    list: config.store.list,
    get: config.store.get,
    create: async rawInput => {
      const input = createWorkspaceInputSchema.parse(rawInput)
      const workspace = config.store.create({ name: input.name ?? null, moduleIds: installedModuleIds })
      await Promise.all(installedModuleIds.map(moduleId => provision(workspace.id, moduleId)))
      return requireWorkspace(workspace.id)
    },
    rename: (rawId, rawInput) => {
      const id = workspaceIdSchema.parse(rawId)
      requireWorkspace(id)
      const input = renameWorkspaceInputSchema.parse(rawInput)
      return config.store.rename(id, input.name)!
    },
    delete: async rawId => {
      const id = workspaceIdSchema.parse(rawId)
      const workspace = requireWorkspace(id)
      for (const item of workspace.modules) {
        config.store.setModuleState(id, provisioningState(item.moduleId, 'removing'))
      }
      const results = await Promise.all(workspace.modules.map(async item => ({
        moduleId: item.moduleId,
        result: await config.modules.remove(item.moduleId, id),
      })))
      const failures = results.filter(item => !item.result.ok)
      if (failures.length > 0) {
        for (const item of failures) {
          if (!item.result.ok) config.store.setModuleState(id, provisioningState(item.moduleId, 'remove_failed', item.result))
        }
        throw hostError({
          status: 502,
          code: 'workspace_delete_incomplete',
          message: 'One or more Modules could not remove their Workspace state',
          retryable: failures.some(item => !item.result.ok && item.result.failure.retryable),
          details: { moduleIds: failures.map(item => item.moduleId) },
        })
      }
      config.store.delete(id)
    },
    retryModule: async (rawId, rawModuleId) => {
      const id = workspaceIdSchema.parse(rawId)
      const moduleId = moduleIdSchema.parse(rawModuleId)
      const workspace = requireWorkspace(id)
      const existing = workspace.modules.find(item => item.moduleId === moduleId)
      if (!existing) {
        throw hostError({ status: 404, code: 'module_state_not_found', message: `Module does not belong to Workspace: ${moduleId}` })
      }
      if (existing.status === 'provision_failed') {
        config.store.setModuleState(id, provisioningState(moduleId, 'provisioning'))
        return await provision(id, moduleId)
      }
      throw hostError({ status: 409, code: 'module_not_retryable', message: `Module lifecycle is not failed: ${moduleId}` })
    },
    definitions: async (rawId, requestedModuleId) => {
      const id = workspaceIdSchema.parse(rawId)
      const workspace = requireWorkspace(id)
      const moduleId = requestedModuleId === undefined ? undefined : moduleIdSchema.parse(requestedModuleId)
      if (moduleId !== undefined) requireInstalledModule(moduleId)
      const modules = moduleId === undefined ? workspace.modules : workspace.modules.filter(item => item.moduleId === moduleId)
      const results = await Promise.all(modules.map(async item => {
        if (item.status !== 'ready') {
          return { moduleId: item.moduleId, result: { ok: false as const, failure: unavailableModuleFailure(item) } }
        }
        return { moduleId: item.moduleId, result: await config.modules.definitions(item.moduleId, id) }
      }))
      const outcomes = results.map(item => item.result.ok
        ? { moduleId: item.moduleId, status: 'ready' as const }
        : { moduleId: item.moduleId, status: 'failed' as const, failure: item.result.failure })
      const definitions = results.flatMap(item => {
        if (!item.result.ok) return []
        const invalid = item.result.value.definitions.find(definition =>
          definition.ref.workspaceId !== id || definition.ref.moduleId !== item.moduleId)
        if (invalid) {
          throw hostError({
            status: 502,
            code: 'module_contract_invalid',
            message: `Module ${item.moduleId} returned a Definition outside its ownership`,
          })
        }
        return item.result.value.definitions
      })
      return workspaceDefinitionCatalogSchema.parse({ workspaceId: id, modules: outcomes, definitions })
    },
    resources: async (rawId, requestedModuleId) => {
      const id = workspaceIdSchema.parse(rawId)
      const workspace = requireWorkspace(id)
      const moduleId = requestedModuleId === undefined ? undefined : moduleIdSchema.parse(requestedModuleId)
      if (moduleId !== undefined) requireInstalledModule(moduleId)
      const modules = moduleId === undefined ? workspace.modules : workspace.modules.filter(item => item.moduleId === moduleId)
      const results = await Promise.all(modules.map(async item => {
        if (item.status !== 'ready') {
          return { moduleId: item.moduleId, result: { ok: false as const, failure: unavailableModuleFailure(item) } }
        }
        return { moduleId: item.moduleId, result: await config.modules.resources(item.moduleId, id) }
      }))
      const outcomes = results.map(item => item.result.ok
        ? { moduleId: item.moduleId, status: 'ready' as const }
        : { moduleId: item.moduleId, status: 'failed' as const, failure: item.result.failure })
      const resources = results.flatMap(item => {
        if (!item.result.ok) return []
        const invalid = item.result.value.resources.find(resource =>
          resource.ref.workspaceId !== id || resource.ref.moduleId !== item.moduleId)
        if (invalid) {
          throw hostError({
            status: 502,
            code: 'module_contract_invalid',
            message: `Module ${item.moduleId} returned a Resource outside its ownership`,
          })
        }
        return item.result.value.resources
      })
      return workspaceResourceCatalogSchema.parse({ workspaceId: id, modules: outcomes, resources })
    },
    capabilities: async (rawId, requestedModuleId) => {
      const id = workspaceIdSchema.parse(rawId)
      const workspace = requireWorkspace(id)
      const moduleId = requestedModuleId === undefined ? undefined : moduleIdSchema.parse(requestedModuleId)
      if (moduleId !== undefined) requireInstalledModule(moduleId)
      const modules = moduleId === undefined ? workspace.modules : workspace.modules.filter(item => item.moduleId === moduleId)
      const results = await Promise.all(modules.map(async item => {
        if (item.status !== 'ready') {
          return { moduleId: item.moduleId, result: { ok: false as const, failure: unavailableModuleFailure(item) } }
        }
        return { moduleId: item.moduleId, result: await config.modules.capabilities(item.moduleId, id) }
      }))
      const outcomes = results.map(item => item.result.ok
        ? { moduleId: item.moduleId, status: 'ready' as const }
        : { moduleId: item.moduleId, status: 'failed' as const, failure: item.result.failure })
      const capabilities = results.flatMap(item => {
        if (!item.result.ok) return []
        const invalid = item.result.value.capabilities.find(capability => capability.moduleId !== item.moduleId)
        if (invalid) {
          throw hostError({
            status: 502,
            code: 'module_contract_invalid',
            message: `Module ${item.moduleId} returned a Capability outside its ownership`,
          })
        }
        return item.result.value.capabilities
      })
      return workspaceCapabilityCatalogSchema.parse({ workspaceId: id, modules: outcomes, capabilities })
    },
    featuredDefinitions: async () => {
      const results = await Promise.all(installedModuleIds.map(async moduleId => {
        const result = await config.modules.featuredDefinitions(moduleId)
        // A Module may feature and list only its own Definitions; the contract
        // already keeps each preview inside its Definition Module's /assets/<moduleId>/.
        const foreignIn = (verb: string, list: ReadonlyArray<{ readonly definition: { readonly moduleId: string } }>) => {
          const item = list.find(candidate => candidate.definition.moduleId !== moduleId)
          return item === undefined ? undefined : `Module ${moduleId} ${verb} a Definition owned by ${item.definition.moduleId}`
        }
        const foreign = result.ok ? foreignIn('featured', result.value.definitions) ?? foreignIn('listed', result.value.listed) : undefined
        return foreign === undefined ? { moduleId, result } : {
          moduleId,
          result: { ok: false as const, failure: { code: 'module_contract_invalid', message: foreign, retryable: false } },
        }
      }))
      return featuredDefinitionCatalogSchema.parse({
        modules: results.map(item => item.result.ok
          ? { moduleId: item.moduleId, status: 'ready' as const }
          : { moduleId: item.moduleId, status: 'failed' as const, failure: item.result.failure }),
        definitions: results.flatMap(item => item.result.ok ? item.result.value.definitions : []),
        listed: results.flatMap(item => item.result.ok ? item.result.value.listed : []),
      })
    },
    activity: async () => {
      const results = await Promise.all(installedModuleIds.map(async moduleId => ({ moduleId, result: await config.modules.activity(moduleId) })))
      // Read after the Modules answered: a Workspace deleted meanwhile is gone,
      // and an id the Host does not know is not a Workspace, whatever a Module holds.
      const entries = new Map(config.store.list().map(workspace => [workspace.id, [] as WorkspaceActivityEntry[]]))
      for (const { moduleId, result } of results) {
        if (!result.ok) continue
        for (const workspace of result.value.workspaces) {
          const known = entries.get(workspace.workspaceId)
          if (known) known.push(...workspace.items.map(item => ({ moduleId, ...item })))
          else reportOrphan(moduleId, workspace.workspaceId)
        }
      }
      return workspaceActivityCatalogSchema.parse({
        modules: results.map(item => item.result.ok
          ? { moduleId: item.moduleId, status: 'ready' as const }
          : { moduleId: item.moduleId, status: 'failed' as const, failure: item.result.failure }),
        workspaces: [...entries].filter(([, items]) => items.length > 0).map(([workspaceId, items]) => ({ workspaceId, items })),
      })
    },
    invoke: invokeCapability,
    installedModuleIds: () => config.modules.list().map(registration => registration.moduleId),
  }
}
