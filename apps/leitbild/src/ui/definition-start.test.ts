import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  createStartRunner, LONG_START_MS, STILL_STARTING_MS, startStepStatus, startSteps, type StartScheduler, type StartState, type StartTarget,
} from './definition-start.ts'
import { CAPACITY_TEXT } from './error-text.ts'
import { fakeFetch, hostError, json } from './host-fetch-fake.test-support.ts'
import { revision, scenario, startCapability, WS } from './workspace-page.test-support.ts'

const definitionsPath = `/api/workspaces/${WS}/definitions?moduleId=world`
const capabilitiesPath = `/api/workspaces/${WS}/capabilities?moduleId=world`
const invokePath = `/api/workspaces/${WS}/capabilities/world.scenario.start/invoke`
const ready = [{ moduleId: 'world', status: 'ready' }]
const target: StartTarget = { key: 'row:supply-run', workspaceId: WS, definition: { moduleId: 'world', type: 'world.scenario', id: 'supply-run' } }

const fakeScheduler = () => {
  let now = 0
  let next = 0
  const pending = new Map<number, { at: number; callback: () => void }>()
  const scheduler: StartScheduler = {
    setTimeout: (callback, ms) => { pending.set(++next, { at: now + ms, callback }); return next },
    clearTimeout: handle => { pending.delete(handle as number) },
  }
  const advance = (ms: number) => {
    now += ms
    for (const [handle, timer] of [...pending].sort((left, right) => left[1].at - right[1].at)) {
      if (timer.at <= now) { pending.delete(handle); timer.callback() }
    }
  }
  return { scheduler, advance, pending }
}

const catalogHost = (definitions = [scenario('supply-run', { currentRevisionId: revision('c') })], capabilities = [startCapability]) =>
  fakeFetch()
    .on('GET', definitionsPath, json({ workspaceId: WS, modules: ready, definitions }))
    .on('GET', capabilitiesPath, json({ workspaceId: WS, modules: ready, capabilities }))

const quietConsole = () => {
  const error = console.error
  beforeEach(() => { console.error = () => {} })
  afterEach(() => { console.error = error })
}

describe('steps', () => {
  test('one step per real Host call, worded for the Module', () => {
    expect(startSteps('world').map(step => step.label)).toEqual(['Checking the scenario', 'Starting the simulation', 'Opening'])
    expect(startSteps('agents').map(step => step.label)).toEqual(['Checking the definition', 'Creating the conversation', 'Opening'])
    expect(startStepStatus('world', 'starting')).toBe('Starting the simulation…')
  })
})

describe('starting a scenario from the Workspace page', () => {
  quietConsole()

  test('re-reads the Definition, invokes its declared primary Capability with the current revision, and opens the Run', async () => {
    const host = catalogHost().on('POST', invokePath, json({
      result: {}, createdResources: [{ workspaceId: WS, moduleId: 'world', type: 'world.simulation-run', id: 'run-1' }],
    }, 201))
    const runner = createStartRunner({ fetch: host.fetch, scheduler: fakeScheduler().scheduler })
    const seen: string[] = []
    runner.subscribe(state => { if (state.phase === 'busy') seen.push(state.step) })
    const result = await runner.start(target)
    expect(result).toEqual({ destination: `/workspaces/${WS}?world=run-1` })
    expect(seen).toEqual(['checking', 'starting', 'opening'])
    expect(host.calls.map(call => `${call.method} ${call.path}`)).toEqual([`GET ${definitionsPath}`, `GET ${capabilitiesPath}`, `POST ${invokePath}`])
    expect(host.calls[2]?.body).toEqual({
      definition: { workspaceId: WS, moduleId: 'world', type: 'world.scenario', id: 'supply-run', revisionId: revision('c') },
      input: {}, actor: { kind: 'human' },
    })
  })

  test('a featured demo starts its featured revision, also when this Workspace edited it', async () => {
    const host = catalogHost().on('POST', invokePath, json({ result: {}, createdResources: [] }, 201))
    const runner = createStartRunner({ fetch: host.fetch, scheduler: fakeScheduler().scheduler })
    expect(await runner.start({ ...target, featured: true, revisionId: revision('a') })).toEqual({ destination: null })
    expect((host.calls[2]?.body as { definition: { revisionId: string } }).definition.revisionId).toBe(revision('a'))
  })

  test('a created conversation opens in the Agents pane', async () => {
    const host = catalogHost().on('POST', invokePath, json({
      result: {}, createdResources: [{ workspaceId: WS, moduleId: 'agents', type: 'agents.room', id: 'room-1' }],
    }, 201))
    expect(await createStartRunner({ fetch: host.fetch }).start(target)).toEqual({ destination: `/workspaces/${WS}?agents=room-1` })
  })

  test('only one start runs at a time', async () => {
    let release: () => void = () => {}
    const host = catalogHost().on('POST', invokePath, () => new Promise<Response>(resolve => {
      release = () => resolve(json({ result: {}, createdResources: [] }, 201))
    }))
    const runner = createStartRunner({ fetch: host.fetch, scheduler: fakeScheduler().scheduler })
    const first = runner.start(target)
    expect(await runner.start({ ...target, key: 'row:other' })).toBeNull()
    await Bun.sleep(0)
    release()
    expect(await first).toEqual({ destination: null })
    expect(host.calls.filter(call => call.method === 'POST')).toHaveLength(1)
  })

  test('says when it is slow, at 8 s and at 30 s, and stops the timers when done', async () => {
    let release: () => void = () => {}
    const host = catalogHost().on('POST', invokePath, () => new Promise<Response>(resolve => {
      release = () => resolve(json({ result: {}, createdResources: [] }, 201))
    }))
    const clock = fakeScheduler()
    const runner = createStartRunner({ fetch: host.fetch, scheduler: clock.scheduler })
    const pending = runner.start(target)
    await Bun.sleep(0)
    clock.advance(STILL_STARTING_MS)
    expect(runner.state()).toMatchObject({ phase: 'busy', step: 'starting', slow: 'still' })
    clock.advance(LONG_START_MS - STILL_STARTING_MS)
    expect(runner.state()).toMatchObject({ slow: 'long' })
    release()
    await pending
    expect(clock.pending.size).toBe(0)
  })

  test('cancel stops waiting and never reports a result later', async () => {
    const host = catalogHost().on('POST', invokePath, call => new Promise<Response>((_, reject) => {
      call.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
    }))
    const runner = createStartRunner({ fetch: host.fetch, scheduler: fakeScheduler().scheduler })
    const pending = runner.start(target)
    await Bun.sleep(0)
    runner.cancel()
    expect(await pending).toBeNull()
    expect(runner.state()).toEqual({ phase: 'idle' })
  })
})

