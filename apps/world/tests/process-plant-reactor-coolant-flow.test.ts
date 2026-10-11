import { describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/index.ts'
import {
  commandsForProcessPlantAction,
  compileProcessPlant,
  createProcessPlantProtectionRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
  resolveProcessPlantSignalBinding,
  type VariablePath,
} from '../src/packs/process-plant/index.ts'
import { saturationTemperatureCFromPressureMPa } from '../src/packs/process-plant/runtime/thermophysics.ts'

// Reactor coolant flow in the deployed four-loop reference PWR after its pumps
// trip from full power, run under its own I&C, against what a Westinghouse-type
// four-loop plant does:
// - all pumps lost: the flywheels keep about 15 % of the flow at 60 s, the flow
//   falling about as 1 / (1 + t / 11 s) (FSAR 15.3.2, complete loss of forced
//   flow); natural circulation of a few percent forms within minutes, with a
//   core rise of 10 to 25 °C on decay heat, stable or falling once forced flow
//   has gone, the core exit following the steam generators' saturation
//   temperature, the steam generators carrying the heat away;
// - one pump lost: the other three keep 70 to 75 % of rated core flow and
//   drive the idle loop backwards, and the core exit falls toward no-load.
// The core rise and the subcooling margin follow the decay heat the core
// makes, here the ANS-5.1 curve's.

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:reactor-coolant-flow', loopCount: 4 }))
const loops = ['A', 'B', 'C', 'D'] as const
const ratedCoreFlow = 17_000
const ratedLoopFlow = ratedCoreFlow / loops.length

interface Sample {
  readonly second: number
  readonly coreFlow: number
  readonly loopFlows: ReadonlyArray<number>
  readonly coreRise: number
  readonly coreExit: number
  readonly coldLeg: number
  /** The steam generators' saturation temperature, at their mean pressure. */
  readonly steamGeneratorSaturation: number
  readonly subcooling: number
  readonly coreHeat: number
  readonly steamGeneratorHeat: number
  readonly coolingAvailability: number
}

/** Steady full power for a minute, the fault, then ten minutes sampled each second. */
const afterFault = (fault: (act: (actionId: string) => void, write: (path: string, value: boolean) => void) => void) => {
  const runtime = createProcessPlantRuntime({ system: plant })
  const protection = createProcessPlantProtectionRunner({ system: plant, protection: plant.automation })
  const read = (path: string): number => Number(runtime.readVariable(path as VariablePath))
  const tag = (tagId: string): number => Number(runtime.readVariable(resolveProcessPlantSignalBinding(plant.graph, { tagId: tagId as never }).path))
  const second = (): void => {
    runtime.tick(1_000)
    protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-reactor-coolant-flow' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
  }
  const sample = (at: number): Sample => ({
    second: at,
    coreFlow: read('core.averageHotLegFlowKgPerS'),
    loopFlows: loops.map(loop => read(`rcp${loop}.loopFlowKgPerS`) - read(`rcp${loop}.loopReverseFlowKgPerS`)),
    coreRise: read('core.coolantOutletTemperatureC') - read('core.coolantInletTemperatureC'),
    coreExit: tag('CET-AVG'),
    coldLeg: read('core.coolantInletTemperatureC'),
    steamGeneratorSaturation: saturationTemperatureCFromPressureMPa(loops.reduce((sum, loop) => sum + read(`sg${loop}.pressureMPa`), 0) / loops.length),
    subcooling: tag('SUB-MARGIN'),
    coreHeat: read('core.totalThermalPowerMw') + read('core.pumpHeatMw'),
    steamGeneratorHeat: loops.reduce((sum, loop) => sum + read(`sg${loop}.heatTransferMw`), 0),
    coolingAvailability: read('core.coreCoolingAvailabilityFraction'),
  })
  for (let index = 0; index < 60; index++) second()
  const before = sample(0)
  fault(
    actionId => {
      for (const command of commandsForProcessPlantAction({ actionId, parameters: {}, graph: plant.graph })) {
        runtime.writeCommand({ type: 'setVariable', path: command.path, value: command.value })
      }
    },
    (path, value) => runtime.writeCommand({ type: 'setVariable', path: path as VariablePath, value }),
  )
  const samples: Sample[] = []
  for (let index = 1; index <= 600; index++) {
    second()
    samples.push(sample(index))
  }
  const at = (seconds: number): Sample => samples[seconds - 1]!
  const after = (seconds: number): ReadonlyArray<Sample> => samples.filter(entry => entry.second >= seconds)
  return { before, at, after, read }
}

/**
 * Natural circulation as ES-0.1 verifies it, once forced flow has gone (from
 * five minutes on): the core rise (core exit over the cold legs) stable or
 * falling, the cold legs at the steam generators' saturation temperature, and
 * the core exit rising only as far as that saturation temperature rises. Not
 * a flat core exit: on the ANS-5.1 decay heat the steam generators are still
 * coming back from the trip's overcooling to the steam dumps' set point, and
 * the cold legs and core exit follow them up; a core exit gaining more than
 * 1 °C on them would be a heat-up.
 */
const naturalCirculationHolds = (fromFive: ReadonlyArray<Sample>, atFive: Sample): void => {
  for (const entry of fromFive) {
    expect(entry.coreExit - entry.coldLeg, `${entry.second} s`).toBeLessThan(atFive.coreExit - atFive.coldLeg + 0.5)
    expect(Math.abs(entry.coldLeg - entry.steamGeneratorSaturation), `${entry.second} s`).toBeLessThan(3)
    expect(entry.coreExit - entry.steamGeneratorSaturation, `${entry.second} s`).toBeLessThan(atFive.coreExit - atFive.steamGeneratorSaturation + 1)
  }
}

describe('all four reactor coolant pumps tripped at full power', () => {
  const { before, at, after, read } = afterFault(act => act('trip-reactor-coolant-pumps'))

  test('starts from the full-power operating point, every loop at its rated flow', () => {
    for (const flow of before.loopFlows) expect(flow).toBeCloseTo(ratedLoopFlow, 0)
    expect(before.coreExit).toBeCloseTo(325, 0)
  })

  test('coasts the loops down on the pumps\' flywheels, about a sixth of the flow left a minute after the trip', () => {
    expect(at(10).coreFlow / ratedCoreFlow).toBeGreaterThan(0.55)
    expect(at(10).coreFlow / ratedCoreFlow).toBeLessThan(0.8)
    expect(at(60).coreFlow / ratedCoreFlow).toBeGreaterThan(0.1)
    expect(at(60).coreFlow / ratedCoreFlow).toBeLessThan(0.2)
    for (const flow of at(60).loopFlows) expect(flow).toBeCloseTo(at(60).coreFlow / loops.length, 0)
  })

  test('settles into natural circulation of a few percent within ten minutes, every loop forward', () => {
    expect(at(600).coreFlow / ratedCoreFlow).toBeGreaterThan(0.02)
    expect(at(600).coreFlow / ratedCoreFlow).toBeLessThan(0.06)
    for (const flow of at(600).loopFlows) expect(flow).toBeGreaterThan(0)
    // Buoyancy, not a set flow: the loops carry less as the decay heat falls.
    expect(at(600).coreFlow).toBeLessThan(at(300).coreFlow)
    expect(at(600).coreRise).toBeGreaterThan(10)
  })

  test('keeps the core rise within 25 °C, and circulates naturally once forced flow has gone, the core exit following the steam generators', () => {
    // Once the reactor has tripped and the core makes only decay heat.
    for (const entry of after(20)) expect(entry.coreRise, `${entry.second} s`).toBeLessThan(25)
    for (const entry of after(20)) expect(entry.coreExit, `${entry.second} s`).toBeLessThan(320)
    naturalCirculationHolds(after(300), at(300))
    expect(at(600).coreExit - at(600).coldLeg).toBeLessThan(at(300).coreExit - at(300).coldLeg)
    // Far from the run-22 core exit rising 28 °C/min a minute in.
    expect((at(70).coreExit - at(50).coreExit) * 3).toBeLessThan(20)
  })

  test('carries the decay heat to the steam generators, keeping the coolant subcooled', () => {
    expect(at(600).steamGeneratorHeat).toBeGreaterThan(0.95 * at(600).coreHeat)
    expect(read('core.coreHeatRemovalDeficitMw')).toBeLessThan(5)
    for (const entry of after(1)) expect(entry.coolingAvailability, `${entry.second} s`).toBeGreaterThan(0.99)
    for (const entry of after(30)) expect(entry.subcooling, `${entry.second} s`).toBeGreaterThan(25)
  })
})

describe('one reactor coolant pump tripped at full power', () => {
  const { at, read } = afterFault((_act, write) => write('rcpA.running', false))

  test('keeps 70 to 75 % of rated core flow on the three running pumps, which drive the idle loop backwards', () => {
    for (const seconds of [60, 600]) {
      const [idle, ...running] = at(seconds).loopFlows
      expect(idle! / ratedLoopFlow, `${seconds} s`).toBeLessThan(-0.3)
      expect(idle! / ratedLoopFlow, `${seconds} s`).toBeGreaterThan(-0.6)
      for (const flow of running) {
        expect(flow / ratedLoopFlow, `${seconds} s`).toBeGreaterThan(1.05)
        expect(flow / ratedLoopFlow, `${seconds} s`).toBeLessThan(1.15)
      }
      expect(at(seconds).coreFlow / ratedCoreFlow, `${seconds} s`).toBeGreaterThan(0.7)
      expect(at(seconds).coreFlow / ratedCoreFlow, `${seconds} s`).toBeLessThan(0.75)
    }
    // Its flow transmitter reads no flow; its hot leg carries the downcomer's water back.
    expect(read('rcpA.loopFlowKgPerS')).toBe(0)
    expect(Math.abs(read('rcs-hot-leg-a.temperatureC') - read('core.coolantInletTemperatureC'))).toBeLessThan(5)
  })

  test('cools the core in no doubt: the core exit falls toward no-load', () => {
    expect(at(60).coreExit).toBeLessThan(300)
    expect(at(600).coreExit).toBeLessThan(300)
    expect(at(600).coreRise).toBeLessThan(5)
    expect(at(600).subcooling).toBeGreaterThan(40)
  })
})

describe('a loss of offsite power at full power', () => {
  const { at, after, read } = afterFault(act => act('loss-offsite-power'))

  test('stops every reactor coolant pump, the loops coasting down as on a pump trip', () => {
    for (const loop of loops) expect(Number(read(`rcp${loop}.runningState`)), loop).toBe(0)
    expect(at(60).coreFlow / ratedCoreFlow).toBeGreaterThan(0.1)
    expect(at(60).coreFlow / ratedCoreFlow).toBeLessThan(0.2)
  })

  test('cools the core by natural circulation once forced flow has gone, the core exit following the steam generators', () => {
    expect(at(600).coreFlow / ratedCoreFlow).toBeGreaterThan(0.02)
    expect(at(600).coreFlow / ratedCoreFlow).toBeLessThan(0.06)
    for (const entry of after(20)) expect(entry.coreRise, `${entry.second} s`).toBeLessThan(25)
    naturalCirculationHolds(after(300), at(300))
    expect(at(600).steamGeneratorHeat).toBeGreaterThan(0.95 * at(600).coreHeat)
  })
})
