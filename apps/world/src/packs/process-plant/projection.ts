import type { AlertState, IsoTimestamp, OperationalObject } from '../../core/model/index.ts'
import { processPlantElectricalPortsAt } from './electrical-ports.ts'
import type { PackObjectStatusTone } from '../../core/packs/protocol.ts'
import type { VariablePath } from './graph/index.ts'
import { formatQuantity } from './quantity-text.ts'
import { overviewKeyValues, plantNowOf } from './ic/key-values.ts'
import { annunciating, isStanding, pendingActions, plantAlarmPriority, plantAlertSeverity, ruleWatches } from './ic/alarm-philosophy.ts'
import { icThresholdsForSignal } from './ic/thresholds.ts'
import type { CompiledProcessPlant } from './plant-compiler.ts'
import {
  emptyProcessPlantProjection,
  processPlantField,
  processPlantUnitPackDataSchema,
  type ProcessPlantUnitEnergyReading,
  type ProcessPlantUnitPackData,
  type ProcessPlantUnitProjection,
  type ProcessPlantUnitSafetyFunction,
} from './model.ts'
import { processPlantOperatingMode, type ProcessPlantIcLifecycleState } from './runtime/index.ts'
import type { ProcessPlantVariableHandle } from './runtime/variable-table.ts'
import type { ProcessPlantRuntimeInstance } from './runtime-instance.ts'
import { evaluateSafetyFunctions, worstSafetyFunction } from './safety-functions.ts'

const severityRank: Readonly<Record<ProcessPlantIcLifecycleState['severity'], number>> = {
  info: 1,
  notice: 2,
  warning: 3,
  critical: 4,
}

const formatValue = (value: unknown, unit: string): string => {
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value === 'number') return formatQuantity(value, unit)
  return `${String(value)} ${unit}`.trim()
}

const formatRuntimePerformance = (plant: ProcessPlantRuntimeInstance): string => {
  const sample = plant.performance.snapshot()
  if (sample === null || sample.simulatedMs <= 0) return 'pending'
  return `RT x${sample.realtimeFactor.toFixed(0)} (${sample.wallMs.toFixed(1)} ms)`
}

// A Plant's panel leads with what its unit overview leads with in the mode
// it is in: what its protection can still trip on, what its automatic actions
// deliver, the key values of the equipment its rules judge, and of its energy
// source and sink (ic/key-values.ts). Its summary states the energy its
// sources put in and its sinks take out. Nothing is picked per model.
interface RailFieldPlan {
  readonly path: VariablePath
  readonly handle: ProcessPlantVariableHandle
}

interface RailPlan {
  readonly fields: ReadonlyArray<RailFieldPlan>
  /** The energy sources' and sinks' rates, for the summary line and the energy readings. */
  readonly headline: ReadonlyArray<RailFieldPlan & { readonly role: ProcessPlantUnitEnergyReading['role'] }>
}

// Re-planned only when what the overview leads with changes (a trip, a mode).
const railPlanCache = new WeakMap<ProcessPlantRuntimeInstance, { readonly key: string; readonly plan: RailPlan }>()

const railPlanFor = (plant: ProcessPlantRuntimeInstance): RailPlan => {
  const leads = overviewKeyValues(plant.plant, plantNowOf(plant))
  const key = leads.join(',')
  const existing = railPlanCache.get(plant)
  if (existing?.key === key) return existing.plan
  const planOf = (path: VariablePath): RailFieldPlan => ({ path, handle: plant.runtime.resolveVariableHandle(path) })
  // The energy the Plant takes in and gives out, as its sources' and sinks' declared rates.
  const ends = plant.plant.graph.components
    .flatMap(component => component.semantics.energy.flatMap(role => (role.role === 'transfer' ? [] : [{ ...planOf(role.rate), role: role.role }])))
  const plan = { fields: leads.map(planOf), headline: ends }
  railPlanCache.set(plant, { key, plan })
  return plan
}

const readField = (
  plant: ProcessPlantRuntimeInstance,
  plan: RailFieldPlan,
): ReturnType<typeof processPlantField> => {
  const variable = plant.runtime.readVariableSnapshotHandle(plan.handle)
  return processPlantField(String(plan.path), variable.label, formatValue(variable.value, variable.unit))
}

