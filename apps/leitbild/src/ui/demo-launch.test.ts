import { describe, expect, test } from 'bun:test'
import type { ModuleFeaturedDefinition, ModuleListedDefinition, WorkspaceId } from '@leitbild/contracts'
import {
  advanceLaunchSteps, createDemoLauncher, initialLaunchSteps, launchDemo, launchFailureView, launchStatusText, NOT_AVAILABLE_TEXT,
  NOT_FEATURED_TEXT, NOT_LISTED_TEXT, SLOW_AFTER_MS, stoppedText, VERY_SLOW_AFTER_MS, watchSlowLaunch,
  type DemoLaunchError, type DemoLaunchPorts, type DemoLaunchStep,
} from './demo-launch.ts'
import { CAPACITY_TEXT, MODULE_UNAVAILABLE_TEXT, OUTCOME_UNKNOWN_TEXT } from './error-text.ts'
import { fakeFetch, hostError, json, workspaceFixture } from './host-fetch-fake.test-support.ts'
import { createWorkspaceApi } from './launch-workspace.ts'
import { WEBGL_MISSING_TEXT } from './webgl-support.ts'
import { createWorkspaceMemory, type WorkspaceMemoryStorage } from './workspace-memory.ts'

// Test fixtures only: the product reads the Modules' own featured catalogue.
const OLD = '0b4b9a52-2f7e-4c1a-9d3e-000000000001' as WorkspaceId
const NEW = '0b4b9a52-2f7e-4c1a-9d3e-000000000002' as WorkspaceId
const at = new Date(2026, 9, 12, 22, 41)
const KEY = 'world:halden-offsite-power-restoration'
const FEATURED_REVISION = `revision-${'a'.repeat(32)}`
const EDITED_REVISION = `revision-${'b'.repeat(32)}`

const featured = (id = 'halden-offsite-power-restoration'): ModuleFeaturedDefinition => ({
  definition: { moduleId: 'world', type: 'world.scenario', id },
  revisionId: FEATURED_REVISION,
  title: 'Halden: loss of offsite power',
  summary: 'Four simulated nuclear units lose their grid connection.',
  about: 'A fixture about text.',
  tags: ['Nuclear plant + grid', 'Desktop'],
  previews: [{ alt: 'The Halden map after the fault.', width: 1600, height: 1000, sources: [{ path: '/assets/world/scenario-previews/offsite.webp', width: 1600 }] }],
} as ModuleFeaturedDefinition)

const SCENARIO_KEY = 'world:halden-normal-operation'
const LISTED_REVISION = `revision-${'c'.repeat(32)}`
const listedItem = (id = 'halden-normal-operation'): ModuleListedDefinition => ({
  definition: { moduleId: 'world', type: 'world.scenario', id },
  revisionId: LISTED_REVISION,
  title: 'Halden: normal operation',
  summary: 'Four simulated nuclear units run at full power; nothing is scripted.',
  tags: ['Nuclear plant + grid', 'No scripted faults'],
} as ModuleListedDefinition)

const catalogue = (
  definitions: ReadonlyArray<ModuleFeaturedDefinition> = [featured()], world: 'ready' | 'failed' = 'ready', listed: ReadonlyArray<ModuleListedDefinition> = [],
) => ({
  modules: [
    world === 'ready'
      ? { moduleId: 'world', status: 'ready' }
      : { moduleId: 'world', status: 'failed', failure: { code: 'module_unavailable', message: 'World did not answer', retryable: true } },
    { moduleId: 'agents', status: 'ready' },
  ],
  definitions: world === 'ready' ? definitions : [],
  listed: world === 'ready' ? listed : [],
})

const start = {
  id: 'world.scenario.start', moduleId: 'world', kind: 'command', scope: { kind: 'definition', definitionType: 'world.scenario' },
  title: 'Start', description: 'Start a run', risk: 'write', idempotent: false,
  inputSchema: { type: 'object', properties: {} }, outputSchema: { type: 'object' },
}
const descriptor = (workspaceId: string, revision = FEATURED_REVISION, id = 'halden-offsite-power-restoration') => ({
  ref: { workspaceId, moduleId: 'world', type: 'world.scenario', id },
  title: 'Halden: loss of offsite power', currentRevisionId: revision,
  capabilityIds: [start.id], primaryCapabilityId: start.id,
})
const definitionsOf = (workspaceId: string, definitions: ReadonlyArray<unknown>) =>
  json({ workspaceId, modules: [{ moduleId: 'world', status: 'ready' }], definitions })
