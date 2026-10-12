import { describe, expect, test } from 'bun:test'
import type { ActorId, CommandEnvelope, CommandId, IsoTimestamp, SimulationRunId } from '../src/core/model/index.ts'
import { createSimulationClock, type SimulationClock } from '../src/core/model/time.ts'
import type { CommandOrigin, PackRuntimeConnection, PackRuntimeStateStore } from '../src/simulation/protocol.ts'
import {
  createLocalProcessPlantPackRuntimeAdapter,
  processPlantControlRampCommandKind,
  processPlantControlWriteCommandKind,
  type VariablePath,
} from '../src/packs/process-plant/index.ts'
import { OPERATIONS_KEPT, createPlantOperations, type OperationRecord } from '../src/packs/process-plant/operations/plant-operations.ts'
import { proposeOperation, type ProposalPorts } from '../src/packs/process-plant/operations/proposals.ts'
import { processPlantRuntimeStateSchema } from '../src/packs/process-plant/sim/runtime-state.ts'
import { scenarios } from './fixtures/scenarios.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// What people and AI agents did to a Plant is kept beside its runtime state
// as an optional field, served to the displays that draw those paths, and
// restored with the Plant; a state saved before it existed restores with
// none (plan-final O-D4, QA-19).

const simulationRunId = 'run:operations-record' as SimulationRunId
const builtIn = scenarios.find(scenario => scenario.id === 'test-plant')!
const basePlant = builtIn.initialObjects.find(object => object.packId === 'process-plant')!
const plantId = String(basePlant.id)
const scenario = { scenarioId: builtIn.id, runtimeIds: ['process-plant.local'], connections: [], world: builtIn.world, initialObjects: [basePlant], runtimeConfig: {} }

const memoryStore = (): PackRuntimeStateStore & { readonly state: () => unknown } => {
  let state: unknown | null = null
  return { load: async () => state, save: async next => { state = structuredClone(next) }, state: () => state }
}
const pausedClock = (): SimulationClock => createSimulationClock({ currentTime: builtIn.world.startsAt, updatedAt: '2026-01-01T09:00:00.000Z' as IsoTimestamp, paused: true })
const advance = async (connection: PackRuntimeConnection, clock: SimulationClock, ms: number): Promise<void> => {
  const current = clock.read()
  const next = { ...current, currentTime: new Date(Date.parse(current.currentTime) + ms).toISOString() as IsoTimestamp }
  await connection.advanceTo!(next)
  clock.set(next)
}
const send = async (connection: PackRuntimeConnection, kind: string, payload: unknown, origin: CommandOrigin | undefined, actorId = 'actor:human:op') =>
  await connection.sendCommand({
    id: `command:${crypto.randomUUID()}` as CommandId,
    simulationRunId,
    actorId: actorId as ActorId,
    kind,
    targetObjectIds: [],
    payload,
    issuedAt: '2026-01-01T09:00:00.000Z' as IsoTimestamp,
  } satisfies CommandEnvelope, origin === undefined ? {} : { origin })
const sample = async (connection: PackRuntimeConnection, paths: ReadonlyArray<string>) =>
  await connection.invokeQuery({ capabilityId: 'world.process-plant.display.sample', input: { plantId, paths, operations: true } }) as {
    readonly operations: { readonly log: ReadonlyArray<OperationRecord>; readonly ramps: ReadonlyArray<{ readonly path: string; readonly target: number }>; readonly proposals: ReadonlyArray<unknown>; readonly resets: ReadonlyArray<unknown> }
  }

