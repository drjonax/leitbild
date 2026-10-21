import { describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/index.ts'
import type { ComposedDisplayClient, ComposedDisplayViewResult, RunPresence, ViewSize } from '../src/ui/embed/composed-display/composed-display-client.ts'
import {
  createComposedDisplaySession,
  IDLE_SUSPEND_MS,
  SAMPLE_BACKOFF_MS,
  sampleStale,
  STALE_AFTER_MS,
  type ComposedDisplaySnapshot,
  type ScheduleTimer,
} from '../src/ui/embed/composed-display/composed-display-session.ts'
import { createKeptSeries, type ReadWindow } from '../src/ui/embed/composed-display/kept-series.ts'
import { HOLD_GAP_MS } from '../src/packs/process-plant/displays/trend-reading.ts'

const runId = 'run-1' as SimulationRunId
const at = (offsetMs: number): string => new Date(Date.parse('2026-01-01T09:00:00.000Z') + offsetMs).toISOString()
// The Run started an hour before at(0).
const elapsedAt = (time: string): number => Date.parse(time) - Date.parse(at(-3_600_000))

const view: ComposedDisplayViewResult = {
  kind: 'advice',
  plantId: 'plant:1',
  plantLabel: 'Unit 1',
  issuedAt: at(0),
  simulationTime: at(0),
  modelChanged: false,
  drawingChanged: false,
  display: {
    plantId: 'plant:1',
    title: 'Pressure',
    advice: { question: 'Is pressure recovering?', need: 'Decide on spray' },
    modelDigest: 'a'.repeat(64),
    panels: [{
      kind: 'trend',
      horizon: '2m',
      horizonMs: 120_000,
      live: [],
      strips: [{
        unit: 'MPa',
        thresholds: [],
        pens: [
          { ref: 'PT-455', role: 'primary', path: 'pressurizer.pressureMPa', tagId: 'PT-455', label: 'Pressure', unit: 'MPa', quantity: 'pressure', seriesId: 'series:pressure', thresholds: [], combinedRules: [] },
          { ref: 'X', role: 'context', path: 'x.value', label: 'X', unit: 'MPa', quantity: 'pressure', seriesId: 'series:x', thresholds: [], combinedRules: [] },
        ],
      }],
    }],
  } as unknown as ComposedDisplayViewResult['display'],
}

const fakeClient = (config: {
  presence: RunPresence | null
  samples?: Array<{ readonly time: string; readonly value: number } | Error>
  view?: ComposedDisplayViewResult
}) => {
  const calls: string[] = []
  let presence = config.presence
  const client: ComposedDisplayClient = {
    presence: async () => { calls.push('presence'); return presence },
    loadRun: async () => { calls.push('loadRun'); presence = presence && { ...presence, loaded: true } },
    view: async (_run, _plant, _state, size) => { calls.push(size === null ? 'view' : `view:${size.width}x${size.height}`); return config.view ?? view },
    history: async (_run, seriesId) => {
      calls.push(`history:${seriesId}`)
      return seriesId === 'series:pressure' ? [{ t: Date.parse(at(-60_000)), v: 15.4 }] : []
    },
    sample: async () => {
      calls.push('sample')
      const next = config.samples?.shift()
      if (next === undefined) throw new Error('no sample scripted')
      if (next instanceof Error) throw next
      // The Plant's clock runs with the Run's: a Run reset takes both back.
      return { simulationTime: next.time, plantElapsedMs: elapsedAt(next.time), values: [{ path: 'pressurizer.pressureMPa', value: next.value, quality: 'good' as const }] }
    },
  }
  return { client, calls }
}

const session = (client: ComposedDisplayClient, wall = { now: 0 }, suspendWhenIdle = true, size: () => ViewSize | null = () => null) => {
  const snapshots: ComposedDisplaySnapshot[] = []
  const controller = createComposedDisplaySession({
    runId, plantId: 'plant:1', state: '{}', client,
    onChange: snapshot => { snapshots.push(snapshot) },
    suspendWhenIdle,
    size,
    wallNow: () => wall.now,
  })
  return { controller, last: () => snapshots[snapshots.length - 1]! }
}

describe('composed display session', () => {
  test('never loads an inactive Run on its own and loads it only on request', async () => {
    const { client, calls } = fakeClient({ presence: { title: 'Run', loaded: false, playback: 'playing', currentSimulationTime: at(0) }, samples: [{ time: at(0), value: 15.4 }] })
    const { controller, last } = session(client)
    await controller.start({ poll: false })
    expect(last().phase.kind).toBe('inactive')
    expect(calls).toEqual(['presence'])
    await controller.loadRun({ poll: false })
    expect(calls.slice(0, 3)).toEqual(['presence', 'loadRun', 'view'])
    expect(last().phase.kind).toBe('live')
  })

  test('samples the on/off states its drawn gated limits require, and no others', async () => {
    // Safety injection on low pressurizer pressure acts only while SI-BLOCKED reads off: the embed reads that state as World does.
    const gated = { ruleId: 'si', label: 'SI', kind: 'trip', operator: '<', direction: 'low', value: 12.7, order: 2, action: 'SI', gatedBy: ['SI-BLOCKED off'], gates: [{ path: 'safetyInjectionBlockLogic.blocked', on: false }] }
    const trend = view.display.panels[0]! as unknown as { strips: ReadonlyArray<{ pens: ReadonlyArray<Record<string, unknown>> }> }
    const [pressure, other] = trend.strips[0]!.pens
    const withGate: ComposedDisplayViewResult = {
      ...view,
      display: { ...view.display, panels: [{ ...view.display.panels[0]!, strips: [{ ...trend.strips[0]!, pens: [{ ...pressure!, thresholds: [gated] }, other!] }] }] } as unknown as ComposedDisplayViewResult['display'],
    }
    const sampled: Array<ReadonlyArray<string>> = []
    const client: ComposedDisplayClient = {
      presence: async () => ({ title: 'Run', loaded: true, playback: 'playing', currentSimulationTime: at(0) }),
      loadRun: async () => {},
      view: async () => withGate,
      history: async () => [],
      sample: async (_run, _plant, paths) => {
        sampled.push(paths)
        return { simulationTime: at(0), plantElapsedMs: 0, values: paths.map(path => ({ path, value: path.endsWith('.blocked') ? true : 12.5, quality: 'good' as const })) }
      },
    }
    const { controller } = session(client)
    await controller.start({ poll: false })
    expect(sampled).toEqual([['pressurizer.pressureMPa', 'safetyInjectionBlockLogic.blocked', 'x.value']])
    controller.close()
  })

  test('reports a removed Run explicitly', async () => {
    const { client } = fakeClient({ presence: null })
    const { controller, last } = session(client)
    await controller.start({ poll: false })
    expect(last().phase.kind).toBe('missing')
  })

  test('merges history in as it lands, marks signals without recorded history and appends live samples', async () => {
    const { client } = fakeClient({ presence: { title: 'Run', loaded: true, playback: 'playing', currentSimulationTime: at(0) }, samples: [{ time: at(0), value: 15.45 }, { time: at(1_000), value: 15.5 }] })
    const { controller, last } = session(client)
    await controller.start({ poll: false })
    expect(last().latest?.values[0]?.value).toBe(15.45)
    await Bun.sleep(0)
    expect([...last().historyMissing]).toEqual(['x.value'])
    await controller.poll()
    // The recorded point, then the first sample the display was drawn with, then the live samples.
    expect(last().series.get('pressurizer.pressureMPa')!.map(point => point.v)).toEqual([15.4, 15.45, 15.5])
  })

  test('flags a Run reset after the advice and keeps stale values on failure', async () => {
    const { client } = fakeClient({
      presence: { title: 'Run', loaded: true, playback: 'playing', currentSimulationTime: at(0) },
      samples: [{ time: at(0), value: 15.4 }, { time: at(-30_000), value: 15.0 }, new Error('Capability query failed: 503')],
    })
    const { controller, last } = session(client)
    await controller.start({ poll: false })
    await controller.poll()
    expect(last().resetSinceAdvice).toBe(true)
    expect(last().series.get('pressurizer.pressureMPa')!.map(point => point.v)).toEqual([15.0])
    await controller.poll()
    expect(last().sampleError).toContain('503')
    expect(last().series.get('pressurizer.pressureMPa')!.map(point => point.v)).toEqual([15.0])
  })

  test('suspends after a long time without interaction and resumes on request', async () => {
    const wall = { now: 0 }
    const { client, calls } = fakeClient({ presence: { title: 'Run', loaded: true, playback: 'playing', currentSimulationTime: at(0) }, samples: [{ time: at(0), value: 15.4 }, { time: at(1_000), value: 15.5 }] })
    const { controller, last } = session(client, wall)
    await controller.start({ poll: false })
    wall.now = IDLE_SUSPEND_MS + 1
    await controller.poll()
    expect(last().phase.kind).toBe('suspended')
    expect(calls.filter(call => call === 'sample')).toHaveLength(1)
    controller.resume()
    expect(last().phase.kind).toBe('live')
    controller.close()
  })

  test('an overview is drawn for its window, and again when the window settles at a new size', async () => {
    const overview: ComposedDisplayViewResult = { kind: 'overview', plantId: 'plant:1', plantLabel: 'Unit 1', simulationTime: at(0), display: view.display }
    const window = { width: 1896, height: 972 }
    const { client, calls } = fakeClient({ presence: { title: 'Run', loaded: true, playback: 'playing', currentSimulationTime: at(0) }, samples: [{ time: at(0), value: 15.4 }], view: overview })
    const { controller } = session(client, { now: 0 }, false, () => window)
    await controller.start({ poll: false })
    window.width = 1440
    await controller.relayout()
    expect(calls.filter(call => call.startsWith('view'))).toEqual(['view:1896x972', 'view:1440x972'])
    controller.close()
  })

  test('a generated display opens equipment in place, samples it at once and keeps drawing it for the window', async () => {
    const overview: ComposedDisplayViewResult = { kind: 'overview', plantId: 'plant:1', plantLabel: 'Unit 1', simulationTime: at(0), display: view.display }
    const detail: ComposedDisplayViewResult = { ...overview, kind: 'detail', display: { ...view.display, title: 'Steam Generator B' } }
    const window = { width: 1896, height: 972 }
    const { client: base, calls } = fakeClient({ presence: { title: 'Run', loaded: true, playback: 'playing', currentSimulationTime: at(0) }, samples: [{ time: at(0), value: 15.4 }, { time: at(1_000), value: 15.5 }] })
    const states: string[] = []
    const client: ComposedDisplayClient = {
      ...base,
      view: async (run, plant, state, size) => {
        states.push(state)
        if (state === 'unknown') throw new Error('cannot be opened')
        await base.view(run, plant, state, size)
        return state === 'detail' ? detail : overview
      },
    }
    const { controller, last } = session(client, { now: 0 }, false, () => window)
    await controller.start({ poll: false })
    // A display that cannot be drawn rejects and leaves the overview shown.
    await expect(controller.open('unknown')).rejects.toThrow('cannot be opened')
    expect(last().view?.kind).toBe('overview')
    await controller.open('detail')
    expect(last().view?.display.title).toBe('Steam Generator B')
    expect(calls.filter(call => call === 'sample')).toHaveLength(2)
    window.width = 1440
    await controller.relayout()
    expect(states).toEqual(['{}', 'unknown', 'detail', 'detail'])
    expect(calls.filter(call => call.startsWith('view'))).toEqual(['view:1896x972', 'view:1896x972', 'view:1440x972'])
    controller.close()
  })

  test('a generated display opened in a window with no size yet waits for one, then draws for it', async () => {
    const overview: ComposedDisplayViewResult = { kind: 'overview', plantId: 'plant:1', plantLabel: 'Unit 1', simulationTime: at(0), display: view.display }
    const window = { width: 0, height: 0 }
    const { client, calls } = fakeClient({ presence: { title: 'Run', loaded: true, playback: 'playing', currentSimulationTime: at(0) }, samples: [{ time: at(0), value: 15.4 }], view: overview })
    const { controller, last } = session(client, { now: 0 }, false, () => window)
    await controller.start({ poll: false })
    await controller.relayout()
    // Nothing is asked of the Run until the window can show a drawing.
    expect(calls).toEqual([])
    window.width = 1896
    window.height = 972
    // A page that is not rendered gets no resize event; the view's clock asks.
    await controller.sized()
    await controller.relayout()
    expect(calls.filter(call => call.startsWith('view'))).toEqual(['view:1896x972', 'view:1896x972'])
    expect(last().phase.kind).toBe('live')
    controller.close()
  })

  test('a generated display reads its lead values\' history once as it opens, then only extends it with live samples', async () => {
    const pen = (path: string, overrides: Record<string, unknown> = {}) => ({
      ref: path, role: 'primary', path, label: path, name: path, described: path, measurement: path, unit: 'MPa', quantity: 'pressure',
      valueKind: 'number', seriesId: `series:${path}`, recorded: true, command: false, thresholds: [], combinedRules: [], ...overrides,
    })
    const leadValues = (paths: ReadonlyArray<string>, extra: ReadonlyArray<ReturnType<typeof pen>> = []) => ({
      kind: 'readouts', sparklineMs: 600_000, pens: [...paths.map(path => pen(path)), ...extra],
    })
    const generated = (kind: 'overview' | 'detail', readouts: ReturnType<typeof leadValues>): ComposedDisplayViewResult => ({
      kind, plantId: 'plant:1', plantLabel: 'Unit 1', simulationTime: at(0),
      display: { plantId: 'plant:1', title: kind, advice: null, modelDigest: 'a'.repeat(64), height: 900, panels: [readouts] } as unknown as ComposedDisplayViewResult['display'],
    })
    const overview = generated('overview', leadValues(['pressurizer.pressureMPa', 'core.powerMw'], [
      // Not recorded, and a state: neither has a sparkline to read.
      pen('vessel.netInventoryFlowKgPerS', { recorded: false }),
      pen('bus.energized', { valueKind: 'boolean' }),
    ]))
    const detail = generated('detail', leadValues(['sgB.levelPercent']))
    const reads: string[] = []
    let samples = 0
    const client: ComposedDisplayClient = {
      presence: async () => ({ title: 'Run', loaded: true, playback: 'playing', currentSimulationTime: at(0) }),
      loadRun: async () => {},
      view: async (_run, _plant, state) => state === 'detail' ? detail : overview,
      history: async (_run, seriesId, window) => {
        reads.push(`${seriesId} from ${(window.from - window.to) / 1000} s`)
        if (seriesId === 'series:core.powerMw') throw new Error('Reading history failed with HTTP 503')
        return [{ t: Date.parse(at(-650_000)), v: 15.5 }, { t: Date.parse(at(-60_000)), v: 15.4 }]
      },
      sample: async (_run, _plant, paths) => ({
        simulationTime: at(1_000 * samples++), plantElapsedMs: 0,
        values: paths.map(path => ({ path, value: path === 'bus.energized' ? true : 15.45, quality: 'good' as const })),
      }),
    }
    const { controller, last } = session(client, { now: 0 }, false, () => ({ width: 1896, height: 972 }))
    await controller.start({ poll: false })
    // From one hold gap (90 s) before the ten-minute window, so the value held at its start is known.
    expect(reads).toEqual(['series:pressurizer.pressureMPa from -690 s', 'series:core.powerMw from -690 s'])
    expect(last().phase.kind).toBe('live')
    await Bun.sleep(0)
    // A history that cannot be read is said on its row; the line starts with the live samples.
    expect([...last().historyErrors]).toEqual([['core.powerMw', 'Reading history failed with HTTP 503']])
    expect(last().series.get('pressurizer.pressureMPa')!.map(point => point.v)).toEqual([15.5, 15.4, 15.45])
    await controller.poll()
    await controller.poll()
    expect(reads).toHaveLength(2)
    expect(last().series.get('pressurizer.pressureMPa')!.map(point => point.v)).toEqual([15.5, 15.4, 15.45, 15.45, 15.45])
    expect(last().series.get('core.powerMw')!.map(point => point.v)).toEqual([15.45, 15.45, 15.45])
    expect(last().series.has('vessel.netInventoryFlowKgPerS')).toBe(false)
    // Equipment opened from it reads its own lead values' history, once.
    await controller.open('detail')
    expect(reads.slice(2)).toEqual(['series:sgB.levelPercent from -690 s'])
    expect([...last().series.keys()]).toEqual(['sgB.levelPercent'])
    expect(last().historyErrors.size).toBe(0)
    controller.close()
  })

  test('a generated display keeps the history of what its drawing\'s vessels trace, the recorded readings only', async () => {
    const pen = (path: string, recorded: boolean) => ({
      ref: path, role: 'primary', path, label: path, name: path, described: path, measurement: path, unit: 'percent', quantity: 'level',
      valueKind: 'number', seriesId: `series:${path}`, recorded, command: false, thresholds: [], combinedRules: [],
    })
    const mimic = { kind: 'mimic', mimic: { paths: ['pressurizer.levelPercent', 'sgA.levelPercent'] }, trends: { windowMs: 600_000, pens: [pen('pressurizer.levelPercent', true), pen('sgA.levelPercent', false)] } }
    const overview: ComposedDisplayViewResult = {
      kind: 'overview', plantId: 'plant:1', plantLabel: 'Unit 1', simulationTime: at(0),
      display: { plantId: 'plant:1', title: 'Unit overview', advice: null, modelDigest: 'a'.repeat(64), height: 900, panels: [mimic] } as unknown as ComposedDisplayViewResult['display'],
    }
    const reads: string[] = []
    let samples = 0
    const client: ComposedDisplayClient = {
      presence: async () => ({ title: 'Run', loaded: true, playback: 'playing', currentSimulationTime: at(0) }),
      loadRun: async () => {},
      view: async () => overview,
      history: async (_run, seriesId, window) => {
        reads.push(`${seriesId} from ${(window.from - window.to) / 1000} s`)
        return [{ t: Date.parse(at(-650_000)), v: 55 }]
      },
      sample: async (_run, _plant, paths) => ({ simulationTime: at(1_000 * ++samples), plantElapsedMs: 0, values: paths.map(path => ({ path, value: 24.9, quality: 'good' as const })) }),
    }
    const { controller, last } = session(client, { now: 0 }, false, () => ({ width: 1896, height: 972 }))
    await controller.start({ poll: false })
    expect(reads).toEqual(['series:pressurizer.levelPercent from -690 s'])
    await controller.poll()
    expect(last().series.get('pressurizer.levelPercent')!.map(point => point.v)).toEqual([55, 24.9, 24.9])
    expect(last().series.has('sgA.levelPercent')).toBe(false)
    controller.close()
  })

  test('advice keeps the size it was composed with', async () => {
    const { client, calls } = fakeClient({ presence: { title: 'Run', loaded: true, playback: 'playing', currentSimulationTime: at(0) }, samples: [{ time: at(0), value: 15.4 }] })
    const { controller } = session(client)
    await controller.start({ poll: false })
    await controller.relayout()
    expect(calls.filter(call => call.startsWith('view'))).toEqual(['view'])
    controller.close()
  })

  test('a frame hidden before its display has started does not poll until it is shown', async () => {
    const { client, calls } = fakeClient({ presence: { title: 'Run', loaded: true, playback: 'playing', currentSimulationTime: at(0) }, samples: [{ time: at(0), value: 15.4 }, { time: at(1_000), value: 15.5 }] })
    const { controller } = session(client)
    controller.setVisible(false)
    await controller.start()
    await Bun.sleep(1_300)
    expect(calls.filter(call => call === 'sample')).toHaveLength(1)
    // Shown again, it samples at once rather than a second later.
    controller.setVisible(true)
    await Bun.sleep(50)
    expect(calls.filter(call => call === 'sample')).toHaveLength(2)
    controller.close()
  })

  test("samples missed while hidden or suspended are read from the Run's history, not drawn as a held value", async () => {
    const wall = { now: 0 }
    const { client, calls } = fakeClient({ presence: { title: 'Run', loaded: true, playback: 'playing', currentSimulationTime: at(0) }, samples: [{ time: at(0), value: 15.4 }, { time: at(1_000), value: 15.5 }, { time: at(60_000), value: 15.9 }] })
    const { controller } = session(client, wall)
    await controller.start({ poll: false })
    const histories = () => calls.filter(call => call === 'history:series:pressure').length
    expect(histories()).toBe(1)
    wall.now = 1_000
    await controller.poll()
    expect(histories()).toBe(1)
    // A minute without samples: the history is read again before the new sample is drawn.
    wall.now = 61_000
    await controller.poll()
    expect(histories()).toBe(2)
    controller.close()
  })

  test('an operating overview keeps updating however long it is left unattended', async () => {
    const wall = { now: 0 }
    const { client, calls } = fakeClient({ presence: { title: 'Run', loaded: true, playback: 'playing', currentSimulationTime: at(0) }, samples: [{ time: at(0), value: 15.4 }, { time: at(1_000), value: 15.5 }] })
    const { controller, last } = session(client, wall, false)
    await controller.start({ poll: false })
    wall.now = IDLE_SUSPEND_MS + 1
    await controller.poll()
    expect(last().phase.kind).toBe('live')
    expect(calls.filter(call => call === 'sample')).toHaveLength(2)
    controller.close()
  })
})

// A clock the test moves: the session's timers and the fake World's answers both run on it.
const fakeClock = () => {
  const wall = { now: 0 }
  let timers: Array<{ readonly at: number; readonly order: number; readonly run: () => void }> = []
  let order = 0
  const schedule: ScheduleTimer = (run, delayMs) => {
    const timer = { at: wall.now + delayMs, order: order++, run }
    timers.push(timer)
    return () => { timers = timers.filter(candidate => candidate !== timer) }
  }
  const settle = async (): Promise<void> => { await Bun.sleep(0) }
  const advance = async (ms: number): Promise<void> => {
    const end = wall.now + ms
    for (;;) {
      await settle()
      timers.sort((left, right) => left.at - right.at || left.order - right.order)
      const next = timers[0]
      if (next === undefined || next.at > end) break
      timers.shift()
      wall.now = next.at
      next.run()
    }
    wall.now = end
    await settle()
  }
  /** Resolves after `ms` on this clock. */
  const after = <T,>(ms: number, value: () => T): Promise<T> => new Promise((resolve, reject) => {
    schedule(() => { try { resolve(value()) } catch (error) { reject(error) } }, ms)
  })
  return { wall, schedule, advance, after, settle }
}

type Clock = ReturnType<typeof fakeClock>

const pen = (path: string) => ({
  ref: path, role: 'primary', path, label: path, name: path, described: path, measurement: path, unit: 'MPa', quantity: 'pressure',
  valueKind: 'number', seriesId: `series:${path}`, recorded: true, command: false, thresholds: [], combinedRules: [],
})

const generatedView = (kind: 'overview' | 'detail', title: string, paths: ReadonlyArray<string>): ComposedDisplayViewResult => ({
  kind, plantId: 'plant:1', plantLabel: 'Unit 1', simulationTime: at(0),
  display: { plantId: 'plant:1', title, advice: null, modelDigest: 'a'.repeat(64), height: 900, panels: [{ kind: 'readouts', sparklineMs: 600_000, pens: paths.map(pen) }] } as unknown as ComposedDisplayViewResult['display'],
})

/** A World that answers on the fake clock; what it answers can change while the test runs. */
const slowWorld = (clock: Clock, initial: { readonly view: ComposedDisplayViewResult }) => {
  const world = {
    latencyMs: 0,
    loaded: true,
    exists: true,
    mode: 'power' as string,
    view: initial.view,
    views: new Map<string, ComposedDisplayViewResult>(),
    calls: [] as string[],
    /** Each history read's series and window. */
    reads: [] as Array<{ readonly seriesId: string } & ReadWindow>,
    historyLatencyMs: 0,
    sampleTimes: [] as number[],
    inFlight: 0,
    maxInFlight: 0,
  }
  let samples = 0
  const client: ComposedDisplayClient = {
    presence: async () => {
      world.calls.push(`presence:${world.loaded ? 'loaded' : 'unloaded'}`)
      return world.exists ? { title: 'Run', loaded: world.loaded, playback: 'playing', currentSimulationTime: at(0) } : null
    },
    loadRun: async () => { world.calls.push('loadRun'); world.loaded = true },
    view: async (_run, _plant, state) => {
      world.calls.push(`view:${state}`)
      return world.views.get(state) ?? world.view
    },
    history: (_run, seriesId, window) => {
      world.calls.push(`history:${seriesId}`)
      world.reads.push({ seriesId, ...window })
      const answer = () => [{ t: Date.parse(at(-60_000)), v: 15 }]
      return world.historyLatencyMs === 0 ? Promise.resolve().then(answer) : clock.after(world.historyLatencyMs, answer)
    },
    sample: (_run, _plant, paths) => {
      world.calls.push(`sample:${paths.join(',')}`)
      world.sampleTimes.push(clock.wall.now)
      world.inFlight += 1
      world.maxInFlight = Math.max(world.maxInFlight, world.inFlight)
      const answer = () => {
        world.inFlight -= 1
        const time = at(1_000 * samples++)
        return {
          simulationTime: time,
          plantElapsedMs: elapsedAt(time),
          mode: { id: world.mode, label: world.mode },
          values: paths.map(path => ({ path, value: 15.5, quality: 'good' as const })),
        }
      }
      // A quick World answers at once; a slow one after its latency on the fake clock.
      return world.latencyMs === 0 ? Promise.resolve().then(answer) : clock.after(world.latencyMs, answer)
    },
  }
  return { world, client }
}

const clocked = (clock: Clock, client: ComposedDisplayClient, options: { readonly suspendWhenIdle?: boolean; readonly size?: () => ViewSize | null } = {}) => {
  const snapshots: ComposedDisplaySnapshot[] = []
  const controller = createComposedDisplaySession({
    runId, plantId: 'plant:1', state: '{}', client,
    onChange: snapshot => { snapshots.push(snapshot) },
    suspendWhenIdle: options.suspendWhenIdle ?? false,
    size: options.size ?? (() => ({ width: 1896, height: 972 })),
    wallNow: () => clock.wall.now,
    schedule: clock.schedule,
  })
  return { controller, snapshots, last: () => snapshots[snapshots.length - 1]! }
}

describe('composed display session on a fake clock', () => {
  test('keeps one sample in flight against a slow World, waits longer after slow answers and returns to 1 Hz', async () => {
    const clock = fakeClock()
    const { world, client } = slowWorld(clock, { view: generatedView('overview', 'Unit 1', ['pressurizer.pressureMPa']) })
    world.latencyMs = 5_000
    const { controller, last } = clocked(clock, client)
    const started = controller.start()
    await clock.advance(5_000)
    await started
    expect(last().phase.kind).toBe('live')
    await clock.advance(55_000)
    // Asked again only once answered: after a 5 s answer it waits 2 s, then 3 s after every further slow answer.
    expect(world.maxInFlight).toBe(1)
    expect(world.sampleTimes).toEqual([0, 6_000, 13_000, 21_000, 29_000, 37_000, 45_000, 53_000])
    // Polls the view never joins two requests: a poll while one is in flight joins it.
    void controller.poll()
    void controller.poll()
    expect(world.maxInFlight).toBe(1)
    world.latencyMs = 100
    await clock.advance(20_000)
    const recent = world.sampleTimes.filter(time => time >= 70_000)
    // Quick answers again: one sample a second, the answer time included.
    expect(recent.slice(1).map((time, index) => time - recent[index]!)).toEqual(recent.slice(1).map(() => 1_000))
    expect(world.maxInFlight).toBe(1)
    controller.close()
  })

  test('a Run that is not loaded is watched with backoff and drawn by itself once someone loads it, never loaded by the display', async () => {
    const clock = fakeClock()
    const { world, client } = slowWorld(clock, { view: generatedView('overview', 'Unit 1', ['pressurizer.pressureMPa']) })
    world.loaded = false
    const { controller, last } = clocked(clock, client)
    await controller.start()
    expect(last().phase.kind).toBe('inactive')
    await clock.advance(2_000)
    world.loaded = true
    await clock.advance(1_000)
    expect(last().phase.kind).toBe('live')
    expect(world.calls.slice(0, 4)).toEqual(['presence:unloaded', 'presence:unloaded', 'presence:loaded', 'view:{}'])
    expect(world.calls).not.toContain('loadRun')
    controller.close()
  })

  test('a Run unloaded under a live display stops its samples and resumes them when it is loaded again', async () => {
    const clock = fakeClock()
    const { world, client } = slowWorld(clock, { view: generatedView('overview', 'Unit 1', ['pressurizer.pressureMPa']) })
    const { controller, last } = clocked(clock, client)
    await controller.start()
    world.loaded = false
    await clock.advance(5_000)
    // The fifth sample's presence read finds the Run unloaded: no sample is asked of it while it is.
    expect(last().phase.kind).toBe('inactive')
    const samplesWhileUnloaded = world.calls.filter(call => call.startsWith('sample')).length
    await clock.advance(30_000)
    expect(world.calls.filter(call => call.startsWith('sample')).length).toBe(samplesWhileUnloaded)
    world.loaded = true
    await clock.advance(10_000)
    expect(last().phase.kind).toBe('live')
    expect(world.calls).not.toContain('loadRun')
    controller.close()
  })

  test('only the Run\'s own clock going backwards reads as a reset, never the order answers arrive in', async () => {
    const clock = fakeClock()
    let elapsed = 10_000
    const base: ComposedDisplayClient = slowWorld(clock, { view }).client
    const answers: Array<() => void> = []
    let requests = 0
    const client: ComposedDisplayClient = {
      ...base,
      sample: async (_run, _plant, paths) => {
        requests += 1
        await new Promise<void>(resolve => { answers.push(resolve) })
        elapsed += 1_000
        return { simulationTime: at(elapsed), plantElapsedMs: elapsed, values: paths.map(path => ({ path, value: 15.5, quality: 'good' as const })) }
      },
    }
    const { controller, last } = clocked(clock, client, { size: () => null })
    const started = controller.start({ poll: false })
    await clock.settle()
    answers.shift()!()
    await started
    // Three polls while one is unanswered are one request.
    const polls = [controller.poll(), controller.poll(), controller.poll()]
    await clock.settle()
    expect(requests).toBe(2)
    answers.shift()!()
    await Promise.all(polls)
    expect(last().resetSinceAdvice).toBe(false)
    // The Run is reset: its Plant clock starts again.
    elapsed = 0
    const after = controller.poll()
    await clock.settle()
    answers.shift()!()
    await after
    expect(last().resetSinceAdvice).toBe(true)
    controller.close()
  })

  test('a generated display is drawn again within two samples of a mode change, with history for the lead values it newly shows', async () => {
    const clock = fakeClock()
    const { world, client } = slowWorld(clock, { view: generatedView('overview', 'Unit 1', ['core.powerMw', 'pressurizer.pressureMPa']) })
    const { controller, last } = clocked(clock, client)
    await controller.start()
    await clock.advance(3_000)
    expect(world.calls.filter(call => call.startsWith('view'))).toHaveLength(1)
    // The reactor trips: the Plant is in another mode, whose lead values put subcooling first.
    world.mode = 'hot-standby'
    world.view = generatedView('overview', 'Unit 1', ['rcs.subcoolingMarginK', 'pressurizer.pressureMPa'])
    const before = world.calls.length
    await clock.advance(2_000)
    const since = world.calls.slice(before)
    expect(since.filter(call => call.startsWith('view'))).toEqual(['view:{}'])
    // Only the newly shown lead value reads its history; the others keep theirs.
    expect(since.filter(call => call.startsWith('history'))).toEqual(['history:series:rcs.subcoolingMarginK'])
    expect(last().view?.display.panels[0]).toMatchObject({ pens: [{ path: 'rcs.subcoolingMarginK' }, { path: 'pressurizer.pressureMPa' }] })
    expect([...last().series.keys()].sort()).toEqual(['pressurizer.pressureMPa', 'rcs.subcoolingMarginK'])
    // The new mode holds: no further redraws.
    await clock.advance(5_000)
    expect(world.calls.filter(call => call.startsWith('view'))).toHaveLength(2)
    controller.close()
  })

  test('advice keeps its composition when the mode changes', async () => {
    const clock = fakeClock()
    const { world, client } = slowWorld(clock, { view })
    const { controller } = clocked(clock, client, { size: () => null })
    await controller.start()
    world.mode = 'hot-standby'
    await clock.advance(5_000)
    expect(world.calls.filter(call => call.startsWith('view'))).toHaveLength(1)
    controller.close()
  })

  test('a frame not on screen asks the Run nothing; shown again it reads presence first, samples at once and reads what it missed', async () => {
    const clock = fakeClock()
    const { world, client } = slowWorld(clock, { view: generatedView('overview', 'Unit 1', ['pressurizer.pressureMPa']) })
    const { controller, last } = clocked(clock, client)
    await controller.start()
    await clock.advance(2_000)
    controller.setVisible(false)
    const before = world.calls.length
    await clock.advance(120_000)
    expect(world.calls.length).toBe(before)
    controller.setVisible(true)
    await clock.settle()
    expect(world.calls.slice(before)).toEqual(['presence:loaded', 'sample:pressurizer.pressureMPa', 'history:series:pressurizer.pressureMPa'])
    // Only what the Run recorded since the last sample it kept before it was hidden, not its whole window.
    expect(world.reads.at(-1)).toEqual({ seriesId: 'series:pressurizer.pressureMPa', from: Date.parse(at(2_000)), to: Date.parse(at(3_000)) })
    expect(last().lastSampleWallMs).toBe(122_000)
    // While it was off screen the Run was unloaded: shown again, it says so and asks no sample, which would load it.
    controller.setVisible(false)
    world.loaded = false
    await clock.advance(60_000)
    const hidden = world.calls.length
    controller.setVisible(true)
    await clock.settle()
    expect(world.calls.slice(hidden)).toEqual(['presence:unloaded'])
    expect(last().phase.kind).toBe('inactive')
    controller.close()
  })

  test('equipment opened in place is shown only with its own first sample, never with the previous display\'s values', async () => {
    const clock = fakeClock()
    const { world, client } = slowWorld(clock, { view: generatedView('overview', 'Unit 1', ['pressurizer.pressureMPa']) })
    world.views.set('detail', generatedView('detail', 'Steam Generator B', ['sgB.levelPercent']))
    const { controller, snapshots, last } = clocked(clock, client)
    await controller.start()
    world.latencyMs = 4_000
    const opened = controller.open('detail')
    await clock.advance(2_000)
    expect(last().view?.display.title).toBe('Unit 1')
    await clock.advance(4_000)
    await opened
    expect(last().view?.display.title).toBe('Steam Generator B')
    expect(last().latest?.values.map(value => value.path)).toEqual(['sgB.levelPercent'])
    // No snapshot ever paired the detail with the overview's sample.
    expect(snapshots.filter(snapshot => snapshot.view?.display.title === 'Steam Generator B' && snapshot.latest?.values.some(value => value.path === 'pressurizer.pressureMPa'))).toEqual([])
    expect(world.maxInFlight).toBe(1)
    controller.close()
  })

  test('a display is drawn with its view and first sample while its history is still being read, and the history merged in once it lands', async () => {
    const clock = fakeClock()
    const { world, client } = slowWorld(clock, { view: generatedView('overview', 'Unit 1', ['pressurizer.pressureMPa']) })
    world.views.set('detail', generatedView('detail', 'Steam Generator B', ['sgB.levelPercent']))
    world.historyLatencyMs = 10_000
    const { controller, last } = clocked(clock, client)
    // Nothing waits for the history: the display is live before the clock moves.
    await controller.start()
    expect(last().phase.kind).toBe('live')
    expect(world.calls.filter(call => call.startsWith('history'))).toEqual(['history:series:pressurizer.pressureMPa'])
    expect(last().series.get('pressurizer.pressureMPa')).toEqual([{ t: Date.parse(at(0)), v: 15.5 }])
    await clock.advance(10_000)
    // The point recorded a minute before is merged in ahead of the live samples.
    expect(last().series.get('pressurizer.pressureMPa')![0]).toEqual({ t: Date.parse(at(-60_000)), v: 15 })
    expect(last().series.get('pressurizer.pressureMPa')!.length).toBeGreaterThan(2)
    // Equipment opened in place is drawn with its own first sample, before its history is in.
    await controller.open('detail')
    expect(last().view?.display.title).toBe('Steam Generator B')
    expect(last().series.get('sgB.levelPercent')!.map(point => point.v)).toEqual([15.5])
    await clock.advance(10_000)
    expect(last().series.get('sgB.levelPercent')![0]).toEqual({ t: Date.parse(at(-60_000)), v: 15 })
    controller.close()
  })

  test("a display opened while a poll is in flight is drawn with that poll's answer where it read all the display shows", async () => {
    const clock = fakeClock()
    const { world, client } = slowWorld(clock, { view: generatedView('overview', 'Unit 1', ['pressurizer.pressureMPa', 'sgB.levelPercent']) })
    world.views.set('detail', generatedView('detail', 'Steam Generator B', ['sgB.levelPercent']))
    const { controller, last } = clocked(clock, client)
    await controller.start()
    world.latencyMs = 2_000
    // The poll asked at 1 s is answered at 3 s.
    await clock.advance(1_500)
    const opened = controller.open('detail')
    await clock.advance(1_500)
    await opened
    expect(last().view?.display.title).toBe('Steam Generator B')
    // No second request: the poll in flight read the detail's lead value too.
    expect(world.sampleTimes).toEqual([0, 1_000])
    expect(last().lastSampleWallMs).toBe(3_000)
    expect(world.maxInFlight).toBe(1)
    controller.close()
  })

  test('Back after a switch reads only what the Run recorded meanwhile, never a whole window again', async () => {
    const clock = fakeClock()
    const { world, client } = slowWorld(clock, { view: generatedView('overview', 'Unit 1', ['pressurizer.pressureMPa', 'core.powerMw']) })
    world.views.set('detail', generatedView('detail', 'Steam Generator B', ['sgB.levelPercent']))
    const { controller, last } = clocked(clock, client)
    await controller.start()
    await clock.advance(3_000)
    await controller.open('detail')
    await clock.advance(30_000)
    // Each lead value read its whole window once, as its display first showed it: a sparkline from one hold gap before.
    expect(world.reads.map(read => [read.seriesId, (read.to - read.from) / 1_000])).toEqual([
      ['series:pressurizer.pressureMPa', 690],
      ['series:core.powerMw', 690],
      ['series:sgB.levelPercent', 690],
    ])
    const before = world.reads.length
    await controller.open('{}')
    expect(last().view?.display.title).toBe('Unit 1')
    await clock.settle()
    // Back: the overview's lead values read from the last sample they kept before the switch (3 s) to its first sample now.
    expect(world.reads.slice(before)).toEqual([
      { seriesId: 'series:pressurizer.pressureMPa', from: Date.parse(at(3_000)), to: Date.parse(at(35_000)) },
      { seriesId: 'series:core.powerMw', from: Date.parse(at(3_000)), to: Date.parse(at(35_000)) },
    ])
    // What they kept from before the switch is drawn: the recorded point and the samples up to the switch.
    expect(last().series.get('pressurizer.pressureMPa')!.map(point => point.t)).toEqual([
      Date.parse(at(-60_000)), Date.parse(at(0)), Date.parse(at(1_000)), Date.parse(at(2_000)), Date.parse(at(3_000)), Date.parse(at(35_000)),
    ])
    controller.close()
  })

  test('a World that answers slowly reads as live on the longest wait between samples; one that stops answering reads as stale', async () => {
    // The longest wait between samples leaves an answer of up to 2 s before the display reads stale.
    expect(SAMPLE_BACKOFF_MS.at(-1)! + 2_000).toBeLessThanOrEqual(STALE_AFTER_MS)
    const clock = fakeClock()
    const { world, client } = slowWorld(clock, { view: generatedView('overview', 'Unit 1', ['pressurizer.pressureMPa']) })
    const { controller, last } = clocked(clock, client)
    await controller.start()
    // Each answer takes longer than a second: the wait climbs to its longest and stays there.
    world.latencyMs = 1_900
    let staleAt: number | null = null
    for (let step = 0; step < 600 && staleAt === null; step += 1) {
      await clock.advance(100)
      if (sampleStale(last(), clock.wall.now)) staleAt = clock.wall.now
    }
    expect(staleAt).toBeNull()
    const recent = world.sampleTimes.slice(-4)
    expect(recent.slice(1).map((time, index) => time - recent[index]!)).toEqual([4_900, 4_900, 4_900])
    // The World stops answering (after the request in flight): the display reads stale once its last sample is older than the threshold.
    world.latencyMs = 600_000
    for (let step = 0; step < 200 && staleAt === null; step += 1) {
      await clock.advance(100)
      if (sampleStale(last(), clock.wall.now)) staleAt = clock.wall.now
    }
    const answeredAt = last().lastSampleWallMs!
    expect(staleAt! - answeredAt).toBeGreaterThan(STALE_AFTER_MS)
    expect(staleAt! - answeredAt).toBeLessThanOrEqual(STALE_AFTER_MS + 100)
    controller.close()
  })
})

describe('kept series', () => {
  test('live samples extend a series without reading it again; a missed sample reads from its newest kept point; it keeps its window and one hold gap, then is dropped', async () => {
    const reads: ReadWindow[] = []
    const kept = createKeptSeries(async (_series, window) => { reads.push(window); return [] })
    const shown = (seriesId: string, value: number) => [{ seriesId, horizonMs: 60_000, leadMs: 60_000, value }]
    for (let t = 0; t <= 300_000; t += 1_000) await Promise.all(kept.take(t, shown('s', t), { missed: false, retry: false }))
    // One read, of the window as it first showed: a minute of nothing recorded.
    expect(reads).toEqual([{ from: -60_000, to: 0 }])
    expect(kept.view('s', undefined)!.missing).toBe(true)
    const points = kept.view('s', undefined)!.points
    expect(points[0]!.t).toBe(300_000 - 60_000 - HOLD_GAP_MS)
    expect(points).toHaveLength(151)
    // Samples missed: what was recorded since its newest kept point is read, not its window.
    await Promise.all(kept.take(310_000, shown('s', 310), { missed: true, retry: false }))
    expect(reads.at(-1)).toEqual({ from: 300_000, to: 310_000 })
    // Shown no more: dropped once its newest point is older than its window and hold gap.
    await Promise.all(kept.take(310_000 + 60_000 + HOLD_GAP_MS, shown('other', 1), { missed: false, retry: false }))
    expect(kept.view('s', undefined)).toBeDefined()
    await Promise.all(kept.take(310_001 + 60_000 + HOLD_GAP_MS, shown('other', 1), { missed: false, retry: false }))
    expect(kept.view('s', undefined)).toBeUndefined()
  })
})
