import { newWorkspaceId,type WorkspaceId } from '@leitbild/contracts'
import { describe,expect,test } from 'bun:test'
import { access,mkdir,mkdtemp,readFile,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ActorId,
  InteractionSignal,
  SignalId,
  SimulationRunEvent,
  SimulationRunId,
} from '../src/core/model/index.ts'
import { deleteObjectCommandKind,nowIso,simulationRunIdSchema } from '../src/core/model/index.ts'
import { createSimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import type { SimulationRunRuntime } from '../src/core/simulation-runs/runtime.ts'
import { fixtureDataOf, fixturePackId } from './fixtures/fixture-pack.ts'
import { fixtureCommandIds, fixtureQueryIds } from './fixtures/fixture-runtime.ts'
import { responseScenario } from './fixtures/scenarios.ts'
import { createTestPackRuntimeAdapters,createTestScenarioRuntimeResolver,testScenarioAuthoring } from './helpers.ts'

const createRegistry = (dataDir: string, workspaceId: WorkspaceId = newWorkspaceId()) =>
  createSimulationRunRegistry({
    dataDir,
    workspaceId,
    scenarioRuntimeResolver: createTestScenarioRuntimeResolver(),
    ...testScenarioAuthoring(),
    runtimeAdapters: createTestPackRuntimeAdapters(),
  })

const simulationRunDir = (
  dataDir: string,
  workspaceId: WorkspaceId,
  simulationRunId: SimulationRunId,
): string => join(dataDir, 'workspaces', workspaceId, 'world', 'simulation-runs', simulationRunId)

const issueDispatchCommand = async (runtime: SimulationRunRuntime): Promise<void> => {
  const snapshot = runtime.snapshot()
  const unit = snapshot.objects.find(object =>
    object.kind === 'mobile_entity' && object.operational.status === 'available')
  const task = snapshot.objects.find(object => {
    if (object.packId !== fixturePackId) return false
    const data = fixtureDataOf(object)
    return data.type === 'task' && data.unitId === undefined
  })
  if (!unit || !task) throw new Error('Scenario missing an available unit or an unassigned task')
  const outcome = await runtime.invokeCapability(
    { id: 'actor:test-operator' as ActorId, label: 'Test Operator', role: 'operator' },
    {
      capabilityId: fixtureCommandIds.assign,
      input: { unitId: unit.id, taskId: task.id },
    },
  )
  expect(outcome.kind).toBe('command')
  if (outcome.kind !== 'command') throw new Error('expected command Capability result')
  expect(outcome.result.ok).toBe(true)
}

describe('Simulation Run registry', () => {
  test('starts with Scenario AI restrictions and lets a human replace them during the Run', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-agent-restrictions-'))
    const registry = createRegistry(dataDir)
    try {
      const run = await registry.create({ scenarioId: 'test-response' })
      const unit = run.snapshot().objects.find(object => object.packId === fixturePackId && object.kind === 'mobile_entity')!
      const operator = { id: 'actor:test-operator' as ActorId, label: 'Test Operator', role: 'operator' as const }
      const ai = { id: 'actor:test-ai' as ActorId, label: 'Test AI', role: 'ai_agent' as const }

      const restricted = await run.setAgentRestrictions(operator, {
        operationIds: [], objects: [{ objectId: unit.id, deny: ['inspect', 'change'] }],
      }, 0)
      expect(restricted).toMatchObject({ revision: 1, objects: [{ objectId: unit.id, deny: ['inspect', 'change'] }] })
      await expect(run.invokeCapability(ai, {
        capabilityId: fixtureQueryIds.object, input: { objectId: unit.id },
      })).rejects.toThrow(`AI inspect access is restricted for: ${unit.id}`)
      await expect(run.invokeCapability(ai, {
        capabilityId: deleteObjectCommandKind, input: { objectId: unit.id },
      })).rejects.toThrow(`AI change access is restricted for: ${unit.id}`)

      const cleared = await run.setAgentRestrictions(operator, { operationIds: [], objects: [] }, 1)
      expect(cleared).toEqual({ operationIds: [], objects: [], revision: 2 })
      expect((await run.invokeCapability(ai, {
        capabilityId: fixtureQueryIds.object, input: { objectId: unit.id },
      })).kind).toBe('query')
      await expect(run.setAgentRestrictions(ai, { operationIds: [], objects: [] }, 2))
        .rejects.toThrow('Only a human operator or system actor may replace Run AI restrictions')
    } finally { await registry.shutdown() }
  })

  test('execution status reopens an unloaded Run before reading its clock', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-execution-reopen-'))
    const registry = createRegistry(dataDir)
    try {
      const source = await registry.create({ scenarioId: 'test-response' })
      await source.setClock({ paused: false })
      await registry.close(source.id)
      expect(registry.get(source.id)).toBeUndefined()

      const execution = await registry.executionStatus(source.id)

      expect(execution).toMatchObject({ playback: 'playing', pace: 'realtime' })
      expect(registry.get(source.id)?.snapshot().clock).toMatchObject({ paused: false })
    } finally { await registry.shutdown() }
  })

  test('composes concurrent playback and pace commands without losing either axis', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-independent-execution-controls-'))
    const registry = createRegistry(dataDir)
    try {
      const run = await registry.create({ scenarioId: 'test-response' })

      await Promise.all([
        registry.setExecution(run.id, { playback: 'paused' }),
        registry.setExecution(run.id, { pace: 'maximum' }),
      ])

      expect(await registry.executionStatus(run.id)).toMatchObject({ playback: 'paused', pace: 'maximum' })
      await registry.setExecution(run.id, { pace: 'realtime' })
    } finally { await registry.shutdown() }
  })

  test('copies a coherent independent Run and fast-forwards it to an exact paused horizon', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-run-copy-'))
    const workspaceId = newWorkspaceId()
    const registry = createRegistry(dataDir, workspaceId)
    try {
      const source = await registry.create({ scenarioId: 'test-response' })
      await source.setClock({ paused: true })
      const restrictedObject = source.snapshot().objects[0]!
      await source.setAgentRestrictions(
        { id: 'actor:test-operator' as ActorId, label: 'Test Operator', role: 'operator' },
        { operationIds: ['world.simulation-run.scenario-source'], objects: [{ objectId: restrictedObject.id, deny: ['inspect'] }] },
        0,
      )
      const sourceBefore = structuredClone(source.snapshot())
      const copy = await registry.copy(source.id, { name: 'What-if' })
      await registry.advanceExecution(copy.id, { minutes: 0.01, onComplete: 'pause' })
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if ((await registry.executionStatus(copy.id)).acceleration?.status !== 'running') break
        await Bun.sleep(25)
      }
      const completed = await registry.executionStatus(copy.id)
      expect(completed.acceleration?.currentSimulationTime).toBe(completed.acceleration?.targetSimulationTime)
      expect(copy.snapshot().clock).toMatchObject({ paused: true, currentTime: completed.acceleration?.targetSimulationTime })
      expect(source.snapshot().clock?.currentTime).toBe(sourceBefore.clock?.currentTime)
      expect(source.snapshot().objects).toEqual(sourceBefore.objects)
      expect(copy.snapshot().scenario?.agentRestrictions).toEqual(sourceBefore.scenario?.agentRestrictions)
      expect((await registry.summary(copy.id)).title).toBe('What-if')
      const manifest = JSON.parse(await readFile(join(simulationRunDir(dataDir, workspaceId, copy.id), 'manifest.json'), 'utf8')) as { origin?: unknown }
      expect(manifest.origin).toMatchObject({ kind: 'copy', familyId: source.id, copyNumber: 1, sourceRunId: source.id, sourceSequence: sourceBefore.seq })
      // The copy's journal starts empty; it holds only the clock its own fast-forward stopped at.
      const journal = (await readFile(join(simulationRunDir(dataDir, workspaceId, copy.id), 'events.jsonl'), 'utf8'))
        .trim().split('\n').map(line => JSON.parse(line) as SimulationRunEvent)
      expect(journal.map(event => event.type === 'clock.updated' ? event.clock : event.type)).toEqual([
        { currentTime: completed.acceleration!.targetSimulationTime!, paused: true, updatedAt: expect.any(String) },
      ])
    } finally { await registry.shutdown() }
  })
  test('stops fast-forward without overshooting its current slice', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-fast-forward-pause-'))
    const registry = createRegistry(dataDir)
    try {
      const source = await registry.create({ scenarioId: 'test-response' })
      await source.setClock({ paused: true })
      const copy = await registry.copy(source.id, {})
      await registry.advanceExecution(copy.id, { minutes: 1, onComplete: 'pause' })
      await registry.setExecution(copy.id, { playback: 'paused' })
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if ((await registry.executionStatus(copy.id)).acceleration?.status !== 'running') break
        await Bun.sleep(25)
      }
      const paused = await registry.executionStatus(copy.id)
      expect(paused).toMatchObject({ playback: 'paused', pace: 'maximum', acceleration: { status: 'paused' } })
      expect(Date.parse(paused.currentSimulationTime)).toBeLessThan(Date.parse(paused.acceleration!.targetSimulationTime!))
      expect(copy.snapshot().clock).toMatchObject({ paused: true, currentTime: paused.currentSimulationTime })
      await registry.setExecution(copy.id, { playback: 'playing' })
      for (let attempt = 0; attempt < 240; attempt += 1) {
        if ((await registry.executionStatus(copy.id)).acceleration?.status !== 'running') break
        await Bun.sleep(25)
      }
      expect(await registry.executionStatus(copy.id)).toMatchObject({
        playback: 'paused', pace: 'realtime', acceleration: { status: 'completed' },
      })
    } finally { await registry.shutdown() }
  })
  test('copies a continuously fast-forwarding Run at a coherent boundary', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-copy-fast-forward-'))
    const registry = createRegistry(dataDir)
    try {
      const source = await registry.create({ scenarioId: 'test-response' })
      await registry.setExecution(source.id, { pace: 'maximum' })
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if ((await registry.executionStatus(source.id)).acceleration?.simulatedMs) break
        await Bun.sleep(10)
      }

      const copy = await registry.copy(source.id, { name: 'Live branch' })

      expect(await registry.executionStatus(source.id)).toMatchObject({ playback: 'playing', pace: 'maximum' })
      expect(await registry.executionStatus(copy.id)).toMatchObject({ playback: 'paused', pace: 'realtime' })
      expect(copy.snapshot().objects.length).toBeGreaterThan(0)
      await registry.setExecution(source.id, { playback: 'paused' })
    } finally { await registry.shutdown() }
  })
  test('fast-forwards an existing running Run and admits commands at exact step boundaries', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-in-place-fast-forward-'))
    const registry = createRegistry(dataDir)
    try {
      const runtime = await registry.create({ scenarioId: 'test-response' })
      expect(runtime.snapshot().clock?.paused).toBe(false)
      await registry.advanceExecution(runtime.id, { minutes: 1, onComplete: 'pause' })
      await expect(runtime.setClock({ paused: false })).rejects.toThrow('Pause maximum-pace')
      await issueDispatchCommand(runtime)
      await registry.setExecution(runtime.id, { playback: 'paused' })
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if ((await registry.executionStatus(runtime.id)).acceleration?.status !== 'running') break
        await Bun.sleep(10)
      }
      expect(await registry.executionStatus(runtime.id)).toMatchObject({ playback: 'paused', pace: 'maximum', acceleration: { status: 'paused' } })
      expect(runtime.snapshot().clock).toMatchObject({ paused: true })
    } finally { await registry.shutdown() }
  })
  test('continuous fast-forward remains fully operable and deletes a connected Plant at a shared boundary', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-fast-forward-delete-'))
    const registry = createRegistry(dataDir)
    try {
      const runtime = await registry.create({ scenarioId: 'halden-power-complex' })
      await registry.setExecution(runtime.id, { pace: 'maximum' })
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if ((await registry.executionStatus(runtime.id)).acceleration?.simulatedMs) break
        await Bun.sleep(10)
      }
      const before = await runtime.invokeCapability(
        { id: 'actor:test-operator' as ActorId, label: 'Test Operator', role: 'operator' },
        { capabilityId: 'world.electric-grid.connection-points.list', input: { gridId: 'grid:halden-four-unit' } },
      )
      expect((before.result as { connectionPoints: unknown[] }).connectionPoints).toHaveLength(4)

      const deletion = await runtime.invokeCapability(
        { id: 'actor:test-operator' as ActorId, label: 'Test Operator', role: 'operator' },
        { capabilityId: deleteObjectCommandKind, input: { objectId: 'plant:halden-1' } },
      )
      expect(deletion.kind === 'command' && deletion.result.ok).toBe(true)
      expect(runtime.snapshot().objects.some(object => object.id === 'plant:halden-1')).toBe(false)
      const after = await runtime.invokeCapability(
        { id: 'actor:test-operator' as ActorId, label: 'Test Operator', role: 'operator' },
        { capabilityId: 'world.electric-grid.connection-points.list', input: { gridId: 'grid:halden-four-unit' } },
      )
      const points = (after.result as { connectionPoints: ReadonlyArray<{ system: { objectId: string }; connected: boolean; systemActivePowerMw: number }> }).connectionPoints
      expect(points.find(point => point.system.objectId === 'plant:halden-1')).toMatchObject({ connected: false, systemActivePowerMw: 0 })
      expect(points.filter(point => point.connected)).toHaveLength(3)
      expect(await registry.executionStatus(runtime.id)).toMatchObject({ playback: 'playing', pace: 'maximum' })
      await registry.setExecution(runtime.id, { playback: 'paused' })
    } finally { await registry.shutdown() }
  })
  test('copy family identity and numbering survive deletion of the original Run', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-run-family-'))
    const workspaceId = newWorkspaceId()
    const registry = createRegistry(dataDir, workspaceId)
    try {
      const original = await registry.create({ scenarioId: 'test-response' })
      const first = await registry.copy(original.id, {})
      const second = await registry.copy(first.id, {})
      await registry.delete(original.id)
      const third = await registry.copy(second.id, {})
      const origins = await Promise.all([first.id, second.id, third.id].map(async id => {
        const manifest = JSON.parse(await readFile(join(simulationRunDir(dataDir, workspaceId, id), 'manifest.json'), 'utf8')) as { origin: { familyId: string; copyNumber: number } }
        return manifest.origin
      }))
      expect(origins).toEqual([
        expect.objectContaining({ familyId: original.id, copyNumber: 1 }),
        expect.objectContaining({ familyId: original.id, copyNumber: 2 }),
        expect.objectContaining({ familyId: original.id, copyNumber: 3 }),
      ])
    } finally { await registry.shutdown() }
  })
  test('deleting a fast-forwarding Run stops its work and removes all persisted state', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-delete-fast-forward-run-'))
    const workspaceId = newWorkspaceId()
    const registry = createRegistry(dataDir, workspaceId)
    try {
      const runtime = await registry.create({ scenarioId: 'test-response' })
      await registry.advanceExecution(runtime.id, { minutes: 10, onComplete: 'pause' })
      expect(await registry.delete(runtime.id)).toBe(true)
      expect(await registry.listKnown()).toEqual([])
      await expect(access(simulationRunDir(dataDir, workspaceId, runtime.id))).rejects.toThrow()
    } finally { await registry.shutdown() }
  })
  test('fast-forwards the coupled four-unit Plant, Grid, and Weather scenario through one Run boundary', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-fast-forward-halden-'))
    const registry = createRegistry(dataDir)
    try {
      const source = await registry.create({ scenarioId: 'halden-power-complex' })
      await source.setClock({ paused: true })
      const copy = await registry.copy(source.id, {})
      await registry.advanceExecution(copy.id, { minutes: 0.01, onComplete: 'pause' })
      for (let attempt = 0; attempt < 400; attempt += 1) {
        if ((await registry.executionStatus(copy.id)).acceleration?.status !== 'running') break
        await Bun.sleep(25)
      }
      expect(await registry.executionStatus(copy.id)).toMatchObject({ playback: 'paused', pace: 'realtime', acceleration: { status: 'completed' } })
      const snapshot = copy.snapshot()
      expect(snapshot.objects.filter(object => object.packId === 'process-plant' && object.kind === 'facility')).toHaveLength(4)
      expect(snapshot.objects.some(object => object.id === 'grid:halden-four-unit')).toBe(true)
      expect(snapshot.objects.some(object => object.id === 'weather:halden-complex')).toBe(true)
    } finally { await registry.shutdown() }
  })
  test('an unreadable compiled artifact does not hide healthy sibling Runs or rewrite retained state', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-run-unreadable-'))
    const workspaceId = newWorkspaceId()
    const registry = createRegistry(dataDir, workspaceId)
    const damaged = await registry.create({ scenarioId: 'test-response' })
    const healthy = await registry.create({ scenarioId: 'test-response' })
    await registry.close(damaged.id)
    await registry.close(healthy.id)
    const path = join(simulationRunDir(dataDir, workspaceId, damaged.id), 'compiled-scenario.json')
    await writeFile(path, '{"unsupported":true}')
    const reopened = createRegistry(dataDir, workspaceId)
    await reopened.summary(healthy.id)
    const summaries = await reopened.listKnown()
    expect(summaries.find(run => run.id === damaged.id)).toMatchObject({ loadError: expect.stringContaining('unreadable'), loaded: false })
    expect(summaries.find(run => run.id === healthy.id)).toMatchObject({ title: responseScenario.title, loaded: false })
    expect(summaries.find(run => run.id === healthy.id)?.loadError).toBeUndefined()
    await expect(reopened.load(damaged.id)).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe('{"unsupported":true}')
  })
  test('keeps independent names across conflicts, reset, template deletion and restart', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-run-names-'))
    const workspaceId = newWorkspaceId()
    const registry = createRegistry(dataDir, workspaceId)
    const first = await registry.create({ scenarioId: 'test-response' })
    const second = await registry.create({ scenarioId: 'test-response' })
    const manifestPath = join(simulationRunDir(dataDir, workspaceId, first.id), 'manifest.json')
    const manifest = await readFile(manifestPath, 'utf8')
    try {
      const results = await Promise.allSettled([
        registry.rename(first.id, 'Operations A', responseScenario.title),
        registry.rename(first.id, 'Operations B', responseScenario.title),
      ])
      expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
      expect((await registry.listKnown()).find(run => run.id === second.id)?.title).toBe(responseScenario.title)
      await registry.reset(first.id)
      expect((await registry.listKnown()).find(run => run.id === first.id)?.title).toBe('Operations A')
      expect(await readFile(manifestPath, 'utf8')).toBe(manifest)
    } finally {
      await registry.close(first.id)
      await registry.close(second.id)
    }
    const reopened = createRegistry(dataDir, workspaceId)
    expect((await reopened.listKnown()).find(run => run.id === first.id)).toMatchObject({ name: 'Operations A', title: 'Operations A', loaded: false })
    const source = await reopened.currentScenario('test-response')
    if (!source) throw new Error('missing test Scenario')
    const updated = await reopened.updateScenario({ ...source.document, title: 'New template title' }, source.id)
    expect(await reopened.deleteScenario('test-response', updated.id)).toBe(true)
    const restored = await reopened.rename(first.id, null, 'Operations A')
    expect(restored.title).toBe(responseScenario.title)
    expect(restored.name).toBeNull()
    expect(reopened.list()).toEqual([])
    expect((await createRegistry(dataDir, workspaceId).listScenarios()).some(scenario => scenario.id === 'test-response')).toBe(false)
    await reopened.delete(first.id)
    await expect(reopened.rename(first.id, 'Must not resurrect', responseScenario.title)).rejects.toThrow('not found')
    expect((await reopened.listKnown()).map(run => run.id)).toEqual([second.id])
  })

  test('creates an opaque server-owned id and an immutable resolved manifest', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-run-registry-'))
    const workspaceId = newWorkspaceId()
    const registry = createRegistry(dataDir, workspaceId)
    const runtime = await registry.create({ scenarioId: 'test-response' })
    try {
      expect(runtime.id).toMatch(/^run-[0-9a-f-]{36}$/)
      const manifest = JSON.parse(await readFile(
        join(simulationRunDir(dataDir, workspaceId, runtime.id), 'manifest.json'),
        'utf8',
      )) as {
        readonly id: string
        readonly workspaceId: string
        readonly scenario: { readonly id: string; readonly revisionId: string; readonly digest: string; readonly compiledDigest: string }
        readonly packs: ReadonlyArray<{ readonly id: string; readonly version: string }>
        readonly runtimes: ReadonlyArray<{ readonly id: string; readonly version: string; readonly clock: string }>
      }
      expect(manifest.id).toBe(runtime.id)
      expect(manifest.workspaceId).toBe(workspaceId)
      expect(manifest.scenario.id).toBe('test-response')
      expect(manifest.scenario.revisionId).toMatch(/^revision-[a-f0-9]{32}$/)
      expect(manifest.scenario.digest).toMatch(/^[a-f0-9]{64}$/)
      expect(manifest.scenario.compiledDigest).toMatch(/^[a-f0-9]{64}$/)
      expect(manifest.packs.every(pack => pack.version.length > 0)).toBe(true)
      expect(manifest.runtimes.every(adapter => adapter.version.length > 0)).toBe(true)
      expect(manifest.runtimes.map(adapter => adapter.clock).sort()).toEqual(['simulation', 'simulation'])
      const compiledScenario = JSON.parse(await readFile(
        join(simulationRunDir(dataDir, workspaceId, runtime.id), 'compiled-scenario.json'),
        'utf8',
      )) as { readonly id: string }
      expect(compiledScenario.id).toBe(manifest.scenario.id)
    } finally {
      await registry.close(runtime.id)
    }
  })

  test('keeps mutable state isolated between Simulation Runs', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-run-registry-'))
    const registry = createRegistry(dataDir)
    const changed = await registry.create({ scenarioId: 'test-response' })
    const untouched = await registry.create({ scenarioId: 'test-response' })
    try {
      await issueDispatchCommand(changed)
      // The core deletion veto asks the Pack runtime before an assigned task goes.
      const assignedTask = changed.snapshot().objects.find(object => {
        if (object.packId !== fixturePackId) return false
        const data = fixtureDataOf(object)
        return data.type === 'task' && data.unitId !== undefined
      })
      if (!assignedTask) throw new Error('dispatch left no assigned task')
      const vetoed = await changed.invokeCapability(
        { id: 'actor:test-operator' as ActorId, label: 'Test Operator', role: 'operator' },
        { capabilityId: deleteObjectCommandKind, input: { objectId: assignedTask.id } },
      )
      expect(vetoed).toMatchObject({ kind: 'command', result: { ok: false, reason: expect.stringContaining('is assigned to') } })
      expect(changed.snapshot().objects.some(object => object.id === assignedTask.id)).toBe(true)
      expect(changed.snapshot().seq).toBeGreaterThan(untouched.snapshot().seq)
      expect(untouched.snapshot().objects).toHaveLength(responseScenario.initialObjects.length)
      expect(untouched.snapshot().objects.find(object => object.id === 'unit:a12')?.operational.status).toBe('available')
    } finally {
      await registry.close(changed.id)
      await registry.close(untouched.id)
    }
  })

  test('loads a persisted run by its opaque id and coalesces loaded joins', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-run-registry-'))
    const workspaceId = newWorkspaceId()
    const firstRegistry = createRegistry(dataDir, workspaceId)
    const first = await firstRegistry.create({ scenarioId: 'test-response' })
    const id = first.id
    await issueDispatchCommand(first)
    await first.setClock({ paused: true })
    const expectedSeq = first.snapshot().seq
    await firstRegistry.close(id)

    const secondRegistry = createRegistry(dataDir, workspaceId)
    const [loaded, joined] = await Promise.all([secondRegistry.load(id), secondRegistry.load(id)])
    try {
      expect(joined).toBe(loaded)
      expect(loaded.snapshot().seq).toBe(expectedSeq)
      expect(loaded.events().some(event => event.type === 'command.issued')).toBe(true)
      expect(secondRegistry.list()).toEqual([loaded])
    } finally {
      await secondRegistry.close(id)
    }
  })

  test('reset preserves the pinned Scenario Revision and restores its initial state', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-run-registry-'))
    const workspaceId = newWorkspaceId()
    const registry = createRegistry(dataDir, workspaceId)
    const before = await registry.create({ scenarioId: 'test-response' })
    const id = before.id
    const manifestPath = join(simulationRunDir(dataDir, workspaceId, id), 'manifest.json')
    const manifestBefore = await readFile(manifestPath, 'utf8')
    await issueDispatchCommand(before)

    const after = await registry.reset(id)
    try {
      expect(after).not.toBe(before)
      expect(after.snapshot().scenario?.scenarioId).toBe('test-response')
      expect(after.snapshot().objects.some(object => object.id === 'site:north')).toBe(true)
      expect(await readFile(manifestPath, 'utf8')).toBe(manifestBefore)
    } finally {
      await registry.close(id)
    }
  })

  test('lists unloaded runs with pinned revision metadata', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-run-registry-'))
    const workspaceId = newWorkspaceId()
    const firstRegistry = createRegistry(dataDir, workspaceId)
    const runtime = await firstRegistry.create({ scenarioId: 'test-response' })
    const id = runtime.id
    const snapshotSeq = runtime.snapshot().seq
    await firstRegistry.close(id)

    const known = await createRegistry(dataDir, workspaceId).listKnown()
    expect(known).toEqual([expect.objectContaining({
      id,
      scenarioId: 'test-response',
      scenarioRevisionId: expect.stringMatching(/^revision-/),
      createdAt: expect.any(String),
      loaded: false,
      snapshotSeq: expect.any(Number),
      objectCount: responseScenario.initialObjects.length,
    })])
    expect(known[0]!.snapshotSeq).toBeGreaterThanOrEqual(snapshotSeq)
  })

  test('deletes loaded and persisted state immediately', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-run-registry-'))
    const workspaceId = newWorkspaceId()
    const registry = createRegistry(dataDir, workspaceId)
    const runtime = await registry.create({ scenarioId: 'test-response' })
    const id = runtime.id
    const runDir = simulationRunDir(dataDir, workspaceId, id)

    expect(await registry.delete(id)).toBe(true)
    await expect(access(runDir)).rejects.toThrow()
    expect(registry.get(id)).toBeUndefined()
    expect(await registry.listKnown()).toEqual([])
    expect(await registry.delete(id)).toBe(false)
  })

  test('reports orphan run directories and refuses to invent their identity', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-run-registry-'))
    const workspaceId = newWorkspaceId()
    const id = simulationRunIdSchema.parse('run-orphan')
    await mkdir(simulationRunDir(dataDir, workspaceId, id), { recursive: true })
    const registry = createRegistry(dataDir, workspaceId)

    expect(await registry.listKnown()).toEqual([expect.objectContaining({
      id,
      scenarioId: null,
      scenarioRevisionId: null,
      loadError: 'Simulation Run Manifest is missing',
    })])
    await expect(registry.load(id)).rejects.toThrow(`Simulation Run not found: ${id}`)
  })

  test('fails visibly for a corrupt snapshot instead of resetting it', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-run-registry-'))
    const workspaceId = newWorkspaceId()
    const firstRegistry = createRegistry(dataDir, workspaceId)
    const runtime = await firstRegistry.create({ scenarioId: 'test-response' })
    const id = runtime.id
    await firstRegistry.close(id)
    await writeFile(join(simulationRunDir(dataDir, workspaceId, id), 'snapshot.json'), '{', 'utf8')

    const secondRegistry = createRegistry(dataDir, workspaceId)
    await expect(secondRegistry.load(id)).rejects.toThrow('Simulation Run snapshot is unreadable')
    expect(await secondRegistry.listKnown()).toEqual([expect.objectContaining({
      id,
      loadError: expect.any(String),
    })])
  })

  test('lists Run resources without parsing their authored revision bodies', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-run-registry-'))
    const workspaceId = newWorkspaceId()
    const registry = createRegistry(dataDir, workspaceId)
    const runtime = await registry.create({ scenarioId: 'test-response' })
    const id = runtime.id
    await registry.close(id)
    const manifest = JSON.parse(await readFile(
      join(simulationRunDir(dataDir, workspaceId, id), 'manifest.json'),
      'utf8',
    )) as { readonly scenario: { readonly revisionId: string } }
    const revisionPath = join(
      dataDir,
      'workspaces',
      workspaceId,
      'world',
      'scenarios',
      'revisions',
      `${manifest.scenario.revisionId}.json`,
    )
    const revision = JSON.parse(await readFile(revisionPath, 'utf8')) as { document: Record<string, unknown> }
    revision.document = { id: 'invalid-pinned-scenario' }
    await writeFile(revisionPath, `${JSON.stringify(revision)}\n`, 'utf8')

    expect(await registry.listKnown()).toEqual([expect.objectContaining({
      id,
      scenarioId: 'test-response',
      scenarioTitle: 'Response fixture',
    })])
  })

  test('fails visibly when pinned Pack versions are unavailable', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-run-registry-'))
    const workspaceId = newWorkspaceId()
    const firstRegistry = createRegistry(dataDir, workspaceId)
    const runtime = await firstRegistry.create({ scenarioId: 'test-response' })
    const id = runtime.id
    await firstRegistry.close(id)
    const manifestPath = join(simulationRunDir(dataDir, workspaceId, id), 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      packs: Array<{ id: string; version: string }>
      [key: string]: unknown
    }
    if (!manifest.packs[0]) throw new Error('expected resolved Pack')
    manifest.packs[0].version = '99.0.0'
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

    await expect(createRegistry(dataDir, workspaceId).load(id)).rejects.toThrow('Pack version mismatch')
  })

  test('rejects a modified compiled Scenario artifact', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-run-registry-'))
    const workspaceId = newWorkspaceId()
    const firstRegistry = createRegistry(dataDir, workspaceId)
    const runtime = await firstRegistry.create({ scenarioId: 'test-response' })
    const id = runtime.id
    await firstRegistry.close(id)
    const compiledPath = join(simulationRunDir(dataDir, workspaceId, id), 'compiled-scenario.json')
    const compiled = JSON.parse(await readFile(compiledPath, 'utf8')) as { title: string; [key: string]: unknown }
    compiled.title = 'Modified after Run creation'
    await writeFile(compiledPath, `${JSON.stringify(compiled, null, 2)}\n`, 'utf8')

    await expect(createRegistry(dataDir, workspaceId).load(id))
      .rejects.toThrow('Compiled Scenario integrity mismatch')
  })

  test('rejects cross-run interaction signals', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-run-registry-'))
    const registry = createRegistry(dataDir)
    const runtime = await registry.create({ scenarioId: 'test-response' })
    try {
      const beforeCount = runtime.events().length
      const signal: InteractionSignal = {
        id: `signal:${crypto.randomUUID()}` as SignalId,
        simulationRunId: simulationRunIdSchema.parse('run-other'),
        at: nowIso(),
        source: { kind: 'actor', id: 'actor:test-operator' as ActorId },
        targets: [{ kind: 'broadcast' }],
        type: 'test.signal',
        payload: {},
      }
      await expect(runtime.publishInteractionSignal(signal, { source: 'operator' }))
        .rejects.toThrow('interaction signal simulation run mismatch')
      expect(runtime.events()).toHaveLength(beforeCount)
    } finally {
      await registry.close(runtime.id)
    }
  })

  test('rejects an event log containing another run id', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-run-registry-'))
    const workspaceId = newWorkspaceId()
    const firstRegistry = createRegistry(dataDir, workspaceId)
    const runtime = await firstRegistry.create({ scenarioId: 'test-response' })
    const id = runtime.id
    await issueDispatchCommand(runtime)
    const events = runtime.events()
    if (!events[0]) throw new Error('expected persisted event')
    await firstRegistry.close(id)
    const wrongEvent: SimulationRunEvent = {
      ...events[0],
      simulationRunId: simulationRunIdSchema.parse('run-other'),
    }
    await writeFile(
      join(simulationRunDir(dataDir, workspaceId, id), 'events.jsonl'),
      `${JSON.stringify(wrongEvent)}\n`,
      'utf8',
    )

    await expect(createRegistry(dataDir, workspaceId).load(id))
      .rejects.toThrow('event log simulation run mismatch')
  })
})


test('pause control retains simulation progress', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-weather-clock-'))
  const registry = createRegistry(dataDir)
  const runtime = await registry.create({ scenarioId: 'test-response' })
  try {
    await runtime.setClock({ paused: true })
    const before = runtime.snapshot().clock
    expect(runtime.snapshot().clock?.currentTime).toBe(before?.currentTime)
    expect(runtime.snapshot().clock?.paused).toBe(true)
  } finally { await registry.close(runtime.id) }
})
