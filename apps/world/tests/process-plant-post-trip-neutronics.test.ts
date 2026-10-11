import { describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/index.ts'
import {
  compileProcessPlant,
  createProcessPlantProtectionRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
  type VariablePath,
} from '../src/packs/process-plant/index.ts'
import { reactorNeutronics } from '../src/packs/process-plant/graph/reactor-component-definitions.ts'
import { reactorKineticsPowerStep } from '../src/packs/process-plant/runtime/physics.ts'

// The four-loop reference PWR tripped from steady full power, against what a
// Westinghouse-type four-loop plant does: the power drops promptly as the rods
// fall, then falls on the longest-lived delayed-neutron group's period, about
// -80 s (-1/3 decade a minute); decay heat follows the ANS-5.1 curve.

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:post-trip-neutronics', loopCount: 4 }))
const core = plant.graph.components[plant.graph.componentIndexById.get('core' as never)!]!
const ratedPowerMw = 3_400

/** The Wigner–Way fit to the ANS-5.1 decay-heat curve for a core a year at power, as a share of its power. */
const yearAtPower = 365.25 * 86_400
const ansDecayHeatFraction = (seconds: number): number => 0.0622 * (seconds ** -0.2 - (seconds + yearAtPower) ** -0.2)

const started = () => {
  const runtime = createProcessPlantRuntime({ system: plant })
  const protection = createProcessPlantProtectionRunner({ system: plant, protection: plant.automation })
  const read = (path: string): number => Number(runtime.readVariable(path as VariablePath))
  const run = (seconds: number, each?: (second: number) => void): void => {
    for (let second = 1; second <= seconds; second++) {
      runtime.tick(1_000)
      protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-post-trip-neutronics' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
      each?.(second)
    }
  }
  return { runtime, read, run }
}

// One trip from full power, held for 20 minutes and sampled each second; the tests below read it.
let tripTrajectory: { readonly before: { readonly powerMw: number }; readonly samples: ReadonlyArray<Readonly<Record<string, number | boolean>>> } | null = null
const tripped = () => {
  if (tripTrajectory !== null) return tripTrajectory
  const plantRun = started()
  plantRun.run(60)
  const before = { powerMw: plantRun.read('core.powerMw') }
  // A manual trip: both trip breakers open and the rod control drives in, as every protection trip does.
  plantRun.runtime.writeCommand({ type: 'setVariable', path: 'reactorTripBreakerA.closed' as VariablePath, value: false })
  plantRun.runtime.writeCommand({ type: 'setVariable', path: 'reactorTripBreakerB.closed' as VariablePath, value: false })
  plantRun.runtime.writeCommand({ type: 'setVariable', path: 'core.rodInsertionFraction' as VariablePath, value: 1 })
  const samples: Array<Record<string, number | boolean>> = []
  plantRun.run(1_200, second => samples.push({
    second,
    powerMw: plantRun.read('core.powerMw'),
    decayHeatMw: plantRun.read('core.decayHeatMw'),
    reactivityPcm: plantRun.read('core.reactivityPcm'),
  }))
  tripTrajectory = { before, samples }
  return tripTrajectory
}
const at = (second: number) => tripped().samples[second - 1]!

describe('at steady full power', () => {
  test('the neutronics add nothing: power, heat balance and the delta-T channels hold their operating point', () => {
    const plantRun = started()
    plantRun.run(60)
    const { read } = plantRun
    expect(read('core.powerMw')).toBeCloseTo(ratedPowerMw, 1)
    expect(read('core.totalThermalPowerMw')).toBeCloseTo(read('core.powerMw'), 1)
    // Decay heat holds its 6 % share of fission power; each precursor group sustains the power it has.
    expect(read('core.decayHeatMw') / read('core.powerMw')).toBeCloseTo(0.06, 5)
    for (let group = 1; group <= 6; group++) expect(read(`core.delayedNeutronGroup${group}PowerMw`)).toBeCloseTo(read('core.powerMw'), 1)
    // The delta-T channels read what they read before the neutronics changed (OTΔT and OPΔT inputs and setpoints).
    expect(read('vessel.meanPrimaryCoolantTemperatureC')).toBeCloseTo(305.68, 2)
    expect(read('deltaTChannelA.deltaTC')).toBeCloseTo(35.55, 2)
    expect(read('deltaTChannelA.overtemperatureSetpointC')).toBeCloseTo(41.84, 2)
    expect(read('deltaTChannelA.overpowerSetpointC')).toBeCloseTo(38.88, 2)
  })
})

describe('a reactor trip from full power', () => {
  test('drops power promptly as the rods fall, then settles on a -1/3 decade a minute period', () => {
    const { before } = tripped()
    // The rods insert their 4,000 pcm scram worth in their 2.7 s drop time.
    expect(at(3).reactivityPcm as number).toBeCloseTo(-4_000, 0)
    // The prompt drop: within seconds the power falls to the share the delayed neutrons sustain, beta / (beta - rho).
    expect(at(5).powerMw as number).toBeLessThan(before.powerMw * 0.1)
    expect(at(5).powerMw as number).toBeGreaterThan(before.powerMw * 0.03)
    // 93 s after the trip: some 0.2 to 0.5 % power.
    expect(at(93).powerMw as number / ratedPowerMw).toBeGreaterThan(0.002)
    expect(at(93).powerMw as number / ratedPowerMw).toBeLessThan(0.005)
    // From five minutes on, the longest-lived group sets the period: about -80 s, -1/3 decade a minute.
    const periodS = (600 - 300) / Math.log((at(600).powerMw as number) / (at(300).powerMw as number))
    expect(periodS).toBeLessThan(-75)
    expect(periodS).toBeGreaterThan(-90)
  }, 120_000) // The trip is held for 20 minutes, the same watchdog as the runtime's long trajectories.

  test('leaves decay heat on the ANS-5.1 curve', () => {
    // The fission power still falling in the first seconds adds its own share, a few percent at most.
    for (const second of [10, 30, 93, 300, 600, 1_200]) {
      const fraction = (at(second).decayHeatMw as number) / ratedPowerMw
      expect(fraction / ansDecayHeatFraction(second)).toBeGreaterThan(0.97)
      expect(fraction / ansDecayHeatFraction(second)).toBeLessThan(1.05)
    }
  }, 120_000)
})

describe('the declared decay heat groups', () => {
  test('follow the ANS-5.1 curve from 10 s to two days, from 6 % at shutdown', () => {
    const groups = reactorNeutronics(core).decayHeatGroups
    const decayHeat = (seconds: number): number => groups.reduce((sum, group) => sum + group.fractionOfFissionPower * Math.exp(-seconds / group.timeConstantS), 0)
    expect(decayHeat(0)).toBeCloseTo(0.06, 6)
    for (let exponent = 1; exponent <= Math.log10(2 * 86_400); exponent += 0.05) {
      const seconds = 10 ** exponent
      expect(Math.abs(decayHeat(seconds) / ansDecayHeatFraction(seconds) - 1)).toBeLessThan(0.03)
    }
    // The senior reactor operator's reference points: about 4 % at 10 s, 2.3 % at 100 s, 1.5 % at 10 min, 1 % at an hour.
    expect(decayHeat(10)).toBeCloseTo(0.037, 2)
    expect(decayHeat(100)).toBeCloseTo(0.023, 3)
    expect(decayHeat(600)).toBeCloseTo(0.015, 3)
    expect(decayHeat(3_600)).toBeCloseTo(0.010, 3)
  })
})

describe('the shut-down kinetics step', () => {
  test('is stable and consistent at any step length', () => {
    const { delayedNeutrons } = reactorNeutronics(core)
    const settle = (dtSeconds: number): number => {
      let powerMw = ratedPowerMw
      let precursorPowerMw: ReadonlyArray<number> = delayedNeutrons.groups.map(() => ratedPowerMw)
      for (let elapsed = 0; elapsed < 600 - 1e-9; elapsed += dtSeconds) {
        const step = reactorKineticsPowerStep({
          currentPowerMw: powerMw, ratedPowerMw, nominalCriticalPowerMw: ratedPowerMw, effectiveReactivityPcm: -4_000, dtSeconds,
          pcmPerEfoldPerSecond: 2_400, maxPowerRampFractionPerS: 0.18, maxPowerFraction: 1.2,
          delayedNeutronFraction: delayedNeutrons.fraction, delayedNeutronGroups: delayedNeutrons.groups, precursorPowerMw,
        })
        expect(step.powerMw).toBeGreaterThan(0)
        expect(step.powerMw).toBeLessThanOrEqual(powerMw)
        powerMw = step.powerMw
        precursorPowerMw = step.precursorPowerMw
      }
      return powerMw
    }
    // The World's 100 ms step against a hundredfold finer and a hundredfold coarser one.
    const reference = settle(0.001)
    expect(settle(0.1) / reference).toBeCloseTo(1, 1)
    expect(settle(10) / reference).toBeGreaterThan(0.5)
    expect(settle(10) / reference).toBeLessThan(2)
  })
})
