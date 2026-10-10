import { expect, test, spyOn } from 'bun:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { Database } from 'bun:sqlite'
import type { PackRuntimeConnectionConfig } from '../src/simulation/protocol.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { createManualIdleTimer, createTestPackRuntimeAdapters, createTestScenarioRuntimeResolver, testScenarioAuthoring, waitForCondition } from './helpers.ts'
import { createRuntimeHub } from '../src/simulation/runtime-hub.ts'
import { electricalPortsFromObject } from '../src/core/model/electrical.ts'
import { testScenarioDefinitions } from './fixtures/scenarios.ts'

const workspaceId = 'bc98c19c-af60-442b-b65a-6d0a1975cba3' as never
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }

test('shutdown waits for healthy sibling checkpoints before reporting a failed Run close', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'world-shutdown-drain-'))
  const registry = createSimulationRunRegistry({ dataDir, workspaceId, ...testScenarioAuthoring(), runtimeAdapters: createTestPackRuntimeAdapters(), scenarioRuntimeResolver: createTestScenarioRuntimeResolver(), idleRuntimeCloseDelayMs: -1 })
  const first = await registry.create({ scenarioId: 'test-response' })
  const second = await registry.create({ scenarioId: 'test-response' })
  const gate = deferred(), entered = deferred()
  const originalClose = second.close
  const failure = spyOn(first, 'close').mockRejectedValue(new Error('Checkpoint failure'))
  const delayed = spyOn(second, 'close').mockImplementation(async () => { entered.resolve(); await gate.promise; await originalClose() })
  let settled = false
  const closing = registry.shutdown().then(() => { settled = true; return null }, error => { settled = true; return error })
  try {
    await entered.promise
    await Bun.sleep(5)
    expect(settled).toBe(false)
    gate.resolve()
    expect(await closing).toBeInstanceOf(AggregateError)
    expect(registry.get(second.id)).toBeUndefined()
  } finally {
    gate.resolve()
    await closing
    failure.mockRestore(); delayed.mockRestore()
    await registry.shutdown()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('damaged optional history does not prevent checkpoint restore or masquerade as empty history', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'run-unavailable-history-'))
  const registry = createSimulationRunRegistry({ dataDir, workspaceId, ...testScenarioAuthoring(), runtimeAdapters: createTestPackRuntimeAdapters(), scenarioRuntimeResolver: createTestScenarioRuntimeResolver(), idleRuntimeCloseDelayMs: -1 })
  try {
    const run = await registry.create({ scenarioId: 'test-response' })
    const objectIds = run.snapshot().objects.map(object => object.id)
    await registry.close(run.id)
    const path = join(dataDir, 'workspaces', workspaceId, 'world', 'simulation-runs', run.id, 'history.sqlite')
    const damaged = new Database(path)
    damaged.exec('DROP TABLE recording_samples')
    damaged.close()
    const original = await readFile(path)
    const restored = await registry.load(run.id)
    expect(restored.snapshot().objects.map(object => object.id)).toEqual(objectIds)
    expect(restored.recordingStatus()).toMatchObject({ captureState: 'unavailable', sampleCount: null, lastError: expect.stringContaining('recording_samples') })
    expect(() => restored.recordedSamples({ mode: 'raw' })).toThrow('Historian unavailable')
    await restored.setClock({ paused: false })
    await registry.close(run.id)
    expect(await readFile(path)).toEqual(original)
  } finally { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) }
})

test('regression: deleting during cold load does not resurrect a deleted Run', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'audit-run-race-'))
  const entered = deferred(), gate = deferred()
  let delay = false
  const adapters = createTestPackRuntimeAdapters().map(adapter => ({ ...adapter, connect: async (config: PackRuntimeConnectionConfig) => {
    const connection = await adapter.connect(config)
    if (delay) { entered.resolve(); await gate.promise }
    return connection
  }}))
  const registry = createSimulationRunRegistry({ dataDir, workspaceId, ...testScenarioAuthoring(), runtimeAdapters: adapters, scenarioRuntimeResolver: createTestScenarioRuntimeResolver(), idleRuntimeCloseDelayMs: -1 })
  try {
    const first = await registry.create({ scenarioId: 'test-response' })
    await registry.close(first.id)
    delay = true
    const loading = registry.load(first.id)
    await entered.promise
    const deleting = registry.delete(first.id)
    gate.resolve()
    const deleted = await deleting
    await loading
    const loadedAfterDelete = registry.get(first.id) !== undefined
    expect(deleted).toBe(true)
    expect(loadedAfterDelete).toBe(false)
  } finally { gate.resolve(); for(const run of registry.list()) await registry.close(run.id); await rm(dataDir,{recursive:true,force:true}) }
})

