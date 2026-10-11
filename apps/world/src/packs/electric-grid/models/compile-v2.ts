import type {
  GridBranchDefinition,
  GridBusDefinition,
  GridExternalSystemDefinition,
  GridGenerationKind,
  GridGeneratorDefinition,
  GridLoadDefinition,
  GridLoadKind,
  GridModelDefinition,
  GridOperatingPointDefinition,
  GridShuntDefinition,
} from '../grid-model.ts'
import type { GridLoadV2, GridModelV2, GridProvenance } from '../schemas/grid-model.ts'
import type { GridOperatingPointV2 } from '../schemas/grid-operating-point.ts'

// Grid Model v2 and one Operating Point (with any Scenario overrides already applied) → the
// runtime's Model and Operating Point definitions. Pure: no file access.

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

/**
 * The runtime holds a set-point until a command changes it; it does not follow a time-of-day
 * schedule. A schedule with one point is that constant set-point; any other is refused, never
 * reduced to one of its points.
 */
const constantSchedule = <Point>(operatingPoint: GridOperatingPointV2, assetId: string, points: ReadonlyArray<Point>): Point => {
  if (points.length !== 1) {
    throw new Error(`Operating Point ${operatingPoint.id}: the schedule of ${assetId} has ${points.length} points; the Grid runtime holds constant set-points and does not follow time-of-day schedules`)
  }
  return points[0]!
}

export interface CompiledV2 {
  readonly model: GridModelDefinition
  readonly operatingPoint: GridOperatingPointDefinition
}

/** Scenario-level scales the v2 Operating Point does not carry; absent scales leave values as the Operating Point sets them. */
export interface RuntimeScales {
  readonly generationAvailabilityScale?: number | undefined
  readonly storageStateOfCharge?: number | undefined
}

