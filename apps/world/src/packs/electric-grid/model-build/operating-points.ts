import { loadDemandGroups, municipalityLoadGroups, priceAreas } from '../schemas/grid-ids.ts'
import type { GridGeneratorV2, GridModelV2 } from '../schemas/grid-model.ts'
import { gridExchangeBorderLabel, gridExchangeBordersOf, type GridOperatingPointV2 } from '../schemas/grid-operating-point.ts'
import type { GridReferenceHourDispatch } from '../schemas/grid-reference-dispatch.ts'
import { compareText } from '../topology/ids.ts'
import { ambientRatingRule, emergencyRule } from './electrical.ts'
import { roundTo } from './geo.ts'
import type { PriceAreaGroupMw } from './profiles.ts'

// Initial operating points of the Norway model. Each sets every price area and Elhub group to its
// metered demand in the Operating Point's hour, which the group's loads share in proportion to
// their reference demand. Each is dispatched to the measured national production and exchange of
// its hour (models/norway-reference-dispatch.json, ENTSO-E data):
// - HVDC links carry the measured flow of their neighbour country (several links to one country
//   share it in proportion to rating); the Nordic remainder takes the measured flow of each of its
//   AC borders (Svenska kraftnät per Swedish bidding-zone border, Energy-Charts for Finland).
// - Wind farms, run-of-river hydro and thermal units each produce the national measured output of
//   their kind in proportion to capacity (no per-unit or per-area production is published).
// - A run-of-river unit whose inflow share lies below its minimum stable loading cannot run on it
//   continuously: per price area and minimum, the largest such units that stay at or above it run on
//   the group's inflow; the others stand (spilling or holding their pondage), and what no unit can
//   turbine falls to storage hydro.
// - Storage hydro (reservoir and pumped) closes each AC island's balance of demand plus export:
//   every unit runs at the island's common loading when that is at least the minimum stable share,
//   else the largest units are committed, as many as keep the loading at or above it.
// Network losses are not scheduled: the runtime's slack covers them. Islands without load start
// with their generators offline. Overhead lines are rated at winter air (ambientRatingRule): the
// summer Operating Point gives each its rating at summer air in branchRatings.

export const dispatchRule = {
  id: 'reference-hour-dispatch',
  /** Lowest loading of committed storage hydro, share of capacity (unit rule minimumStableShare, generator-rules.ts). */
  minimumStorageLoading: 0.3,
  source: 'ENTSO-E actual generation per production type and cross-border physical flows for Norway at the reference hour (Energy-Charts API, CC BY 4.0); national values shared in proportion to capacity',
} as const

type GeneratorState = NonNullable<GridOperatingPointV2['generatorStates']>[number]
type HvdcSchedule = NonNullable<GridOperatingPointV2['hvdcSchedules']>[number]
type ExchangeSchedule = NonNullable<GridOperatingPointV2['externalExchangeSchedules']>[number]

const neighbourOfArea: Readonly<Record<string, keyof GridReferenceHourDispatch['importMw']>> = {
  SE1: 'SE', SE2: 'SE', SE3: 'SE', FI: 'FI', DK1: 'DK', DE: 'DE', NL: 'NL', GB: 'GB',
}

export interface ReferenceSchedules {
  readonly hvdc: ReadonlyArray<HvdcSchedule>
  readonly exchange: ReadonlyArray<ExchangeSchedule>
  /** Export of each HVDC link's Norwegian converter bus, MW (positive leaves Norway). */
  readonly hvdcExportMw: ReadonlyMap<string, number>
  /** Export through each synchronous external system's boundary buses (the sum of its borders), MW. */
  readonly exchangeExportMw: ReadonlyMap<string, number>
  /** Links whose measured share exceeds their rating and is scheduled at the rating. */
  readonly limited: ReadonlyArray<{ readonly linkId: string; readonly measuredMw: number; readonly ratingMw: number }>
}

