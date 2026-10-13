import { describe, expect, test } from 'bun:test'
import type { WorkspaceId } from '@leitbild/contracts'
import { fakeFetch, hostError, json, workspaceFixture } from './host-fetch-fake.test-support.ts'
import {
  createWorkspaceApi, isWorkspaceNotReady, LAST_WORKSPACE_GONE_TEXT, moduleReadiness, moduleTitle, newWorkspaceName, rememberedWorkspace,
  resolveLaunchWorkspace, shortDate, workspaceLabel, type LaunchWorkspaceStep,
} from './launch-workspace.ts'
import { createWorkspaceMemory, type WorkspaceMemoryStorage } from './workspace-memory.ts'

const OLD = '0b4b9a52-2f7e-4c1a-9d3e-000000000001' as WorkspaceId
const NEW = '0b4b9a52-2f7e-4c1a-9d3e-000000000002' as WorkspaceId
const OTHER = '0b4b9a52-2f7e-4c1a-9d3e-000000000003' as WorkspaceId
const at = new Date(2026, 9, 12, 22, 41)
const memoryStorage = (): WorkspaceMemoryStorage => {
  const data = new Map<string, string>()
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) }, removeItem: key => { data.delete(key) } }
}
const setup = () => {
  const host = fakeFetch()
  const memory = createWorkspaceMemory(memoryStorage())
  const steps: LaunchWorkspaceStep['kind'][] = []
  const ports = { api: createWorkspaceApi(host.fetch), memory, now: () => at }
  const onstep = (step: LaunchWorkspaceStep) => { steps.push(step.kind) }
  return { host, memory, ports, steps, onstep }
}

describe('Workspace names', () => {
  test('auto-created Workspaces are named with the local date and time', () => {
    expect(newWorkspaceName(at)).toBe('New Workspace · 12 Oct, 22:41')
    expect(newWorkspaceName(new Date(2026, 0, 3, 7, 5))).toBe('New Workspace · 3 Jan, 07:05')
    expect(shortDate(at)).toBe('12 Oct')
  })

  test('never shows a raw id as a primary label', () => {
    expect(workspaceLabel({ id: 'b56b1d2e-0000-4000-8000-000000000000', name: null })).toBe('Untitled · b56b1d')
    expect(workspaceLabel({ id: 'b56b1d2e-0000-4000-8000-000000000000', name: null }, 'header')).toBe('Untitled Workspace · b56b1d')
    expect(workspaceLabel({ id: OLD, name: 'Grid study' }, 'header')).toBe('Grid study')
  })

  test('reads Module readiness from the Host record', () => {
    const workspace = workspaceFixture(OLD, { world: 'provision_failed', agents: 'provisioning' })
    expect(moduleReadiness(workspace as never, 'world')).toBe('failed')
    expect(moduleReadiness(workspace as never, 'agents')).toBe('provisioning')
    expect(moduleReadiness({ modules: [] }, 'world')).toBe('missing')
  })
})

describe('launch Workspace', () => {
  test('uses the remembered Workspace when it still exists, reading only the Host', async () => {
    const { host, memory, ports, steps, onstep } = setup()
    memory.remember(OLD, 'picked')
    host.on('GET', `/api/workspaces/${OLD}`, json({ workspace: workspaceFixture(OLD) }))
    const target = await resolveLaunchWorkspace('world', ports, { onstep })
    expect(target).toMatchObject({ created: false, notice: null, workspace: { id: OLD, name: 'Grid study' } })
    expect(steps).toEqual(['using-workspace'])
    expect(host.calls.map(call => `${call.method} ${call.path}`)).toEqual([`GET /api/workspaces/${OLD}`])
  })

  test('creates "New Workspace · 12 Oct, 22:41" when nothing is remembered, and remembers it at once', async () => {
    const { host, memory, ports, steps, onstep } = setup()
    host.on('POST', '/api/workspaces', json({ workspace: workspaceFixture(NEW, { name: 'New Workspace · 12 Oct, 22:41' }) }, 201))
    const target = await resolveLaunchWorkspace('world', ports, { onstep })
    expect(target).toMatchObject({ created: true, notice: null, workspace: { id: NEW } })
    expect(host.calls[0]!.body).toEqual({ name: 'New Workspace · 12 Oct, 22:41' })
    expect(steps).toEqual(['creating-workspace', 'created-workspace'])
    expect(memory.remembered()).toBe(NEW)
  })

  test('a remembered Workspace that is gone is forgotten, replaced, and reported once', async () => {
    const { host, memory, ports } = setup()
    memory.remember(OLD, 'launched')
    host.on('GET', `/api/workspaces/${OLD}`, hostError(404, 'workspace_not_found', 'Workspace not found'))
    host.on('POST', '/api/workspaces', json({ workspace: workspaceFixture(NEW) }, 201))
    const target = await resolveLaunchWorkspace('world', ports)
    expect(target).toMatchObject({ created: true, notice: LAST_WORKSPACE_GONE_TEXT, workspace: { id: NEW } })
    expect(memory.remembered()).toBe(NEW)
    expect(memory.recent()).not.toContain(OLD)
  })

  test('an explicit choice wins over the remembered Workspace', async () => {
    const { host, memory, ports } = setup()
    memory.remember(OLD, 'picked')
    host.on('GET', `/api/workspaces/${OTHER}`, json({ workspace: workspaceFixture(OTHER, { name: null }) }))
    const target = await resolveLaunchWorkspace('agents', ports, { workspaceId: OTHER })
    expect(target.workspace.id).toBe(OTHER)
    expect(memory.remembered()).toBe(OLD)
  })

  test('"Use a new Workspace instead" creates one without reading the remembered one', async () => {
    const { host, memory, ports } = setup()
    memory.remember(OLD, 'picked')
    host.on('POST', '/api/workspaces', json({ workspace: workspaceFixture(NEW) }, 201))
    expect((await resolveLaunchWorkspace('world', ports, { forceNew: true })).workspace.id).toBe(NEW)
    expect(host.calls).toHaveLength(1)
  })

  test('a Module that is not ready is a visible error naming the Workspace, never a silent launch', async () => {
    const { host, memory, ports } = setup()
    host.on('POST', '/api/workspaces', json({ workspace: workspaceFixture(NEW, { world: 'provision_failed' }) }, 201))
    const error = await resolveLaunchWorkspace('world', ports).catch(cause => cause)
    expect(isWorkspaceNotReady(error)).toBe(true)
    expect(error).toMatchObject({ message: 'World could not be prepared in the new Workspace.', created: true, moduleId: 'world', workspace: { id: NEW } })
    expect(memory.remembered()).toBe(NEW)

    memory.remember(OLD, 'picked')
    host.on('GET', `/api/workspaces/${OLD}`, json({ workspace: workspaceFixture(OLD, { agents: 'provisioning' }) }))
    const existing = await resolveLaunchWorkspace('agents', ports).catch(cause => cause)
    expect(existing).toMatchObject({ message: 'Agents is not ready in Grid study.', created: false })
  })

  test('Host failures surface with their status and code', async () => {
    const { host, ports } = setup()
    host.on('POST', '/api/workspaces', hostError(503, 'module_unavailable', 'World did not answer'))
    expect(await resolveLaunchWorkspace('world', ports).catch(cause => cause)).toMatchObject({ status: 503, code: 'module_unavailable' })
  })

  test('rejects a malformed Workspace response instead of guessing', async () => {
    const { host, memory, ports } = setup()
    memory.remember(OLD, 'picked')
    host.on('GET', `/api/workspaces/${OLD}`, json({ workspace: { id: OLD, name: 'x' } }))
    await expect(resolveLaunchWorkspace('world', ports)).rejects.toThrow()
  })

  test('passes the abort signal to every request', async () => {
    const { host, ports } = setup()
    const controller = new AbortController()
    controller.abort()
    host.on('POST', '/api/workspaces', json({ workspace: workspaceFixture(NEW) }, 201))
    await expect(resolveLaunchWorkspace('world', { ...ports, signal: controller.signal })).rejects.toThrow('aborted')
    expect(host.calls[0]!.signal).toBe(controller.signal)
  })
})

