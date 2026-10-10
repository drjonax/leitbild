import { describe, expect, test } from 'bun:test'
import { electricGridDefinitionCatalog } from '../src/packs/electric-grid/definition-refs.ts'
import { gridAutomationPreset } from '../src/packs/electric-grid/definitions.ts'
import { evaluateGeneratorProtection, createGeneratorProtectionState } from '../src/packs/electric-grid/runtime/frequency/generator-protection.ts'
import { allocateFrequencyReserves, noReserves } from '../src/packs/electric-grid/runtime/frequency/governors.ts'
import {
  createIslandFrequencyState,
  rearmIslandLfddStage,
  resetIslandGeneratorProtection,
  restoreIslandLfddStage,
  type FrequencyAction,
  type IslandFrequencyState,
} from '../src/packs/electric-grid/runtime/frequency/island-state.ts'
import { advanceIslandFrequency, type IslandFrequencyAdvance } from '../src/packs/electric-grid/runtime/frequency/island.ts'
import { integrateSwingSubStep } from '../src/packs/electric-grid/runtime/frequency/swing.ts'
import type { FrequencyLoad, FrequencyStorageUnit, FrequencyUnit, IslandFrequencyInput } from '../src/packs/electric-grid/runtime/frequency/types.ts'
import { gridAutomationSchema, type GridAutomation } from '../src/packs/electric-grid/schemas/grid-automation.ts'

const nordic = gridAutomationPreset('electric-grid.frequency.nordic-2025')
const training = gridAutomationPreset('electric-grid.frequency.manual-balancing-training')
const islanded = gridAutomationPreset('electric-grid.frequency.islanded-operation')

interface IslandSpec {
  readonly automation: GridAutomation
  readonly loadMw: number
  /** Kinetic energy of the machines that remain after the loss. */
  readonly kineticEnergyMws: number
  readonly lossMw: number
  readonly unitCount?: number
  readonly loads?: ReadonlyArray<FrequencyLoad>
  readonly storage?: ReadonlyArray<FrequencyStorageUnit>
  readonly storageStateOfCharge?: number
}

interface BuiltIsland {
  readonly before: IslandFrequencyInput
  readonly after: IslandFrequencyInput
  readonly state: IslandFrequencyState
}

/** Hydro units at 70 % loading carry the load; a separate unit carries the lost infeed and trips at t = 0. */
const buildIsland = (spec: IslandSpec): BuiltIsland => {
  const unitCount = spec.unitCount ?? 40
  const storageScheduledMw = (spec.storage ?? []).reduce((sum, unit) => sum + unit.scheduledMw, 0)
  const balancingMw = spec.loadMw - spec.lossMw - storageScheduledMw
  const unitMaximumMw = balancingMw / unitCount / 0.7
  const ratedMva = unitMaximumMw / 0.9
  const inertiaConstantSeconds = spec.kineticEnergyMws / (unitCount * ratedMva)
  const raw = Array.from({ length: unitCount }, (_, index) => ({
    id: `hydro-${index}`,
    connection: 'synchronous' as const,
    governorClass: 'hydro' as const,
    synchronised: true,
    ratedMva,
    inertiaConstantSeconds,
    minimumMw: 0,
    maximumMw: unitMaximumMw,
    targetMw: balancingMw / unitCount,
    rampRateMwPerSecond: unitMaximumMw / 60,
  }))
  const lost: FrequencyUnit = {
    id: 'lost-unit', connection: 'synchronous', governorClass: 'none', synchronised: true,
    ratedMva: spec.lossMw / 0.9, inertiaConstantSeconds, minimumMw: 0, maximumMw: spec.lossMw, targetMw: spec.lossMw,
    rampRateMwPerSecond: spec.lossMw / 60, reserves: noReserves,
  }
  const allocation = allocateFrequencyReserves({ automation: spec.automation, units: raw, islandLoadMw: spec.loadMw })
  const units: FrequencyUnit[] = raw.map(unit => ({ ...unit, reserves: allocation.allocations.get(unit.id)! }))
  const loads = spec.loads ?? [{ id: 'demand', priority: 'normal', demandMw: spec.loadMw, protectedMw: 0 }]
  const before: IslandFrequencyInput = { islandId: 'island', units: [...units, lost], storage: spec.storage ?? [], loads, externals: [], lossesMw: 0, fixedInjectionMw: 0 }
  const after: IslandFrequencyInput = { ...before, units: [...units, { ...lost, synchronised: false }] }
  const state = createIslandFrequencyState(spec.automation, before, {
    frequencyHz: 50,
    startSeconds: 0,
    storageStateOfChargeFraction: Object.fromEntries((spec.storage ?? []).map(unit => [unit.id, spec.storageStateOfCharge ?? 0.5])),
  })
  return { before, after, state }
}

