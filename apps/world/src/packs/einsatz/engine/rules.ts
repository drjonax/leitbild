import { rangeText } from '../config-properties.ts'
import type { Requirement, UnitType } from '../config-schema.ts'
import { refusal } from '../refusal.ts'
import { unitTypeOf, type Catalog, type PropertyValue, type TaskRecord, type UnitRecord } from './model.ts'
import { total } from './values.ts'
import { numberBoundText, propertyValueText } from './wording.ts'

/** Phases in which a unit travels along its leg. */
export const movingPhases: ReadonlyArray<UnitRecord['phase']> = ['en-route', 'transporting', 'returning']
/** Phases of a unit committed to a task: turning out, on its way, or on task. */
export const committedPhases: ReadonlyArray<UnitRecord['phase']> = ['mobilizing', 'en-route', 'on-task']
/** Phases from which a committed unit may still be diverted: it has not arrived. */
export const divertablePhases: ReadonlyArray<UnitRecord['phase']> = ['mobilizing', 'en-route']

export const isMoving = (unit: UnitRecord): boolean => movingPhases.includes(unit.phase)
export const isDestroyed = (unit: UnitRecord): boolean => unit.integrity === 'destroyed'
export const hasLoad = (unit: UnitRecord): boolean => total(unit.load) > 0
export const isSite = (catalog: Catalog, unit: UnitRecord): boolean => unitTypeOf(catalog, unit).components.receiving !== undefined

/** Free: no task and no load, not destroyed, in any phase. A point move or a hold never commits a unit. */
export const isFree = (unit: UnitRecord): boolean => unit.taskId === undefined && !hasLoad(unit) && !isDestroyed(unit)

/**
 * The same-side linkage invariant. A unit may be sent to, counted towards
 * or deliver to only a task or site that is public or its own side's. In
 * open mode nothing has a side, so everything links.
 */
export const linksToTask = (unit: UnitRecord, task: TaskRecord): boolean => unit.side === task.side
export const linksToSite = (catalog: Catalog, unit: UnitRecord, site: UnitRecord): boolean =>
  unitTypeOf(catalog, site).public || unit.side === site.side

export const providesFor = (type: UnitType, requirement: Requirement): boolean =>
  type.components.service?.provides.includes(requirement.provides) === true

const declaredLabel = (catalog: Catalog, propertyId: string): string => {
  const property = catalog.config.unitTypes.flatMap(type => type.properties).find(entry => entry.id === propertyId)
  if (property === undefined) throw new Error(`Property ${propertyId} is not declared`)
  return property.label
}

/**
 * Why a unit fails a requirement's `where` comparisons, one reason per
 * failed comparison, in property and configuration words: "Unit 2 ·
 * Payload 300 kg · needs ≥ 500 kg". A unit whose type lacks the property is
 * ineligible: "Payload not declared on Scout".
 */
export const conditionReasons = (catalog: Catalog, unit: UnitRecord, requirement: Requirement): string[] => {
  const type = unitTypeOf(catalog, unit)
  return requirement.where.flatMap(condition => {
    const property = type.properties.find(entry => entry.id === condition.property)
    if (property === undefined) return [`${declaredLabel(catalog, condition.property)} not declared on ${type.label}`]
    const value = unit.properties[property.id]
    if (value === undefined) throw new Error(`${unit.id}: property ${property.id} has no value`)
    const failed = (expected: string): string => `${unit.label} · ${property.label} ${propertyValueText(property, value)} · needs ${expected}`
    if ('equals' in condition) return value === condition.equals ? [] : [failed(propertyValueText(property, condition.equals))]
    if (typeof value !== 'number') throw new Error(`${unit.id}: property ${property.id} is not a number`)
    const atLeast = 'atLeast' in condition ? condition.atLeast : undefined
    return [
      ...(atLeast !== undefined && value < atLeast ? [failed(numberBoundText(property, 'atLeast', atLeast))] : []),
      ...(condition.atMost !== undefined && value > condition.atMost ? [failed(numberBoundText(property, 'atMost', condition.atMost))] : []),
    ]
  })
}

/** A unit meets a requirement when its type provides the service and its properties pass every `where` comparison. */
export const meetsRequirement = (catalog: Catalog, unit: UnitRecord, requirement: Requirement): boolean =>
  providesFor(unitTypeOf(catalog, unit), requirement) && conditionReasons(catalog, unit, requirement).length === 0

/** Why a property value cannot be set on a unit of this type, as an Einsatz refusal; undefined when it can. */
export const propertyRefusal = (type: UnitType, propertyId: string, value: PropertyValue): string | undefined => {
  const property = type.properties.find(entry => entry.id === propertyId)
  if (property === undefined) return refusal('unknown_property', `${type.label} declares no property "${propertyId}"`)
  const mismatch = refusal('property_kind_mismatch', `${property.label} is a ${property.kind} property`)
  if (property.kind === 'boolean') return typeof value === 'boolean' ? undefined : mismatch
  if (property.kind === 'enum') {
    if (typeof value !== 'string') return mismatch
    return property.values.some(entry => entry.id === value) ? undefined : refusal('unknown_enum_value', `"${value}" is not a value of ${property.label}`)
  }
  if (typeof value !== 'number') return mismatch
  const inRange = (property.min === undefined || value >= property.min) && (property.max === undefined || value <= property.max)
  return inRange ? undefined : refusal('property_out_of_range', `${property.label} ${value} is outside ${rangeText(property)}`)
}
