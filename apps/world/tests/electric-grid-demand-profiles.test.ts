import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IsoTimestamp } from '../src/core/model/index.ts'
import {
  electricGridDefinitionCatalog,
  haldenFourUnitGridModelRef,
  nordicFrequencyAutomationRef,
  norwayGridModelRef,
  norwaySummerLowOperatingPointRef,
  norwayWinterPeakOperatingPointRef,
} from '../src/packs/electric-grid/definition-refs.ts'
import { compileGridDefinition, compileGridModelIndex, createGridDefinitionCompiler, gridAutomationFileReader, gridModelFileReader, gridModelV2, gridLoadProfiles } from '../src/packs/electric-grid/definitions.ts'
import type { CompiledGridDefinition, GridDemandProfileDefinition } from '../src/packs/electric-grid/grid-model.ts'
import { compileGridModelV2 } from '../src/packs/electric-grid/models/compile-v2.ts'
import { gridAssetGetQuery } from '../src/packs/electric-grid/queries/assets.ts'
import { answerElectricGridQuery } from '../src/packs/electric-grid/queries/index.ts'
import { gridSummaryQuery } from '../src/packs/electric-grid/queries/summary.ts'
import { applyGridDemand } from '../src/packs/electric-grid/runtime/demand.ts'
import { evaluateDemandProfiles, osloLocalMs } from '../src/packs/electric-grid/runtime/demand-profiles.ts'
import { createGridRuntimeInstance, type GridRuntimeInstance } from '../src/packs/electric-grid/runtime/instance.ts'
import { advanceGrid } from '../src/packs/electric-grid/runtime/solver.ts'
import { validateGridLoadProfiles, type GridLoadProfiles } from '../src/packs/electric-grid/schemas/grid-load-profile.ts'
import { validateGridModel, type GridModelV2 } from '../src/packs/electric-grid/schemas/grid-model.ts'
import type { PriceArea } from '../src/packs/electric-grid/schemas/grid-ids.ts'
import { gridOperatingPointTargetsForModel, validateGridOperatingPoint, type GridOperatingPointV2 } from '../src/packs/electric-grid/schemas/grid-operating-point.ts'

// The Grid's daily demand follows Elhub's measured price-area profiles (models/norway-load-profiles.json):
// each load the series of its price area and municipality group (major sites: the industry group),
// in the Operating Point's season, exactly 1 at the Operating Point's hour. The expectations below
// are computed from the committed JSON files, independently of the compiler.

const models = join(import.meta.dir, '../src/packs/electric-grid/models')
const readJson = async (file: string): Promise<unknown> => JSON.parse(await readFile(join(models, file), 'utf8')) as unknown
const v2: GridModelV2 = validateGridModel(await readJson('norway-transmission.grid-model.json'), 'model')
const profiles: GridLoadProfiles = validateGridLoadProfiles(await readJson('norway-load-profiles.json'), 'profiles')
const winterPoint = validateGridOperatingPoint(await readJson('norway-winter-weekday-peak.operating-point.json'), 'winter', gridOperatingPointTargetsForModel(v2))
const summerPoint = validateGridOperatingPoint(await readJson('norway-summer-night-low.operating-point.json'), 'summer', gridOperatingPointTargetsForModel(v2))

const definitionFor = (operatingPointRef: string, modelRef = norwayGridModelRef): CompiledGridDefinition => compileGridDefinition({
  id: 'grid:demand-profiles', model: { ref: modelRef }, operatingPoint: { ref: operatingPointRef }, automation: { ref: nordicFrequencyAutomationRef },
})
const winter = definitionFor(norwayWinterPeakOperatingPointRef)
const summer = definitionFor(norwaySummerLowOperatingPointRef)

const totalDemandMw = (grid: GridRuntimeInstance): number => grid.arrays.loads.demandMw.reduce((sum, value) => sum + value, 0)
const demandAt = (grid: GridRuntimeInstance, at: string): number => {
  applyGridDemand(grid, Date.parse(at))
  return totalDemandMw(grid)
}

type Group = 'private' | 'business' | 'industry'
type DayType = 'weekday' | 'weekend'
const groupOf = (kind: GridModelV2['loads'][number]['kind']): Group => kind === 'private' || kind === 'business' ? kind : 'industry'

