import { newWorkspaceId } from '@leitbild/contracts'
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActorId, IsoTimestamp, ObjectId } from '../src/core/model/index.ts'
import { createSimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import type { SimulationRunRuntime } from '../src/core/simulation-runs/runtime.ts'
import { electricGridPackDataSchema, type GridProjection } from '../src/packs/electric-grid/model.ts'
import { builtinScenarioDefinitions } from '../src/scenarios/definitions.ts'
import { createManualIdleTimer, createTestPackRuntimeAdapters, createTestScenarioRuntimeResolver, testScenarioAuthoring } from './helpers.ts'

// Each bundled Electric Grid Scenario runs headless through the Scenario Library and a Simulation
// Run at maximum pace (1 s Run slices), so its timeline cues execute as they do for an operator.

const operator = { id: 'actor:grid-scenario-test' as ActorId, label: 'Grid scenario test operator', role: 'operator' as const }

interface GridSample {
  readonly seconds: number
  readonly projection: GridProjection
}

/** A Run of one bundled Scenario, paused, advanced only by `advanceTo` at maximum pace. */
const startScenarioRun = async (scenarioId: string, gridId: string) => {
  const dataDir = await mkdtemp(join(tmpdir(), `leitbild-${scenarioId}-`))
  const registry = createSimulationRunRegistry({
    dataDir,
    workspaceId: newWorkspaceId(),
    ...testScenarioAuthoring(),
    runtimeAdapters: createTestPackRuntimeAdapters(),
    scenarioRuntimeResolver: createTestScenarioRuntimeResolver(),
    // The test drives the Run without a viewer's lease; idle close must not end it mid-scenario.
    idleRuntimeCloseTimer: createManualIdleTimer().arm,
  })
  const run: SimulationRunRuntime = await registry.create({ scenarioId })
  await run.setClock({ paused: true })
  const startedAtMs = Date.parse(run.snapshot().scenario!.timeline!.startedAt)
  const elapsedSeconds = (): number => (Date.parse(run.snapshot().clock!.currentTime) - startedAtMs) / 1_000
  const object = (id: string) => {
    const found = run.snapshot().objects.find(candidate => candidate.id === id as ObjectId)
    if (!found) throw new Error(`Run has no object ${id}`)
    return found
  }
  const projection = (): GridProjection => electricGridPackDataSchema.parse(object(gridId).packData).projection
  const samples: GridSample[] = []
  const advanceTo = async (seconds: number): Promise<void> => {
    await run.runMaximumPace(new Date(startedAtMs + seconds * 1_000).toISOString() as IsoTimestamp, {
      shouldStop: () => false,
      onProgress: () => { samples.push({ seconds: elapsedSeconds(), projection: projection() }) },
    })
  }
  const invoke = async (capabilityId: string, input: Record<string, unknown>) => run.invokeCapability(operator, { capabilityId, input: { gridId, ...input } })
  const query = async <Result>(capabilityId: string, input: Record<string, unknown> = {}): Promise<Result> => {
    const outcome = await invoke(capabilityId, input)
    if (outcome.kind !== 'query') throw new Error(`${capabilityId} is not a query`)
    return outcome.result as Result
  }
  const command = async (capabilityId: string, input: Record<string, unknown>) => {
    const outcome = await invoke(capabilityId, input)
    if (outcome.kind !== 'command') throw new Error(`${capabilityId} is not a command`)
    return outcome.result
  }
  const failedCues = (): ReadonlyArray<string> => run.events().flatMap(event =>
    event.type === 'notification.emitted' && event.notification.id.startsWith('notification:scenario-cue-failed:') ? [event.notification.message] : [])
  const firedCueIds = (): ReadonlyArray<string> => run.snapshot().scenario?.timeline?.firedCueIds ?? []
  const close = async (): Promise<void> => {
    await registry.shutdown()
    await rm(dataDir, { recursive: true, force: true })
  }
  return { object, projection, samples, advanceTo, query, command, failedCues, firedCueIds, close }
}

type ScenarioRun = Awaited<ReturnType<typeof startScenarioRun>>

const cueIdsOf = (scenarioId: string): ReadonlyArray<string> =>
  builtinScenarioDefinitions.find(source => source.id === scenarioId)!.timeline!.cues.map(cue => cue.id)

/** Every authored cue fired, and none was rejected by its Capability. */
const expectTimelineExecuted = (scenario: ScenarioRun, scenarioId: string): void => {
  expect(scenario.failedCues()).toEqual([])
  expect([...scenario.firedCueIds()].sort()).toEqual([...cueIdsOf(scenarioId)].sort())
}

interface AssetGetResult {
  readonly asset: {
    readonly state: {
      readonly state: string
      readonly dispatchMw?: number
      readonly mfrrMw?: number
    }
  }
}

interface AssetSearchResult {
  readonly total: number
  readonly assets: ReadonlyArray<{ readonly id: string }>
}

interface ScreenedBranch {
  readonly assetId: string
  readonly loadingPercent: number
}

interface ContingencyResult {
  readonly contingency: { readonly assetId: string }
  readonly islanding: boolean
  readonly overloadedBranches: ReadonlyArray<ScreenedBranch>
  readonly violationCount: number
}

interface ScreeningSummary {
  readonly violatingCount: number
  readonly baseCase: { readonly overloadedCount: number }
}

interface ScreenResult extends ScreeningSummary {
  readonly results: ReadonlyArray<ContingencyResult>
}

interface RemedialResult {
  readonly actionBalances: ReadonlyArray<unknown>
  readonly before: ScreeningSummary
  readonly after: ScreeningSummary
  readonly results: ReadonlyArray<ContingencyResult>
}

const trippedCount = async (scenario: ScenarioRun, kind: 'branch' | 'generator'): Promise<number> =>
  (await scenario.query<AssetSearchResult>('world.electric-grid.assets.search', { kinds: [kind], status: ['tripped'], limit: 1 })).total

describe('bundled Electric Grid Scenarios', () => {
  test('nordic-frequency-event: FCR-D arrests the Kvilldal trip above LFDD and aFRR and mFRR restore 50 Hz', async () => {
    const scenario = await startScenarioRun('nordic-frequency-event', 'grid:norway')
    const kvilldal = 'generator:nve-hydro-222'
    const tripSeconds = 120
    try {
      await scenario.advanceTo(tripSeconds - 1)
      const before = scenario.projection()
      expect(Math.abs(before.frequencyHz! - 50)).toBeLessThan(0.01)
      expect(before.unservedLoadMw).toBe(0)
      expect(await trippedCount(scenario, 'branch')).toBe(0)
      const lostMw = (await scenario.query<AssetGetResult>('world.electric-grid.asset.get', { assetId: kvilldal })).asset.state.dispatchMw!
      expect(lostMw).toBeGreaterThan(400)

      await scenario.advanceTo(tripSeconds + 15 * 60)
      expectTimelineExecuted(scenario, 'nordic-frequency-event')
      expect((await scenario.query<AssetGetResult>('world.electric-grid.asset.get', { assetId: kvilldal })).asset.state.state).toBe('tripped')
      const after = scenario.samples.filter(sample => sample.seconds > tripSeconds)
      const nadir = after.reduce((lowest, sample) => sample.projection.frequencyHz! < lowest.projection.frequencyHz! ? sample : lowest)
      const nadirHz = nadir.projection.frequencyHz!
      const nadirAfterSeconds = nadir.seconds - tripSeconds
      const maximumRocof = Math.max(...after.map(sample => Math.abs(sample.projection.islands.find(island => island.id === sample.projection.frequencyIslandId)!.rocofHzPerSecond!)))
      const standardRangeFrom = after.find(sample => after.every(later => later.seconds < sample.seconds || Math.abs(later.projection.frequencyHz! - 50) < 0.1))!.seconds - tripSeconds
      const finalHz = scenario.projection().frequencyHz!
      // FCR-D arrests the fall well above the 48.8 Hz first LFDD stage and the 49.0 Hz FCR-D design limit.
      expect(nadirHz).toBeGreaterThan(49.55)
      expect(nadirHz).toBeLessThan(49.85)
      expect(nadirAfterSeconds).toBeGreaterThanOrEqual(3)
      expect(nadirAfterSeconds).toBeLessThanOrEqual(20)
      expect(maximumRocof).toBeGreaterThan(0.02)
      expect(maximumRocof).toBeLessThan(0.2)
      expect(after.every(sample => sample.projection.unservedLoadMw === 0)).toBe(true)
      expect(await trippedCount(scenario, 'generator')).toBe(1)
      // aFRR returns the frequency to the ±100 mHz standard range within five minutes; mFRR closes the rest.
      expect(standardRangeFrom).toBeLessThanOrEqual(5 * 60)
      expect(Math.abs(finalHz - 50)).toBeLessThan(0.02)
      const largest = await scenario.query<AssetSearchResult>('world.electric-grid.assets.search', { kinds: ['generator'], status: ['online'], sort: 'dispatch', limit: 10 })
      const activatedMfrrMw = (await Promise.all(largest.assets.map(async asset =>
        (await scenario.query<AssetGetResult>('world.electric-grid.asset.get', { assetId: asset.id })).asset.state.mfrrMw!))).reduce((sum, value) => sum + value, 0)
      expect(activatedMfrrMw).toBeGreaterThan(0)
      console.info(`nordic-frequency-event: Kvilldal ${lostMw.toFixed(0)} MW lost; nadir ${nadirHz.toFixed(3)} Hz ${nadirAfterSeconds} s after the trip, |RoCoF| ≤ ${maximumRocof.toFixed(3)} Hz/s; within ±100 mHz from ${standardRangeFrom} s; f(15 min) ${finalHz.toFixed(4)} Hz; mFRR on the ten largest units ${activatedMfrrMw.toFixed(0)} MW`)
    } finally { await scenario.close() }
  }, 120_000)

  const svartisenRana = 'branch:osm-ac345cb49df196e1'
  const smibelgSjona = 'branch:osm-0fb54dfbafcab6d8'

  test('nordland-corridor-security: N-1 shows the Helgeland overload and sectionalising at Sjona removes it before the trip', async () => {
    const scenario = await startScenarioRun('nordland-corridor-security', 'grid:norway')
    try {
      await scenario.advanceTo(60)
      expect(scenario.projection().highestBranchLoadingPercent).toBeLessThan(100)
      const screen = await scenario.query<ScreenResult>('world.electric-grid.contingency.screen', { contingencies: 'all-branches', limit: 50 })
      expect(screen.baseCase.overloadedCount).toBe(0)
      const outage = screen.results.find(result => result.contingency.assetId === svartisenRana)
      expect(outage).toBeDefined()
      expect(outage!.islanding).toBe(false)
      const helgeland = outage!.overloadedBranches.find(branch => branch.assetId === smibelgSjona)
      // Above the 150 % instantaneous element: protection would trip it at once.
      expect(helgeland!.loadingPercent).toBeGreaterThan(150)

      const evaluated = await scenario.query<RemedialResult>('world.electric-grid.remedial-actions.evaluate', {
        contingencies: 'all-branches',
        actions: [{ kind: 'open-branch', assetId: smibelgSjona }],
        limit: 50,
      })
      expect(evaluated.actionBalances).toEqual([])
      expect(evaluated.after.baseCase.overloadedCount).toBe(0)
      expect(evaluated.after.violatingCount).toBeLessThan(evaluated.before.violatingCount)
      expect(evaluated.results.find(result => result.contingency.assetId === svartisenRana)?.violationCount ?? 0).toBe(0)

      expect((await scenario.command('world.electric-grid.open-branch', { assetId: smibelgSjona })).ok).toBe(true)
      const verified = await scenario.query<ScreenResult>('world.electric-grid.contingency.screen', { contingencies: [svartisenRana], limit: 1 })
      expect(verified.results[0]!.violationCount).toBe(0)

      await scenario.advanceTo(660)
      expectTimelineExecuted(scenario, 'nordland-corridor-security')
      expect((await scenario.query<AssetGetResult>('world.electric-grid.asset.get', { assetId: svartisenRana })).asset.state.state).toBe('open')
      const afterTrip = scenario.projection()
      expect(afterTrip.highestBranchLoadingPercent).toBeLessThan(100)
      expect(afterTrip.unservedLoadMw).toBe(0)
      expect(afterTrip.activeIslandCount).toBe(1)
      expect(await trippedCount(scenario, 'branch')).toBe(0)
      console.info(`nordland-corridor-security: Svartisen – Rana outage loads Smibelg – Sjona to ${helgeland!.loadingPercent} %; opening Smibelg – Sjona leaves ${evaluated.after.violatingCount} of ${evaluated.before.violatingCount} violating outages; after the trip the highest loading is ${afterTrip.highestBranchLoadingPercent.toFixed(1)} %`)
    } finally { await scenario.close() }
  }, 120_000)

  test('nordland-corridor-security: without a remedial action the trip overloads Helgeland and its protection disconnects load', async () => {
    const scenario = await startScenarioRun('nordland-corridor-security', 'grid:norway')
    try {
      await scenario.advanceTo(660)
      expectTimelineExecuted(scenario, 'nordland-corridor-security')
      expect((await scenario.query<AssetGetResult>('world.electric-grid.asset.get', { assetId: smibelgSjona })).asset.state.state).toBe('tripped')
      const branchTrips = await trippedCount(scenario, 'branch')
      const unservedMw = scenario.projection().unservedLoadMw
      expect(branchTrips).toBeGreaterThanOrEqual(3)
      expect(unservedMw).toBeGreaterThan(0)
      console.info(`nordland-corridor-security without action: ${branchTrips} branches tripped, ${unservedMw.toFixed(1)} MW unserved`)
    } finally { await scenario.close() }
  }, 120_000)
})
