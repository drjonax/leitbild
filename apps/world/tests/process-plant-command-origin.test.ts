import { newWorkspaceId } from '@leitbild/contracts'
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActorId, CommandEnvelope, CommandId, CommandResult, IsoTimestamp, OperationalObject, SimulationRunId } from '../src/core/model/index.ts'
import type { Actor } from '../src/core/simulation-runs/actors.ts'
import { createSimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import type { SimulationRunRuntime } from '../src/core/simulation-runs/runtime.ts'
import type { CommandOrigin, PackRuntimeConnection } from '../src/simulation/protocol.ts'
import {
  createLocalProcessPlantPackRuntimeAdapter,
  processPlantActionInvokeCommandKind,
  processPlantControlWriteCommandKind,
} from '../src/packs/process-plant/index.ts'
import { scenarios } from './fixtures/scenarios.ts'
import { createTestPackRuntimeAdapters, createTestScenarioRuntimeResolver, testScenarioAuthoring } from './helpers.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// Core tells the Plant who issues each command (a person, an AI agent, or
// the Run itself), and journals an AI agent's command as the AI's
// (plan-final S3). A fault the scenario injects and a condition outside the
// Plant are the instructor's: neither a person's nor an AI agent's control
// write or ramp reaches them, while a person's instructor action and the
// Run's own write do (S1, QA-3). An AI agent proposes operations on a Plant
// for a person to approve, unless the Plant opts into direct AI operation
// (QA-1).

const operator: Actor = { id: 'actor:human:origin-operator' as ActorId, label: 'Origin test operator', role: 'operator' }
const agent: Actor = { id: 'actor:ai:origin-agent' as ActorId, label: 'Origin test agent', role: 'ai_agent' }
const scenario: Actor = { id: 'actor:origin-scenario' as ActorId, label: 'Origin test scenario', role: 'system' }
const proposeOnly = 'An AI agent proposes operations on this Plant for a person to approve (world.process-plant.control.propose); it does not operate it directly'

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

/** The test Plant opted into direct AI operation, on its own Pack connection. */
const withDirectPlant = async (body: (connection: PackRuntimeConnection, plantId: string) => Promise<void>): Promise<void> => {
  const builtIn = scenarios.find(candidate => candidate.id === 'test-plant')!
  const plant = builtIn.initialObjects.find(object => object.packId === 'process-plant')!
  const direct: OperationalObject = { ...plant, packData: { ...(plant.packData as Record<string, unknown>), aiOperation: 'direct' } }
  const connection = await createLocalProcessPlantPackRuntimeAdapter().connect({
    simulationRunId: 'run:command-origin' as SimulationRunId,
    scenario: { scenarioId: builtIn.id, runtimeIds: ['process-plant.local'], connections: [], world: builtIn.world, initialObjects: [direct], runtimeConfig: {} },
  })
  try {
    await body(connection, String(plant.id))
  } finally {
    await connection.close()
  }
}

const send = async (connection: PackRuntimeConnection, kind: string, payload: unknown, origin: CommandOrigin): Promise<CommandResult> =>
  await connection.sendCommand({
    id: `command:${crypto.randomUUID()}` as CommandId,
    simulationRunId: 'run:command-origin' as SimulationRunId,
    actorId: 'actor:ai:origin-agent' as ActorId,
    kind,
    targetObjectIds: [],
    payload,
    issuedAt: '2026-01-01T09:00:00.000Z' as IsoTimestamp,
  } satisfies CommandEnvelope, { origin })

describe('who issues a Plant command', () => {
  test('an AI agent\'s command is journaled as the AI\'s, a person\'s as the operator\'s', async () => {
    await withRun(async (run, plantId) => {
      await commandResult(run, operator, 'world.process-plant.control.write', { plantId, tagId: 'CHG-PUMP-B', value: true })
      await commandResult(run, agent, 'world.process-plant.control.write', { plantId, tagId: 'CHG-PUMP-B', value: false })
      const issued = run.events().flatMap(event => event.type === 'command.issued' ? [[event.command.actorId, event.provenance.source]] : [])
      expect(issued).toEqual([[operator.id, 'operator'], [agent.id, 'ai']])
    })
  })

  test('a fault and the offsite boundary refuse a person\'s direct write and ramp, and take the Run\'s', async () => {
    await withRun(async (run, plantId) => {
      const fault = { plantId, path: 'pressurizer.reliefValveFailureActive', value: true }
      expect(await commandResult(run, operator, 'world.process-plant.control.write', fault)).toMatchObject({
        ok: false, reason: 'pressurizer.reliefValveFailureActive is a fault the scenario injects: only instructor actions and the Scenario set it',
      })
      const ramp = await commandResult(run, operator, 'world.process-plant.control.ramp', { plantId, path: 'offsiteGrid.voltageFraction', targetValue: 0.9, durationSeconds: 30 })
      expect(ramp.ok).toBe(false)
      if (!ramp.ok) expect(ramp.reason).toContain('is a condition outside the Plant: only instructor actions and the Scenario set it')
      expect((await commandResult(run, scenario, 'world.process-plant.control.write', fault)).ok).toBe(true)
      // A person's instructor action injects the fault.
      expect((await commandResult(run, operator, 'world.process-plant.action.invoke', { plantId, actionId: 'pressurizer-relief-open', parameters: { positionPercent: 20 } })).ok).toBe(true)
    })
  })

  test('by default an AI agent operates nothing directly: writes, ramps, instructor actions and alarm lifecycle changes are refused', async () => {
    await withRun(async (run, plantId) => {
      const refused = [
        await commandResult(run, agent, 'world.process-plant.control.write', { plantId, tagId: 'CHG-PUMP-B', value: true }),
        await commandResult(run, agent, 'world.process-plant.control.ramp', { plantId, tagId: 'RCP-A-SPD', targetValue: 0.9, durationSeconds: 30 }),
        await commandResult(run, agent, 'world.process-plant.action.invoke', { plantId, actionId: 'turbine-trip', parameters: {} }),
        await commandResult(run, agent, 'world.process-plant.ic.lifecycle', { plantId, lifecycleId: 'any', action: 'acknowledge' }),
      ]
      expect(refused).toEqual(refused.map(result => ({ ok: false, commandId: result.commandId, rejectedAt: expect.any(String), reason: proposeOnly })))
      // It still reads and validates; a person's same command is accepted.
      const validation = await run.invokeCapability(agent, { capabilityId: 'world.process-plant.control.validate', input: { plantId, tagId: 'CHG-PUMP-B', value: true } })
      expect(validation).toMatchObject({ kind: 'query', result: { accepted: true } })
      expect((await commandResult(run, operator, 'world.process-plant.control.write', { plantId, tagId: 'CHG-PUMP-B', value: true })).ok).toBe(true)
    })
  })

  test('on a Plant that opts into direct AI operation an agent operates it, but never reaches a fault', async () => {
    await withDirectPlant(async (connection, plantId) => {
      expect((await send(connection, processPlantControlWriteCommandKind, { plantId, tagId: 'CHG-PUMP-B', value: true }, 'ai')).ok).toBe(true)
      const fault = await send(connection, processPlantControlWriteCommandKind, { plantId, path: 'pressurizer.reliefValveFailureActive', value: true }, 'ai')
      expect(fault).toMatchObject({ ok: false, reason: 'pressurizer.reliefValveFailureActive is a fault the scenario injects: only instructor actions and the Scenario set it' })
      const action = await send(connection, processPlantActionInvokeCommandKind, { plantId, actionId: 'pressurizer-relief-open', parameters: { positionPercent: 20 } }, 'ai')
      expect(action.ok).toBe(false)
      if (!action.ok) expect(action.reason).toContain('is a fault the scenario injects')
      expect((await send(connection, processPlantActionInvokeCommandKind, { plantId, actionId: 'pressurizer-relief-open', parameters: { positionPercent: 20 } }, 'person')).ok).toBe(true)
    })
  })
})