test('regression: failed initial snapshot closes successful Pack connections', async () => {
  let closes = 0
  const hub = createRuntimeHub([{ id:'audit',version:'1.0.0',packId:'audit',clock:'simulation',capabilities:[],connect:async()=>({getSnapshot:async()=>{throw new Error('snapshot failure')},close:async()=>{closes++}} as never) }])
  await expect(hub.connect({ simulationRunId:'run-audit' as never,scenario:{scenarioId:'audit',runtimeIds:['audit'],world:{startsAt:'2026-01-01T00:00:00.000Z' as never,environment:{}},initialObjects:[],connections:[],runtimeConfig:{}} })).rejects.toThrow('snapshot failure')
  expect(closes).toBe(1)
})

test('regression: pause longer than peer TTL preserves electrical connection on resume', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'audit-paused-grid-'))
  const registry = createSimulationRunRegistry({ dataDir,workspaceId,...testScenarioAuthoring(),runtimeAdapters:createTestPackRuntimeAdapters(),scenarioRuntimeResolver:createTestScenarioRuntimeResolver(),idleRuntimeCloseDelayMs:-1 })
  try {
    const run = await registry.create({scenarioId:'halden-power-complex'})
    // Each Pack tick commits events and exchanges connection states; a loaded machine delays ticks, so wait for them.
    const ticked = (label: string, afterSeq: number) => waitForCondition(label, () => run.snapshot().seq > afterSeq, { timeoutMs: 20_000 })
    await Bun.sleep(2100)
    await ticked('Packs observe one another before the pause', 0)
    await run.setClock({paused:true})
    const states = () => run.snapshot().objects.flatMap(o=>electricalPortsFromObject(o).map(p=>({object:o.id,port:p.id,state:p.state})))
    const before = states()
    await Bun.sleep(5500) // The property: a wall-clock pause longer than the former 5 s peer TTL.
    await run.setClock({paused:false})
    const resumedSeq = run.snapshot().seq
    await Bun.sleep(2200)
    await ticked('Packs tick after resuming', resumedSeq)
    await run.setClock({paused:true})
    expect(before).toHaveLength(8)
    expect(before.every(p => p.state?.connected === true)).toBe(true)
    expect(states().every(p => p.state?.connected === true)).toBe(true)
  } finally { for(const run of registry.list())await registry.close(run.id);await rm(dataDir,{recursive:true,force:true}) }
},60_000) // A watchdog: at load 100 creating the four-unit Run alone takes seconds.

test('regression: API-only run lifetime honors idle policy and recent access', async () => {
  const dataDir = await mkdtemp(join(tmpdir(),'audit-run-leases-'))
  const idle = createManualIdleTimer()
  const registry = createSimulationRunRegistry({dataDir,workspaceId,...testScenarioAuthoring(),runtimeAdapters:createTestPackRuntimeAdapters(),scenarioRuntimeResolver:createTestScenarioRuntimeResolver(),idleRuntimeCloseDelayMs:80,idleRuntimeCloseTimer:idle.arm})
  try {
    const run=await registry.create({scenarioId:'test-response'})
    await idle.advance(80)
    const stillLoadedWithoutLeases=registry.get(run.id)!==undefined
    await registry.load(run.id)
    const release=registry.acquireLease(run.id,'realtime')
    release()
    await idle.advance(55)
    await registry.load(run.id)
    await idle.advance(55)
    const loadedAfterRecentLoad=registry.get(run.id)!==undefined
    expect(stillLoadedWithoutLeases).toBe(false)
    expect(loadedAfterRecentLoad).toBe(true)
  } finally {for(const run of registry.list())await registry.close(run.id);await rm(dataDir,{recursive:true,force:true})}
})