const capabilitiesOf = (workspaceId: string, capabilities: ReadonlyArray<unknown> = [start]) =>
  json({ workspaceId, modules: [{ moduleId: 'world', status: 'ready' }], capabilities })
const runOf = (workspaceId: string, runId = 'run-1') =>
  json({ result: { ok: true }, createdResources: [{ workspaceId, moduleId: 'world', type: 'world.simulation-run', id: runId }] })

const memoryStorage = (): WorkspaceMemoryStorage => {
  const data = new Map<string, string>()
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) }, removeItem: key => { data.delete(key) } }
}

const setup = (options: { webgl?: boolean } = {}) => {
  const host = fakeFetch()
  const memory = createWorkspaceMemory(memoryStorage())
  const steps: DemoLaunchStep[] = []
  const ports: DemoLaunchPorts = {
    api: createWorkspaceApi(host.fetch), memory, now: () => at, fetch: host.fetch, webgl: () => options.webgl ?? true,
    onstep: step => { steps.push(step) },
  }
  const paths = () => host.calls.map(call => `${call.method} ${call.path}`)
  return { host, memory, ports, steps, paths }
}

const invokePath = (workspaceId: string) => `/api/workspaces/${workspaceId}/capabilities/world.scenario.start/invoke`
const workspaceRoutes = (host: ReturnType<typeof fakeFetch>, workspaceId: string, definitions: ReadonlyArray<unknown>, capabilities?: ReadonlyArray<unknown>) => {
  host.on('GET', `/api/workspaces/${workspaceId}/definitions?moduleId=world`, definitionsOf(workspaceId, definitions))
  host.on('GET', `/api/workspaces/${workspaceId}/capabilities?moduleId=world`, capabilitiesOf(workspaceId, capabilities))
}

const failure = async (promise: Promise<unknown>): Promise<DemoLaunchError> => {
  try {
    await promise
  } catch (error) {
    return error as DemoLaunchError
  }
  throw new Error('Expected the launch to fail')
}

