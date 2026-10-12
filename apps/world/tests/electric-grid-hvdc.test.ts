import { describe, expect, test } from 'bun:test'
import { gridCloseBranchCommandKind, gridOpenBranchCommandKind } from '../src/packs/electric-grid/commands/branch.ts'
import {
  gridBlockHvdcCommandKind,
  gridDeblockHvdcCommandKind,
  gridResetHvdcTripCommandKind,
  gridSetHvdcSetpointCommandKind,
  gridTripHvdcCommandKind,
} from '../src/packs/electric-grid/commands/hvdc.ts'
import { gridDefinitionSchema } from '../src/packs/electric-grid/config.ts'
import { gridSetExternalExchangeCommandKind } from '../src/packs/electric-grid/commands/external.ts'
import { nordicFrequencyAutomationRef, norwayGridModelRef } from '../src/packs/electric-grid/definition-refs.ts'
import { compileGridDefinition } from '../src/packs/electric-grid/definitions.ts'
import type { CompiledGridDefinition, GridBusDefinition, GridModelDefinition } from '../src/packs/electric-grid/grid-model.ts'
import { answerElectricGridQuery, electricGridQueryCapabilities } from '../src/packs/electric-grid/queries/index.ts'
import { gridAlarmId } from '../src/packs/electric-grid/runtime/alarms.ts'
import { createGridRuntimeInstance, type GridRuntimeInstance } from '../src/packs/electric-grid/runtime/instance.ts'
import { islandKineticEnergyMws } from '../src/packs/electric-grid/runtime/island-input.ts'
import { gridIslandAtBus, solvedGridIslands } from '../src/packs/electric-grid/runtime/island-lifecycle.ts'
import { hvdcLinksRamping } from '../src/packs/electric-grid/runtime/hvdc.ts'
import { createGridRecordingPlan } from '../src/packs/electric-grid/recording.ts'
import { gridMapIslandState } from '../src/packs/electric-grid/queries/map-state.ts'
import { electricGridRuntimeStateSchema, restoredGridRuntimeStateFor, runtimeStateForElectricGrids } from '../src/packs/electric-grid/sim/runtime-state.ts'
import { isoAt, steppedGrid, tripSignals, type SteppedGrid } from './fixtures/grid-corridor.ts'
import { norwayRuntimeTestOperatingPointRef } from './fixtures/grid-operating-point.ts'
import { gridDefinitionForModel, handBuiltModel, syntheticHydroUnit, testLine, testLoad } from './fixtures/synthetic-grid.ts'
import { largestIslandInjectionSumMw, largestKclResidualMw } from './fixtures/grid-invariants.ts'

// A Norwegian 420 kV bus tied to the Nordic equivalent at SE3 with four hydro units, a radial
// converter bus west of it, and two links to Germany: one with NordLink's rating, losses and ramp
// as the Norway Model carries them, one with a slower ramp.
const provenance = { sources: ['test:hand-built'], method: 'curated' as const, confidence: 'high' as const, note: 'HVDC command test model.' }
const bus = (id: string, longitude: number, kind: GridBusDefinition['kind'] = 'substation'): GridBusDefinition => ({ id, label: id, kind, nominalKv: 420, location: [longitude, 59] })
const line = (id: string, fromBusId: string, toBusId: string, ratingMw: number) =>
  testLine({ id, fromBusId, toBusId, nominalKv: 420, ratingMw, reactancePu: 0.01, resistancePu: 0.001 })
const nordlinkId = 'hvdc:test-nordlink'
const westLinkId = 'hvdc:test-west'

const model: GridModelDefinition = handBuiltModel({
  id: 'hvdc-commands',
  title: 'HVDC commands',
  description: 'A Norwegian bus tied to the Nordic equivalent, a radial converter bus and two links to Germany.',
  buses: [bus('bus:south', 7), bus('bus:west', 6), bus('bus:boundary-SE3@420', 11, 'boundary'), bus('bus:boundary-DE', 9, 'boundary')],
  branches: [line('tie-se3', 'bus:south', 'bus:boundary-SE3@420', 3_000), line('west-line', 'bus:south', 'bus:west', 1_500)],
  generators: Array.from({ length: 4 }, (_, index) => syntheticHydroUnit({ id: `south-${index}`, label: `South ${index}`, busId: 'bus:south', location: [7, 59], capacityMw: 400 })),
  loads: [testLoad({ id: 'south-load', busId: 'bus:south', demandMw: 1_000 }), testLoad({ id: 'west-load', busId: 'bus:west', demandMw: 100 })],
  externalSystems: [
    {
      id: 'external:nordic-remainder', label: 'Nordic remainder', area: 'nordic-remainder', synchronous: true, boundaryBusIds: ['bus:boundary-SE3@420'],
      inertiaGws: 171, loadMw: 43_100, fcrNMwPerHz: 3_720, fcrDUpMw: 899, fcrDDownMw: 868, afrrUpMw: 138, afrrDownMw: 138,
      areaParticipation: [{ area: 'SE3', share: 1, boundaryBusIds: ['bus:boundary-SE3@420'] }], provenance,
    },
    { id: 'external:DE', label: 'Germany', area: 'DE', synchronous: false, boundaryBusIds: ['bus:boundary-DE'], provenance },
  ],
  hvdcLinks: [
    { id: nordlinkId, label: 'Test NordLink', fromBusId: 'bus:south', toBusId: 'bus:boundary-DE', ratingMw: 1_400, lossPercent: 3.1, rampMwPerMinute: 60, osmWayIds: [], provenance },
    { id: westLinkId, label: 'Test west link', fromBusId: 'bus:west', toBusId: 'bus:boundary-DE', ratingMw: 700, lossPercent: 2, rampMwPerMinute: 26, osmWayIds: [], provenance },
  ],
})

