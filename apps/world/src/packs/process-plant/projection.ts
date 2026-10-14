import type { IsoTimestamp, OperationalObject } from '../../core/model/index.ts'
import { processPlantElectricalPortsAt } from './electrical-ports.ts'
import type { PackObjectStatusTone } from '../../core/packs/protocol.ts'
import type { VariablePath } from './graph/index.ts'
import { formatQuantity } from './displays/display-text.ts'
import { overviewKeyValues, plantNowOf } from './displays/overview-key-values.ts'
import {
  emptyProcessPlantProjection,
  processPlantField,
  processPlantUnitPackDataSchema,
  type ProcessPlantUnitPackData,
  type ProcessPlantUnitProjection,
} from './model.ts'
import type { ProcessPlantIcLifecycleState } from './runtime/index.ts'
import type { ProcessPlantVariableHandle } from './runtime/variable-table.ts'
import type { ProcessPlantRuntimeInstance } from './runtime-instance.ts'

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
// source and sink (overview-key-values.ts). Its summary states the energy its
// sources put in and its sinks take out. Nothing is picked per model.
interface RailFieldPlan {
  readonly path: VariablePath
  readonly handle: ProcessPlantVariableHandle
}

interface RailPlan {
  readonly fields: ReadonlyArray<RailFieldPlan>
  /** The energy sources' and sinks' rates, for the summary line. */
  readonly headline: ReadonlyArray<RailFieldPlan>
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
    .flatMap(component => component.semantics.energy.flatMap(role => (role.role === 'transfer' ? [] : [role.rate])))
  const plan = { fields: leads.map(planOf), headline: ends.map(planOf) }
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
  readonly at: IsoTimestamp
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
  const projection: ProcessPlantUnitProjection = {
    schemaVersion: 1,
    summary: headline.length === 0 ? status.label : headline.map(field => `${field.label} ${field.value}`).join(' · '),
    statusTone: status.tone,
    statusLabel: status.label,
    ...(status.highestSeverity === undefined ? {} : { highestSeverity: status.highestSeverity }),
    activeAlarmCount: lifecycles.filter(lifecycle => lifecycle.kind === 'alarm').length,
    activeTripCount,
    fields,
    updatedAt: config.at,
  }
  return {
    ...config.object,
    revision: config.object.revision + 1,
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

export const processPlantProjectionKey = (object: OperationalObject): string => {
  const parsed = processPlantUnitPackDataSchema.safeParse(object.packData)
  const projection = parsed.success ? parsed.data.projection : undefined
  return parsed.success
    ? JSON.stringify({
        status: object.operational.status,
        priority: object.operational.priority,
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
