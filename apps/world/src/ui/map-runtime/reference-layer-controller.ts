import type { PackMapLayerGroup } from '../../core/packs/protocol.ts'
import type { PackMapAppearance, PackReferenceDatasetStyle } from '../../core/packs/reference-style.ts'
import { createMapLayerRegistry, type MapLayerRegistry } from './map-layer-registry.ts'
import { mapPerformanceDiagnostics } from './map-performance-diagnostics.ts'
import type { MapRuntimeHandle } from './types.ts'

export interface ReferenceLayerControllerRegistration {
  readonly runtime: MapRuntimeHandle
  readonly simulationRunId: string | null
  readonly styles: ReadonlyArray<PackReferenceDatasetStyle>
  readonly appearance: PackMapAppearance
  readonly layerGroups: ReadonlyArray<PackMapLayerGroup>
  readonly visibility: Readonly<Record<string, boolean>>
}

export interface ReferenceLayerController {
  readonly register: (registration: ReferenceLayerControllerRegistration) => void
  readonly applyVisibility: (visibility: Readonly<Record<string, boolean>>) => void
  readonly reset: () => void
}

export interface ReferenceLayerControllerConfig {
  readonly createRegistry?: () => MapLayerRegistry
  readonly requestIdle?: (callback: () => void) => void
  readonly onError: (message: string) => void
}

const referenceKeyFor = (
  registration: ReferenceLayerControllerRegistration,
): string => [
  registration.simulationRunId ?? 'no-simulation-run',
  registration.appearance.theme,
  registration.styles.map(style => style.datasetId).join(','),
  registration.layerGroups.map(group => `${group.id}:${group.layerIdPattern}:${group.defaultVisible}`).join(','),
].join('|')

const defaultRequestIdle = (callback: () => void): void => {
  if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
    window.requestIdleCallback(callback, { timeout: 1_500 })
    return
  }
  globalThis.setTimeout(callback, 120)
}

export const createReferenceLayerController = (
  config: ReferenceLayerControllerConfig,
): ReferenceLayerController => {
  const registry = config.createRegistry?.() ?? createMapLayerRegistry()
  const requestIdle = config.requestIdle ?? defaultRequestIdle
  let serial = 0
  let registeredKey: string | null = null

  const reset = (): void => {
    serial += 1
    registeredKey = null
    registry.reset()
  }

  const runRegistration = async (
    registration: ReferenceLayerControllerRegistration,
    registrationSerial: number,
  ): Promise<void> => {
    const runtime = registration.runtime
    try {
      runtime.reportDiagnosticPhase({
        phase: 'reference',
        status: 'running',
        message: 'Registering reference layers',
        details: [
          { label: 'Datasets', value: String(registration.styles.length) },
          { label: 'Layer groups', value: String(registration.layerGroups.length) },
        ],
      })
      const result = await mapPerformanceDiagnostics.measureAsync(
        'reference',
        'registerReferenceLayers',
        async () => registry.registerReferenceLayers({
          map: runtime.map,
          styles: registration.styles,
          appearance: registration.appearance,
          layerGroups: registration.layerGroups,
          visibility: registration.visibility,
          logger: message => {
            console.warn(message)
          },
        }),
        {
          datasets: registration.styles.length,
          layerGroups: registration.layerGroups.length,
        },
      )
      if (registrationSerial !== serial) return
      runtime.reportDiagnosticPhase({
        phase: 'reference',
        status: 'ready',
        message: 'Reference layers registered',
        details: [
          { label: 'Sources', value: String(result.sourceIds.length) },
          { label: 'Layers', value: String(result.layerIds.length) },
        ],
      })
    } catch (err) {
      if (registrationSerial !== serial) return
      const message = err instanceof Error ? err.message : String(err)
      runtime.reportDiagnosticPhase({
        phase: 'reference',
        status: 'failed',
        message,
        error: {
          phase: 'reference',
          message,
          recoverable: true,
        },
      })
      config.onError(`Reference map overlay failed: ${message}`)
    }
  }

  return {
    register: (registration) => {
      const key = referenceKeyFor(registration)
      if (registeredKey === key) return
      registeredKey = key
      serial += 1
      const registrationSerial = serial
      registry.reset()
      if (registration.styles.length === 0 && registration.layerGroups.length === 0) {
        registration.runtime.reportDiagnosticPhase({
          phase: 'reference',
          status: 'ready',
          message: 'No reference layers configured',
          details: [],
        })
        return
      }
      requestIdle(() => {
        void runRegistration(registration, registrationSerial)
      })
    },
    applyVisibility: visibility => {
      registry.applyLayerGroupVisibility(visibility)
    },
    reset,
  }
}
