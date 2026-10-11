import { describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/index.ts'
import {
  commandsForProcessPlantAction,
  compileProcessPlant,
  createProcessPlantProtectionRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
  type ProcessPlantIcConfig,
  type VariablePath,
} from '../src/packs/process-plant/index.ts'
import { validateProcessPlantControlWrite } from '../src/packs/process-plant/control-write-validation.ts'
import { saturationTemperatureCFromPressureMPa } from '../src/packs/process-plant/runtime/thermophysics.ts'
import { liquidEnthalpyKjPerKg, saturationPressureMPaFromTemperatureC } from '../src/packs/process-plant/runtime/water-properties.ts'

// The deployed four-loop reference PWR at full power, run under its own I&C,
// against what a Westinghouse-type four-loop plant does.

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:primary-th', loopCount: 4 }))
const loops = ['A', 'B', 'C', 'D'] as const

const started = (automation: ProcessPlantIcConfig = plant.automation) => {
  const runtime = createProcessPlantRuntime({ system: plant })
  const protection = createProcessPlantProtectionRunner({ system: plant, protection: automation })
  const read = (path: string): number => Number(runtime.readVariable(path as VariablePath))
  const evaluate = (): void => {
    protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-primary-th' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
  }
  const run = (seconds: number, each?: () => void): void => {
    for (let second = 0; second < seconds; second++) {
      runtime.tick(1_000)
      evaluate()
      each?.()
    }
  }
  const active = (): ReadonlyArray<string> => {
    const snapshot = protection.snapshot()
    return [...snapshot.alarms, ...snapshot.trips].filter(lifecycle => lifecycle.active).map(lifecycle => lifecycle.id)
  }
  return { runtime, read, run, evaluate, active }
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
  test('lets the pressure fall to the hot legs\' saturation pressure while safety injection fills the pressurizer', () => {
    const plantRun = started()
    plantRun.run(60)
    for (const command of commandsForProcessPlantAction({ actionId: 'pressurizer-relief-open', parameters: { positionPercent: 100 }, graph: plant.graph })) {
      plantRun.runtime.writeCommand({ type: 'setVariable', path: command.path, value: command.value })
    }
    const { read } = plantRun
    // Rated 26.5 kg/s of steam at 16.2 MPa, the open PORV passes about 25 kg/s at 15.5 MPa.
    plantRun.run(1)
    expect(read('pressurizer.reliefFlowKgPerS')).toBeGreaterThan(24)
    expect(read('pressurizer.reliefFlowKgPerS')).toBeLessThan(26.5)
    let lowestLevel = 100
    plantRun.run(89, () => { lowestLevel = Math.min(lowestLevel, read('pressurizer.levelPercent')) })
    // The falling pressure lowers the overtemperature delta-T set point onto the loop delta-T, which trips the
    // reactor before the low-pressure trip would; the coolant shrinks and the pressurizer level falls.
    expect(plantRun.active()).toContain('trip:reactor-overtemperature-delta-t-trip:overtemperature-delta-t-trip')
    expect(lowestLevel).toBeLessThan(40)
    // Safety injection then outruns the relief: the pressurizer refills while the pressure keeps falling, toward
    // the saturation pressure of the hot legs, about 8 MPa after the trip, never far below it. A level rising
    // while the pressure falls is the trap Three Mile Island's operators fell into.
    const pressures: number[] = []
    let filled: { readonly pressure: number; readonly hotLegSaturation: number; readonly subcooling: number } | null = null
    for (let second = 0; second < 1_200 && filled === null; second += 1) {
      plantRun.run(1)
      pressures.push(read('pressurizer.pressureMPa'))
      if (read('pressurizer.levelPercent') > 90) {
        filled = {
          pressure: read('pressurizer.pressureMPa'),
          hotLegSaturation: saturationPressureMPaFromTemperatureC(read('core.coolantOutletTemperatureC')),
          subcooling: read('vessel.subcoolingMarginC'),
        }
      }
    }
    expect(Math.min(...pressures)).toBeGreaterThan(7)
    expect(filled).not.toBeNull()
    expect(Math.abs(filled!.pressure - filled!.hotLegSaturation)).toBeLessThan(0.3)
    expect(filled!.subcooling).toBeGreaterThan(-2)
    expect(filled!.subcooling).toBeLessThan(2)
    expect(read('vessel.safetyInjectionFlowKgPerS')).toBeGreaterThan(40)
  })

  test('35 % open outruns the heaters: the reactor trips, SI comes in and the pressure falls to about 10.6 MPa in five minutes', () => {
    const plantRun = started()
    plantRun.run(60)
    for (const command of commandsForProcessPlantAction({ actionId: 'pressurizer-relief-open', parameters: { positionPercent: 35 }, graph: plant.graph })) {
      plantRun.runtime.writeCommand({ type: 'setVariable', path: command.path, value: command.value })
    }
    const { read } = plantRun
    const firstIn = new Map<string, number>()
    let second = 0
    plantRun.run(300, () => {
      second += 1
      for (const id of plantRun.active()) if (!firstIn.has(id)) firstIn.set(id, second)
    })
    // About 9 kg/s of steam against 1.8 MW of heaters: the pressure falls about 0.55 MPa a minute until the
    // falling pressure brings the overtemperature delta-T set point onto the loop delta-T, about two minutes in;
    // the trip's shrink takes it to the 12.7 MPa SI set point some 15 s later.
    const otdt = firstIn.get('trip:reactor-overtemperature-delta-t-trip:overtemperature-delta-t-trip')
    const si = firstIn.get('trip:safety-injection-low-pzr-pressure:safety-injection')
    expect(otdt).toBeGreaterThan(90)
    expect(otdt).toBeLessThan(160)
    expect(si).toBeGreaterThan(otdt!)
    expect(si).toBeLessThan(otdt! + 40)
    expect(read('pressurizer.pressureMPa')).toBeGreaterThan(10)
    expect(read('pressurizer.pressureMPa')).toBeLessThan(11.2)
    // The PORV then passes about 6 kg/s, a quarter of its rating at a third open and two thirds of the pressure.
    expect(read('pressurizer.reliefFlowKgPerS')).toBeGreaterThan(5.5)
    expect(read('pressurizer.reliefFlowKgPerS')).toBeLessThan(6.6)
  })

  test('passes water at its liquid rating once the pressurizer is solid, which the inventory balance counts', () => {
    const plantRun = started()
    plantRun.run(5)
    for (const command of commandsForProcessPlantAction({ actionId: 'pressurizer-relief-open', parameters: { positionPercent: 100 }, graph: plant.graph })) {
      plantRun.runtime.writeCommand({ type: 'setVariable', path: command.path, value: command.value })
    }
    const { read } = plantRun
    // While it has a steam space the pressurizer relieves steam, at its rating in proportion to the pressure.
    let steamRelief = 0
    let solidFor = 0
    for (let second = 0; second < 1_200 && solidFor < 60; second += 1) {
      plantRun.run(1)
      if (read('pressurizer.levelPercent') > 99) solidFor += 1
      else if (read('pressurizer.levelPercent') < 90) steamRelief = read('pressurizer.reliefFlowKgPerS') / (26.5 * read('pressurizer.pressureMPa') / 16.2)
    }
    expect(steamRelief).toBeCloseTo(1, 2)
    expect(read('pressurizer.levelPercent')).toBeGreaterThan(99)
    // Solid, water flashing as it chokes in the valve passes about three times the mass.
    const steamRating = 26.5 * read('pressurizer.pressureMPa') / 16.2
    expect(read('pressurizer.reliefFlowKgPerS') / steamRating).toBeGreaterThan(2.5)
    expect(read('pressurizer.reliefFlowKgPerS') / steamRating).toBeLessThan(3.5)
    expect(Math.abs(read('rcsInventoryBalance.leakRateKgPerS'))).toBeLessThan(0.063)
  })
})