/** Constant schedules at the measured flows of the reference hour. */
export const referenceSchedules = (model: GridModelV2, hour: GridReferenceHourDispatch): ReferenceSchedules => {
  const areaOfBus = new Map(model.buses.flatMap(bus => bus.externalArea === undefined ? [] : [[bus.id, bus.externalArea] as const]))
  const neighbourOfLink = (link: GridModelV2['hvdcLinks'][number]): keyof GridReferenceHourDispatch['importMw'] => {
    const area = areaOfBus.get(link.toBusId)
    if (area === undefined) throw new Error(`${link.id} does not end at a boundary bus`)
    return neighbourOfArea[area]!
  }
  const linksByNeighbour = new Map<string, GridModelV2['hvdcLinks'][number][]>()
  for (const link of model.hvdcLinks) linksByNeighbour.set(neighbourOfLink(link), [...(linksByNeighbour.get(neighbourOfLink(link)) ?? []), link])
  const hvdcExportMw = new Map<string, number>()
  const limited: Array<{ linkId: string; measuredMw: number; ratingMw: number }> = []
  for (const [neighbour, links] of linksByNeighbour) {
    const rating = links.reduce((sum, link) => sum + link.ratingMw, 0)
    for (const link of links) {
      const measuredMw = roundTo(-hour.importMw[neighbour as keyof GridReferenceHourDispatch['importMw']] * link.ratingMw / rating, 1)
      // The border measurement includes the sending converter's losses; a schedule stays within the link rating.
      if (Math.abs(measuredMw) > link.ratingMw) limited.push({ linkId: link.id, measuredMw, ratingMw: link.ratingMw })
      hvdcExportMw.set(link.id, Math.sign(measuredMw) * Math.min(Math.abs(measuredMw), link.ratingMw))
    }
  }
  const exchangeExportMw = new Map<string, number>()
  const exchange: ExchangeSchedule[] = []
  const bordersOf = gridExchangeBordersOf(model)
  const measuredBorders = new Map(hour.acBorderImportMw.map(border => [gridExchangeBorderLabel(border), border.importMw]))
  const scheduledBorders = new Set<string>()
  for (const system of model.externalSystems.filter(candidate => candidate.synchronous)) {
    const neighbours = [...new Set(system.boundaryBusIds.map(busId => neighbourOfArea[areaOfBus.get(busId)!]!))].sort(compareText)
    if (neighbours.some(neighbour => linksByNeighbour.has(neighbour))) throw new Error(`${system.id}: a synchronous neighbour is also reached by HVDC`)
    const borders = bordersOf.get(system.id)!.map(border => {
      const label = gridExchangeBorderLabel(border)
      const importMw = measuredBorders.get(label)
      if (importMw === undefined) throw new Error(`${system.id}: no measured flow on its AC border ${label}`)
      scheduledBorders.add(label)
      return { priceArea: border.priceArea, externalArea: border.externalArea, exportMw: roundTo(-importMw, 1) }
    })
    exchangeExportMw.set(system.id, roundTo(borders.reduce((sum, border) => sum + border.exportMw, 0), 1))
    exchange.push({ assetId: system.id, timeZone: 'Europe/Oslo', points: [{ localTime: '00:00', borders }] })
  }
  const unscheduled = [...measuredBorders.keys()].filter(label => !scheduledBorders.has(label))
  if (unscheduled.length > 0) throw new Error(`measured AC border flows on ${unscheduled.join(', ')} have no border of a synchronous external system in the model`)
  const covered = new Set([...linksByNeighbour.keys(), ...model.externalSystems.filter(system => system.synchronous)
    .flatMap(system => system.boundaryBusIds.map(busId => neighbourOfArea[areaOfBus.get(busId)!]!))])
  const missing = (Object.keys(hour.importMw) as Array<keyof GridReferenceHourDispatch['importMw']>).filter(neighbour => !covered.has(neighbour) && hour.importMw[neighbour] !== 0)
  if (missing.length > 0) throw new Error(`measured exchange with ${missing.join(', ')} has no link or external system in the model`)
  return {
    hvdc: model.hvdcLinks.map(link => ({ assetId: link.id, timeZone: 'Europe/Oslo' as const, points: [{ localTime: '00:00', transferMw: hvdcExportMw.get(link.id)! }] })),
    exchange,
    hvdcExportMw,
    exchangeExportMw,
    limited,
  }
}

