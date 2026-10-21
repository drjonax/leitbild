// A paused fixture-Pack Run as the composer reads it (architecture A2–A6 tests): the fixture Pack is the stand-in for
// a Pack World knows nothing about; its units declare speed and status on an engine fed from a tank.
import { displayRunOf } from '../../src/core/api/display-capabilities.ts'
import type { ActorId, IsoTimestamp } from '../../src/core/model/index.ts'
import type { Actor } from '../../src/core/simulation-runs/actors.ts'
import type { ViewRun } from '../../src/features/displays/compose/view.ts'
import { createRoleRunRegistry } from './role-runs.ts'

export const person: Actor = { id: 'actor:human:composer' as ActorId, label: 'Composer', role: 'operator' }

export const fixtureComposeRun = async (definition?: { readonly id: string }, seconds = 2) => {
  const registry = await createRoleRunRegistry(definition === undefined ? [] : [definition])
  const runtime = await registry.create({ scenarioId: definition?.id ?? 'open-run' })
  await runtime.setClock({ paused: true })
  await runtime.runMaximumPace(new Date(Date.parse(runtime.snapshot().clock!.currentTime) + seconds * 1_000).toISOString() as IsoTimestamp, { shouldStop: () => false })
  /** The Run as this caller reads it; a test may hide objects or stand in their state and connections. */
  const runOf = async (overrides: Partial<Pick<ViewRun, 'denied' | 'objects' | 'connections' | 'port'>> = {}): Promise<ViewRun> =>
    ({ ...await displayRunOf(registry, runtime, person, new Set()), ...overrides })
  return { registry, runtime, runOf, close: async () => { await registry.shutdown() } }
}