describe('the pressurizer heaters', () => {
  test('are rated like a Westinghouse four-loop pressurizer\'s: 0.4 MW proportional and 1.4 MW backup, 1.8 MW in all', () => {
    const pressurizer = plant.graph.components.find(component => component.id === 'pressurizer')!
    const controlGroup = plant.graph.signalBindingByPath.get('pressurizer.heaterPowerMw' as VariablePath)!
    expect(controlGroup.limits?.hardRange).toEqual({ min: 0, max: 0.4 })
    expect((pressurizer.parameters as Readonly<Record<string, unknown>>).backupHeaterCapacityMw).toBe(1.4)
    // The pressure control energizes the control group at its rating, no more.
    const energized = plant.automation.rules.flatMap(rule => rule.effects).filter(effect => effect.type === 'writeSignal' && effect.signal.tagId === 'PZR-HTR' && effect.value !== 0)
    expect(energized.map(effect => effect.type === 'writeSignal' ? effect.value : null)).toEqual([0.4])
    // An operator can ask no more of the group than it has.
    const runtime = createProcessPlantRuntime({ system: plant })
    expect(validateProcessPlantControlWrite({ system: plant, runtime, payload: { plantId: plant.id, tagId: 'PZR-HTR', value: 12 } as never }).accepted).toBe(false)
    expect(validateProcessPlantControlWrite({ system: plant, runtime, payload: { plantId: plant.id, tagId: 'PZR-HTR', value: 0.4 } as never }).accepted).toBe(true)
  })

  test('hold 15.5 MPa at steady full power with every group off', () => {
    const plantRun = started()
    let lowest = Infinity
    let highest = -Infinity
    plantRun.run(600, () => {
      lowest = Math.min(lowest, plantRun.read('pressurizer.pressureMPa'))
      highest = Math.max(highest, plantRun.read('pressurizer.pressureMPa'))
    })
    expect(lowest).toBeGreaterThan(15.45)
    expect(highest).toBeLessThan(15.55)
    expect(plantRun.read('pressurizer.demandMw')).toBe(0)
    expect(plantRun.read('pressurizer.backupHeaterDemandMw')).toBe(0)
  })
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
  })
})