const islandsOf = (model: GridModelV2): ReadonlyArray<ReadonlySet<string>> => {
  const neighbours = new Map<string, string[]>(model.buses.filter(bus => bus.kind !== 'boundary').map(bus => [bus.id, []]))
  for (const branch of model.branches) {
    if (!neighbours.has(branch.fromBusId) || !neighbours.has(branch.toBusId)) continue
    neighbours.get(branch.fromBusId)!.push(branch.toBusId)
    neighbours.get(branch.toBusId)!.push(branch.fromBusId)
  }
  const seen = new Set<string>()
  const islands: Set<string>[] = []
  for (const start of [...neighbours.keys()].sort(compareText)) {
    if (seen.has(start)) continue
    const island = new Set<string>([start])
    const stack = [start]
    seen.add(start)
    while (stack.length > 0) {
      for (const next of neighbours.get(stack.pop()!)!) {
        if (seen.has(next)) continue
        seen.add(next)
        island.add(next)
        stack.push(next)
      }
    }
    islands.push(island)
  }
  return islands
}

type Family = 'wind' | 'run-of-river' | 'thermal' | 'storage'

const familyOf = (generator: GridGeneratorV2): Family => {
  switch (generator.kind) {
    case 'wind': return 'wind'
    case 'hydro-run-of-river': return 'run-of-river'
    case 'thermal': return 'thermal'
    case 'hydro-reservoir':
    case 'hydro-pumped': return 'storage'
    case 'solar':
    case 'nuclear': throw new Error(`${generator.id}: no measured ${generator.kind} output to dispatch it from`)
  }
}

/** Measured national output share of capacity per non-storage family, capped at full output. */
const measuredShares = (model: GridModelV2, hour: GridReferenceHourDispatch): Readonly<Record<Exclude<Family, 'storage'>, number>> => {
  const capacity = (family: Family): number => model.generators.filter(generator => familyOf(generator) === family).reduce((sum, generator) => sum + generator.capacityMw, 0)
  const share = (family: Exclude<Family, 'storage'>, measuredMw: number): number => {
    if (measuredMw === 0) return 0
    const total = capacity(family)
    if (total === 0) throw new Error(`the reference hour measures ${measuredMw} MW of ${family} but the model has none`)
    return Math.min(1, measuredMw / total)
  }
  return {
    wind: share('wind', hour.generationMw.windOnshore + hour.generationMw.windOffshore),
    'run-of-river': share('run-of-river', hour.generationMw.hydroRunOfRiver),
    thermal: share('thermal', hour.generationMw.fossilGas),
  }
}

/**
 * Run-of-river targets where an inflow share lies below a unit's minimum stable loading: per price
 * area and minimum share, the largest units are committed while the group's inflow keeps each at
 * or above its minimum, and run at the group's common loading; the rest get 0. Units at or above their
 * minimum are absent from the result and keep their inflow.
 */
const commitRunOfRiver = (units: ReadonlyArray<GridGeneratorV2>, inflowMw: (generator: GridGeneratorV2) => number): ReadonlyMap<string, number> => {
  const groups = new Map<string, GridGeneratorV2[]>()
  for (const unit of units) {
    if (inflowMw(unit) >= unit.minimumStableMw) continue
    const key = `${unit.priceArea}|${unit.minimumStableMw / unit.capacityMw}`
    groups.set(key, [...(groups.get(key) ?? []), unit])
  }
  const targets = new Map<string, number>()
  for (const [key, members] of [...groups].sort(([left], [right]) => compareText(left, right))) {
    const share = Number(key.split('|')[1])
    const groupInflowMw = members.reduce((sum, unit) => sum + inflowMw(unit), 0)
    const committed: GridGeneratorV2[] = []
    let committedMw = 0
    for (const unit of [...members].sort((left, right) => right.capacityMw - left.capacityMw || compareText(left.id, right.id))) {
      // Largest first, stopping at the first that does not fit: the next unit is no larger than the
      // committed capacity, so the common loading stays below twice the minimum share (≤ 1).
      if ((committedMw + unit.capacityMw) * share > groupInflowMw) break
      committed.push(unit)
      committedMw += unit.capacityMw
    }
    const loading = committedMw === 0 ? 0 : groupInflowMw / committedMw
    for (const unit of members) targets.set(unit.id, committed.includes(unit) ? unit.capacityMw * loading : 0)
  }
  return targets
}