// The active alarms and trips, counted as the unit's displays annunciate
// them: shelved, suppressed and out-of-service ones annunciate nowhere, so
// they neither count nor colour the Plant on the map.
const activeLifecycles = (
  plant: ProcessPlantRuntimeInstance,
): ReadonlyArray<ProcessPlantIcLifecycleState> => {
  const snapshot = plant.protection?.snapshot()
  if (!snapshot) return []
  return [...snapshot.alarms, ...snapshot.trips]
    .filter(lifecycle => lifecycle.active && !lifecycle.shelved && !lifecycle.suppressed && !lifecycle.outOfService)
}

// A declared energy rate as it reads now, at the Run time the runtime stands
// at. The compiler declares every rate a solved power, so it reads a number.
const energyReading = (
  plant: ProcessPlantRuntimeInstance,
  plan: RailPlan['headline'][number],
  simulationTime: IsoTimestamp,
): ProcessPlantUnitEnergyReading => {
  const variable = plant.runtime.readVariableSnapshotHandle(plan.handle)
  if (typeof variable.value !== 'number') throw new Error(`energy rate ${String(plan.path)} reads no number`)
  return {
    path: String(plan.path),
    label: variable.label,
    role: plan.role,
    value: Number.isFinite(variable.value) ? variable.value : null,
    unit: variable.unit,
    simulationTime,
  }
}

// The most challenged critical safety function, where the model declares any.
const worstSafetyFunctionOf = (plant: ProcessPlantRuntimeInstance): ProcessPlantUnitSafetyFunction | undefined => {
  const worst = worstSafetyFunction(evaluateSafetyFunctions(plant.plant, plant.runtime))
  if (worst === undefined) return undefined
  return {
    id: worst.id,
    label: worst.label,
    shortLabel: worst.shortLabel,
    status: worst.status,
    ...(worst.procedure === undefined ? {} : { procedure: worst.procedure }),
    meaning: worst.meaning,
  }
}

// Whether a trip of a first-out group the model declares as its reactor trip
// is active. This is the Plant's state, not an annunciation: shelving or
// suppressing the trip's alarm does not reset the trip, so only an
// out-of-service trip, which judges nothing, is left out.
const reactorTripped = (plant: ProcessPlantRuntimeInstance): boolean => {
  const trips = plant.protection?.snapshot().trips ?? []
  const groups = new Set(plant.plant.automation.firstOutGroups.filter(group => group.reactorTrip).map(group => group.id))
  return trips.some(lifecycle => {
    const group = lifecycle.annunciator?.firstOutGroup
    return lifecycle.active && !lifecycle.outOfService && group !== undefined && groups.has(group)
  })
}

const firstOutMembers = new WeakMap<CompiledProcessPlant['automation'], ReadonlyMap<string, number>>()

// How many alarms and trips each first-out group annunciates: first among one says nothing (R21).
const membersOf = (plant: CompiledProcessPlant, group: string): number => {
  const known = firstOutMembers.get(plant.automation) ?? (() => {
    const counts = new Map<string, number>()
    for (const rule of plant.automation.rules) {
      if (!rule.enabled) continue
      for (const effect of rule.effects) {
        if (effect.type === 'writeSignal' || effect.annunciator?.firstOutGroup === undefined) continue
        counts.set(effect.annunciator.firstOutGroup, (counts.get(effect.annunciator.firstOutGroup) ?? 0) + 1)
      }
    }
    return counts
  })()
  firstOutMembers.set(plant.automation, known)
  return known.get(group) ?? 0
}

// Who an actor id names, by the kind in it: an AI agent, the Run itself (its scenario timeline), or a person.
const actorKind = (actorId: string): NonNullable<AlertState['acknowledgedBy']> => {
  const kind = actorId.split(':')[1]
  return kind === 'ai' ? 'ai' : kind === 'system' || kind === 'scenario-timeline' ? 'system' : 'person'
}