describe('a steam generator tube rupture without charging or letdown', () => {
  test('drains the pressurizer and settles where safety injection makes up the leak, lifting no relief valve', () => {
    const plantRun = started()
    plantRun.run(60)
    const { read } = plantRun
    for (const pump of ['chargingPump', 'chargingPumpB']) {
      plantRun.runtime.writeCommand({ type: 'setVariable', path: `${pump}.running` as VariablePath, value: false })
    }
    plantRun.runtime.writeCommand({ type: 'setVariable', path: 'letdownValve.positionFraction' as VariablePath, value: 0 })
    plantRun.runtime.writeCommand({ type: 'setVariable', path: 'sgA.tubeLeakFraction' as VariablePath, value: 0.18 })
    let drainedPressure: number | null = null
    let peakPressureDrained = 0
    let peakReliefDrained = 0
    plantRun.run(540, () => {
      if (drainedPressure === null && read('pressurizer.levelPercent') < 1) drainedPressure = read('pressurizer.pressureMPa')
      if (drainedPressure === null) return
      peakPressureDrained = Math.max(peakPressureDrained, read('pressurizer.pressureMPa'))
      peakReliefDrained = Math.max(peakReliefDrained, read('pressurizer.reliefFlowKgPerS') + read('pressurizer.safetyValveFlowKgPerS'))
    })
    // The last few kilograms of water in the drained pressurizer cannot hold
    // its steam up at their own saturation pressure: from the moment it
    // drains, the pressure only falls, and no relief valve lifts.
    expect(drainedPressure).not.toBeNull()
    expect(peakPressureDrained).toBeLessThan(drainedPressure! + 0.1)
    expect(peakReliefDrained).toBe(0)
    // It settles above the ruptured generator's pressure, where the safety
    // injection pumps deliver what the leak takes, with the loops still full.
    expect(read('pressurizer.pressureMPa')).toBeGreaterThan(read('sgA.pressureMPa'))
    expect(Math.abs(read('vessel.safetyInjectionFlowKgPerS') - read('vessel.tubeLeakFlowKgPerS'))).toBeLessThan(10)
    expect(read('vessel.loopVoidFraction')).toBeLessThan(0.01)
  })
})

