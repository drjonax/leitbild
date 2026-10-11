import type { Map as MapLibreMap } from 'maplibre-gl'
import type { PackMapLayerGroup } from '../../core/packs/protocol.ts'
import type { PackMapAppearance, PackReferenceDatasetStyle } from '../../core/packs/reference-style.ts'
import type { RenderPhase } from './types.ts'
import { createReferenceDataController, type ReferenceDatasetController } from '../map/reference-data-controller.ts'
import { createPackLayerGroupControllerFromGroups, type PackLayerGroupController } from '../map/pack-layer-group-controller.ts'
import { referenceLayerAnchorId } from './reference-layer-order.ts'

export interface MapLayerRegistration {
  readonly phase: RenderPhase
  readonly sourceIds: ReadonlyArray<string>
  readonly layerIds: ReadonlyArray<string>
  readonly teardown?: () => void
}

export interface MapLayerRegistry {
  readonly registerReferenceLayers: (config: ReferenceLayerRegistrationConfig) => Promise<MapLayerRegistration>
  readonly applyLayerGroupVisibility: (visibility: Readonly<Record<string, boolean>>) => void
  readonly reset: () => void
}

export interface ReferenceLayerRegistrationConfig {
  readonly map: MapLibreMap
  readonly styles: ReadonlyArray<PackReferenceDatasetStyle>
  readonly appearance: PackMapAppearance
  readonly layerGroups: ReadonlyArray<PackMapLayerGroup>
  readonly visibility: Readonly<Record<string, boolean>>
  readonly logger?: (message: string) => void
  /** A registered dataset failed after registration, e.g. when its promoted build could not be adopted. */
  readonly onError: (message: string) => void
}

export const createMapLayerRegistry = (): MapLayerRegistry => {
  let layerGroupController: PackLayerGroupController | null = null
  let referenceController: ReferenceDatasetController | null = null
  let generation = 0

  const reset = (): void => {
    generation += 1
    referenceController?.dispose()
    referenceController = null
    layerGroupController = null
  }

  return {
    registerReferenceLayers: async (config) => {
      reset()
      const registration = generation
      const controller = await createReferenceDataController({
        map: config.map,
        styles: config.styles,
        appearance: config.appearance,
        beforeLayerId: () => referenceLayerAnchorId(config.map.getStyle()),
        ...(config.logger === undefined ? {} : { logger: config.logger }),
        onBuildRecoveryFailed: config.onError,
      })
      // A reset while the capabilities loaded superseded this registration.
      if (registration !== generation) controller.dispose()
      else referenceController = controller
      if (config.layerGroups.length > 0) {
        layerGroupController = createPackLayerGroupControllerFromGroups({
          map: config.map,
          groups: config.layerGroups,
        })
        layerGroupController.apply({ ...layerGroupController.defaults, ...config.visibility })
      }
      return {
        phase: 'reference',
        sourceIds: controller.registered.map(dataset => dataset.sourceId),
        layerIds: controller.registered.flatMap(dataset => dataset.layerIds),
      }
    },
    applyLayerGroupVisibility: (visibility) => {
      const controller = layerGroupController
      if (!controller) return
      controller.apply({ ...controller.defaults, ...visibility })
    },
    reset,
  }
}