/** A Model with each link starting at the given transfer (MW, positive exports); others at 0. */
const definitionFor = (base: GridModelDefinition, transfersMw: Readonly<Record<string, number>> = {}): CompiledGridDefinition => {
  const definition = gridDefinitionForModel(base)
  return { ...definition, operatingPoint: { ...definition.operatingPoint, hvdcSetpoints: base.hvdcLinks.map(link => ({ linkId: link.id, setpointMw: transfersMw[link.id] ?? 0 })) } }
}
/** The test Model with each link starting at the given transfer; see definitionFor. */
const definitionWith = (transfersMw: Readonly<Record<string, number>> = {}): CompiledGridDefinition => definitionFor(model, transfersMw)

// Both links to Germany share one border's ramp: 50 MW/min together, below the test NordLink's own 60.
const groupRampMwPerMinute = 50
const groupedModel: GridModelDefinition = {
  ...model,
  id: 'hvdc-ramp-group',
  hvdcRampGroups: [{ id: 'ramp:test-de', linkIds: [nordlinkId, westLinkId], rampMwPerMinute: groupRampMwPerMinute, provenance }],
}

const linkOf = (run: SteppedGrid, linkId = nordlinkId) => run.grid.hvdcLinks.get(linkId)!
const reasonOf = (result: { readonly ok: boolean; readonly reason?: string }): string => {
  if (result.ok) throw new Error('expected the command to be rejected')
  return result.reason!
}
const hvdcTransitions = (run: SteppedGrid) => run.signals.filter(signal => signal.type.startsWith('electric-grid.hvdc.')).map(signal => signal.type)

const queryCapability = (id: string) => electricGridQueryCapabilities.find(capability => capability.id === id)!
/** Answers a query the way the Host does: the Pack answer, then the published output schema. */
const query = (grid: GridRuntimeInstance, capabilityId: string, input: Readonly<Record<string, unknown>> = {}) =>
  queryCapability(capabilityId).output.parse(answerElectricGridQuery({
    request: { capabilityId, input: { gridId: grid.definition.gridId, ...input } },
    grids: new Map([[grid.definition.gridId, grid]]),
  })) as Record<string, any>

describe('HVDC set-point', () => {
  test('ramps the transfer at the link\'s rate to the set-point; an import arrives less the converter losses', () => {
    const run = steppedGrid(definitionWith())
    expect(run.command(gridSetHvdcSetpointCommandKind, { assetId: nordlinkId, setpointMw: -600 }).ok).toBe(true)
    expect(linkOf(run)).toMatchObject({ state: 'deblocked', setpointMw: -600, transferMw: 0 })
    // 60 MW/min: 600 MW take 600 s.
    run.advanceTo(300_000, [1_000])
    expect(linkOf(run).transferMw).toBeCloseTo(-300, 9)
    run.advanceTo(599_000, [1_000])
    expect(linkOf(run).transferMw).toBeCloseTo(-599, 9)
    run.advanceTo(600_000, [1_000])
    expect(linkOf(run).transferMw).toBe(-600)
    expect(linkOf(run).lossesMw).toBeCloseTo(18.6, 9)
    const island = (query(run.grid, 'world.electric-grid.islands.list').islands as ReadonlyArray<{ id: string; hvdcImportMw: number }>)
      .find(candidate => candidate.id === run.grid.busStates.get('bus:south')!.islandId)!
    expect(island.hvdcImportMw).toBeCloseTo(600 * (1 - 0.031), 9)
    expect(largestIslandInjectionSumMw(run.grid)).toBeLessThan(1e-6)
  })

  test('follows the same ramp whatever the advance step', () => {
    // 26 MW/min: a 100 MW import completes after 230.8 s, inside an advance for every step.
    const sampleTimesMs = [35_000, 70_000, 105_000, 140_000, 175_000, 210_000, 245_000]
    const trajectory = (stepMs: number): ReadonlyArray<number> => {
      const run = steppedGrid(definitionWith())
      expect(run.command(gridSetHvdcSetpointCommandKind, { assetId: westLinkId, setpointMw: -100 }).ok).toBe(true)
      return sampleTimesMs.map(timeMs => {
        run.advanceTo(timeMs, [stepMs])
        return linkOf(run, westLinkId).transferMw
      })
    }
    const expected = sampleTimesMs.map(timeMs => Math.max(-100, -26 / 60 * timeMs / 1_000))
    for (const stepMs of [250, 1_000, 2_500, 7_000]) {
      const transfers = trajectory(stepMs)
      transfers.forEach((transferMw, index) => expect(transferMw).toBeCloseTo(expected[index]!, 9))
      console.info(`HVDC ramp, step ${stepMs / 1_000} s: ${transfers.map(value => value.toFixed(6)).join(', ')} MW`)
    }
  })

  test('rejects set-points beyond the rating, an unchanged set-point and unknown links, changing nothing', () => {
    const run = steppedGrid(definitionWith())
    const setpoint = (assetId: string, setpointMw: number) => run.command(gridSetHvdcSetpointCommandKind, { assetId, setpointMw })
    expect(reasonOf(setpoint(nordlinkId, 1_400.1))).toBe('HVDC link hvdc:test-nordlink set-point 1400.1 MW lies outside its ±1400 MW rating (positive exports from bus:south)')
    expect(reasonOf(setpoint(nordlinkId, -1_401))).toContain('outside its ±1400 MW rating')
    expect(linkOf(run).setpointMw).toBe(0)
    expect(setpoint(nordlinkId, -1_400).ok).toBe(true)
    expect(reasonOf(setpoint(nordlinkId, -1_400))).toBe('HVDC link hvdc:test-nordlink already has the set-point -1400 MW (transfer 0 MW)')
    expect(reasonOf(setpoint('hvdc:missing', 100))).toContain('HVDC link not found: hvdc:missing')
    expect(reasonOf(setpoint('south-0', 100))).toContain('HVDC link not found: south-0')
    expect(linkOf(run).setpointMw).toBe(-1_400)
  })
})