describe('the operations record', () => {
  test('logs people\'s and AI agents\' accepted commands, newest last, keeping the last 64', () => {
    const operations = createPlantOperations()
    expect(operations.snapshot()).toBeUndefined()
    for (let index = 0; index < OPERATIONS_KEPT + 3; index += 1) {
      operations.record({ commandId: `command:${index}`, path: 'p.x' as VariablePath, value: index, origin: 'person', actorId: 'actor:human:op', elapsedMs: index, kind: 'write' }, { elapsedMs: index, wallMs: index })
    }
    expect(operations.log().length).toBe(OPERATIONS_KEPT)
    expect(operations.log()[0]!.commandId).toBe('command:3')
    expect(operations.snapshot()?.log.at(-1)?.commandId).toBe(`command:${OPERATIONS_KEPT + 2}`)
  })

  test('a person\'s command on the equipment supersedes what was proposed for it', () => {
    const ports: ProposalPorts = {
      offered: () => ({ ok: true, item: 'item', word: 'SHUT' }),
      validate: () => ({ accepted: true }),
      reading: () => ({ ok: true, path: 'p.pt' as VariablePath, value: 15 }),
      resettable: ruleId => ({ ok: false, reason: `${ruleId} is not reset in this test` }),
    }
    const operations = createPlantOperations()
    const proposed = proposeOperation(operations.book(), { id: 'command:p', plantId: 'p', write: { path: 'p.valve' as VariablePath, value: 0 }, reason: 'isolate', evidence: ['PT' as never], proposer: { actorId: 'actor:ai:a', origin: 'ai' }, at: { elapsedMs: 0, wallMs: 0 } }, ports)
    operations.setBook(proposed.book)
    const transitions = operations.record({ commandId: 'command:w', path: 'p.valve' as VariablePath, value: 0, origin: 'person', actorId: 'actor:human:op', elapsedMs: 5, kind: 'write' }, { elapsedMs: 5, wallMs: 5 })
    expect(transitions.map(transition => [transition.type, transition.proposal.id])).toEqual([['superseded', 'command:p']])
  })
})

describe('on a Plant\'s Pack connection', () => {
  test('a person\'s write and an operator ramp are served to displays drawing those paths, and persist and restore', async () => {
    const store = memoryStore()
    const clock = pausedClock()
    const first = await createLocalProcessPlantPackRuntimeAdapter().connect({ simulationRunId, scenario, runtimeStateStore: store, runClock: clock })
    try {
      expect((await send(first, processPlantControlWriteCommandKind, { plantId, tagId: 'CHG-PUMP-B', value: true }, 'person')).ok).toBe(true)
      expect((await send(first, processPlantControlRampCommandKind, { plantId, path: 'rcpA.speedFraction', targetValue: 0.95, durationSeconds: 60 }, 'person')).ok).toBe(true)
      // The Run's own write and an unattributed one are not people's or agents' operations.
      expect((await send(first, processPlantControlWriteCommandKind, { plantId, tagId: 'CHG-PUMP-A', value: true }, 'system')).ok).toBe(true)
      expect((await send(first, processPlantControlWriteCommandKind, { plantId, tagId: 'CHG-PUMP-A', value: false }, undefined)).ok).toBe(true)
      await advance(first, clock, 1_000)
      const served = await sample(first, ['chargingPumpB.running', 'rcpA.speedFraction', 'chargingPump.running'])
      expect(served.operations.log.map(record => [String(record.path), record.value, record.origin, record.kind])).toEqual([
        ['chargingPumpB.running', true, 'person', 'write'],
        ['rcpA.speedFraction', 0.95, 'person', 'ramp'],
      ])
      expect(served.operations.ramps.map(ramp => [ramp.path, ramp.target])).toEqual([['rcpA.speedFraction', 0.95]])
      // A display that does not draw a path is not served its operations.
      expect((await sample(first, ['pressurizer.pressureMPa'])).operations).toEqual({ log: [], ramps: [], proposals: [], resets: [] })
      await first.checkpoint!()
    } finally {
      await first.close()
    }
    const saved = processPlantRuntimeStateSchema.parse(store.state())
    expect(saved.plants[0]!.operations?.log.length).toBe(2)
    const restored = await createLocalProcessPlantPackRuntimeAdapter().connect({ simulationRunId, scenario, runtimeStateStore: store, runClock: pausedClock() })
    try {
      expect((await sample(restored, ['chargingPumpB.running'])).operations.log.map(record => record.commandId)).toEqual([saved.plants[0]!.operations!.log[0]!.commandId])
    } finally {
      await restored.close()
    }
  })

  test('a state saved without an operations record restores with none, and writes none until something happens', async () => {
    const store = memoryStore()
    const first = await createLocalProcessPlantPackRuntimeAdapter().connect({ simulationRunId, scenario, runtimeStateStore: store, runClock: pausedClock() })
    try {
      await first.checkpoint!()
    } finally {
      await first.close()
    }
    const saved = processPlantRuntimeStateSchema.parse(store.state())
    expect('operations' in saved.plants[0]!).toBe(false)
    const restored = await createLocalProcessPlantPackRuntimeAdapter().connect({ simulationRunId, scenario, runtimeStateStore: store, runClock: pausedClock() })
    try {
      expect((await sample(restored, ['chargingPumpB.running'])).operations).toEqual({ log: [], ramps: [], proposals: [], resets: [] })
    } finally {
      await restored.close()
    }
  })
})
