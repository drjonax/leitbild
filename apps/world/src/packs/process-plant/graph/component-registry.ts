import type { ComponentDefinition, ComponentKind } from './model.ts'
import { accumulatorComponentDefinitions } from './accumulator-component-definitions.ts'
import { balanceOfPlantComponentDefinitions } from './balance-of-plant-component-definitions.ts'
import { boundaryComponentDefinitions } from './boundary-component-definitions.ts'
import { containmentComponentDefinitions } from './containment-component-definitions.ts'
import { heatExchangerComponentDefinitions } from './heat-exchanger-component-definitions.ts'
import { instrumentationComponentDefinitions } from './instrumentation-component-definitions.ts'
import { electricalComponentDefinitions } from './electrical-component-definitions.ts'
import { junctionComponentDefinitions } from './junction-component-definitions.ts'
import { pressurizerComponentDefinitions } from './pressurizer-component-definitions.ts'
import { pumpComponentDefinitions } from './pump-component-definitions.ts'
import { reactorComponentDefinitions } from './reactor-component-definitions.ts'
import { steamGeneratorComponentDefinitions } from './steam-generator-component-definitions.ts'

export const processPlantComponentDefinitions: ReadonlyArray<ComponentDefinition> = [
  ...reactorComponentDefinitions,
  ...junctionComponentDefinitions,
  ...pressurizerComponentDefinitions,
  ...steamGeneratorComponentDefinitions,
  ...pumpComponentDefinitions,
  ...balanceOfPlantComponentDefinitions,
  ...heatExchangerComponentDefinitions,
  ...containmentComponentDefinitions,
  ...boundaryComponentDefinitions,
  ...accumulatorComponentDefinitions,
  ...electricalComponentDefinitions,
  ...instrumentationComponentDefinitions,
]

export const processPlantComponentRegistry: ReadonlyMap<ComponentKind, ComponentDefinition> = new Map(
  processPlantComponentDefinitions.map(definition => [definition.kind, definition]),
)
