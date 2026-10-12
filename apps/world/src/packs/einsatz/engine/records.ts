import type { GeoJsonPoint } from '../../../core/model/index.ts'
import { skipSteps } from './chain-steps.ts'
import { engagementFieldsAtCreate, isTrackId } from './combat-model.ts'
import { coverageOf, rankOf } from './coverage.ts'
import { putUnit, setMotion, stageTask, unitIn, type Draft } from './draft.ts'
import { actionBy, groupRefusal, notInPicture, refused, sideRefusal, type Refused } from './intent-support.ts'
import type { EngineActor, IntentOf, Plan } from './intents.ts'
import { clearAlerts, templateOf, unitTypeOf, workReturnedCode, type EngineState, type PropertyValue, type TaskRecord, type UnitRecord } from './model.ts'
import { conditionReasons, isSite, meetsRequirement, propertyRefusal } from './rules.ts'
import { byId, countsOf, patch } from './values.ts'
import type { UnitType } from '../config-schema.ts'

const applied = (apply: (draft: Draft) => void): Plan => ({ ok: true, routes: [], notes: [], apply: draft => apply(draft) })

const idTaken = (state: EngineState, id: string): Refused | undefined =>
  state.units.has(id) || state.tasks.has(id) ? refused('duplicate_id', `${id} already exists`)
    : isTrackId(id) ? refused('reserved_id', `${id} is reserved: ids starting with track: or tracks: name tracks`)
    : undefined

const propertiesRefusal = (type: UnitType, properties: Readonly<Record<string, PropertyValue>>): Refused | undefined => {
  for (const [id, value] of Object.entries(properties)) {
    const reason = propertyRefusal(type, id, value)
    if (reason !== undefined) return { ok: false, reason }
  }
  return undefined
}

const samePoint = (a: GeoJsonPoint, b: GeoJsonPoint): boolean => a.coordinates[0] === b.coordinates[0] && a.coordinates[1] === b.coordinates[1]

/** A new unit of a declared type, at rest; unnamed properties take the type's defaults. */
export const planUnitCreate = (state: EngineState, intent: IntentOf<'unit.create'>, actor: EngineActor): Plan => {
  const taken = idTaken(state, intent.id)
  if (taken) return taken
  const type = state.catalog.types.get(intent.type)
  if (type === undefined) return refused('unknown_unit_type', `Unit type "${intent.type}" is not declared`)
  const sided = sideRefusal(state, intent.side, type.public, type.label)
  if (sided) return sided
  const grouped = groupRefusal(state, intent, type.public, type.label)
  if (grouped) return grouped
  const invalid = propertiesRefusal(type, intent.properties ?? {})
  if (invalid) return invalid
  return applied(draft => {
    const base = intent.base ?? intent.at
    const receiving = type.components.receiving
    draft.motion.set(intent.id, { point: intent.at, progressMs: 0, impacts: [] })
    putUnit(draft, {
      id: intent.id,
      label: intent.label,
      type: 'unit',
      unitType: type.id,
      ...(intent.side === undefined ? {} : { side: intent.side }),
      ...(intent.group === undefined ? {} : { group: intent.group }),
      presentation: { icon: type.icon, typeLabel: type.label },
      base,
      atBase: samePoint(base, intent.at),
      properties: Object.fromEntries(type.properties.map(property => [property.id, intent.properties?.[property.id] ?? property.default])),
      phase: 'available',
      phaseSinceMs: draft.timeMs,
      integrity: 'healthy',
      load: {},
      ...(receiving === undefined ? {} : { accepting: receiving.accepting, received: {} }),
      lastAction: actionBy(draft, actor, 'create'),
      alerts: [],
      orders: [],
      ...engagementFieldsAtCreate(type, draft.timeMs, draft.sides.length > 0),
    })
  })
}

/** New property values, validated against the type; a committed unit may not fall below its task's `where`. */
export const planUnitAdjust = (state: EngineState, intent: IntentOf<'unit.adjust'>, actor: EngineActor): Plan => {
  const unit = state.units.get(intent.unitId)
  if (unit === undefined) return notInPicture()
  const invalid = propertiesRefusal(unitTypeOf(state.catalog, unit), intent.properties)
  if (invalid) return invalid
  const adjusted = patch(unit, { properties: { ...unit.properties, ...intent.properties } })
  const task = unit.taskId === undefined ? undefined : state.tasks.get(unit.taskId)
  if (task !== undefined) {
    for (const requirement of templateOf(state.catalog, task).requires) {
      if (!meetsRequirement(state.catalog, unit, requirement)) continue
      const [reason] = conditionReasons(state.catalog, adjusted, requirement)
      if (reason !== undefined) return refused('requirement_unmet', `${task.label}: ${reason}`)
    }
  }
  return applied(draft => {
    putUnit(draft, patch(unitIn(draft, unit.id), { properties: adjusted.properties, lastAction: actionBy(draft, actor, 'adjust', undefined, intent.reason) }))
  })
}