/** The Operating Point's demand of each price area × group (MW). */
const cellsOf = (point: GridOperatingPointV2): ReadonlyArray<{ readonly area: PriceArea; readonly group: Group; readonly mw: number }> =>
  (Object.entries(point.demand.priceAreaGroupMw) as Array<[PriceArea, Partial<Record<Group, number>>]>)
    .flatMap(([area, groups]) => (Object.entries(groups) as Array<[Group, number]>).map(([group, mw]) => ({ area, group, mw })))

/** A profile series at local `hour` (fractional, linear between hours) of one day type. */
const seriesAt = (season: 'winter' | 'summer', dayType: DayType, area: PriceArea, group: Group, hour: number): number => {
  const series = profiles.seasons[season][dayType][area][group]
  const whole = Math.floor(hour)
  return series[whole]! + (series[(whole + 1) % 24]! - series[whole]!) * (hour - whole)
}

/**
 * Σ over price area × group of the Operating Point's MW × the Elhub series at local `hour` of
 * `dayType`, divided by the series at the Operating Point's hour.
 */
const elhubTotalMw = (config: {
  readonly point: GridOperatingPointV2
  readonly dayType: DayType
  readonly hour: number
  readonly reference: { readonly dayType: DayType; readonly hour: number }
}): number => {
  const season = config.point.demand.season
  return cellsOf(config.point).reduce((total, { area, group, mw }) =>
    total + mw * seriesAt(season, config.dayType, area, group, config.hour) / seriesAt(season, config.reference.dayType, area, group, config.reference.hour), 0)
}

/**
 * Elhub's mean-day demand of a season and day type at local `hour` (MW): a profile value is the
 * measured mean MW of its area and group divided by its MW at the profiles' reference hour, where
 * the winter Operating Point sets each area and group to its metered MW.
 */
const elhubMeanMw = (season: 'winter' | 'summer', dayType: DayType, hour: number): number =>
  cellsOf(winterPoint).reduce((total, { area, group, mw }) => total + mw * seriesAt(season, dayType, area, group, hour), 0)

