import type { WorldPack } from '../../core/packs/protocol.ts'
import { electricGridPackConfigSchema } from './config.ts'
import {
  electricGridDefinitionCatalog,
  gridModelCatalogEntry,
  norwayGridModelRef,
  norwayWinterPeakOperatingPointRef,
  nordicFrequencyAutomationRef,
} from './definition-refs.ts'
import { electricGridRecordingProfiles, gridRecordingSeriesCount } from './recording.ts'
import { electricGridPackDataSchema } from './model.ts'
import { electricGridScenarioSupport } from './scenario.ts'
import { electricGridPackView } from './ui-pack.ts'
import { gridObservationDeclarationsQuery } from './observation/declarations.ts'
import { gridObservationReadQuery } from './observation/read.ts'
import { gridObservationTopologyQuery } from './observation/topology.ts'

export const electricGridPack: WorldPack = {
  ...electricGridPackView,
  scenarioConfigSchema: electricGridPackConfigSchema,
  referenceData: { builders: [], datasetIds: electricGridPackView.referenceData?.datasetIds ?? [] },
  authoring: {
    itemTypes: [{
      id: 'grid',
      label: 'Electric grid',
      description: 'A map-visible Grid backed by a selected model, operating point, and automation definition.',
      idPrefix: 'grid',
      defaultItem: {
        model: { ref: norwayGridModelRef },
        operatingPoint: { ref: norwayWinterPeakOperatingPointRef },
        automation: { ref: nordicFrequencyAutomationRef },
      },
      placement: { kind: 'point', path: ['location'] },
      fields: [{
        path: ['model', 'ref'], label: 'Grid Model',
        control: { kind: 'select', options: electricGridDefinitionCatalog.models.map(model => ({ value: model.id, label: model.title })) },
      }, {
        path: ['operatingPoint', 'ref'], label: 'Operating Point',
        control: { kind: 'select', options: electricGridDefinitionCatalog.operatingPoints.map(point => ({ value: point.id, label: point.title, compatibleWith: { path: ['model', 'ref'], values: point.compatibleModelRefs } })) },
      }, {
        path: ['automation', 'ref'], label: 'Automation',
        control: { kind: 'select', options: electricGridDefinitionCatalog.automations.map(automation => ({ value: automation.id, label: automation.title, compatibleWith: { path: ['model', 'ref'], values: automation.compatibleModelRefs } })) },
      }, {
        path: ['operatingPoint', 'overrides', 'loadScale'], label: 'Load scale',
        control: { kind: 'number', min: 0.01, step: 0.01 },
      }, {
        path: ['operatingPoint', 'overrides', 'generationAvailabilityScale'], label: 'Generation availability scale',
        control: { kind: 'number', min: 0, step: 0.01 },
      }],
    }],
  },
  recording: { profiles: electricGridRecordingProfiles, estimateSeries: (objects, profileId) => objects.reduce((sum, object) => {
    const data = electricGridPackDataSchema.parse(object.packData)
    return sum + gridRecordingSeriesCount(gridModelCatalogEntry(data.model.ref).assetCounts, profileId)
  }, 0) },
  scenario: electricGridScenarioSupport,
  observation: {
    categories: ['electric-grids'], declarations: gridObservationDeclarationsQuery.capability.id, read: gridObservationReadQuery.capability.id,
    topology: { family: 'network', capability: gridObservationTopologyQuery.capability.id },
  },
}
