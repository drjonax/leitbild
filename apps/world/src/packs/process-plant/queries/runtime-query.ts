import type { PackRuntimeQuery } from '../../../simulation/protocol.ts'
import type { ProcessPlantIcLifecycleState } from '../runtime/index.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'
import { failure, requirePlant, plantQuerySchema } from './common.ts'

const icSummaryFor = (plant: ProcessPlantRuntimeInstance): {
  readonly configured: boolean
  readonly activeAlarmCount: number
  readonly activeTripCount: number
  readonly activeRuleCount: number
  readonly failureCount: number
  readonly firstOutCount: number
  readonly activeFirstOut: ReadonlyArray<ProcessPlantIcSummaryLifecycle>
  readonly activeHighestSeverity: ProcessPlantIcLifecycleState['severity'] | null
  readonly active: ReadonlyArray<ProcessPlantIcSummaryLifecycle>
} => {
  const snapshot = plant.protection?.snapshot()
  if (snapshot === undefined) {
    return {
      configured: false,
      activeAlarmCount: 0,
      activeTripCount: 0,
      activeRuleCount: 0,
      failureCount: 0,
      firstOutCount: 0,
      activeFirstOut: [],
      activeHighestSeverity: null,
      active: [],
    }
  }
  const active = [...snapshot.alarms, ...snapshot.trips].filter(lifecycle => lifecycle.active)
  const activeSummaries = active
    .sort((left, right) => severityRank(right.severity) - severityRank(left.severity))
    .map(summaryLifecycle)
  const firstOut = active.filter(lifecycle => lifecycle.firstOut)
  return {
    configured: true,
    activeAlarmCount: snapshot.alarms.filter(alarm => alarm.active).length,
    activeTripCount: snapshot.trips.filter(trip => trip.active).length,
    activeRuleCount: snapshot.rules.filter(rule => rule.active).length,
    failureCount: snapshot.failures.length,
    firstOutCount: firstOut.length,
    activeFirstOut: firstOut.map(summaryLifecycle),
    activeHighestSeverity: activeSummaries[0]?.severity ?? null,
    active: activeSummaries,
  }
}

interface ProcessPlantIcSummaryLifecycle {
  readonly id: string
  readonly kind: ProcessPlantIcLifecycleState['kind']
  readonly title: string
  readonly severity: ProcessPlantIcLifecycleState['severity']
  readonly firstOut: boolean
  readonly firstOutGroup?: string
  readonly equipmentId?: string
  readonly firstActiveElapsedMs?: number
}

const severityOrder: ReadonlyArray<ProcessPlantIcLifecycleState['severity']> = ['info', 'notice', 'warning', 'critical']

const severityRank = (severity: ProcessPlantIcLifecycleState['severity']): number =>
  severityOrder.indexOf(severity)

const summaryLifecycle = (lifecycle: ProcessPlantIcLifecycleState): ProcessPlantIcSummaryLifecycle => ({
  id: lifecycle.id,
  kind: lifecycle.kind,
  title: lifecycle.title,
  severity: lifecycle.severity,
  firstOut: lifecycle.firstOut,
  ...(lifecycle.annunciator?.firstOutGroup === undefined ? {} : { firstOutGroup: lifecycle.annunciator.firstOutGroup }),
  ...(lifecycle.annunciator?.equipmentId === undefined ? {} : { equipmentId: lifecycle.annunciator.equipmentId }),
  ...(lifecycle.firstActiveElapsedMs === undefined ? {} : { firstActiveElapsedMs: lifecycle.firstActiveElapsedMs }),
})

export const processPlantRuntimeQueryKinds = [
  'world.process-plant.runtime.status',
  'world.process-plant.transient.diagnostics',
] as const

export const answerProcessPlantRuntimeQuery = (config: {
  readonly request: PackRuntimeQuery
  readonly plants: ReadonlyMap<string, ProcessPlantRuntimeInstance>
}): unknown | undefined => {
  if (!processPlantRuntimeQueryKinds.some(kind => kind === config.request.capabilityId)) return undefined
  if (config.request.capabilityId === 'world.process-plant.runtime.status') {
    return {
      active: config.plants.size > 0,
      plantCount: config.plants.size,
      plants: [...config.plants.values()].map(({ plant, runtime }) => {
        const snapshot = runtime.snapshot()
        return {
          id: plant.id,
          elapsedMs: snapshot.elapsedMs,
          remainderMs: snapshot.remainderMs,
          publishedVariableCount: snapshot.variables.filter(variable => variable.published).length,
          variableCount: snapshot.variables.length,
        }
      }),
    }
  }
  if (config.request.capabilityId === 'world.process-plant.transient.diagnostics') {
    const payload = plantQuerySchema.parse(config.request.input)
    const plant = requirePlant(config.plants, payload.plantId)
    // The primary boundary's leak flow and the tube leak flow are the model's truth about an injected fault, which no
    // person or AI agent reads (signals.ts isInjectedFault): the diagnostics leave them out.
    const { leakFlowKgPerS: _leak, tubeLeakFlowKgPerS: _tubeLeak, ...primary } = plant.runtime.pwrTransientDiagnostics().primary
    return {
      plantId: payload.plantId,
      diagnostics: { ...plant.runtime.pwrTransientDiagnostics(), primary },
      ic: icSummaryFor(plant),
    }
  }
  return failure(`Process Plant does not support query Capability: ${config.request.capabilityId}`)
}
