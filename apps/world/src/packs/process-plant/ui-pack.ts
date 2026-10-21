import type { WorldPackView } from '../../core/packs/protocol.ts'
import { createWorldPackDescriptor } from '../../core/packs/protocol.ts'
import { processPlantPackId, processPlantUnitPackDataSchema } from './model.ts'
import { processPlantPresentation } from './presentation.ts'
import { processPlantSimRuntimeId } from './sim/constants.ts'

/** Browser-only Pack view. Simulation compilation and runtime code stay outside
 * the UI dependency graph. */
export const processPlantPackView = {
  descriptor: createWorldPackDescriptor({
    id: processPlantPackId,
    version: '1.0.0',
    name: 'Process Plant',
    description: 'Configurable component-graph process plants with transient dynamics, procedures, controls, and engineering views.',
    contributions: ['runtime', 'recording', 'knowledge', 'scenario', 'presentation', 'observation'],
  }),
  runtime: {
    runtimes: [{ id: processPlantSimRuntimeId, version: '1.0.0', label: 'Local process plant runtime', kind: 'local', clock: 'simulation' }],
    defaultRuntimeId: processPlantSimRuntimeId,
  },
  presentation: processPlantPresentation,
  procedures: {
    scopeIdForObject: object => {
      const parsed = processPlantUnitPackDataSchema.safeParse(object.packData)
      return parsed.success ? String(object.id) : null
    },
    signalReadQuery: (plantId, tag) => ({
      capabilityId: 'world.process-plant.signals.read',
      input: { plantId, signals: [{ tagId: tag.id, ...(tag.units === undefined ? {} : { requestedUnit: tag.units }) }] },
    }),
    tagValidationQuery: (plantId, tags) => ({
      capabilityId: 'world.process-plant.procedure-tags.validate',
      input: { plantId, tags: tags.map(tag => ({
        id: tag.id,
        ...(tag.description === undefined ? {} : { description: tag.description }),
        ...(tag.simPath === undefined ? {} : { simPath: tag.simPath }),
        ...(tag.units === undefined ? {} : { units: tag.units }),
        ...(tag.equipment === undefined ? {} : { equipment: tag.equipment }),
        ...(tag.source === undefined ? {} : { source: tag.source }),
        ...(tag.range === undefined ? {} : { range: tag.range }),
      })) },
    }),
    assessmentsQuery: (plantId, assessmentIds) => ({
      capabilityId: 'world.process-plant.assessments.evaluate', input: { plantId, assessmentIds },
    }),
    // The equipment the tag is measured on, opened as from a unit overview: World draws what feeds it and where its outflow goes.
  },
} satisfies WorldPackView
