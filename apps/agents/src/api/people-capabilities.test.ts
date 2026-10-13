import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { moduleCapabilityCollectionSchema, newWorkspaceId, type WorkspaceId } from '@leitbild/contracts'
import { createDeploymentRuntime } from '../core/deployment-runtime.ts'
import { workspaceModulePaths } from '../core/paths.ts'
import { PRESENCE_TIMEOUT_MS } from '../core/people/presence.ts'
import { createAgentsModuleState, type AgentsModuleState } from '../core/workspaces/module-state.ts'
import { createWorkspaceRuntimeRegistry, type WorkspaceRuntimeRegistry } from '../core/workspaces/runtime-registry.ts'
import { handleAgentsModuleApi } from './workspace-module-api.ts'

const IDLE_MS = 1_000_000
let home = ''
let originalHome: string | undefined
let originalProvider: string | undefined
let state: AgentsModuleState
let registry: WorkspaceRuntimeRegistry
let quietLog: ReturnType<typeof spyOn>

const newRegistry = () => createWorkspaceRuntimeRegistry({ deployment: createDeploymentRuntime(), moduleState: state, idleMs: IDLE_MS })

beforeEach(async () => {
  originalHome = process.env.LEITBILD_HOME
  originalProvider = process.env.PROVIDER
  home = await mkdtemp(join(tmpdir(), 'leitbild-people-api-'))
  process.env.LEITBILD_HOME = home
  process.env.PROVIDER = 'ollama'
  state = createAgentsModuleState()
  registry = newRegistry()
  // Send outcome lines are asserted in the directory tests; keep this output quiet.
  quietLog = spyOn(console, 'log').mockImplementation(() => undefined)
})

afterEach(async () => {
  quietLog.mockRestore()
  await registry.shutdown()
  if (originalHome === undefined) delete process.env.LEITBILD_HOME
  else process.env.LEITBILD_HOME = originalHome
  if (originalProvider === undefined) delete process.env.PROVIDER
  else process.env.PROVIDER = originalProvider
  await rm(home, { recursive: true, force: true })
})

