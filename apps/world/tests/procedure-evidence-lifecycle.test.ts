import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newWorkspaceId } from '@leitbild/contracts'
import { createKnowledge } from '@leitbild/knowledge'
import { actorIdSchema, deleteObjectCommandKind, type ProcedureRunState } from '../src/core/model/index.ts'
import type { Actor } from '../src/core/simulation-runs/actors.ts'
import { createSimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import type { SimulationRunRuntime } from '../src/core/simulation-runs/runtime.ts'
import { createProcedureSourceService } from '../src/features/procedures/source.ts'
import { createTestPackRuntimeAdapters, createTestScenarioRuntimeResolver, testScenarioAuthoring, waitForCondition } from './helpers.ts'

const operator: Actor = { id: actorIdSchema.parse('operator:evidence'), label: 'Evidence operator', role: 'operator' }
const agent: Actor = { id: actorIdSchema.parse('agent:evidence'), label: 'Evidence reader', role: 'ai_agent' }
const revision = 'a'.repeat(40)
const sourceId = 'evidence-test'
const path = 'procedures/PUMP-OBS.md'
const fixture = (modelRef: string, modelDigest: string): string => `---
type: procedure
procedure-md: 0.7
procedure-id: PUMP-OBS
title: Test pump observation and handover
---
# Test pump observation and handover
This is a software integration fixture, not a plant operating criterion.
## Step 1 [id: observe-pump]
Basis: Test comparison of the represented pump state, with no CSF adequacy claim.
Check: Compare the represented running state.
\`\`\`procedure-observation
${JSON.stringify({ capabilityId: 'world.process-plant.procedure-condition.evaluate', continuous: true, input: {
  condition: { type: 'comparison', signal: { path: 'rcpA.running' }, operator: '==', value: true, unit: 'boolean' },
  basis: { modelRef, modelDigest, source: 'source:apps/world/src/packs/process-plant/specs/pwr-reference-template.graph.json', description: 'Test-only pump-running comparison; no functional sufficiency claim.' },
} })}
\`\`\`
- Evidence reviewed [outcome: normal] → #record-handover
## Step 2 [id: record-handover]
Action: Record a handover comment; the earlier continuous observation remains active.
- Review ended [outcome: normal] → END
`

const query = async <T>(runtime: SimulationRunRuntime, capabilityId: string, input: unknown = {}, actor = agent): Promise<T> => {
  const response = await runtime.invokeCapability(actor, { capabilityId, input })
  if (response.kind !== 'query') throw new Error(`Expected query: ${capabilityId}`)
  return response.result as T
}
const command = async (runtime: SimulationRunRuntime, capabilityId: string, input: unknown, actor = operator): Promise<void> => {
  const response = await runtime.invokeCapability(actor, { capabilityId, input })
  if (response.kind !== 'command') throw new Error(`Expected command: ${capabilityId}`)
  expect(response.result.ok).toBe(true)
  if (!response.result.ok) throw new Error(response.result.reason)
}

describe('procedure evidence through the real Run and process-plant runtime', () => {
  test('acquires without a browser, retains simulation-time evidence and selected-branch provenance, restores, copies and deletes independently', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-procedure-evidence-lifecycle-'))
    const workspaceId = newWorkspaceId()
    let publication = createKnowledge({ revision, documents: [] })
    const source = createProcedureSourceService({
      sources: [{ sourceId, label: 'Integration evidence fixture', repository: 'test-fixture', ref: 'publication', procedurePath: 'procedures' }],
      retentionDirectory: join(dataDir, 'procedure-publications'), loadKnowledge: async () => publication,
    })
    const registry = createSimulationRunRegistry({ dataDir, workspaceId,
      scenarioRuntimeResolver: createTestScenarioRuntimeResolver(), ...testScenarioAuthoring(),
      runtimeAdapters: createTestPackRuntimeAdapters(), procedureSourceService: source,
    })
    try {
      let runtime = await registry.create({ scenarioId: 'test-plant' })
      await runtime.setClock({ paused: true })
      const plants = await query<{ plants: Array<{ id: string; modelRef: string; modelDigest: string; elapsedMs: number }> }>(runtime, 'world.process-plant.plants.list')
      const plant = plants.plants[0]!
      publication = createKnowledge({ revision, documents: [{ path, content: fixture(plant.modelRef, plant.modelDigest) }] })
      await command(runtime, 'world.procedure.run.start', { sourceId, sourceRevision: revision, procedureId: 'PUMP-OBS', scope: { plantId: plant.id } })
      const current = (): ProcedureRunState => runtime.snapshot().procedures!.runs[0]!
      const runId = current().runId
      const initial = current().observations?.[0]
      expect(initial).toMatchObject({ stepId: 'observe-pump', result: { status: 'satisfied', targetObjectId: plant.id,
        modelRef: plant.modelRef, modelDigest: plant.modelDigest, automaticCsfQualified: false,
        evidence: [{ instrumentationValidity: 'not-established', provenance: 'runtime-model', variable: { value: true, unit: 'boolean' } }],
      } })
      const pausedTime = runtime.snapshot().clock!.currentTime
      const pausedEvidence = structuredClone(initial)
      await Bun.sleep(1_100) // Prove the server timer does not advance a paused simulation.
      expect(runtime.snapshot().clock!.currentTime).toBe(pausedTime)
      expect(current().observations?.[0]).toEqual(pausedEvidence)

      // The step cites no plant tag an AI agent could rest a decision on, so a person selects its branch.
      const refused = await runtime.invokeCapability(agent, { capabilityId: 'world.procedure.run.transition', input: { runId, stepId: 'observe-pump', branchIndex: 0 } })
      expect(refused.kind === 'command' && !refused.result.ok && refused.result.reason).toContain('Nobody drives PUMP-OBS')
      await command(runtime, 'world.procedure.run.transition', { runId, stepId: 'observe-pump', branchIndex: 0 })
      expect(current().currentStepId).toBe('record-handover')
      const selected = runtime.events().find(event => event.type === 'procedure.branch.selected')
      expect(selected).toMatchObject({ type: 'procedure.branch.selected', stepId: 'observe-pump', selectedBy: operator.id,
        outcome: 'normal', simulationTime: pausedTime, observation: pausedEvidence,
      })
      await command(runtime, 'world.process-plant.control.write', { plantId: plant.id, path: 'rcpA.running', value: false })
      const targetTime = new Date(Date.parse(pausedTime) + 2_000).toISOString()
      await registry.advanceExecution(runtime.id, { minutes: 2 / 60, onComplete: 'pause' })
      await waitForCondition('maximum pace reaches its exact requested boundary', () => runtime.snapshot().clock?.currentTime === targetTime, { timeoutMs: 10_000 })
      await registry.setExecution(runtime.id, { playback: 'paused' })
      expect(current()).toMatchObject({ currentStepId: 'record-handover', observations: [{ stepId: 'observe-pump', simulationTime: targetTime,
        result: { status: 'challenged', evidence: [{ variable: { value: false }, instrumentationValidity: 'not-established' }] },
      }] })
      expect(runtime.events().filter(event => event.type === 'procedure.observation.updated').map(event => event.observation.result.status)).toEqual(['satisfied', 'challenged'])

      const saved = structuredClone(current())
      const originalId = runtime.id
      await registry.close(originalId)
      publication = createKnowledge({ revision: 'b'.repeat(40), documents: [{ path: 'index.md', content: '# Current publication has changed' }] })
      runtime = await registry.load(originalId)
      expect(current()).toEqual(saved)
      expect((await runtime.procedureDocument(saved)).source.revision).toBe(revision)
      const copy = await registry.copy(originalId, { name: 'Independent evidence branch' })
      expect(copy.snapshot().procedures?.runs[0]).toEqual(saved)
      await command(copy, deleteObjectCommandKind, { objectId: plant.id })
      expect(copy.snapshot().procedures?.runs).toEqual([])
      expect(current()).toEqual(saved)
      await registry.close(copy.id)
      expect((await registry.load(copy.id)).snapshot().procedures?.runs).toEqual([])

      // A source acquisition failure after restoration must withdraw the old
      // conclusion, even while the simulation is paused and no UI is open.
      await registry.close(originalId)
      await writeFile(join(dataDir, 'procedure-publications', `${sourceId}-${revision}.json`), '{invalid-test-source')
      runtime = await registry.load(originalId)
      await waitForCondition('unavailable pinned source becomes explicit unknown evidence', () => current().observations?.[0]?.result.status === 'unknown', { timeoutMs: 3_000 })
      expect(current().observations?.[0]?.result.reason).toContain('source')
    } finally {
      await registry.shutdown()
      await rm(dataDir, { recursive: true, force: true }) // Only this test's mkdtemp-owned directory.
    }
  })
})