interface SimulationResult {
  readonly state: IslandFrequencyState
  readonly nadirHz: number
  readonly nadirAtSeconds: number
  readonly frequencyAt: ReadonlyMap<number, number>
  readonly actions: ReadonlyArray<FrequencyAction>
  readonly last: IslandFrequencyAdvance
}

const simulate = (automation: GridAutomation, state: IslandFrequencyState, input: IslandFrequencyInput, seconds: number, dtSeconds: number): SimulationResult => {
  let current = state
  let nadirHz = Number.POSITIVE_INFINITY
  let nadirAtSeconds = 0
  const frequencyAt = new Map<number, number>()
  const actions: FrequencyAction[] = []
  let last: IslandFrequencyAdvance | null = null
  const steps = Math.round(seconds / dtSeconds)
  for (let index = 0; index < steps; index += 1) {
    last = advanceIslandFrequency(automation, current, input, dtSeconds)
    current = last.state
    actions.push(...last.actions)
    if (last.extremes && last.extremes.minimumHz < nadirHz) {
      nadirHz = last.extremes.minimumHz
      nadirAtSeconds = last.extremes.minimumAtSeconds
    }
    if (current.frequencyHz === null) break
    frequencyAt.set(Math.round(current.elapsedSeconds * 1_000) / 1_000, current.frequencyHz)
  }
  if (!last) throw new Error('simulation ran no step')
  return { state: current, nadirHz, nadirAtSeconds, frequencyAt, actions, last }
}

const frequencyAt = (result: SimulationResult, seconds: number): number => {
  const value = result.frequencyAt.get(seconds)
  if (value === undefined) throw new Error(`no sample at ${seconds} s`)
  return value
}

describe('electric grid Automation presets', () => {
  test('every preset validates and the Nordic preset cites a source for every section', () => {
    const presetIds = electricGridDefinitionCatalog.automations.map(entry => entry.id)
    expect([...presetIds].sort()).toEqual([
      'electric-grid.frequency.islanded-operation',
      'electric-grid.frequency.manual-balancing-training',
      'electric-grid.frequency.nordic-2025',
    ])
    for (const id of presetIds) {
      const preset = gridAutomationPreset(id)
      expect(gridAutomationSchema.parse(preset)).toEqual(preset)
    }
    const cited = new Set(nordic.sources.filter(source => source.status !== 'modelling-choice').map(source => source.section))
    for (const section of ['swing', 'fcrN', 'fcrD', 'afrr', 'mfrr', 'lfdd', 'storage', 'generatorProtection', 'synchroCheck'] as const) {
      expect(cited.has(section)).toBe(true)
    }
    expect(training.afrr.enabled).toBe(false)
    expect(training.mfrr.enabled).toBe(false)
  })

  test('the schema rejects inconsistent automation', () => {
    const invalid = (change: (value: Record<string, unknown>) => void): boolean => {
      const value = structuredClone(nordic) as unknown as Record<string, unknown>
      change(value)
      return gridAutomationSchema.safeParse(value).success
    }
    expect(invalid(() => undefined)).toBe(true)
    expect(invalid(value => { value.unexpected = true })).toBe(false)
    expect(invalid(value => { value.afrr = { enabled: false } })).toBe(false)
    expect(invalid(value => {
      const lfdd = value.lfdd as { stages: Array<{ thresholdHz: number }> }
      lfdd.stages[1]!.thresholdHz = lfdd.stages[0]!.thresholdHz + 0.1
    })).toBe(false)
    expect(invalid(value => { (value.simulation as { subStepSeconds: number }).subStepSeconds = 0.3 })).toBe(false)
  })
})