describe('Start demo: the target Workspace', () => {
  test('starts in the remembered Workspace through its own Definition and primary Capability, then remembers it', async () => {
    const { host, memory, ports, steps, paths } = setup()
    memory.remember(OLD, 'picked')
    host.on('GET', '/api/featured-definitions', json(catalogue()))
    host.on('GET', `/api/workspaces/${OLD}`, json({ workspace: workspaceFixture(OLD) }))
    workspaceRoutes(host, OLD, [descriptor(OLD)])
    host.on('POST', invokePath(OLD), runOf(OLD, 'run-7'))

    const result = await launchDemo({ demo: KEY }, ports)

    expect(result).toMatchObject({ created: false, runId: 'run-7', destination: `/workspaces/${OLD}?world=run-7`, original: false, notice: null })
    // The catalogue is re-read at click time, before anything else.
    expect(paths()).toEqual([
      'GET /api/featured-definitions',
      `GET /api/workspaces/${OLD}`,
      `GET /api/workspaces/${OLD}/definitions?moduleId=world`,
      `GET /api/workspaces/${OLD}/capabilities?moduleId=world`,
      `POST ${invokePath(OLD)}`,
    ])
    expect(host.calls.at(-1)?.body).toEqual({
      definition: { workspaceId: OLD, moduleId: 'world', type: 'world.scenario', id: 'halden-offsite-power-restoration', revisionId: FEATURED_REVISION },
      input: {}, actor: { kind: 'human' },
    })
    expect(steps.map(step => step.kind)).toEqual(['checking', 'using-workspace', 'starting', 'opening'])
    expect(memory.remembered()).toBe(OLD)
    expect(memory.recent()[0]).toBe(OLD)
  })

  test('creates "New Workspace · 12 Oct, 22:41" when none is remembered', async () => {
    const { host, memory, ports, steps } = setup()
    host.on('GET', '/api/featured-definitions', json(catalogue()))
    host.on('POST', '/api/workspaces', json({ workspace: workspaceFixture(NEW, { name: 'New Workspace · 12 Oct, 22:41' }) }, 201))
    workspaceRoutes(host, NEW, [descriptor(NEW)])
    host.on('POST', invokePath(NEW), runOf(NEW))

    const result = await launchDemo({ demo: KEY }, ports)

    expect(result).toMatchObject({ created: true, destination: `/workspaces/${NEW}?world=run-1` })
    expect(host.calls.find(call => call.method === 'POST' && call.path === '/api/workspaces')?.body).toEqual({ name: 'New Workspace · 12 Oct, 22:41' })
    expect(steps.map(step => step.kind)).toEqual(['checking', 'creating-workspace', 'created-workspace', 'starting', 'opening'])
    expect(memory.remembered()).toBe(NEW)
  })

  test('a remembered Workspace that is gone is forgotten, and the demo starts in a new one', async () => {
    const { host, memory, ports } = setup()
    memory.remember(OLD, 'launched')
    host.on('GET', '/api/featured-definitions', json(catalogue()))
    host.on('GET', `/api/workspaces/${OLD}`, hostError(404, 'workspace_not_found', 'Workspace not found'))
    host.on('POST', '/api/workspaces', json({ workspace: workspaceFixture(NEW, { name: 'New Workspace · 12 Oct, 22:41' }) }, 201))
    workspaceRoutes(host, NEW, [descriptor(NEW)])
    host.on('POST', invokePath(NEW), runOf(NEW))

    const result = await launchDemo({ demo: KEY }, ports)

    expect(result).toMatchObject({ created: true, notice: 'Your last Workspace no longer exists.' })
    expect(memory.remembered()).toBe(NEW)
    expect(memory.recent()).not.toContain(OLD)
  })

  test('"Use a new Workspace instead" creates one even with a remembered Workspace', async () => {
    const { host, memory, ports, paths } = setup()
    memory.remember(OLD, 'picked')
    host.on('GET', '/api/featured-definitions', json(catalogue()))
    host.on('POST', '/api/workspaces', json({ workspace: workspaceFixture(NEW) }, 201))
    workspaceRoutes(host, NEW, [descriptor(NEW)])
    host.on('POST', invokePath(NEW), runOf(NEW))

    await launchDemo({ demo: KEY, forceNewWorkspace: true }, ports)

    expect(paths()).not.toContain(`GET /api/workspaces/${OLD}`)
    expect(memory.remembered()).toBe(NEW)
  })

  test('World not ready in the remembered Workspace: offer Retry and Open, start nothing', async () => {
    const { host, memory, ports, paths } = setup()
    memory.remember(OLD, 'picked')
    host.on('GET', '/api/featured-definitions', json(catalogue()))
    host.on('GET', `/api/workspaces/${OLD}`, json({ workspace: workspaceFixture(OLD, { world: 'provision_failed' }) }))

    const error = await failure(launchDemo({ demo: KEY }, ports))

    expect(error).toMatchObject({ kind: 'workspace-not-ready', created: false, invoked: false, workspace: { id: OLD } })
    expect(launchFailureView(error)).toEqual({ text: 'World is not ready in Grid study.', actions: ['retry-module', 'open'] })
    expect(paths().some(path => path.includes('/definitions') || path.includes('/invoke'))).toBe(false)
  })

  test('World not ready in a new Workspace says so', async () => {
    const { host, ports } = setup()
    host.on('GET', '/api/featured-definitions', json(catalogue()))
    host.on('POST', '/api/workspaces', json({ workspace: workspaceFixture(NEW, { world: 'provision_failed' }) }, 201))

    const error = await failure(launchDemo({ demo: KEY }, ports))

    expect(error).toMatchObject({ kind: 'workspace-not-ready', created: true, workspace: { id: NEW } })
    expect(launchFailureView(error).text).toBe('World could not be prepared in the new Workspace.')
  })

  test('Retry after a Module retry uses the named Workspace', async () => {
    const { host, ports, paths } = setup()
    host.on('GET', '/api/featured-definitions', json(catalogue()))
    host.on('GET', `/api/workspaces/${OLD}`, json({ workspace: workspaceFixture(OLD) }))
    workspaceRoutes(host, OLD, [descriptor(OLD)])
    host.on('POST', invokePath(OLD), runOf(OLD))

    await launchDemo({ demo: KEY, workspaceId: OLD }, ports)

    expect(paths()).toContain(`GET /api/workspaces/${OLD}`)
    expect(paths()).not.toContain('POST /api/workspaces')
  })
})