export const compileGridModelV2 = (model: GridModelV2, operatingPoint: GridOperatingPointV2, scales: RuntimeScales = {}): CompiledV2 => {
  if (!operatingPoint.compatibleModelRefs.includes(model.id)) throw new Error(`Operating Point ${operatingPoint.id} is not compatible with ${model.id}`)
  const states = new Map((operatingPoint.generatorStates ?? []).map(state => [state.assetId, state]))
  const areaScale = operatingPoint.priceAreaDemandScale ?? {}
  const firstSource = (provenance: GridProvenance): string => provenance.sources[0]!
  const buses: GridBusDefinition[] = model.buses.map(bus => ({
    id: bus.id,
    label: bus.label,
    kind: bus.kind,
    nominalKv: bus.nominalKv,
    location: bus.location,
    sourceId: firstSource(bus.provenance),
    ...(bus.substationId === undefined ? {} : { sourceFeatureId: bus.substationId }),
    provenance: bus.provenance,
  }))
  // Ratings at the Operating Point's ambient conditions replace the Model's as the branch's base ratings.
  const ratings = new Map((operatingPoint.branchRatings ?? []).map(entry => [entry.assetId, entry]))
  const branches: GridBranchDefinition[] = model.branches.map(branch => ({
    id: branch.id,
    label: branch.label,
    kind: branch.kind,
    fromBusId: branch.fromBusId,
    toBusId: branch.toBusId,
    nominalKv: branch.nominalKv,
    ...(branch.lengthKm === undefined ? {} : { lengthKm: branch.lengthKm }),
    circuits: branch.circuits,
    ratingMw: ratings.get(branch.id)?.ratingMw ?? branch.ratingMw,
    emergencyRatingMw: ratings.get(branch.id)?.emergencyRatingMw ?? branch.emergencyRatingMw,
    emergencyDurationSeconds: branch.emergencyDurationSeconds,
    reactancePu: branch.reactancePu,
    resistancePu: branch.resistancePu,
    chargingSusceptancePu: branch.chargingSusceptancePu,
    ...(branch.tapRatio === undefined ? {} : { tapRatio: branch.tapRatio }),
    sourceId: firstSource(branch.provenance),
    provenance: branch.provenance,
  }))
  const shunts: GridShuntDefinition[] = model.shunts.map(shunt => ({ ...shunt }))
  const generators: GridGeneratorDefinition[] = model.generators.map(generator => {
    const state = states.get(generator.id)
    return {
      id: generator.id,
      label: generator.label,
      kind: generationKinds[generator.kind],
      busId: generator.busId,
      location: generator.location,
      capacityMw: generator.capacityMw,
      ratedMva: generator.ratedMva,
      powerFactor: generator.powerFactor,
      voltageSetpointPu: generator.voltageSetpointPu,
      inertiaSeconds: generator.inertiaSeconds,
      synchronous: generator.synchronous,
      minimumStableMw: generator.minimumStableMw,
      blackStartCapable: generator.blackStartCapable,
      rampRateMwPerMinute: generator.rampMwPerMinute,
      // An asset the Operating Point does not list starts as the runtime initialises it: online at capacity.
      availableMw: state?.availableMw ?? generator.capacityMw,
      initialState: state?.state ?? 'online',
      initialTargetMw: state?.state === 'online' && state.targetMw !== undefined ? state.targetMw : null,
      ...(generator.annualProductionGwh === undefined ? {} : { annualProductionGwh: generator.annualProductionGwh }),
      priceArea: generator.priceArea,
      sourceId: firstSource(generator.provenance),
      provenance: generator.provenance,
    }
  })
  const loads: GridLoadDefinition[] = model.loads.map(load => {
    const demandMw = load.referenceDemandMw * (areaScale[load.priceArea] ?? 1)
    return {
      id: load.id,
      label: load.label,
      kind: loadKinds[load.kind],
      busId: load.busId,
      location: load.location,
      demandMw,
      // A critical load is protected whole: LFDD and manual shedding never disconnect it.
      criticalMw: load.priority === 'critical' ? demandMw : 0,
      powerFactor: load.powerFactor,
      priority: load.priority,
      interruptibleMw: load.interruptibleMw,
      sourceId: firstSource(load.provenance),
      provenance: load.provenance,
    }
  })
  const branchStates = new Map((operatingPoint.branchStates ?? []).map(entry => [entry.assetId, entry]))
  const newestInput = [...model.sourceBuild.inputs].map(input => input.snapshotAt).sort().at(-1)!
  const exchanges = new Map((operatingPoint.externalExchangeSchedules ?? []).map(schedule => [schedule.assetId, constantSchedule(operatingPoint, schedule.assetId, schedule.points).exportMw]))
  const hvdcSchedules = new Map((operatingPoint.hvdcSchedules ?? []).map(schedule => [schedule.assetId, constantSchedule(operatingPoint, schedule.assetId, schedule.points).transferMw]))
  // The Operating Point sets a synchronous equivalent's inertia and load for its season and hour;
  // the reserve volumes stay as the Model sets them.
  const externalStates = new Map((operatingPoint.externalSystemStates ?? []).map(state => [state.assetId, state]))
  const externalAreaOfBus = new Map(model.buses.flatMap(bus => bus.externalArea === undefined ? [] : [[bus.id, bus.externalArea] as const]))
  const externalSystems = model.externalSystems.map((system): GridExternalSystemDefinition => {
    const state = externalStates.get(system.id)
    const { areaParticipation, ...values } = system
    const mapped: GridExternalSystemDefinition = {
      ...values,
      ...(areaParticipation === undefined ? {} : {
        areaParticipation: areaParticipation.map(entry => ({
          area: entry.area,
          share: entry.share,
          boundaryBusIds: system.boundaryBusIds.filter(busId => externalAreaOfBus.get(busId) === entry.area),
        })),
      }),
    }
    if (state === undefined) return mapped
    return {
      ...mapped,
      inertiaGws: state.inertiaGws,
      loadMw: state.loadMw,
      provenance: {
        sources: [...new Set([...state.provenance.sources, ...system.provenance.sources])],
        method: 'curated',
        confidence: state.provenance.confidence === 'high' ? system.provenance.confidence : state.provenance.confidence,
        note: `Inertia and load at Operating Point ${operatingPoint.id}: ${state.provenance.note ?? state.provenance.method}. Model: ${system.provenance.note ?? system.provenance.method}`,
      },
    }
  })
  return {
    model: {
      id: model.id,
      title: model.title,
      description: model.description,
      nominalFrequencyHz: model.nominalFrequencyHz,
      sBaseMva: model.sBaseMva,
      fidelity: { ...model.fidelity, recommendedMaximumBusCount },
      // v2 records no wall-clock build time; the runtime's generatedAt carries the newest input snapshot.
      sourceBuild: { id: model.sourceBuild.id, generatedAt: newestInput },
      sourceIds: model.sourceBuild.inputs.map(input => input.sourceId),
      buses,
      branches,
      shunts,
      generators,
      loads,
      storage: [],
      connectionPoints: model.connectionPoints.map(point => ({ ...point })),
      externalSystems,
      hvdcLinks: model.hvdcLinks.map(link => ({ ...link })),
    },
    operatingPoint: {
      id: operatingPoint.id,
      title: operatingPoint.title,
      loadScale: operatingPoint.loadScale,
      generationAvailabilityScale: scales.generationAvailabilityScale ?? 1,
      storageStateOfCharge: scales.storageStateOfCharge ?? null,
      hvdcSetpoints: model.hvdcLinks.map(link => ({ linkId: link.id, setpointMw: hvdcSchedules.get(link.id) ?? 0 })),
      externalExchanges: externalSystems.filter(system => system.synchronous).map(system => ({ systemId: system.id, scheduledExportMw: exchanges.get(system.id) ?? 0 })),
      // An Operating Point lists only the branches that start open or derated (a summer ambient
      // rating is an availability below 1); every other branch starts closed at its full rating.
      branchStates: model.branches.map(branch => {
        const entry = branchStates.get(branch.id)
        return { branchId: branch.id, state: entry?.state ?? 'closed', availability: entry?.availability ?? 1 }
      }),
    },
  }
}