describe('island swing equation', () => {
  test('a constant imbalance changes frequency by ΔP·h·f0/(2·E_k) and load damping relaxes it', () => {
    const step = integrateSwingSubStep({
      nominalFrequencyHz: 50, frequencyHz: 50, kineticEnergyMws: 10_000, stepSeconds: 0.1,
      fixedEnergyMws: 900 * 0.1, loadMw: 1_000, loadDampingPerHz: 0, externalDampingMwPerHz: 0, elements: [],
    })
    expect(step.frequencyHz - 50).toBeCloseTo(-100 * 0.1 * 50 / 20_000, 12)
    expect(step.rocofHzPerSecond).toBeCloseTo(-0.25, 12)
  })

  test('(a) a step loss matches the closed-form single-machine response with governor lag within 1 %', () => {
    // FCR-N only, deviation inside its linear band: M·dΔf/dt = −ΔP − D·Δf + Pg, T·dPg/dt = −K·Δf − Pg.
    const automation = training
    const T = automation.fcrN.timeConstantSeconds
    const kineticEnergyMws = 10_000
    const loadMw = 2_000
    const allocationMw = 100
    const lossMw = 5
    const M = 2 * kineticEnergyMws / 50
    const D = loadMw * automation.swing.loadDampingPercentPerHz / 100
    const K = allocationMw / automation.fcrN.fullActivationDeviationHz
    const machine: FrequencyUnit = {
      id: 'machine', connection: 'synchronous', governorClass: 'hydro', synchronised: true, ratedMva: 2_500,
      inertiaConstantSeconds: kineticEnergyMws / 2_500, minimumMw: 0, maximumMw: 2_400, targetMw: loadMw - lossMw,
      rampRateMwPerSecond: 10, reserves: { ...noReserves, fcrNMw: allocationMw },
    }
    const lost: FrequencyUnit = { ...machine, id: 'lost', governorClass: 'none', ratedMva: 12, inertiaConstantSeconds: 0, maximumMw: lossMw, targetMw: lossMw, reserves: noReserves }
    const before: IslandFrequencyInput = { islandId: 'single', units: [machine, lost], storage: [], loads: [{ id: 'load', priority: 'normal', demandMw: loadMw, protectedMw: 0 }], externals: [], lossesMw: 0, fixedInjectionMw: 0 }
    const after: IslandFrequencyInput = { ...before, units: [machine, { ...lost, synchronised: false }] }
    let state = createIslandFrequencyState(automation, before, { frequencyHz: 50, startSeconds: 0, storageStateOfChargeFraction: {} })
    const h = automation.simulation.subStepSeconds
    const trace = [0]
    for (let index = 0; index < 6_000; index += 1) {
      state = advanceIslandFrequency(automation, state, after, h).state
      trace.push(state.frequencyHz! - 50)
    }
    const sigma = (1 / T + D / M) / 2
    const omegaD = Math.sqrt((D + K) / (M * T) - sigma * sigma)
    const settledHz = -lossMw / (D + K)
    const a = -settledHz
    const b = (-lossMw / M + sigma * a) / omegaD
    const closedForm = (t: number): number => settledHz + Math.exp(-sigma * t) * (a * Math.cos(omegaD * t) + b * Math.sin(omegaD * t))
    let nadirTime = Math.atan2(-sigma * a + omegaD * b, sigma * b + omegaD * a) / omegaD
    if (nadirTime < 0) nadirTime += Math.PI / omegaD
    let lowest = 1
    for (let index = 1; index < trace.length; index += 1) if (trace[index]! < trace[lowest]!) lowest = index
    const [y0, y1, y2] = [trace[lowest - 1]!, trace[lowest]!, trace[lowest + 1]!]
    const offset = (y0 - y2) / (2 * (y0 - 2 * y1 + y2))
    const simulatedNadirTime = (lowest + offset) * h
    const simulatedNadirHz = y1 - (y0 - y2) * offset / 4
    expect(Math.abs(closedForm(nadirTime))).toBeLessThan(automation.fcrN.fullActivationDeviationHz)
    expect(Math.abs(simulatedNadirHz / closedForm(nadirTime) - 1)).toBeLessThan(0.01)
    expect(Math.abs(simulatedNadirTime / nadirTime - 1)).toBeLessThan(0.01)
    expect(Math.abs(trace.at(-1)! / settledHz - 1)).toBeLessThan(0.01)
    console.info(`(a) nadir ${simulatedNadirHz.toFixed(6)} Hz vs ${closedForm(nadirTime).toFixed(6)} Hz; t ${simulatedNadirTime.toFixed(3)} s vs ${nadirTime.toFixed(3)} s; settled ${trace.at(-1)!.toFixed(6)} vs ${settledHz.toFixed(6)} Hz`)
  })
})

