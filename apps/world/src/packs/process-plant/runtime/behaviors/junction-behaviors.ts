import type { ComponentBehaviorDefinition, ComponentInitialReconciliationDefinition } from '../behavior-contract.ts'
import { headerBehaviorDefinitions, headerInitialReconciliationDefinitions } from './junction/header-behaviors.ts'
import { valveBehaviorDefinitions, valveInitialReconciliationDefinitions } from './junction/valve-behaviors.ts'

export const junctionInitialReconciliationDefinitions: ReadonlyArray<ComponentInitialReconciliationDefinition> = [
  ...valveInitialReconciliationDefinitions,
  ...headerInitialReconciliationDefinitions,
]

export const junctionBehaviorDefinitions: ReadonlyArray<ComponentBehaviorDefinition> = [
  ...valveBehaviorDefinitions,
  ...headerBehaviorDefinitions,
]