describe('Start demo: the Definition', () => {
  test('a Workspace that edited the demo starts the featured (original) revision there', async () => {
    const { host, memory, ports, steps } = setup()
    memory.remember(OLD, 'picked')
    host.on('GET', '/api/featured-definitions', json(catalogue()))
    host.on('GET', `/api/workspaces/${OLD}`, json({ workspace: workspaceFixture(OLD) }))
    workspaceRoutes(host, OLD, [descriptor(OLD, EDITED_REVISION)])
    host.on('POST', invokePath(OLD), runOf(OLD))

    const result = await launchDemo({ demo: KEY }, ports)

    expect(result.original).toBe(true)
    expect((host.calls.at(-1)?.body as { definition: { revisionId: string } }).definition.revisionId).toBe(FEATURED_REVISION)
    expect(steps.find(step => step.kind === 'starting')).toMatchObject({ original: true })
    expect(launchStatusText({ kind: 'starting', workspace: workspaceFixture(OLD) as never, original: true }, 'x')).toBe('Starting the original demo…')
  })

  test('a demo deleted in the remembered Workspace starts in one new Workspace, and says so', async () => {
    const { host, memory, ports, steps } = setup()
    memory.remember(OLD, 'picked')
    host.on('GET', '/api/featured-definitions', json(catalogue()))
    host.on('GET', `/api/workspaces/${OLD}`, json({ workspace: workspaceFixture(OLD) }))
    workspaceRoutes(host, OLD, [descriptor(OLD, FEATURED_REVISION, 'something-else')])
    host.on('POST', '/api/workspaces', json({ workspace: workspaceFixture(NEW, { name: 'New Workspace · 12 Oct, 22:41' }) }, 201))
    workspaceRoutes(host, NEW, [descriptor(NEW)])
    host.on('POST', invokePath(NEW), runOf(NEW))

    const result = await launchDemo({ demo: KEY }, ports)

    expect(result).toMatchObject({ created: true, workspace: { id: NEW }, notice: 'Grid study no longer has this demo, so it starts in a new Workspace.' })
    expect(steps.map(step => step.kind)).toEqual(['checking', 'using-workspace', 'moving', 'creating-workspace', 'created-workspace', 'starting', 'opening'])
    expect(launchStatusText(steps[2]!, 'x')).toBe('Grid study no longer has this demo, so it starts in a new Workspace.')
    expect(host.calls.filter(call => call.method === 'POST' && call.path === '/api/workspaces')).toHaveLength(1)
    expect(memory.remembered()).toBe(NEW)
  })

  test('a demo missing in a fresh Workspace is an error, not a second Workspace', async () => {
    const { host, ports } = setup()
    host.on('GET', '/api/featured-definitions', json(catalogue()))
    host.on('POST', '/api/workspaces', json({ workspace: workspaceFixture(NEW) }, 201))
    workspaceRoutes(host, NEW, [])

    const error = await failure(launchDemo({ demo: KEY }, ports))

    expect(error).toMatchObject({ kind: 'not-available', created: true, invoked: false })
    expect(launchFailureView(error)).toEqual({ text: NOT_AVAILABLE_TEXT, actions: ['open'] })
    expect(host.calls.filter(call => call.method === 'POST' && call.path === '/api/workspaces')).toHaveLength(1)
  })

  test('a missing primary Capability is a visible error, never a no-op', async () => {
    const { host, memory, ports, paths } = setup()
    memory.remember(OLD, 'picked')
    host.on('GET', '/api/featured-definitions', json(catalogue()))
    host.on('GET', `/api/workspaces/${OLD}`, json({ workspace: workspaceFixture(OLD) }))
    workspaceRoutes(host, OLD, [descriptor(OLD)], [])

    const error = await failure(launchDemo({ demo: KEY }, ports))

    expect(error.kind).toBe('cannot-start')
    expect(launchFailureView(error)).toEqual({ text: 'This demo cannot be started in Grid study right now.', actions: ['try-again', 'open'] })
    expect(paths().some(path => path.endsWith('/invoke'))).toBe(false)
  })

  test('a demo that is no longer featured at click time creates nothing', async () => {
    const { host, ports, paths } = setup()
    host.on('GET', '/api/featured-definitions', json(catalogue([featured('nordland-corridor-security')])))

    const error = await failure(launchDemo({ demo: KEY }, ports))

    expect(error.kind).toBe('not-featured')
    expect(launchFailureView(error)).toEqual({ text: NOT_FEATURED_TEXT, actions: [] })
    expect(paths()).toEqual(['GET /api/featured-definitions'])
  })

  test('World failing to list its demos at click time is plain text with Try again', async () => {
    const { host, ports } = setup()
    host.on('GET', '/api/featured-definitions', json(catalogue([], 'failed')))

    const error = await failure(launchDemo({ demo: KEY }, ports))

    expect(launchFailureView(error)).toEqual({ text: MODULE_UNAVAILABLE_TEXT, actions: ['try-again'] })
  })

  test('without WebGL 2 nothing is requested or created', async () => {
    const { ports, paths } = setup({ webgl: false })

    const error = await failure(launchDemo({ demo: KEY }, ports))

    expect(error.kind).toBe('webgl')
    expect(launchFailureView(error).text).toBe(WEBGL_MISSING_TEXT)
    expect(paths()).toEqual([])
  })
})

