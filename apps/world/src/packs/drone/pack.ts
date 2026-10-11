import type { WorldPack } from '../../core/packs/protocol.ts'
import { dronePackConfigSchema } from './config.ts'
import { createDroneAttackInteractionHandler } from './interactions.ts'
import { defaultDroneVehicleModels } from './model.ts'
import { droneScenarioSupport } from './scenario.ts'
import { dronePackView } from './ui-pack.ts'

export const dronePack: WorldPack = {
  ...dronePackView,
  scenarioConfigSchema: dronePackConfigSchema,
  authoring: {
    configFields: [
      { path: ['maxDrones'], label: 'Maximum drones', control: { kind: 'number', step: 1 } },
    ],
    itemTypes: [{
      id: 'drone',
      label: 'Drone',
      description: 'A simulated aircraft with a selected vehicle model, starting altitude, and heading.',
      idPrefix: 'drone',
      defaultItem: {
        modelId: 'native-survey-quad',
        altitudeM: 35,
        headingDeg: 0,
      },
      placement: { kind: 'point', path: ['position'] },
      fields: [{
        path: ['modelId'], label: 'Vehicle model',
        control: {
          kind: 'select',
          options: defaultDroneVehicleModels.map(model => ({ value: model.id, label: model.label })),
          extendFromConfig: { path: ['models'], valueKey: 'id', labelKey: 'label' },
        },
      }, {
        path: ['altitudeM'], label: 'Altitude (m)',
        control: { kind: 'number', step: 5 },
      }, {
        path: ['headingDeg'], label: 'Heading (degrees)',
        control: { kind: 'number', min: 0, max: 360, step: 5 },
      }],
    }],
  },
  knowledge: { wikiRefs: [{ name: 'Drone knowledge', url: '/wiki?path=world%2Fpacks%2Fdrone%2Findex.md' }] },
  interactions: { handlers: [createDroneAttackInteractionHandler()] },
  scenario: droneScenarioSupport,
}
