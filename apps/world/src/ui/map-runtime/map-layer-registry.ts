import type { Map as MapLibreMap } from 'maplibre-gl'
import type { PackMapLayerGroup } from '../../core/packs/protocol.ts'
import type { PackMapAppearance, PackReferenceDatasetStyle } from '../../core/packs/reference-style.ts'
import type { RenderPhase } from './types.ts'
import { createReferenceDataController } from '../map/reference-data-controller.ts'
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
}

export const createMapLayerRegistry = (): MapLayerRegistry => {
  let layerGroupController: PackLayerGroupController | null = null

  return {
    registerReferenceLayers: async (config) => {
      const referenceController = await createReferenceDataController({
        map: config.map,
        styles: config.styles,
        appearance: config.appearance,
        beforeLayerId: () => referenceLayerAnchorId(config.map.getStyle()),
        ...(config.logger === undefined ? {} : { logger: config.logger }),
      })
      if (config.layerGroups.length > 0) {
        layerGroupController = createPackLayerGroupControllerFromGroups({
          map: config.map,
          groups: config.layerGroups,
        })
        layerGroupController.apply({ ...layerGroupController.defaults, ...config.visibility })
      }
      return {
        phase: 'reference',
        sourceIds: referenceController.registered.map(dataset => dataset.sourceId),
        layerIds: referenceController.registered.flatMap(dataset => dataset.layerIds),
      }
    },
    applyLayerGroupVisibility: (visibility) => {
      const controller = layerGroupController
      if (!controller) return
      controller.apply({ ...controller.defaults, ...visibility })
    },
    reset: () => {
      layerGroupController = null
    },
  }
}
