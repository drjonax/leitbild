import { describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/ids.ts'
import type { VignetteSample, VignetteView } from '../src/features/displays/compose/model.ts'
import { createVignetteSession, GAP_MS, INACTIVE_RETRY_MS, SAMPLE_BACKOFF_MS, SAMPLE_INTERVAL_MS, sampleStale, STALE_AFTER_MS, type RunPresence, type VignetteSnapshot } from '../src/ui/embed/vignette/vignette-client.ts'

// The vignette's link to its Run (architecture B1): presence before anything,
// never loading a Run; the view once; history with the first sample only, and
// again after a gap; one sample a second while shown, none while hidden.

type Pen = Extract<VignetteView['sections'][number], { kind: 'trend' }>['strips'][number][number]
const levelPen: Pen = { ref: 'unit-1#level', label: 'Unit 1 · Level', quantity: 'level', unit: '%', valueType: 'number', thresholds: [], series: { seriesId: 'unit-1.level', intervalMs: 1_000 } }
const trendOf = (pens: ReadonlyArray<Pen>): VignetteView => ({ title: 'Level', sections: [{ kind: 'trend', rows: 4, horizonMs: 600_000, strips: [pens] }] })
const view = trendOf([levelPen])

const harness = (presence: (at: string) => RunPresence | null) => {
  let wall = 0
  let runMs = Date.parse('2026-10-21T10:00:00.000Z')
  const timers: Array<{ at: number; run: () => void; cancelled: boolean }> = []
  const calls: string[] = []
  /** How long the Run takes to answer a sample, on the fake clock. */
  let latencyMs = 0
  /** The quality the level reads with. */
  let quality: VignetteSample['observations'][number]['quality'] = 'good'
  const later = <T>(value: () => T): Promise<T> => latencyMs === 0 ? Promise.resolve(value())
    : new Promise(resolve => { timers.push({ at: wall + latencyMs, run: () => resolve(value()), cancelled: false }) })
  const snapshots: VignetteSnapshot[] = []
  const sample = (history?: { readonly fromMs: number }): VignetteSample => ({
    at: { at: new Date(runMs).toISOString(), clock: 'simulation', paused: false },
    observations: [{ ref: 'unit-1#level', at: new Date(runMs).toISOString(), clock: 'simulation', value: 40 + (runMs % 10_000) / 1_000, quality, priority: 'none' }],
    alerts: [], entities: {}, slots: {}, maps: {},
    ...(history === undefined ? {} : { series: { 'unit-1.level': { holdMs: 90_000, points: [{ t: history.fromMs + 1_000, v: 30 }] } } }),
  })
  const session = createVignetteSession({
    runId: 'run-1' as SimulationRunId,
    state: '{"title":"Level"}',
    routes: {
      presence: async () => { calls.push('presence'); return presence(new Date(runMs).toISOString()) },
      view: async () => { calls.push('view'); return view },
      sample: async (_runId, _state, history) => { calls.push(history === undefined ? 'sample' : `history ${runMs - history.fromMs}`); return later(() => sample(history)) },
    },
    onChange: snapshot => { snapshots.push(snapshot) },
    wallNow: () => wall,
    schedule: (run, delayMs) => {
      const timer = { at: wall + delayMs, run, cancelled: false }
      timers.push(timer)
      return () => { timer.cancelled = true }
    },
  })
  const settle = async (): Promise<void> => { for (let turn = 0; turn < 20; turn += 1) await Promise.resolve() }
  /** Moves both clocks on and runs every timer that falls due. */
  const advance = async (ms: number): Promise<void> => {
    const end = wall + ms
    for (;;) {
      const due = timers.filter(timer => !timer.cancelled && timer.at <= end).sort((left, right) => left.at - right.at)[0]
      if (due === undefined) break
      due.cancelled = true
      runMs += due.at - wall
      wall = due.at
      due.run()
      await settle()
    }
    runMs += end - wall
    wall = end
  }
  return {
    session, calls, snapshots, settle, advance, pending: () => timers.filter(timer => !timer.cancelled).length, last: () => snapshots.at(-1)!,
    wall: () => wall, answerIn: (ms: number) => { latencyMs = ms }, readsAs: (next: typeof quality) => { quality = next },
  }
}

const loaded = (at: string): RunPresence => ({ loaded: true, at })

describe('vignette session', () => {
  test('presence first, the view once, history with the first sample only, then a sample a second', async () => {
    const run = harness(loaded)
    run.session.start()
    await run.settle()
    expect(run.calls).toEqual(['presence', 'view', 'history 600000'])
    expect(run.last().phase).toBe('live')
    // The record keeps the hold the Run served it with.
    expect(run.last().series.get('unit-1#level')).toMatchObject({ holdMs: 90_000 })
    expect(run.last().series.get('unit-1#level')?.points.length).toBe(2)
    await run.advance(3 * SAMPLE_INTERVAL_MS)
    expect(run.calls.slice(3)).toEqual(['sample', 'sample', 'sample'])
    expect(run.last().series.get('unit-1#level')?.points.length).toBe(5)
    expect(run.last().series.get('unit-1#level')?.holdMs).toBe(90_000)
    run.session.close()
  })

  test('hidden, it asks the Run nothing; shown again after a gap it reads presence and the history again', async () => {
    const run = harness(loaded)
    run.session.start()
    await run.settle()
    run.session.setVisible(false)
    expect(run.pending()).toBe(0)
    const before = run.calls.length
    await run.advance(GAP_MS * 4)
    expect(run.calls.length).toBe(before)
    run.session.setVisible(true)
    await run.settle()
    expect(run.calls.slice(before)).toEqual(['presence', 'history 600000'])
    run.session.close()
  })

  test('a Run that is not loaded is never loaded: it is asked about again, and drawn once someone loads it', async () => {
    let isLoaded = false
    const run = harness(at => ({ loaded: isLoaded, at }))
    run.session.start()
    await run.settle()
    expect([run.calls, run.last().phase]).toEqual([['presence'], 'inactive'])
    await run.advance(INACTIVE_RETRY_MS)
    expect(run.calls).toEqual(['presence', 'presence'])
    isLoaded = true
    await run.advance(INACTIVE_RETRY_MS)
    expect(run.calls.slice(2)).toEqual(['presence', 'view', 'history 600000'])
    expect(run.last().phase).toBe('live')
    run.session.close()
  })

  /** Steps the fake clock 100 ms at a time until the vignette reads stale, at most `steps` times; the wall time it did, or null. */
  const staleWithin = async (run: ReturnType<typeof harness>, steps: number): Promise<number | null> => {
    for (let step = 0; step < steps; step += 1) {
      await run.advance(100)
      if (sampleStale(run.last(), run.wall())) return run.wall()
    }
    return null
  }

  test('a Run that answers every sample in 1.9 s reads as live for a minute: the longest wait leaves room for it', async () => {
    expect(SAMPLE_BACKOFF_MS.at(-1)! + 2_000).toBeLessThanOrEqual(STALE_AFTER_MS)
    const run = harness(loaded)
    run.session.start()
    await run.settle()
    run.answerIn(1_900)
    expect(await staleWithin(run, 600)).toBeNull()
    run.session.close()
  })

  test('a Run that stops answering reads as stale once its last sample is 5 s old', async () => {
    const run = harness(loaded)
    run.session.start()
    await run.settle()
    await run.advance(3 * SAMPLE_INTERVAL_MS)
    run.answerIn(600_000)
    const staleAt = await staleWithin(run, 200)
    const answeredAt = run.last().lastSampleWallMs!
    expect(staleAt! - answeredAt).toBeGreaterThan(STALE_AFTER_MS)
    expect(staleAt! - answeredAt).toBeLessThanOrEqual(STALE_AFTER_MS + 100)
    run.session.close()
  })

  test('a reading outside its declared validity, or bad, adds no point to its trace: the trace breaks there', async () => {
    const run = harness(loaded)
    run.session.start()
    await run.settle()
    await run.advance(3_000)
    const points = () => run.last().series.get('unit-1#level')?.points.length ?? 0
    const before = points()
    run.readsAs('not-applicable')
    await run.advance(3_000)
    expect(points()).toBe(before)
    run.readsAs('bad')
    await run.advance(2_000)
    expect(points()).toBe(before)
    run.readsAs('good')
    await run.advance(2_000)
    expect(points()).toBeGreaterThan(before)
    run.session.close()
  })

  test('a pen whose record the Run did not serve draws nothing, its live readings included: its hold is never guessed', async () => {
    const withFlow = trendOf([levelPen, { ...levelPen, ref: 'unit-1#flow', label: 'Unit 1 · Flow', quantity: 'flow', unit: 'kg/s', series: { seriesId: 'unit-1.flow', intervalMs: 1_000 } }])
    const at = '2026-10-21T10:00:00.000Z'
    const snapshots: VignetteSnapshot[] = []
    const session = createVignetteSession({
      runId: 'run-1' as SimulationRunId, state: '{"title":"Level"}', onChange: snapshot => { snapshots.push(snapshot) }, wallNow: () => 0, schedule: () => () => {},
      routes: {
        presence: async () => loaded(at),
        view: async () => withFlow,
        sample: async (_runId, _state, history) => ({
          at: { at, clock: 'simulation', paused: false }, alerts: [], entities: {}, slots: {}, maps: {},
          observations: ['unit-1#level', 'unit-1#flow'].map(ref => ({ ref, at, clock: 'simulation' as const, value: 50, quality: 'good' as const, priority: 'none' as const })),
          ...(history === undefined ? {} : { series: { 'unit-1.level': { holdMs: 90_000, points: [] } } }),
        }),
      },
    })
    session.start()
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()
    expect([...snapshots.at(-1)!.series.keys()]).toEqual(['unit-1#level'])
    session.close()
  })

  test('a Run that is gone stops the vignette', async () => {
    const run = harness(() => null)
    run.session.start()
    await run.settle()
    expect([run.last().phase, run.pending()]).toEqual(['missing', 0])
  })
})
