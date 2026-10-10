import { describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/index.ts'
import {
  commandsForProcessPlantAction,
  compileProcessPlant,
  createProcessPlantProtectionRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
  type VariablePath,
} from '../src/packs/process-plant/index.ts'
import { saturationTemperatureCFromPressureMPa } from '../src/packs/process-plant/runtime/thermophysics.ts'
import { liquidEnthalpyKjPerKg, saturationPressureMPaFromTemperatureC } from '../src/packs/process-plant/runtime/water-properties.ts'

// The deployed four-loop reference PWR at full power, run under its own I&C,
// against what a Westinghouse-type four-loop plant does.

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:primary-th', loopCount: 4 }))
const loops = ['A', 'B', 'C', 'D'] as const

const started = () => {
  const runtime = createProcessPlantRuntime({ system: plant })
  const protection = createProcessPlantProtectionRunner({ system: plant, protection: plant.automation })
  const read = (path: string): number => Number(runtime.readVariable(path as VariablePath))
  const run = (seconds: number, each?: () => void): void => {
    for (let second = 0; second < seconds; second++) {
      runtime.tick(1_000)
      protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-primary-th' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
      each?.()
    }
  }
  const active = (): ReadonlyArray<string> => {
    const snapshot = protection.snapshot()
    return [...snapshot.alarms, ...snapshot.trips].filter(lifecycle => lifecycle.active).map(lifecycle => lifecycle.id)
  }
  return { runtime, read, run, active }
}

describe('the full-power operating point', () => {
  const plantRun = started()
  plantRun.run(600)
  const { read } = plantRun
  const pressure = read('pressurizer.pressureMPa')
  const saturation = saturationTemperatureCFromPressureMPa(pressure)

  test('holds a four-loop plant\'s temperatures, pressure, level and output, with nothing annunciated', () => {
    expect(read('core.powerMw')).toBeGreaterThan(3_380)
    expect(read('core.powerMw')).toBeLessThan(3_420)
    expect(read('core.coolantInletTemperatureC')).toBeGreaterThan(285)
    expect(read('core.coolantInletTemperatureC')).toBeLessThan(292)
    expect(read('core.coolantOutletTemperatureC')).toBeGreaterThan(318)
    expect(read('core.coolantOutletTemperatureC')).toBeLessThan(328)
    expect(read('vessel.meanPrimaryCoolantTemperatureC')).toBeGreaterThan(302)
    expect(read('vessel.meanPrimaryCoolantTemperatureC')).toBeLessThan(310)
    expect(pressure).toBeGreaterThan(15.35)
    expect(pressure).toBeLessThan(15.65)
    expect(read('pressurizer.levelPercent')).toBeGreaterThan(50)
    expect(read('pressurizer.levelPercent')).toBeLessThan(60)
    expect(read('sgA.pressureMPa')).toBeGreaterThan(6.7)
    expect(read('sgA.pressureMPa')).toBeLessThan(7.1)
    expect(read('turbine.electricMw')).toBeGreaterThan(1_100)
    expect(read('turbine.electricMw')).toBeLessThan(1_200)
    expect(read('vessel.loopVoidFraction')).toBeLessThan(1e-6)
    expect(plantRun.active()).toEqual([])
  })

  test('reads the core exit a little above the hot leg, about 20 °C below saturation', () => {
    const coreExit = read('core.coreExitTemperatureC')
    const hotLeg = read('core.coolantOutletTemperatureC')
    expect(coreExit - hotLeg).toBeGreaterThan(0.5)
    expect(coreExit - hotLeg).toBeLessThan(4)
    expect(saturation - coreExit).toBeGreaterThan(19.5)
    expect(saturation - coreExit).toBeLessThan(22)
    // The subcooling monitor takes the hottest reading.
    expect(read('vessel.subcoolingMarginC')).toBeCloseTo(saturation - coreExit, 3)
  })

  test('closes its energy balance: core and pump heat leave through the steam generators', () => {
    const fission = read('core.fissionPowerMw')
    const thermal = read('core.totalThermalPowerMw')
    const pumpHeat = read('core.pumpHeatMw')
    // Core thermal power is the prompt share of fission power plus decay heat, and at steady power equals it.
    expect(thermal).toBeCloseTo(fission * 0.94 + read('core.decayHeatMw'), 6)
    expect(Math.abs(thermal - fission)).toBeLessThan(fission * 0.002)
    expect(pumpHeat).toBeGreaterThan(15)
    expect(pumpHeat).toBeLessThan(25)
    expect(read('core.heatToCoolantMw')).toBeCloseTo(thermal + pumpHeat, 2)
    const steamGeneratorHeat = loops.reduce((total, loop) => total + read(`sg${loop}.heatTransferMw`), 0)
    // Charging returns at about cold-leg temperature, so the CVCS takes little heat.
    const coldLegEnthalpy = liquidEnthalpyKjPerKg(read('core.coolantInletTemperatureC'), pressure)
    const chargingHeat = read('vessel.chargingFlowKgPerS') * (coldLegEnthalpy - liquidEnthalpyKjPerKg(read('charging-pump-to-cold-leg-a.temperatureC'), pressure)) / 1_000
    expect(Math.abs(thermal + pumpHeat - steamGeneratorHeat - chargingHeat)).toBeLessThan(0.002 * thermal)
    // The generator delivers the steam generators' heat at a 34% gross cycle efficiency.
    expect(read('turbine.electricMw') / steamGeneratorHeat).toBeGreaterThan(0.33)
    expect(read('turbine.electricMw') / steamGeneratorHeat).toBeLessThan(0.35)
  })
})

describe('a stuck-open PORV', () => {
  test('holds coolant pressure near the hot leg\'s saturation pressure while the pressurizer fills', () => {
    const plantRun = started()
    plantRun.run(60)
    for (const command of commandsForProcessPlantAction({ actionId: 'pressurizer-relief-open', parameters: { positionPercent: 100 }, graph: plant.graph })) {
      plantRun.runtime.writeCommand({ type: 'setVariable', path: command.path, value: command.value })
    }
    let lowestLevel = 100
    plantRun.run(90, () => { lowestLevel = Math.min(lowestLevel, plantRun.read('pressurizer.levelPercent')) })
    // The falling pressure lowers the overtemperature delta-T set point onto the loop delta-T, which trips the
    // reactor before the low-pressure trip would; the coolant shrinks and then flashes.
    expect(plantRun.active()).toContain('trip:reactor-overtemperature-delta-t-trip:overtemperature-delta-t-trip')
    expect(lowestLevel).toBeLessThan(40)
    const pressures: number[] = []
    plantRun.run(450, () => pressures.push(plantRun.read('pressurizer.pressureMPa')))
    const { read } = plantRun
    // For minutes the pressure hangs near the saturation pressure of the hot
    // legs, about 8 MPa after the trip, never falling far below it ...
    expect(Math.min(...pressures)).toBeGreaterThan(7)
    expect(Math.max(...pressures.slice(60))).toBeLessThan(9.5)
    const hotLegSaturation = saturationPressureMPaFromTemperatureC(read('core.coolantOutletTemperatureC'))
    expect(Math.abs(read('pressurizer.pressureMPa') - hotLegSaturation)).toBeLessThan(0.3)
    expect(read('vessel.subcoolingMarginC')).toBeGreaterThan(-2)
    expect(read('vessel.subcoolingMarginC')).toBeLessThan(2)
    // ... while steam in the loops pushes water into the pressurizer, which
    // rises far above its post-trip low, as at Three Mile Island.
    expect(read('vessel.loopVoidFraction')).toBeGreaterThan(0.05)
    expect(read('pressurizer.levelPercent')).toBeGreaterThan(90)
    expect(read('pressurizer.reliefFlowKgPerS')).toBeGreaterThan(20)
  }, 60_000)
})

describe('a reactor trip', () => {
  test('shrinks the coolant as it cools, and the pressurizer level falls', () => {
    const plantRun = started()
    plantRun.run(60)
    const { read } = plantRun
    const initialMeanTemperature = read('vessel.meanPrimaryCoolantTemperatureC')
    const initialLevel = read('pressurizer.levelPercent')
    plantRun.runtime.writeCommand({ type: 'setVariable', path: 'core.rodInsertionFraction' as VariablePath, value: 1 })
    let lowestLevel = initialLevel
    let lowestPressure = read('pressurizer.pressureMPa')
    let lowestMeanTemperature = initialMeanTemperature
    plantRun.run(180, () => {
      lowestLevel = Math.min(lowestLevel, read('pressurizer.levelPercent'))
      lowestPressure = Math.min(lowestPressure, read('pressurizer.pressureMPa'))
      lowestMeanTemperature = Math.min(lowestMeanTemperature, read('vessel.meanPrimaryCoolantTemperatureC'))
    })
    expect(initialMeanTemperature - lowestMeanTemperature).toBeGreaterThan(12)
    // About two percent of level for each degree the loops cool.
    expect(initialLevel - lowestLevel).toBeGreaterThan(20)
    expect((initialLevel - lowestLevel) / (initialMeanTemperature - lowestMeanTemperature)).toBeGreaterThan(1.5)
    expect((initialLevel - lowestLevel) / (initialMeanTemperature - lowestMeanTemperature)).toBeLessThan(2.8)
    // The outsurge flashes the pressurizer water, which holds the pressure up.
    expect(lowestPressure).toBeGreaterThan(13)
    expect(read('vessel.loopVoidFraction')).toBeLessThan(1e-6)
  }, 60_000)
})
