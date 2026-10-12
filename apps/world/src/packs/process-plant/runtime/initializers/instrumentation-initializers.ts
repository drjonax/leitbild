import type { ComponentInitialValueDefinition } from './model.ts'

// An instrument channel computes from the plant's state, so its values are
// set by its initial reconciliation once that state exists; these only give
// the table its entries.
const channelPaths = new Set(['deltaTC', 'averageTemperatureC', 'overtemperatureSetpointC', 'overpowerSetpointC', 'overtemperatureMarginC', 'overpowerMarginC', 'deltaTPowerPercent', 'loopFlowFraction'])

export const instrumentationInitialValueDefinitions: ReadonlyArray<ComponentInitialValueDefinition> = [
  {
    componentKind: 'deltaTProtectionChannel',
    initialValueFor: (_component, localPath) => channelPaths.has(localPath) ? 0 : localPath === 'forcedFlow' ? false : undefined,
  },
  {
    componentKind: 'safetyInjectionBlockLogic',
    initialValueFor: (_component, localPath) => localPath === 'blockPushbutton' || localPath === 'blocked' || localPath === 'belowP11' ? false : undefined,
  },
  {
    componentKind: 'manualActuation',
    initialValueFor: (_component, localPath) => localPath === 'pushbutton' || localPath === 'demanded' ? false : undefined,
  },
  {
    componentKind: 'rcsInventoryBalance',
    initialValueFor: (_component, localPath) => localPath === 'leakRateKgPerS' || localPath === 'balancedInventoryKg' ? 0 : undefined,
  },
]
