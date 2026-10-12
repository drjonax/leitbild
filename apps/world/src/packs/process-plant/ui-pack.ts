import type { WorldPackView } from '../../core/packs/protocol.ts'
import { createWorldPackDescriptor } from '../../core/packs/protocol.ts'
import { COMPOSED_DISPLAY_VIEW_TYPE, detailDisplayStateSchema } from './displays/composition.ts'
import { processPlantPackId, processPlantUnitPackDataSchema } from './model.ts'
import { processPlantPresentation } from './presentation.ts'
import { processPlantSimRuntimeId } from './sim/constants.ts'

// An embedded view's title holds at most this (embeddedViewPublicationSchema).
const TAG_DISPLAY_TITLE_MAX = 120

/** Browser-only Pack view. Simulation compilation and runtime code stay outside
 * the UI dependency graph. */
export const processPlantPackView = {
  descriptor: createWorldPackDescriptor({
    id: processPlantPackId,
    version: '1.0.0',
    name: 'Process Plant',
    description: 'Configurable component-graph process plants with transient dynamics, procedures, controls, and engineering views.',
    contributions: ['runtime', 'recording', 'knowledge', 'scenario', 'presentation'],
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
    tagDisplay: (plantId, validation) => {
      if (validation.measuredOn === undefined) return null
      const label = typeof validation.signal?.label === 'string' ? validation.signal.label : null
      const title = label === null ? validation.id : `${validation.id}: ${label}`
      const state = JSON.stringify(detailDisplayStateSchema.parse({ detail: { plantId, components: [validation.measuredOn] } }))
      return {
        viewType: COMPOSED_DISPLAY_VIEW_TYPE,
        title: title.length <= TAG_DISPLAY_TITLE_MAX ? title : `${title.slice(0, TAG_DISPLAY_TITLE_MAX - 1)}…`,
        state,
        // Equipment is drawn for the view it is shown in, as the embedded view draws it.
        drawQuery: size => ({ capabilityId: 'world.process-plant.display.view', input: { plantId, state, size } }),
      }
    },
  },
} satisfies WorldPackView
