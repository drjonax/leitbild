import type { ProcessLinkBehaviorDefinition } from '../behavior-contract.ts'
import { processLinkChemistryBehaviorDefinitions } from './process-link-chemistry-behaviors.ts'
import { processLinkElectricalBehaviorDefinitions } from './process-link-electrical-behaviors.ts'
import { processLinkFlowBehaviorDefinitions } from './process-link-flow-behaviors.ts'
import { processLinkPressureBehaviorDefinitions } from './process-link-pressure-behaviors.ts'
import { processLinkRadiationBehaviorDefinitions } from './process-link-radiation-behaviors.ts'
import { processLinkTemperatureBehaviorDefinitions } from './process-link-temperature-behaviors.ts'

export const processLinkBehaviorDefinitions: ReadonlyArray<ProcessLinkBehaviorDefinition> = [
  ...processLinkFlowBehaviorDefinitions,
  ...processLinkPressureBehaviorDefinitions,
  ...processLinkTemperatureBehaviorDefinitions,
  ...processLinkRadiationBehaviorDefinitions,
  ...processLinkChemistryBehaviorDefinitions,
  ...processLinkElectricalBehaviorDefinitions,
]