describe('island frequency control', () => {
  test('(b) nadir and frequency at 120 s do not depend on the adapter step', () => {
    const cases = [
      { name: 'nordic 15 GW', automation: nordic, loadMw: 15_000, kineticEnergyMws: 60_000, lossMw: 267 },
      { name: 'islanded 1 GW', automation: islanded, loadMw: 1_000, kineticEnergyMws: 5_000, lossMw: 120, unitCount: 8 },
    ]
    for (const spec of cases) {
      const results = [0.5, 1, 2, 10, 60].map(dt => {
        const island = buildIsland(spec)
        return { dt, result: simulate(spec.automation, island.state, island.after, 120, dt) }
      })
      const reference = results[0]!.result
      for (const { dt, result } of results) {
        expect(Math.abs(result.nadirHz - reference.nadirHz)).toBeLessThan(0.005)
        expect(Math.abs(frequencyAt(result, 120) - frequencyAt(reference, 120))).toBeLessThan(0.005)
        console.info(`(b) ${spec.name} dt ${dt} s: nadir ${result.nadirHz.toFixed(6)} Hz, f(120 s) ${frequencyAt(result, 120).toFixed(6)} Hz`)
      }
    }
  })

  test('(c) the Nordic dimensioning incident keeps frequency at or above 49.0 Hz without LFDD', () => {
    // Nordic dimensioning incident 1,450 MW; minimum instantaneous frequency 49.0 Hz (see preset sources).
    for (const kineticEnergyMws of [120_000, 200_000]) {
      const island = buildIsland({ automation: nordic, loadMw: 40_000, kineticEnergyMws, lossMw: 1_450 })
      const result = simulate(nordic, island.state, island.after, 300, 1)
      expect(result.nadirHz).toBeGreaterThanOrEqual(49.0)
      expect(result.actions.filter(action => action.kind === 'lfdd-stage-operated')).toHaveLength(0)
      expect(result.actions.filter(action => action.kind === 'generator-trip')).toHaveLength(0)
      console.info(`(c) E_k ${kineticEnergyMws / 1_000} GWs: nadir ${result.nadirHz.toFixed(4)} Hz at ${result.nadirAtSeconds.toFixed(1)} s`)
    }
  })

  test('(d) aFRR restores |Δf| < 10 mHz within 300 s after a 267 MW loss in a 15 GW island', () => {
    const island = buildIsland({ automation: nordic, loadMw: 15_000, kineticEnergyMws: 60_000, lossMw: 267 })
    const result = simulate(nordic, island.state, island.after, 900, 1)
    const restoredAt = [...result.frequencyAt].find(([seconds]) =>
      [...result.frequencyAt].every(([later, hz]) => later < seconds || Math.abs(hz - 50) < 0.01))
    expect(restoredAt).toBeDefined()
    expect(restoredAt![0]).toBeLessThanOrEqual(300)
    console.info(`(d) |Δf| < 10 mHz from ${restoredAt![0]} s; f(300 s) ${frequencyAt(result, 300).toFixed(5)} Hz; nadir ${result.nadirHz.toFixed(4)} Hz`)
  })

  test('mFRR takes over saturated aFRR and frees it', () => {
    const island = buildIsland({ automation: nordic, loadMw: 40_000, kineticEnergyMws: 150_000, lossMw: 1_450 })
    if (!nordic.afrr.enabled || !nordic.mfrr.enabled) throw new Error('Nordic preset must enable aFRR and mFRR')
    const result = simulate(nordic, island.state, island.after, 2_400, 2)
    const activations = result.actions.filter(action => action.kind === 'mfrr-activated')
    expect(activations.length).toBeGreaterThan(0)
    expect(activations[0]!.atSeconds).toBeGreaterThanOrEqual(nordic.mfrr.sustainedSeconds)
    expect(Math.abs(result.last.afrr!.utilisation)).toBeLessThan(nordic.mfrr.afrrUtilisationThresholdFraction)
    expect(Math.abs(result.state.frequencyHz! - 50)).toBeLessThan(0.01)
    console.info(`mFRR: first activation ${activations[0]!.activatedMw.toFixed(0)} MW at ${activations[0]!.atSeconds.toFixed(0)} s; ${activations.length} activations; aFRR utilisation at 2,400 s ${result.last.afrr!.utilisation.toFixed(3)}; f ${result.state.frequencyHz!.toFixed(4)} Hz`)
  })

  test('(e) LFDD stages latch, operate once each, spare critical loads and never reconnect by themselves', () => {
    const loads: FrequencyLoad[] = [
      { id: 'ev-charging', priority: 'low', demandMw: 300, protectedMw: 0 },
      { id: 'residential', priority: 'normal', demandMw: 800, protectedMw: 0 },
      { id: 'industry', priority: 'high', demandMw: 500, protectedMw: 0 },
      { id: 'hospital', priority: 'critical', demandMw: 400, protectedMw: 0 },
    ]
    const island = buildIsland({ automation: nordic, loadMw: 2_000, kineticEnergyMws: 12_000, lossMw: 700, unitCount: 10, loads })
    const result = simulate(nordic, island.state, island.after, 900, 1)
    const operations = result.actions.filter((action): action is Extract<FrequencyAction, { kind: 'lfdd-stage-operated' }> => action.kind === 'lfdd-stage-operated')
    expect(operations.map(operation => operation.stageId)).toEqual(nordic.lfdd.stages.map(stage => stage.id))
    const shed = new Map<string, number>()
    for (const operation of operations) {
      for (const [loadId, mw] of Object.entries(operation.shedMwByLoad)) shed.set(loadId, (shed.get(loadId) ?? 0) + mw)
      const sheddable = (loadId: string): number => loads.find(load => load.id === loadId)!.demandMw - (shed.get(loadId) ?? 0)
      if ((shed.get('hospital') ?? 0) > 0) expect(sheddable('ev-charging') + sheddable('residential') + sheddable('industry')).toBeLessThan(1e-6)
      if ((shed.get('industry') ?? 0) > 0) expect(sheddable('ev-charging') + sheddable('residential')).toBeLessThan(1e-6)
    }
    expect(shed.get('hospital') ?? 0).toBe(0)
    const totalShed = [...shed.values()].reduce((sum, mw) => sum + mw, 0)
    expect(totalShed).toBeCloseTo(2_000 * nordic.lfdd.stages.reduce((sum, stage) => sum + stage.shareOfLoad, 0), 6)
    // Frequency has recovered, yet every stage stays operated and its load stays shed.
    expect(result.state.frequencyHz!).toBeGreaterThan(nordic.lfdd.stages[0]!.thresholdHz)
    expect(Object.values(result.state.lfdd.stages).every(stage => stage.status === 'operated')).toBe(true)
    expect(result.last.loads.reduce((sum, load) => sum + load.lfddShedMw, 0)).toBeCloseTo(totalShed, 6)
    const lastStage = nordic.lfdd.stages.at(-1)!.id
    const restored = restoreIslandLfddStage(result.state, lastStage)
    expect(Object.values(restored.reconnectedFractionByLoad).length).toBeGreaterThan(0)
    expect(() => restoreIslandLfddStage(restored.state, lastStage)).toThrow(/only an operated stage/)
    expect(() => rearmIslandLfddStage(result.state, lastStage)).toThrow(/only a restored stage/)
    const rearmed = rearmIslandLfddStage(restored.state, lastStage)
    expect(rearmed.lfdd.stages[lastStage]!.status).toBe('armed')
    console.info(`(e) stages at ${operations.map(operation => `${operation.atSeconds.toFixed(1)} s`).join(', ')}; shed ${[...shed].map(([id, mw]) => `${id} ${mw.toFixed(0)}`).join(', ')} MW; f(900 s) ${result.state.frequencyHz!.toFixed(3)} Hz`)
  })

  test('(f) storage changes operating state at most twice after a step event', () => {
    const battery: FrequencyStorageUnit = {
      id: 'battery', connected: true, maximumDischargeMw: 100, maximumChargeMw: 100, energyCapacityMwh: 200,
      chargeEfficiency: 0.95, dischargeEfficiency: 0.95, scheduledMw: 0,
    }
    const droop = gridAutomationSchema.parse({
      ...islanded,
      id: 'test.storage-droop',
      storage: { mode: 'droop', deadbandHz: 0.05, droopPercent: 1, timeConstantSeconds: 1, stateOfChargeLimits: { minimumFraction: 0.05, maximumFraction: 0.95 } },
    })
    for (const automation of [nordic, islanded, droop]) {
      const island = buildIsland({ automation, loadMw: 15_000, kineticEnergyMws: 60_000, lossMw: 267, storage: [battery] })
      const result = simulate(automation, island.state, island.after, 1_200, 2)
      const transitions = result.actions.filter(action => action.kind === 'storage-state-changed')
      expect(transitions.length).toBeGreaterThan(0)
      expect(transitions.length).toBeLessThanOrEqual(2)
      const charge = result.state.storage.battery!.stateOfChargeFraction
      expect(charge).toBeGreaterThan(0)
      console.info(`(f) ${automation.storage.mode}: ${transitions.length} transitions (${transitions.map(action => `${action.from}→${action.to} at ${action.atSeconds.toFixed(1)} s`).join(', ')}); SoC ${charge.toFixed(4)}`)
    }
  })

  test('storage honours its state-of-charge limit within the sub-step', () => {
    const battery: FrequencyStorageUnit = {
      id: 'battery', connected: true, maximumDischargeMw: 200, maximumChargeMw: 200, energyCapacityMwh: 2,
      chargeEfficiency: 0.95, dischargeEfficiency: 0.95, scheduledMw: 0,
    }
    const island = buildIsland({ automation: nordic, loadMw: 15_000, kineticEnergyMws: 60_000, lossMw: 600, storage: [battery], storageStateOfCharge: 0.2 })
    const result = simulate(nordic, island.state, island.after, 600, 1)
    if (nordic.storage.mode === 'off') throw new Error('Nordic preset must give storage a frequency response')
    const charge = result.state.storage.battery!.stateOfChargeFraction
    expect(charge).toBeGreaterThanOrEqual(nordic.storage.stateOfChargeLimits.minimumFraction - 1e-9)
    expect(charge).toBeLessThan(nordic.storage.stateOfChargeLimits.minimumFraction + 1e-3)
    expect(result.last.storage[0]!.limitedByStateOfCharge).toBe(true)
    expect(result.actions.filter(action => action.kind === 'storage-state-changed').length).toBeLessThanOrEqual(2)
  })
})

