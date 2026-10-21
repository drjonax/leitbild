/**
 * T39's Plant states (swap plan): the deterministic states T01 recorded the
 * old display path in (tests/fixtures/display-characterization/old-path.json),
 * and the names it drew and read there, read again on the new path. A fresh
 * four-loop reference Plant per state, played in 1 s steps with protection
 * evaluated each step, answered at the Capability boundary.
 */
import type { IsoTimestamp } from '../../src/core/model/index.ts'
import {
  answerProcessPlantQuery,
  commandsForProcessPlantAction,
  compileProcessPlant,
  createProcessPlantProtectionRunner,
  createProcessPlantRampRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
  type CompiledProcessPlant,
} from '../../src/packs/process-plant/index.ts'
import { createPlantOperations } from '../../src/packs/process-plant/operations/plant-operations.ts'
import { createProcessPlantRuntimePerformance, type ProcessPlantRuntimeInstance } from '../../src/packs/process-plant/runtime-instance.ts'

export const PLANT_ID = 'plant:characterization'
export const SIMULATION_TIME = '2026-10-20T10:00:00.000Z' as IsoTimestamp

/** A Plant state the facts are read in: a fault (or none) played for a number of simulated seconds after a 5 s settle. */
export interface CharacterizationState {
  readonly id: string
  readonly action?: { readonly actionId: string; readonly parameters?: Record<string, unknown> }
  readonly seconds: number
}

export const STATES: ReadonlyArray<CharacterizationState> = [
  { id: 'steady', seconds: 10 },
  { id: 'loss-main-feedwater+120s', action: { actionId: 'loss-main-feedwater' }, seconds: 120 },
  { id: 'loss-offsite-power+60s', action: { actionId: 'loss-offsite-power' }, seconds: 60 },
  { id: 'porv-open-35+120s', action: { actionId: 'pressurizer-relief-open', parameters: { positionPercent: 35 } }, seconds: 120 },
]

/** Mimics an agent wrote in the evaluation runs, each drawing equipment people operate. */
export const REFERENCE_MIMICS: ReadonlyArray<{ readonly around?: ReadonlyArray<string>; readonly from?: ReadonlyArray<string>; readonly to?: ReadonlyArray<string>; readonly services?: ReadonlyArray<string> }> = [
  { around: ['auxFeedwaterValveA'] },
  { from: ['pressurizer'], to: ['pressurizerReliefTank'], services: ['primaryRelief'] },
  { from: ['dieselGeneratorA'], to: ['auxFeedwaterPumpMotor'], services: ['electricalPower'] },
  { around: ['mainSteamIsolationValveA'] },
]

/** The values whose chips are read: levels, pressures, power, an electrical bus and AFW flow. */
export const CHIP_SIGNALS: ReadonlyArray<string> = ['SG-A-LVL-NR', 'SG-B-LVL-NR', 'SG-A-PRESS', 'PT-455', 'PZR-LVL', 'TAVG', 'NIS-PR-AVG', 'BUS-A-VOLTAGE', 'AFW-FLOW', 'SUB-MARGIN']

/** Tags procedures name: measured ones, a breaker, an absent one. */
export const PROCEDURE_TAGS: ReadonlyArray<string> = ['PT-455', 'NIS-PR-AVG', 'SG-B-LVL-NR', 'AFW-FLOW', 'MSIV-A-POS', 'TRIP-BKR-A', 'DG-A', 'SI-SIG']

let compiled: CompiledProcessPlant | undefined
export const plantModel = (): CompiledProcessPlant => compiled ??= compileProcessPlant(createPwrReferencePlantDefinition({ id: PLANT_ID, loopCount: 4 }))

/** A fresh 4-loop reference Plant played into the state, deterministically. */
export const plantIn = (state: CharacterizationState): ProcessPlantRuntimeInstance => {
  const plant = plantModel()
  const runtime = createProcessPlantRuntime({ system: plant })
  const protection = createProcessPlantProtectionRunner({ system: plant, protection: plant.automation })
  const step = () => {
    runtime.tick(1_000)
    protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-characterization' as never, sourceRuntimeId: 'process-plant.local' })
  }
  for (let second = 0; second < 5; second += 1) step()
  if (state.action !== undefined) {
    for (const command of commandsForProcessPlantAction({ actionId: state.action.actionId, parameters: state.action.parameters ?? {}, graph: plant.graph })) {
      runtime.writeCommand({ type: 'setVariable', path: command.path, value: command.value })
    }
  }
  for (let second = 0; second < state.seconds; second += 1) step()
  return { plant, runtime, ramps: createProcessPlantRampRunner({ runtime }), protection, operations: createPlantOperations(), performance: createProcessPlantRuntimePerformance() }
}

/** The Plant's Capabilities, as a person asks them of the Run, at the state's Run time. */
export const askOf = (instance: ProcessPlantRuntimeInstance) => <T,>(capabilityId: string, input: unknown): T => answerProcessPlantQuery({
  request: { capabilityId, input },
  plants: new Map([[PLANT_ID, instance]]),
  objects: new Map(),
  simulationTime: SIMULATION_TIME,
  recordedSeriesIds: new Set(),
}) as T