test('regression: unrelated observation does not clear health during a persistent runtime fault', async () => {
  const adapter = { id:'audit.health',version:'1.0.0',packId:'audit',clock:'none',capabilities:[{id:'world.audit.status',kind:'query'}],connect:async(config:any)=>({
    getSnapshot:async()=>({simulationRunId:config.simulationRunId,objects:[],capturedAt:'2026-09-02T00:00:00.000Z'}),
    subscribe:()=>()=>{},close:async()=>{},observeCommittedEvents:async()=>{},setClock:async()=>{},invokeQuery:async()=>{throw new Error('solver permanently stopped')},
  })}
  const hub = await createRuntimeHub([adapter as never]).connect({simulationRunId:'audit-health' as never,scenario:{scenarioId:'audit',runtimeIds:[adapter.id],world:{startsAt:'2026-09-02T00:00:00.000Z' as never,environment:{}},initialObjects:[],connections:[],runtimeConfig:{}}})
  try {
    await expect(hub.invokeQuery({capabilityId:'world.audit.status',input:{}})).rejects.toThrow('solver permanently stopped')
    expect(hub.health?.()[0]?.state).toBe('degraded')
    await hub.observeCommittedEvents([])
    expect(hub.health?.()[0]?.state).toBe('degraded')
    await expect(hub.invokeQuery({capabilityId:'world.audit.status',input:{}})).rejects.toThrow('solver permanently stopped')
  } finally {await hub.close()}
})

test('boundary: Save still rejects a separate unfinished cue after another cue is fixed',async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'audit-editor-'))
  const registry=createSimulationRunRegistry({dataDir,workspaceId,...testScenarioAuthoring(),runtimeAdapters:createTestPackRuntimeAdapters(),scenarioRuntimeResolver:createTestScenarioRuntimeResolver()})
  try {
    const source=structuredClone(testScenarioDefinitions.find(source=>source.id==='test-response')!)
    const validCue={id:'fixed-cue',at:{kind:'after_scenario_start',seconds:60},actions:[{type:'clear_highlights'}]}
    const unfinishedCue={id:'unfinished-cue',at:{kind:'after_scenario_start',seconds:120},actions:[]}
    await expect(registry.previewScenario({...source,timeline:{cues:[validCue,unfinishedCue]}} as never)).rejects.toThrow()
    await expect(registry.previewScenario({...source,timeline:{cues:[validCue]}} as never)).resolves.toBeDefined()
  } finally {await rm(dataDir,{recursive:true,force:true})}
})

test('request and explicit background ownership protect a Run until released', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'run-ownership-'))
  const idle = createManualIdleTimer()
  const registry = createSimulationRunRegistry({ dataDir, workspaceId, ...testScenarioAuthoring(), runtimeAdapters: createTestPackRuntimeAdapters(), scenarioRuntimeResolver: createTestScenarioRuntimeResolver(), idleRuntimeCloseDelayMs: 40, idleRuntimeCloseTimer: idle.arm })
  try {
    const run = await registry.create({ scenarioId: 'test-response' })
    const release = registry.acquireLease(run.id, 'api')
    await expect(registry.delete(run.id)).rejects.toThrow('active requests')
    await expect(registry.reset(run.id)).rejects.toThrow('active requests')
    await idle.advance(80)
    expect(registry.get(run.id)).toBe(run)
    await registry.setBackgroundExecution(run.id, true)
    release()
    await idle.advance(80)
    expect(registry.get(run.id)).toBe(run)
    expect(registry.leaseSummary(run.id).leasesByKind.background).toBe(1)
    await registry.setBackgroundExecution(run.id, false)
    await idle.advance(39)
    expect(registry.get(run.id)).toBe(run)
    await idle.advance(1)
    expect(registry.get(run.id)).toBeUndefined()
  } finally { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) }
})
