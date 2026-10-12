import { loadDemandGroups, municipalityLoadGroups, priceAreas, type PriceArea } from '../schemas/grid-ids.ts'
import type { GridLoadProfiles } from '../schemas/grid-load-profile.ts'
import type { GridGeneratorV2, GridModelV2 } from '../schemas/grid-model.ts'
import { gridExchangeBorderLabel, gridExchangeBordersOf, type GridOperatingPointV2 } from '../schemas/grid-operating-point.ts'
import type { GridReferenceHourDispatch } from '../schemas/grid-reference-dispatch.ts'
import { compareText } from '../topology/ids.ts'
import { ambientRatingRule, emergencyRule } from './electrical.ts'
import { roundTo } from './geo.ts'
import { solveOperatingPointFlow } from './operating-point-flow.ts'
import type { PriceAreaGroupMw } from './profiles.ts'

// Initial operating points of the Norway model. Each sets every price area and Elhub group to its
// metered demand in the Operating Point's hour, which the group's loads share in proportion to
// their reference demand, and each price area's losses of the networks below 132 kV, which no
// meter sees (settleNetworkLosses). Each is dispatched to the measured production and exchange of
// its hour (models/norway-reference-dispatch.json):
// - HVDC links carry the measured flow of their neighbour country (several links to one country
//   share it in proportion to rating); the Nordic remainder takes the measured flow of each of its
//   AC borders (Svenska kraftnät per Swedish bidding-zone border, Energy-Charts for Finland).
// - Wind farms and thermal units produce their price area's measured output of their kind (Elhub
//   production per area and group) in proportion to capacity, at most their capacity.
// - Run-of-river hydro produces the national measured run-of-river output (ENTSO-E; no per-area
//   value is published) in proportion to capacity. A unit whose inflow share lies below its minimum
//   stable loading cannot run on it continuously: per price area and minimum, the largest such units
//   that stay at or above it run on the group's inflow; the others stand (spilling or holding their
//   pondage), and what no unit can turbine falls to storage hydro.
// - Storage hydro (reservoir and pumped) produces the rest of its price area's measured production
//   (all Elhub groups, so unmodelled solar, small thermal and other output too), every area's share
//   scaled by one factor that closes the AC island's balance of demand (with the losses below
//   132 kV) plus export. Within an area
//   every unit runs at the area's common loading when that is at least the minimum stable share,
//   else the largest units are committed, as many as keep the loading at or above it. What exceeds
//   an area's storage capacity runs on its run-of-river units, up to their capacity.
// The model's own branch losses are not scheduled: the runtime's slack covers them. Islands without load start
// with their generators offline. Overhead lines are rated at winter air (ambientRatingRule): the
// summer Operating Point gives each its rating at summer air in branchRatings.

