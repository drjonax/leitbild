import type { SimulationRunId } from '../src/core/model/index.ts'
import type { IdleRuntimeCloseTimer } from '../src/core/simulation-runs/registry.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { createScenarioRuntimeResolver,type ScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import { createDroneNativePackRuntimeAdapter } from '../src/packs/drone/native/adapter.ts'
import { createLocalElectricGridPackRuntimeAdapter } from '../src/packs/electric-grid/sim/adapter.ts'
import { createLocalProcessPlantPackRuntimeAdapter } from '../src/packs/process-plant/sim/adapter.ts'
import { createLocalWeatherPackRuntimeAdapter } from '../src/packs/weather/sim/adapter.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import type { PackRuntimeAdapter,PackRuntimeConnectionConfig,PackScenarioRuntimeConfig } from '../src/simulation/protocol.ts'
import { createFixturePackRuntimeAdapter } from './fixtures/fixture-runtime.ts'
import { testScenarioDefinitions } from './fixtures/scenarios.ts'
import { testPacks } from './fixtures/test-packs.ts'

export { testPacks }

export const createTestScenarioRuntimeResolver = (): ScenarioRuntimeResolver => createScenarioRuntimeResolver({
  packs: testPacks,
})

export const testScenarioAuthoring = () => ({
  scenarioDefinitions: testScenarioDefinitions,
  compileScenarioDefinition: (source: unknown) => compileScenarioDefinition(source, testPacks, { routing: createDirectRoutingAdapter() }),
  scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(testPacks),
})

export const createTestPackRuntimeAdapters = (): ReadonlyArray<PackRuntimeAdapter> => {
  return [
    createFixturePackRuntimeAdapter(),
    createLocalWeatherPackRuntimeAdapter(),
    createDroneNativePackRuntimeAdapter(),
    createLocalProcessPlantPackRuntimeAdapter(),
    createLocalElectricGridPackRuntimeAdapter(),
  ]
}

export const testSimulationRunId = (suffix: string): SimulationRunId =>
  `run-${suffix}` as SimulationRunId

export const testRuntimeConnectionConfig = (config: {
  readonly simulationRunId: SimulationRunId
  readonly runtimeIds: ReadonlyArray<string>
  readonly initialObjects?: PackScenarioRuntimeConfig['initialObjects']
  readonly runtimeConfig?: unknown
}): PackRuntimeConnectionConfig => ({
  simulationRunId: config.simulationRunId,
  scenario: {
    scenarioId: 'scenario:test-runtime',
    runtimeIds: config.runtimeIds,
    connections: [],
    world: { startsAt: '2026-01-01T00:00:00.000Z' as PackScenarioRuntimeConfig['world']['startsAt'], environment: { mode: 'test' } },
    initialObjects: config.initialObjects ?? [],
    runtimeConfig: config.runtimeConfig ?? {},
  },
  ...(config.initialObjects === undefined ? {} : { initialObjects: config.initialObjects }),
})

/**
 * A Run registry's idle-close countdowns on virtual time: a test advances it
 * explicitly and each close that falls due has finished when advance returns.
 */
export const createManualIdleTimer = () => {
  let nowMs = 0
  const armed = new Set<{ readonly dueMs: number; readonly closeIfIdle: () => Promise<void> }>()
  const arm: IdleRuntimeCloseTimer = (closeIfIdle, delayMs) => {
    const countdown = { dueMs: nowMs + delayMs, closeIfIdle }
    armed.add(countdown)
    return () => { armed.delete(countdown) }
  }
  const advance = async (ms: number): Promise<void> => {
    const untilMs = nowMs + ms
    for (;;) {
      const due = [...armed].filter(countdown => countdown.dueMs <= untilMs).sort((a, b) => a.dueMs - b.dueMs)[0]
      if (!due) break
      armed.delete(due)
      nowMs = due.dueMs
      await due.closeIfIdle()
    }
    nowMs = untilMs
  }
  return { arm, advance }
}

export const waitForCondition = async (
  label: string,
  condition: () => boolean,
  options?: {
    readonly timeoutMs?: number
    readonly intervalMs?: number
  },
): Promise<void> => {
  // The deadline reports a condition that never holds; it is not a budget, so
  // it leaves a loaded machine room, and the condition is checked once more
  // after a sleep that the machine stretched past it.
  const timeoutMs = options?.timeoutMs ?? 10_000
  const intervalMs = options?.intervalMs ?? 25
  const startedAt = Date.now()

  for (;;) {
    if (condition()) return
    if (Date.now() - startedAt > timeoutMs) break
    await Bun.sleep(intervalMs)
  }

  throw new Error(`timed out waiting for condition: ${label}`)
}
