import { describe, expect, test } from 'bun:test'
import {
  createWorkspaceInputSchema,
  coreModuleIds,
  featuredDefinitionCatalogSchema,
  moduleFeaturedDefinitionCollectionSchema,
  moduleFeaturedDefinitionSchema,
  moduleListedDefinitionSchema,
  moduleCapabilityDescriptorSchema,
  moduleCapabilityInvocationSchema,
  moduleDefinitionDescriptorSchema,
  moduleProvisioningStateSchema,
  moduleResourceDescriptorSchema,
  newWorkspaceId,
  workspaceRoomScopeSchema,
  workspaceModuleManifestSchema,
  workspaceSchema,
} from './index.ts'

const now = '2026-08-29T17:00:00.000Z'

describe('Workspace', () => {
  test('accepts an unnamed Workspace with no default Module set', () => {
    const workspace = workspaceSchema.parse({
      id: newWorkspaceId(),
      name: null,
      modules: [],
      createdAt: now,
      updatedAt: now,
    })
    expect(workspace.name).toBeNull()
    expect(workspace.modules).toEqual([])
  })

  test('keeps Module selection out of Workspace creation', () => {
    const input = createWorkspaceInputSchema.parse({ name: null })
    expect(input).toEqual({ name: null })
    expect(() => createWorkspaceInputSchema.parse({ moduleIds: ['world'] })).toThrow()
  })

  test('rejects duplicate Module provisioning state', () => {
    const state = { moduleId: 'world', status: 'ready', updatedAt: now }
    expect(() => workspaceSchema.parse({
      id: newWorkspaceId(),
      name: null,
      modules: [state, state],
      createdAt: now,
      updatedAt: now,
    })).toThrow('duplicate Module provisioning state')
  })

  test('requires a structured failure only for failed lifecycle states', () => {
    expect(() => moduleProvisioningStateSchema.parse({
      moduleId: 'world',
      status: 'provision_failed',
      updatedAt: now,
    })).toThrow('requires a failure')

    expect(() => moduleProvisioningStateSchema.parse({
      moduleId: 'world',
      status: 'ready',
      failure: { code: 'module_unavailable', message: 'offline', retryable: true },
      updatedAt: now,
    })).toThrow('cannot carry a failure')
  })
})

describe('Module contracts', () => {
  test('defines one fixed core Module set', () => {
    expect(coreModuleIds.map(String)).toEqual(['world', 'agents'])
  })

  test('requires relative Workspace-scoped endpoint templates', () => {
    const manifest = workspaceModuleManifestSchema.parse({
      module: { id: 'world', title: 'World' },
      endpoints: {
        workspace: '/internal/workspaces/{workspaceId}',
        definitions: '/internal/workspaces/{workspaceId}/definitions',
        resources: '/internal/workspaces/{workspaceId}/resources',
        capabilities: '/internal/workspaces/{workspaceId}/capabilities',
        invoke: '/internal/workspaces/{workspaceId}/capabilities/{capabilityId}/invoke',
        featuredDefinitions: '/internal/featured-definitions',
      },
    })
    expect(String(manifest.module.id)).toBe('world')

    expect(() => workspaceModuleManifestSchema.parse({
      ...manifest,
      endpoints: { ...manifest.endpoints, resources: 'https://module.test/resources' },
    })).toThrow()
  })

  test('requires a Workspace-independent featured Definitions path on every Module', () => {
    const endpoints = {
      workspace: '/internal/workspaces/{workspaceId}',
      definitions: '/internal/workspaces/{workspaceId}/definitions',
      resources: '/internal/workspaces/{workspaceId}/resources',
      capabilities: '/internal/workspaces/{workspaceId}/capabilities',
      invoke: '/internal/workspaces/{workspaceId}/capabilities/{capabilityId}/invoke',
    }
    const manifest = (featuredDefinitions?: string) => ({
      module: { id: 'agents', title: 'Agents' },
      endpoints: { ...endpoints, ...(featuredDefinitions === undefined ? {} : { featuredDefinitions }) },
    })
    expect(workspaceModuleManifestSchema.parse(manifest('/internal/featured-definitions')).endpoints.featuredDefinitions)
      .toBe('/internal/featured-definitions')
    expect(() => workspaceModuleManifestSchema.parse(manifest())).toThrow()
    expect(() => workspaceModuleManifestSchema.parse(manifest('/internal/workspaces/{workspaceId}/featured'))).toThrow('must not contain a template')
    expect(() => workspaceModuleManifestSchema.parse(manifest('https://module.test/featured'))).toThrow('origin')
  })
})

