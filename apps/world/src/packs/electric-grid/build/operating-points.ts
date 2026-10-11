import { priceAreas, type PriceArea } from '../schemas/grid-ids.ts'
import type { GridGeneratorV2, GridModelV2 } from '../schemas/grid-model.ts'
import type { GridOperatingPointV2 } from '../schemas/grid-operating-point.ts'
import type { GridReferenceHourDispatch } from '../schemas/grid-reference-dispatch.ts'
import { compareText } from '../topology/ids.ts'
import { ambientRatingRule } from './electrical.ts'
import { roundTo } from './geo.ts'

// Initial operating points of the Norway model, dispatched to the measured national production
// and exchange of their reference hour (models/norway-reference-dispatch.json, ENTSO-E data):
// - HVDC links carry the measured flow of their neighbour country (several links to one country
//   share it in proportion to rating); the Nordic remainder takes the Swedish and Finnish exchange.
// - Wind farms, run-of-river hydro and thermal units each produce the national measured output of
//   their kind in proportion to capacity (no per-unit or per-area production is published).
// - Storage hydro (reservoir and pumped) closes each AC island's balance of demand plus export:
//   every unit runs at the island's common loading when that is at least the minimum stable share,
//   else the largest units are committed, as many as keep the loading at or above it.
// Network losses are not scheduled: the runtime's slack covers them. Islands without load start
// with their generators offline. Overhead lines are rated at winter air (ambientRatingRule): the
// summer Operating Point derates each to its rating at summer air.

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
  /** Export through each synchronous external system's boundary buses, MW. */
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
  for (const system of model.externalSystems.filter(candidate => candidate.synchronous)) {
    const neighbours = [...new Set(system.boundaryBusIds.map(busId => neighbourOfArea[areaOfBus.get(busId)!]!))].sort(compareText)
    if (neighbours.some(neighbour => linksByNeighbour.has(neighbour))) throw new Error(`${system.id}: a synchronous neighbour is also reached by HVDC`)
    exchangeExportMw.set(system.id, roundTo(-neighbours.reduce((sum, neighbour) => sum + hour.importMw[neighbour as keyof GridReferenceHourDispatch['importMw']], 0), 1))
  }
  const covered = new Set([...linksByNeighbour.keys(), ...model.externalSystems.filter(system => system.synchronous)
    .flatMap(system => system.boundaryBusIds.map(busId => neighbourOfArea[areaOfBus.get(busId)!]!))])
  const missing = (Object.keys(hour.importMw) as Array<keyof GridReferenceHourDispatch['importMw']>).filter(neighbour => !covered.has(neighbour) && hour.importMw[neighbour] !== 0)
  if (missing.length > 0) throw new Error(`measured exchange with ${missing.join(', ')} has no link or external system in the model`)
  return {
    hvdc: model.hvdcLinks.map(link => ({ assetId: link.id, timeZone: 'Europe/Oslo' as const, points: [{ localTime: '00:00', transferMw: hvdcExportMw.get(link.id)! }] })),
    exchange: model.externalSystems.filter(system => system.synchronous)
      .map(system => ({ assetId: system.id, timeZone: 'Europe/Oslo' as const, points: [{ localTime: '00:00', exportMw: exchangeExportMw.get(system.id)! }] })),
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
    for (const generator of measured) {
      const targetMw = roundTo(measuredMw(generator) * curtail, 3)
      states.push({ assetId: generator.id, state: 'online', availableMw: generator.kind === 'wind' ? roundTo(measuredMw(generator), 3) : generator.capacityMw, targetMw })
    }
    const residualMw = balanceMw - measuredTotal * curtail
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
  return `Dispatch (rule ${dispatchRule.id}): ENTSO-E measured ${roundTo(hour.generationMw.windOnshore + hour.generationMw.windOffshore, 0)} MW wind, ${roundTo(hour.generationMw.hydroRunOfRiver, 0)} MW run-of-river and ${roundTo(hour.generationMw.fossilGas, 0)} MW gas, shared by capacity; HVDC links and the Nordic exchange at the measured flows (net export ${roundTo(exportMw, 0)} MW); storage hydro closes the balance at one common loading; losses are left to the slack.${limits}`
}

