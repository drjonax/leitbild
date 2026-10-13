import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { moduleRegistrationSchema, workspaceIdSchema, workspaceSchema } from '@leitbild/contracts'
import { createServer as createWorldServer } from '../../../apps/world/src/core/api/server.ts'
import { createWorldModuleState } from '../../../apps/world/src/core/workspaces/module-state.ts'
import { createWorldWorkspaceRuntimeRegistry } from '../../../apps/world/src/core/workspaces/runtime-registry.ts'
import { createWorldApplicationAssembly } from '../../../apps/world/src/app-assembly.ts'
import { scenarioAuthoringCatalogFor } from '../../../apps/world/src/core/scenarios/authoring.ts'
import { compileScenarioDefinition } from '../../../apps/world/src/core/scenarios/compiler.ts'
import { createScenarioRuntimeResolver } from '../../../apps/world/src/core/scenarios/runtime-resolver.ts'
import { createDirectRoutingAdapter } from '../../../apps/world/src/routing/direct-adapter.ts'
import { builtinScenarioDefinitions } from '../../../apps/world/src/scenarios/definitions.ts'
import { builtinFeaturedScenarioDefinitions } from '../../../apps/world/src/scenarios/featured.ts'
import { handleAgentsModuleApi } from '../../../apps/agents/src/api/workspace-module-api.ts'
import { CAPABILITY_INVOKE_IDLE_SECONDS, isCapabilityInvokeRequest } from '../../../apps/agents/src/api/capability-invoke-timeout.ts'
import { createDeploymentRuntime } from '../../../apps/agents/src/core/deployment-runtime.ts'
import { workspaceModulePaths } from '../../../apps/agents/src/core/paths.ts'
import { createAgentsModuleState } from '../../../apps/agents/src/core/workspaces/module-state.ts'
import { createWorkspaceRuntimeRegistry as createAgentsWorkspaceRuntimeRegistry } from '../../../apps/agents/src/core/workspaces/runtime-registry.ts'
import { createWorkspaceHost } from '../../../apps/leitbild/src/host.ts'
import { createModuleGateway } from '../../../apps/leitbild/src/module-gateway.ts'
import { createWorkspaceHostServer } from '../../../apps/leitbild/src/server.ts'
import { createWorkspaceStore } from '../../../apps/leitbild/src/store.ts'

interface Person { readonly id: string; readonly name: string }
interface Message { readonly seq: number; readonly id: string; readonly from: string; readonly to: string; readonly text: string; readonly sentAt: string }
interface SyncResult {
  readonly storeId: string
  readonly presenceWarming: boolean
  readonly me: Person
  readonly present: ReadonlyArray<Person>
  readonly conversations: ReadonlyArray<{ readonly with: Person; readonly here: boolean; readonly unread: number }>
  readonly messages: ReadonlyArray<Message>
  readonly cursor: number
  readonly view: string
}

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const operation of cleanup.splice(0).reverse()) await operation()
})