export const dispatchGenerators = (
  model: GridModelV2,
  demandMwOf: (load: GridModelV2['loads'][number]) => number,
  hour: GridReferenceHourDispatch,
  schedules: Pick<ReferenceSchedules, 'hvdcExportMw' | 'exchangeExportMw'>,
): ReadonlyArray<GeneratorState> => {
  const shares = measuredShares(model, hour)
  const boundaryOf = new Map<string, string[]>()
  for (const branch of model.branches) {
    for (const [own, other] of [[branch.fromBusId, branch.toBusId], [branch.toBusId, branch.fromBusId]] as const) {
      const system = model.externalSystems.find(candidate => candidate.synchronous && candidate.boundaryBusIds.includes(other))
      if (system !== undefined) boundaryOf.set(own, [...(boundaryOf.get(own) ?? []), system.id])
    }
  }
  const states: GeneratorState[] = []
  const exchangeIslands = new Map<string, number>()
  for (const island of islandsOf(model)) {
    const generators = model.generators.filter(generator => island.has(generator.busId))
    const demandMw = model.loads.filter(load => island.has(load.busId)).reduce((sum, load) => sum + demandMwOf(load), 0)
    const hvdcExport = model.hvdcLinks.filter(link => island.has(link.fromBusId)).reduce((sum, link) => sum + schedules.hvdcExportMw.get(link.id)!, 0)
    const systems = [...new Set([...island].flatMap(busId => boundaryOf.get(busId) ?? []))]
    for (const system of systems) exchangeIslands.set(system, (exchangeIslands.get(system) ?? 0) + 1)
    const exchangeExport = systems.reduce((sum, system) => sum + schedules.exchangeExportMw.get(system)!, 0)
    if (demandMw === 0) {
      if (hvdcExport !== 0 || exchangeExport !== 0) throw new Error(`an island of ${island.size} buses without load carries scheduled exchange`)
      for (const generator of generators) states.push({ assetId: generator.id, state: 'offline', availableMw: generator.capacityMw, targetMw: 0 })
      continue
    }
    const balanceMw = demandMw + hvdcExport + exchangeExport
    const measured = generators.filter(generator => familyOf(generator) !== 'storage')
    const storage = generators.filter(generator => familyOf(generator) === 'storage')
    const measuredMw = (generator: GridGeneratorV2): number => generator.capacityMw * shares[familyOf(generator) as Exclude<Family, 'storage'>]
    const measuredTotal = measured.reduce((sum, generator) => sum + measuredMw(generator), 0)
    // Measured output beyond the island's balance is curtailed in proportion.
    const curtail = measuredTotal > balanceMw ? balanceMw / measuredTotal : 1
    const runOfRiver = commitRunOfRiver(measured.filter(generator => generator.kind === 'hydro-run-of-river'), generator => measuredMw(generator) * curtail)
    let turbinedMw = 0
    for (const generator of measured) {
      const targetMw = roundTo(runOfRiver.get(generator.id) ?? measuredMw(generator) * curtail, 3)
      turbinedMw += targetMw
      states.push(targetMw === 0 && runOfRiver.has(generator.id)
        ? { assetId: generator.id, state: 'offline', availableMw: generator.capacityMw, targetMw: 0 }
        : { assetId: generator.id, state: 'online', availableMw: generator.kind === 'wind' ? roundTo(measuredMw(generator), 3) : generator.capacityMw, targetMw })
    }
    const residualMw = balanceMw - turbinedMw
    const capacity = storage.reduce((sum, generator) => sum + generator.capacityMw, 0)
    if (residualMw > capacity) throw new Error(`island of ${island.size} buses: storage hydro (${roundTo(capacity, 1)} MW) cannot cover the residual demand ${roundTo(residualMw, 1)} MW`)
    const ordered = [...storage].sort((left, right) => right.capacityMw - left.capacityMw || compareText(left.id, right.id))
    let committedMw = 0
    const committed = new Set<string>()
    for (const generator of ordered) {
      // Commit while the residual covers the next unit at the minimum stable loading.
      if (committedMw >= residualMw && residualMw / (committedMw + generator.capacityMw) < dispatchRule.minimumStorageLoading) break
      committed.add(generator.id)
      committedMw += generator.capacityMw
    }
    const loading = committedMw === 0 ? 0 : residualMw / committedMw
    for (const generator of storage) {
      if (!committed.has(generator.id)) {
        states.push({ assetId: generator.id, state: 'offline', availableMw: generator.capacityMw, targetMw: 0 })
        continue
      }
      const targetMw = roundTo(generator.capacityMw * loading, 3)
      if (targetMw < generator.minimumStableMw) throw new Error(`${generator.id}: dispatch ${targetMw} MW below its minimum stable ${generator.minimumStableMw} MW`)
      states.push({ assetId: generator.id, state: 'online', availableMw: generator.capacityMw, targetMw })
    }
  }
  for (const [system, count] of exchangeIslands) if (count > 1) throw new Error(`${system} ties into ${count} AC islands; its exchange cannot be assigned to one`)
  return states.sort((left, right) => compareText(left.assetId, right.assetId))
}

