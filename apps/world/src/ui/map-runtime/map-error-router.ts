import type { MapErrorClaim } from './types.ts'

// Routes the map's MapLibre `error` events. A claim registered by the component that owns
// the cause takes an event over, e.g. the reference build recovery for tiles of a superseded
// build; it then reports any failure itself. An unclaimed reference dataset error becomes one
// reference warning per source and message; any other error fails the map runtime.

export interface MapErrorDetails {
  readonly message: string
  readonly sourceId: string | null
}

export interface MapErrorRouterConfig {
  readonly onReferenceWarning: (message: string) => void
  readonly onRuntimeError: (details: MapErrorDetails) => void
}

export interface MapErrorRouter {
  readonly route: (event: unknown) => void
  /** Registers a claim; the returned function releases it. */
  readonly claim: (claim: MapErrorClaim) => () => void
}

const stringFromUnknown = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null

export const mapErrorDetails = (event: unknown): MapErrorDetails => {
  const candidate = event as {
    readonly error?: unknown
    readonly sourceId?: unknown
    readonly source?: { readonly id?: unknown }
  }
  const error = candidate.error
  return {
    message: error instanceof Error
      ? error.message
      : stringFromUnknown(error) ?? 'Vector map failed to load',
    sourceId: stringFromUnknown(candidate.sourceId) ?? stringFromUnknown(candidate.source?.id),
  }
}

const isReferenceDatasetError = (details: MapErrorDetails): boolean =>
  details.sourceId?.startsWith('reference:') === true || details.message.includes('/map/datasets/')

export const createMapErrorRouter = (config: MapErrorRouterConfig): MapErrorRouter => {
  const claims = new Set<MapErrorClaim>()
  const warned = new Set<string>()
  return {
    route: (event) => {
      for (const claim of [...claims]) if (claim(event)) return
      const details = mapErrorDetails(event)
      if (!isReferenceDatasetError(details)) {
        config.onRuntimeError(details)
        return
      }
      const key = `${details.sourceId ?? 'reference'}:${details.message}`
      if (warned.has(key)) return
      warned.add(key)
      config.onReferenceWarning(details.message)
    },
    claim: (claim) => {
      claims.add(claim)
      return () => { claims.delete(claim) }
    },
  }
}
