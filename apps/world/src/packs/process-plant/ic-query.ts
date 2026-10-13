import { z } from 'zod'
import type { PackRuntimeQuery } from '../../simulation/protocol.ts'
import { processPlantIcRuleClassSchema, type ProcessPlantIcLifecycleState, type ProcessPlantIcRuleCatalogEntry, type ProcessPlantIcSnapshot } from './runtime/index.ts'
import type { ProcessPlantRuntimeInstance } from './runtime-instance.ts'
import { failure, paginateProcessPlantSearch, plantQuerySchema, requirePlant } from './queries/common.ts'

export const processPlantIcQueryKinds = [
  'world.process-plant.ic.status',
  'world.process-plant.ic.catalog',
  'world.process-plant.alarms.status',
  'world.process-plant.alarms.summary',
  'world.process-plant.alarms.history',
] as const

// The reference PWR's catalog holds 154 rules of up to 7.6 KB each with the
// signals they watch, 170 KB in all (a default page: 29 KB). A page bounds
// what one read puts in a caller's context; ruleCount says how many rules the
// Plant has.
export const PROCESS_PLANT_IC_CATALOG_DEFAULT_LIMIT = 25
export const PROCESS_PLANT_IC_CATALOG_MAX_LIMIT = 100

export const processPlantIcCatalogQuerySchema = plantQuerySchema.extend({
  text: z.string().trim().min(1).max(200).optional()
    .describe('Words every listed rule contains in its id, label, class, modes, effects or watched signals (tagId, label or path), e.g. "safety injection".'),
  ruleClass: processPlantIcRuleClassSchema.optional(),
  ruleIds: z.array(z.string().min(1).max(128)).min(1).max(64).optional().describe('Exact rule ids, as a page or an actuation reset names them.'),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(PROCESS_PLANT_IC_CATALOG_MAX_LIMIT).default(PROCESS_PLANT_IC_CATALOG_DEFAULT_LIMIT),
}).strict()

const catalogTerms = (text: string): ReadonlyArray<string> =>
  [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]

const catalogRuleText = (rule: ProcessPlantIcRuleCatalogEntry): string => [
  rule.id, rule.label ?? '', rule.ruleClass, ...(rule.modes ?? []),
  ...rule.effects.flatMap(effect => [effect.id, effect.title ?? '', effect.signal?.tagId ?? '', effect.signal?.label ?? '', effect.signal?.path ?? '']),
  ...[...rule.watchedSignals, ...rule.commandGates.map(gate => gate.signal)].flatMap(signal => [signal.tagId ?? '', signal.label, signal.path]),
].join(' ').toLowerCase()

const alarmLifecycleStates = (
  snapshot: ProcessPlantIcSnapshot,
): ReadonlyArray<ProcessPlantIcLifecycleState> => [
  ...snapshot.alarms,
  ...snapshot.trips,
]

const alarmSummaryFor = (snapshot: ProcessPlantIcSnapshot): unknown => {
  const lifecycles = alarmLifecycleStates(snapshot)
  const active = lifecycles.filter(lifecycle => lifecycle.active)
  const unacknowledged = lifecycles.filter(lifecycle => !lifecycle.acknowledged && (lifecycle.active || lifecycle.lastClearedElapsedMs !== undefined))
  const firstOut = lifecycles.filter(lifecycle => lifecycle.firstOut)
  const bySeverity = Object.fromEntries(['info', 'notice', 'warning', 'critical'].map(severity => [
    severity,
    active.filter(lifecycle => lifecycle.severity === severity).length,
  ]))
  const byKind = Object.fromEntries(['alarm', 'trip'].map(kind => [
    kind,
    active.filter(lifecycle => lifecycle.kind === kind).length,
  ]))
  const byRole = lifecycles.reduce<Record<string, number>>((acc, lifecycle) => {
    if (!lifecycle.active) return acc
    const role = lifecycle.annunciator?.role ?? 'unclassified'
    acc[role] = (acc[role] ?? 0) + 1
    return acc
  }, {})
  const groups = lifecycles.reduce<Record<string, { readonly active: number; readonly unacknowledged: number }>>((acc, lifecycle) => {
    const group = lifecycle.annunciator?.group
    if (group === undefined) return acc
    const current = acc[group] ?? { active: 0, unacknowledged: 0 }
    acc[group] = {
      active: current.active + (lifecycle.active ? 1 : 0),
      unacknowledged: current.unacknowledged + (!lifecycle.acknowledged && lifecycle.active ? 1 : 0),
    }
    return acc
  }, {})
  return {
    activeCount: active.length,
    unacknowledgedCount: unacknowledged.length,
    shelvedCount: lifecycles.filter(lifecycle => lifecycle.shelved).length,
    suppressedCount: lifecycles.filter(lifecycle => lifecycle.suppressed).length,
    firstOutCount: firstOut.length,
    bySeverity,
    byKind,
    byRole,
    groups,
    firstOut,
  }
}

export const answerProcessPlantIcQuery = (config: {
  readonly request: PackRuntimeQuery
  readonly plants: ReadonlyMap<string, ProcessPlantRuntimeInstance>
}): unknown | undefined => {
  const supportedKinds = new Set<string>(processPlantIcQueryKinds)
  if (!supportedKinds.has(config.request.capabilityId)) {
    return undefined
  }
  const catalogQuery = config.request.capabilityId === 'world.process-plant.ic.catalog'
    ? processPlantIcCatalogQuerySchema.parse(config.request.input)
    : undefined
  const payload = catalogQuery ?? plantQuerySchema.parse(config.request.input)
  const system = requirePlant(config.plants, payload.plantId)
  if (!system.protection) return failure(`process plant I&C is not configured for plant: ${payload.plantId}`)
  const snapshot = system.protection.snapshot()
  if (config.request.capabilityId === 'world.process-plant.ic.status') {
    return {
        plantId: payload.plantId,
        ic: snapshot,
      }
  }
  if (config.request.capabilityId === 'world.process-plant.alarms.status') {
    return {
        plantId: payload.plantId,
        alarms: snapshot.alarms.filter(lifecycle => lifecycle.active),
        trips: snapshot.trips.filter(lifecycle => lifecycle.active),
        summary: alarmSummaryFor(snapshot),
      }
  }
  if (config.request.capabilityId === 'world.process-plant.alarms.summary') {
    return {
        plantId: payload.plantId,
        summary: alarmSummaryFor(snapshot),
      }
  }
  if (config.request.capabilityId === 'world.process-plant.alarms.history') {
    return {
        plantId: payload.plantId,
        history: snapshot.history,
      }
  }
  if (catalogQuery === undefined) throw new Error(`I&C query ${config.request.capabilityId} has no answer`)
  const query = catalogQuery
  const catalog = system.protection.catalog()
  const terms = query.text === undefined ? [] : catalogTerms(query.text)
  const ruleIds = query.ruleIds === undefined ? undefined : new Set(query.ruleIds)
  const rules = catalog.rules.filter(rule =>
    (query.ruleClass === undefined || rule.ruleClass === query.ruleClass)
    && (ruleIds === undefined || ruleIds.has(rule.id))
    && (terms.length === 0 || terms.every(term => catalogRuleText(rule).includes(term))))
  const page = paginateProcessPlantSearch(rules, query.offset, query.limit)
  return {
    plantId: payload.plantId,
    ruleCount: catalog.ruleCount,
    total: page.total,
    offset: page.offset,
    returned: page.returned,
    hasMore: page.hasMore,
    rules: page.items,
  }
}
