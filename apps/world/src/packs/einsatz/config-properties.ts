import { configIssue, type ConfigCheck, type ConfigIssue, type ConfigPath } from './config-issues.ts'
import type { Condition, UnitProperty, UnitType } from './config-schema.ts'

type NumberProperty = Extract<UnitProperty, { kind: 'number' }>
const maxBoardProperties = 2

const inRange = (property: NumberProperty, value: number): boolean =>
  (property.min === undefined || value >= property.min) && (property.max === undefined || value <= property.max)

/** A number property's bounds in its own unit: "0–20000 kg", "≥ 0 kg", or "any value". */
export const rangeText = (property: NumberProperty): string => {
  const unit = property.unit === undefined ? '' : ` ${property.unit}`
  if (property.min !== undefined && property.max !== undefined) return `${property.min}–${property.max}${unit}`
  if (property.min !== undefined) return `≥ ${property.min}${unit}`
  if (property.max !== undefined) return `≤ ${property.max}${unit}`
  return `any value${unit}`
}

/** A property's own default and bounds agree with each other. */
const ownConsistency = (property: UnitProperty, at: ConfigPath): ConfigIssue[] => {
  if (property.kind === 'boolean') return []
  if (property.kind === 'enum') {
    return property.values.some(value => value.id === property.default) ? []
      : [configIssue([...at, 'default'], 'unknown_enum_value', `Default "${property.default}" is not a value of "${property.label}"`)]
  }
  if (property.min !== undefined && property.max !== undefined && property.min > property.max) {
    return [configIssue([...at, 'min'], 'invalid_range', `"${property.label}" has minimum ${property.min} above maximum ${property.max}`)]
  }
  return inRange(property, property.default) ? []
    : [configIssue([...at, 'default'], 'default_out_of_range', `Default ${property.default} of "${property.label}" is outside ${rangeText(property)}`)]
}

const unitText = (property: NumberProperty): string => property.unit === undefined ? 'no unit' : property.unit

/** One property id means one thing: the same kind, and for numbers the same unit, on every unit type declaring it. */
const sameMeaning = (property: UnitProperty, type: UnitType, first: { property: UnitProperty; type: UnitType }, at: ConfigPath): ConfigIssue[] => {
  const other = first.property
  if (other.kind !== property.kind) {
    return [configIssue([...at, 'kind'], 'property_conflict', `"${property.id}" is ${property.kind} on "${type.label}" but ${other.kind} on "${first.type.label}"`)]
  }
  if (property.kind === 'number' && other.kind === 'number' && property.unit !== other.unit) {
    return [configIssue([...at, 'unit'], 'property_conflict', `"${property.id}" is in ${unitText(property)} on "${type.label}" but ${unitText(other)} on "${first.type.label}"`)]
  }
  return []
}

/** Defaults, bounds, board slots and cross-type meaning of every declared property. */
export const consistentProperties: ConfigCheck = config => {
  const firstDeclaration = new Map<string, { property: UnitProperty; type: UnitType }>()
  return config.unitTypes.flatMap((type, index) => {
    const at: ConfigPath = ['unitTypes', index, 'properties']
    const boardCount = type.properties.filter(property => property.board).length
    return [
      ...(boardCount > maxBoardProperties
        ? [configIssue(at, 'too_many_board_properties', `"${type.label}" shows ${boardCount} properties on the board; at most ${maxBoardProperties} may`)]
        : []),
      ...type.properties.flatMap((property, entry) => {
        const first = firstDeclaration.get(property.id)
        if (first === undefined) firstDeclaration.set(property.id, { property, type })
        return [
          ...ownConsistency(property, [...at, entry]),
          ...(first === undefined || first.type === type ? [] : sameMeaning(property, type, first, [...at, entry])),
        ]
      }),
    ]
  })
}

const comparisonHint: Readonly<Record<UnitProperty['kind'], string>> = {
  number: 'atLeast or atMost',
  boolean: 'equals true or false',
  enum: 'equals one of its values',
}

/** A comparison names a property some providing type declares, fits its kind, and can be met within its bounds. */
const conditionIssues = (condition: Condition, providers: ReadonlyArray<UnitType>, at: ConfigPath): ConfigIssue[] => {
  const declared = providers.flatMap(type => type.properties.filter(property => property.id === condition.property))
  const property = declared[0]
  if (property === undefined) {
    return [configIssue([...at, 'property'], 'unknown_property', `No unit type providing this requirement declares "${condition.property}"`)]
  }
  const mismatch = [configIssue(at, 'property_kind_mismatch', `"${property.label}" is a ${property.kind} property; compare it with ${comparisonHint[property.kind]}`)]
  if ('equals' in condition) {
    if (typeof condition.equals === 'boolean') return property.kind === 'boolean' ? [] : mismatch
    if (property.kind !== 'enum') return mismatch
    return declared.some(entry => entry.kind === 'enum' && entry.values.some(value => value.id === condition.equals)) ? []
      : [configIssue([...at, 'equals'], 'unknown_enum_value', `"${condition.equals}" is not a value of "${property.label}"`)]
  }
  if (property.kind !== 'number') return mismatch
  const numbers = declared.filter((entry): entry is NumberProperty => entry.kind === 'number')
  const bounds = { atLeast: 'atLeast' in condition ? condition.atLeast : undefined, atMost: condition.atMost }
  return [
    ...(bounds.atLeast !== undefined && bounds.atMost !== undefined && bounds.atLeast > bounds.atMost
      ? [configIssue(at, 'invalid_range', `"${property.label}" cannot be at least ${bounds.atLeast} and at most ${bounds.atMost}`)]
      : []),
    ...(['atLeast', 'atMost'] as const).flatMap(bound => {
      const value = bounds[bound]
      return value === undefined || numbers.some(entry => inRange(entry, value)) ? []
        : [configIssue([...at, bound], 'condition_out_of_range', `${bound} ${value} is outside ${rangeText(property)} for "${property.label}"`)]
    }),
  ]
}

/** Every requirement is provided by some unit type, and its `where` comparisons hold up against the declared properties. */
export const satisfiableRequirements: ConfigCheck = config => config.taskTemplates.flatMap((template, index) =>
  template.requires.flatMap((requirement, entry) => {
    const at: ConfigPath = ['taskTemplates', index, 'requires', entry]
    const providers = config.unitTypes.filter(type => type.components.service?.provides.includes(requirement.provides) === true)
    if (providers.length === 0) return [configIssue([...at, 'provides'], 'unknown_service', `No unit type provides "${requirement.provides}"`)]
    return requirement.where.flatMap((condition, position) => conditionIssues(condition, providers, [...at, 'where', position]))
  }))
