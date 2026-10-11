import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IsoTimestamp } from '../src/core/model/index.ts'
import { norwayGridModelRef } from '../src/packs/electric-grid/definition-refs.ts'
import { gridLoadProfiles } from '../src/packs/electric-grid/definitions.ts'
import type { CompiledGridDefinition } from '../src/packs/electric-grid/grid-model.ts'
import { compileGridModelV2 } from '../src/packs/electric-grid/models/compile-v2.ts'
import { answerElectricGridQuery } from '../src/packs/electric-grid/queries/index.ts'
import { captureContingencySnapshot, type ContingencyRatingBasis } from '../src/packs/electric-grid/runtime/contingency-capture.ts'
import { liveContingencyCase, type ContingencyCase } from '../src/packs/electric-grid/runtime/contingency-case.ts'
import {
  contingencyExecution,
  inlineScreeningWorkUnits,
  screeningChunks,
  screeningWorkUnits,
  screenRecordsInline,
  screenRecordsOnPool,
  sizedContingencyScreen,
} from '../src/packs/electric-grid/runtime/contingency-execution.ts'
import { contingencyPoolConfigFromEnv, createContingencyPool, type ContingencyPool } from '../src/packs/electric-grid/runtime/contingency-pool.ts'
import { screenContingencies, selectContingencies, type BranchOutageScope, type ContingencySelection, type ScreeningSummary } from '../src/packs/electric-grid/runtime/contingency-screen.ts'
import { sharedScreeningRecords, type ContingencySnapshot, type GridContingency } from '../src/packs/electric-grid/runtime/contingency-snapshot.ts'
import { createGridRuntimeInstance, type GridRuntimeInstance } from '../src/packs/electric-grid/runtime/instance.ts'
import { advanceGrid } from '../src/packs/electric-grid/runtime/solver.ts'
import { gridAutomationSchema } from '../src/packs/electric-grid/schemas/grid-automation.ts'
import { validateGridModel } from '../src/packs/electric-grid/schemas/grid-model.ts'
import { gridOperatingPointTargetsForModel, validateGridOperatingPoint } from '../src/packs/electric-grid/schemas/grid-operating-point.ts'
import { runtimeStateForElectricGrids } from '../src/packs/electric-grid/sim/runtime-state.ts'
import { referenceComputation, threadCpuMs } from './cpu-cost.ts'
import { corridorDefinition, steppedGrid } from './fixtures/grid-corridor.ts'
import { gridDefinitionForModel, syntheticGridDefinition } from './fixtures/synthetic-grid.ts'

const workerUrl = new URL('../src/packs/electric-grid/runtime/contingency-worker.ts', import.meta.url)
const pools: ContingencyPool[] = []
const poolOf = (size: number, idleTimeoutMs = 60_000, url = workerUrl): ContingencyPool => {
  const pool = createContingencyPool({ size, sizeReason: `test pool of ${size}`, idleTimeoutMs, workerUrl: url })
  pools.push(pool)
  return pool
}
afterAll(() => {
  for (const pool of pools) pool.close()
})

const at = '2026-01-15T07:00:00.000Z' as IsoTimestamp
const solved = (definition: CompiledGridDefinition): GridRuntimeInstance => {
  const grid = createGridRuntimeInstance({ definition, at })
  advanceGrid(grid, 0, at)
  return grid
}

/** The v2 Norway model at the winter weekday peak, as the N-1 performance test screens it. */
const v2Grid = async (): Promise<GridRuntimeInstance> => {
  const directory = join(import.meta.dir, '../src/packs/electric-grid/models')
  const generated = validateGridModel(JSON.parse(await readFile(join(directory, 'norway-transmission.grid-model.json'), 'utf8')), 'v2')
  const winter = validateGridOperatingPoint(JSON.parse(await readFile(join(directory, 'norway-winter-weekday-peak.operating-point.json'), 'utf8')), 'winter', gridOperatingPointTargetsForModel(generated))
  return solved(gridDefinitionForModel(compileGridModelV2(generated, winter, gridLoadProfiles(norwayGridModelRef)).model))
}

/** The synthetic grid intact: with branch relays its random dispatch would trip a fifth of it at once. */
const intactSynthetic = (busCount: number): GridRuntimeInstance => {
  const base = syntheticGridDefinition(busCount)
  return solved({ ...base, automation: gridAutomationSchema.parse({ ...base.automation, branchProtection: { enabled: false } }) })
}

