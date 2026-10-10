import { describe, expect, test } from 'bun:test'
import { compileProcessPlant } from '../src/packs/process-plant/plant-compiler.ts'
import { createPwrReferencePlantDefinition, processPlantDefinitionCatalog } from '../src/packs/process-plant/plant-definitions.ts'
import { createProcessPlantRuntime } from '../src/packs/process-plant/runtime/runtime.ts'
import type { VariablePath } from '../src/packs/process-plant/graph/index.ts'
import { saturationTemperatureCFromPressureMPa } from '../src/packs/process-plant/runtime/thermophysics.ts'

describe('authoritative PWR full-power operating point', () => {
  test('saturation temperature agrees with the IAPWS region 4 verification points', () => {
    for (const [pressure, kelvin] of [[0.1, 372.755919], [1, 453.035632], [10, 584.149488]]) {
      expect(saturationTemperatureCFromPressureMPa(pressure!) + 273.15).toBeCloseTo(kelvin!, 6)
    }
  })
  for (const loopCount of [2, 3, 4, 5, 6]) {
    test(`resolves real initialized power and all ${loopCount} steam generators`, () => {
      const system = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'test:plant', loopCount }))
      const runtime = createProcessPlantRuntime({ system })
      const read = (path: string) => Number(runtime.readVariable(path as VariablePath))
      // The steam generators carry the core's 3,400 MW and the reactor coolant
      // pumps' heat; the generator turns it into power at 34% gross.
      const pumpHeat = read('core.pumpHeatMw')
      const steamGeneratorHeat = 3400 + pumpHeat
      const ratedElectric = steamGeneratorHeat * 0.34
      expect(pumpHeat).toBeGreaterThan(15)
      expect(pumpHeat).toBeLessThan(25)
      expect(read('core.powerMw')).toBe(3400)
      expect(read('core.totalThermalPowerMw')).toBe(3400)
      expect(read('turbine.electricMw')).toBeCloseTo(ratedElectric, 8)
      expect(read('turbine.loadFraction')).toBe(1)
      // The loops start full at the operating point's temperatures, so they hold their nominal inventory.
      const initialInventory = read('vessel.primaryCoolantInventoryKg')
      expect(initialInventory / Number((system.sourceGraph.components.find(component => component.id === 'vessel')!.parameters as Record<string, unknown>).nominalPrimaryCoolantInventoryKg)).toBeCloseTo(1, 6)
      for (const component of system.sourceGraph.components.filter(component => component.kind === 'steamGenerator')) {
        expect(read(`${component.id}.steamFlowKgPerS`)).toBeCloseTo(steamGeneratorHeat / 2.26 / loopCount, 8)
      }
      runtime.tick(100)
      expect(read('core.temperatureFeedbackPcm')).toBeCloseTo(0, 6)
      expect(read('core.powerMw')).toBeCloseTo(3400, 6)
      expect(read('sgA.heatTransferMw')).toBeCloseTo(steamGeneratorHeat / loopCount, 4)
      expect(runtime.readVariable('safetyBusA.energized' as VariablePath)).toBe(true)
      for (let step = 1; step < 600; step++) runtime.tick(100)
      // Normal CVCS heat exchange is a small transient, not a 15–50% collapse.
      expect(read('turbine.electricMw')).toBeGreaterThan(ratedElectric * 0.97)
      expect(read('turbine.electricMw')).toBeLessThanOrEqual(ratedElectric + 1)
      // The loops hold the inventory they started with: charging matches letdown.
      expect(read('vessel.primaryCoolantInventoryKg') / initialInventory).toBeCloseTo(1, 3)
      // The operating point initializes real state; it must never clamp power.
      runtime.writeCommand({ type: 'setVariable', path: 'core.rodInsertionFraction' as VariablePath, value: 1 })
      for (let step = 0; step < 150; step++) runtime.tick(100)
      expect(read('core.powerMw')).toBeLessThan(340)
    })
  }

  test('sparse explicit overrides merge with point defaults and are validated', () => {
    const definition = createPwrReferencePlantDefinition({
      id: 'test:custom',
      parameterOverrides: { core: { ratedPowerMw: 3000 }, turbine: { initialLoadFraction: 0.7 } },
    })
    const runtime = createProcessPlantRuntime({ system: compileProcessPlant(definition) })
    expect(runtime.readVariable('core.powerMw' as VariablePath)).toBe(3000)
    expect(runtime.readVariable('turbine.loadFraction' as VariablePath)).toBe(0.7)
    expect(() => compileProcessPlant(createPwrReferencePlantDefinition({ id: 'bad', parameterOverrides: { core: { initialPowerFraction: 2 } } }))).toThrow()
    expect(() => compileProcessPlant(createPwrReferencePlantDefinition({ id: 'bad', parameterOverrides: { missing: {} } }))).toThrow('unknown component')
    expect(processPlantDefinitionCatalog().operatingPoints[0]?.description).toContain('100%')
  })

  test('restore retains actual progressed state instead of reapplying the operating point', () => {
    const system = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'test:restore' }))
    const runtime = createProcessPlantRuntime({ system })
    runtime.tick(1000)
    const checkpoint = runtime.checkpoint()
    const restored = createProcessPlantRuntime({ system, restoredCheckpoint: checkpoint })
    expect(restored.snapshot()).toEqual(runtime.snapshot())
  })

  // This executes 6,000 real solver steps; the shared CI runner can take more
  // than Bun's five-second default. It is a correctness test, not a CPU benchmark.
  test('full-power balance stays bounded through ten minutes without forcing output', () => {
    const runtime = createProcessPlantRuntime({ system: compileProcessPlant(createPwrReferencePlantDefinition({ id: 'test:steady' })) })
    const ratedElectric = Number(runtime.readVariable('turbine.electricMw' as VariablePath))
    const initialInventory = Number(runtime.readVariable('vessel.primaryCoolantInventoryKg' as VariablePath))
    for (let step = 0; step < 6000; step++) {
      runtime.tick(100)
      if (step % 600 === 599) {
        expect(Number(runtime.readVariable('turbine.electricMw' as VariablePath))).toBeGreaterThan(ratedElectric * 0.97)
        expect(Number(runtime.readVariable('turbine.electricMw' as VariablePath))).toBeLessThanOrEqual(ratedElectric + 1)
        expect(Number(runtime.readVariable('vessel.primaryCoolantInventoryKg' as VariablePath)) / initialInventory).toBeCloseTo(1, 3)
      }
    }
  }, 120_000)
})