/** The real Host in front of the real World and Agents Modules, as production composes them. */
const startPlatform = async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'people-chat-world-'))
  const agentsHome = await mkdtemp(join(tmpdir(), 'people-chat-agents-'))
  const originalHome = process.env.LEITBILD_HOME
  const originalProvider = process.env.PROVIDER
  process.env.LEITBILD_HOME = agentsHome
  process.env.PROVIDER = 'ollama'
  cleanup.push(async () => {
    if (originalHome === undefined) delete process.env.LEITBILD_HOME
    else process.env.LEITBILD_HOME = originalHome
    if (originalProvider === undefined) delete process.env.PROVIDER
    else process.env.PROVIDER = originalProvider
    await rm(agentsHome, { recursive: true, force: true })
    await rm(dataDir, { recursive: true, force: true })
  })

  const routing = createDirectRoutingAdapter()
  const worldAssembly = createWorldApplicationAssembly({ routing })
  const worldRegistry = createWorldWorkspaceRuntimeRegistry({
    dataDir,
    moduleState: createWorldModuleState({ dataDir }),
    scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: worldAssembly.packs }),
    scenarioDefinitions: builtinScenarioDefinitions,
    compileScenarioDefinition: source => compileScenarioDefinition(source, worldAssembly.packs, { routing }),
    scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(worldAssembly.packs),
    runtimeAdapters: worldAssembly.runtimeAdapters,
  })
  cleanup.push(() => worldRegistry.shutdown())
  const worldServer = createWorldServer({
    workspaces: worldRegistry,
    featuredDefinitions: builtinFeaturedScenarioDefinitions,
    bindHost: '127.0.0.1',
    port: 0,
    uiDistPath: dataDir,
    mapArtifacts: { rootDir: join(dataDir, 'maps') },
  })
  cleanup.push(() => worldServer.stop())

  const agentsState = createAgentsModuleState()
  const agentsRegistry = createAgentsWorkspaceRuntimeRegistry({ deployment: createDeploymentRuntime(), moduleState: agentsState, idleMs: 1_000_000 })
  cleanup.push(() => agentsRegistry.shutdown())
  // The Agents server's own idle rule for Capability invocations, as src/api/server.ts applies it.
  const agentsServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url)
      if (isCapabilityInvokeRequest(request, url)) server.timeout(request, CAPABILITY_INVOKE_IDLE_SECONDS)
      return await handleAgentsModuleApi(request, url, { state: agentsState, registry: agentsRegistry })
        ?? new Response('Not found', { status: 404 })
    },
  })
  cleanup.push(() => agentsServer.stop(true))

  const store = createWorkspaceStore(':memory:')
  cleanup.push(() => store.close())
  const host = createWorkspaceHost({
    store,
    modules: createModuleGateway({
      registrations: [
        moduleRegistrationSchema.parse({ moduleId: 'world', internalBaseUrl: `http://127.0.0.1:${worldServer.port}`, manifestPath: '/.well-known/workspace-module' }),
        moduleRegistrationSchema.parse({ moduleId: 'agents', internalBaseUrl: `http://127.0.0.1:${agentsServer.port}`, manifestPath: '/.well-known/workspace-module' }),
      ],
    }),
  })
  const hostServer = createWorkspaceHostServer({ host, bindHost: '127.0.0.1', port: 0 })
  cleanup.push(() => hostServer.stop(true))
  const baseUrl = `http://127.0.0.1:${hostServer.port}`

  const created = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'People Lab' }),
  })
  expect(created.status).toBe(201)
  const workspace = workspaceSchema.parse((await created.json() as { workspace: unknown }).workspace)
  const workspaceId = workspaceIdSchema.parse(workspace.id)

  // What the Host UI sends: a Workspace-scoped invocation by a human, the token in the input.
  const invoke = async (
    capabilityId: string,
    input: Record<string, unknown>,
    options: { readonly actor?: { readonly kind: string }; readonly idempotencyKey?: string; readonly signal?: AbortSignal } = {},
  ): Promise<{ readonly status: number; readonly body: { readonly result?: unknown; readonly error?: { readonly code: string } } }> => {
    const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/capabilities/${capabilityId}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input,
        actor: options.actor ?? { kind: 'human' },
        ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
      }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    return { status: response.status, body: await response.json() as { result?: unknown; error?: { code: string } } }
  }
  const run = { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-people-lab' }
  const joinPerson = async (): Promise<{ readonly token: string; readonly me: Person }> => {
    const joined = await invoke('agents.people.join', {})
    // The Host answers every completed invocation with 200; the Module's 201 stays internal.
    expect(joined.status).toBe(200)
    return joined.body.result as { token: string; me: Person }
  }
  const sync = async (token: string, screen: string, extra: Record<string, unknown> = {}): Promise<SyncResult> => {
    const synced = await invoke('agents.people.sync', { token, screen, viewing: run, waitMs: 0, ...extra })
    expect(synced.status).toBe(200)
    return synced.body.result as SyncResult
  }
  return { baseUrl, workspaceId, agentsRegistry, run, invoke, joinPerson, sync }
}

