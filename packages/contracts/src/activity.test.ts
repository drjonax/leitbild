import { describe, expect, test } from 'bun:test'
import { moduleActivitySchema, workspaceActivityCatalogSchema, workspaceModuleManifestSchema } from './index.ts'

const W1 = '0b6c1f8e-6c1d-4a39-9d36-2f7f0a0f5e11'
const W2 = '7d2a0c3e-1b5f-4f0a-8c6e-9a1b2c3d4e5f'
const running = { key: 'simulations-running', label: '2 simulations running', count: 2, active: true }

describe('Workspace activity', () => {
  test('a Module states short facts per Workspace and leaves quiet Workspaces out', () => {
    const activity = moduleActivitySchema.parse({ workspaces: [{ workspaceId: W1, items: [running, { key: 'simulations', label: '5 simulations', count: 5, active: false }] }] })
    expect(activity.workspaces[0]!.items.map(item => item.key)).toEqual(['simulations-running', 'simulations'])
    expect(moduleActivitySchema.parse({ workspaces: [] }).workspaces).toEqual([])
    expect(() => moduleActivitySchema.parse({ workspaces: [{ workspaceId: W1, items: [] }] })).toThrow()
  })

  test('refuses a repeated Workspace or key, a bad key and an empty label', () => {
    expect(() => moduleActivitySchema.parse({ workspaces: [{ workspaceId: W1, items: [running] }, { workspaceId: W1, items: [running] }] })).toThrow('duplicate Workspace')
    expect(() => moduleActivitySchema.parse({ workspaces: [{ workspaceId: W1, items: [running, running] }] })).toThrow('duplicate activity key')
    expect(() => moduleActivitySchema.parse({ workspaces: [{ workspaceId: W1, items: [{ ...running, key: 'Running_Now' }] }] })).toThrow()
    expect(() => moduleActivitySchema.parse({ workspaces: [{ workspaceId: W1, items: [{ ...running, label: ' ' }] }] })).toThrow()
    expect(() => moduleActivitySchema.parse({ workspaces: [{ workspaceId: W1, items: [{ ...running, count: -1 }] }] })).toThrow()
  })

  test('the Host catalogue names the Module of every fact and has one outcome per Module', () => {
    const catalog = workspaceActivityCatalogSchema.parse({
      modules: [{ moduleId: 'world', status: 'ready' }, { moduleId: 'agents', status: 'failed', failure: { code: 'module_unavailable', message: 'down', retryable: true } }],
      workspaces: [{ workspaceId: W2, items: [{ ...running, moduleId: 'world' }] }],
    })
    expect(String(catalog.workspaces[0]!.items[0]!.moduleId)).toBe('world')
    // The same item from another Module is another fact, not a repeat.
    expect(workspaceActivityCatalogSchema.parse({
      modules: [{ moduleId: 'world', status: 'ready' }, { moduleId: 'agents', status: 'ready' }],
      workspaces: [{ workspaceId: W2, items: [{ ...running, moduleId: 'world' }, { ...running, moduleId: 'agents' }] }],
    }).workspaces[0]!.items).toHaveLength(2)
  })

  test('the Host catalogue refuses what the featured catalogue refuses', () => {
    const ready = { moduleId: 'world', status: 'ready' }
    const item = { ...running, moduleId: 'world' }
    expect(() => workspaceActivityCatalogSchema.parse({ modules: [ready], workspaces: [{ workspaceId: W2, items: [running] }] })).toThrow('moduleId')
    expect(() => workspaceActivityCatalogSchema.parse({ modules: [ready, ready], workspaces: [] })).toThrow('duplicate Module outcome: world')
    expect(() => workspaceActivityCatalogSchema.parse({ modules: [], workspaces: [{ workspaceId: W2, items: [item] }] }))
      .toThrow('activity item has no ready Module outcome: world')
    expect(() => workspaceActivityCatalogSchema.parse({
      modules: [{ moduleId: 'world', status: 'failed', failure: { code: 'module_unavailable', message: 'down', retryable: true } }],
      workspaces: [{ workspaceId: W2, items: [item] }],
    })).toThrow('activity item has no ready Module outcome: world')
    expect(() => workspaceActivityCatalogSchema.parse({ modules: [ready], workspaces: [{ workspaceId: W2, items: [item, item] }] }))
      .toThrow('duplicate activity item: world:simulations-running')
    expect(() => workspaceActivityCatalogSchema.parse({ modules: [ready], workspaces: [{ workspaceId: W2, items: [item] }, { workspaceId: W2, items: [item] }] }))
      .toThrow('duplicate Workspace')
  })

  test('every Module declares a Workspace-independent activity path', () => {
    const endpoints = {
      workspace: '/internal/workspaces/{workspaceId}',
      definitions: '/internal/workspaces/{workspaceId}/definitions',
      resources: '/internal/workspaces/{workspaceId}/resources',
      capabilities: '/internal/workspaces/{workspaceId}/capabilities',
      invoke: '/internal/workspaces/{workspaceId}/capabilities/{capabilityId}/invoke',
      featuredDefinitions: '/internal/featured-definitions',
    }
    const manifest = (activity?: string) => ({ module: { id: 'world', title: 'World' }, endpoints: { ...endpoints, ...(activity === undefined ? {} : { activity }) } })
    expect(workspaceModuleManifestSchema.parse(manifest('/internal/activity')).endpoints.activity).toBe('/internal/activity')
    expect(() => workspaceModuleManifestSchema.parse(manifest())).toThrow()
    expect(() => workspaceModuleManifestSchema.parse(manifest('/internal/workspaces/{workspaceId}/activity'))).toThrow('must not contain a template')
  })
})