describe('generator frequency protection', () => {
  test('(g) an under-frequency element trips at 47.5 Hz only after its delay', () => {
    const element = nordic.generatorProtection.underFrequency.find(candidate => candidate.thresholdHz === 47.5)
    if (!element) throw new Error('Nordic preset must protect generators at 47.5 Hz')
    const h = nordic.simulation.subStepSeconds
    let state = createGeneratorProtectionState(nordic.generatorProtection)
    let previous = 47.8
    let crossedAt: number | null = null
    for (let index = 1; index <= 100 && !state.trip; index += 1) {
      const frequency = 47.8 - 0.05 * index * h
      if (crossedAt === null && frequency < 47.5) crossedAt = index * h - (47.5 - frequency) / 0.05
      state = evaluateGeneratorProtection(nordic.generatorProtection, state, {
        previousFrequencyHz: previous, frequencyHz: frequency, rocofHzPerSecond: -0.05, stepSeconds: h, nowSeconds: index * h,
      })
      previous = frequency
    }
    expect(state.trip?.elementId).toBe(element.id)
    expect(state.trip!.atSeconds - crossedAt!).toBeGreaterThanOrEqual(element.delaySeconds - 1e-9)
    expect(state.trip!.atSeconds - crossedAt!).toBeLessThan(element.delaySeconds + h)

    // A dip below 47.5 Hz shorter than the delay does not trip.
    let brief = createGeneratorProtectionState(nordic.generatorProtection)
    const dip = [47.6, 47.45, 47.45, 47.6]
    dip.forEach((frequency, index) => {
      brief = evaluateGeneratorProtection(nordic.generatorProtection, brief, {
        previousFrequencyHz: index === 0 ? 47.7 : dip[index - 1]!, frequencyHz: frequency, rocofHzPerSecond: 0, stepSeconds: h, nowSeconds: (index + 1) * h,
      })
    })
    if (element.delaySeconds > 2 * h) expect(brief.trip).toBeNull()
    console.info(`(g) crossing ${crossedAt!.toFixed(3)} s, trip ${state.trip!.atSeconds.toFixed(3)} s (delay ${element.delaySeconds} s)`)
  })

  test('(g) an island whose load cannot be shed collapses through generator under-frequency trips', () => {
    const loads: FrequencyLoad[] = [{ id: 'essential', priority: 'critical', demandMw: 2_000, protectedMw: 2_000 }]
    const island = buildIsland({ automation: nordic, loadMw: 2_000, kineticEnergyMws: 12_000, lossMw: 900, unitCount: 10, loads })
    const result = simulate(nordic, island.state, island.after, 120, 1)
    const operations = result.actions.filter((action): action is Extract<FrequencyAction, { kind: 'lfdd-stage-operated' }> => action.kind === 'lfdd-stage-operated')
    expect(operations.every(operation => operation.shedMw === 0 && operation.shortfallMw > 0)).toBe(true)
    const trips = result.actions.filter((action): action is Extract<FrequencyAction, { kind: 'generator-trip' }> => action.kind === 'generator-trip')
    expect(trips.length).toBe(10)
    expect(trips.every(trip => trip.cause === 'under-frequency')).toBe(true)
    expect(result.actions.some(action => action.kind === 'island-collapsed')).toBe(true)
    expect(result.state.frequencyHz).toBeNull()
    expect(() => advanceIslandFrequency(nordic, result.state, island.after, 1)).toThrow(/collapsed/)
    console.info(`(g) island collapse: first trip ${trips[0]!.atSeconds.toFixed(2)} s (${trips[0]!.elementId})`)
  })

  test('a protection trip must be applied before the next advance and is cleared only by reset', () => {
    // A synchronous neighbour keeps the island energised after its own units trip.
    const island = buildIsland({ automation: nordic, loadMw: 2_000, kineticEnergyMws: 12_000, lossMw: 900, unitCount: 10,
      loads: [{ id: 'essential', priority: 'critical', demandMw: 2_000, protectedMw: 2_000 }] })
    const neighbour = { id: 'neighbour', kineticEnergyMws: 20_000, scheduledImportMw: 0, loadMw: 0, reserves: { fcrNMw: 0, fcrDUpMw: 0, fcrDDownMw: 0, afrrUpMw: 0, afrrDownMw: 0 } }
    const before = { ...island.before, externals: [neighbour] }
    const after = { ...island.after, externals: [neighbour] }
    let state = createIslandFrequencyState(nordic, before, { frequencyHz: 50, startSeconds: 0, storageStateOfChargeFraction: {} })
    let advance: IslandFrequencyAdvance | null = null
    while (!advance?.actions.some(action => action.kind === 'generator-trip')) {
      advance = advanceIslandFrequency(nordic, state, after, 0.1)
      state = advance.state
    }
    expect(state.frequencyHz).not.toBeNull()
    const trip = advance.actions.find(action => action.kind === 'generator-trip')!
    if (trip.kind !== 'generator-trip') throw new Error('expected a trip')
    expect(advance.units.find(unit => unit.id === trip.unitId)!.outputMw).toBe(0)
    expect(() => advanceIslandFrequency(nordic, state, after, 0.1)).toThrow(/must be applied/)
    const reset = resetIslandGeneratorProtection(nordic, state, trip.unitId)
    expect(reset.units[trip.unitId]!.protection.trip).toBeNull()
    expect(() => resetIslandGeneratorProtection(nordic, reset, trip.unitId)).toThrow(/no protection trip/)
  })
})