describe('Electric Grid demand profiles', () => {
  test('each load follows the Elhub series of its price area and group in the Operating Point season', () => {
    // Each Operating Point file names its season and measured hour.
    expect(winterPoint.demand).toMatchObject({ season: 'winter', referenceHour: '2026-01-12T08:00:00+01:00' })
    expect(summerPoint.demand).toMatchObject({ season: 'summer', referenceHour: '2026-07-12T06:00:00+02:00' })
    const v2ById = new Map(v2.loads.map(load => [load.id, load]))
    const profileById = new Map(winter.model.demandProfiles.map(profile => [profile.id, profile]))
    expect(winter.model.demandProfiles.map(profile => profile.id)).toHaveLength(15)
    for (const load of winter.model.loads) {
      const source = v2ById.get(load.id)!
      expect(profileById.get(load.demandProfileId)!.series).toEqual({
        profileSetId: 'electric-grid.norway.load-profiles', season: 'winter', priceArea: source.priceArea, group: groupOf(source.kind), referenceHour: '2026-01-12T08:00:00+01:00',
      })
    }
    // Major sites (25 industry sites and 12 petroleum sites) follow their area's industry group.
    const sites = winter.model.loads.filter(load => v2ById.get(load.id)!.kind.endsWith('-site'))
    expect(sites).toHaveLength(37)
    for (const site of sites) expect(site.demandProfileId).toBe(`demand-profile:winter-${v2ById.get(site.id)!.priceArea.toLowerCase()}-industry`)
    expect(summer.model.demandProfiles.every(profile => profile.series!.season === summerPoint.demand.season && profile.series!.referenceHour === summerPoint.demand.referenceHour)).toBe(true)
    // The Halden addition adds no load: its loads are Norway's with the same profiles.
    const halden = definitionFor(norwayWinterPeakOperatingPointRef, haldenFourUnitGridModelRef)
    expect(halden.model.demandProfiles).toEqual(winter.model.demandProfiles)
    expect(halden.model.loads.map(load => load.demandProfileId)).toEqual(winter.model.loads.map(load => load.demandProfileId))
  })

  test('reproduces the Operating Point demand exactly at its hour, winter and summer', () => {
    for (const [definition, at] of [[winter, '2026-01-12T07:00:00.000Z'], [summer, '2026-07-12T04:00:00.000Z']] as const) {
      const grid = createGridRuntimeInstance({ definition, at })
      const loads = grid.arrays.loads
      for (let load = 0; load < definition.model.loads.length; load += 1) {
        expect(loads.profileFactor[load]).toBe(1)
        expect(loads.demandMw[load]).toBe(loads.nominalDemandMw[load]!)
      }
    }
    expect(Math.round(totalDemandMw(createGridRuntimeInstance({ definition: winter, at: '2026-01-12T07:00:00.000Z' })))).toBe(22_883)
    expect(Math.round(totalDemandMw(createGridRuntimeInstance({ definition: summer, at: '2026-07-12T04:00:00.000Z' })))).toBe(10_493)
  })

  test('tracks the Elhub winter weekday series over the day, linear between hours', () => {
    const grid = createGridRuntimeInstance({ definition: winter, at: '2026-01-12T07:00:00.000Z' })
    const reference = { dayType: 'weekday', hour: 8 } as const
    // Monday 2026-01-12 (CET, UTC+1), every half hour.
    for (let step = 0; step < 48; step += 1) {
      const at = new Date(Date.parse('2026-01-11T23:00:00.000Z') + step * 1_800_000).toISOString()
      const expected = elhubTotalMw({ point: winterPoint, dayType: 'weekday', hour: step / 2, reference })
      expect(Math.abs(demandAt(grid, at) - expected)).toBeLessThan(1e-6 * expected)
    }
    // Measured shape: below the reference hour at night, midday and evening.
    expect(Math.round(demandAt(grid, '2026-01-12T02:00:00.000Z'))).toBe(19_941)
    expect(Math.round(demandAt(grid, '2026-01-12T11:00:00.000Z'))).toBe(22_611)
    expect(Math.round(demandAt(grid, '2026-01-12T17:00:00.000Z'))).toBe(22_596)
  })

  test('sets each price area and group to its metered demand, so the summer day follows Elhub\'s measured mix on both day types', () => {
    // Elhub's price-area totals at the Operating Points' hours (model-and-data: the reference hours).
    const areaTotals = (point: GridOperatingPointV2) => {
      const totals: Partial<Record<PriceArea, number>> = {}
      for (const { area, mw } of cellsOf(point)) totals[area] = (totals[area] ?? 0) + mw
      return Object.fromEntries(Object.entries(totals).map(([area, mw]) => [area, Math.round(mw * 10) / 10]))
    }
    expect(areaTotals(winterPoint)).toEqual({ NO1: 7238.7, NO2: 5817.4, NO3: 4262.9, NO4: 3047.1, NO5: 2516.8 })
    expect(areaTotals(summerPoint)).toEqual({ NO1: 1811.8, NO2: 3044.1, NO3: 2470.3, NO4: 1674.8, NO5: 1491.9 })
    expect(Date.parse(profiles.referenceHour)).toBe(Date.parse(winterPoint.demand.referenceHour))
    const grid = createGridRuntimeInstance({ definition: summer, at: '2026-07-12T04:00:00.000Z' })
    const reference = { dayType: 'weekend', hour: 6 } as const
    const ratios: number[] = []
    // Sunday 2026-07-12 and Monday 2026-07-13 (CEST, UTC+2), every half hour from 00:00 to 23:00.
    for (const [midnight, dayType] of [['2026-07-11T22:00:00.000Z', 'weekend'], ['2026-07-12T22:00:00.000Z', 'weekday']] as const) {
      for (let step = 0; step <= 46; step += 1) {
        const modelMw = demandAt(grid, new Date(Date.parse(midnight) + step * 1_800_000).toISOString())
        expect(grid.demandSample.dayType).toBe(dayType)
        const expected = elhubTotalMw({ point: summerPoint, dayType, hour: step / 2, reference })
        expect(Math.abs(modelMw - expected)).toBeLessThan(1e-6 * expected)
        ratios.push(modelMw / elhubMeanMw('summer', dayType, step / 2))
      }
    }
    // One ratio to Elhub's mean summer day at every hour of both day types, to within 0.3 %: the
    // measured Sunday 06:00 against the Saturday–Sunday mean at 06:00 (with winter's mix scaled
    // per price area, Sunday 18:00 was 6.8 % above that mean).
    expect(Math.max(...ratios) / Math.min(...ratios)).toBeLessThan(1.003)
    expect(ratios[12]!).toBeCloseTo(10_492.8 / elhubMeanMw('summer', 'weekend', 6), 4)
    expect(ratios[12]!).toBeGreaterThan(0.99)
    // Sunday 12:00, 18:00 and 23:00 CEST.
    expect(['10', '16', '21'].map(utcHour => Math.round(demandAt(grid, `2026-07-12T${utcHour}:00:00.000Z`)))).toEqual([12_016, 11_993, 11_486])
  })

  test('takes the weekend profile on Saturday and Sunday and moves into the next day type after 23:00', () => {
    const grid = createGridRuntimeInstance({ definition: winter, at: '2026-01-12T07:00:00.000Z' })
    const reference = { dayType: 'weekday', hour: 8 } as const
    const saturday = demandAt(grid, '2026-01-17T07:00:00.000Z')
    expect(grid.demandSample.dayType).toBe('weekend')
    expect(Math.abs(saturday - elhubTotalMw({ point: winterPoint, dayType: 'weekend', hour: 8, reference }))).toBeLessThan(1e-6 * saturday)
    expect(saturday).toBeLessThan(0.85 * demandAt(grid, '2026-01-16T07:00:00.000Z'))
    expect(grid.demandSample.dayType).toBe('weekday')
    // Friday 23:30 lies halfway between Friday's 23:00 and Saturday's 00:00.
    const friday23 = elhubTotalMw({ point: winterPoint, dayType: 'weekday', hour: 23, reference })
    const saturday0 = elhubTotalMw({ point: winterPoint, dayType: 'weekend', hour: 0, reference })
    expect(Math.abs(demandAt(grid, '2026-01-16T22:30:00.000Z') - (friday23 + saturday0) / 2)).toBeLessThan(1e-6 * friday23)
  })

  test('takes the weekend profile on Norwegian public holidays and names their day type holiday', () => {
    const grid = createGridRuntimeInstance({ definition: winter, at: '2026-01-12T07:00:00.000Z' })
    const reference = { dayType: 'weekday', hour: 8 } as const
    // New Year's Day, Thursday 2026-01-01 11:00 CET: the hour of Sunday 2026-01-04, not of Friday 2026-01-02.
    const newYear = demandAt(grid, '2026-01-01T10:00:00.000Z')
    expect(grid.demandSample.dayType).toBe('holiday')
    expect(Math.abs(newYear - elhubTotalMw({ point: winterPoint, dayType: 'weekend', hour: 11, reference }))).toBeLessThan(1e-6 * newYear)
    expect(demandAt(grid, '2026-01-04T10:00:00.000Z')).toBe(newYear)
    expect(grid.demandSample.dayType).toBe('weekend')
    expect(newYear).toBeLessThan(0.9 * demandAt(grid, '2026-01-02T10:00:00.000Z'))
    expect(grid.demandSample.dayType).toBe('weekday')
    // New Year's Eve 23:30 lies halfway between Wednesday's 23:00 and the holiday's 00:00.
    const wednesday23 = elhubTotalMw({ point: winterPoint, dayType: 'weekday', hour: 23, reference })
    const holiday0 = elhubTotalMw({ point: winterPoint, dayType: 'weekend', hour: 0, reference })
    expect(Math.abs(demandAt(grid, '2025-12-31T22:30:00.000Z') - (wednesday23 + holiday0) / 2)).toBeLessThan(1e-6 * wednesday23)
    // The moveable holidays of 2026 on weekdays: Maundy Thursday, Good Friday, Easter Monday, Ascension Day, Whit Monday.
    for (const date of ['2026-04-02', '2026-04-03', '2026-04-06', '2026-05-14', '2026-05-25']) {
      demandAt(grid, `${date}T10:00:00.000Z`)
      expect({ date, dayType: grid.demandSample.dayType }).toEqual({ date, dayType: 'holiday' })
    }
    // A demand sample on a holiday allocates no Map or Set.
    const globals = globalThis as { Map: MapConstructor; Set: SetConstructor }
    const { Map: OriginalMap, Set: OriginalSet } = globals
    let constructions = 0
    globals.Map = new Proxy(OriginalMap, { construct: (target, args, newTarget) => { constructions += 1; return Reflect.construct(target, args, newTarget) } })
    globals.Set = new Proxy(OriginalSet, { construct: (target, args, newTarget) => { constructions += 1; return Reflect.construct(target, args, newTarget) } })
    try {
      for (let minute = 0; minute < 60; minute += 1) applyGridDemand(grid, Date.parse('2025-12-31T22:30:00.000Z') + minute * 60_000)
    } finally {
      globals.Map = OriginalMap
      globals.Set = OriginalSet
    }
    expect(constructions).toBe(0)
    expect(grid.demandSample.dayType).toBe('holiday')
    // asset.get and grid.summary name the day type.
    const grids = new Map([[winter.gridId, grid]])
    const load = winter.model.loads[0]!
    const detail = gridAssetGetQuery.capability.output.parse(answerElectricGridQuery({ request: { capabilityId: gridAssetGetQuery.capability.id, input: { gridId: winter.gridId, assetId: load.id } }, grids })) as {
      readonly asset: { readonly demandProfile: { readonly sample: { readonly localTime: string; readonly dayType: string } } }
    }
    expect(detail.asset.demandProfile.sample).toMatchObject({ localTime: '00:29', dayType: 'holiday' })
    const summary = gridSummaryQuery.capability.output.parse(answerElectricGridQuery({ request: { capabilityId: gridSummaryQuery.capability.id, input: { gridId: winter.gridId } }, grids })) as {
      readonly demandProfiles: { readonly sample: { readonly dayType: string } }
    }
    expect(summary.demandProfiles.sample.dayType).toBe('holiday')
  })

  test('follows the Europe/Oslo clock across both daylight-saving changes', () => {
    const profile: GridDemandProfileDefinition = winter.model.demandProfiles[0]!
    const hours = Float64Array.from([...profile.weekday, ...profile.weekend])
    const factorAt = (at: string): number => {
      const factors = new Float64Array(1)
      evaluateDemandProfiles(hours, 1, osloLocalMs(Date.parse(at)), factors)
      return factors[0]!
    }
    // Sunday 2026-03-29: 01:59 CET is followed by 03:00 CEST; 02:00–03:00 does not occur.
    expect(factorAt('2026-03-29T00:30:00.000Z')).toBeCloseTo((profile.weekend[1]! + profile.weekend[2]!) / 2, 12)
    expect(factorAt('2026-03-29T01:00:00.000Z')).toBe(profile.weekend[3]!)
    // Sunday 2026-10-25: 02:00–03:00 occurs twice, in CEST and then in CET, with the same demand.
    expect(factorAt('2026-10-25T00:30:00.000Z')).toBe(factorAt('2026-10-25T01:30:00.000Z'))
    expect(factorAt('2026-10-25T02:00:00.000Z')).toBe(profile.weekend[3]!)
    // The summer Operating Point's hour is 06:00 CEST.
    const grid = createGridRuntimeInstance({ definition: summer, at: '2026-07-12T04:00:00.000Z' })
    expect(Math.round(totalDemandMw(grid))).toBe(10_493)
    const sundayNoon = elhubTotalMw({ point: summerPoint, dayType: 'weekend', hour: 12, reference: { dayType: 'weekend', hour: 6 } })
    expect(Math.abs(demandAt(grid, '2026-07-12T10:00:00.000Z') - sundayNoon)).toBeLessThan(1e-6 * sundayNoon)
  })

  test('is deterministic: the same definition digest and demand trajectory from separate compilers and runs', () => {
    const compiler = () => createGridDefinitionCompiler({ catalog: electricGridDefinitionCatalog, readModelFile: gridModelFileReader(new URL('../src/packs/electric-grid/models/', import.meta.url)), readAutomationFile: gridAutomationFileReader })
    const definition = { id: 'grid:demand-profiles', model: { ref: norwayGridModelRef }, operatingPoint: { ref: norwayWinterPeakOperatingPointRef }, automation: { ref: nordicFrequencyAutomationRef } }
    const [first, second] = [compiler().compile(definition), compiler().compile(definition)]
    expect(second.definitionDigest).toBe(first.definitionDigest)
    expect(second.definitionDigest).not.toBe(summer.definitionDigest)
    const trajectory = (compiled: CompiledGridDefinition): number[] => {
      const grid = createGridRuntimeInstance({ definition: compiled, at: '2026-01-12T07:00:00.000Z' })
      const demand: number[] = []
      for (let minute = 1; minute <= 30; minute += 1) {
        advanceGrid(grid, 60, new Date(Date.parse('2026-01-12T07:00:00.000Z') + minute * 60_000).toISOString() as IsoTimestamp)
        demand.push(totalDemandMw(grid))
      }
      return demand
    }
    expect(trajectory(second)).toEqual(trajectory(first))
  }, 60_000)

  test('publishes the profile series, day type and factor of a load, and the profile sources in the summary', () => {
    const grid = createGridRuntimeInstance({ definition: winter, at: '2026-01-12T07:00:00.000Z' })
    applyGridDemand(grid, Date.parse('2026-01-17T11:30:00.000Z'))
    const grids = new Map([[winter.gridId, grid]])
    const load = winter.model.loads.find(candidate => candidate.id.startsWith('load:0301-private-'))!
    const detail = gridAssetGetQuery.capability.output.parse(answerElectricGridQuery({ request: { capabilityId: gridAssetGetQuery.capability.id, input: { gridId: winter.gridId, assetId: load.id } }, grids })) as {
      readonly asset: { readonly state: { readonly profileFactor: number; readonly demandMw: number; readonly nominalDemandMw: number }; readonly demandProfile: { readonly definition: GridDemandProfileDefinition; readonly sample: { readonly localTime: string; readonly dayType: string } } }
    }
    expect(detail.asset.demandProfile.definition.series).toMatchObject({ season: 'winter', priceArea: 'NO1', group: 'private' })
    expect(detail.asset.demandProfile.sample).toMatchObject({ localTime: '12:30', dayType: 'weekend' })
    const weekend = detail.asset.demandProfile.definition.weekend
    expect(detail.asset.state.profileFactor).toBeCloseTo((weekend[12]! + weekend[13]!) / 2, 12)
    expect(detail.asset.state.demandMw).toBeCloseTo(detail.asset.state.nominalDemandMw * detail.asset.state.profileFactor, 9)
    const summary = gridSummaryQuery.capability.output.parse(answerElectricGridQuery({ request: { capabilityId: gridSummaryQuery.capability.id, input: { gridId: winter.gridId } }, grids })) as {
      readonly demandProfiles: { readonly sample: { readonly dayType: string }; readonly profiles: ReadonlyArray<{ readonly sources: ReadonlyArray<string>; readonly loadCount: number; readonly demandMw: number }> }
    }
    expect(summary.demandProfiles.sample.dayType).toBe('weekend')
    expect(summary.demandProfiles.profiles.every(profile => profile.sources.includes('electric-grid.norway.load-profiles') && profile.sources.includes('elhub:consumption-per-group-mba-hour'))).toBe(true)
    expect(summary.demandProfiles.profiles.reduce((sum, profile) => sum + profile.loadCount, 0)).toBe(winter.model.loads.length)
    expect(summary.demandProfiles.profiles.reduce((sum, profile) => sum + profile.demandMw, 0)).toBeCloseTo(totalDemandMw(grid), 6)
  })

  test('refuses an Operating Point hour outside its season week and a measured profile that is not 1 at its hour', () => {
    const loadProfiles = gridLoadProfiles(norwayGridModelRef)
    const atHour = (referenceHour: string) => ({ ...winterPoint, demand: { ...winterPoint.demand, referenceHour } })
    expect(() => compileGridModelV2(gridModelV2(norwayGridModelRef), atHour('2026-01-20T08:00:00+01:00'), loadProfiles))
      .toThrow('lies outside the winter profile week 2026-01-12–2026-01-19')
    expect(() => compileGridModelV2(gridModelV2(norwayGridModelRef), atHour('2026-01-12T08:30:00+01:00'), loadProfiles))
      .toThrow('is not a whole Europe/Oslo hour')
    const [profile, ...others] = winter.model.demandProfiles
    const shifted = { ...profile!, weekday: profile!.weekday.map(value => value * 1.01) }
    expect(() => compileGridModelIndex({ ...winter.model, demandProfiles: [shifted, ...others] })).toThrow(`${profile!.id} is 1.01 at its reference hour`)
    expect(() => compileGridModelIndex({ ...winter.model, loads: [{ ...winter.model.loads[0]!, demandProfileId: 'demand-profile:missing' }, ...winter.model.loads.slice(1)] }))
      .toThrow('follows unknown demand profile demand-profile:missing')
  })
})