/**
 * The unit's alarms and trips in the core alert slot (plan v3.1 §2.2, A2):
 * those annunciating, and those returned to normal still unacknowledged, with
 * their facets. Every field is a pure function of the persisted I&C state:
 * `raisedAt` is the occurrence's plant time (`lastActiveElapsedMs`) at the Run
 * time the Plant started, so an entry holds while its state does (A3).
 */
const alertsOf = (objectId: string, plant: ProcessPlantRuntimeInstance, simulationTime: IsoTimestamp): ReadonlyArray<AlertState> => {
  const snapshot = plant.protection?.snapshot()
  if (snapshot === undefined) return []
  const compiled = plant.plant
  const origin = Date.parse(simulationTime) - plant.runtime.advancedMs()
  const elapsedMs = plant.runtime.elapsedMs()
  const showing = annunciating(snapshot)
  const pending = pendingActions(compiled, snapshot, elapsedMs)
  const returned = [...snapshot.alarms, ...snapshot.trips]
    .filter(lifecycle => !lifecycle.active && !lifecycle.acknowledged && lifecycle.phase === 'clearedUnacknowledged' && !lifecycle.shelved && !lifecycle.suppressed && !lifecycle.outOfService)
  return [...showing, ...returned].map(lifecycle => {
    const priority = plantAlarmPriority(lifecycle.severity, lifecycle.annunciator?.priority)
    const rule = compiled.automation.rules.find(candidate => candidate.id === lifecycle.ruleId)!
    const watched = ruleWatches(compiled, rule)
    const limited = watched.length === 1 && compiled.graph.signalBindingByPath.get(watched[0]!)?.published === true ? watched[0]! : undefined
    const group = lifecycle.annunciator?.firstOutGroup
    return {
      id: lifecycle.id,
      kind: lifecycle.kind,
      severity: plantAlertSeverity(lifecycle.severity),
      message: lifecycle.title,
      // A state saved without the plant time it came in leaves the clock out: "time unknown".
      raisedAt: new Date(origin + (lifecycle.lastActiveElapsedMs ?? 0)).toISOString() as IsoTimestamp,
      acknowledged: lifecycle.acknowledged,
      ...(lifecycle.acknowledged && lifecycle.lastActorId !== undefined ? { acknowledgedBy: actorKind(lifecycle.lastActorId) } : {}),
      ...(lifecycle.active ? {} : { returned: true as const }),
      ...(lifecycle.latched ? { latched: true as const } : {}),
      ...(lifecycle.active && isStanding(compiled, lifecycle, { all: showing, pending, elapsedMs, priority }) ? { standing: true as const } : {}),
      ...(lifecycle.firstOut && group !== undefined && lifecycle.firstOutRank !== undefined && membersOf(compiled, group) > 1 ? { firstOut: { group, rank: lifecycle.firstOutRank } } : {}),
      ...(lifecycle.annunciator?.equipmentId === undefined ? {} : { subject: { element: lifecycle.annunciator.equipmentId } }),
      ...(limited === undefined ? {} : { observable: `${objectId}#${limited}` }),
      ...(limited !== undefined && icThresholdsForSignal(compiled, limited).thresholds.some(threshold => threshold.ruleId === rule.id) ? { threshold: rule.id } : {}),
      priority,
      ...(lifecycle.lastActiveElapsedMs === undefined ? {} : { clock: 'simulation' as const }),
    }
  })
}

const statusFor = (
  lifecycles: ReadonlyArray<ProcessPlantIcLifecycleState>,
): {
  readonly tone: PackObjectStatusTone
  readonly label: string
  readonly highestSeverity?: ProcessPlantIcLifecycleState['severity']
} => {
  const highestSeverity = lifecycles
    .map(lifecycle => lifecycle.severity)
    .sort((left, right) => severityRank[right] - severityRank[left])[0]
  if (highestSeverity === 'critical') return { tone: 'error', label: 'Critical alarm or trip active', highestSeverity }
  if (highestSeverity === 'warning') return { tone: 'working', label: 'Warning alarm active', highestSeverity }
  if (highestSeverity === 'notice' || highestSeverity === 'info') return { tone: 'working', label: 'Operational notice active', highestSeverity }
  return { tone: 'ready', label: 'Normal' }
}

