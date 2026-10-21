import type { SimulationRunEvent, OperationalObject } from '../model/index.ts'

export type SimulationRunEventPersistenceDisposition = 'durable' | 'projected'

const stableJson = (value: unknown): string => JSON.stringify(value)

const routeMeaningChanged = (previous: OperationalObject, next: OperationalObject): boolean => {
  const previousRoute = previous.spatial.route
  const nextRoute = next.spatial.route
  if (stableJson(previousRoute?.planned) !== stableJson(nextRoute?.planned)) return true
  if (previousRoute?.source !== nextRoute?.source) return true
  if (stableJson(previousRoute?.impacts) !== stableJson(nextRoute?.impacts)) return true
  return false
}

const communicationMeaningChanged = (previous: OperationalObject, next: OperationalObject): boolean =>
  previous.communication?.state !== next.communication?.state

const isMeaningfulObjectUpsert = (previous: OperationalObject | undefined, next: OperationalObject): boolean => {
  if (!previous) return true
  if (previous.kind !== next.kind) return true
  if (previous.packId !== next.packId) return true
  if (previous.label !== next.label) return true
  if (previous.lifecycle !== next.lifecycle) return true
  if (stableJson(previous.operational) !== stableJson(next.operational)) return true
  if (stableJson(previous.tasking) !== stableJson(next.tasking)) return true
  if (stableJson(previous.alerts) !== stableJson(next.alerts)) return true
  if (stableJson(previous.packData) !== stableJson(next.packData)) return true
  if (routeMeaningChanged(previous, next)) return true
  if (communicationMeaningChanged(previous, next)) return true
  return false
}

export const persistenceDispositionFor = (
  event: SimulationRunEvent,
  previousObject?: OperationalObject,
): SimulationRunEventPersistenceDisposition => {
  if (event.type === 'object.upserted') {
    return isMeaningfulObjectUpsert(previousObject, event.object) ? 'durable' : 'projected'
  }
  if (event.type === 'telemetry.sampled') return 'projected'
  return 'durable'
}
