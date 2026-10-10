import { priceAreas, type PriceArea } from '../schemas/grid-ids.ts'
import type { GridGeneratorV2, GridModelV2 } from '../schemas/grid-model.ts'
import type { GridOperatingPointV2 } from '../schemas/grid-operating-point.ts'
import { compareText } from '../topology/ids.ts'
import { roundTo } from './geo.ts'

// Initial operating points of the Norway model. Dispatch rule (per AC island, applied to every
// island that holds load): wind and run-of-river hydro produce their NVE normal-year mean output
// (annual GWh / 8760 h); storage hydro (reservoir and pumped) covers the residual demand, committed
// largest unit first until the committed capacity is the residual / committedLoading, and shares
// it in proportion to capacity. HVDC links and the Nordic exchange start at 0 MW: no schedule is
// evidenced for these hours. Islands without load start with their generators offline.

/** Loading of committed storage hydro, leaving 30 % headroom for reserves (modelling judgement). */
export const committedLoading = 0.7

const hoursPerYear = 8760

const meanOutputMw = (generator: GridGeneratorV2): number => {
  if (generator.annualProductionGwh === undefined) throw new Error(`${generator.id} has no annual production for its mean output`)
  return Math.min(generator.capacityMw, generator.annualProductionGwh * 1000 / hoursPerYear)
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

type GeneratorState = NonNullable<GridOperatingPointV2['generatorStates']>[number]

export const dispatchGenerators = (model: GridModelV2, demandMwOf: (load: GridModelV2['loads'][number]) => number): ReadonlyArray<GeneratorState> => {
  const states: GeneratorState[] = []
  for (const island of islandsOf(model)) {
    const generators = model.generators.filter(generator => island.has(generator.busId))
    const demandMw = model.loads.filter(load => island.has(load.busId)).reduce((sum, load) => sum + demandMwOf(load), 0)
    if (demandMw === 0) {
      for (const generator of generators) states.push({ assetId: generator.id, state: 'offline', availableMw: generator.capacityMw, targetMw: 0 })
      continue
    }
    const mustRun = generators.filter(generator => generator.kind === 'wind' || generator.kind === 'hydro-run-of-river')
    const storage = generators.filter(generator => generator.kind === 'hydro-reservoir' || generator.kind === 'hydro-pumped')
    const mustRunMw = mustRun.reduce((sum, generator) => sum + meanOutputMw(generator), 0)
    // Must-run output beyond demand is curtailed in proportion.
    const mustRunScale = Math.min(1, demandMw / mustRunMw)
    const residualMw = demandMw - mustRunMw * mustRunScale
    for (const generator of mustRun) {
      const targetMw = roundTo(meanOutputMw(generator) * mustRunScale, 3)
      states.push({ assetId: generator.id, state: 'online', availableMw: generator.kind === 'wind' ? roundTo(meanOutputMw(generator), 3) : generator.capacityMw, targetMw })
    }
    const ordered = [...storage].sort((left, right) => right.capacityMw - left.capacityMw || compareText(left.id, right.id))
    const committed: GridGeneratorV2[] = []
    let committedMw = 0
    for (const generator of ordered) {
      if (committedMw >= residualMw / committedLoading) break
      committed.push(generator)
      committedMw += generator.capacityMw
    }
    if (residualMw > committedMw) throw new Error(`island of ${island.size} buses: storage hydro (${roundTo(committedMw, 1)} MW) cannot cover the residual demand ${roundTo(residualMw, 1)} MW`)
    const share = committedMw === 0 ? 0 : residualMw / committedMw
    const committedIds = new Set(committed.map(generator => generator.id))
    for (const generator of storage) {
      if (!committedIds.has(generator.id)) {
        states.push({ assetId: generator.id, state: 'offline', availableMw: generator.capacityMw, targetMw: 0 })
        continue
      }
      const targetMw = roundTo(generator.capacityMw * share, 3)
      if (targetMw < generator.minimumStableMw) throw new Error(`${generator.id}: dispatch ${targetMw} MW below its minimum stable ${generator.minimumStableMw} MW`)
      states.push({ assetId: generator.id, state: 'online', availableMw: generator.capacityMw, targetMw })
    }
  }
  return states.sort((left, right) => compareText(left.assetId, right.assetId))
}

const zeroSchedules = (model: GridModelV2) => ({
  hvdcSchedules: model.hvdcLinks.map(link => ({ assetId: link.id, timeZone: 'Europe/Oslo' as const, points: [{ localTime: '00:00', transferMw: 0 }] })),
  externalExchangeSchedules: model.externalSystems.filter(system => system.synchronous)
    .map(system => ({ assetId: system.id, timeZone: 'Europe/Oslo' as const, points: [{ localTime: '00:00', exportMw: 0 }] })),
})

export const buildOperatingPoints = (config: {
  readonly model: GridModelV2
  readonly compatibleModelRefs: ReadonlyArray<string>
  readonly summerAreaMw: Readonly<Record<PriceArea, number>>
  readonly summerHour: string
}): { readonly winter: GridOperatingPointV2; readonly summer: GridOperatingPointV2 } => {
  const { model } = config
  const areaMw = (area: PriceArea): number => model.loads.filter(load => load.priceArea === area).reduce((sum, load) => sum + load.referenceDemandMw, 0)
  const summerScale = Object.fromEntries(priceAreas.map(area => [area, roundTo(config.summerAreaMw[area] / areaMw(area), 6)])) as Record<PriceArea, number>
  const rule = `Initial dispatch: wind and run-of-river hydro at their NVE normal-year mean output, storage hydro committed largest first to ${committedLoading * 100} % loading for the residual demand and shared in proportion to capacity; HVDC links and the Nordic exchange at 0 MW (no evidenced schedule).`
  return {
    winter: {
      schemaVersion: 2,
      id: 'electric-grid.norway.winter-weekday-peak',
      title: 'Winter weekday peak',
      description: `Elhub reference hour ${model.referenceHour} (national ${roundTo(priceAreas.reduce((sum, area) => sum + areaMw(area), 0), 0)} MW located demand). ${rule}`,
      compatibleModelRefs: [...config.compatibleModelRefs],
      loadScale: 1,
      generatorStates: [...dispatchGenerators(model, load => load.referenceDemandMw)],
      ...zeroSchedules(model),
    },
    summer: {
      schemaVersion: 2,
      id: 'electric-grid.norway.summer-night-low',
      title: 'Summer night low',
      description: `Elhub summer low hour ${config.summerHour}: each price area's demand scaled to its metered total. ${rule} The Nordic remainder keeps the model's winter inertia and load; the Operating Point schema cannot override them.`,
      compatibleModelRefs: [...config.compatibleModelRefs],
      loadScale: 1,
      priceAreaDemandScale: summerScale,
      generatorStates: [...dispatchGenerators(model, load => load.referenceDemandMw * summerScale[load.priceArea])],
      ...zeroSchedules(model),
    },
  }
}
