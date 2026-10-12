import { newWorkspaceId } from '@leitbild/contracts'
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActorId, CommandResult } from '../src/core/model/index.ts'
import type { Actor } from '../src/core/simulation-runs/actors.ts'
import { createSimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import type { SimulationRunRuntime } from '../src/core/simulation-runs/runtime.ts'
import { createTestPackRuntimeAdapters, createTestScenarioRuntimeResolver, testScenarioAuthoring } from './helpers.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// Core tells the Plant who issues each command (a person, an AI agent, or
// the Run itself), and journals an AI agent's command as the AI's
// (plan-final S3).

const operator: Actor = { id: 'actor:human:origin-operator' as ActorId, label: 'Origin test operator', role: 'operator' }
const agent: Actor = { id: 'actor:ai:origin-agent' as ActorId, label: 'Origin test agent', role: 'ai_agent' }

const withRun = async (body: (run: SimulationRunRuntime, plantId: string) => Promise<void>): Promise<void> => {
  const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-command-origin-'))
  const registry = createSimulationRunRegistry({
    dataDir,
    workspaceId: newWorkspaceId(),
    ...testScenarioAuthoring(),
    runtimeAdapters: createTestPackRuntimeAdapters(),
    scenarioRuntimeResolver: createTestScenarioRuntimeResolver(),
  })
  try {
    const run = await registry.create({ scenarioId: 'test-plant' })
    await run.setClock({ paused: true })
    const plantId = run.snapshot().objects.find(object => object.packId === 'process-plant')!.id
    await body(run, plantId)
  } finally {
    await registry.shutdown()
    await rm(dataDir, { recursive: true, force: true })
  }
}

const commandResult = async (run: SimulationRunRuntime, actor: Actor, capabilityId: string, input: Record<string, unknown>): Promise<CommandResult> => {
  const outcome = await run.invokeCapability(actor, { capabilityId, input })
  if (outcome.kind !== 'command') throw new Error(`${capabilityId} is not a command`)
  return outcome.result
}

describe('who issues a Plant command', () => {
  test('an AI agent\'s command is journaled as the AI\'s, a person\'s as the operator\'s', async () => {
    await withRun(async (run, plantId) => {
      await commandResult(run, operator, 'world.process-plant.control.write', { plantId, tagId: 'CHG-PUMP-B', value: true })
      await commandResult(run, agent, 'world.process-plant.control.write', { plantId, tagId: 'CHG-PUMP-B', value: false })
      const issued = run.events().flatMap(event => event.type === 'command.issued' ? [[event.command.actorId, event.provenance.source]] : [])
      expect(issued).toEqual([[operator.id, 'operator'], [agent.id, 'ai']])
    })
  })
})