export const dispatchRule = {
  id: 'reference-hour-dispatch',
  /** Lowest loading of committed storage hydro, share of capacity (unit rule minimumStableShare, generator-rules.ts). */
  minimumStorageLoading: 0.3,
  source: 'Elhub metered production per price area and group, ENTSO-E national run-of-river generation and cross-border physical flows (Energy-Charts API), Svenska kraftnät physical flows per bidding-zone border, at the reference hour (all CC BY 4.0); each area\'s values shared by its units in proportion to capacity',
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

/**
 * Measured output share of capacity of each non-storage family, capped at full output: wind and
 * thermal per price area (Elhub), run-of-river nationally (ENTSO-E).
 */
const measuredShareOf = (model: GridModelV2, hour: GridReferenceHourDispatch): ((generator: GridGeneratorV2) => number) => {
  const capacityOf = (family: Family, area?: PriceArea): number => model.generators
    .filter(generator => familyOf(generator) === family && (area === undefined || generator.priceArea === area))
    .reduce((sum, generator) => sum + generator.capacityMw, 0)
  const share = (measuredMw: number, capacityMw: number): number => capacityMw === 0 ? 0 : Math.min(1, measuredMw / capacityMw)
  const runOfRiverMw = hour.generationMw.hydroRunOfRiver
  if (runOfRiverMw > 0 && capacityOf('run-of-river') === 0) throw new Error(`the reference hour measures ${runOfRiverMw} MW of run-of-river but the model has none`)
  const runOfRiver = share(runOfRiverMw, capacityOf('run-of-river'))
  const byArea = new Map(priceAreas.map(area => [area, {
    wind: share(hour.areaProduction.mw[area].wind, capacityOf('wind', area)),
    thermal: share(hour.areaProduction.mw[area].thermal, capacityOf('thermal', area)),
  }]))
  return generator => {
    const family = familyOf(generator)
    if (family === 'storage') throw new Error(`${generator.id}: storage hydro closes the balance and has no measured share`)
    return family === 'run-of-river' ? runOfRiver : byArea.get(generator.priceArea)![family]
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

/** Storage hydro of one price area at `targetMw`: committed largest first while the common loading stays at or above the minimum stable share. */
const commitStorage = (storage: ReadonlyArray<GridGeneratorV2>, targetMw: number): ReadonlyArray<GeneratorState> => {
  const ordered = [...storage].sort((left, right) => right.capacityMw - left.capacityMw || compareText(left.id, right.id))
  let committedMw = 0
  const committed = new Set<string>()
  for (const generator of ordered) {
    // Commit while the target covers the next unit at the minimum stable loading.
    if (committedMw >= targetMw && targetMw / (committedMw + generator.capacityMw) < dispatchRule.minimumStorageLoading) break
    committed.add(generator.id)
    committedMw += generator.capacityMw
  }
  const loading = committedMw === 0 ? 0 : targetMw / committedMw
  return storage.map(generator => {
    if (!committed.has(generator.id)) return { assetId: generator.id, state: 'offline', availableMw: generator.capacityMw, targetMw: 0 }
    const unitMw = roundTo(generator.capacityMw * loading, 3)
    if (unitMw < generator.minimumStableMw) throw new Error(`${generator.id}: dispatch ${unitMw} MW below its minimum stable ${generator.minimumStableMw} MW`)
    return { assetId: generator.id, state: 'online', availableMw: generator.capacityMw, targetMw: unitMw }
  })
}

export interface DispatchResult {
  readonly states: ReadonlyArray<GeneratorState>
  /** Per AC island with load, in island order: the one factor that scales its areas' storage hydro targets to its balance. */
  readonly storageFactors: ReadonlyArray<number>
}

export const dispatchGenerators = (
  model: GridModelV2,
  demandMwOf: (load: GridModelV2['loads'][number]) => number,
  hour: GridReferenceHourDispatch,
  schedules: Pick<ReferenceSchedules, 'hvdcExportMw' | 'exchangeExportMw'>,
): DispatchResult => {
  const shareOf = measuredShareOf(model, hour)
  const boundaryOf = new Map<string, string[]>()
  for (const branch of model.branches) {
    for (const [own, other] of [[branch.fromBusId, branch.toBusId], [branch.toBusId, branch.fromBusId]] as const) {
      const system = model.externalSystems.find(candidate => candidate.synchronous && candidate.boundaryBusIds.includes(other))
      if (system !== undefined) boundaryOf.set(own, [...(boundaryOf.get(own) ?? []), system.id])
    }
  }
  const states: GeneratorState[] = []
  const exchangeIslands = new Map<string, number>()
  const islandOfArea = new Map<PriceArea, number>()
  const storageFactors: number[] = []
  islandsOf(model).forEach((island, islandIndex) => {
    const generators = model.generators.filter(generator => island.has(generator.busId))
    const demandMw = model.loads.filter(load => island.has(load.busId)).reduce((sum, load) => sum + demandMwOf(load), 0)
    const hvdcExport = model.hvdcLinks.filter(link => island.has(link.fromBusId)).reduce((sum, link) => sum + schedules.hvdcExportMw.get(link.id)!, 0)
    const systems = [...new Set([...island].flatMap(busId => boundaryOf.get(busId) ?? []))]
    for (const system of systems) exchangeIslands.set(system, (exchangeIslands.get(system) ?? 0) + 1)
    const exchangeExport = systems.reduce((sum, system) => sum + schedules.exchangeExportMw.get(system)!, 0)
    if (demandMw === 0) {
      if (hvdcExport !== 0 || exchangeExport !== 0) throw new Error(`an island of ${island.size} buses without load carries scheduled exchange`)
      for (const generator of generators) states.push({ assetId: generator.id, state: 'offline', availableMw: generator.capacityMw, targetMw: 0 })
      return
    }
    const areas = [...new Set(generators.map(generator => generator.priceArea))].sort(compareText)
    for (const area of areas) {
      const other = islandOfArea.get(area)
      if (other !== undefined) throw new Error(`price area ${area} has generators in two AC islands with load; its measured production cannot be assigned to one`)
      islandOfArea.set(area, islandIndex)
    }
    const balanceMw = demandMw + hvdcExport + exchangeExport
    const measured = generators.filter(generator => familyOf(generator) !== 'storage')
    const measuredMw = (generator: GridGeneratorV2): number => generator.capacityMw * shareOf(generator)
    const measuredTotal = measured.reduce((sum, generator) => sum + measuredMw(generator), 0)
    // Measured output beyond the island's balance is curtailed in proportion.
    const curtail = measuredTotal > balanceMw ? balanceMw / measuredTotal : 1
    const runOfRiver = commitRunOfRiver(measured.filter(generator => generator.kind === 'hydro-run-of-river'), generator => measuredMw(generator) * curtail)
    const measuredStates = new Map<string, GeneratorState>()
    for (const generator of measured) {
      const targetMw = roundTo(runOfRiver.get(generator.id) ?? measuredMw(generator) * curtail, 3)
      measuredStates.set(generator.id, targetMw === 0 && runOfRiver.has(generator.id)
        ? { assetId: generator.id, state: 'offline', availableMw: generator.capacityMw, targetMw: 0 }
        : { assetId: generator.id, state: 'online', availableMw: generator.kind === 'wind' ? roundTo(measuredMw(generator), 3) : generator.capacityMw, targetMw })
    }
    const turbinedMw = (area: PriceArea): number => measured.filter(generator => generator.priceArea === area).reduce((sum, generator) => sum + measuredStates.get(generator.id)!.targetMw!, 0)
    // Each area's storage hydro produces what its other units leave of its measured production; one factor scales them to the island's residual.
    const storageTargetMw = new Map(areas.map(area => {
      const producedMw = Object.values(hour.areaProduction.mw[area]).reduce((sum, value) => sum + value, 0)
      const targetMw = producedMw - turbinedMw(area)
      if (targetMw < 0) throw new Error(`price area ${area}: its wind, thermal and run-of-river units produce ${roundTo(turbinedMw(area), 1)} MW, more than its measured ${roundTo(producedMw, 1)} MW`)
      return [area, targetMw] as const
    }))
    const residualMw = balanceMw - areas.reduce((sum, area) => sum + turbinedMw(area), 0)
    const factor = residualMw / [...storageTargetMw.values()].reduce((sum, value) => sum + value, 0)
    storageFactors.push(factor)
    for (const area of areas) {
      const storage = generators.filter(generator => generator.priceArea === area && familyOf(generator) === 'storage')
      const capacityMw = storage.reduce((sum, generator) => sum + generator.capacityMw, 0)
      const areaTargetMw = storageTargetMw.get(area)! * factor
      // What the area's storage cannot produce runs on its online run-of-river units, by their headroom.
      const overflowMw = Math.max(0, areaTargetMw - capacityMw)
      if (overflowMw > 0) {
        const units = measured.filter(generator => generator.priceArea === area && generator.kind === 'hydro-run-of-river' && measuredStates.get(generator.id)!.state === 'online')
        const headroomMw = units.reduce((sum, generator) => sum + generator.capacityMw - measuredStates.get(generator.id)!.targetMw!, 0)
        if (overflowMw > headroomMw) throw new Error(`price area ${area}: storage hydro (${roundTo(capacityMw, 1)} MW) and the headroom of its run-of-river units (${roundTo(headroomMw, 1)} MW) cannot cover ${roundTo(areaTargetMw, 1)} MW`)
        for (const generator of units) {
          const state = measuredStates.get(generator.id)!
          measuredStates.set(generator.id, { ...state, targetMw: roundTo(state.targetMw! + overflowMw * (generator.capacityMw - state.targetMw!) / headroomMw, 3) })
        }
      }
      states.push(...commitStorage(storage, Math.min(areaTargetMw, capacityMw)))
    }
    states.push(...measuredStates.values())
  })
  for (const [system, count] of exchangeIslands) if (count > 1) throw new Error(`${system} ties into ${count} AC islands; its exchange cannot be assigned to one`)
  return { states: states.sort((left, right) => compareText(left.assetId, right.assetId)), storageFactors }
}

const describeHour = (hour: GridReferenceHourDispatch, schedules: ReferenceSchedules, dispatch: DispatchResult): string => {
  const exportMw = [...schedules.hvdcExportMw.values(), ...schedules.exchangeExportMw.values()].reduce((sum, value) => sum + value, 0)
  const limits = schedules.limited.map(entry => ` ${entry.linkId} measured ${entry.measuredMw} MW, scheduled at its ${entry.ratingMw} MW rating.`).join('')
  const producedMw = priceAreas.reduce((sum, area) => sum + Object.values(hour.areaProduction.mw[area]).reduce((total, value) => total + value, 0), 0)
  const factors = dispatch.storageFactors.map(factor => roundTo(factor, 3)).join(', ')
  return `Dispatch (rule ${dispatchRule.id}): Elhub measured ${roundTo(producedMw, 0)} MW of production by price area; each area's wind farms and thermal units run at its measured output of their kind and run-of-river at ENTSO-E's national ${roundTo(hour.generationMw.hydroRunOfRiver, 0)} MW, shared by capacity (run-of-river units below their turbine's minimum stable loading committed per price area); storage hydro produces the rest of each area's measured production, scaled by ${factors} to close the balance of demand and its losses below 132 kV plus export; HVDC links and each AC border of the Nordic exchange at the measured flows (net export ${roundTo(exportMw, 0)} MW); losses are left to the slack.${limits}`
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

/** The Operating Point's demand entry: the metered demand of each price area and group the model has loads in, in area then group order, and each such area's losses below 132 kV. */
const demandOf = (model: GridModelV2, season: 'winter' | 'summer', referenceHour: string, metered: PriceAreaGroupMw, networkLossMw: AreaLossMw): GridOperatingPointV2['demand'] => {
  const used = new Set(model.loads.map(load => `${load.priceArea}|${loadDemandGroups[load.kind]}`))
  const areas = priceAreas.filter(area => municipalityLoadGroups.some(group => used.has(`${area}|${group}`)))
  const priceAreaGroupMw = Object.fromEntries(areas.map(area =>
    [area, Object.fromEntries(municipalityLoadGroups.filter(group => used.has(`${area}|${group}`)).map(group => [group, metered[area][group]]))]))
  return { season, referenceHour, priceAreaGroupMw, networkLossMw: Object.fromEntries(areas.map(area => [area, networkLossMw.get(area)!])) }
}

type AreaLossMw = ReadonlyMap<PriceArea, number>

export const networkLossRule = {
  id: 'network-losses-below-132kv',
  /** The fixed point ends once no price area's losses move by more than this between passes (MW). */
  toleranceMw: 0.05,
  maximumPasses: 8,
  source: 'Elhub production and consumption per price area and Energy-Charts (ENTSO-E) cross-border physical flows at the reference hour, less the model\'s own AC branch losses at its Operating Point; shared by price area in proportion to metered consumption, as no openly licensed internal border flows give each area\'s net position',
} as const

/**
 * The losses of the networks below 132 kV at the reference hour, per price area: what the measured
 * production leaves after the metered consumption, the measured net export and the model's own
 * branch losses (all ≥ 132 kV) at the Operating Point, shared by consumption. The model's losses
 * depend on the flows, the flows on the dispatch and the dispatch on these losses: they are found
 * as a fixed point, every pass solving the Operating Point's AC load flow.
 */
const settleNetworkLosses = (config: {
  readonly model: GridModelV2
  readonly profiles: GridLoadProfiles
  readonly hour: GridReferenceHourDispatch
  readonly metered: PriceAreaGroupMw
  readonly operatingPointWith: (networkLossMw: AreaLossMw) => GridOperatingPointV2
}): { readonly operatingPoint: GridOperatingPointV2; readonly networkLossMw: AreaLossMw; readonly nationalMw: number; readonly modelLossMw: number } => {
  const areas = [...new Set(config.model.loads.map(load => load.priceArea))].sort(compareText)
  const areaConsumedMw = (area: PriceArea): number => municipalityLoadGroups.reduce((sum, group) => sum + config.metered[area][group], 0)
  const consumedMw = areas.reduce((sum, area) => sum + areaConsumedMw(area), 0)
  const producedMw = priceAreas.reduce((sum, area) => sum + Object.values(config.hour.areaProduction.mw[area]).reduce((total, value) => total + value, 0), 0)
  const exportedMw = -Object.values(config.hour.importMw).reduce((sum, value) => sum + value, 0)
  let losses: AreaLossMw = new Map(areas.map(area => [area, 0]))
  for (let pass = 1; pass <= networkLossRule.maximumPasses; pass += 1) {
    const operatingPoint = config.operatingPointWith(losses)
    const flow = solveOperatingPointFlow(config.model, operatingPoint, config.profiles, { tolerancePu: 1e-6, maximumIterations: 100 })
    const failed = flow.islands.filter(island => !island.outcome.converged)
    if (failed.length > 0) throw new Error(`${operatingPoint.id}: the AC load flow of ${failed.length} islands did not converge, so the model's own losses are unknown`)
    let modelLossMw = 0
    for (let index = 0; index < flow.branches.length; index += 1) modelLossMw += flow.state.branchFromActiveMw[index]! + flow.state.branchToActiveMw[index]!
    const nationalMw = producedMw - consumedMw - exportedMw - modelLossMw
    if (!(nationalMw >= 0)) throw new Error(`${operatingPoint.id}: measured production ${roundTo(producedMw, 1)} MW leaves no losses below 132 kV after consumption ${roundTo(consumedMw, 1)} MW, net export ${roundTo(exportedMw, 1)} MW and the model's ${roundTo(modelLossMw, 1)} MW`)
    const next: AreaLossMw = new Map(areas.map(area => [area, roundTo(nationalMw * areaConsumedMw(area) / consumedMw, 1)]))
    if (areas.every(area => Math.abs(next.get(area)! - losses.get(area)!) <= networkLossRule.toleranceMw)) return { operatingPoint, networkLossMw: losses, nationalMw: [...losses.values()].reduce((sum, value) => sum + value, 0), modelLossMw }
    losses = next
  }
  throw new Error(`the losses below 132 kV did not settle within ${networkLossRule.maximumPasses} passes`)
}

/** How the losses below 132 kV were found, and how far the measured national production they rest on is certain. */
const describeLosses = (hour: GridReferenceHourDispatch, consumedMw: number, settled: { readonly nationalMw: number; readonly modelLossMw: number }): string => {
  const elhubMw = priceAreas.reduce((sum, area) => sum + Object.values(hour.areaProduction.mw[area]).reduce((total, value) => total + value, 0), 0)
  const generation = hour.generationMw
  const entsoeMw = generation.hydroRunOfRiver + generation.hydroReservoir + (generation.hydroPumpedStorage ?? 0) + generation.windOnshore + generation.windOffshore + generation.fossilGas + generation.other
  const pumped = generation.hydroPumpedStorage === null ? ', which publishes no pumped storage for the hour' : ''
  return `Each load also draws its share of its price area's losses below 132 kV (rule ${networkLossRule.id}): ${roundTo(settled.nationalMw, 0)} MW nationally, ${roundTo(100 * settled.nationalMw / consumedMw, 1)} % of metered demand, as Elhub's measured production less consumption, the measured net export and the model's own ${roundTo(settled.modelLossMw, 0)} MW of branch losses at this Operating Point, shared by price area in proportion to consumption; it is as uncertain as the measured production, ${roundTo(Math.abs(elhubMw - entsoeMw), 0)} MW apart in Elhub and ENTSO-E${pumped}.`
}

export const buildOperatingPoints = (config: {
  readonly model: GridModelV2
  readonly compatibleModelRefs: ReadonlyArray<string>
  /** The model's Load Profiles: each pass of the network-loss fixed point solves the Operating Point's AC load flow. */
  readonly profiles: GridLoadProfiles
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
  const demandText = (metered: PriceAreaGroupMw): string => `each price area and Elhub group at its metered demand (${meteredDemand.sourceId}; national ${roundTo(nationalMw(metered), 0)} MW), shared by its loads in proportion to their reference demand`
  // normally-open curations (normally-open.ts): lines in the model that normal operation keeps open.
  const normallyOpen = config.normallyOpenBranchIds.map(assetId => ({ assetId, state: 'open' as const }))
  /** A load's Operating Point demand plus its share of its area's losses below 132 kV, as compile-v2 shares them. */
  const demandWithLossesAt = (metered: PriceAreaGroupMw, networkLossMw: AreaLossMw): ((load: GridModelV2['loads'][number]) => number) => {
    const demandMw = loadDemandAt(model, metered)
    const areaDemandMw = new Map<string, number>()
    for (const load of model.loads) areaDemandMw.set(load.priceArea, (areaDemandMw.get(load.priceArea) ?? 0) + demandMw(load))
    return load => demandMw(load) * (1 + networkLossMw.get(load.priceArea)! / areaDemandMw.get(load.priceArea)!)
  }
  const season = (spec: {
    readonly id: string
    readonly title: string
    readonly name: 'winter' | 'summer'
    readonly referenceHour: string
    readonly hour: GridReferenceHourDispatch
    readonly metered: PriceAreaGroupMw
    readonly lead: string
    readonly tail: string
    readonly extra: Pick<GridOperatingPointV2, 'branchRatings'>
  }): GridOperatingPointV2 => {
    const schedules = referenceSchedules(model, spec.hour)
    const operatingPointWith = (networkLossMw: AreaLossMw): GridOperatingPointV2 => ({
      schemaVersion: 2,
      id: spec.id,
      title: spec.title,
      description: '',
      compatibleModelRefs: [...config.compatibleModelRefs],
      demand: demandOf(model, spec.name, spec.referenceHour, spec.metered, networkLossMw),
      loadScale: 1,
      generatorStates: [...dispatchGenerators(model, demandWithLossesAt(spec.metered, networkLossMw), spec.hour, schedules).states],
      branchStates: normallyOpen,
      hvdcSchedules: [...schedules.hvdc],
      externalExchangeSchedules: [...schedules.exchange],
      ...spec.extra,
      externalSystemStates: [...config.externalSystemStates[spec.name]],
    })
    const settled = settleNetworkLosses({ model, profiles: config.profiles, hour: spec.hour, metered: spec.metered, operatingPointWith })
    const dispatch = dispatchGenerators(model, demandWithLossesAt(spec.metered, settled.networkLossMw), spec.hour, schedules)
    return {
      ...settled.operatingPoint,
      description: `${spec.lead}: ${demandText(spec.metered)}. ${describeLosses(spec.hour, nationalMw(spec.metered), settled)} ${describeHour(spec.hour, schedules, dispatch)} ${spec.tail}`,
    }
  }
  return {
    winter: season({
      id: 'electric-grid.norway.winter-weekday-peak',
      title: 'Winter weekday peak',
      name: 'winter',
      referenceHour: model.referenceHour,
      hour: config.dispatch.winterPeak,
      metered: meteredDemand.winter,
      lead: `Elhub reference hour ${model.referenceHour}`,
      tail: 'The Nordic remainder is at its winter-peak inertia and load.',
      extra: {},
    }),
    summer: season({
      id: 'electric-grid.norway.summer-night-low',
      title: 'Summer night low',
      name: 'summer',
      referenceHour: config.summerHour,
      hour: config.dispatch.summerLow,
      metered: meteredDemand.summer,
      lead: `Elhub summer low hour ${config.summerHour}`,
      tail: `branchRatings rate overhead lines at ${ambientRatingRule.summerAirC} °C air (rule ${ambientRatingRule.id}). The Nordic remainder is at its summer-low inertia and load.`,
      extra: { branchRatings: [...summerBranchRatings(model, config.summerLineRatingMw)] },
    }),
  }
}