describe('Start demo: the invoke', () => {
  const ready = () => {
    const context = setup()
    context.memory.remember(OLD, 'picked')
    context.host.on('GET', '/api/featured-definitions', json(catalogue()))
    context.host.on('GET', `/api/workspaces/${OLD}`, json({ workspace: workspaceFixture(OLD) }))
    workspaceRoutes(context.host, OLD, [descriptor(OLD)])
    return context
  }

  test('a timed-out start (504) may have started: Open only, never Try again', async () => {
    const { host, ports, memory } = ready()
    host.on('POST', invokePath(OLD), hostError(504, 'module_outcome_unknown', 'Lost the connection to World before the result arrived'))

    const error = await failure(launchDemo({ demo: KEY }, ports))

    expect(error).toMatchObject({ kind: 'outcome-unknown', invoked: true })
    expect(launchFailureView(error)).toEqual({ text: 'The demo may have started. Open Grid study to check.', actions: ['open'] })
    expect(launchFailureView(error).text).not.toBe(OUTCOME_UNKNOWN_TEXT)
    expect(memory.remembered()).toBe(OLD)
  })

  test('a connection lost during the start is also an unknown outcome', async () => {
    const { host, ports } = ready()
    host.on('POST', invokePath(OLD), () => { throw new TypeError('Failed to fetch') })

    const error = await failure(launchDemo({ demo: KEY }, ports))

    expect(launchFailureView(error).actions).toEqual(['open'])
  })

  test('a start that reports no Run sends the user to check', async () => {
    const { host, ports } = ready()
    host.on('POST', invokePath(OLD), json({ result: {} }))

    const error = await failure(launchDemo({ demo: KEY }, ports))

    expect(error.kind).toBe('outcome-unknown')
  })

  test('capacity (503) asks to try again in a minute', async () => {
    const { host, ports } = ready()
    host.on('POST', invokePath(OLD), hostError(503, 'workspace_capacity_exceeded', 'Too many active Workspaces'))

    const error = await failure(launchDemo({ demo: KEY }, ports))

    expect(launchFailureView(error)).toEqual({ text: CAPACITY_TEXT, actions: ['try-again'] })
  })

  test('other refusals are plain text with Try again, and the raw code stays out of the text', async () => {
    const { host, ports } = ready()
    host.on('POST', invokePath(OLD), hostError(409, 'scenario_invalid', 'This scenario needs a newer map.'))
    const refused = await failure(launchDemo({ demo: KEY }, ports))
    expect(launchFailureView(refused)).toEqual({ text: 'This scenario needs a newer map.', actions: ['try-again'] })

    const second = ready()
    second.host.on('POST', invokePath(OLD), hostError(500, 'internal_error', 'TypeError: x is undefined at run.ts:12'))
    const raw = await failure(launchDemo({ demo: KEY }, second.ports))
    expect(launchFailureView(raw).text).toBe('Something went wrong. Try again.')
  })
})

