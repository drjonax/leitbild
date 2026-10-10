import type { ComponentInitialValueDefinition } from './model.ts'

// An instrument channel computes from the plant's state, so its values are
// set by its initial reconciliation once that state exists; these only give
// the table its entries.
const channelPaths = new Set(['deltaTC', 'averageTemperatureC', 'overtemperatureSetpointC', 'overpowerSetpointC', 'overtemperatureMarginC', 'overpowerMarginC'])

export const instrumentationInitialValueDefinitions: ReadonlyArray<ComponentInitialValueDefinition> = [
  {
    componentKind: 'deltaTProtectionChannel',
    initialValueFor: (_component, localPath) => channelPaths.has(localPath) ? 0 : undefined,
  },
]