describe('HVDC ramp groups', () => {
  /** Steps a run 1 s at a time to `untilMs`, failing a step whose net change of the group's aggregate transfer exceeds its limit. */
  const advanceHeldToGroup = (run: SteppedGrid, untilMs: number): void => {
    while (run.nowMs() < untilMs) {
      const before = [nordlinkId, westLinkId].map(linkId => linkOf(run, linkId).transferMw)
      run.advanceTo(run.nowMs() + 1_000, [1_000])
      const netMw = [nordlinkId, westLinkId].reduce((sum, linkId, index) => sum + linkOf(run, linkId).transferMw - before[index]!, 0)
      expect(Math.abs(netMw)).toBeLessThanOrEqual(groupRampMwPerMinute / 60 + 1e-9)
    }
  }

  test('holds two links ramping the same way to the group\'s net limit, both moves scaled back by one factor', () => {
    const run = steppedGrid(definitionFor(groupedModel))
    expect(run.command(gridSetHvdcSetpointCommandKind, { assetId: nordlinkId, setpointMw: -600 }).ok).toBe(true)
    expect(run.command(gridSetHvdcSetpointCommandKind, { assetId: westLinkId, setpointMw: -300 }).ok).toBe(true)
    // Own ramps 60 and 26 MW/min, 86 together: both scale by 50/86 to 34.9 and 15.1 MW/min.
    advanceHeldToGroup(run, 60_000)
    expect(linkOf(run).transferMw).toBeCloseTo(-60 * 50 / 86, 9)
    expect(linkOf(run, westLinkId).transferMw).toBeCloseTo(-26 * 50 / 86, 9)
    expect(hvdcLinksRamping(run.grid)).toBe(true)
    // The test NordLink arrives after 600 / (60·50/86) min = 1032 s; the west link then ramps alone at its own 26 MW/min, arriving at 1124 s.
    advanceHeldToGroup(run, 1_040_000)
    expect(linkOf(run).transferMw).toBe(-600)
    const westAfterMw = linkOf(run, westLinkId).transferMw
    advanceHeldToGroup(run, 1_100_000)
    expect(linkOf(run, westLinkId).transferMw - westAfterMw).toBeCloseTo(-26, 9)
    advanceHeldToGroup(run, 1_400_000)
    expect(linkOf(run, westLinkId).transferMw).toBe(-300)
    expect(hvdcLinksRamping(run.grid)).toBe(false)
    expect(largestIslandInjectionSumMw(run.grid)).toBeLessThan(1e-6)
  })

  test('links ramping in opposite directions offset: within the net limit both move at their own ramps', () => {
    const run = steppedGrid(definitionFor(groupedModel))
    expect(run.command(gridSetHvdcSetpointCommandKind, { assetId: nordlinkId, setpointMw: 1_200 }).ok).toBe(true)
    expect(run.command(gridSetHvdcSetpointCommandKind, { assetId: westLinkId, setpointMw: -300 }).ok).toBe(true)
    // Net 60 − 26 = 34 MW/min, within the group's 50.
    advanceHeldToGroup(run, 60_000)
    expect(linkOf(run).transferMw).toBeCloseTo(60, 9)
    expect(linkOf(run, westLinkId).transferMw).toBeCloseTo(-26, 9)
    // Once the west link has arrived (after 692 s) the test NordLink ramps alone, held to the group's 50 MW/min.
    advanceHeldToGroup(run, 700_000)
    expect(linkOf(run, westLinkId).transferMw).toBe(-300)
    const nordlinkAfterMw = linkOf(run).transferMw
    advanceHeldToGroup(run, 760_000)
    expect(linkOf(run).transferMw - nordlinkAfterMw).toBeCloseTo(50, 9)
  })

  test('a link ramping alone in its group moves at the lower of its own and the group\'s limit; a blocked member takes no share', () => {
    const run = steppedGrid(definitionFor(groupedModel))
    expect(run.command(gridSetHvdcSetpointCommandKind, { assetId: nordlinkId, setpointMw: -600 }).ok).toBe(true)
    // Own 60 MW/min, group 50: 50 MW/min.
    run.advanceTo(120_000, [1_000])
    expect(linkOf(run).transferMw).toBeCloseTo(-100, 9)
    expect(run.command(gridBlockHvdcCommandKind, { assetId: nordlinkId }).ok).toBe(true)
    expect(run.command(gridSetHvdcSetpointCommandKind, { assetId: westLinkId, setpointMw: 300 }).ok).toBe(true)
    // Own 26 MW/min, group 50: 26 MW/min, the blocked test NordLink using none of the group's.
    run.advanceTo(240_000, [1_000])
    expect(linkOf(run, westLinkId).transferMw).toBeCloseTo(52, 9)
    // A link in no group keeps its own ramp: the same command on the ungrouped Model moves at 60 MW/min.
    const ungrouped = steppedGrid(definitionWith())
    expect(ungrouped.command(gridSetHvdcSetpointCommandKind, { assetId: nordlinkId, setpointMw: -600 }).ok).toBe(true)
    ungrouped.advanceTo(120_000, [1_000])
    expect(linkOf(ungrouped).transferMw).toBeCloseTo(-120, 9)
  })

  test('is deterministic and follows the same trajectory whatever the advance step', () => {
    // Samples while both ramp the same way, then after both have arrived.
    const sampleTimesMs = [90_000, 360_000, 720_000, 2_000_000]
    const trajectory = (stepMs: number): ReadonlyArray<number> => {
      const run = steppedGrid(definitionFor(groupedModel))
      expect(run.command(gridSetHvdcSetpointCommandKind, { assetId: nordlinkId, setpointMw: -600 }).ok).toBe(true)
      expect(run.command(gridSetHvdcSetpointCommandKind, { assetId: westLinkId, setpointMw: -300 }).ok).toBe(true)
      return sampleTimesMs.flatMap(timeMs => {
        run.advanceTo(timeMs, [stepMs])
        return [linkOf(run).transferMw, linkOf(run, westLinkId).transferMw]
      })
    }
    const reference = trajectory(1_000)
    expect(trajectory(1_000)).toEqual(reference)
    expect(reference.slice(0, 2).map(value => Math.round(value * 1e6) / 1e6)).toEqual([-60 * 50 / 86 * 1.5, -26 * 50 / 86 * 1.5].map(value => Math.round(value * 1e6) / 1e6))
    expect(reference.slice(-2)).toEqual([-600, -300])
    for (const stepMs of [250, 2_500, 7_000]) trajectory(stepMs).forEach((value, index) => expect(value).toBeCloseTo(reference[index]!, 9))
  })

  test('the Grid rejects a ramp group naming an unknown link, one link, or a link of another group', () => {
    const group = groupedModel.hvdcRampGroups[0]!
    const compile = (hvdcRampGroups: GridModelDefinition['hvdcRampGroups']) => () => gridDefinitionForModel({ ...groupedModel, hvdcRampGroups })
    expect(compile([{ ...group, linkIds: [nordlinkId, 'hvdc:missing'] }])).toThrow('HVDC ramp group ramp:test-de names unknown HVDC link hvdc:missing')
    expect(compile([{ ...group, linkIds: [nordlinkId] }])).toThrow('HVDC ramp group ramp:test-de needs at least two links')
    expect(compile([group, { ...group, id: 'ramp:test-other' }])).toThrow('HVDC link hvdc:test-nordlink belongs to both ramp:test-de and ramp:test-other; a link shares at most one ramp group')
  })

  test('asset.get and power-flow.snapshot name each link\'s ramp group and the group\'s limit', () => {
    const run = steppedGrid(definitionFor(groupedModel))
    expect(query(run.grid, 'world.electric-grid.asset.get', { assetId: westLinkId }).asset.rampGroup).toEqual({
      id: 'ramp:test-de', linkIds: [nordlinkId, westLinkId], rampMwPerMinute: groupRampMwPerMinute, provenance,
    })
    expect(query(run.grid, 'world.electric-grid.power-flow.snapshot').hvdcLinks.map((row: { id: string; rampGroup: unknown }) => [row.id, row.rampGroup])).toEqual([
      [nordlinkId, { id: 'ramp:test-de', rampMwPerMinute: groupRampMwPerMinute }],
      [westLinkId, { id: 'ramp:test-de', rampMwPerMinute: groupRampMwPerMinute }],
    ])
  })

  test('the Norway Model carries the NorNed–NordLink and Skagerrak ramp groups', () => {
    const definition = compileGridDefinition(gridDefinitionSchema.parse({
      id: 'grid:norway', model: { ref: norwayGridModelRef }, automation: { ref: nordicFrequencyAutomationRef }, operatingPoint: { ref: norwayRuntimeTestOperatingPointRef },
    }))
    expect(definition.index.hvdcRampGroups.map(group => [group.id, group.linkIds, group.rampMwPerMinute])).toEqual([
      ['ramp:no2-continental', ['hvdc:nordlink', 'hvdc:norned'], 50],
      ['ramp:skagerrak', ['hvdc:skagerrak-1', 'hvdc:skagerrak-2', 'hvdc:skagerrak-3', 'hvdc:skagerrak-4'], 25],
    ])
    expect(definition.index.hvdcRampGroupOfLink.has('hvdc:north-sea-link')).toBe(false)
  })
})

