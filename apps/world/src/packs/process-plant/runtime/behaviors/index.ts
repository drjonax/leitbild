import type {
  ComponentBehaviorDefinition,
  ComponentInitialReconciliationDefinition,
} from '../behavior-contract.ts'
import type { ComponentKind } from '../../graph/index.ts'
import { accumulatorBehaviorDefinitions } from './accumulator-behaviors.ts'
import { balanceOfPlantBehaviorDefinitions } from './balance-of-plant-behaviors.ts'
import { boundaryBehaviorDefinitions } from './boundary-behaviors.ts'
import { containmentBehaviorDefinitions } from './containment-behaviors.ts'
import { electricalBehaviorDefinitions, electricalInitialReconciliationDefinitions } from './electrical-behaviors.ts'
import { heatExchangerBehaviorDefinitions } from './heat-exchanger-behaviors.ts'
import { instrumentationBehaviorDefinitions, instrumentationInitialReconciliationDefinitions } from './instrumentation-behaviors.ts'
import { junctionBehaviorDefinitions, junctionInitialReconciliationDefinitions } from './junction-behaviors.ts'
import { pressurizerBehaviorDefinitions, pressurizerInitialReconciliationDefinitions } from './pressurizer-behaviors.ts'
import { pumpBehaviorDefinitions, pumpInitialReconciliationDefinitions } from './pump-behaviors.ts'
import { reactorBehaviorDefinitions, reactorInitialReconciliationDefinitions } from './reactor-behaviors.ts'
import { steamGeneratorBehaviorDefinitions } from './steam-generator-behaviors.ts'

const behaviorDefinitionsByFamily: ReadonlyArray<ComponentBehaviorDefinition> = [
  ...reactorBehaviorDefinitions,
  ...balanceOfPlantBehaviorDefinitions,
  ...heatExchangerBehaviorDefinitions,
  ...containmentBehaviorDefinitions,
  ...boundaryBehaviorDefinitions,
  ...accumulatorBehaviorDefinitions,
  ...junctionBehaviorDefinitions,
  ...electricalBehaviorDefinitions,
  ...pumpBehaviorDefinitions,
  ...steamGeneratorBehaviorDefinitions,
  ...pressurizerBehaviorDefinitions,
  ...instrumentationBehaviorDefinitions,
]

const behaviorDefinitionById = (id: string): ComponentBehaviorDefinition => {
  const behavior = behaviorDefinitionsByFamily.find(definition => definition.id === id)
  if (!behavior) throw new Error(`missing component behavior definition ${id}`)
  return behavior
}

export const componentBehaviorDefinitions: ReadonlyArray<ComponentBehaviorDefinition> = [
  behaviorDefinitionById('reactor-core-reactivity-control'),
  behaviorDefinitionById('processValve-position-controller'),
  behaviorDefinitionById('steamValve-position-controller'),
  behaviorDefinitionById('processValve-effective-position'),
  behaviorDefinitionById('steamValve-effective-position'),
  behaviorDefinitionById('electrical-grid-source'),
  behaviorDefinitionById('diesel-generator-start-and-power'),
  behaviorDefinitionById('battery-discharge'),
  behaviorDefinitionById('electrical-breaker-propagation'),
  behaviorDefinitionById('electrical-transformer-propagation'),
  behaviorDefinitionById('inverter-propagation'),
  behaviorDefinitionById('electrical-bus-propagation'),
  behaviorDefinitionById('turbine-electrical-output'),
  behaviorDefinitionById('centrifugal-pump-flow'),
  behaviorDefinitionById('centrifugal-pump-primary-loop-inertia'),
  behaviorDefinitionById('reactor-core-heat-to-coolant'),
  behaviorDefinitionById('steam-generator-heat-transfer'),
  behaviorDefinitionById('steam-generator-tube-leak-transfer'),
  behaviorDefinitionById('reactor-core-power-state'),
  // The loops' inventory sets the surge the pressurizer then takes.
  behaviorDefinitionById('reactor-vessel-primary-inventory-state'),
  behaviorDefinitionById('pressurizer-pressure-inventory-state'),
  behaviorDefinitionById('process-tank-inventory-state'),
  behaviorDefinitionById('reactor-core-coolant-temperature-state'),
  behaviorDefinitionById('steam-generator-inventory-pressure-state'),
  behaviorDefinitionById('condenser-steam-sink-state'),
  behaviorDefinitionById('heat-exchanger-thermal-transfer'),
  behaviorDefinitionById('containment-lumped-atmosphere-sump'),
  behaviorDefinitionById('atmosphere-boundary-release'),
  behaviorDefinitionById('accumulator-pressure-driven-discharge'),
  behaviorDefinitionById('processValve-flow-diagnostics'),
  behaviorDefinitionById('steamValve-flow-diagnostics'),
  behaviorDefinitionById('processHeader-mixing-diagnostics'),
  behaviorDefinitionById('steamHeader-mixing-diagnostics'),
  behaviorDefinitionById('electrical-load-service'),
  behaviorDefinitionById('delta-t-protection-channel'),
  behaviorDefinitionById('rcs-inventory-balance'),
  behaviorDefinitionById('safety-injection-block-logic'),
]

