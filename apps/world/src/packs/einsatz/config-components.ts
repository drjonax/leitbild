import { configIssue, type ConfigCheck, type ConfigIssue, type ConfigPath } from './config-issues.ts'
import type { StandingOrders, UnitComponents } from './config-schema.ts'

/**
 * Component combinations that cannot mean anything: a receiving site neither
 * moves nor takes damage; a public object neither moves, senses nor fires; a
 * sensor identifies no further than it detects. An effector without a sensor,
 * a sensor-only post and a targetable static object are allowed.
 */
export const allowedCombinations: ConfigCheck = config => config.unitTypes.flatMap((type, index) => {
  const at: ConfigPath = ['unitTypes', index]
  const { mobility, receiving, durability, sensor } = type.components
  const publicRefusals = (['mobility', 'sensor', 'effector'] as const).filter(component => type.components[component] !== undefined)
  return [
    ...(receiving !== undefined && mobility !== undefined
      ? [configIssue([...at, 'components', 'receiving'], 'refused_combination', `"${type.label}" receives load, so it cannot have mobility`)]
      : []),
    ...(receiving !== undefined && durability !== undefined
      ? [configIssue([...at, 'components', 'receiving'], 'refused_combination', `"${type.label}" receives load, so it cannot have durability`)]
      : []),
    ...(type.public ? publicRefusals.map(component => configIssue([...at, 'public'], 'refused_combination', `"${type.label}" is public, so it cannot have ${component}`)) : []),
    ...(sensor !== undefined && sensor.identifyM > sensor.detectM
      ? [configIssue([...at, 'components', 'sensor', 'identifyM'], 'identify_exceeds_detect', `"${type.label}" identifies at ${sensor.identifyM} m but detects only at ${sensor.detectM} m`)]
      : []),
  ]
})

/** The components a standing order acts through; without them the order could never fire. */
const orderNeeds: Readonly<Record<keyof StandingOrders, ReadonlyArray<keyof UnitComponents>>> = {
  deliver: ['carry'],
  return: ['mobility'],
  roe: ['effector'],
  withdraw: ['mobility', 'durability'],
  onStepLost: ['durability'],
}
const orders = Object.keys(orderNeeds) as ReadonlyArray<keyof StandingOrders>

export const standingOrderComponents: ConfigCheck = config => config.unitTypes.flatMap((type, index): ConfigIssue[] =>
  orders.flatMap(order => {
    if (type.standingOrders?.[order] === undefined) return []
    const missing = orderNeeds[order].filter(component => type.components[component] === undefined)
    return missing.length === 0 ? []
      : [configIssue(['unitTypes', index, 'standingOrders', order], 'order_requires_component', `Standing order ${order} on "${type.label}" needs ${missing.join(' and ')}`)]
  }))
