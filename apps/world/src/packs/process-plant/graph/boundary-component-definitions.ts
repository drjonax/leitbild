import { z } from 'zod'
import type { ComponentDefinition, ComponentKind } from './model.ts'
import { defineComponent, variable } from './component-definition-helpers.ts'
import { fixedSemantics } from './semantics.ts'

// The open air outside the Plant's buildings, where steam relieved to
// atmosphere (main steam safety valves, atmospheric dump valves) leaves the
// Plant. It holds no inventory and its pressure does not rise with what it
// receives; it totals the release, so a discharge to the environment is seen.
export const boundaryComponentDefinitions: ReadonlyArray<ComponentDefinition> = [
  defineComponent({
    kind: 'atmosphereBoundary' as ComponentKind,
    label: 'Atmosphere Boundary',
    ports: {
      releaseIn: { kind: 'steam', direction: 'in', circuit: 'release' },
    },
    parametersSchema: z.object({
      pressureMPa: z.number().finite().positive(),
    }).strict(),
    semantics: fixedSemantics({ keyValues: ['releaseFlowKgPerS', 'releasedMassKg'] }),
    variables: [
      variable({ path: 'pressureMPa', label: 'Atmospheric pressure', kind: 'state', discipline: 'thermal', writable: false, publish: 'telemetry', quantity: 'pressure', unit: 'MPa' }),
      variable({ path: 'releaseFlowKgPerS', label: 'Release flow to atmosphere', kind: 'derived', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'flowRate', unit: 'kg/s' }),
      variable({ path: 'releasedMassKg', label: 'Mass released to atmosphere', kind: 'state', discipline: 'hydraulic', writable: false, publish: 'telemetry', quantity: 'mass', unit: 'kg' }),
    ],
  }),
]
