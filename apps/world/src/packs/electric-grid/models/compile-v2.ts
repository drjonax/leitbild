import type {
  GridBranchDefinition,
  GridBusDefinition,
  GridConnectionPointDefinition,
  GridGenerationKind,
  GridGeneratorDefinition,
  GridLoadDefinition,
  GridLoadKind,
  GridModelDefinition,
  GridOperatingPointDefinition,
} from '../grid-model.ts'
import type { GridLoadV2, GridModelV2, GridProvenance } from '../schemas/grid-model.ts'
import type { GridOperatingPointV2 } from '../schemas/grid-operating-point.ts'

// Grid Model v2 (+ one Operating Point) → the runtime's Model definition. Pure: no file access.
// The runtime types predate v2 and drop the AC fields (charging, taps, shunts, power factors,
// minimum stable output); they are listed for the runtime lane in the MB1 report.

/** External systems and HVDC links as the solver-integration runtime (lane IS1) declares them. */
export interface RuntimeExternalSystem {
  readonly id: string
  readonly label: string
  readonly area: 'SE1' | 'SE2' | 'SE3' | 'SE4' | 'FI' | 'DK1' | 'NL' | 'DE' | 'GB' | 'nordic-remainder'
  readonly synchronous: boolean
  readonly boundaryBusIds: ReadonlyArray<string>
  readonly inertiaGws?: number
  readonly loadMw?: number
  readonly fcrNMwPerHz?: number
  readonly fcrDUpMw?: number
  readonly fcrDDownMw?: number
  readonly afrrUpMw?: number
  readonly afrrDownMw?: number
  readonly provenance: GridProvenance
}

export interface RuntimeHvdcLink {
  readonly id: string
  readonly label: string
  readonly fromBusId: string
  readonly toBusId: string
  readonly ratingMw: number
  readonly lossPercent: number
  readonly rampMwPerMinute: number
  readonly osmWayIds: ReadonlyArray<string>
  readonly provenance: GridProvenance
}

export type RuntimeGridModel = GridModelDefinition & {
  readonly externalSystems: ReadonlyArray<RuntimeExternalSystem>
  readonly hvdcLinks: ReadonlyArray<RuntimeHvdcLink>
}

/** Bus count the runtime's sparse solver handles within its budget (lane N1: 10,000 buses rebuilt in 21 ms). */
const recommendedMaximumBusCount = 10_000

const generationKinds: Readonly<Record<GridModelV2['generators'][number]['kind'], GridGenerationKind>> = {
  'hydro-reservoir': 'hydro',
  'hydro-run-of-river': 'hydro',
  'hydro-pumped': 'hydro',
  wind: 'wind',
  solar: 'solar',
  thermal: 'thermal',
  nuclear: 'nuclear',
}

const loadKinds: Readonly<Record<GridLoadV2['kind'], GridLoadKind>> = {
  private: 'residential',
  business: 'commercial',
  industry: 'industry',
  'industry-site': 'industry',
  'petroleum-site': 'industry',
  'data-center': 'data_center',
}

// The runtime still requires a weather exposure class; weather coupling is not built (plan
// decision 5). Classes follow the v1 rule: buried cables low, overhead lines by length.
const weatherExposure = (branch: GridModelV2['branches'][number]): GridBranchDefinition['weatherExposure'] => {
  if (branch.kind !== 'ac_line') return 'low'
  const km = branch.lengthKm!
  return km >= 60 ? 'high' : km >= 20 ? 'medium' : 'low'
}

/**
 * The runtime gives a synchronous external system exactly one boundary bus (one frequency per
 * system). The v2 Nordic remainder meets Norway at one boundary bus per area and voltage, so it
 * becomes one runtime system per boundary bus, its inertia, load and reserves shared in proportion
 * to the continuous rating of the AC ties ending there.
 */
const splitSynchronous = (model: GridModelV2, system: GridModelV2['externalSystems'][number]): ReadonlyArray<RuntimeExternalSystem> => {
  const tieMw = (busId: string): number => model.branches
    .filter(branch => branch.fromBusId === busId || branch.toBusId === busId)
    .reduce((sum, branch) => sum + branch.ratingMw, 0)
  const total = system.boundaryBusIds.reduce((sum, busId) => sum + tieMw(busId), 0)
  if (total === 0) throw new Error(`${system.id}: no AC tie ends at its boundary buses`)
  return system.boundaryBusIds.map(busId => {
    const share = tieMw(busId) / total
    const bus = model.buses.find(candidate => candidate.id === busId)!
    const part = (value: number | undefined): number => {
      if (value === undefined) throw new Error(`${system.id} lacks a synchronous parameter`)
      return value * share
    }
    return {
      id: system.boundaryBusIds.length === 1 ? system.id : `${system.id}@${busId.slice('bus:boundary-'.length)}`,
      label: system.boundaryBusIds.length === 1 ? system.label : `${system.label} via ${busId.slice('bus:boundary-'.length)}`,
      area: system.boundaryBusIds.length === 1 ? system.area : bus.externalArea!,
      synchronous: true,
      boundaryBusIds: [busId],
      inertiaGws: part(system.inertiaGws),
      loadMw: part(system.loadMw),
      fcrNMwPerHz: part(system.fcrNMwPerHz),
      fcrDUpMw: part(system.fcrDUpMw),
      fcrDDownMw: part(system.fcrDDownMw),
      afrrUpMw: part(system.afrrUpMw),
      afrrDownMw: part(system.afrrDownMw),
      provenance: {
        ...system.provenance,
        note: `${system.provenance.note ?? system.label}; ${(share * 100).toFixed(1)} % share by AC tie rating at ${busId}`,
      },
    }
  })
}

