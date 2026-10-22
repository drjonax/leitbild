import { describe, expect, test } from 'bun:test'
import { recordingSeriesIdFor, type IsoTimestamp } from '../src/core/model/index.ts'
import {
  answerProcessPlantQuery,
  commandsForProcessPlantAction,
  compileProcessPlant,
  createProcessPlantProtectionRunner,
  createProcessPlantRampRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
  isInjectedFault,
  recordedPlantVariables,
} from '../src/packs/process-plant/index.ts'
import { plantDeclaration } from '../src/packs/process-plant/observation/declarations.ts'
import { createPlantOperations } from '../src/packs/process-plant/operations/plant-operations.ts'
import { createProcessPlantRuntimePerformance, type ProcessPlantRuntimeInstance } from '../src/packs/process-plant/runtime-instance.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// A fault the scenario injects (a stuck relief valve's failure, a tube leak's
// size) is the instructor's knob, never a reading: no person or AI agent
// searches, reads, evaluates, records or is shown it, so a training scenario's
// fault shows only through what the Plant does. The instructor's action still
// injects it. A boundary (the grid's frequency) stays a reading.

const PLANT_ID = 'plant:injected-faults'
const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: PLANT_ID, loopCount: 4 }))
const faults = plant.graph.signalBindings.filter(isInjectedFault)

const instance = (): ProcessPlantRuntimeInstance => {
  const runtime = createProcessPlantRuntime({ system: plant })
  const protection = createProcessPlantProtectionRunner({ system: plant, protection: plant.automation })
  return { plant, runtime, ramps: createProcessPlantRampRunner({ runtime }), protection, operations: createPlantOperations(), performance: createProcessPlantRuntimePerformance() }
}

const askOf = (system: ProcessPlantRuntimeInstance) => (capabilityId: string, input: unknown): unknown => answerProcessPlantQuery({
  request: { capabilityId, input },
  plants: new Map([[PLANT_ID, system]]),
  objects: new Map(),
  simulationTime: '2026-10-21T10:00:00.000Z' as IsoTimestamp,
  recordedSeriesIds: new Set(),
})