describe('remembered Workspace for "Continue in …"', () => {
  test('returns nothing without a hint, and makes no request', async () => {
    const { host, ports } = setup()
    expect(await rememberedWorkspace(ports)).toEqual({ workspace: null, notice: null })
    expect(host.calls).toHaveLength(0)
  })

  test('says once that the last Workspace no longer exists', async () => {
    const { host, memory, ports } = setup()
    memory.remember(OLD, 'picked')
    host.on('GET', `/api/workspaces/${OLD}`, hostError(404, 'workspace_not_found', 'Workspace not found'))
    expect(await rememberedWorkspace(ports)).toEqual({ workspace: null, notice: LAST_WORKSPACE_GONE_TEXT })
    expect(await rememberedWorkspace(ports)).toEqual({ workspace: null, notice: null })
  })
})

describe('Workspace API', () => {
  test('lists, creates and retries through the Host only', async () => {
    const host = fakeFetch()
      .on('GET', '/api/workspaces', json({ workspaces: [workspaceFixture(OLD), workspaceFixture(NEW, { name: null })] }))
      .on('POST', `/api/workspaces/${OLD}/modules/world/retry`, json({ workspace: workspaceFixture(OLD) }))
    const api = createWorkspaceApi(host.fetch)
    expect((await api.list()).map(item => item.name)).toEqual(['Grid study', null])
    expect((await api.retryModule(OLD, 'world')).id).toBe(OLD)
    expect(host.calls.map(call => call.method)).toEqual(['GET', 'POST'])
  })

  test('reads every Module\'s activity through the contract, passing the caller\'s signal, and reports a refusal', async () => {
    const answer = {
      modules: [{ moduleId: 'world', status: 'ready' }, { moduleId: 'agents', status: 'failed', failure: { code: 'module_unavailable', message: 'down', retryable: true } }],
      workspaces: [{ workspaceId: OLD, items: [{ moduleId: 'world', key: 'simulations-running', label: '1 simulation running', count: 1, active: true }] }],
    }
    const host = fakeFetch().on('GET', '/api/workspace-activity', json(answer))
    const signal = new AbortController().signal
    expect(await createWorkspaceApi(host.fetch).activity(signal)).toEqual(answer as never)
    expect(host.calls[0]!.signal).toBe(signal)
    await expect(createWorkspaceApi(fakeFetch().on('GET', '/api/workspace-activity', hostError(500, 'internal_error', 'Internal Workspace Host error')).fetch).activity())
      .rejects.toMatchObject({ status: 500, code: 'internal_error' })
    // An item from a Module without a ready outcome is outside the contract.
    await expect(createWorkspaceApi(fakeFetch().on('GET', '/api/workspace-activity', json({ ...answer, modules: [] })).fetch).activity()).rejects.toThrow()
  })
})

describe('Module titles', () => {
  test('a core Module is named by its title, any other by its id as it stands', () => {
    expect([moduleTitle('world'), moduleTitle('agents')]).toEqual(['World', 'Agents'])
    expect(moduleTitle('process-plant')).toBe('process-plant')
    expect(moduleTitle('constructor')).toBe('constructor')
  })
})