const inline = async (snapshot: ContingencySnapshot) => screenRecordsInline(snapshot)
const onPool = (pool: ContingencyPool) => async (snapshot: ContingencySnapshot) => await screenRecordsOnPool(snapshot, pool)

const screened = async (screeningCase: ContingencyCase, contingencies: ReadonlyArray<GridContingency>, ratingBasis: ContingencyRatingBasis, screen: (snapshot: ContingencySnapshot) => Promise<ReturnType<typeof screenRecordsInline>>): Promise<ScreeningSummary> =>
  await screenContingencies({ screeningCase, contingencies, ratingBasis, screen })

const median = (values: ReadonlyArray<number>): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!

const wallMs = async (run: () => Promise<unknown>): Promise<number> => {
  const started = performance.now()
  await run()
  return performance.now() - started
}

const medianWallMs = async (run: () => Promise<unknown>, rounds: number): Promise<number> => {
  const samples: number[] = []
  for (let round = 0; round < rounds; round += 1) samples.push(await wallMs(run))
  return median(samples)
}

/** Main-thread CPU of an async run in references timed just before it, the median of `rounds` (cpu-cost.ts). */
const mainThreadCostInReferences = async (run: () => Promise<unknown>, rounds: number): Promise<number> => {
  const ratios: number[] = []
  for (let round = 0; round < rounds; round += 1) {
    const referenceMs = threadCpuMs(referenceComputation)
    const before = process.threadCpuUsage()
    await run()
    const used = process.threadCpuUsage(before)
    ratios.push((used.user + used.system) / 1_000 / referenceMs)
  }
  return median(ratios)
}