const describeHour = (hour: GridReferenceHourDispatch, schedules: ReferenceSchedules): string => {
  const exportMw = [...schedules.hvdcExportMw.values(), ...schedules.exchangeExportMw.values()].reduce((sum, value) => sum + value, 0)
  const limits = schedules.limited.map(entry => ` ${entry.linkId} measured ${entry.measuredMw} MW, scheduled at its ${entry.ratingMw} MW rating.`).join('')
  return `Dispatch (rule ${dispatchRule.id}): ENTSO-E measured ${roundTo(hour.generationMw.windOnshore + hour.generationMw.windOffshore, 0)} MW wind, ${roundTo(hour.generationMw.hydroRunOfRiver, 0)} MW run-of-river and ${roundTo(hour.generationMw.fossilGas, 0)} MW gas, shared by capacity (run-of-river units below their turbine's minimum stable loading committed per price area); HVDC links and each AC border of the Nordic exchange at the measured flows (net export ${roundTo(exportMw, 0)} MW); storage hydro closes the balance at one common loading; losses are left to the slack.${limits}`
}

/** Summer-air ratings of each line or sub-transmission equivalent rated lower than in the model, MW; the emergency rating follows the emergency rule. */
const summerBranchRatings = (model: GridModelV2, summerRatingMw: ReadonlyMap<string, number>): NonNullable<GridOperatingPointV2['branchRatings']> => model.branches.flatMap(branch => {
  const summerMw = summerRatingMw.get(branch.id)
  if (summerMw === undefined && branch.kind !== 'transformer') throw new Error(`${branch.id}: no summer rating`)
  if (summerMw === undefined || summerMw >= branch.ratingMw) return []
  return [{ assetId: branch.id, ratingMw: summerMw, emergencyRatingMw: Math.round(summerMw * emergencyRule.factor) }]
})

type ExternalSystemState = NonNullable<GridOperatingPointV2['externalSystemStates']>[number]

/** The Operating Point demand of each load: its share of its price area and group's metered demand. */
const loadDemandAt = (model: GridModelV2, metered: PriceAreaGroupMw): ((load: GridModelV2['loads'][number]) => number) => {
  const referenceMw = new Map<string, number>()
  const key = (load: GridModelV2['loads'][number]): string => `${load.priceArea}|${loadDemandGroups[load.kind]}`
  for (const load of model.loads) referenceMw.set(key(load), (referenceMw.get(key(load)) ?? 0) + load.referenceDemandMw)
  return load => load.referenceDemandMw * metered[load.priceArea][loadDemandGroups[load.kind]] / referenceMw.get(key(load))!
}

const nationalMw = (metered: PriceAreaGroupMw): number =>
  priceAreas.reduce((sum, area) => sum + municipalityLoadGroups.reduce((areaSum, group) => areaSum + metered[area][group], 0), 0)

/** The Operating Point's demand entry: the metered demand of each price area and group the model has loads in, in area then group order. */
const demandOf = (model: GridModelV2, season: 'winter' | 'summer', referenceHour: string, metered: PriceAreaGroupMw): GridOperatingPointV2['demand'] => {
  const used = new Set(model.loads.map(load => `${load.priceArea}|${loadDemandGroups[load.kind]}`))
  const priceAreaGroupMw = Object.fromEntries(priceAreas.flatMap(area => {
    const groups = municipalityLoadGroups.filter(group => used.has(`${area}|${group}`))
    return groups.length === 0 ? [] : [[area, Object.fromEntries(groups.map(group => [group, metered[area][group]]))]]
  }))
  return { season, referenceHour, priceAreaGroupMw }
}