describe('a pressurizer filling toward solid', () => {
  test('compresses its steam smoothly, without its pressure ringing from one solver step to the next', () => {
    // A loss of feedwater at power with every reactor trip but overtemperature
    // delta-T out of service: the coolant heats up and swells into the
    // pressurizer until its steam space is small.
    const plantRun = started({
      ...plant.automation,
      rules: plant.automation.rules.filter(rule => rule.id === 'reactor-overtemperature-delta-t-trip'
        || !rule.effects.some(effect => effect.type === 'writeSignal' && effect.signal.tagId === 'TRIP-BKR-A')),
    })
    plantRun.run(5)
    const { read } = plantRun
    for (const command of commandsForProcessPlantAction({ actionId: 'loss-main-feedwater', parameters: {}, graph: plant.graph })) {
      plantRun.runtime.writeCommand({ type: 'setVariable', path: command.path, value: command.value })
    }
    // A small steam space over the whole system's compressible water: the
    // pressure follows the water's growth, step by solver step.
    let previousPressure = read('pressurizer.pressureMPa')
    let largestStepChange = 0
    let highestLevel = 0
    for (let second = 0; second < 170; second++) {
      for (let step = 0; step < 10; step++) {
        plantRun.runtime.tick(100)
        const pressure = read('pressurizer.pressureMPa')
        const level = read('pressurizer.levelPercent')
        if (level > 70 && level < 97) largestStepChange = Math.max(largestStepChange, Math.abs(pressure - previousPressure))
        previousPressure = pressure
        highestLevel = Math.max(highestLevel, level)
      }
      plantRun.evaluate()
    }
    expect(highestLevel).toBeGreaterThan(95)
    expect(largestStepChange).toBeLessThan(0.05)
  })
})

describe('a pressurizer draining below its low-level cutoff', () => {
  test('cuts off its heaters and isolates letdown at 17 %', () => {
    const plantRun = started()
    plantRun.run(30)
    const { read } = plantRun
    // A cold-leg leak of about 150 kg/s drains the pressurizer; the pressure
    // falls with its level and the heaters come on.
    plantRun.runtime.writeCommand({ type: 'setVariable', path: 'rcs-cold-leg-a.leak.areaFraction' as VariablePath, value: 0.005 })
    let heatedAbove = false
    let cutOffAt: number | null = null
    let heatedBelow = 0
    // Read each solver step: the reactor trips on low pressure as the level nears the cutoff, and the coolant's
    // shrink as the rods drop takes the level through it at several percent a second.
    for (let second = 0; second < 150; second++) {
      for (let step = 0; step < 10; step++) {
        plantRun.runtime.tick(100)
        const level = read('pressurizer.levelPercent')
        if (level > 20 && read('pressurizer.demandMw') > 0) heatedAbove = true
        if (cutOffAt === null && read('pressurizer.heatersCutOff') === 1) cutOffAt = level
        if (level < 16.5) heatedBelow = Math.max(heatedBelow, read('pressurizer.demandMw'))
      }
      plantRun.evaluate()
    }
    expect(heatedAbove).toBe(true)
    expect(cutOffAt).not.toBeNull()
    expect(cutOffAt!).toBeGreaterThan(15)
    expect(cutOffAt!).toBeLessThan(17)
    expect(heatedBelow).toBe(0)
    expect(read('pressurizer.heaterPowerMw')).toBeGreaterThan(0)
    expect(read('vessel.letdownFlowKgPerS')).toBe(0)
    expect(plantRun.active()).toContain('alarm:pzr-level-low-heaters-off:heaters-off-letdown-isolated')
  })
})