describe('set-external-exchange', () => {
  test('acts only on a synchronous external system: an HVDC-only neighbour is set through its links', () => {
    const run = steppedGrid(definitionWith())
    expect(reasonOf(run.command(gridSetExternalExchangeCommandKind, { assetId: 'external:DE', scheduledExportMw: 100 }))).toBe('external:DE is reached only by HVDC; set-hvdc-setpoint sets the transfer of its links')
    expect(reasonOf(run.command(gridSetExternalExchangeCommandKind, { assetId: 'external:SE', scheduledExportMw: 100 }))).toContain('external system not found: external:SE')
    expect(run.command(gridSetExternalExchangeCommandKind, { assetId: 'external:nordic-remainder', scheduledExportMw: 200 }).ok).toBe(true)
    expect(run.grid.externalSystems.get('external:nordic-remainder')).toMatchObject({ scheduledImportMw: 0, targetImportMw: -200, exchangeVoided: false })
  })
})

describe('HVDC block and deblock', () => {
  test('block stops the transfer at once without ramping; deblock returns the link at 0 MW to ramp on a new set-point', () => {
    const run = steppedGrid(definitionWith({ [nordlinkId]: -600 }))
    run.advanceTo(10_000)
    expect(linkOf(run)).toMatchObject({ state: 'deblocked', transferMw: -600 })
    expect(run.command(gridBlockHvdcCommandKind, { assetId: nordlinkId }).ok).toBe(true)
    expect(linkOf(run)).toMatchObject({ state: 'blocked', setpointMw: 0, transferMw: 0, lossesMw: 0, trip: null })
    expect(run.signals.find(signal => signal.type === 'electric-grid.hvdc.blocked')!.payload)
      .toMatchObject({ assetId: nordlinkId, transferBeforeMw: -600, islandId: run.grid.busStates.get('bus:south')!.islandId, elapsedSeconds: 10 })
    expect(reasonOf(run.command(gridBlockHvdcCommandKind, { assetId: nordlinkId }))).toBe('HVDC link hvdc:test-nordlink is already blocked')
    expect(reasonOf(run.command(gridSetHvdcSetpointCommandKind, { assetId: nordlinkId, setpointMw: 100 }))).toContain('is blocked; deblock-hvdc returns it to service at 0 MW')
    expect(reasonOf(run.command(gridResetHvdcTripCommandKind, { assetId: nordlinkId }))).toContain('not tripped')
    // A block is an operator action, not a fault: it raises no HVDC alarm.
    run.advanceTo(20_000)
    expect(run.grid.alarms.records.has(gridAlarmId('hvdc', nordlinkId, 'tripped'))).toBe(false)
    expect(run.command(gridDeblockHvdcCommandKind, { assetId: nordlinkId }).ok).toBe(true)
    expect(linkOf(run)).toMatchObject({ state: 'deblocked', setpointMw: 0, transferMw: 0 })
    expect(reasonOf(run.command(gridDeblockHvdcCommandKind, { assetId: nordlinkId }))).toBe('HVDC link hvdc:test-nordlink is already deblocked')
    expect(run.command(gridSetHvdcSetpointCommandKind, { assetId: nordlinkId, setpointMw: 120 }).ok).toBe(true)
    run.advanceTo(80_000, [1_000])
    expect(linkOf(run).transferMw).toBeCloseTo(60, 9)
    run.advanceTo(140_000, [1_000])
    expect(linkOf(run).transferMw).toBe(120)
    expect(hvdcTransitions(run)).toEqual(['electric-grid.hvdc.blocked', 'electric-grid.hvdc.deblocked'])
  })
})

