import { describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/index.ts'
import type { ComposedDisplayClient, ComposedDisplayViewResult, RunPresence, ViewSize } from '../src/ui/embed/composed-display/composed-display-client.ts'
import {
  createComposedDisplaySession,
  IDLE_SUSPEND_MS,
  type ComposedDisplaySnapshot,
} from '../src/ui/embed/composed-display/composed-display-session.ts'

const runId = 'run-1' as SimulationRunId
const at = (offsetMs: number): string => new Date(Date.parse('2026-01-01T09:00:00.000Z') + offsetMs).toISOString()

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
      return { simulationTime: next.time, plantElapsedMs: 0, values: [{ path: 'pressurizer.pressureMPa', value: next.value, quality: 'good' as const }] }
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

  test('reports a removed Run explicitly', async () => {
    const { client } = fakeClient({ presence: null })
    const { controller, last } = session(client)
    await controller.start({ poll: false })
    expect(last().phase.kind).toBe('missing')
  })

  test('backfills history, marks signals without recorded history and appends live samples', async () => {
    const { client } = fakeClient({ presence: { title: 'Run', loaded: true, playback: 'playing', currentSimulationTime: at(0) }, samples: [{ time: at(0), value: 15.45 }, { time: at(1_000), value: 15.5 }] })
    const { controller, last } = session(client)
    await controller.start({ poll: false })
    expect([...last().historyMissing]).toEqual(['x.value'])
    expect(last().latest?.values[0]?.value).toBe(15.45)
    await controller.poll()
    expect(last().series.get('pressurizer.pressureMPa')!.map(point => point.v)).toEqual([15.4, 15.5])
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
        reads.push(`${seriesId} from ${(window.from - Date.parse(at(0))) / 1000} s`)
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
    // A history that cannot be read is said on its row; the line starts with the live samples.
    expect([...last().historyErrors]).toEqual([['core.powerMw', 'Reading history failed with HTTP 503']])
    expect(last().series.get('pressurizer.pressureMPa')!.map(point => point.v)).toEqual([15.5, 15.4])
    await controller.poll()
    await controller.poll()
    expect(reads).toHaveLength(2)
    expect(last().series.get('pressurizer.pressureMPa')!.map(point => point.v)).toEqual([15.5, 15.4, 15.45, 15.45])
    expect(last().series.get('core.powerMw')!.map(point => point.v)).toEqual([15.45, 15.45])
    expect(last().series.has('vessel.netInventoryFlowKgPerS')).toBe(false)
    // Equipment opened from it reads its own lead values' history, once.
    await controller.open('detail')
    expect(reads.slice(2)).toEqual(['series:sgB.levelPercent from -690 s'])
    expect([...last().series.keys()]).toEqual(['sgB.levelPercent'])
    expect(last().historyErrors.size).toBe(0)
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