describe('frequency advance boundaries', () => {
  test('an adapter step beyond the maximum catch-up fails instead of stretching the sub-step', () => {
    const island = buildIsland({ automation: nordic, loadMw: 15_000, kineticEnergyMws: 60_000, lossMw: 267 })
    expect(() => advanceIslandFrequency(nordic, island.state, island.after, nordic.simulation.maximumCatchUpSeconds + 1)).toThrow(/maximum catch-up/)
    expect(() => advanceIslandFrequency(nordic, island.state, island.after, -1)).toThrow(/non-negative/)
    const unchanged = advanceIslandFrequency(nordic, island.state, island.after, 0)
    expect(unchanged.state.frequencyHz).toBe(50)
  })

  test('reserve allocation scales FCR to the units in the island and reports deficits', () => {
    const units = Array.from({ length: 4 }, (_, index) => ({
      id: `unit-${index}`, connection: 'synchronous' as const, governorClass: 'hydro' as const, synchronised: index < 3,
      ratedMva: 300, inertiaConstantSeconds: 3, minimumMw: 0, maximumMw: 250, targetMw: 200, rampRateMwPerSecond: 5,
    }))
    const result = allocateFrequencyReserves({ automation: islanded, units, islandLoadMw: 600 })
    const unitCount = [...result.allocations.values()].filter(allocation => allocation.fcrNMw > 0).length
    expect(unitCount).toBe(3)
    const headroomMw = 3 * 50
    const allocatedUp = result.products.filter(product => product.product.endsWith('Up') || product.product === 'fcrN')
      .reduce((sum, product) => sum + product.allocatedMw, 0)
    expect(allocatedUp).toBeLessThanOrEqual(headroomMw + 1e-9)
    expect(result.products.some(product => product.deficitMw > 0)).toBe(true)
  })
})
