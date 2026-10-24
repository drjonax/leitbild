import { describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/ids.ts'
import type { BandPoint, SetColumn, SetSample, VignetteSample, VignetteView } from '../src/features/displays/compose/model.ts'
import { setPenValues, setStripRows } from '../src/ui/embed/vignette/set-trend.ts'
import { bandPaths, stripDrawing } from '../src/ui/embed/vignette/trend.ts'
import { createVignetteSession, type VignetteSnapshot } from '../src/ui/embed/vignette/vignette-client.ts'

// A trend of a set beyond four units (multiunit plan T3.3): its band is the span from min to max with the median, each
// point held until the next, on the strip's own scale; the client keeps the band World served with its history and
// appends each sample's; a unit named as a pen since then asks for its record with the next sample.

const column: SetColumn = {
  label: 'Reactor power', unit: '%',
  observable: { quantity: 'thermal-fraction', unit: '%', valueType: 'number', thresholds: [{ id: 'high', value: 105, direction: 'above', priority: 'warning', effect: 'trip' } as never], intervalMs: 1_000 },
}
const pen = (unit: number) => ({ ref: `plant:halden-${unit}#core.powerRangePercent`, label: `Halden Unit ${unit}`, seriesId: `series:${unit}` })

describe('band geometry', () => {
  const x = (t: number): number => t / 10
  const y = (v: number): number => 100 - v
  const window = { start: 0, end: 1_000 }

  test('spans min to max, each point held until the next and the last until the window ends, the median through it', () => {
    const points: ReadonlyArray<BandPoint> = [{ t: 200, min: 90, median: 95, max: 100 }, { t: 600, min: 92, median: 96, max: 99 }]
    expect(bandPaths(points, x, y, window)).toEqual({
      area: 'M20.0 0.0 L60.0 0.0 L60.0 1.0 L100.0 1.0 L100.0 8.0 L60.0 8.0 L60.0 10.0 L20.0 10.0 Z',
      median: 'M20.0 5.0 L60.0 5.0 L60.0 4.0 L100.0 4.0',
    })
  })

  test('clips to the window and draws nothing where no point holds into it', () => {
    expect(bandPaths([{ t: -500, min: 90, median: 95, max: 100 }], x, y, window)?.area).toBe('M0.0 0.0 L100.0 0.0 L100.0 10.0 L0.0 10.0 Z')
    expect(bandPaths([{ t: 2_000, min: 90, median: 95, max: 100 }], x, y, window)).toBeNull()
    expect(bandPaths([], x, y, window)).toBeNull()
  })

  test('a strip scales to its band as well as its pens', () => {
    const pens = setPenValues(column, [pen(3)])
    const series = new Map([[pens[0]!.ref, { holdMs: 60_000, points: [{ t: 0, v: 100 }] }]])
    const band: ReadonlyArray<BandPoint> = [{ t: 0, min: 80, median: 100, max: 101 }]
    const banded = stripDrawing({ pens, series, observations: [], now: 60_000, horizonMs: 60_000, width: 600, height: 60, band })!
    const plain = stripDrawing({ pens, series, observations: [], now: 60_000, horizonMs: 60_000, width: 600, height: 60 })!
    expect(banded.band).not.toBeNull()
    expect(plain.band).toBeNull()
    expect(banded.values.some(tick => Number(tick.label) <= 80)).toBe(true)
    expect(plain.values.every(tick => Number(tick.label) > 90)).toBe(true)
  })
})

describe('set pens', () => {
  test('are trend pens labelled by unit and quantity, recorded under each unit\'s series', () => {
    expect(setPenValues(column, [pen(7)])).toEqual([{
      ref: 'plant:halden-7#core.powerRangePercent', label: 'Halden Unit 7 · Reactor power', quantity: 'thermal-fraction', unit: '%', valueType: 'number',
      thresholds: column.observable!.thresholds, series: { seriesId: 'series:7', intervalMs: 1_000 },
    }])
    expect(setPenValues({ label: 'Reactor power', unit: '' }, [pen(7)])).toEqual([])
    expect(setStripRows(9, 2)).toBe(4)
    expect(setStripRows(4, 1)).toBe(3)
  })
})

describe('the client keeps a set trend\'s band', () => {
  test('from the history World served, then each sample\'s; a newly named unit asks for its record next', async () => {
    const view: VignetteView = { title: 'Fleet', sections: [{ kind: 'set-trend', rows: 5, label: 'Process plants', horizonMs: 600_000, strips: [column] }] }
    let runMs = Date.parse('2026-10-24T10:00:00.000Z')
    let named = [pen(7), pen(3), pen(9)]
    const asked: string[] = []
    const sample = (history?: { readonly fromMs: number }): VignetteSample => {
      const set: SetSample = {
        kind: 'set-trend', members: 12,
        strips: [{ pens: named, band: { min: 92, median: 100, max: 104, count: 12, minAt: 'Halden Unit 7', maxAt: 'Halden Unit 3' }, missing: [] }],
        ...(history === undefined ? {} : { history: { 0: [{ t: history.fromMs, min: 100, median: 100, max: 100 }] } }),
      }
      return {
        at: { at: new Date(runMs).toISOString(), clock: 'simulation', paused: false },
        observations: named.map(entry => ({ ref: entry.ref, at: new Date(runMs).toISOString(), clock: 'simulation', value: 100, quality: 'good', priority: 'none' })),
        alerts: [], entities: {}, slots: {}, maps: {}, sets: { 0: set },
        ...(history === undefined ? {} : { series: Object.fromEntries(named.map(entry => [entry.seriesId, { holdMs: 60_000, points: [{ t: history.fromMs, v: 100 }] }])) }),
      }
    }
    const timers: Array<() => void> = []
    let snapshot: VignetteSnapshot | undefined
    const session = createVignetteSession({
      runId: 'run-1' as SimulationRunId, state: '{}',
      routes: {
        presence: async () => ({ loaded: true, at: new Date(runMs).toISOString() }),
        view: async () => view,
        sample: async (_run, _state, history) => { asked.push(history === undefined ? 'sample' : 'history'); return sample(history) },
      },
      onChange: next => { snapshot = next },
      wallNow: () => runMs,
      schedule: run => { timers.push(run); return () => {} },
    })
    const settle = async (): Promise<void> => { for (let turn = 0; turn < 20; turn += 1) await Promise.resolve() }
    const tick = async (): Promise<void> => { runMs += 1_000; timers.shift()?.(); await settle() }
    session.start()
    await settle()
    expect(asked).toEqual(['history'])
    expect(snapshot!.bands.get('0:0')!.map(point => point.min)).toEqual([100, 92])
    await tick()
    expect(asked).toEqual(['history', 'sample'])
    expect(snapshot!.bands.get('0:0')!.length).toBe(3)
    expect(snapshot!.series.has(pen(9).ref)).toBe(true)
    // Unit 5 is named in place of unit 9: drawn once its record comes, with the next sample's history.
    named = [pen(7), pen(3), pen(5)]
    await tick()
    expect(snapshot!.series.has(pen(5).ref)).toBe(false)
    await tick()
    expect(asked).toEqual(['history', 'sample', 'sample', 'history'])
    expect(snapshot!.series.has(pen(5).ref)).toBe(true)
    session.close()
  })
})