export const componentInitialReconciliationDefinitions: ReadonlyArray<ComponentInitialReconciliationDefinition> = [
  ...pumpInitialReconciliationDefinitions,
  ...electricalInitialReconciliationDefinitions,
  ...instrumentationInitialReconciliationDefinitions,
  ...pressurizerInitialReconciliationDefinitions,
  ...reactorInitialReconciliationDefinitions,
  ...junctionInitialReconciliationDefinitions,
]

/**
 * Code provenance for the deliberately inspectable reference runtime. This is
 * kept beside behavior registration so adding a component implementation has
 * one review point and does not leak source paths into Plant specifications.
 */
export const processPlantComponentBehaviorSourcePathByKind: ReadonlyMap<ComponentKind, string> = new Map([
  ['reactorCore' as ComponentKind, 'src/packs/process-plant/runtime/behaviors/reactor-behaviors.ts'],
  ['reactorVessel' as ComponentKind, 'src/packs/process-plant/runtime/behaviors/reactor-behaviors.ts'],
  ['processTank' as ComponentKind, 'src/packs/process-plant/runtime/behaviors/balance-of-plant-behaviors.ts'],
  ['turbineLoadSink' as ComponentKind, 'src/packs/process-plant/runtime/behaviors/balance-of-plant-behaviors.ts'],
  ['condenserSink' as ComponentKind, 'src/packs/process-plant/runtime/behaviors/balance-of-plant-behaviors.ts'],
  ['heatExchanger' as ComponentKind, 'src/packs/process-plant/runtime/behaviors/heat-exchanger-behaviors.ts'],
  ['containmentVolume' as ComponentKind, 'src/packs/process-plant/runtime/behaviors/containment-behaviors.ts'],
  ['atmosphereBoundary' as ComponentKind, 'src/packs/process-plant/runtime/behaviors/boundary-behaviors.ts'],
  ['accumulator' as ComponentKind, 'src/packs/process-plant/runtime/behaviors/accumulator-behaviors.ts'],
  ['processHeader' as ComponentKind, 'src/packs/process-plant/runtime/behaviors/junction/header-behaviors.ts'],
  ['steamHeader' as ComponentKind, 'src/packs/process-plant/runtime/behaviors/junction/header-behaviors.ts'],
  ['processValve' as ComponentKind, 'src/packs/process-plant/runtime/behaviors/junction/valve-behaviors.ts'],
  ['steamValve' as ComponentKind, 'src/packs/process-plant/runtime/behaviors/junction/valve-behaviors.ts'],
  ['electricalGridSource' as ComponentKind, 'src/packs/process-plant/runtime/behaviors/electrical-behaviors.ts'],
  ['electricalBus' as ComponentKind, 'src/packs/process-plant/runtime/behaviors/electrical-behaviors.ts'],
  ['electricalBreaker' as ComponentKind, 'src/packs/process-plant/runtime/behaviors/electrical-behaviors.ts'],
  ['electricalTransformer' as ComponentKind, 'src/packs/process-plant/runtime/behaviors/electrical-behaviors.ts'],
  ['dieselGenerator' as ComponentKind, 'src/packs/process-plant/runtime/behaviors/electrical-behaviors.ts'],
  ['battery' as ComponentKind, 'src/packs/process-plant/runtime/behaviors/electrical-behaviors.ts'],
  ['inverter' as ComponentKind, 'src/packs/process-plant/runtime/behaviors/electrical-behaviors.ts'],
  ['electricalLoad' as ComponentKind, 'src/packs/process-plant/runtime/behaviors/electrical-behaviors.ts'],
  ['centrifugalPump' as ComponentKind, 'src/packs/process-plant/runtime/behaviors/pump-behaviors.ts'],
  ['steamGenerator' as ComponentKind, 'src/packs/process-plant/runtime/behaviors/steam-generator-behaviors.ts'],
  ['pressurizer' as ComponentKind, 'src/packs/process-plant/runtime/behaviors/pressurizer-behaviors.ts'],
  ['deltaTProtectionChannel' as ComponentKind, 'src/packs/process-plant/runtime/behaviors/instrumentation-behaviors.ts'],
  ['rcsInventoryBalance' as ComponentKind, 'src/packs/process-plant/runtime/behaviors/instrumentation-behaviors.ts'],
  ['safetyInjectionBlockLogic' as ComponentKind, 'src/packs/process-plant/runtime/behaviors/instrumentation-behaviors.ts'],
])