describe('Start demo: × and the in-flight flag', () => {
  test('× during the start aborts the client flow; a created Workspace is named in the stopped line', async () => {
    const { host, ports } = setup()
    const launcher = createDemoLauncher()
    host.on('GET', '/api/featured-definitions', json(catalogue()))
    host.on('POST', '/api/workspaces', json({ workspace: workspaceFixture(NEW, { name: 'New Workspace · 12 Oct, 22:41' }) }, 201))
    workspaceRoutes(host, NEW, [descriptor(NEW)])
    host.on('POST', invokePath(NEW), call => {
      launcher.cancel()
      if (call.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
      return runOf(NEW)
    })

    const error = await failure(launcher.start({ demo: KEY }, ports))

    expect(error).toMatchObject({ kind: 'aborted', created: true, invoked: true })
    expect(stoppedText(error)).toBe('Stopped. New Workspace · 12 Oct, 22:41 was created; the demo may appear there.')
    expect(launcher.busy()).toBe(false)
  })

  test('× before the start leaves only the created Workspace behind', async () => {
    const { host, ports, paths } = setup()
    const launcher = createDemoLauncher()
    host.on('GET', '/api/featured-definitions', json(catalogue()))
    host.on('POST', '/api/workspaces', () => {
      launcher.cancel()
      return json({ workspace: workspaceFixture(NEW, { name: 'Lab' }) }, 201)
    })

    const error = await failure(launcher.start({ demo: KEY }, ports))

    expect(error).toMatchObject({ kind: 'aborted', invoked: false })
    expect(stoppedText(error)).toBe('Stopped. Lab was created.')
    expect(paths().some(path => path.endsWith('/invoke'))).toBe(false)
  })

  test('× in a remembered Workspace before the start leaves nothing to say', async () => {
    const { host, memory, ports } = setup()
    const launcher = createDemoLauncher()
    memory.remember(OLD, 'picked')
    host.on('GET', '/api/featured-definitions', json(catalogue()))
    host.on('GET', `/api/workspaces/${OLD}`, () => {
      launcher.cancel()
      return json({ workspace: workspaceFixture(OLD) })
    })

    const error = await failure(launcher.start({ demo: KEY }, ports))

    expect(error.kind).toBe('aborted')
    expect(stoppedText(error)).toBeNull()
  })

  test('one launch at a time per page', async () => {
    const { host, ports } = setup()
    const launcher = createDemoLauncher()
    let release: () => void = () => {}
    host.on('GET', '/api/featured-definitions', () => new Promise<Response>(resolve => { release = () => resolve(json(catalogue([]))) }))

    const first = failure(launcher.start({ demo: KEY }, ports))
    expect(launcher.busy()).toBe(true)
    const second = await failure(launcher.start({ demo: KEY }, ports))
    expect(second.kind).toBe('busy')
    release()
    expect((await first).kind).toBe('not-featured')
    expect(launcher.busy()).toBe(false)
  })
})

describe('Start a listed scenario (More scenarios): the same flow', () => {
  const scenarioDescriptor = (workspaceId: string, revision = LISTED_REVISION) => descriptor(workspaceId, revision, 'halden-normal-operation')
  const withListed = () => catalogue([featured()], 'ready', [listedItem()])

  test('starts in the remembered Workspace through its own Definition and primary Capability, at the listed revision', async () => {
    const { host, memory, ports, steps, paths } = setup()
    memory.remember(OLD, 'picked')
    host.on('GET', '/api/featured-definitions', json(withListed()))
    host.on('GET', `/api/workspaces/${OLD}`, json({ workspace: workspaceFixture(OLD) }))
    workspaceRoutes(host, OLD, [descriptor(OLD), scenarioDescriptor(OLD)])
    host.on('POST', invokePath(OLD), runOf(OLD, 'run-9'))

    const result = await launchDemo({ demo: SCENARIO_KEY }, ports)

    expect(result).toMatchObject({ created: false, runId: 'run-9', destination: `/workspaces/${OLD}?world=run-9`, original: false, notice: null })
    expect(paths()).toEqual([
      'GET /api/featured-definitions',
      `GET /api/workspaces/${OLD}`,
      `GET /api/workspaces/${OLD}/definitions?moduleId=world`,
      `GET /api/workspaces/${OLD}/capabilities?moduleId=world`,
      `POST ${invokePath(OLD)}`,
    ])
    expect(host.calls.at(-1)?.body).toEqual({
      definition: { workspaceId: OLD, moduleId: 'world', type: 'world.scenario', id: 'halden-normal-operation', revisionId: LISTED_REVISION },
      input: {}, actor: { kind: 'human' },
    })
    expect(steps.map(step => step.kind)).toEqual(['checking', 'using-workspace', 'starting', 'opening'])
    expect(memory.remembered()).toBe(OLD)
  })

  test('creates a Workspace when none is remembered, or when asked for a new one', async () => {
    const { host, memory, ports, paths } = setup()
    memory.remember(OLD, 'picked')
    host.on('GET', '/api/featured-definitions', json(withListed()))
    host.on('POST', '/api/workspaces', json({ workspace: workspaceFixture(NEW) }, 201))
    workspaceRoutes(host, NEW, [scenarioDescriptor(NEW)])
    host.on('POST', invokePath(NEW), runOf(NEW))

    const result = await launchDemo({ demo: SCENARIO_KEY, forceNewWorkspace: true }, ports)

    expect(result).toMatchObject({ created: true, destination: `/workspaces/${NEW}?world=run-1` })
    expect(paths()).not.toContain(`GET /api/workspaces/${OLD}`)
    expect(memory.remembered()).toBe(NEW)
  })

  test('an edited scenario starts World\'s original revision; a deleted one starts in a new Workspace with "scenario" in its notice', async () => {
    const edited = setup()
    edited.memory.remember(OLD, 'picked')
    edited.host.on('GET', '/api/featured-definitions', json(withListed()))
    edited.host.on('GET', `/api/workspaces/${OLD}`, json({ workspace: workspaceFixture(OLD) }))
    workspaceRoutes(edited.host, OLD, [scenarioDescriptor(OLD, EDITED_REVISION)])
    edited.host.on('POST', invokePath(OLD), runOf(OLD))
    expect((await launchDemo({ demo: SCENARIO_KEY }, edited.ports)).original).toBe(true)
    expect((edited.host.calls.at(-1)?.body as { definition: { revisionId: string } }).definition.revisionId).toBe(LISTED_REVISION)

    const deleted = setup()
    deleted.memory.remember(OLD, 'picked')
    deleted.host.on('GET', '/api/featured-definitions', json(withListed()))
    deleted.host.on('GET', `/api/workspaces/${OLD}`, json({ workspace: workspaceFixture(OLD) }))
    workspaceRoutes(deleted.host, OLD, [descriptor(OLD)])
    deleted.host.on('POST', '/api/workspaces', json({ workspace: workspaceFixture(NEW) }, 201))
    workspaceRoutes(deleted.host, NEW, [scenarioDescriptor(NEW)])
    deleted.host.on('POST', invokePath(NEW), runOf(NEW))
    const moved = await launchDemo({ demo: SCENARIO_KEY }, deleted.ports)
    expect(moved).toMatchObject({ created: true, notice: 'Grid study no longer has this scenario, so it starts in a new Workspace.' })
    expect(launchStatusText(deleted.steps[2]!, 'x', 'scenario')).toBe('Grid study no longer has this scenario, so it starts in a new Workspace.')
  })

  test('a scenario in neither list, or missing in a fresh Workspace, is said so with "scenario"', async () => {
    const gone = setup()
    gone.host.on('GET', '/api/featured-definitions', json(catalogue([featured()], 'ready', [listedItem('supply-run')])))
    const notListed = await failure(launchDemo({ demo: SCENARIO_KEY }, gone.ports))
    expect(notListed.kind).toBe('not-featured')
    expect(launchFailureView(notListed, 'scenario')).toEqual({ text: NOT_LISTED_TEXT, actions: [] })
    expect(gone.paths()).toEqual(['GET /api/featured-definitions'])

    const fresh = setup()
    fresh.host.on('GET', '/api/featured-definitions', json(withListed()))
    fresh.host.on('POST', '/api/workspaces', json({ workspace: workspaceFixture(NEW) }, 201))
    workspaceRoutes(fresh.host, NEW, [descriptor(NEW)])
    const missing = await failure(launchDemo({ demo: SCENARIO_KEY }, fresh.ports))
    expect(missing).toMatchObject({ kind: 'not-available', created: true, invoked: false })
    expect(launchFailureView(missing, 'scenario')).toEqual({ text: 'This scenario is not available in this Workspace right now.', actions: ['open'] })
  })

  test('one launch at a time across demos and scenarios', async () => {
    const { host, ports } = setup()
    const launcher = createDemoLauncher()
    let release: () => void = () => {}
    host.on('GET', '/api/featured-definitions', () => new Promise<Response>(resolve => { release = () => resolve(json(catalogue([]))) }))

    const first = failure(launcher.start({ demo: KEY }, ports))
    const second = await failure(launcher.start({ demo: SCENARIO_KEY }, ports))
    expect(second.kind).toBe('busy')
    expect(launchFailureView(second, 'scenario').text).toBe('A scenario is already starting.')
    release()
    expect((await first).kind).toBe('not-featured')
  })
})

describe('launch texts: "demo" or "scenario"', () => {
  const ws = workspaceFixture(OLD) as never
  const error = (kind: DemoLaunchError['kind'], context: Partial<Pick<DemoLaunchError, 'workspace' | 'created' | 'invoked'>> = {}): DemoLaunchError =>
    Object.assign(new Error(kind), { kind, workspace: null, created: false, invoked: false, ...context }) as DemoLaunchError

  test('a demo keeps its texts; a scenario says "scenario" in every one', () => {
    const cases: Array<[DemoLaunchError, string, string]> = [
      [error('not-featured'), NOT_FEATURED_TEXT, NOT_LISTED_TEXT],
      [error('not-available'), NOT_AVAILABLE_TEXT, 'This scenario is not available in this Workspace right now.'],
      [error('cannot-start', { workspace: ws }), 'This demo cannot be started in Grid study right now.', 'This scenario cannot be started in Grid study right now.'],
      [error('cannot-start'), 'This demo cannot be started right now.', 'This scenario cannot be started right now.'],
      [error('outcome-unknown', { workspace: ws }), 'The demo may have started. Open Grid study to check.', 'The scenario may have started. Open Grid study to check.'],
      [error('busy'), 'A demo is already starting.', 'A scenario is already starting.'],
      [error('aborted', { workspace: ws, created: true, invoked: true }), 'Stopped. Grid study was created; the demo may appear there.', 'Stopped. Grid study was created; the scenario may appear there.'],
    ]
    for (const [failed, demo, scenario] of cases) {
      expect(launchFailureView(failed).text).toBe(demo)
      expect(launchFailureView(failed, 'demo').text).toBe(demo)
      expect(launchFailureView(failed, 'scenario').text).toBe(scenario)
    }
    expect(stoppedText(error('aborted', { workspace: ws, invoked: true }), 'scenario')).toBe('Stopped. The scenario may appear in Grid study.')
    const starting: DemoLaunchStep = { kind: 'starting', workspace: ws, original: true }
    expect(launchStatusText(starting, 'x', 'scenario')).toBe('Starting the original scenario…')
    expect(launchStatusText(starting, 'x')).toBe('Starting the original demo…')
    const initial = initialLaunchSteps(ws, 'Halden: normal operation')
    expect(advanceLaunchSteps(initial, starting, 'scenario')[1]?.detail).toBe('Starts the original scenario')
    expect(advanceLaunchSteps(initial, starting)[1]?.detail).toBe('Starts the original demo')
  })
})

describe('slow states', () => {
  test('says "still starting" at 8 s and offers Keep waiting / Open at 30 s, until cancelled', () => {
    const timers: Array<{ at: number; run: () => void; live: boolean }> = []
    const scheduler = {
      setTimeout: (run: () => void, ms: number) => { const timer = { at: ms, run, live: true }; timers.push(timer); return timer },
      clearTimeout: (handle: unknown) => { (handle as { live: boolean }).live = false },
    }
    const levels: number[] = []
    const cancel = watchSlowLaunch(scheduler, level => { levels.push(level) })
    expect(timers.map(timer => timer.at)).toEqual([SLOW_AFTER_MS, VERY_SLOW_AFTER_MS])
    timers[0]!.run()
    expect(levels).toEqual([1])
    cancel()
    expect(timers.every(timer => !timer.live)).toBe(true)
  })
})

describe('launch progress', () => {
  const ws = workspaceFixture(NEW, { name: 'Lab' }) as never

  test('three real steps, each with a text state', () => {
    const initial = initialLaunchSteps(null, 'Halden: loss of offsite power')
    expect(initial.map(step => [step.label, step.state])).toEqual([
      ['Creating a Workspace', 'doing'], ['Starting the simulation', 'pending'], ['Opening', 'pending'],
    ])
    const created = advanceLaunchSteps(initial, { kind: 'created-workspace', workspace: ws })
    expect(created.map(step => [step.label, step.state])).toEqual([
      ['Created Lab', 'done'], ['Starting the simulation', 'doing'], ['Opening', 'pending'],
    ])
    expect(created[0]?.detail).toBe('Public: anyone can see, open, change or delete it.')
    const opening = advanceLaunchSteps(created, { kind: 'opening', workspace: ws, destination: '/x' })
    expect(opening.map(step => step.state)).toEqual(['done', 'done', 'doing'])
  })

  test('a chosen Workspace is named from the start', () => {
    const initial = initialLaunchSteps({ id: OLD, name: 'Grid study' }, 'x')
    expect(initial[0]).toMatchObject({ label: 'Using Grid study', state: 'doing' })
    const using = advanceLaunchSteps(initial, { kind: 'using-workspace', workspace: workspaceFixture(OLD) as never })
    expect(using.map(step => step.state)).toEqual(['done', 'doing', 'pending'])
  })

  test('one status sentence per step', () => {
    expect(launchStatusText({ kind: 'checking' }, 'Halden: loss of offsite power')).toBe('Starting Halden: loss of offsite power…')
    expect(launchStatusText({ kind: 'creating-workspace' }, 'x')).toBe('Creating a Workspace…')
    expect(launchStatusText({ kind: 'created-workspace', workspace: ws }, 'x')).toBe('Created Lab.')
    expect(launchStatusText({ kind: 'using-workspace', workspace: ws }, 'x')).toBe('Using Lab.')
    expect(launchStatusText({ kind: 'opening', workspace: ws, destination: '/x' }, 'x')).toBe('Opening the simulation…')
  })
})
