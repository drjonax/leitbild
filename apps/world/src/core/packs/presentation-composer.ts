import type { IsoTimestamp, OperationalObject } from '../model/index.ts'
import type {
  PackObjectPresentation,
  PackObjectPresentationTier,
} from './protocol.ts'
import type { ActivePackViews } from './active-views.ts'

export interface PackPresentationComposerContext {
  readonly pack: ActivePackViews | null
  readonly objects: ReadonlyArray<OperationalObject>
  readonly currentTime?: IsoTimestamp
  /** The roles the screen shows in a role Run (`PackObjectPresentationContext.seenRoleIds`). */
  readonly seenRoleIds?: ReadonlyArray<string>
}

export interface PackPresentationRequest {
  readonly tier?: PackObjectPresentationTier
}

export interface PackPresentationTierDiagnostics {
  readonly calls: number
  readonly cacheHits: number
  readonly cacheMisses: number
  readonly totalMissDurationMs: number
  readonly worstMissDurationMs: number
}

export interface PackPresentationDiagnosticsSnapshot {
  readonly contextKey: string
  readonly cacheSize: number
  readonly tiers: Readonly<Record<PackObjectPresentationTier, PackPresentationTierDiagnostics>>
}

export interface PackPresentationComposer {
  readonly present: (object: OperationalObject, request?: PackPresentationRequest) => PackObjectPresentation
  readonly diagnostics: () => PackPresentationDiagnosticsSnapshot
  readonly reset: () => void
}

export interface PackPresentationComposerConfig {
  readonly getContext: () => PackPresentationComposerContext
  readonly nowMs?: () => number
}

type MutableTierDiagnostics = {
  calls: number
  cacheHits: number
  cacheMisses: number
  totalMissDurationMs: number
  worstMissDurationMs: number
}

const emptyTierDiagnostics = (): MutableTierDiagnostics => ({
  calls: 0,
  cacheHits: 0,
  cacheMisses: 0,
  totalMissDurationMs: 0,
  worstMissDurationMs: 0,
})

const createDiagnostics = (): Record<PackObjectPresentationTier, MutableTierDiagnostics> => ({
  summary: emptyTierDiagnostics(),
  map: emptyTierDiagnostics(),
  detail: emptyTierDiagnostics(),
})

const snapshotDiagnostics = (
  diagnostics: Record<PackObjectPresentationTier, MutableTierDiagnostics>,
): Record<PackObjectPresentationTier, PackPresentationTierDiagnostics> => ({
  summary: { ...diagnostics.summary },
  map: { ...diagnostics.map },
  detail: { ...diagnostics.detail },
})

const contextKeyFor = (
  context: PackPresentationComposerContext,
): string => `${context.pack?.packIds.join(',') ?? 'no-pack'}:${context.currentTime ?? 'no-time'}:${context.seenRoleIds?.join(',') ?? 'all-roles'}`

const objectsForPackLookup = (
  objects: ReadonlyArray<OperationalObject>,
): ((packId: string) => ReadonlyArray<OperationalObject>) => {
  const byPackId = new Map<string, OperationalObject[]>()
  for (const object of objects) {
    const list = byPackId.get(object.packId) ?? []
    list.push(object)
    byPackId.set(object.packId, list)
  }
  return packId => byPackId.get(packId) ?? []
}

export const createPackPresentationComposer = (
  config: PackPresentationComposerConfig,
): PackPresentationComposer => {
  const nowMs = config.nowMs ?? (() => performance.now())
  const cache = new Map<string, PackObjectPresentation>()
  const diagnostics = createDiagnostics()
  let cacheObjects: ReadonlyArray<OperationalObject> | null = null
  let cacheContextKey = ''
  let objectsForPack: ((packId: string) => ReadonlyArray<OperationalObject>) = () => []

  const reset = (): void => {
    cache.clear()
    cacheObjects = null
    cacheContextKey = ''
    objectsForPack = () => []
    for (const tier of Object.keys(diagnostics) as PackObjectPresentationTier[]) {
      Object.assign(diagnostics[tier], emptyTierDiagnostics())
    }
  }

  const syncContext = (
    context: PackPresentationComposerContext,
  ): string => {
    const contextKey = contextKeyFor(context)
    if (cacheObjects !== context.objects || cacheContextKey !== contextKey) {
      cache.clear()
      cacheObjects = context.objects
      cacheContextKey = contextKey
      objectsForPack = objectsForPackLookup(context.objects)
    }
    return contextKey
  }

  return {
    present: (object, request = {}) => {
      const context = config.getContext()
      if (!context.pack) throw new Error('scenario packs are not loaded')
      syncContext(context)
      const tier = request.tier ?? 'summary'
      const tierDiagnostics = diagnostics[tier]
      tierDiagnostics.calls += 1
      const key = `${object.id}:${object.revision}:${tier}`
      const cached = cache.get(key)
      if (cached) {
        tierDiagnostics.cacheHits += 1
        return cached
      }
      tierDiagnostics.cacheMisses += 1
      const startedAtMs = nowMs()
      try {
        const presentation = context.pack.presentation.presentObject(object, {
          objects: context.objects,
          objectsForPack,
          tier,
          ...(context.currentTime === undefined ? {} : { currentTime: context.currentTime }),
          ...(context.seenRoleIds === undefined ? {} : { seenRoleIds: context.seenRoleIds }),
        })
        cache.set(key, presentation)
        return presentation
      } finally {
        const durationMs = nowMs() - startedAtMs
        tierDiagnostics.totalMissDurationMs += durationMs
        tierDiagnostics.worstMissDurationMs = Math.max(tierDiagnostics.worstMissDurationMs, durationMs)
      }
    },
    diagnostics: () => ({
      contextKey: cacheContextKey,
      cacheSize: cache.size,
      tiers: snapshotDiagnostics(diagnostics),
    }),
    reset,
  }
}