describe('featured Definitions', () => {
  const featured = {
    definition: { moduleId: 'world', type: 'world.scenario', id: 'halden-offsite-power-restoration' },
    revisionId: 'revision-0123456789abcdef0123456789abcdef',
    title: 'Halden: loss of offsite power',
    summary: 'Four simulated nuclear units lose their grid connection.',
    about: 'A fault cuts four fictional units off the grid; restore offsite power.',
    tags: ['Nuclear plant + grid', 'Desktop'],
    previews: [{
      alt: 'The grid map after the fault',
      width: 1600,
      height: 1000,
      sources: [
        { path: '/assets/world/scenario-previews/offsite-800.0a1b2c3d.webp', width: 800 },
        { path: '/assets/world/scenario-previews/offsite-1600.0a1b2c3d.webp', width: 1600 },
      ],
    }],
  }
  const withPreviewPath = (path: string) => ({
    ...featured,
    previews: [{ ...featured.previews[0]!, sources: [{ path, width: 800 }] }],
  })

  test('names a Definition and its exact revision without a Workspace', () => {
    const parsed = moduleFeaturedDefinitionSchema.parse(featured)
    expect(String(parsed.definition.id)).toBe('halden-offsite-power-restoration')
    expect(parsed).not.toHaveProperty('definition.workspaceId')
    expect(() => moduleFeaturedDefinitionSchema.parse({ ...featured, definition: { ...featured.definition, workspaceId: newWorkspaceId() } })).toThrow()
    expect(() => moduleFeaturedDefinitionSchema.parse({ ...featured, definition: { ...featured.definition, type: 'agents.room-definition' } }))
      .toThrow('namespaced by its owning Module')
  })

  test('bounds the copy and requires at least one preview and one tag', () => {
    expect(() => moduleFeaturedDefinitionSchema.parse({ ...featured, previews: [] })).toThrow()
    expect(() => moduleFeaturedDefinitionSchema.parse({ ...featured, tags: [] })).toThrow()
    expect(() => moduleFeaturedDefinitionSchema.parse({ ...featured, tags: ['a', 'b', 'c', 'd', 'e'] })).toThrow()
    expect(() => moduleFeaturedDefinitionSchema.parse({ ...featured, summary: 'x'.repeat(201) })).toThrow()
    expect(() => moduleFeaturedDefinitionSchema.parse({ ...featured, about: 'x'.repeat(1025) })).toThrow()
  })

  test('serves previews only from the featuring Module\'s own assets', () => {
    expect(() => moduleFeaturedDefinitionSchema.parse(withPreviewPath('/assets/agents/offsite.webp'))).toThrow('/assets/world/')
    expect(() => moduleFeaturedDefinitionSchema.parse(withPreviewPath('/assets/world/../agents/offsite.webp'))).toThrow('/assets/world/')
    expect(() => moduleFeaturedDefinitionSchema.parse(withPreviewPath('/assets/world/offsite.webp?v=1'))).toThrow('/assets/world/')
    expect(() => moduleFeaturedDefinitionSchema.parse(withPreviewPath('https://cdn.test/assets/world/offsite.webp'))).toThrow()
    expect(() => moduleFeaturedDefinitionSchema.parse({
      ...featured,
      previews: [{ ...featured.previews[0]!, sources: [featured.previews[0]!.sources[0]!, featured.previews[0]!.sources[0]!] }],
    })).toThrow('duplicate preview source width')
  })

  test('lists each featured Definition once, with a ready outcome for its Module', () => {
    expect(() => moduleFeaturedDefinitionCollectionSchema.parse({ definitions: [featured, featured], listed: [] })).toThrow('duplicate featured Definition')
    expect(featuredDefinitionCatalogSchema.parse({
      modules: [{ moduleId: 'world', status: 'ready' }, { moduleId: 'agents', status: 'ready' }],
      definitions: [featured],
      listed: [],
    }).definitions).toHaveLength(1)
    expect(() => featuredDefinitionCatalogSchema.parse({
      modules: [{ moduleId: 'world', status: 'failed', failure: { code: 'module_unavailable', message: 'offline', retryable: true } }],
      definitions: [featured],
      listed: [],
    })).toThrow('no ready Module outcome')
  })

  const listed = {
    definition: { moduleId: 'world', type: 'world.scenario', id: 'halden-normal-operation' },
    revisionId: 'revision-fedcba9876543210fedcba9876543210',
    title: 'Halden: normal operation',
    summary: 'Four simulated nuclear units run at full power; nothing is scripted.',
    tags: ['Nuclear plant + grid', 'No scripted faults'],
  }

  test('lists a Definition beside the featured ones with a short summary, one or two tags and no previews', () => {
    expect(moduleListedDefinitionSchema.parse(listed)).toEqual(listed as never)
    expect(() => moduleListedDefinitionSchema.parse({ ...listed, previews: featured.previews })).toThrow()
    expect(() => moduleListedDefinitionSchema.parse({ ...listed, about: featured.about })).toThrow()
    expect(() => moduleListedDefinitionSchema.parse({ ...listed, summary: 'x'.repeat(201) })).toThrow()
    expect(() => moduleListedDefinitionSchema.parse({ ...listed, summary: ' ' })).toThrow()
    expect(() => moduleListedDefinitionSchema.parse({ ...listed, tags: [] })).toThrow()
    expect(() => moduleListedDefinitionSchema.parse({ ...listed, tags: ['a', 'b', 'c'] })).toThrow()
    expect(() => moduleListedDefinitionSchema.parse({ ...listed, definition: { ...listed.definition, workspaceId: newWorkspaceId() } })).toThrow()
  })

  test('requires the listed collection, and keeps a Definition in one list once', () => {
    expect(moduleFeaturedDefinitionCollectionSchema.parse({ definitions: [featured], listed: [listed] }).listed).toHaveLength(1)
    expect(() => moduleFeaturedDefinitionCollectionSchema.parse({ definitions: [featured] })).toThrow()
    expect(() => moduleFeaturedDefinitionCollectionSchema.parse({ definitions: [], listed: [listed, listed] })).toThrow('duplicate listed Definition')
    const alsoFeatured = { ...listed, definition: featured.definition }
    expect(() => moduleFeaturedDefinitionCollectionSchema.parse({ definitions: [featured], listed: [alsoFeatured] })).toThrow('duplicate listed Definition')
    const ready = [{ moduleId: 'world', status: 'ready' }, { moduleId: 'agents', status: 'ready' }]
    expect(featuredDefinitionCatalogSchema.parse({ modules: ready, definitions: [featured], listed: [listed] }).listed).toHaveLength(1)
    expect(() => featuredDefinitionCatalogSchema.parse({ modules: ready, definitions: [featured] })).toThrow()
    expect(() => featuredDefinitionCatalogSchema.parse({ modules: ready, definitions: [featured], listed: [alsoFeatured] })).toThrow('duplicate listed Definition')
    expect(() => featuredDefinitionCatalogSchema.parse({
      modules: [{ moduleId: 'world', status: 'failed', failure: { code: 'module_unavailable', message: 'offline', retryable: true } }],
      definitions: [],
      listed: [listed],
    })).toThrow('listed Definition has no ready Module outcome')
  })
})

