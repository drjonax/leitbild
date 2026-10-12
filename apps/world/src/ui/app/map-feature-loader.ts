import type { SimulationRunId, GeoJsonPolygon, IsoTimestamp, OperationalObject } from '../../core/model/index.ts'
import { packMapFeatureSchema, type PackMapFeature, type PackMapFeatureQuery, type PackObjectPresentationContext } from '../../core/packs/protocol.ts'
import type { ActivePackViews } from '../../core/packs/active-views.ts'
import { querySimulationRunCapability, type SimulationRunRequestOptions } from '../simulation-run-client.ts'

export interface MapFeatureLoaderContext {
  readonly viewport: GeoJsonPolygon
  readonly zoom: number
  readonly currentTime?: IsoTimestamp
  readonly signal?: AbortSignal
}

export interface MapFeatureRuntimeConfig {
  readonly pack: () => ActivePackViews | null
  readonly objects: () => ReadonlyArray<OperationalObject>
  readonly simulationRunId: () => SimulationRunId | null
  readonly currentTime: () => IsoTimestamp | undefined
  /**
   * The roles the screen shows Packs in a role Run (the role dialog's See
   * boxes), or null in open mode. A Pack's map features receive it as its
   * object presentation does, so what a screen does not see stays off the
   * map in every layer a Pack draws.
   */
  readonly seenRoleIds: () => ReadonlyArray<string> | null
  readonly queryTimeoutMs?: number
  readonly onWarnings?: (messages: ReadonlyArray<string>) => void
  readonly queryCapability?: (
    simulationRunId: SimulationRunId,
    request: PackMapFeatureQuery,
    options?: SimulationRunRequestOptions,
  ) => Promise<unknown>
}

const defaultMapFeatureQueryTimeoutMs = 1_500

const mapFeaturesFromQueryResult = (result: unknown): ReadonlyArray<PackMapFeature> => {
  if (typeof result !== 'object' || result === null || !('features' in result)) {
    throw new Error('pack map feature query returned no features field')
  }
  const features = (result as { readonly features?: unknown }).features
  if (!Array.isArray(features)) throw new Error('pack map feature query features field is not an array')
  return features.map((feature, index) => {
    const parsed = packMapFeatureSchema.safeParse(feature)
    if (!parsed.success) throw new Error(`pack map feature query returned invalid feature ${index}: ${parsed.error.message}`)
    return parsed.data as PackMapFeature
  })
}

const createAbortSignalWithTimeout = (
  parent: AbortSignal | undefined,
  timeoutMs: number,
): { readonly signal: AbortSignal; readonly dispose: () => void } => {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort(new Error(`pack map feature query timed out after ${timeoutMs}ms`))
  }, timeoutMs)
  const abortFromParent = (): void => {
    controller.abort(parent?.reason)
  }
  parent?.addEventListener('abort', abortFromParent, { once: true })
  if (parent?.aborted) abortFromParent()
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout)
      parent?.removeEventListener('abort', abortFromParent)
    },
  }
}

export const createMapFeatureLoader = (
  config: MapFeatureRuntimeConfig,
): ((context: MapFeatureLoaderContext) => Promise<ReadonlyArray<PackMapFeature>>) =>
  async (context: MapFeatureLoaderContext): Promise<ReadonlyArray<PackMapFeature>> => {
    const currentTime = context.currentTime ?? config.currentTime()
    const seenRoleIds = config.seenRoleIds()
    const presentationContextWithTime: PackObjectPresentationContext = {
      objects: config.objects(),
      map: { viewport: context.viewport, zoom: context.zoom },
      ...(currentTime === undefined ? {} : { currentTime }),
      ...(seenRoleIds === null ? {} : { seenRoleIds }),
    }
    const pack = config.pack()
    if (!pack) { config.onWarnings?.([]); return [] }
    const syncFeatures = pack.presentation.mapFeatures?.(presentationContextWithTime) ?? []
    const simulationRunId = config.simulationRunId()
    if (!simulationRunId) { config.onWarnings?.([]); return syncFeatures }
    const requests = pack.presentation.mapFeatureQueries?.(presentationContextWithTime) ?? []
    if (requests.length === 0) { config.onWarnings?.([]); return syncFeatures }
    const query = config.queryCapability ?? (async (id, request, options) =>
      await querySimulationRunCapability(id, request.capabilityId, request.input, options))
    const timeout = createAbortSignalWithTimeout(
      context.signal,
      config.queryTimeoutMs ?? defaultMapFeatureQueryTimeoutMs,
    )
    try {
      const warnings: string[] = []
      const responses = await Promise.all(requests.map(async request => {
        try {
          const result = await query(simulationRunId, request, { signal: timeout.signal })
          if (typeof result === 'object' && result !== null && 'truncated' in result && result.truncated === true) warnings.push(request.capabilityId + ': map coverage limited; zoom in for more detail.')
          return mapFeaturesFromQueryResult(result)
        } catch (error) {
          if (context.signal?.aborted) throw error
          if (!config.onWarnings) throw error
          warnings.push(request.capabilityId + ': ' + String(error)); return []
        }
      }))
      if (context.signal?.aborted) throw context.signal.reason
      config.onWarnings?.(warnings)
      return [...syncFeatures, ...responses.flat()]
    } finally {
      timeout.dispose()
    }
  }