export interface CompiledV2 {
  readonly model: RuntimeGridModel
  readonly operatingPoint: GridOperatingPointDefinition
}

export const compileGridModelV2 = (model: GridModelV2, operatingPoint: GridOperatingPointV2): CompiledV2 => {
  if (!operatingPoint.compatibleModelRefs.includes(model.id)) throw new Error(`Operating Point ${operatingPoint.id} is not compatible with ${model.id}`)
  const states = new Map((operatingPoint.generatorStates ?? []).map(state => [state.assetId, state]))
  const areaScale = operatingPoint.priceAreaDemandScale ?? {}
  const firstSource = (provenance: GridProvenance): string => provenance.sources[0]!
  const buses: GridBusDefinition[] = model.buses.map(bus => ({
    id: bus.id,
    label: bus.label,
    nominalKv: bus.nominalKv,
    location: bus.location,
    sourceId: firstSource(bus.provenance),
    ...(bus.substationId === undefined ? {} : { sourceFeatureId: bus.substationId }),
    provenance: bus.provenance,
  }))
  const branches: GridBranchDefinition[] = model.branches.map(branch => ({
    id: branch.id,
    label: branch.label,
    kind: branch.kind,
    fromBusId: branch.fromBusId,
    toBusId: branch.toBusId,
    nominalKv: branch.nominalKv,
    ratingMw: branch.ratingMw,
    emergencyRatingMw: branch.emergencyRatingMw,
    reactancePu: branch.reactancePu,
    resistancePu: branch.resistancePu,
    weatherExposure: weatherExposure(branch),
    sourceId: firstSource(branch.provenance),
    provenance: branch.provenance,
  }))
  const generators: GridGeneratorDefinition[] = model.generators.map(generator => {
    const state = states.get(generator.id)
    const availableMw = state?.availableMw ?? generator.capacityMw
    const targetMw = state?.state === 'online' ? state.targetMw ?? 0 : 0
    return {
      id: generator.id,
      label: generator.label,
      kind: generationKinds[generator.kind],
      busId: generator.busId,
      location: generator.location,
      capacityMw: generator.capacityMw,
      availableMw,
      // Headroom the Operating Point leaves above the dispatch target.
      reserveMw: state?.state === 'online' ? Math.max(0, availableMw - targetMw) : 0,
      rampRateMwPerMinute: generator.rampMwPerMinute,
      inertiaSeconds: generator.inertiaSeconds,
      ...(generator.annualProductionGwh === undefined ? {} : { annualProductionGwh: generator.annualProductionGwh }),
      priceArea: generator.priceArea,
      sourceId: firstSource(generator.provenance),
    }
  })
  const loads: GridLoadDefinition[] = model.loads.map(load => {
    const demandMw = load.referenceDemandMw * operatingPoint.loadScale * (areaScale[load.priceArea] ?? 1)
    return {
      id: load.id,
      label: load.label,
      kind: loadKinds[load.kind],
      busId: load.busId,
      location: load.location,
      demandMw,
      criticalMw: load.priority === 'critical' ? demandMw : 0,
      reactiveDemandMvar: demandMw * Math.tan(Math.acos(load.powerFactor)),
      priority: load.priority,
      controllable: load.interruptibleMw > 0,
      sourceId: firstSource(load.provenance),
    }
  })
  const connectionPoints: GridConnectionPointDefinition[] = model.connectionPoints.map(point => ({ ...point }))
  const newestInput = [...model.sourceBuild.inputs].map(input => input.snapshotAt).sort().at(-1)!
  return {
    model: {
      id: model.id,
      title: model.title,
      description: model.description,
      nominalFrequencyHz: model.nominalFrequencyHz,
      fidelity: { powerFlow: 'dc', voltage: 'approximate', frequency: 'aggregate-dynamic', recommendedMaximumBusCount },
      // v2 records no wall-clock build time; the runtime's generatedAt carries the newest input snapshot.
      sourceBuild: { id: model.sourceBuild.id, generatedAt: newestInput },
      sourceIds: model.sourceBuild.inputs.map(input => input.sourceId),
      buses,
      branches,
      generators,
      loads,
      storage: [],
      connectionPoints,
      externalSystems: model.externalSystems.flatMap(system => system.synchronous
        ? splitSynchronous(model, system)
        : [{ id: system.id, label: system.label, area: system.area, synchronous: false, boundaryBusIds: system.boundaryBusIds, provenance: system.provenance }]),
      hvdcLinks: model.hvdcLinks.map(link => ({ ...link })),
    },
    operatingPoint: {
      id: operatingPoint.id,
      title: operatingPoint.title,
      // loadScale and the price-area scales are already in each load's demandMw.
      loadScale: 1,
      generationAvailabilityScale: 1,
      // No storage in the v2 model.
      storageStateOfCharge: 0,
    },
  }
}
