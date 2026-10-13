import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { moduleActivitySchema, newWorkspaceId, type ModuleActivity, type WorkspaceId } from '@leitbild/contracts'
import { asAIAgent } from '../../agents/shared.ts'
import { makeStubGateway, makeStubSetup, stubProviderConfig } from '../../api/__fixtures__/stub-gateway.ts'
import { handleAgentsModuleApi } from '../../api/workspace-module-api.ts'
import type { ProviderGateway } from '../../llm/provider-gateway.ts'
import type { Script } from '../types/script.ts'
import type { Trigger } from '../triggers/types.ts'
import { createDeploymentRuntime } from '../deployment-runtime.ts'
import { createAgentsModuleState, type AgentsModuleState } from './module-state.ts'
import { createWorkspaceRuntimeRegistry, type WorkspaceRuntimeRegistry } from './runtime-registry.ts'

describe('Agents Workspace activity', () => {
  let originalHome: string | undefined
  let originalProvider: string | undefined
  let originalSeed: string | undefined
  let home = ''
  let state: AgentsModuleState
  let registries: WorkspaceRuntimeRegistry[] = []

  beforeEach(async () => {
    originalHome = process.env.LEITBILD_HOME
    originalProvider = process.env.PROVIDER
    originalSeed = process.env.LEITBILD_SEED_WORKSPACE
    home = await mkdtemp(join(tmpdir(), 'leitbild-activity-'))
    process.env.LEITBILD_HOME = home
    process.env.PROVIDER = 'ollama'
    process.env.LEITBILD_SEED_WORKSPACE = '0'
    state = createAgentsModuleState()
  })

  afterEach(async () => {
    await Promise.all(registries.map(registry => registry.shutdown()))
    registries = []
    if (originalHome === undefined) delete process.env.LEITBILD_HOME
    else process.env.LEITBILD_HOME = originalHome
    if (originalProvider === undefined) delete process.env.PROVIDER
    else process.env.PROVIDER = originalProvider
    if (originalSeed === undefined) delete process.env.LEITBILD_SEED_WORKSPACE
    else process.env.LEITBILD_SEED_WORKSPACE = originalSeed
    await rm(home, { recursive: true, force: true })
  })

  // A test-only model whose answers the test holds open.
  const registryWith = (stream?: ProviderGateway['stream']): WorkspaceRuntimeRegistry => {
    const provider = { ...makeStubGateway(),
      modelInfo: async (model: string) => ({ id: model, provider: 'stub', contextMax: 100_000, source: 'fixture' }),
      ...(stream === undefined ? {} : { stream }) }
    const registry = createWorkspaceRuntimeRegistry({ moduleState: state, idleMs: 1_000_000,
      deployment: createDeploymentRuntime({ providerConfig: stubProviderConfig, providerSetup: makeStubSetup(provider) }),
    })
    registries.push(registry)
    return registry
  }

  const provisioned = async (): Promise<WorkspaceId> => {
    const id = newWorkspaceId()
    await state.provision(id)
    return id
  }

  const activity = async (registry: WorkspaceRuntimeRegistry): Promise<ModuleActivity> => {
    const url = new URL('/internal/activity', 'http://agents.test')
    const response = await handleAgentsModuleApi(new Request(url.href), url, { state, registry })
    if (!response) throw new Error('Module API did not handle GET /internal/activity')
    expect(response.status).toBe(200)
    return moduleActivitySchema.parse(await response.json())
  }

  const until = async (condition: () => boolean, what: string): Promise<void> => {
    const deadline = performance.now() + 10_000
    while (!condition()) {
      if (performance.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
      await Bun.sleep(5)
    }
  }

  test('nothing loaded and an idle loaded Workspace both answer no Workspaces, without touching the idle clock', async () => {
    const registry = registryWith()
    expect(await activity(registry)).toEqual({ workspaces: [] })
    const idle = await provisioned()
    await registry.getOrLoad(idle)
    const before = registry.list()
    await Bun.sleep(5)
    expect(await activity(registry)).toEqual({ workspaces: [] })
    expect(registry.list()).toEqual(before)
  })

  test('AI agents generating a turn are reported for their Workspace only, until they answer', async () => {
    let release!: () => void
    const released = new Promise<void>(resolve => { release = resolve })
    const registry = registryWith(async function* () {
      await released
      yield { delta: 'Done.', done: true, tokensUsed: { prompt: 1, completion: 1 } }
    })
    const busy = await provisioned()
    const idle = await provisioned()
    await registry.getOrLoad(idle)
    const system = await registry.getOrLoad(busy)
    try {
      const agents = await Promise.all(['First', 'Second'].map(async name => {
        const room = system.rooms.createRoom({ name: `${name} room`, createdBy: 'test' })
        const agent = asAIAgent(await system.spawnAIAgent({ name, model: 'mock-model', persona: '', tools: [] }))!
        room.addMember(agent.id)
        await agent.join(room)
        // The Room delivers to its members; a second receive would queue a second turn.
        room.post({ senderId: 'human', type: 'chat', content: 'Assess the plant.' })
        return agent
      }))
      await until(() => agents.every(agent => agent.state.get() === 'generating'), 'both agents to generate')
      const before = registry.list()
      await Bun.sleep(5)
      expect(await activity(registry)).toEqual({ workspaces: [{
        workspaceId: busy,
        items: [{ key: 'agents-answering', label: '2 AI agents answering', count: 2, active: true }],
      }] })
      expect(registry.list()).toEqual(before)
      release()
      await Promise.all(agents.map(agent => agent.whenIdle()))
      expect(await activity(registry)).toEqual({ workspaces: [] })
    } finally { release() }
  })

  test('a running model comparison is reported until it ends', async () => {
    let streams = 0
    let comparisonEntered!: () => void
    const comparisonStarted = new Promise<void>(resolve => { comparisonEntered = resolve })
    // The Agent's own turn answers; the comparison's model call answers only
    // by failing when its signal aborts, as a slow real model would.
    const registry = registryWith(async function* (_request: unknown, signal?: AbortSignal) {
      if (++streams === 1) {
        yield { delta: 'Original answer.', done: true, tokensUsed: { prompt: 1, completion: 1 } }
        return
      }
      comparisonEntered()
      await new Promise<never>((_, reject) => {
        if (!signal) return reject(new Error('Comparison model call carries no abort signal'))
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    const id = await provisioned()
    const system = await registry.getOrLoad(id)
    const room = system.rooms.createRoom({ name: 'Comparison', createdBy: 'test' })
    const agent = asAIAgent(await system.spawnAIAgent({ name: 'Agent', model: 'mock-model', persona: '', tools: [] }))!
    room.addMember(agent.id)
    await agent.join(room)
    room.post({ senderId: 'human', type: 'chat', content: 'Assess the plant.' })
    await until(() => room.getRetainedMessages().some(message => message.senderId === agent.id), 'the original answer')
    await agent.whenIdle()
    const original = room.getRetainedMessages().find(message => message.senderId === agent.id)!
    const started = await system.comparisons.start(room.profile.id, original.id, 'stub:mock-model')
    await comparisonStarted
    expect(await activity(registry)).toEqual({ workspaces: [{
      workspaceId: id,
      items: [{ key: 'comparisons-running', label: '1 model comparison running', count: 1, active: true }],
    }] })
    await system.comparisons.cancel(room.profile.id, original.id, started.id)
    await until(() => system.comparisons.running() === 0, 'the comparison to end')
    expect(await activity(registry)).toEqual({ workspaces: [] })
  }, 30_000)

  test('script runs and room summaries being written are background work; a paused script waits', async () => {
    let release!: () => void
    const released = new Promise<void>(resolve => { release = resolve })
    // Every model call, Agent turn or summary, waits for the test.
    const registry = registryWith(async function* () {
      await released
      yield { delta: 'Done.', done: true, tokensUsed: { prompt: 1, completion: 1 } }
    })
    const id = await provisioned()
    const system = await registry.getOrLoad(id)
    const script: Script = {
      id: 'script-1', name: 'demo', title: 'Demo Script', source: '',
      cast: [
        { name: 'Alex', model: 'mock-model', persona: 'You are Alex.', starts: true },
        { name: 'Sam', model: 'mock-model', persona: 'You are Sam.' },
      ],
      steps: [{ index: 0, title: 'Opening', roles: { Alex: 'start', Sam: 'respond' } }],
    }
    const scripted = system.rooms.createRoom({ name: 'Scripted', createdBy: 'test' })
    const summarised = system.rooms.createRoom({ name: 'Summarised', createdBy: 'test' })
    const answering = { key: 'agents-answering', label: '1 AI agent answering', count: 1, active: true }
    try {
      expect(await system.scriptRunner.startWith(scripted.profile.id, script)).toEqual({ ok: true })
      await until(() => system.team.getAgent('Alex')?.state.get() === 'generating', 'the first cast member to speak')
      expect(await activity(registry)).toEqual({ workspaces: [{ workspaceId: id, items: [
        answering,
        { key: 'background-running', label: '1 script running', count: 1, active: true },
      ] }] })

      summarised.post({ senderId: 'human', type: 'chat', content: 'The pumps are running.' })
      summarised.setSummaryConfig({ ...summarised.summaryConfig, model: 'mock-model' })
      const summary = system.summaryScheduler.triggerNow(summarised.profile.id, 'summary')
      await until(() => system.summaryScheduler.isRunning(summarised.profile.id, 'summary'), 'the summary to start')
      expect(await activity(registry)).toEqual({ workspaces: [{ workspaceId: id, items: [
        answering,
        { key: 'background-running', label: '2 background jobs running', count: 2, active: true },
      ] }] })

      scripted.setPaused(true)
      expect(await activity(registry)).toEqual({ workspaces: [{ workspaceId: id, items: [
        answering,
        { key: 'background-running', label: '1 room summary being written', count: 1, active: true },
        { key: 'jobs-waiting', label: '1 paused script', count: 1, active: false },
      ] }] })

      release()
      await summary
      await until(() => system.team.getAgent('Alex')?.state.get() === 'idle', 'the cast member to finish')
      expect(await system.scriptRunner.stop(scripted.profile.id)).toMatchObject({ ok: true })
      expect(await activity(registry)).toEqual({ workspaces: [] })
    } finally { release() }
  }, 30_000)

  test('enabled triggers and timed summaries are recurring work that waits between runs', async () => {
    const registry = registryWith()
    const id = await provisioned()
    const system = await registry.getOrLoad(id)
    const room = system.rooms.createRoom({ name: 'Watch', createdBy: 'test' })
    const agent = asAIAgent(await system.spawnAIAgent({ name: 'Watcher', model: 'mock-model', persona: '', tools: [] }))!
    const trigger = (name: string, enabled: boolean): Trigger =>
      ({ id: crypto.randomUUID(), name, prompt: 'Report the plant state.', mode: 'execute', intervalSec: 3_600, enabled, roomId: room.profile.id })
    const hourly = trigger('Hourly', true)
    agent.addTrigger!(hourly)
    agent.addTrigger!(trigger('Off', false))
    expect(await activity(registry)).toEqual({ workspaces: [{ workspaceId: id, items: [
      { key: 'jobs-waiting', label: '1 recurring trigger', count: 1, active: false },
    ] }] })

    // A summary counted by messages is not timed; only the timed compression counts.
    room.setSummaryConfig({
      ...room.summaryConfig,
      summary: { enabled: true, schedule: { kind: 'messages', everyMessages: 25 } },
      compression: { ...room.summaryConfig.compression, enabled: true, schedule: { kind: 'time', everySeconds: 3_600 } },
    })
    expect(await activity(registry)).toEqual({ workspaces: [{ workspaceId: id, items: [
      { key: 'jobs-waiting', label: '2 jobs waiting to run', count: 2, active: false },
    ] }] })

    agent.updateTrigger!(hourly.id, { enabled: false })
    expect(await activity(registry)).toEqual({ workspaces: [{ workspaceId: id, items: [
      { key: 'jobs-waiting', label: '1 timed room summary', count: 1, active: false },
    ] }] })

    room.setSummaryConfig({ ...room.summaryConfig, compression: { ...room.summaryConfig.compression, enabled: false } })
    expect(await activity(registry)).toEqual({ workspaces: [] })
  })

  test('an evicted or never loaded Workspace reports nothing and is not loaded', async () => {
    const registry = registryWith()
    const evicted = await provisioned()
    await provisioned()
    await registry.getOrLoad(evicted)
    await registry.evictOne(evicted)
    const load = spyOn(registry, 'getOrLoad')
    expect(await activity(registry)).toEqual({ workspaces: [] })
    expect(load).not.toHaveBeenCalled()
    expect(registry.list()).toEqual([])
    expect(registry.tryGetLive(evicted)).toBeUndefined()
  })
})