/** Each line or sub-transmission equivalent rated lower at summer air, at that share of its model rating (3 decimals, rounded down). */
const summerLineDerates = (model: GridModelV2, summerRatingMw: ReadonlyMap<string, number>): NonNullable<GridOperatingPointV2['branchStates']> => model.branches.flatMap(branch => {
  const summerMw = summerRatingMw.get(branch.id)
  if (summerMw === undefined && branch.kind !== 'transformer') throw new Error(`${branch.id}: no summer rating`)
  if (summerMw === undefined) return []
  const availability = Math.floor(summerMw / branch.ratingMw * 1000) / 1000
  return availability < 1 ? [{ assetId: branch.id, state: 'closed' as const, availability }] : []
})

export const buildOperatingPoints = (config: {
  readonly model: GridModelV2
  readonly compatibleModelRefs: ReadonlyArray<string>
  readonly summerAreaMw: Readonly<Record<PriceArea, number>>
  readonly summerHour: string
  readonly summerStartUtc: string
  readonly winterStartUtc: string
  readonly dispatch: { readonly winterPeak: GridReferenceHourDispatch; readonly summerLow: GridReferenceHourDispatch }
  /** Summer-air rating of every line and sub-transmission equivalent, MW, by branch id. */
  readonly summerLineRatingMw: ReadonlyMap<string, number>
}): { readonly winter: GridOperatingPointV2; readonly summer: GridOperatingPointV2 } => {
  const { model } = config
  const sameHour = (label: string, dispatch: GridReferenceHourDispatch, startUtc: string): void => {
    if (Date.parse(dispatch.startUtc) !== Date.parse(startUtc)) throw new Error(`reference dispatch ${label} starts ${dispatch.startUtc}, the Elhub reference hour ${startUtc}`)
  }
  sameHour('winterPeak', config.dispatch.winterPeak, config.winterStartUtc)
  sameHour('summerLow', config.dispatch.summerLow, config.summerStartUtc)
  const areaMw = (area: PriceArea): number => model.loads.filter(load => load.priceArea === area).reduce((sum, load) => sum + load.referenceDemandMw, 0)
  const summerScale = Object.fromEntries(priceAreas.map(area => [area, roundTo(config.summerAreaMw[area] / areaMw(area), 6)])) as Record<PriceArea, number>
  const winterSchedules = referenceSchedules(model, config.dispatch.winterPeak)
  const summerSchedules = referenceSchedules(model, config.dispatch.summerLow)
  return {
    winter: {
      schemaVersion: 2,
      id: 'electric-grid.norway.winter-weekday-peak',
      title: 'Winter weekday peak',
      description: `Elhub reference hour ${model.referenceHour} (national ${roundTo(priceAreas.reduce((sum, area) => sum + areaMw(area), 0), 0)} MW located demand). ${describeHour(config.dispatch.winterPeak, winterSchedules)}`,
      compatibleModelRefs: [...config.compatibleModelRefs],
      loadScale: 1,
      generatorStates: [...dispatchGenerators(model, load => load.referenceDemandMw, config.dispatch.winterPeak, winterSchedules)],
      hvdcSchedules: [...winterSchedules.hvdc],
      externalExchangeSchedules: [...winterSchedules.exchange],
    },
    summer: {
      schemaVersion: 2,
      id: 'electric-grid.norway.summer-night-low',
      title: 'Summer night low',
      description: `Elhub summer low hour ${config.summerHour}: each price area's demand scaled to its metered total. ${describeHour(config.dispatch.summerLow, summerSchedules)} Overhead lines derated to their rating at ${ambientRatingRule.summerAirC} °C air (rule ${ambientRatingRule.id}). The Nordic remainder keeps the model's winter inertia and load; the Operating Point schema cannot override them.`,
      compatibleModelRefs: [...config.compatibleModelRefs],
      loadScale: 1,
      priceAreaDemandScale: summerScale,
      generatorStates: [...dispatchGenerators(model, load => load.referenceDemandMw * summerScale[load.priceArea], config.dispatch.summerLow, summerSchedules)],
      hvdcSchedules: [...summerSchedules.hvdc],
      externalExchangeSchedules: [...summerSchedules.exchange],
      branchStates: [...summerLineDerates(model, config.summerLineRatingMw)],
    },
  }
}