describe('dynamic Resource and Capability discovery', () => {
  test('keeps a mutable Definition identity separate from its immutable current revision', () => {
    const workspaceId = newWorkspaceId()
    const definition = moduleDefinitionDescriptorSchema.parse({
      ref: { workspaceId, moduleId: 'world', type: 'world.scenario', id: 'halden' },
      title: 'Halden',
      currentRevisionId: 'revision-0123456789abcdef0123456789abcdef',
      capabilityIds: ['world.scenario.start'],
    })
    expect(String(definition.ref.id)).toBe('halden')
    expect(String(definition.currentRevisionId)).toBe('revision-0123456789abcdef0123456789abcdef')
  })

  test('requires Module-owned namespaces', () => {
    const workspaceId = newWorkspaceId()
    const resource = moduleResourceDescriptorSchema.parse({
      ref: {
        workspaceId,
        moduleId: 'world',
        type: 'world.simulation-run',
        id: 'run-01',
      },
      title: 'Run 01',
      capabilityIds: ['world.simulation-run.read'],
      observedAt: now,
    })
    expect(String(resource.ref.id)).toBe('run-01')

    expect(() => moduleResourceDescriptorSchema.parse({
      ...resource,
      capabilityIds: ['agents.simulation-run.read'],
    })).toThrow('Resource Capability must be owned')
  })

  test('publishes agent-usable semantics without a concrete Resource binding', () => {
    const capability = moduleCapabilityDescriptorSchema.parse({
      id: 'world.ambulance.set-destination',
      moduleId: 'world',
      kind: 'command',
      scope: { kind: 'resource', resourceType: 'world.simulation-run' },
      title: 'Set ambulance destination',
      description: 'Sets one ambulance destination in a selected Simulation Run.',
      risk: 'write',
      idempotent: true,
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
    })
    expect(capability.scope.kind).toBe('resource')
    if (capability.scope.kind === 'resource') {
      expect(String(capability.scope.resourceType)).toBe('world.simulation-run')
    }
    expect(capability).not.toHaveProperty('resourceId')
  })

  test('keeps the selected Resource in each invocation instead of Agent configuration', () => {
    const workspaceId = newWorkspaceId()
    const invocation = moduleCapabilityInvocationSchema.parse({
      workspaceId,
      capabilityId: 'world.simulation-run.read',
      resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-01' },
      input: {},
      access: {
        workspaceId,
        requestId: crypto.randomUUID(),
        actor: { kind: 'ai', id: 'agent:operator' },
      },
    })
    expect(String(invocation.resource?.id)).toBe('run-01')
  })

  test('targets either an exact Definition Revision or a Resource, never both', () => {
    const workspaceId = newWorkspaceId()
    const base = {
      workspaceId,
      capabilityId: 'world.scenario.start',
      definition: {
        workspaceId,
        moduleId: 'world',
        type: 'world.scenario',
        id: 'halden',
        revisionId: 'revision-0123456789abcdef0123456789abcdef',
      },
      input: {},
      access: {
        workspaceId,
        requestId: crypto.randomUUID(),
        actor: { kind: 'ai' as const, id: 'agent:operator' },
      },
    }
    expect(String(moduleCapabilityInvocationSchema.parse(base).definition?.id)).toBe('halden')
    expect(() => moduleCapabilityInvocationSchema.parse({
      ...base,
      resource: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-1' },
    })).toThrow('cannot target both')
  })

  test('uses one explicit Room Scope instead of per-Capability grants', () => {
    const workspaceId = newWorkspaceId()
    expect(workspaceRoomScopeSchema.parse({ kind: 'workspace' })).toEqual({ kind: 'workspace' })
    const collection = {
      workspaceId,
      moduleId: 'world',
      type: 'world.run-family',
      id: 'family-01',
    }
    const resource = {
      workspaceId,
      moduleId: 'world',
      type: 'world.simulation-run',
      id: 'run-01',
    }
    expect(workspaceRoomScopeSchema.parse({
      kind: 'collection',
      collection,
      members: { mode: 'all', except: [resource] },
    }).kind).toBe('collection')
    expect(() => workspaceRoomScopeSchema.parse({
      kind: 'collection',
      collection,
      members: { mode: 'selected', only: [resource, resource] },
    })).toThrow('duplicate Resource reference')
  })
})