const request = async (method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> => {
  const url = new URL(path, 'http://agents.test')
  const response = await handleAgentsModuleApi(new Request(url.href, {
    method,
    ...(signal === undefined ? {} : { signal }),
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  }), url, { state, registry })
  if (!response) throw new Error(`Module API did not handle ${method} ${path}`)
  return response
}

const provision = async (): Promise<WorkspaceId> => {
  const workspaceId = newWorkspaceId()
  expect((await request('PUT', `/internal/workspaces/${workspaceId}`, { workspaceId })).status).toBe(201)
  return workspaceId
}

type Actor = { readonly kind: 'human' | 'ai' | 'system' | 'anonymous'; readonly id?: string }
const invocationBody = (workspaceId: WorkspaceId, capabilityId: string, input: unknown, options: {
  readonly actor?: Actor
  readonly idempotencyKey?: string
  readonly resource?: unknown
} = {}) => ({
  workspaceId,
  capabilityId,
  input,
  ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
  ...(options.resource === undefined ? {} : { resource: options.resource }),
  access: {
    workspaceId,
    requestId: crypto.randomUUID(),
    actor: options.actor ?? { kind: 'human' },
    client: { id: 'workspace-host', kind: 'service' },
  },
})

const invoke = (workspaceId: WorkspaceId, capabilityId: string, input: unknown, options: Parameters<typeof invocationBody>[3] & { readonly signal?: AbortSignal } = {}) =>
  request('POST', `/internal/workspaces/${workspaceId}/capabilities/${capabilityId}/invoke`, invocationBody(workspaceId, capabilityId, input, options), options.signal)

const resultOf = async <T = unknown>(response: Response, status = 200): Promise<NoInfer<T>> => {
  const body = await response.json() as { result: T; error?: unknown }
  if (response.status !== status) throw new Error(`expected ${status}, got ${response.status}: ${JSON.stringify(body)}`)
  return body.result
}
const errorOf = async (response: Response) => ({ status: response.status, ...(await response.json() as { error: { code: string; retryable?: boolean; details?: Record<string, unknown> } }).error })

const run = (workspaceId: WorkspaceId, id = 'run-1') => ({ workspaceId, moduleId: 'world', type: 'world.simulation-run', id })

interface Joined { token: string; me: { id: string; name: string }; preferredNameAccepted: boolean }
interface Synced { storeId: string; cursor: number; view: string; present: Array<{ id: string; name: string }>; messages: Array<{ id: string; seq: number; text: string }>; conversations: Array<Record<string, unknown>> }
const join_ = async (workspaceId: WorkspaceId, preferredName?: string) =>
  resultOf<Joined>(await invoke(workspaceId, 'agents.people.join', preferredName === undefined ? {} : { preferredName }), 201)
const sync = async (workspaceId: WorkspaceId, token: string, screen: string, extra: Record<string, unknown> = {}, signal?: AbortSignal) =>
  invoke(workspaceId, 'agents.people.sync', { token, screen, viewing: run(workspaceId), waitMs: 0, ...extra }, signal === undefined ? {} : { signal })

const PEOPLE_IDS = [
  'agents.people.join',
  'agents.people.sync',
  'agents.people.rename',
  'agents.people.conversation.read',
  'agents.people.conversation.mark-read',
  'agents.people.message.send',
  'agents.people.leave',
]

const until = async (condition: () => boolean, timeoutMs = 1_000): Promise<number> => {
  const started = performance.now()
  while (!condition()) {
    if (performance.now() - started > timeoutMs) throw new Error('condition not reached in time')
    await Bun.sleep(5)
  }
  return performance.now() - started
}

describe('People Capabilities', () => {
  test('are published beside the runtime Capabilities with exact schemas and retry metadata', async () => {
    const workspaceId = await provision()
    const catalog = moduleCapabilityCollectionSchema.parse(await (await request('GET', `/internal/workspaces/${workspaceId}/capabilities`)).json()).capabilities
    const ids: string[] = catalog.map(capability => capability.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('agents.room.create')
    const people = catalog.filter(capability => capability.id.startsWith('agents.people.'))
    expect(people.map((capability): string => capability.id).sort()).toEqual([...PEOPLE_IDS].sort())
    for (const capability of people) expect(capability.scope).toEqual({ kind: 'workspace' })
    expect(people.filter(capability => capability.acceptsIdempotencyKey).map((capability): string => capability.id)).toEqual(['agents.people.message.send'])
    expect(people.find(capability => capability.id === 'agents.people.conversation.read')).toMatchObject({ kind: 'query', risk: 'read', idempotent: true, comparisonUnavailableReason: expect.any(String) })
    expect(people.find(capability => capability.id === 'agents.people.sync')!.inputSchema).toMatchObject({
      type: 'object', additionalProperties: false, required: expect.arrayContaining(['token', 'screen', 'viewing', 'waitMs']),
    })
    expect(registry.tryGetLive(workspaceId)).toBeUndefined()
  })

  test('serve joining, presence, renaming and chat without ever loading the Agents runtime', async () => {
    const workspaceId = await provision()
    const ann = await join_(workspaceId, 'Ann')
    const ben = await join_(workspaceId)
    expect(ann).toMatchObject({ me: { name: 'Ann' }, preferredNameAccepted: true })
    expect(ben).toMatchObject({ me: { name: 'User1' }, preferredNameAccepted: false })
    const annScreen = crypto.randomUUID()
    const benScreen = crypto.randomUUID()
    const first = await resultOf<Synced>(await sync(workspaceId, ann.token, annScreen))
    expect(first).toMatchObject({ present: [], messages: [], cursor: 0, more: false, presenceWarming: expect.any(Boolean), me: ann.me })
    expect((await resultOf<Synced>(await sync(workspaceId, ben.token, benScreen))).present).toEqual([ann.me])
    // Ben's arrival changed Ann's view, so her next sync answers at once.
    const arrived = await resultOf<Synced>(await sync(workspaceId, ann.token, annScreen, { after: first.cursor, storeId: first.storeId, view: first.view, waitMs: 5_000 }))
    expect(arrived.present).toEqual([ben.me])

    const waiting = sync(workspaceId, ann.token, annScreen, { after: arrived.cursor, storeId: arrived.storeId, view: arrived.view, waitMs: 5_000 })
    await until(() => registry.peopleStatus().waiters === 1)
    expect(await resultOf<unknown>(await invoke(workspaceId, 'agents.people.rename', { token: ben.token, name: 'Ben' }))).toEqual({ me: { id: ben.me.id, name: 'Ben' } })
    const renamed = await resultOf<Synced>(await waiting)
    expect(renamed.present).toEqual([{ id: ben.me.id, name: 'Ben' }])

    const sent = await resultOf<{ message: { id: string; seq: number; from: string; to: string; text: string; sentAt: string }; replayed: boolean }>(
      await invoke(workspaceId, 'agents.people.message.send', { token: ben.token, to: ann.me.id, text: 'Hello Ann' }, { idempotencyKey: 'client-1' }), 201)
    expect(sent).toMatchObject({ replayed: false, message: { from: ben.me.id, to: ann.me.id, text: 'Hello Ann' } })
    const delivered = await resultOf<Synced>(await sync(workspaceId, ann.token, annScreen, { after: renamed.cursor, storeId: renamed.storeId, view: renamed.view, waitMs: 5_000 }))
    expect(delivered.messages).toEqual([sent.message])
    expect(delivered.conversations).toEqual([{ with: { id: ben.me.id, name: 'Ben' }, here: true, lastSeq: sent.message.seq, lastSentAt: sent.message.sentAt, unread: 1 }])

    expect(await resultOf(await invoke(workspaceId, 'agents.people.conversation.read', { token: ann.token, with: ben.me.id }))).toEqual({
      with: { id: ben.me.id, name: 'Ben' }, messages: [sent.message], readThrough: { me: 0, them: sent.message.seq },
    })
    expect(await resultOf(await invoke(workspaceId, 'agents.people.conversation.mark-read', { token: ann.token, with: ben.me.id, through: sent.message.seq }))).toEqual({ unread: 0 })
    expect(await resultOf(await invoke(workspaceId, 'agents.people.leave', { token: ben.token, screen: benScreen }))).toEqual({ left: true })
    expect((await resultOf<Synced>(await sync(workspaceId, ann.token, annScreen))).present).toEqual([])

    expect(registry.tryGetLive(workspaceId)).toBeUndefined()
    expect(registry.list()).toEqual([])
    expect(existsSync(workspaceModulePaths(workspaceId).agents.people)).toBe(true)
    expect(registry.peopleStatus()).toMatchObject({ joins: 2, renames: 1, messagesSent: 1, leaves: 1, openDirectories: 1, waiters: 0 })
  })

  test('refuse AI, system and anonymous actors before opening People storage', async () => {
    const workspaceId = await provision()
    for (const actor of [{ kind: 'ai', id: 'agent:operator' }, { kind: 'system' }, { kind: 'anonymous' }] as const) {
      for (const capabilityId of PEOPLE_IDS) {
        const refused = await errorOf(await invoke(workspaceId, capabilityId, {}, { actor }))
        expect(refused).toMatchObject({ status: 403, code: 'people_human_required' })
      }
    }
    expect(existsSync(workspaceModulePaths(workspaceId).agents.people)).toBe(false)
    expect(registry.peopleStatus()).toMatchObject({ openDirectories: 0, rejections: { people_human_required: 21 } })
  })

  test('keep identity tokens inside their Workspace and out of every other response', async () => {
    const first = await provision()
    const second = await provision()
    const ann = await join_(first)
    await join_(second)
    const response = await sync(second, ann.token, crypto.randomUUID())
    const text = await response.clone().text()
    expect(await errorOf(response)).toMatchObject({ status: 401, code: 'person_token_invalid' })
    expect(text).not.toContain(ann.token)
    const ben = await join_(first)
    const benView = await (await sync(first, ben.token, crypto.randomUUID())).text()
    expect(benView).not.toContain(ann.token)
    const invalid = await (await invoke(first, 'agents.people.rename', { token: ann.token, name: 'x'.repeat(600) })).text()
    expect(invalid).not.toContain(ann.token)
  })

  test('send requires a retry key and replays it, also after the store is reopened; other People Capabilities refuse keys', async () => {
    const workspaceId = await provision()
    const ann = await join_(workspaceId)
    const ben = await join_(workspaceId)
    const message = { token: ann.token, to: ben.me.id, text: 'Pump 2 is yours' }
    expect(await errorOf(await invoke(workspaceId, 'agents.people.message.send', message))).toMatchObject({ status: 400, code: 'idempotency_key_required' })
    const sent = await resultOf<{ message: unknown }>(await invoke(workspaceId, 'agents.people.message.send', message, { idempotencyKey: 'k-1' }), 201)
    expect(await resultOf(await invoke(workspaceId, 'agents.people.message.send', message, { idempotencyKey: 'k-1' }))).toEqual({ message: sent.message, replayed: true })
    expect(await errorOf(await invoke(workspaceId, 'agents.people.message.send', { ...message, text: 'other' }, { idempotencyKey: 'k-1' })))
      .toMatchObject({ status: 409, code: 'idempotency_conflict' })
    expect(await errorOf(await invoke(workspaceId, 'agents.people.join', {}, { idempotencyKey: 'k-2' }))).toMatchObject({ status: 400, code: 'idempotency_not_supported' })
    expect(await errorOf(await invoke(workspaceId, 'agents.people.sync', { token: ann.token, screen: crypto.randomUUID(), viewing: run(workspaceId), waitMs: 0 }, { idempotencyKey: 'k-3' })))
      .toMatchObject({ status: 400, code: 'idempotency_not_supported' })

    await registry.shutdown()
    registry = newRegistry()
    expect(await resultOf(await invoke(workspaceId, 'agents.people.message.send', message, { idempotencyKey: 'k-1' }))).toEqual({ message: sent.message, replayed: true })
    expect(registry.tryGetLive(workspaceId)).toBeUndefined()
  })

  test('answer refusals with distinct structured codes', async () => {
    const workspaceId = await provision()
    const other = await provision()
    const ann = await join_(workspaceId)
    expect(await errorOf(await invoke(workspaceId, 'agents.people.sync', { token: ann.token, screen: 'not-a-uuid', viewing: run(workspaceId), waitMs: 0 })))
      .toMatchObject({ status: 400, code: 'invalid_request' })
    expect(await errorOf(await invoke(workspaceId, 'agents.people.sync', { token: ann.token, screen: crypto.randomUUID(), viewing: run(workspaceId), waitMs: 20_001 })))
      .toMatchObject({ status: 400, code: 'invalid_request' })
    expect(await errorOf(await invoke(workspaceId, 'agents.people.sync', { token: ann.token, screen: crypto.randomUUID(), viewing: run(other), waitMs: 0 })))
      .toMatchObject({ status: 409, code: 'workspace_scope_mismatch' })
    expect(await errorOf(await invoke(workspaceId, 'agents.people.join', {}, { resource: run(workspaceId) })))
      .toMatchObject({ status: 409, code: 'capability_scope_invalid' })
    expect(await errorOf(await invoke(workspaceId, 'agents.people.rename', { token: ann.token, name: 'Ann\u202e' })))
      .toMatchObject({ status: 400, code: 'person_name_invalid', details: { reason: 'invalid_characters' } })
    expect(await errorOf(await invoke(workspaceId, 'agents.people.message.send', { token: ann.token, to: ann.me.id, text: 'me' }, { idempotencyKey: 'self' })))
      .toMatchObject({ status: 400, code: 'message_to_self' })
    const ben = await join_(workspaceId)
    // SQLite's length() stops at NUL: refused as client errors, never a retryable 500.
    expect(await errorOf(await invoke(workspaceId, 'agents.people.message.send', { token: ann.token, to: ben.me.id, text: '\u0000hello' }, { idempotencyKey: 'nul-text' })))
      .toMatchObject({ status: 400, code: 'message_invalid_characters' })
    expect(await errorOf(await invoke(workspaceId, 'agents.people.message.send', { token: ann.token, to: ben.me.id, text: 'hello' }, { idempotencyKey: '\u0000k' })))
      .toMatchObject({ status: 400, code: 'invalid_request' })
    expect(registry.peopleStatus().storeFailures).toBe(0)
    for (let i = 0; i < 9; i++) await resultOf(await invoke(workspaceId, 'agents.people.rename', { token: ann.token, name: `Ann ${i}` }))
    expect(await errorOf(await invoke(workspaceId, 'agents.people.rename', { token: ann.token, name: 'Ann again' })))
      .toMatchObject({ status: 429, code: 'people_rate_limited', retryable: true, details: { retryAfterMs: expect.any(Number) } })
    const unprovisioned = newWorkspaceId()
    expect(await errorOf(await invoke(unprovisioned, 'agents.people.join', {}))).toMatchObject({ status: 404, code: 'workspace_not_found' })
    expect(existsSync(workspaceModulePaths(unprovisioned).root)).toBe(false)
  })

  test('an aborted pending sync drops its waiter', async () => {
    const workspaceId = await provision()
    const ann = await join_(workspaceId)
    const screen = crypto.randomUUID()
    const first = await resultOf<Synced>(await sync(workspaceId, ann.token, screen))
    const controller = new AbortController()
    const pending = sync(workspaceId, ann.token, screen, { after: first.cursor, storeId: first.storeId, view: first.view, waitMs: 20_000 }, controller.signal)
    await until(() => registry.peopleStatus().waiters === 1)
    controller.abort()
    expect((await pending).status).toBe(499)
    expect(registry.peopleStatus()).toMatchObject({ waiters: 0, syncsAborted: 1 })
  })

  test('DELETE during a pending sync answers it within a second and removes people.sqlite', async () => {
    const workspaceId = await provision()
    const ann = await join_(workspaceId)
    const screen = crypto.randomUUID()
    const first = await resultOf<Synced>(await sync(workspaceId, ann.token, screen))
    const pending = sync(workspaceId, ann.token, screen, { after: first.cursor, storeId: first.storeId, view: first.view, waitMs: 20_000 })
    await until(() => registry.peopleStatus().waiters === 1)
    const started = performance.now()
    expect((await request('DELETE', `/internal/workspaces/${workspaceId}`)).status).toBe(204)
    const answered = await pending
    expect(performance.now() - started).toBeLessThan(1_000)
    expect((await resultOf<Synced>(answered)).view).toBe(first.view)
    expect(existsSync(workspaceModulePaths(workspaceId).agents.people)).toBe(false)
    expect(existsSync(workspaceModulePaths(workspaceId).agents.root)).toBe(false)
    expect(await errorOf(await sync(workspaceId, ann.token, screen))).toMatchObject({ status: 404, code: 'workspace_not_found' })
    expect(existsSync(workspaceModulePaths(workspaceId).agents.root)).toBe(false)
    expect(registry.peopleStatus()).toMatchObject({ openDirectories: 0, waiters: 0 })
  })

  test('registry shutdown during a pending sync answers it within a second; later calls are retryable closings', async () => {
    const workspaceId = await provision()
    const ann = await join_(workspaceId)
    const screen = crypto.randomUUID()
    const first = await resultOf<Synced>(await sync(workspaceId, ann.token, screen))
    const pending = sync(workspaceId, ann.token, screen, { after: first.cursor, storeId: first.storeId, view: first.view, waitMs: 20_000 })
    await until(() => registry.peopleStatus().waiters === 1)
    const started = performance.now()
    await registry.shutdown()
    expect((await pending).status).toBe(200)
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(await errorOf(await sync(workspaceId, ann.token, screen))).toMatchObject({ status: 409, code: 'workspace_closing', retryable: true })
  })

  test('idle People directories are evicted and reopen with the same store on the next request', async () => {
    const workspaceId = await provision()
    const ann = await join_(workspaceId)
    const first = await resultOf<Synced>(await sync(workspaceId, ann.token, crypto.randomUUID()))
    expect(await registry.evictIdle(Date.now() + 1_000)).toBe(0)
    expect(registry.peopleStatus().openDirectories).toBe(1)
    await registry.evictIdle(Date.now() + IDLE_MS + PRESENCE_TIMEOUT_MS + 1_000)
    expect(registry.peopleStatus()).toMatchObject({ openDirectories: 0, directoriesEvicted: 1 })
    const again = await resultOf<Synced>(await sync(workspaceId, ann.token, crypto.randomUUID()))
    expect(again.storeId).toBe(first.storeId)
  })

  test('Bun aborts the Agents request when the Host-side fetch is aborted, and the waiter is dropped', async () => {
    const workspaceId = await provision()
    const ann = await join_(workspaceId)
    const screen = crypto.randomUUID()
    const first = await resultOf<Synced>(await sync(workspaceId, ann.token, screen))
    const agents = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async request => await handleAgentsModuleApi(request, new URL(request.url), { state, registry })
        ?? new Response('not found', { status: 404 }),
    })
    // Stands in for the Host gateway: forwards the body and passes its own request signal.
    const host = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async request => await fetch(new URL(new URL(request.url).pathname, agents.url), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: await request.text(), signal: request.signal,
      }),
    })
    try {
      const capabilityId = 'agents.people.sync'
      const browser = new AbortController()
      const pending = fetch(new URL(`/internal/workspaces/${workspaceId}/capabilities/${capabilityId}/invoke`, host.url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invocationBody(workspaceId, capabilityId, {
          token: ann.token, screen, viewing: run(workspaceId), after: first.cursor, storeId: first.storeId, view: first.view, waitMs: 20_000,
        })),
        signal: browser.signal,
      }).catch((error: unknown) => error)
      await until(() => registry.peopleStatus().waiters === 1)
      browser.abort()
      expect(await pending).toBeInstanceOf(Error)
      await until(() => registry.peopleStatus().waiters === 0)
      expect(registry.peopleStatus().syncsAborted).toBe(1)
    } finally {
      host.stop(true)
      agents.stop(true)
    }
  })
})