describe('HVDC converter trips', () => {
  test('trip-hvdc trips the link and raises an alarm; reset leaves it blocked until deblock', () => {
    const run = steppedGrid(definitionWith({ [nordlinkId]: 800 }))
    run.advanceTo(10_000)
    expect(run.command(gridTripHvdcCommandKind, { assetId: nordlinkId }).ok).toBe(true)
    expect(linkOf(run)).toMatchObject({ state: 'tripped', setpointMw: 0, transferMw: 0, trip: { cause: 'command', atElapsedMs: 10_000, transferMw: 800 } })
    expect(tripSignals(run.signals)).toEqual([{ assetId: nordlinkId, element: 'command', elapsedSeconds: 10 }])
    const alarmId = gridAlarmId('hvdc', nordlinkId, 'tripped')
    expect(run.grid.alarms.records.get(alarmId)).toMatchObject({ active: true, priority: 2, scope: 'hvdc', assetId: nordlinkId, value: 800, unit: 'MW' })
    expect(run.grid.alarms.records.get(alarmId)!.message).toBe('Test NordLink was tripped by command while sending 800 MW; reset the trip, then deblock the link')
    expect(reasonOf(run.command(gridDeblockHvdcCommandKind, { assetId: nordlinkId }))).toContain('reset it with reset-hvdc-trip before deblocking it')
    expect(reasonOf(run.command(gridSetHvdcSetpointCommandKind, { assetId: nordlinkId, setpointMw: 100 }))).toContain('reset-hvdc-trip, then deblock-hvdc')
    expect(reasonOf(run.command(gridBlockHvdcCommandKind, { assetId: nordlinkId }))).toContain('already stopped')
    expect(reasonOf(run.command(gridTripHvdcCommandKind, { assetId: nordlinkId }))).toContain('nothing to trip')
    expect(run.command(gridResetHvdcTripCommandKind, { assetId: nordlinkId }).ok).toBe(true)
    expect(linkOf(run)).toMatchObject({ state: 'blocked', trip: null })
    run.advanceTo(30_000)
    expect(run.grid.alarms.records.get(alarmId)).toMatchObject({ active: false })
    expect(reasonOf(run.command(gridTripHvdcCommandKind, { assetId: nordlinkId }))).toContain('is blocked; there is nothing to trip')
    expect(run.command(gridDeblockHvdcCommandKind, { assetId: nordlinkId }).ok).toBe(true)
    expect(hvdcTransitions(run)).toEqual(['electric-grid.hvdc.trip-reset', 'electric-grid.hvdc.deblocked'])
  })

  test('a converter whose AC terminal loses voltage trips and cannot deblock until it is re-energised', () => {
    const run = steppedGrid(definitionWith({ [westLinkId]: -200 }))
    run.advanceTo(10_000)
    expect(run.command(gridOpenBranchCommandKind, { assetId: 'west-line' }).ok).toBe(true)
    // The trip applies in the zero-length tick that follows the switching, before any import reaches the dead bus.
    expect(run.grid.busStates.get('bus:west')!.energized).toBe(false)
    expect(linkOf(run, westLinkId)).toMatchObject({ state: 'tripped', transferMw: 0, trip: { cause: 'ac-voltage-loss', atElapsedMs: 10_000, transferMw: -200 } })
    expect(tripSignals(run.signals)).toEqual([{ assetId: westLinkId, element: 'ac-voltage-loss', elapsedSeconds: 10 }])
    expect(run.grid.alarms.records.get(gridAlarmId('hvdc', westLinkId, 'tripped'))!.message).toContain('tripped on loss of AC voltage while sending -200 MW')
    expect(run.command(gridResetHvdcTripCommandKind, { assetId: westLinkId }).ok).toBe(true)
    expect(reasonOf(run.command(gridDeblockHvdcCommandKind, { assetId: westLinkId }))).toBe('HVDC link hvdc:test-west cannot deblock: its converter terminal bus:west (bus:west) has no AC voltage')
    expect(query(run.grid, 'world.electric-grid.asset.get', { assetId: westLinkId }).asset.applicableOperationIds).toEqual([])
    expect(run.command(gridCloseBranchCommandKind, { assetId: 'west-line' }).ok).toBe(true)
    expect(run.command(gridDeblockHvdcCommandKind, { assetId: westLinkId }).ok).toBe(true)
    expect(linkOf(run, westLinkId)).toMatchObject({ state: 'deblocked', transferMw: 0 })
  })

  test('blocked and tripped links keep their state and trip through a persistence round trip', () => {
    const run = steppedGrid(definitionWith({ [nordlinkId]: 500, [westLinkId]: 100 }))
    run.advanceTo(10_000)
    expect(run.command(gridTripHvdcCommandKind, { assetId: nordlinkId }).ok).toBe(true)
    expect(run.command(gridBlockHvdcCommandKind, { assetId: westLinkId }).ok).toBe(true)
    const { gridId, definitionDigest } = run.grid.definition
    const stored = electricGridRuntimeStateSchema.parse(JSON.parse(JSON.stringify(runtimeStateForElectricGrids(new Map([[gridId, run.grid]])))))
    const restored = createGridRuntimeInstance({ definition: run.grid.definition, at: isoAt(10_000), restored: restoredGridRuntimeStateFor(stored, gridId, definitionDigest)! })
    expect(restored.hvdcLinks.get(nordlinkId)).toEqual(linkOf(run))
    expect(restored.hvdcLinks.get(westLinkId)).toEqual(linkOf(run, westLinkId))
    expect(restored.hvdcLinks.get(nordlinkId)).toMatchObject({ state: 'tripped', trip: { cause: 'command', transferMw: 500 } })
  })
})

