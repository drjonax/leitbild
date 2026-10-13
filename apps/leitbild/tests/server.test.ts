import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  coreModuleIds,
  featuredDefinitionCatalogSchema,
  moduleDefinitionCollectionSchema,
  moduleFeaturedDefinitionCollectionSchema,
  moduleRegistrationSchema,
} from '@leitbild/contracts'
import { createWorkspaceHost } from '../src/host.ts'
import type { ModuleGateway } from '../src/module-gateway.ts'
import { createWorkspaceHostServer } from '../src/server.ts'
import { createWorkspaceStore, type WorkspaceStore } from '../src/store.ts'

const servers: Array<ReturnType<typeof createWorkspaceHostServer>> = []
const stores: WorkspaceStore[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
  for (const store of stores.splice(0)) store.close()
})

const gateway = (): ModuleGateway => ({
  list: () => coreModuleIds.map(moduleId => moduleRegistrationSchema.parse({
    moduleId, internalBaseUrl: `http://${moduleId}.internal`, manifestPath: '/manifest',
  })),
  has: moduleId => coreModuleIds.includes(moduleId),
  provision: async () => ({ ok: true, value: undefined }),
  remove: async () => ({ ok: true, value: undefined }),
  definitions: async (moduleId, workspaceId) => ({ ok: true, value: moduleDefinitionCollectionSchema.parse({ definitions: [
    moduleId === 'world' ? {
      ref: { workspaceId, moduleId, type: 'world.scenario', id: 'test-scenario' },
      title: 'Test Scenario', currentRevisionId: 'revision-0123456789abcdef0123456789abcdef',
      capabilityIds: ['world.scenario.start'],
    } : {
      ref: { workspaceId, moduleId, type: 'agents.room-definition', id: 'halden-integrated-control-room' },
      title: 'Halden Integrated Control Room', currentRevisionId: 'revision-0123456789abcdef0123456789abcdef',
      capabilityIds: ['agents.room-definition.start'],
    },
  ] }) }),
  resources: async () => ({ ok: true, value: { resources: [] } }),
  capabilities: async () => ({ ok: true, value: { capabilities: [] } }),
  invoke: async () => ({ ok: true, value: { result: null } }),
  featuredDefinitions: async moduleId => ({ ok: true, value: moduleFeaturedDefinitionCollectionSchema.parse({ definitions: moduleId === 'world' ? [{
    definition: { moduleId, type: 'world.scenario', id: 'test-scenario' },
    revisionId: 'revision-0123456789abcdef0123456789abcdef',
    title: 'Test Scenario',
    summary: 'A short test scenario.',
    about: 'A short test scenario that shows the featured catalogue.',
    tags: ['Test'],
    previews: [{ alt: 'Test map', width: 1600, height: 1000, sources: [{ path: '/assets/world/scenario-previews/test.webp', width: 1600 }] }],
  }] : [], listed: moduleId === 'world' ? [{
    definition: { moduleId, type: 'world.scenario', id: 'quiet-scenario' },
    revisionId: 'revision-fedcba9876543210fedcba9876543210',
    title: 'Quiet Scenario',
    summary: 'A test scenario where nothing is scripted.',
    tags: ['Test'],
  }] : [] }) }),
})

const startHost = (uiDistPath?: string, modules: ModuleGateway = gateway()) => {
  const store = createWorkspaceStore(':memory:')
  stores.push(store)
  const host = createWorkspaceHost({ store, modules })
  const server = createWorkspaceHostServer({ host, port: 0, bindHost: '127.0.0.1', ...(uiDistPath === undefined ? {} : { uiDistPath }) })
  servers.push(server)
  return { host, baseUrl: `http://127.0.0.1:${server.port}` }
}