/** New demand on a side. A task without load ranks by its template's floor, so a load-less task needs one. */
export const planTaskCreate = (state: EngineState, intent: IntentOf<'task.create'>, actor: EngineActor): Plan => {
  const taken = idTaken(state, intent.id)
  if (taken) return taken
  const template = state.catalog.templates.get(intent.template)
  if (template === undefined) return refused('unknown_task_template', `Task template "${intent.template}" is not declared`)
  const sided = sideRefusal(state, intent.side, false, template.label)
  if (sided) return sided
  const loads = intent.loads ?? {}
  const unknown = Object.keys(loads).find(id => !state.catalog.classRank.has(id))
  if (unknown !== undefined) return refused('unknown_load_class', `Load class "${unknown}" is not declared`)
  if (Object.keys(loads).length === 0 && template.priorityClass === undefined) {
    return refused('priority_class_required', `${template.label} has no priority floor, so the task needs load`)
  }
  return applied(draft => {
    const fields = {
      id: intent.id,
      template: template.id,
      loads: countsOf(draft.catalog.classIds.map(id => [id, loads[id] ?? 0] as const)),
      served: {},
    }
    const task: TaskRecord = {
      ...fields,
      label: intent.label,
      type: 'task',
      ...(intent.side === undefined ? {} : { side: intent.side }),
      presentation: { icon: template.icon, typeLabel: template.label },
      point: intent.at,
      createdAtMs: draft.timeMs,
      pickedUp: {},
      rank: rankOf(draft.catalog, fields),
      coverage: coverageOf(draft.catalog, fields, []),
      lastAction: actionBy(draft, actor, 'create'),
      alerts: [],
    }
    stageTask(draft, task)
  })
}

/**
 * Closes a task, dropping load not yet picked up; units still committed to
 * it stop and are free. Its step is skipped on every chain, and each chain
 * goes on.
 */
export const planTaskClose = (state: EngineState, intent: IntentOf<'task.close'>, actor: EngineActor): Plan => {
  const task = state.tasks.get(intent.taskId)
  if (task === undefined) return notInPicture()
  if (task.closedAtMs !== undefined) return refused('task_closed', `${task.label} is closed`)
  return applied(draft => {
    for (const unit of [...draft.units.values()].filter(entry => entry.taskId === task.id).sort(byId)) {
      setMotion(draft, unit.id, { progressMs: 0 })
      const freed = skipSteps(unit, draft.timeMs, step => 'taskId' in step.target && step.target.taskId === task.id ? { label: task.label, reason: 'closed' } : undefined)
      putUnit(draft, patch(freed, {
        taskId: undefined, leg: undefined, phase: 'available', phaseSinceMs: draft.timeMs, phaseDueMs: undefined,
        lastAction: actionBy(draft, actor, 'release', task.id, `${task.label} closed`),
      }))
    }
    stageTask(draft, patch(task, {
      closedAtMs: draft.timeMs, alerts: clearAlerts(task.alerts, [workReturnedCode]), coverage: coverageOf(draft.catalog, task, []),
      lastAction: actionBy(draft, actor, 'close', undefined, intent.reason),
    }))
  })
}

/**
 * Opens or closes a site to arrivals. When it stops accepting, units under
 * a `deliver` order still heading there or queued there stop, their delivery
 * step skipped, and deliver elsewhere at once; others keep going and wait.
 * Handovers under way finish. A queued delivery to a closed site is skipped
 * when it would start.
 */
export const planSiteSet = (state: EngineState, intent: IntentOf<'site.set'>, actor: EngineActor): Plan => {
  const site = state.units.get(intent.siteId)
  if (site === undefined) return notInPicture()
  if (!isSite(state.catalog, site)) return refused('not_a_site', `${site.label} does not receive load`)
  if (site.accepting === intent.accepting) return { ok: true, routes: [], notes: [`${site.label} already ${intent.accepting ? 'accepting' : 'not accepting'}`], apply: () => undefined }
  return applied(draft => {
    putUnit(draft, patch(unitIn(draft, site.id), { accepting: intent.accepting, lastAction: actionBy(draft, actor, 'set') }))
    if (intent.accepting) return
    const rerouted = [...draft.units.values()].filter((unit: UnitRecord) => unit.siteId === site.id
      && (unit.phase === 'transporting' || (unit.phase === 'at-site' && unit.phaseDueMs === undefined))
      && unitTypeOf(draft.catalog, unit).standingOrders?.deliver === 'nearest-accepting').sort(byId)
    for (const unit of rerouted) {
      setMotion(draft, unit.id, { progressMs: 0 })
      const delivering = skipSteps(unit, draft.timeMs, step => step.state === 'active' ? { label: site.label, reason: 'stopped accepting' } : undefined)
      putUnit(draft, patch(delivering, {
        phase: 'holding', leg: undefined, siteId: undefined, phaseSinceMs: draft.timeMs,
        lastAction: actionBy(draft, actor, 'release', site.id, `${site.label} stopped accepting`),
      }))
    }
  })
}
