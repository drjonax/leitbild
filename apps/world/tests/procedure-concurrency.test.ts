import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newWorkspaceId } from '@leitbild/contracts'
import { actorIdSchema, deleteObjectCommandKind, type SimulationRunEvent } from '../src/core/model/index.ts'
import { createSimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { createSimulationRunStateStore } from '../src/core/simulation-runs/state-store.ts'
import { createSimulationRunRealtimeManager } from '../src/core/api/realtime.ts'
import { createLocalWeatherPackRuntimeAdapter } from '../src/packs/weather/sim/adapter.ts'
import { createFixturePackRuntimeAdapter } from './fixtures/fixture-runtime.ts'
import { createTestScenarioRuntimeResolver, testScenarioAuthoring } from './helpers.ts'
import { deferred, procedureTestCatalog, procedureTestDocument, procedureTestSource } from './procedure-fixtures.ts'
import type { ProcedureSourceService } from '../src/features/procedures/source.ts'
import { procedureRunFor } from '../src/ui/procedures/procedure-run-selectors.ts'

describe('procedure commands through the real publish queue and realtime projection', () => {
  test('two operators, transactional transitions, reset/deletion races, and durable restore', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-procedure-concurrency-'))
    const actorA = { id: actorIdSchema.parse('operator:a'), label: 'A', role: 'operator' as const }
    const actorB = { id: actorIdSchema.parse('operator:b'), label: 'B', role: 'operator' as const }
    let readDocument: ProcedureSourceService['readDocument'] = async input => procedureTestDocument(input.procedureId, input.sourceRevision)
    const registry = createSimulationRunRegistry({
      dataDir, workspaceId: newWorkspaceId(), scenarioRuntimeResolver: createTestScenarioRuntimeResolver(), ...testScenarioAuthoring(),
      runtimeAdapters: [
        createFixturePackRuntimeAdapter(),
        createLocalWeatherPackRuntimeAdapter(),
      ],
      procedureSourceService: { listSources: () => [], readCatalog: async () => procedureTestCatalog(), readDocument: async input => await readDocument(input), readEvidence: async () => { throw new Error('No retained evidence in this concurrency fixture') } },
    })
    const runtime = await registry.create({ scenarioId: 'test-response' })
    const clients = [createSimulationRunStateStore(), createSimulationRunStateStore()]
    const batches: ReadonlyArray<SimulationRunEvent>[] = []
    const realtime = createSimulationRunRealtimeManager<(typeof clients)[number]>({ registry,
      send: (client, message) => {
        if (message.type === 'events') { batches.push(message.events); for (const event of message.events) client.apply(event) }
      }, sendReady: () => {} })
    const unit = runtime.snapshot().objects.find(object => object.id.startsWith('unit:'))!
    const scope = { plantId: unit.id, targetObjectId: unit.id }
    const startInput = { sourceId: procedureTestSource.sourceId, sourceRevision: procedureTestSource.revision, procedureId: 'E-0', scope }
    const command = async (id: string, input: unknown, actor = actorA) => {
      const result = await runtime.invokeCapability(actor, { capabilityId: id, input })
      if (result.kind !== 'command') throw new Error('expected command')
      return result.result
    }
    const mustCommand = async (id: string, input: unknown, actor = actorA) => {
      const result = await command(id, input, actor)
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(result.reason)
    }
    const reset = () => mustCommand('world.procedure.run.reset', { ...startInput, scope: { plantId: scope.plantId } })
    const current = () => runtime.snapshot().procedures!.runs.find(run => run.procedureId === 'E-0')!
    try {
      await runtime.setClock({ paused: true })
      for (const client of clients) { client.hydrate(runtime.snapshot()); realtime.addClient(runtime.id, client) }

      // Both requests prepare against the same state. Only one may commit a new Run.
      const gate = deferred<void>()
      const bothReading = deferred<void>()
      let reads = 0
      readDocument = async input => { if (++reads === 2) bothReading.resolve(); await gate.promise; return procedureTestDocument(input.procedureId) }
      const a = command('world.procedure.run.start', startInput)
      const b = command('world.procedure.run.start', startInput, actorB)
      await bothReading.promise
      gate.resolve()
      const results = await Promise.all([a, b])
      expect(results.filter(result => result.ok)).toHaveLength(1)
      expect(runtime.snapshot().procedures?.runs).toHaveLength(1)
      readDocument = async input => procedureTestDocument(input.procedureId, input.sourceRevision)

      expect((await command('world.procedure.run.start', { ...startInput, scope: { plantId: unit.id } }, actorB)).ok).toBe(false)
      expect(procedureRunFor(runtime.snapshot().procedures!.runs, { sourceId: startInput.sourceId,
        procedureId: startInput.procedureId, scope: { plantId: unit.id } })?.runId).toBe(current().runId)
      expect((await command('world.procedure.run.start', { ...startInput,
        scope: { plantId: unit.id, targetObjectId: 'plant:other' } }, actorB)).ok).toBe(false)

      await mustCommand('world.procedure.step.update', { runId: current().runId, stepId: 'second', currentStepId: 'second', assessment: 'complete' }, actorA)
      await mustCommand('world.procedure.step.update', { runId: current().runId, stepId: 'first', comment: 'Operator B note', favorite: true }, actorB)
      expect(current().currentStepId).toBe('second')
      for (const client of clients) {
        expect(client.snapshot().procedures).toEqual(runtime.snapshot().procedures)
        expect(client.snapshot().procedures?.runs[0]?.stepStates.find(step => step.stepId === 'second')?.assessment).toBe('complete')
      }

      // Fetch failure cannot leave the source half-completed.
      readDocument = async input => { if (input.procedureId === 'TARGET') throw new Error('source unavailable'); return procedureTestDocument(input.procedureId) }
      const before = runtime.snapshot().procedures
      expect((await command('world.procedure.run.transition', { runId: current().runId, stepId: 'first', branchIndex: 0 })).ok).toBe(false)
      expect(runtime.snapshot().procedures).toEqual(before)
      readDocument = async input => procedureTestDocument(input.procedureId, input.sourceRevision)
      expect((await command('world.procedure.run.transition', { runId: current().runId, stepId: 'second', branchIndex: 999 })).ok).toBe(false)

      const batchStart = batches.length
      await mustCommand('world.procedure.run.transition', { runId: current().runId, stepId: 'first', branchIndex: 0 })
      expect(current().status).toBe('transferred')
      expect(current().currentStepId).toBe('first')
      expect(current().stepStates.find(step => step.stepId === 'first')?.assessment).toBe('blank')
      expect(runtime.snapshot().procedures?.runs.find(run => run.procedureId === 'TARGET')?.status).toBe('active')
      const transitionBatches = batches.slice(batchStart).filter(batch => batch.some(event => event.type === 'procedure.run.closed'))
      expect(transitionBatches).toHaveLength(2) // one batch per subscriber
      expect(transitionBatches[0]?.map(event => event.type)).toEqual(['procedure.run.started', 'procedure.branch.selected', 'procedure.step.updated', 'procedure.run.closed'])

      // Reusing an already active target does not create a duplicate.
      await reset(); await mustCommand('world.procedure.run.start', startInput)
      await mustCommand('world.procedure.run.transition', { runId: current().runId, stepId: 'first', branchIndex: 0 })
      expect(runtime.snapshot().procedures?.runs.filter(run => run.procedureId === 'TARGET')).toHaveLength(1)
      const target = runtime.snapshot().procedures!.runs.find(run => run.procedureId === 'TARGET')!
      await mustCommand('world.procedure.run.close', { runId: target.runId, status: 'completed' })
      await reset(); await mustCommand('world.procedure.run.start', startInput)
      const beforeCompletedTarget = runtime.snapshot().procedures
      expect((await command('world.procedure.run.transition', { runId: current().runId, stepId: 'first', branchIndex: 0 })).ok).toBe(false)
      expect(runtime.snapshot().procedures).toEqual(beforeCompletedTarget)

      // Reset can commit while a document is still being fetched; stale updates cannot resurrect it.
      const delayed = deferred<void>()
      const reading = deferred<void>()
      readDocument = async input => { reading.resolve(); await delayed.promise; return procedureTestDocument(input.procedureId) }
      const update = command('world.procedure.step.update', { runId: current().runId, stepId: 'second', assessment: 'complete' })
      await reading.promise
      await reset()
      delayed.resolve()
      expect((await update).ok).toBe(false)
      expect(current()).toBeUndefined()

      // Deleting the target asset while start is preparing also prevents resurrection.
      const startGate = deferred<void>()
      const starting = deferred<void>()
      readDocument = async input => { starting.resolve(); await startGate.promise; return procedureTestDocument(input.procedureId) }
      const pendingStart = command('world.procedure.run.start', startInput)
      await starting.promise
      await mustCommand(deleteObjectCommandKind, { objectId: unit.id })
      startGate.resolve()
      expect((await pendingStart).ok).toBe(false)
      expect(runtime.snapshot().procedures?.runs).toEqual([])
      for (const client of clients) expect(client.snapshot().procedures).toEqual(runtime.snapshot().procedures)

      const state = runtime.snapshot()
      await registry.close(runtime.id)
      const restored = await registry.load(runtime.id)
      expect(restored.snapshot().procedures).toEqual(state.procedures)
      const events = restored.events()
      expect(events.every((event, index) => index === 0 || event.seq > events[index - 1]!.seq)).toBe(true)
    } finally {
      for (const client of clients) realtime.removeClient(runtime.id, client)
      await registry.close(runtime.id)
      await rm(dataDir, { recursive: true, force: true }) // only this test's mkdtemp directory
    }
  })
})