describe('island balance through an HVDC import step', () => {
  test('stays exact when a 1,000 MW import blocks or trips at once', () => {
    for (const kind of [gridBlockHvdcCommandKind, gridTripHvdcCommandKind]) {
      const run = steppedGrid(definitionWith({ [nordlinkId]: -1_000 }))
      run.advanceTo(10_000, [1_000])
      const southIsland = () => run.grid.islandPlan!.islands.find(island => island.id === run.grid.busStates.get('bus:south')!.islandId)!
      const pickUpBaseMw = [0, 1, 2, 3].reduce((sum, index) => sum + run.grid.generators.get(`south-${index}`)!.dispatchMw, 0)
        + run.grid.externalSystems.get('external:nordic-remainder')!.importMw
      expect(run.command(kind, { assetId: nordlinkId }).ok).toBe(true)
      let worstSumMw = largestIslandInjectionSumMw(run.grid)
      let worstKclMw = largestKclResidualMw(run.grid)
      let nadirHz = Number.POSITIVE_INFINITY
      for (let second = 0; second < 30; second += 1) {
        run.advanceTo(run.nowMs() + 1_000, [1_000])
        worstSumMw = Math.max(worstSumMw, largestIslandInjectionSumMw(run.grid))
        worstKclMw = Math.max(worstKclMw, largestKclResidualMw(run.grid))
        nadirHz = Math.min(nadirHz, southIsland().minimumHz!)
      }
      const pickUpMw = [0, 1, 2, 3].reduce((sum, index) => sum + run.grid.generators.get(`south-${index}`)!.dispatchMw, 0)
        + run.grid.externalSystems.get('external:nordic-remainder')!.importMw - pickUpBaseMw
      console.info(`HVDC ${kind.split('.').at(-1)} of a 1000 MW import (969 MW delivered): island sum ≤ ${worstSumMw.toExponential(2)} MW, KCL ≤ ${worstKclMw.toExponential(2)} MW, nadir ${nadirHz.toFixed(4)} Hz, units + Nordic equivalent +${pickUpMw.toFixed(1)} MW after 30 s`)
      expect(worstSumMw).toBeLessThan(1e-6)
      expect(worstKclMw).toBeLessThan(1e-6)
      expect(nadirHz).toBeLessThan(50)
      // Units and the equivalent replace the lost 969 MW, plus the tie's added I²R losses (r 0.001 pu
      // at about 9.7 pu more flow: about 9 MW), less load self-regulation at the lower frequency.
      expect(Math.abs(pickUpMw - 969)).toBeLessThan(15)
    }
  })
})

describe('HVDC links in the Grid queries', () => {
  test('asset.get, assets.search, power-flow.snapshot and islands.list carry HVDC state and operations', () => {
    const run = steppedGrid(definitionWith({ [nordlinkId]: -600 }))
    run.advanceTo(10_000)
    const detail = query(run.grid, 'world.electric-grid.asset.get', { assetId: nordlinkId }).asset
    expect(detail).toMatchObject({
      id: nordlinkId,
      kind: 'hvdc',
      subkind: 'hvdc_link',
      status: { tone: 'ready', label: 'Deblocked' },
      summary: '-600 / -600 MW set-point · ±1,400 MW',
      applicableOperationIds: [gridSetHvdcSetpointCommandKind, gridBlockHvdcCommandKind, gridTripHvdcCommandKind],
      mapTarget: { kind: 'bounds', bounds: [[7, 59], [9, 59]] },
      definition: { fromBusId: 'bus:south', toBusId: 'bus:boundary-DE', ratingMw: 1_400, lossPercent: 3.1, rampMwPerMinute: 60 },
      rampGroup: null,
      state: { state: 'deblocked', setpointMw: -600, transferMw: -600, lossesMw: expect.closeTo(18.6, 9), trip: null },
    })
    expect(query(run.grid, 'world.electric-grid.assets.search', { kinds: ['hvdc'] }).assets.map((asset: { id: string }) => asset.id)).toEqual([nordlinkId, westLinkId])
    expect(query(run.grid, 'world.electric-grid.assets.search', { text: 'nordlink' }).assets.map((asset: { id: string }) => asset.id)).toEqual([nordlinkId])

    const rows = query(run.grid, 'world.electric-grid.power-flow.snapshot').hvdcLinks
    expect(rows).toEqual([
      { id: nordlinkId, label: 'Test NordLink', state: 'deblocked', ratingMw: 1_400, setpointMw: -600, transferMw: -600, lossesMw: 18.6, loadingPercent: 42.9, rampGroup: null },
      { id: westLinkId, label: 'Test west link', state: 'deblocked', ratingMw: 700, setpointMw: 0, transferMw: 0, lossesMw: 0, loadingPercent: 0, rampGroup: null },
    ])
    expect(query(run.grid, 'world.electric-grid.power-flow.snapshot', { minLoadingPercent: 10 }).hvdcLinks.map((row: { id: string }) => row.id)).toEqual([nordlinkId])

    expect(run.command(gridSetHvdcSetpointCommandKind, { assetId: nordlinkId, setpointMw: -700 }).ok).toBe(true)
    expect(query(run.grid, 'world.electric-grid.asset.get', { assetId: nordlinkId }).asset.status).toEqual({ tone: 'working', label: 'Ramping to -700 MW' })
    expect(run.command(gridBlockHvdcCommandKind, { assetId: westLinkId }).ok).toBe(true)
    expect(query(run.grid, 'world.electric-grid.asset.get', { assetId: westLinkId }).asset).toMatchObject({ status: { tone: 'idle', label: 'Blocked' }, applicableOperationIds: [gridDeblockHvdcCommandKind] })
    expect(query(run.grid, 'world.electric-grid.assets.search', { status: ['blocked'] }).assets.map((asset: { id: string }) => asset.id)).toEqual([westLinkId])
    expect(run.command(gridTripHvdcCommandKind, { assetId: nordlinkId }).ok).toBe(true)
    expect(query(run.grid, 'world.electric-grid.asset.get', { assetId: nordlinkId }).asset).toMatchObject({ status: { tone: 'error', label: 'Tripped (command)' }, applicableOperationIds: [gridResetHvdcTripCommandKind] })
    expect(query(run.grid, 'world.electric-grid.assets.search', { kinds: ['hvdc'], status: ['tripped'] }).total).toBe(1)
  })
})