describe('pressurizer level control', () => {
  test('brings the level back to its program after a reactor trip, and holds it there', () => {
    const plantRun = started()
    plantRun.run(60)
    const { read } = plantRun
    // The program asks for 55 % at full-load Tavg, 25 % at no-load.
    expect(read('pressurizer.levelProgramPercent')).toBeCloseTo(55, 0)
    plantRun.runtime.writeCommand({ type: 'setVariable', path: 'core.rodInsertionFraction' as VariablePath, value: 1 })
    let lowestLevel = 100
    let highestCharging = 0
    plantRun.run(300, () => {
      lowestLevel = Math.min(lowestLevel, read('pressurizer.levelPercent'))
      highestCharging = Math.max(highestCharging, read('vessel.chargingFlowKgPerS'))
    })
    // The coolant shrinks faster than charging, at its most about 150 gpm,
    // can make up: the level dips toward the cutoff, which may isolate
    // letdown, and an operator restores it.
    expect(highestCharging).toBeGreaterThan(9.5)
    expect(lowestLevel).toBeGreaterThan(12)
    plantRun.runtime.writeCommand({ type: 'setVariable', path: 'letdownValve.positionFraction' as VariablePath, value: 1 })
    plantRun.run(1_500)
    // The level sits on the no-load end of the program, with charging back in
    // balance with letdown.
    expect(read('pressurizer.levelProgramPercent')).toBeLessThan(32)
    expect(Math.abs(read('pressurizer.levelPercent') - read('pressurizer.levelProgramPercent'))).toBeLessThan(1.5)
    expect(Math.abs(read('vessel.chargingFlowKgPerS') - read('vessel.letdownFlowKgPerS'))).toBeLessThan(1)
    expect(read('pressurizer.pressureMPa')).toBeGreaterThan(15.3)
  })

  test('cuts charging back when letdown is isolated, so the pressurizer does not fill', () => {
    const plantRun = started()
    plantRun.run(30)
    const { read } = plantRun
    plantRun.runtime.writeCommand({ type: 'setVariable', path: 'letdownValve.positionFraction' as VariablePath, value: 0 })
    let highestLevel = 0
    plantRun.run(600, () => { highestLevel = Math.max(highestLevel, read('pressurizer.levelPercent')) })
    expect(read('vessel.chargingFlowKgPerS')).toBeLessThan(0.5)
    expect(highestLevel).toBeLessThan(62)
    expect(read('pressurizer.pressureMPa')).toBeLessThan(15.8)
    expect(read('pressurizer.reliefFlowKgPerS')).toBe(0)
  })
})

describe('after a loss of offsite power', () => {
  test('the steam generator relief valves hold their pressure part open, passing what their opening and the pressure drive', () => {
    const plantRun = started()
    plantRun.run(30)
    const { read } = plantRun
    for (const command of commandsForProcessPlantAction({ actionId: 'loss-offsite-power', parameters: {}, graph: plant.graph })) {
      plantRun.runtime.writeCommand({ type: 'setVariable', path: command.path, value: command.value })
    }
    plantRun.run(20)
    for (const diesel of ['dieselGeneratorA', 'dieselGeneratorB']) {
      plantRun.runtime.writeCommand({ type: 'setVariable', path: `${diesel}.startCommand` as VariablePath, value: true })
    }
    // On the ANS-5.1 decay heat the generators take some 16 minutes to heat
    // their auxiliary feed back up to the relief valves' set point.
    plantRun.run(1_180)
    // Natural circulation carries the decay heat to the generators; their
    // relief valves, set at 7.86 MPa, open only as far as it takes to pass
    // the steam they raise ...
    const pressure = read('sgA.pressureMPa')
    const opening = read('steamGeneratorReliefValveA.effectivePositionFraction')
    const reliefFlow = read('sg-a-steam-to-relief-valve-a.flowKgPerS')
    expect(pressure).toBeGreaterThan(7.86)
    expect(pressure).toBeLessThan(8)
    expect(opening).toBeGreaterThan(0.05)
    expect(opening).toBeLessThan(0.5)
    expect(Math.abs(reliefFlow - read('sgA.steamFlowKgPerS'))).toBeLessThan(0.3 * read('sgA.steamFlowKgPerS'))
    // ... and what passes is what the opening and the pressure drive through
    // a valve rated 21 kg/s per square-root MPa.
    expect(reliefFlow).toBeCloseTo(21 * opening * Math.sqrt(pressure - 0.101325), 0)
  })
})