export const projectedProcessPlantUnit = (config: {
  readonly object: OperationalObject
  readonly plant: ProcessPlantRuntimeInstance | undefined
  /** Wall time, for `updatedAt`. */
  readonly at: IsoTimestamp
  /** The Run time the Plant's runtime stands at, for its readings. */
  readonly simulationTime: IsoTimestamp
  readonly connected?: boolean
}): OperationalObject => {
  const parsed = processPlantUnitPackDataSchema.safeParse(config.object.packData)
  if (!parsed.success) return config.object
  if (!config.plant) {
    return {
      ...config.object,
      packData: {
        ...parsed.data,
        projection: emptyProcessPlantProjection(config.at),
      } satisfies ProcessPlantUnitPackData,
    }
  }
  const plant = config.plant
  const lifecycles = activeLifecycles(plant)
  const status = statusFor(lifecycles)
  const activeTripCount = lifecycles.filter(lifecycle => lifecycle.kind === 'trip').length
  const rail = railPlanFor(plant)
  const fields = [
    ...rail.fields.map(plan => readField(plant, plan)),
    processPlantField('active-alarms', 'Active alarms', String(lifecycles.filter(lifecycle => lifecycle.kind === 'alarm').length)),
    processPlantField('active-trips', 'Active trips', String(activeTripCount)),
    processPlantField('runtime-performance', 'Runtime', formatRuntimePerformance(plant)),
  ]
  const headline = rail.headline.map(plan => readField(plant, plan))
  const worst = worstSafetyFunctionOf(plant)
  // The operating mode the unit overview names (composed-display-query.ts).
  const mode = processPlantOperatingMode({ system: plant.plant, runtime: plant.runtime, modes: plant.plant.automation.operatingModes })
  const projection: ProcessPlantUnitProjection = {
    schemaVersion: 1,
    summary: headline.length === 0 ? status.label : headline.map(field => `${field.label} ${field.value}`).join(' · '),
    statusTone: status.tone,
    statusLabel: status.label,
    ...(status.highestSeverity === undefined ? {} : { highestSeverity: status.highestSeverity }),
    ...(mode === null ? {} : { modeLabel: mode.label }),
    ...(reactorTripped(plant) ? { reactorTripped: true } : {}),
    activeAlarmCount: lifecycles.filter(lifecycle => lifecycle.kind === 'alarm').length,
    activeTripCount,
    energy: rail.headline.map(plan => energyReading(plant, plan, config.simulationTime)),
    ...(worst === undefined ? {} : { worstSafetyFunction: worst }),
    fields,
    updatedAt: config.at,
  }
  return {
    ...config.object,
    revision: config.object.revision + 1,
    alerts: [...alertsOf(String(config.object.id), plant, config.simulationTime)],
    operational: {
      ...config.object.operational,
      status: status.tone === 'ready' ? 'normal' : status.tone === 'error' ? 'critical' : 'degraded',
      priority: status.tone === 'error' ? 'critical' : status.tone === 'working' ? 'high' : 'normal',
    },
    packData: {
      ...parsed.data,
      electricalPorts: [...processPlantElectricalPortsAt({ plant, connected: config.connected ?? false, at: config.at })],
      projection,
    } satisfies ProcessPlantUnitPackData,
    timestamps: {
      ...config.object.timestamps,
      updatedAt: config.at,
    },
  }
}

// What makes a projection new: everything but its wall time. Its energy
// readings carry their Run time, so a running Plant's are new each step.
export const processPlantProjectionKey = (object: OperationalObject): string => {
  const parsed = processPlantUnitPackDataSchema.safeParse(object.packData)
  const projection = parsed.success ? parsed.data.projection : undefined
  return parsed.success
    ? JSON.stringify({
        status: object.operational.status,
        priority: object.operational.priority,
        alerts: object.alerts,
        projection: projection === undefined
          ? undefined
          : {
              ...projection,
              updatedAt: '<ignored>',
            },
        electricalPorts: parsed.data.electricalPorts.map(port => ({
          ...port,
          state: port.state === undefined ? undefined : { ...port.state, observedAt: '<ignored>' },
        })),
      })
    : ''
}