describe('People and direct chat through the Host', () => {
  test('two people see each other on a Run, chat without duplicates, and never wake the Agents runtime', async () => {
    const platform = await startPlatform()
    const { invoke, joinPerson, sync, workspaceId, agentsRegistry, run } = platform

    const catalog = await (await fetch(`${platform.baseUrl}/api/workspaces/${workspaceId}/capabilities?moduleId=agents`)).json() as { capabilities: Array<{ id: string }> }
    expect(catalog.capabilities.map(capability => capability.id)).toEqual(expect.arrayContaining([
      'agents.people.join', 'agents.people.sync', 'agents.people.rename', 'agents.people.conversation.read',
      'agents.people.conversation.mark-read', 'agents.people.message.send', 'agents.people.leave',
    ]))

    // An AI actor is never a Person.
    expect((await invoke('agents.people.join', {}, { actor: { kind: 'ai' } })).body.error?.code).toBe('people_human_required')

    const anna = await joinPerson()
    const ben = await joinPerson()
    expect([anna.me.name, ben.me.name]).toEqual(['User1', 'User2'])
    const annaScreen = crypto.randomUUID()
    const benScreen = crypto.randomUUID()
    await sync(ben.token, benScreen)
    const annaFirst = await sync(anna.token, annaScreen)
    expect(annaFirst.present.map(person => person.name)).toEqual(['User2'])

    // Anna waits; Ben's message answers her pending sync at once.
    const started = performance.now()
    const pending = invoke('agents.people.sync', {
      token: anna.token, screen: annaScreen, viewing: run, waitMs: 20_000,
      after: annaFirst.cursor, storeId: annaFirst.storeId, view: annaFirst.view,
    })
    await Bun.sleep(150)
    const sent = await invoke('agents.people.message.send', { token: ben.token, to: anna.me.id, text: 'Pressuriser level?' }, { idempotencyKey: 'ben-key-1' })
    expect(sent.status).toBe(200)
    expect((sent.body.result as { replayed: boolean }).replayed).toBe(false)
    const woken = await pending
    expect(performance.now() - started).toBeLessThan(2_000)
    const wokenResult = woken.body.result as SyncResult
    expect(wokenResult.messages.map(message => message.text)).toEqual(['Pressuriser level?'])
    expect(wokenResult.conversations.find(conversation => conversation.with.id === ben.me.id)?.unread).toBe(1)

    // A retry with the same key returns the same message instead of a second one.
    const retried = await invoke('agents.people.message.send', { token: ben.token, to: anna.me.id, text: 'Pressuriser level?' }, { idempotencyKey: 'ben-key-1' })
    expect(retried.status).toBe(200)
    const sentMessage = (sent.body.result as { message: Message }).message
    expect(retried.body.result).toEqual({ message: sentMessage, replayed: true })
    const conversation = await invoke('agents.people.conversation.read', { token: anna.token, with: ben.me.id })
    expect((conversation.body.result as { messages: Message[] }).messages.map(message => message.id)).toEqual([sentMessage.id])

    // Reading clears the unread count; a rename reaches the other person's next sync.
    await invoke('agents.people.conversation.mark-read', { token: anna.token, with: ben.me.id, through: sentMessage.seq })
    expect((await invoke('agents.people.rename', { token: ben.token, name: 'Ben' })).status).toBe(200)
    const afterRename = await sync(anna.token, annaScreen, { after: wokenResult.cursor, storeId: wokenResult.storeId })
    expect(afterRename.present.map(person => person.name)).toEqual(['Ben'])
    expect(afterRename.conversations.find(entry => entry.with.id === ben.me.id)?.unread).toBe(0)

    // A token is no identity in another Workspace's sense: an invented one is refused.
    expect((await invoke('agents.people.sync', { token: 'not-a-token', screen: annaScreen, viewing: run, waitMs: 0 })).body.error?.code).toBe('person_token_invalid')

    // Leaving takes Ben out of the Run at once.
    expect((await invoke('agents.people.leave', { token: ben.token, screen: benScreen })).status).toBe(200)
    expect((await sync(anna.token, annaScreen)).present).toEqual([])

    // None of this loaded Rooms or AI Agents.
    expect(agentsRegistry.tryGetLive(workspaceId)).toBeUndefined()
  }, 60_000)

  test('a sync held for 12 s with no change answers through the Host and its Module gateway', async () => {
    const { joinPerson, sync, invoke, run } = await startPlatform()
    const anna = await joinPerson()
    const screen = crypto.randomUUID()
    const first = await sync(anna.token, screen)
    const started = performance.now()
    const held = await invoke('agents.people.sync', {
      token: anna.token, screen, viewing: run, waitMs: 12_000, after: first.cursor, storeId: first.storeId, view: first.view,
    })
    expect(held.status).toBe(200)
    expect(performance.now() - started).toBeGreaterThan(11_000)
  }, 60_000)

  test('deleting the Workspace answers a pending sync and removes the People file', async () => {
    const { baseUrl, workspaceId, joinPerson, sync, invoke, run } = await startPlatform()
    const anna = await joinPerson()
    const screen = crypto.randomUUID()
    const first = await sync(anna.token, screen)
    const peopleFile = workspaceModulePaths(workspaceId).agents.people
    expect(existsSync(peopleFile)).toBe(true)
    const pending = invoke('agents.people.sync', {
      token: anna.token, screen, viewing: run, waitMs: 20_000, after: first.cursor, storeId: first.storeId, view: first.view,
    })
    await Bun.sleep(150)
    const started = performance.now()
    const deleted = await fetch(`${baseUrl}/api/workspaces/${workspaceId}`, { method: 'DELETE' })
    expect(deleted.status).toBe(204)
    await pending
    expect(performance.now() - started).toBeLessThan(3_000)
    expect(existsSync(peopleFile)).toBe(false)
  }, 60_000)
})
