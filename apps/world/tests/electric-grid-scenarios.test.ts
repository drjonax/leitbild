import { newWorkspaceId } from '@leitbild/contracts'
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { electricalPortFromObject, type ActorId, type IsoTimestamp, type ObjectId } from '../src/core/model/index.ts'
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

interface BusGetResult {
  readonly asset: { readonly state: { readonly islandId: string; readonly energized: boolean; readonly frequencyHz: number | null } }
}

interface LoadGetResult {
  readonly asset: {
    readonly definition: { readonly busId: string }
    readonly state: {
      readonly demandMw: number
      readonly servedMw: number
      readonly unservedMw: number
      readonly lfddShedMw: number
      readonly outageMw: number
      readonly manualDemandLimitMw: number | null
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

  test('halden-offsite-power-restoration: the busbar fault de-energises the bays and reclosing returns offsite power to the Plants', async () => {
    const gridId = 'grid:halden-four-unit'
    const scenario = await startScenarioRun('halden-offsite-power-restoration', gridId)
    const plants = [1, 2, 3, 4].map(unit => ({ plantId: `plant:halden-${unit}`, bayId: `unit-${unit}-420kv` }))
    const ports = () => plants.map(({ plantId, bayId }) => ({
      bay: electricalPortFromObject(scenario.object(gridId), bayId)!.state!,
      plant: electricalPortFromObject(scenario.object(plantId), 'grid-420kv')!.state!,
    }))
    const circuits = ['hasle-1', 'hasle-2', 'hasle-3', 'tegneby-1', 'tegneby-2', 'tegneby-3'].map(name => `branch:curated-halden-pwr-${name}`)
    try {
      await scenario.advanceTo(119)
      for (const { bay, plant } of ports()) {
        expect(bay).toMatchObject({ energized: true, connected: true })
        expect(plant).toMatchObject({ energized: true, connected: true })
        expect(bay.activePowerMw).toBeLessThan(-900)
      }
      const exportMw = -ports().reduce((sum, { bay }) => sum + bay.activePowerMw, 0)

      await scenario.advanceTo(180)
      expectTimelineExecuted(scenario, 'halden-offsite-power-restoration')
      for (const { bay, plant } of ports()) {
        expect(bay).toMatchObject({ energized: false, voltagePu: 0, frequencyHz: null })
        expect(plant).toMatchObject({ connected: false })
      }
      const transient = scenario.samples.filter(sample => sample.seconds > 120)
      const nadirHz = Math.min(...transient.map(sample => sample.projection.frequencyHz!))
      const lfddMw = Math.max(...transient.map(sample => sample.projection.unservedLoadMw))
      // About 4.2 GW lost at once: the frequency falls through the LFDD stages, which shed load.
      expect(nadirHz).toBeLessThan(49)
      expect(nadirHz).toBeGreaterThan(47.5)
      expect(lfddMw).toBeGreaterThan(500)

      // Dead-bus closing: one Hasle circuit energises the switchyard from the grid.
      expect((await scenario.command('world.electric-grid.close-branch', { assetId: circuits[0]! })).ok).toBe(true)
      await scenario.advanceTo(182)
      for (const { bay, plant } of ports()) {
        expect(bay.energized).toBe(true)
        expect(bay.energized && bay.voltagePu).toBeGreaterThan(0.9)
        expect(plant).toMatchObject({ energized: true, connected: true })
        // The tripped units draw station service instead of returning their export at once.
        expect(plant.activePowerMw).toBeLessThan(100)
      }
      // Loop closing under synchro-check: each remaining circuit closes within the angle limit.
      for (const circuit of circuits.slice(1)) expect((await scenario.command('world.electric-grid.close-branch', { assetId: circuit })).ok).toBe(true)
      await scenario.advanceTo(240)
      for (const circuit of circuits) {
        expect((await scenario.query<AssetGetResult>('world.electric-grid.asset.get', { assetId: circuit })).asset.state.state).toBe('closed')
      }
      for (const { bay, plant } of ports()) {
        expect(bay.energized).toBe(true)
        expect(plant).toMatchObject({ energized: true, connected: true })
      }
      console.info(`halden-offsite-power-restoration: ${exportMw.toFixed(0)} MW export lost; nadir ${nadirHz.toFixed(3)} Hz; LFDD and outage ${lfddMw.toFixed(0)} MW; bays re-energised by dead-bus closing; f(240 s) ${scenario.projection().frequencyHz!.toFixed(3)} Hz`)
    } finally { await scenario.close() }
  }, 180_000)

  test('rogaland-black-start: the separated region goes dark, Lysebotn I black-starts it, blocks stay clear of LFDD and synchro-check gates the resynchronisation', async () => {
    const scenario = await startScenarioRun('rogaland-black-start', 'grid:norway')
    const lysebotnBus = 'bus:osm-relation-8886668@132'
    const lysebotn = 'generator:nve-hydro-257'
    // Forsand small hydro: a run-of-river aggregate that the model does not mark black-start capable.
    const follower = 'generator:aggregate-osm-relation-12678808@132-hydro-run-of-river'
    const fagrafjell = 'branch:transformer-osm-way-830770515-300-132'
    const lyse = 'branch:transformer-osm-relation-8886202-300-132'
    const startingBlockBuses = new Set(['bus:osm-relation-12678808@132', 'bus:osm-relation-10876752@132', 'bus:osm-relation-12678806@132', 'bus:osm-way-1191984327@132', 'bus:osm-way-1191984325@132'])
    const islandPickUpBuses = new Set(['bus:osm-way-50192634@132', 'bus:osm-relation-20603477@132', 'bus:osm-way-288575132@132', 'bus:osm-way-830770515@132'])
    const bus = async () => (await scenario.query<BusGetResult>('world.electric-grid.asset.get', { assetId: lysebotnBus })).asset.state
    const load = async (assetId: string) => (await scenario.query<LoadGetResult>('world.electric-grid.asset.get', { assetId })).asset
    const generatorState = async (assetId: string) => (await scenario.query<AssetGetResult>('world.electric-grid.asset.get', { assetId })).asset.state
    const ok = async (capabilityId: string, input: Record<string, unknown>) => expect((await scenario.command(capabilityId, input)).ok).toBe(true)
    // The black-start island is the only energised island off nominal; the main grid is the largest-load island.
    const islandOffsetHz = async (): Promise<number> => Math.abs((await bus()).frequencyHz! - scenario.projection().frequencyHz!)
    try {
      await scenario.advanceTo(59)
      expect((await bus()).energized).toBe(true)

      await scenario.advanceTo(65)
      expectTimelineExecuted(scenario, 'rogaland-black-start')
      const dark = await bus()
      expect(dark.energized).toBe(false)
      const regionGenerators = await scenario.query<AssetSearchResult>('world.electric-grid.assets.search', { islandId: dark.islandId, kinds: ['generator'], limit: 50 })
      const regionTripped = await scenario.query<AssetSearchResult>('world.electric-grid.assets.search', { islandId: dark.islandId, kinds: ['generator'], status: ['tripped'], limit: 50 })
      expect(regionGenerators.total).toBeGreaterThan(0)
      expect(regionTripped.total).toBe(regionGenerators.total)
      const loadIds = (await scenario.query<AssetSearchResult>('world.electric-grid.assets.search', { islandId: dark.islandId, kinds: ['load'], limit: 200 })).assets.map(asset => asset.id)
      const loads = new Map(await Promise.all(loadIds.map(async id => [id, await load(id)] as const)))
      const outageMw = [...loads.values()].reduce((sum, entry) => sum + entry.state.outageMw, 0)
      expect(outageMw).toBeGreaterThan(250)
      expect([...loads.values()].every(entry => entry.state.lfddShedMw === 0)).toBe(true)
      expect(scenario.projection().activeIslandCount).toBe(1)
      expect(Math.abs(scenario.projection().frequencyHz! - 50)).toBeLessThan(0.3)

      // Only a black-start capable unit may start in the dead island.
      await ok('world.electric-grid.reset-generator-trip', { assetId: follower })
      const refused = await scenario.command('world.electric-grid.start-generator', { assetId: follower })
      expect(refused.ok).toBe(false)
      expect(refused.ok ? '' : refused.reason).toContain('is not black-start capable')

      // Disconnect everything but the Ryfylke starting block, then black-start Lysebotn I onto it.
      const startingBlock = loadIds.filter(id => startingBlockBuses.has(loads.get(id)!.definition.busId))
      const shed = loadIds.filter(id => !startingBlockBuses.has(loads.get(id)!.definition.busId))
      for (const id of shed) await ok('world.electric-grid.shed-load', { assetId: id, targetDemandMw: 0, emergency: true })
      const startingBlockMw = startingBlock.reduce((sum, id) => sum + loads.get(id)!.state.demandMw, 0)
      await ok('world.electric-grid.reset-generator-trip', { assetId: lysebotn })
      await ok('world.electric-grid.start-generator', { assetId: lysebotn })
      const blackStartAt = 65
      await scenario.advanceTo(blackStartAt + 330)
      expect((await generatorState(lysebotn)).state).toBe('online')
      const energised = await bus()
      expect(energised.energized).toBe(true)
      expect(energised.frequencyHz!).toBeGreaterThan(49.5)
      expect(energised.frequencyHz!).toBeLessThan(50.5)
      // Once the island is live, a unit without black-start capability may start in it.
      await ok('world.electric-grid.start-generator', { assetId: follower })

      // Pick up Stavanger and Sandnes demand in blocks of at most 10 MW, the set-point raised with each.
      const firstPickUpSample = scenario.samples.length
      let targetMw = Math.round((startingBlockMw + 0.3) * 10) / 10
      await ok('world.electric-grid.dispatch-generator', { assetId: lysebotn, targetMw })
      await scenario.advanceTo(blackStartAt + 450)
      const candidates = shed.filter(id => islandPickUpBuses.has(loads.get(id)!.definition.busId))
        .sort((left, right) => loads.get(left)!.state.demandMw - loads.get(right)!.state.demandMw)
      const blocks: string[][] = []
      for (const id of candidates) {
        const last = blocks.at(-1)
        const lastMw = last?.reduce((sum, member) => sum + loads.get(member)!.state.demandMw, 0) ?? Number.POSITIVE_INFINITY
        if (last && lastMw + loads.get(id)!.state.demandMw <= 10) last.push(id)
        else blocks.push([id])
      }
      // 114 MW: 95 % of Lysebotn I's 120 MW, leaving headroom for its governor.
      const blockMw = (block: ReadonlyArray<string>): number => block.reduce((sum, id) => sum + loads.get(id)!.state.demandMw, 0)
      const fitting = blocks.filter((_, index) => targetMw + blocks.slice(0, index + 1).reduce((sum, block) => sum + blockMw(block), 0) <= 114)
      let elapsed = blackStartAt + 450
      let offsetBeforeCloseHz = 0
      for (const [index, block] of fitting.entries()) {
        targetMw = Math.round((targetMw + blockMw(block)) * 10) / 10
        await ok('world.electric-grid.dispatch-generator', { assetId: lysebotn, targetMw })
        for (const id of block) await ok('world.electric-grid.restore-load', { assetId: id })
        if (index === fitting.length - 1) {
          // Closing during the last block's frequency dip: synchro-check refuses the transformer.
          await scenario.advanceTo(elapsed + 3)
          offsetBeforeCloseHz = await islandOffsetHz()
          expect(offsetBeforeCloseHz).toBeGreaterThan(0.1)
          const blocked = await scenario.command('world.electric-grid.close-branch', { assetId: fagrafjell })
          expect(blocked.ok).toBe(false)
          expect(blocked.ok ? '' : blocked.reason).toContain('synchro-check')
        }
        elapsed += 180
        await scenario.advanceTo(elapsed)
      }
      const pickedUpMw = fitting.reduce((sum, block) => sum + blockMw(block), 0)
      const largestBlockMw = Math.max(...fitting.map(blockMw))
      const pickUp = scenario.samples.slice(firstPickUpSample)
      const lowestHz = Math.min(...pickUp.map(sample => sample.projection.frequencyMinHz!))
      // Every block stays above the 48.8 Hz first LFDD stage.
      expect(pickedUpMw).toBeGreaterThan(50)
      expect(largestBlockMw).toBeLessThanOrEqual(10)
      expect(lowestHz).toBeGreaterThan(48.8)
      for (const id of [...startingBlock, ...candidates]) expect((await load(id)).state.lfddShedMw).toBe(0)

      // Watch the frequencies converge; if the island settles short of the limit, trim Lysebotn I up by 1 MW.
      const waitFrom = elapsed
      let trimmed = false
      while (await islandOffsetHz() > 0.08) {
        expect(elapsed - waitFrom).toBeLessThan(900)
        if (!trimmed && elapsed - waitFrom >= 300) {
          trimmed = true
          await ok('world.electric-grid.dispatch-generator', { assetId: lysebotn, targetMw: Math.round((targetMw + 1) * 10) / 10 })
        }
        elapsed += 10
        await scenario.advanceTo(elapsed)
      }
      const offsetAtCloseHz = await islandOffsetHz()
      const waitedSeconds = elapsed - waitFrom
      await ok('world.electric-grid.close-branch', { assetId: fagrafjell })
      await ok('world.electric-grid.close-branch', { assetId: lyse })
      for (const id of shed) if ((await load(id)).state.manualDemandLimitMw !== null) await ok('world.electric-grid.restore-load', { assetId: id })
      elapsed += 120
      await scenario.advanceTo(elapsed)
      const restored = await Promise.all(loadIds.map(load))
      expect(restored.every(entry => entry.state.unservedMw < 0.01 && entry.state.lfddShedMw === 0)).toBe(true)
      expect(scenario.projection().activeIslandCount).toBe(1)
      expect((await bus()).energized).toBe(true)
      expect(await trippedCount(scenario, 'branch')).toBe(0)
      console.info(`rogaland-black-start: ${outageMw.toFixed(0)} MW dark, ${regionTripped.total} units tripped; starting block ${startingBlockMw.toFixed(1)} MW; ${pickedUpMw.toFixed(1)} MW picked up in ${fitting.length} blocks of at most ${largestBlockMw.toFixed(1)} MW with the lowest frequency ${lowestHz.toFixed(3)} Hz; synchro-check refused at ${offsetBeforeCloseHz.toFixed(3)} Hz and closed at ${offsetAtCloseHz.toFixed(3)} Hz after waiting ${waitedSeconds} s${trimmed ? ' with a 1 MW trim' : ''}; ${restored.reduce((sum, entry) => sum + entry.state.servedMw, 0).toFixed(0)} MW served at the end`)
    } finally { await scenario.close() }
  }, 300_000)
})