describe('start failures are explicit', () => {
  quietConsole()
  const failed = (runner: { state(): StartState }) => runner.state() as Extract<StartState, { phase: 'failed' }>

  test('a Definition gone from this Workspace', async () => {
    const runner = createStartRunner({ fetch: catalogHost([]).fetch })
    expect(await runner.start(target)).toBeNull()
    expect(failed(runner)).toMatchObject({ key: 'row:supply-run', step: 'checking', text: 'This scenario is no longer in this Workspace.', action: 'check' })
    await runner.start({ ...target, featured: true })
    expect(failed(runner).text).toBe('This demo is not available in this Workspace right now.')
  })

  test('a missing or invalid primary Capability is an error, never a no-op', async () => {
    const missing = createStartRunner({ fetch: catalogHost(undefined, []).fetch })
    await missing.start(target)
    expect(failed(missing)).toMatchObject({ text: 'This scenario cannot be started right now.', action: 'try-again' })
    const invalid = createStartRunner({ fetch: catalogHost(undefined, [{ ...startCapability, risk: 'destructive' }]).fetch })
    await invalid.start(target)
    expect(failed(invalid).text).toBe('This scenario cannot be started right now.')
  })

  test('a failed Module outcome in the catalogue', async () => {
    const host = fakeFetch()
      .on('GET', definitionsPath, json({ workspaceId: WS, modules: [{ moduleId: 'world', status: 'failed', failure: { code: 'module_unavailable', message: 'World did not answer', retryable: true } }], definitions: [] }))
      .on('GET', capabilitiesPath, json({ workspaceId: WS, modules: ready, capabilities: [startCapability] }))
    const runner = createStartRunner({ fetch: host.fetch })
    await runner.start(target)
    expect(failed(runner)).toMatchObject({ text: 'Part of Leitbild is not responding right now. Try again in a moment.', action: 'try-again' })
  })

  test('an unknown outcome is never retried blindly', async () => {
    const runner = createStartRunner({ fetch: catalogHost().on('POST', invokePath, hostError(504, 'module_outcome_unknown', 'lost')).fetch })
    await runner.start(target)
    expect(failed(runner)).toMatchObject({ step: 'starting', action: 'check', text: 'The simulation may have started. Check Continue on this page before starting it again.' })
  })

  test('capacity asks to wait; other refusals keep their plain text and Try again restarts from the check', async () => {
    const busy = createStartRunner({ fetch: catalogHost().on('POST', invokePath, hostError(503, 'workspace_capacity_exceeded', 'full')).fetch })
    await busy.start(target)
    expect(failed(busy)).toMatchObject({ text: CAPACITY_TEXT, action: 'wait' })

    const host = catalogHost().on('POST', invokePath,
      hostError(409, 'run_limit', 'This Workspace already runs eight simulations.'),
      json({ result: {}, createdResources: [{ workspaceId: WS, moduleId: 'world', type: 'world.simulation-run', id: 'run-2' }] }, 201))
    const runner = createStartRunner({ fetch: host.fetch, scheduler: fakeScheduler().scheduler })
    await runner.start(target)
    expect(failed(runner)).toMatchObject({ text: 'This Workspace already runs eight simulations.', action: 'try-again' })
    expect(await runner.retry()).toEqual({ destination: `/workspaces/${WS}?world=run-2` })
    expect(host.calls.map(call => call.method)).toEqual(['GET', 'GET', 'POST', 'GET', 'GET', 'POST'])
    runner.dismiss()
  })
})