describe('NordLink import block on the Norway Model', () => {
  test('blocking a 1,400 MW NordLink import is a frequency event that Nordic FCR-D arrests above 49.0 Hz', () => {
    const definition = compileGridDefinition(gridDefinitionSchema.parse({
      id: 'grid:norway',
      model: { ref: norwayGridModelRef },
      automation: { ref: nordicFrequencyAutomationRef },
      operatingPoint: {
        ref: norwayRuntimeTestOperatingPointRef,
        overrides: { hvdcSchedules: [{ assetId: 'hvdc:nordlink', timeZone: 'Europe/Oslo', points: [{ localTime: '00:00', transferMw: -1_400 }] }] },
      },
    }))
    const nordlink = definition.index.hvdcLinks.find(link => link.id === 'hvdc:nordlink')!
    const run = steppedGrid(definition)
    run.advanceTo(10_000, [1_000])
    expect(run.grid.hvdcLinks.get(nordlink.id)).toMatchObject({ state: 'deblocked', transferMw: -1_400 })
    const island = () => run.grid.islandPlan!.islands.find(candidate => candidate.id === run.grid.busStates.get(nordlink.fromBusId)!.islandId)!
    const beforeHz = island().frequency!.frequencyHz!
    expect(run.command(gridBlockHvdcCommandKind, { assetId: nordlink.id }).ok).toBe(true)
    // The swing equation's RoCoF at the step: ΔP·f0 / (2·E_k) over the island's kinetic energy.
    const kineticEnergyMws = islandKineticEnergyMws(run.grid, run.grid.islandPlan!.plan.islands[island().planIndex]!)
    let worstSumMw = largestIslandInjectionSumMw(run.grid)
    let nadirHz = Number.POSITIVE_INFINITY
    let nadirAtSeconds = 0
    let largestRocof = 0
    const frequencyAt = new Map<number, number>()
    for (let second = 1; second <= 60; second += 1) {
      run.advanceTo(10_000 + second * 1_000, [1_000])
      const current = island()
      worstSumMw = Math.max(worstSumMw, largestIslandInjectionSumMw(run.grid))
      if (current.minimumHz! < nadirHz) {
        nadirHz = current.minimumHz!
        nadirAtSeconds = second
      }
      largestRocof = Math.max(largestRocof, Math.abs(current.rocofHzPerSecond!))
      frequencyAt.set(second, current.frequency!.frequencyHz!)
    }
    const lostInfeedMw = 1_400 * (1 - nordlink.lossPercent / 100)
    const initialRocof = lostInfeedMw * 50 / (2 * kineticEnergyMws)
    console.info(`NordLink block at 1400 MW import (${lostInfeedMw.toFixed(1)} MW infeed lost): f ${beforeHz.toFixed(4)} Hz → nadir ${nadirHz.toFixed(4)} Hz in second ${nadirAtSeconds}, E_k ${(kineticEnergyMws / 1_000).toFixed(1)} GWs so RoCoF −${initialRocof.toFixed(4)} Hz/s at the step, |RoCoF| ≤ ${largestRocof.toFixed(4)} Hz/s at 1 s samples, f(30 s) ${frequencyAt.get(30)!.toFixed(4)} Hz, f(60 s) ${frequencyAt.get(60)!.toFixed(4)} Hz, island sum ≤ ${worstSumMw.toExponential(2)} MW`)
    expect(worstSumMw).toBeLessThan(1e-6)
    // FCR-D activates below 49.9 Hz; SO GL Annex III caps the Nordic maximum instantaneous frequency deviation at 1000 mHz.
    expect(nadirHz).toBeLessThan(49.9)
    expect(nadirHz).toBeGreaterThan(49.0)
    expect(run.grid.frequencyEvents.filter(event => event.kind === 'lfdd-stage-operated' || event.kind === 'generator-trip')).toEqual([])
    expect(run.grid.alarms.records.has(gridAlarmId('hvdc', nordlink.id, 'tripped'))).toBe(false)
  }, 120_000)
})

