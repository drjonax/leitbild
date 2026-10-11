import { describe, expect, test } from 'bun:test'
import { norwayRuntimeTestOperatingPointRef } from './fixtures/grid-operating-point.ts'
import { gridCloseBranchCommandKind, gridDerateBranchCommandKind, gridOpenBranchCommandKind } from '../src/packs/electric-grid/commands/branch.ts'
import { gridResetGeneratorTripCommandKind, gridTripGeneratorCommandKind } from '../src/packs/electric-grid/commands/generator.ts'
import { gridResetBranchProtectionCommandKind } from '../src/packs/electric-grid/commands/protection.ts'
import { gridDefinitionSchema } from '../src/packs/electric-grid/config.ts'
import { norwayGridModelRef, nordicFrequencyAutomationRef } from '../src/packs/electric-grid/definition-refs.ts'
import { compileGridDefinition } from '../src/packs/electric-grid/definitions.ts'
import type { CompiledGridDefinition } from '../src/packs/electric-grid/grid-model.ts'
import { gridAlarmId } from '../src/packs/electric-grid/runtime/alarms.ts'
import { compiledGridNetworkFor } from '../src/packs/electric-grid/runtime/network/compiled-network.ts'
import { findGridIslands } from '../src/packs/electric-grid/runtime/network/islands.ts'
import { branchThermalTripLevel, type EnabledBranchProtection } from '../src/packs/electric-grid/runtime/protection/relays.ts'
import { gridAutomationSchema } from '../src/packs/electric-grid/schemas/grid-automation.ts'
import { parseElectricGridRuntimeState, restoredGridRuntimeStateFor, runtimeStateForElectricGrids } from '../src/packs/electric-grid/sim/runtime-state.ts'
import { createGridRuntimeInstance } from '../src/packs/electric-grid/runtime/instance.ts'
import { advanceGrid } from '../src/packs/electric-grid/runtime/solver.ts'
import { corridorDefinition, isoAt, steppedGrid, tripSignals } from './fixtures/grid-corridor.ts'

const norway = compileGridDefinition(gridDefinitionSchema.parse({
  id: 'grid:norway',
  model: { ref: norwayGridModelRef },
  operatingPoint: { ref: norwayRuntimeTestOperatingPointRef },
  automation: { ref: nordicFrequencyAutomationRef },
}))

const protectionOf = (definition: CompiledGridDefinition): EnabledBranchProtection => {
  const settings = definition.automation.branchProtection
  if (!settings.enabled) throw new Error('the preset must enable branch protection')
  return settings
}

/** The most loaded overhead line below 60 % of its rating (its conductor is cool) whose outage keeps its island connected. */
const meshedBranchUnderLoad = (run: ReturnType<typeof steppedGrid>): string => {
  const { model } = run.grid.definition
  const network = compiledGridNetworkFor(model)
  const closed = Uint8Array.from(model.branches, branch => run.grid.branches.get(branch.id)!.state === 'closed' ? 1 : 0)
  const baseCount = findGridIslands(network, closed).count
  const loading = (id: string, ratingMw: number): number => Math.abs(run.grid.branches.get(id)!.flowMw) / ratingMw
  return [...model.branches]
    .filter(branch => branch.kind === 'ac_line' && loading(branch.id, branch.ratingMw) < 0.6)
    .sort((a, b) => loading(b.id, b.ratingMw) - loading(a.id, a.ratingMw))
    .find(branch => {
      const without = closed.slice()
      without[model.branches.indexOf(branch)] = 0
      return findGridIslands(network, without).count === baseCount
    })!.id
}

