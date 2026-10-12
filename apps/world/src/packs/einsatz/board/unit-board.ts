import type { BoardRecords, BoardUnit } from './records.ts'
import { isFree, type BoardRules } from './rules.ts'
import { clockText, loadText, propertyText, unitWord } from './text.ts'
import type { UnitRow } from './types.ts'

/**
 * The unit board: the units the viewer commands that can move, free first,
 * then in id order. Places that only receive or stand (sites, depots) are
 * targets, not rows.
 */

export const boardUnits = (rules: BoardRules, records: BoardRecords): ReadonlyArray<BoardUnit> =>
  [...records.units.values()]
    .filter(unit => rules.commands(unit) && rules.typeOf(unit).components.mobility !== undefined)
    .sort((a, b) => Number(isFree(b)) - Number(isFree(a)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

export const unitRow = (rules: BoardRules, records: BoardRecords, unit: BoardUnit, context: {
  readonly nowMs: number
  readonly selected: boolean
  readonly moveArmed: boolean
}): UnitRow => {
  const type = rules.typeOf(unit)
  const task = unit.taskId === undefined ? undefined : records.tasks.get(unit.taskId)
  const site = unit.siteId === undefined ? undefined : records.units.get(unit.siteId)
  const load = loadText(rules, unit.load)
  return {
    id: unit.id,
    label: unit.label,
    typeLabel: type.label,
    icon: type.icon,
    phaseText: unitWord(rules, unit, unit.phase),
    phaseAgeText: clockText((context.nowMs - unit.phaseSinceMs) / 1_000),
    taskText: task?.label ?? site?.label ?? null,
    etaText: unit.etaSeconds === undefined ? null : clockText(unit.etaSeconds),
    loadText: load === '' ? null : load,
    properties: type.properties.filter(property => property.board).map(property => ({ label: property.label, value: propertyText(property, unit.properties[property.id]) })),
    integrityText: unit.integrity === 'healthy' ? null : unit.integrity === 'destroyed' ? unitWord(rules, unit, 'destroyed') : 'damaged',
    alerts: unit.alerts.map(alert => alert.message),
    free: isFree(unit),
    selected: context.selected,
    moveArmed: context.moveArmed,
  }
}