describe('HVDC terminals of asynchronous external systems', () => {
  test('lie in no island: islands.list, the projection, energisation, alarms and recordings leave them out', () => {
    const run = steppedGrid(definitionWith({ [nordlinkId]: 600 }))
    run.advanceTo(10_000)
    const terminal = 'bus:boundary-DE'
    const islands = solvedGridIslands(run.grid)
    expect(islands.plan.islandIndexOfBus[islands.plan.network.busIndexById.get(terminal)!]).toBe(-1)
    expect(() => gridIslandAtBus(islands, terminal)).toThrow('lies in no island: it is an HVDC terminal of an asynchronous external system')
    // One Norwegian island, counted alike by islands.list, the projection count and the projected islands.
    const listed = query(run.grid, 'world.electric-grid.islands.list')
    expect(listed.total).toBe(1)
    expect(run.grid.projection.islandCount).toBe(1)
    expect(run.grid.projection.islands.map(island => island.id)).toEqual(listed.islands.map((island: { id: string }) => island.id))
    expect(listed.islands[0].busCount).toBe(3)
    // Its own state: the system's area and the links ending there; no bus state, energisation or island.
    expect(run.grid.busStates.has(terminal)).toBe(false)
    expect(run.grid.hvdcTerminals.get(terminal)).toEqual({
      busId: terminal,
      externalSystemId: 'external:DE',
      area: 'DE',
      links: [
        { linkId: nordlinkId, state: 'deblocked', setpointMw: 600, transferMw: 600 },
        { linkId: westLinkId, state: 'deblocked', setpointMw: 0, transferMw: 0 },
      ],
      deliveredMw: 600 * (1 - 0.031),
    })
    const detail = query(run.grid, 'world.electric-grid.asset.get', { assetId: terminal }).asset
    expect(detail).toMatchObject({
      kind: 'bus', subkind: 'hvdc-terminal', status: { tone: 'ready', label: 'HVDC terminal' },
      summary: 'Germany · Test NordLink 600 MW export · Test west link 0 MW export', applicableOperationIds: [],
      state: { externalSystemId: 'external:DE', area: 'DE', deliveredMw: 600 * (1 - 0.031) },
    })
    const busIds = (input: Readonly<Record<string, unknown>>) => query(run.grid, 'world.electric-grid.assets.search', { kinds: ['bus'], ...input }).assets.map((asset: { id: string }) => asset.id)
    expect(busIds({ status: ['de-energized'] })).toEqual([])
    expect(busIds({ status: ['energized'] })).toEqual(['bus:south', 'bus:west', 'bus:boundary-SE3@420'])
    expect(busIds({ islandId: listed.islands[0].id })).toEqual(['bus:south', 'bus:west', 'bus:boundary-SE3@420'])
    // A link matches the island of its Norwegian converter.
    expect(query(run.grid, 'world.electric-grid.power-flow.snapshot', { islandId: listed.islands[0].id }).hvdcLinks.map((row: { id: string }) => row.id)).toEqual([nordlinkId, westLinkId])
    // The map's island state, in the Model's bus order, places the terminal in no island.
    const mapIslands = gridMapIslandState(run.grid)
    expect(mapIslands.busIsland).toEqual(model.buses.map(bus => bus.id === terminal ? null : 0))
    const recording = createGridRecordingPlan({ selection: { packId: 'electric-grid', profileId: 'engineering' }, grids: new Map([[run.grid.definition.gridId, run.grid]]) })
    expect(recording.descriptors.filter(descriptor => descriptor.signalId.startsWith(terminal))).toEqual([])
    expect(recording.descriptors.filter(descriptor => descriptor.signalId.startsWith('bus:west.'))).toHaveLength(2)

    // Whatever its links do, the terminal raises no alarm and forms no island: a trip and a block
    // stop the transfer, and only the trip raises the link's own alarm.
    expect(run.command(gridTripHvdcCommandKind, { assetId: nordlinkId }).ok).toBe(true)
    expect(run.command(gridBlockHvdcCommandKind, { assetId: westLinkId }).ok).toBe(true)
    run.advanceTo(20_000)
    expect(run.grid.hvdcTerminals.get(terminal)).toMatchObject({ links: [{ state: 'tripped', transferMw: 0 }, { state: 'blocked', transferMw: 0 }], deliveredMw: 0 })
    expect(query(run.grid, 'world.electric-grid.asset.get', { assetId: terminal }).asset.status).toEqual({ tone: 'idle', label: 'HVDC terminal' })
    // The lost export raises the link's trip and the Norwegian island's frequency and reserve alarms; none concerns the terminal.
    const records = [...run.grid.alarms.records.values()]
    expect(records.find(record => record.id === gridAlarmId('hvdc', nordlinkId, 'tripped'))).toMatchObject({ active: true, islandId: listed.islands[0].id })
    expect(records.filter(record => record.islandId !== listed.islands[0].id || record.id.includes(terminal) || record.assetId === terminal)).toEqual([])
    expect(query(run.grid, 'world.electric-grid.islands.list').total).toBe(1)

    // A Norwegian converter bus that loses supply is a dead island with its alarm; the terminal still is none.
    expect(run.command(gridOpenBranchCommandKind, { assetId: 'west-line' }).ok).toBe(true)
    run.advanceTo(30_000)
    const split = query(run.grid, 'world.electric-grid.islands.list')
    expect(split.islands.map((island: { busCount: number; energized: boolean }) => [island.busCount, island.energized])).toEqual([[2, true], [1, false]])
    expect(run.grid.projection.islandCount).toBe(2)
    const deEnergised = [...run.grid.alarms.records.values()].filter(record => record.active && record.condition === 'de-energised')
    expect(deEnergised.map(record => record.islandId)).toEqual([run.grid.busStates.get('bus:west')!.islandId])
  })

  test('on the Norway Model the four HVDC-only neighbours are terminals and the island count agrees everywhere', () => {
    const definition = compileGridDefinition(gridDefinitionSchema.parse({
      id: 'grid:norway', model: { ref: norwayGridModelRef }, automation: { ref: nordicFrequencyAutomationRef }, operatingPoint: { ref: norwayRuntimeTestOperatingPointRef },
    }))
    const run = steppedGrid(definition)
    run.advanceTo(4_000, [1_000])
    expect([...run.grid.hvdcTerminals.keys()].sort()).toEqual(['bus:boundary-DE', 'bus:boundary-DK1', 'bus:boundary-GB', 'bus:boundary-NL'])
    const listed = query(run.grid, 'world.electric-grid.islands.list', { limit: 500 })
    expect(listed.total).toBe(run.grid.projection.islandCount)
    expect(listed.total).toBe(run.grid.projection.islands.length)
    expect(listed.total).toBe(1)
    expect(listed.islands[0].busCount).toBe(definition.model.buses.length - 4)
    for (const terminal of run.grid.hvdcTerminals.values()) {
      expect(terminal.links.length).toBeGreaterThan(0)
      expect(run.grid.busStates.has(terminal.busId)).toBe(false)
    }
  }, 120_000)
})