const snapshotDigest = (snapshot: ContingencySnapshot): string => {
  const hash = createHash('sha256')
  const visit = (value: unknown): void => {
    if (ArrayBuffer.isView(value)) hash.update(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
    else if (typeof value === 'number') hash.update(String(value))
    else if (typeof value === 'object' && value !== null) for (const key of Object.keys(value).sort()) visit((value as Record<string, unknown>)[key])
  }
  visit(snapshot)
  return hash.digest('hex')
}

describe('electric grid N-1 worker pool', () => {
  test('a parallel screening is byte-identical to the inline one on the v2 model, and leaves the main thread nearly idle', async () => {
    const grid = await v2Grid()
    const live = liveContingencyCase(grid)
    // AC base flows with DC increments.
    expect(live.baseFlowModels.map(island => island.flowModel)).toEqual(['ac'])
    const pool = poolOf(3)
    // One circuit of each multi-circuit branch, every circuit of each branch, and the largest units.
    const selections: ReadonlyArray<readonly [ContingencySelection, BranchOutageScope]> = [
      [{ kind: 'all-branches' }, 'circuit'],
      [{ kind: 'all-branches' }, 'branch'],
      [{ kind: 'largest-generators', count: 100 }, 'circuit'],
    ]
    for (const [selection, branchOutage] of selections) {
      for (const ratingBasis of ['normal', 'emergency'] as const) {
        const contingencies = selectContingencies(live, selection, branchOutage)
        const alone = JSON.stringify(await screened(live, contingencies, ratingBasis, inline))
        const parallel = JSON.stringify(await screened(live, contingencies, ratingBasis, onPool(pool)))
        expect(parallel).toBe(alone)
        // Deterministic: the same case screens to the same bytes again.
        expect(JSON.stringify(await screened(live, contingencies, ratingBasis, onPool(pool)))).toBe(alone)
      }
    }
    // The query takes the pool by the size rule and answers with the same results.
    const all = selectContingencies(live, { kind: 'all-branches' }, 'circuit')
    expect(contingencyExecution(captureContingencySnapshot(live, all, 'normal'), 3)).toBe('pool')
    const answer = await answerElectricGridQuery({
      request: { capabilityId: 'world.electric-grid.contingency.screen', input: { gridId: grid.definition.gridId, contingencies: 'all-branches', limit: 500 } },
      grids: new Map([[grid.definition.gridId, grid]]),
    }) as { results: unknown }
    expect(JSON.stringify(answer.results)).toBe(JSON.stringify((await screened(live, all, 'normal', inline)).results.slice(0, 500)))

    const inlineCost = await mainThreadCostInReferences(() => screened(live, all, 'normal', inline), 5)
    const poolCost = await mainThreadCostInReferences(() => screened(live, all, 'normal', onPool(pool)), 5)
    const inlineMs = await medianWallMs(() => screened(live, all, 'normal', inline), 3)
    const poolMs = await medianWallMs(() => screened(live, all, 'normal', onPool(pool)), 3)
    console.info(`N-1 v2 all ${all.length} branches: inline ${inlineMs.toFixed(1)} ms wall, ${inlineCost.toFixed(2)} references main thread; 3 workers ${poolMs.toFixed(1)} ms wall, ${poolCost.toFixed(2)} references main thread`)
    // Capture and formatting stay on the main thread; the kernel does not.
    expect(poolCost).toBeLessThan(inlineCost / 3)
  }, 120_000)

  test('a parallel screening is byte-identical to the inline one on a synthetic 10k-bus grid, and faster', async () => {
    const grid = intactSynthetic(10_000)
    const live = liveContingencyCase(grid)
    // Its AC load flow converges at the fixture's declared demand (1.0 at 08:00), so the base flows are AC.
    expect(live.baseFlowModels.map(island => island.flowModel)).toEqual(['ac'])
    const pool = poolOf(3)
    const branches = selectContingencies(live, { kind: 'all-branches' }, 'circuit')
    expect(branches.length).toBe(14_000)
    // Every fourth branch across the grid (meshed and bridges) and the 50 largest units.
    const contingencies = [...branches.filter((_, index) => index % 4 === 0), ...selectContingencies(live, { kind: 'largest-generators', count: 50 }, 'circuit')]
    const snapshot = captureContingencySnapshot(live, contingencies, 'normal')
    expect(Array.from(snapshot.bridges.childOf).some(child => child >= 0)).toBe(true)
    let alone = ''
    const inlineMs = await wallMs(async () => { alone = JSON.stringify(await screened(live, contingencies, 'normal', inline)) })
    let parallel = ''
    // The first pooled screening also starts the workers.
    const firstPoolMs = await wallMs(async () => { parallel = JSON.stringify(await screened(live, contingencies, 'normal', onPool(pool))) })
    expect(parallel).toBe(alone)
    const poolMs = await wallMs(() => screened(live, contingencies, 'normal', onPool(pool)))
    console.info(`N-1 10k synthetic, ${contingencies.length} contingencies (${(screeningWorkUnits(snapshot) / 1e6).toFixed(0)} M work units): inline ${inlineMs.toFixed(0)} ms, 3 workers ${firstPoolMs.toFixed(0)} ms cold, ${poolMs.toFixed(0)} ms warm`)
    // Measured 3.6x with four workers at load 4–7; the gate only asks that three beat one.
    expect(poolMs).toBeLessThan(inlineMs)
  }, 120_000)

  test('screening on the pool is read-only: the snapshot, the Grid state, its topology plan and factors are unchanged', async () => {
    const grid = await v2Grid()
    const state = () => JSON.stringify({
      state: runtimeStateForElectricGrids(new Map([[grid.definition.gridId, grid]])),
      projection: grid.projection,
      tick: grid.tick,
      rebuilds: grid.diagnostics.topologyRebuildCount,
      injections: Array.from(grid.topologyPlan!.injectionsMw),
      angles: Array.from(grid.topologyPlan!.anglesRad),
      closed: Array.from(grid.topologyPlan!.closedBranches),
      factors: grid.topologyPlan!.systems.map(system => [Array.from(system.factor.values), Array.from(system.factor.structure.rowIndex)]),
      branches: [...grid.branches.values()],
      generators: [...grid.generators.values()],
    })
    const plan = grid.topologyPlan
    const before = state()
    const live = liveContingencyCase(grid)
    const snapshot = captureContingencySnapshot(live, selectContingencies(live, { kind: 'all-branches' }, 'circuit'), 'emergency')
    const digest = snapshotDigest(snapshot)
    const records = await screenRecordsOnPool(snapshot, poolOf(3))
    expect(records.count).toBe(snapshot.contingencies.count)
    expect(snapshotDigest(snapshot)).toBe(digest)
    expect(grid.topologyPlan).toBe(plan)
    expect(state()).toBe(before)
  }, 60_000)

  test('the size rule screens small cases inline and large ones on the pool; chunks cover every position once', () => {
    const run = steppedGrid(corridorDefinition())
    run.advanceTo(10_000)
    const corridor = liveContingencyCase(run.grid)
    const small = captureContingencySnapshot(corridor, selectContingencies(corridor, { kind: 'all-branches' }, 'circuit'), 'normal')
    expect(screeningWorkUnits(small)).toBeLessThan(inlineScreeningWorkUnits)
    expect(contingencyExecution(small, 4)).toBe('inline')
    const synthetic = liveContingencyCase(intactSynthetic(2_000))
    const large = captureContingencySnapshot(synthetic, selectContingencies(synthetic, { kind: 'all-branches' }, 'circuit'), 'normal')
    expect(contingencyExecution(large, 4)).toBe('pool')
    // A host without a spare core, or LEITBILD_GRID_N1_MAX_WORKERS=0, screens everything inline.
    expect(contingencyExecution(large, 0)).toBe('inline')
    for (const [count, workers] of [[1, 4], [7, 2], [1_239, 3], [14_000, 4]] as const) {
      const chunks = screeningChunks(count, workers)
      expect(chunks.length).toBe(Math.min(count, workers * 4))
      expect(chunks[0]!.start).toBe(0)
      expect(chunks.at(-1)!.end).toBe(count)
      chunks.forEach((chunk, index) => {
        expect(chunk.end).toBeGreaterThan(chunk.start)
        if (index > 0) expect(chunk.start).toBe(chunks[index - 1]!.end)
      })
    }
    const host = { cores: 8, limit: { kind: 'cores', why: 'test host' } } as const
    expect(contingencyPoolConfigFromEnv({ LEITBILD_GRID_N1_MAX_WORKERS: '2', LEITBILD_GRID_N1_IDLE_MS: '500' }, host)).toMatchObject({ size: 2, idleTimeoutMs: 500 })
    expect(contingencyPoolConfigFromEnv({ LEITBILD_GRID_N1_MAX_WORKERS: '0' }, host).size).toBe(0)
    expect(() => contingencyPoolConfigFromEnv({ LEITBILD_GRID_N1_MAX_WORKERS: 'four' }, host)).toThrow('LEITBILD_GRID_N1_MAX_WORKERS must be an integer of at least 0, got "four"')
    expect(() => contingencyPoolConfigFromEnv({ LEITBILD_GRID_N1_IDLE_MS: '0' }, host)).toThrow('LEITBILD_GRID_N1_IDLE_MS must be an integer of at least 1')
  }, 60_000)

  test('a pool starts no worker before its first pooled screening, and none for inline ones', async () => {
    const pool = poolOf(2)
    expect(pool.liveWorkerCount()).toBe(0)
    const run = steppedGrid(corridorDefinition())
    run.advanceTo(10_000)
    const corridor = liveContingencyCase(run.grid)
    await screened(corridor, selectContingencies(corridor, { kind: 'all-branches' }, 'circuit'), 'normal', sizedContingencyScreen(() => pool))
    expect(pool.liveWorkerCount()).toBe(0)
    const synthetic = liveContingencyCase(intactSynthetic(2_000))
    await screened(synthetic, selectContingencies(synthetic, { kind: 'all-branches' }, 'circuit'), 'normal', sizedContingencyScreen(() => pool))
    expect(pool.liveWorkerCount()).toBe(2)
  }, 60_000)

  test('the process pool does not exist at adapter start, stays without workers for small screenings and empties when idle', async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/contingency-pool-process.ts')], {
      env: { ...process.env, LEITBILD_GRID_N1_MAX_WORKERS: '2', LEITBILD_GRID_N1_IDLE_MS: '150' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    const report = JSON.parse(stdout.trim().split('\n').at(-1)!)
    expect(report).toMatchObject({ poolAtStart: null, workersAfterSmall: 0, workersAfterLarge: 2, workersAfterIdle: 0 })
    // grid.summary reports the pool once a screening created it, with how its size was chosen.
    expect(report.poolAtStart).toBeNull()
    expect(report.summaryPoolAtStart).toBeNull()
    expect(report.summaryPoolAfterLarge).toMatchObject({ size: 2, liveWorkerCount: 2 })
    expect(report.summaryPoolAfterLarge.sizeReason).toStartWith('2 workers = min of cores ')
    expect(report.summaryPoolAfterLarge.sizeReason).toContain('cap 2 (LEITBILD_GRID_N1_MAX_WORKERS)')
  }, 60_000)

  test('idle workers are terminated after the idle time, and the next screening starts new ones', async () => {
    const pool = poolOf(2, 100)
    const synthetic = liveContingencyCase(intactSynthetic(1_000))
    const snapshot = captureContingencySnapshot(synthetic, selectContingencies(synthetic, { kind: 'all-branches' }, 'circuit'), 'normal')
    // The idle timer starts with the last chunk's reply, which also resolves the screening.
    const first = await screenRecordsOnPool(snapshot, pool)
    const idleFrom = performance.now()
    expect(pool.liveWorkerCount()).toBe(2)
    // Polled with a generous deadline: a loaded machine may run the idle timer late, never early.
    while (pool.liveWorkerCount() > 0 && performance.now() - idleFrom < 10_000) await Bun.sleep(5)
    expect(pool.liveWorkerCount()).toBe(0)
    expect(performance.now() - idleFrom).toBeGreaterThanOrEqual(90)
    const second = await screenRecordsOnPool(snapshot, pool)
    expect(pool.liveWorkerCount()).toBe(2)
    expect(Array.from(second.integers)).toEqual(Array.from(first.integers))
    expect(Array.from(second.values)).toEqual(Array.from(first.values))
  }, 60_000)

  test('a failing worker fails the screening with its reason and nothing is re-run inline; the pool recovers', async () => {
    const run = steppedGrid(corridorDefinition())
    run.advanceTo(10_000)
    const corridor = liveContingencyCase(run.grid)
    const contingencies = selectContingencies(corridor, { kind: 'all-branches' }, 'circuit')
    const snapshot = captureContingencySnapshot(corridor, contingencies, 'normal')
    const pool = poolOf(2)
    // The kernel throws in the worker: the worker replies with the reason and stays alive.
    await expect(pool.screen(snapshot, sharedScreeningRecords(contingencies.length + 1), [{ start: 0, end: 1 }]))
      .rejects.toThrow(`N-1 screening worker failed: screening records hold ${contingencies.length + 1} contingencies for a snapshot of ${contingencies.length}`)
    expect(pool.liveWorkerCount()).toBe(1)
    // A task the worker cannot read (records it would write to a copy of) is refused the same way.
    const unshared = { ...sharedScreeningRecords(contingencies.length), integers: new Int32Array(contingencies.length * 9) }
    await expect(pool.screen(snapshot, unshared, [{ start: 0, end: 1 }])).rejects.toThrow(/^N-1 screening worker failed: N-1 worker task \d+ carries no shared snapshot and records$/)
    expect(pool.liveWorkerCount()).toBe(1)
    const records = sharedScreeningRecords(contingencies.length)
    await pool.screen(snapshot, records, screeningChunks(contingencies.length, 2))
    expect(Array.from(records.integers)).toEqual(Array.from(screenRecordsInline(snapshot).integers))

    // A worker that crashes or exits fails the whole screening (every chunk of it), and the summary is never formed.
    const crashing = poolOf(2, 60_000, new URL('./fixtures/crashing-contingency-worker.ts', import.meta.url))
    await expect(screened(corridor, contingencies, 'normal', onPool(crashing))).rejects.toThrow(/^N-1 screening worker failed: test worker crash on task \d+$/)
    expect(crashing.liveWorkerCount()).toBeLessThan(2)
    const exiting = poolOf(2, 60_000, new URL('./fixtures/exiting-contingency-worker.ts', import.meta.url))
    await expect(screened(corridor, contingencies, 'normal', onPool(exiting))).rejects.toThrow('N-1 screening worker failed: the worker exited with code 3')
    expect(exiting.liveWorkerCount()).toBeLessThan(2)
    // A closed pool fails what it was running and accepts nothing more.
    const closing = poolOf(1)
    const synthetic = liveContingencyCase(intactSynthetic(1_000))
    const pending = screened(synthetic, selectContingencies(synthetic, { kind: 'all-branches' }, 'circuit'), 'normal', onPool(closing))
    closing.close()
    await expect(pending).rejects.toThrow('the N-1 worker pool was closed during the screening')
    await expect(closing.screen(snapshot, sharedScreeningRecords(contingencies.length), [{ start: 0, end: 1 }])).rejects.toThrow('the N-1 worker pool is closed')
  }, 60_000)
})
