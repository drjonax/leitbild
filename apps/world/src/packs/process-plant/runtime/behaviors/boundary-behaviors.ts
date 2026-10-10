import { componentVariablePath, type ComponentBehaviorDefinition } from '../behavior-contract.ts'
import { parameterNumber } from '../component-helpers.ts'
import { sumIncomingLinkValue } from '../links/link-flow-helpers.ts'

export const boundaryBehaviorDefinitions: ReadonlyArray<ComponentBehaviorDefinition> = [
  {
    id: 'atmosphere-boundary-release',
    phase: 'updateComponentState',
    componentKind: 'atmosphereBoundary',
    reads: ['incoming:flowKgPerS', 'releasedMassKg'],
    writes: ['pressureMPa', 'releaseFlowKgPerS', 'releasedMassKg'],
    update: ({ system, component, context }): void => {
      // The atmosphere takes whatever is relieved to it at its own pressure.
      const releaseFlow = sumIncomingLinkValue(system, component.index, 'flowKgPerS', context, () => true)
      const releasedMass = componentVariablePath(component, 'releasedMassKg')
      context.write(componentVariablePath(component, 'pressureMPa'), parameterNumber(component, 'pressureMPa'))
      context.write(componentVariablePath(component, 'releaseFlowKgPerS'), releaseFlow)
      context.write(releasedMass, context.readNumber(releasedMass) + Math.max(0, releaseFlow) * context.dtSeconds)
    },
  },
]