export const buildOperatingPoints = (config: {
  readonly model: GridModelV2
  readonly compatibleModelRefs: ReadonlyArray<string>
  /** Elhub's metered demand of each price area and group in each Operating Point's hour, and its source id. */
  readonly meteredDemand: { readonly winter: PriceAreaGroupMw; readonly summer: PriceAreaGroupMw; readonly sourceId: string }
  readonly summerHour: string
  readonly summerStartUtc: string
  readonly winterStartUtc: string
  readonly dispatch: { readonly winterPeak: GridReferenceHourDispatch; readonly summerLow: GridReferenceHourDispatch }
  /** Summer-air rating of every line and sub-transmission equivalent, MW, by branch id. */
  readonly summerLineRatingMw: ReadonlyMap<string, number>
  /** Lines that normal operation keeps open (normally-open curations): both Operating Points start them open. */
  readonly normallyOpenBranchIds: ReadonlyArray<string>
  /** The synchronous equivalent's inertia and load per season, from the interconnector table's cases. */
  readonly externalSystemStates: { readonly winter: ReadonlyArray<ExternalSystemState>; readonly summer: ReadonlyArray<ExternalSystemState> }
}): { readonly winter: GridOperatingPointV2; readonly summer: GridOperatingPointV2 } => {
  const { model } = config
  const sameHour = (label: string, dispatch: GridReferenceHourDispatch, startUtc: string): void => {
    if (Date.parse(dispatch.startUtc) !== Date.parse(startUtc)) throw new Error(`reference dispatch ${label} starts ${dispatch.startUtc}, the Elhub reference hour ${startUtc}`)
  }
  sameHour('winterPeak', config.dispatch.winterPeak, config.winterStartUtc)
  sameHour('summerLow', config.dispatch.summerLow, config.summerStartUtc)
  const { meteredDemand } = config
  const winterDemandMw = loadDemandAt(model, meteredDemand.winter)
  const summerDemandMw = loadDemandAt(model, meteredDemand.summer)
  const demandText = (metered: PriceAreaGroupMw): string => `each price area and Elhub group at its metered demand (${meteredDemand.sourceId}; national ${roundTo(nationalMw(metered), 0)} MW), shared by its loads in proportion to their reference demand`
  // normally-open curations (normally-open.ts): lines in the model that normal operation keeps open.
  const normallyOpen = config.normallyOpenBranchIds.map(assetId => ({ assetId, state: 'open' as const }))
  const winterSchedules = referenceSchedules(model, config.dispatch.winterPeak)
  const summerSchedules = referenceSchedules(model, config.dispatch.summerLow)
  return {
    winter: {
      schemaVersion: 2,
      id: 'electric-grid.norway.winter-weekday-peak',
      title: 'Winter weekday peak',
      description: `Elhub reference hour ${model.referenceHour}: ${demandText(meteredDemand.winter)}. ${describeHour(config.dispatch.winterPeak, winterSchedules)} The Nordic remainder is at its winter-peak inertia and load.`,
      compatibleModelRefs: [...config.compatibleModelRefs],
      demand: demandOf(model, 'winter', model.referenceHour, meteredDemand.winter),
      loadScale: 1,
      generatorStates: [...dispatchGenerators(model, winterDemandMw, config.dispatch.winterPeak, winterSchedules)],
      branchStates: normallyOpen,
      hvdcSchedules: [...winterSchedules.hvdc],
      externalExchangeSchedules: [...winterSchedules.exchange],
      externalSystemStates: [...config.externalSystemStates.winter],
    },
    summer: {
      schemaVersion: 2,
      id: 'electric-grid.norway.summer-night-low',
      title: 'Summer night low',
      description: `Elhub summer low hour ${config.summerHour}: ${demandText(meteredDemand.summer)}. ${describeHour(config.dispatch.summerLow, summerSchedules)} branchRatings rate overhead lines at ${ambientRatingRule.summerAirC} °C air (rule ${ambientRatingRule.id}). The Nordic remainder is at its summer-low inertia and load.`,
      compatibleModelRefs: [...config.compatibleModelRefs],
      demand: demandOf(model, 'summer', config.summerHour, meteredDemand.summer),
      loadScale: 1,
      generatorStates: [...dispatchGenerators(model, summerDemandMw, config.dispatch.summerLow, summerSchedules)],
      branchStates: normallyOpen,
      hvdcSchedules: [...summerSchedules.hvdc],
      externalExchangeSchedules: [...summerSchedules.exchange],
      branchRatings: [...summerBranchRatings(model, config.summerLineRatingMw)],
      externalSystemStates: [...config.externalSystemStates.summer],
    },
  }
}