describe('a fault the scenario injects is no reading', () => {
  test('the reference Plant has injected faults, published ones among them (leak areas, tube leaks), and boundaries beside them', () => {
    expect(faults.length).toBeGreaterThan(60)
    expect(faults.filter(binding => binding.published).map(binding => String(binding.path))).toContain('sgA.tubeLeakFraction')
    expect(plant.graph.signalBindings.filter(binding => binding.actuation === 'boundary').map(binding => binding.tagId).filter(Boolean)).toEqual(expect.arrayContaining(['GRID-HZ', 'GRID-AVAIL']))
  })

  test('signals.search finds none, however it is asked; signals.resolve and signals.read refuse each with why', () => {
    const ask = askOf(instance())
    const found = (input: Record<string, unknown>) => (ask('world.process-plant.signals.search', { plantId: PLANT_ID, limit: 500, ...input }) as { readonly signals: ReadonlyArray<{ readonly signal: { readonly path: string } }> }).signals.map(entry => entry.signal.path)
    const paths = new Set(faults.map(binding => String(binding.path)))
    expect(found({}).filter(path => paths.has(path))).toEqual([])
    for (const text of ['failure', 'failed position', 'leak', 'tube leak']) expect(found({ text }).filter(path => paths.has(path))).toEqual([])
    for (const binding of [faults.find(entry => String(entry.path) === 'pressurizer.reliefValveFailureActive')!, faults.find(entry => String(entry.path) === 'sgA.tubeLeakFraction')!]) {
      for (const capabilityId of ['world.process-plant.signals.resolve', 'world.process-plant.signals.read']) {
        expect(() => ask(capabilityId, { plantId: PLANT_ID, signals: [{ path: binding.path }] })).toThrow(`${binding.path} is a fault the scenario injects, not a reading`)
      }
    }
    // A boundary stays a reading.
    expect((ask('world.process-plant.signals.read', { plantId: PLANT_ID, signals: [{ tagId: 'GRID-HZ' }] }) as { readonly signals: ReadonlyArray<unknown> }).signals).toHaveLength(1)
  })

  test('variables.search finds none and variables.read refuses each; conditions that compare one are refused', () => {
    const ask = askOf(instance())
    const paths = new Set(faults.map(binding => String(binding.path)))
    const variables = (ask('world.process-plant.variables.search', { plantId: PLANT_ID, limit: 500, text: 'leak' }) as { readonly variables: ReadonlyArray<{ readonly variable: { readonly path: string } }> }).variables
    expect(variables.filter(entry => paths.has(entry.variable.path))).toEqual([])
    const all = ask('world.process-plant.variables.search', { plantId: PLANT_ID, limit: 500, text: 'failure' }) as { readonly variables: ReadonlyArray<{ readonly variable: { readonly path: string } }> }
    expect(all.variables.filter(entry => paths.has(entry.variable.path))).toEqual([])
    expect(() => ask('world.process-plant.variables.read', { plantId: PLANT_ID, paths: ['pressurizer.reliefValveFailureActive'] })).toThrow('is a fault the scenario injects')
    const condition = { type: 'comparison', signal: { path: 'pressurizer.reliefValveFailureActive' }, operator: '==', value: true }
    expect(() => ask('world.process-plant.conditions.evaluate', { plantId: PLANT_ID, condition })).toThrow('is a fault the scenario injects')
    expect(() => ask('world.process-plant.conditions.evaluate', { plantId: PLANT_ID, condition: { type: 'all', conditions: [{ ...condition, signal: { path: 'pressurizer.levelPercent' }, operator: '>', value: 0 }, condition] } })).toThrow('is a fault the scenario injects')
  })

  test('no observable declares one, though the Run records every variable; no recording profile records one; no I&C rule reads one', () => {
    const recordedEverything = { seriesIds: new Set(plant.graph.signalBindings.map(binding => recordingSeriesIdFor(plant.id, binding.path))), intervalMs: 1_000 }
    for (const recording of [null, recordedEverything]) {
      const declared = new Set(plantDeclaration(PLANT_ID as never, plant, recording).observables.map(observable => observable.ref.slice(PLANT_ID.length + 1)))
      expect(faults.filter(binding => declared.has(String(binding.path))).map(binding => String(binding.path))).toEqual([])
      expect(declared.has('offsiteGrid.frequencyHz')).toBe(true)
      // Recorded, every other variable would be declared: the rule, not the recording, keeps the faults out.
      if (recording !== null) expect(declared.size).toBeGreaterThan(plant.graph.signalBindings.length - faults.length - 1)
    }
    for (const profile of ['operations', 'engineering']) expect(recordedPlantVariables(plant, profile).filter(variable => faults.some(binding => binding.path === variable.path))).toEqual([])
    const read = (condition: unknown): ReadonlyArray<string> => condition === null || typeof condition !== 'object' ? []
      : Object.entries(condition).flatMap(([key, value]) => key === 'signal' && typeof (value as { path?: unknown }).path === 'string' ? [String((value as { path: string }).path)] : read(value))
    const paths = new Set(faults.map(binding => String(binding.path)))
    expect(plant.automation.rules.flatMap(rule => read(rule.condition).filter(path => paths.has(path)).map(path => `${rule.id}: ${path}`))).toEqual([])
  })

  test('the instructor\'s action still injects it, and the Plant shows it only by what it does', () => {
    const system = instance()
    for (const command of commandsForProcessPlantAction({ actionId: 'pressurizer-relief-open', parameters: { positionPercent: 100 }, graph: plant.graph })) {
      system.runtime.writeCommand({ type: 'setVariable', path: command.path, value: command.value })
    }
    for (let second = 0; second < 5; second += 1) system.runtime.tick(1_000)
    expect(system.runtime.readVariable('pressurizer.reliefValveFailureActive' as never)).toBe(true)
    const ask = askOf(system)
    const read = ask('world.process-plant.signals.read', { plantId: PLANT_ID, signals: [{ path: 'pressurizer.reliefFlowKgPerS' }] }) as { readonly signals: ReadonlyArray<{ readonly variable: { readonly value: number } }> }
    expect(read.signals[0]!.variable.value).toBeGreaterThan(1)
  })
})