describe('electric grid branch protection', () => {
  test('a derated branch above its emergency rating trips after its emergency duration and not before', () => {
    const run = steppedGrid(norway)
    run.advanceTo(60_000)
    const branchId = meshedBranchUnderLoad(run)
    const branch = norway.model.branches.find(candidate => candidate.id === branchId)!
    // 125 % of the derated rating: above the 118 % emergency rating, below the 150 % instantaneous pickup.
    // Relays act on the AC apparent power, so the derate is set on it, not on the active flow.
    const before = run.grid.branches.get(branchId)!
    expect(before.flowModel).toBe('ac')
    const availability = before.apparentPowerMva! / (1.25 * branch.ratingMw)
    expect(run.command(gridDerateBranchCommandKind, { assetId: branchId, availability }).ok).toBe(true)
    const settings = protectionOf(norway)
    // From the pre-derate thermal state the thermal element would need longer than the emergency duration.
    const steady = 1.25 ** 2
    const thermalSeconds = settings.thermalTimeConstantSeconds.ac_line
      * Math.log((steady - run.grid.branches.get(branchId)!.protection.thermalLevel) / (steady - branchThermalTripLevel(branch, settings)))
    expect(thermalSeconds).toBeGreaterThan(branch.emergencyDurationSeconds + 30)
    // The first relay sample after the derate (61 s) picks up; the element operates 900 s later.
    run.advanceTo(960_000)
    expect(run.grid.branches.get(branchId)!.state).toBe('closed')
    expect(run.grid.branches.get(branchId)!.protection.overEmergencySinceElapsedMs).toBe(61_000)
    expect(run.grid.alarms.records.get(gridAlarmId('branch', branchId, 'loading-above-emergency'))).toMatchObject({ active: true, priority: 1 })
    run.advanceTo(962_000)
    const state = run.grid.branches.get(branchId)!
    expect(state.state).toBe('tripped')
    expect(state.protection.trip).toMatchObject({ element: 'emergency-duration', atElapsedMs: 961_000 })
    expect(tripSignals(run.signals).filter(trip => trip.assetId === branchId)).toEqual([{ assetId: branchId, element: 'emergency-duration', elapsedSeconds: 961 }])
    expect(run.grid.alarms.records.get(gridAlarmId('branch', branchId, 'tripped'))).toMatchObject({ active: true, priority: 1, raisedAtElapsedMs: 961_000 })

    // Tripped is not open: closing needs the protection reset first, and the reset leaves the breaker open.
    expect(run.command(gridCloseBranchCommandKind, { assetId: branchId }).reason).toContain('reset it with reset-branch-protection')
    expect(run.command(gridOpenBranchCommandKind, { assetId: branchId }).reason).toContain('its protection tripped it')
    expect(run.command(gridResetBranchProtectionCommandKind, { assetId: branchId }).ok).toBe(true)
    expect(run.grid.branches.get(branchId)!).toMatchObject({ state: 'open', protection: { trip: null } })
    expect(run.command(gridResetBranchProtectionCommandKind, { assetId: branchId }).reason).toContain('not tripped')
  }, 60_000)

  test('the instantaneous element trips at the first relay sample above its pickup', () => {
    const run = steppedGrid(norway)
    run.advanceTo(30_000)
    const branchId = meshedBranchUnderLoad(run)
    const branch = norway.model.branches.find(candidate => candidate.id === branchId)!
    const availability = Math.abs(run.grid.branches.get(branchId)!.flowMw) / (1.7 * branch.ratingMw)
    expect(run.command(gridDerateBranchCommandKind, { assetId: branchId, availability }).ok).toBe(true)
    expect(run.grid.branches.get(branchId)!.state).toBe('closed')
    run.advanceTo(32_000)
    expect(run.grid.branches.get(branchId)!.protection.trip).toMatchObject({ element: 'instantaneous', atElapsedMs: 31_000 })
  })

  test('a seeded corridor cascade repeats exactly across adapter steps of 1 s, 2 s, real-time jitter and 60 s fast-forward', () => {
    const cascade = (steps: ReadonlyArray<number>) => {
      const run = steppedGrid(corridorDefinition())
      run.advanceTo(10_000, [1_000])
      expect(run.command(gridOpenBranchCommandKind, { assetId: 'branch:g-l' }).ok).toBe(true)
      run.advanceTo(1_200_000, steps)
      return { trips: tripSignals(run.signals), frequencyHz: run.grid.projection.frequencyHz, thermal: [...run.grid.branches.values()].map(state => state.protection.thermalLevel) }
    }
    const reference = cascade([1_000])
    console.info(`corridor cascade: ${reference.trips.map(trip => `${trip.assetId} ${trip.element} @${trip.elapsedSeconds} s`).join(', ')}`)
    // Opening the direct line loads the A path at 129 % of its rating: its thermal element operates,
    // the B path then carries everything and trips instantaneously, and the separated islands' units
    // trip on RoCoF.
    expect(reference.trips.map(trip => [trip.assetId, trip.element])).toEqual([
      ['branch:g-a', 'thermal'], ['branch:g-b', 'instantaneous'], ['branch:b-l', 'instantaneous'], ['generator:g1', 'rocof'], ['generator:l1', 'rocof'],
    ])
    const thermalTrip = reference.trips[0]!.elapsedSeconds
    expect(thermalTrip).toBeGreaterThan(10 + 300)
    expect(thermalTrip).toBeLessThan(10 + corridorDefinition().model.branches.find(branch => branch.id === 'branch:g-a')!.emergencyDurationSeconds)
    const twoSecond = cascade([2_000])
    expect(twoSecond).toEqual(reference)
    expect(cascade([60_000])).toEqual(reference)
    // Branch relays sample on the fixed grid, so their trips repeat exactly under jitter. A unit's
    // frequency protection is observed at the next network solution, which a jittered tick end can
    // bring before the next relay sample: same units and elements, up to one sub-step earlier.
    const jittered = cascade([1_700, 2_300, 1_950, 2_051, 2_000, 1_999]).trips
    const branchTrips = (trips: typeof reference.trips) => trips.filter(trip => trip.assetId.startsWith('branch:'))
    expect(branchTrips(jittered)).toEqual(branchTrips(reference.trips))
    const unitTrips = (trips: typeof reference.trips) => trips.filter(trip => !trip.assetId.startsWith('branch:'))
    expect(unitTrips(jittered).map(trip => [trip.assetId, trip.element])).toEqual(unitTrips(reference.trips).map(trip => [trip.assetId, trip.element]))
    unitTrips(jittered).forEach((trip, index) => expect(Math.abs(trip.elapsedSeconds - unitTrips(reference.trips)[index]!.elapsedSeconds)).toBeLessThanOrEqual(corridorDefinition().automation.simulation.subStepSeconds + 1e-9))
  }, 120_000)

  test('an explicit preset field disables branch protection; the loading alarms still report', () => {
    const base = corridorDefinition()
    const definition: CompiledGridDefinition = { ...base, automation: gridAutomationSchema.parse({ ...base.automation, branchProtection: { enabled: false } }) }
    const run = steppedGrid(definition)
    run.advanceTo(10_000)
    expect(run.command(gridOpenBranchCommandKind, { assetId: 'branch:g-l' }).ok).toBe(true)
    run.advanceTo(1_200_000)
    expect(tripSignals(run.signals).filter(trip => trip.assetId.startsWith('branch:'))).toEqual([])
    expect(run.grid.branches.get('branch:g-a')!.state).toBe('closed')
    expect(run.grid.alarms.records.get(gridAlarmId('branch', 'branch:g-a', 'loading-above-emergency'))?.active).toBe(true)
  }, 60_000)

  test('a generator trip by command or by its frequency protection is a recorded event and an alarm', () => {
    const run = steppedGrid(corridorDefinition())
    run.advanceTo(10_000)
    expect(run.command(gridTripGeneratorCommandKind, { assetId: 'generator:l1' }).ok).toBe(true)
    expect(tripSignals(run.signals)).toEqual([{ assetId: 'generator:l1', element: 'command', elapsedSeconds: 10 }])
    const alarmId = gridAlarmId('generator', 'generator:l1', 'tripped')
    expect(run.grid.alarms.records.get(alarmId)).toMatchObject({ active: true, priority: 2 })
    expect(run.grid.alarms.records.get(alarmId)!.message).toContain('by command')
    run.advanceTo(30_000)
    expect(run.command(gridResetGeneratorTripCommandKind, { assetId: 'generator:l1' }).ok).toBe(true)
    run.advanceTo(32_000)
    expect(run.grid.alarms.records.get(alarmId)?.active).toBe(false)

    const cascade = steppedGrid(corridorDefinition())
    cascade.advanceTo(10_000)
    cascade.command(gridOpenBranchCommandKind, { assetId: 'branch:g-l' })
    cascade.advanceTo(900_000)
    const unitTrips = tripSignals(cascade.signals).filter(trip => trip.assetId.startsWith('generator:'))
    expect(unitTrips.map(trip => trip.element)).toEqual(['rocof', 'rocof'])
    expect(cascade.grid.alarms.records.get(gridAlarmId('generator', 'generator:g1', 'tripped'))!.message).toContain('rocof protection')
  }, 60_000)

  test('relay state persists: a restored Grid continues the thermal states and trips', () => {
    const run = steppedGrid(corridorDefinition())
    run.advanceTo(10_000)
    run.command(gridOpenBranchCommandKind, { assetId: 'branch:g-l' })
    run.advanceTo(300_000)
    const stored = parseElectricGridRuntimeState(JSON.parse(JSON.stringify(runtimeStateForElectricGrids(new Map([[run.grid.definition.gridId, run.grid]])))))
    const restored = createGridRuntimeInstance({
      definition: run.grid.definition,
      at: isoAt(300_000),
      restored: restoredGridRuntimeStateFor(stored, run.grid.definition.gridId, run.grid.definition.definitionDigest)!,
    })
    advanceGrid(restored, 0, isoAt(300_000))
    expect([...restored.branches.values()].map(state => state.protection)).toEqual([...run.grid.branches.values()].map(state => state.protection))
    for (let ms = 302_000; ms <= 900_000; ms += 2_000) advanceGrid(restored, 2, isoAt(ms))
    run.advanceTo(900_000)
    expect([...restored.branches.values()].map(state => [state.state, state.protection.trip?.atElapsedMs ?? null]))
      .toEqual([...run.grid.branches.values()].map(state => [state.state, state.protection.trip?.atElapsedMs ?? null]))
  }, 60_000)
})