describe('Leitbild server', () => {
  test('revalidates capability catalogs with an exact content ETag', async () => {
    const {host,baseUrl}=startHost()
    const workspace=await host.create({name:null})
    const url=`${baseUrl}/api/workspaces/${workspace.id}/capabilities`
    const first=await fetch(url)
    const etag=first.headers.get('etag')
    expect(first.status).toBe(200)
    expect(etag).toBeTruthy()
    const repeated=await fetch(url,{headers:{'If-None-Match':etag!}})
    expect(repeated.status).toBe(304)
    expect(await repeated.text()).toBe('')
    const stale=await fetch(url,{headers:{'If-None-Match':'"old-catalog"'}})
    expect(stale.status).toBe(200)
  })
  test('serves the featured and listed catalogue in one response without a Workspace and revalidates it by ETag', async () => {
    const { host, baseUrl } = startHost()
    const first = await fetch(`${baseUrl}/api/featured-definitions`)
    expect(first.status).toBe(200)
    const catalog = featuredDefinitionCatalogSchema.parse(await first.json())
    expect(catalog.modules.map(item => [String(item.moduleId), item.status])).toEqual([['world', 'ready'], ['agents', 'ready']])
    expect(catalog.definitions.map(item => String(item.definition.id))).toEqual(['test-scenario'])
    expect(catalog.listed.map(item => String(item.definition.id))).toEqual(['quiet-scenario'])
    expect(host.list()).toHaveLength(0)
    const etag = first.headers.get('etag')
    expect(etag).toBeTruthy()
    const repeated = await fetch(`${baseUrl}/api/featured-definitions`, { headers: { 'If-None-Match': etag! } })
    expect(repeated.status).toBe(304)
    expect(await repeated.text()).toBe('')
  })

  test('shows onboarding for zero Workspaces without implicit creation', async () => {
    const { host, baseUrl } = startHost()
    const response = await fetch(`${baseUrl}/`, { redirect: 'manual' })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/workspaces')
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(host.list()).toHaveLength(0)
  })

  test('opens the landing page from root even when exactly one Workspace exists', async () => {
    const { host, baseUrl } = startHost()
    await host.create({ name: null })
    const response = await fetch(`${baseUrl}/?guide=start`, { redirect: 'manual', headers: { Host: 'leitbild.ai' } })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/workspaces')
  })

  test('serves built images and fonts with their own content types', async () => {
    const uiDistPath = await mkdtemp(join(tmpdir(), 'leitbild-host-ui-'))
    try {
      await mkdir(join(uiDistPath, 'assets/host'), { recursive: true })
      const types = {
        'hero.webp': 'image/webp', 'hero.avif': 'image/avif', 'hero.jpg': 'image/jpeg', 'hero.jpeg': 'image/jpeg',
        'mark.svg': 'image/svg+xml', 'mark.png': 'image/png', 'text.woff2': 'font/woff2',
      }
      for (const file of Object.keys(types)) await writeFile(join(uiDistPath, 'assets/host', file), 'x')
      const { baseUrl } = startHost(uiDistPath)
      for (const [file, type] of Object.entries(types)) {
        const response = await fetch(`${baseUrl}/assets/host/${file}`)
        expect([file, response.headers.get('content-type')]).toEqual([file, type])
        expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
      }
    } finally { await rm(uiDistPath, { recursive: true, force: true }) }
  })

  test('supports create, rename, read, and complete delete', async () => {
    const { baseUrl } = startHost()
    const createdResponse = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    })
    expect(createdResponse.status).toBe(201)
    const created = (await createdResponse.json() as { workspace: { id: string; name: string | null; modules: unknown[] } }).workspace
    expect(created.name).toBeNull()
    expect(created.modules).toHaveLength(2)

    const renamedResponse = await fetch(`${baseUrl}/api/workspaces/${created.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Exercise Alpha' }),
    })
    expect((await renamedResponse.json() as { workspace: { name: string } }).workspace.name).toBe('Exercise Alpha')
    expect((await fetch(`${baseUrl}/api/workspaces/${created.id}`)).status).toBe(200)
    expect((await fetch(`${baseUrl}/api/workspaces/${created.id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await fetch(`${baseUrl}/api/workspaces/${created.id}`)).status).toBe(404)
  })

  test('does not expose user-controlled Module provisioning routes', async () => {
    const { host, baseUrl } = startHost()
    const workspace = await host.create({ name: null })
    expect((await fetch(`${baseUrl}/api/workspaces/${workspace.id}/modules/world`, { method: 'DELETE' })).status).toBe(404)
  })

  test('does not expose a retired Combined launcher', async () => {
    const { baseUrl } = startHost()
    expect((await fetch(`${baseUrl}/api/compositions`)).status).toBe(404)
  })

  test('answers a capability invocation that takes longer than Bun\'s 10 s idle limit', async () => {
    // Test-only gateway: a Module that answers after 12 s, as a run wait may.
    const { host, baseUrl } = startHost(undefined, { ...gateway(), invoke: async () => {
      await Bun.sleep(12_000)
      return { ok: true, value: { result: { reason: 'timeout' } } }
    } })
    const workspace = await host.create({ name: null })
    const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/capabilities/world.simulation-run.wait/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: {}, actor: { kind: 'ai', id: 'waiter' } }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ result: { reason: 'timeout' } })
  }, 60_000)

  // Bun's 10 s idle timeout does not cut off a server running inside bun test,
  // but does one in a process of its own, as the Host runs: so a child process.
  test('answers a Workspace delete whose Module removal takes longer than Bun\'s 10 s idle limit', async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures', 'slow-workspace-delete.ts')], { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' })
    try {
      const reader = child.stdout.getReader()
      let output = ''
      while (!/ready (\{.*\})/.test(output)) {
        const { value, done } = await reader.read()
        if (done) throw new Error(`Fixture exited before listening: ${output}`)
        output += new TextDecoder().decode(value)
      }
      const { port, workspaceId } = JSON.parse(/ready (\{.*\})/.exec(output)![1]!) as { port: number; workspaceId: string }
      const response = await fetch(`http://127.0.0.1:${port}/api/workspaces/${workspaceId}`, { method: 'DELETE' })
      expect(response.status).toBe(204)
      expect((await fetch(`http://127.0.0.1:${port}/api/workspaces/${workspaceId}`)).status).toBe(404)
    } finally { child.kill(); await child.exited }
  }, 60_000)
})
