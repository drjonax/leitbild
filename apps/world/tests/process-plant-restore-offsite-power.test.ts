import { describe, expect, test } from 'bun:test'
import type { ElectricalConnectionDefinition, SimulationRunId } from '../src/core/model/index.ts'
import {
  commandsForProcessPlantAction,
  compileProcessPlant,
  createProcessPlantProtectionRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
  type VariablePath,
} from '../src/packs/process-plant/index.ts'
import { validateProcessPlantControlWrite } from '../src/packs/process-plant/control-write-validation.ts'
import { coupledBoundaryEffect } from '../src/packs/process-plant/sim/offsite-isolation.ts'
import { guardPlantTests, PLANT_HANG_GUARD_MS } from './plant-hang-guard.ts'

guardPlantTests()

// The instructor's way back from a loss of offsite power: the offsite source is available again, through the
// same validated write every action takes, and the operators reclose the breakers.

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:restore-offsite-power', loopCount: 4 }))

describe('restoring offsite power', () => {
  test('writes only the offsite source available, which a Grid-connected Plant reads as the end of its isolation', () => {
    const commands = commandsForProcessPlantAction({ actionId: 'restore-offsite-power', parameters: {}, graph: plant.graph })
    expect(commands).toEqual([{ path: 'offsiteGrid.available', value: true }] as never)
    // Coupled to a Grid, the write clears the Plant-side isolation; voltage and frequency stay the Grid's to set.
    const connection = { id: 'unit-1', system: { objectId: plant.id, portId: 'grid-420kv' }, network: { objectId: 'grid:test', portId: 'unit-1' } } as unknown as ElectricalConnectionDefinition
    const coupled = new Map([
      ['offsiteGrid.available' as VariablePath, { connection, variable: 'available' as const }],
      ['offsiteGrid.voltageFraction' as VariablePath, { connection, variable: 'voltageFraction' as const }],
      ['offsiteGrid.frequencyHz' as VariablePath, { connection, variable: 'frequencyHz' as const }],
    ])
    expect(coupledBoundaryEffect(coupled, commands)).toEqual({ ok: true, effect: { isolate: [], clear: [connection] } })
  })

  test('brings the offsite grid back after a loss of offsite power, with the breakers left for operators to reclose', () => {
    const runtime = createProcessPlantRuntime({ system: plant })
    const protection = createProcessPlantProtectionRunner({ system: plant, protection: plant.automation })
    const run = (seconds: number): void => {
      for (let second = 0; second < seconds; second += 1) {
        runtime.tick(1_000)
        protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-restore-offsite-power' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
      }
    }
    const act = (actionId: string): void => {
      for (const command of commandsForProcessPlantAction({ actionId, parameters: {}, graph: plant.graph })) {
        const validation = validateProcessPlantControlWrite({ system: plant, runtime, protection, payload: { plantId: plant.id, path: command.path, value: command.value } })
        expect(validation.accepted).toBe(true)
        runtime.writeCommand({ type: 'setVariable', path: command.path, value: command.value })
      }
    }
    const read = (path: string) => runtime.readVariable(path as VariablePath)
    run(10)
    act('loss-offsite-power')
    run(30)
    expect(read('offsiteGrid.energized')).toBe(false)
    act('restore-offsite-power')
    run(5)
    expect(read('offsiteGrid.available')).toBe(true)
    expect(read('offsiteGrid.energized')).toBe(true)
    expect([read('offsiteBreakerA.closedState'), read('offsiteBreakerB.closedState')]).toEqual([false, false])
  }, PLANT_HANG_GUARD_MS)
})
