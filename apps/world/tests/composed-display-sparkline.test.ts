import { describe, expect, test } from 'bun:test'
import type { ComposedDisplayThreshold } from '../src/packs/process-plant/displays/ic-thresholds.ts'
import { SPARKLINE_SIZE, sparkline, sparklineText, sparklineWindowText } from '../src/ui/embed/composed-display/sparkline.ts'
import type { TrendPoint } from '../src/ui/embed/composed-display/trend-geometry.ts'

const now = 1_000_000
const windowMs = 600_000
const start = now - windowMs
const size = SPARKLINE_SIZE

// The pressurizer's pressure limits, as the reference PWR declares them.
const pressure: ReadonlyArray<ComposedDisplayThreshold> = [
  { ruleId: 'trip-low', label: 'Pressure low trip', kind: 'trip', operator: '<', direction: 'low', value: 13.8, escalation: 1 },
  { ruleId: 'alarm-low', label: 'Pressure low', kind: 'alarm', operator: '<', direction: 'low', value: 14.8, escalation: 1 },
  { ruleId: 'spray', label: 'Spray on', kind: 'control', operator: '>', direction: 'high', value: 15.65, escalation: 1 },
  { ruleId: 'alarm-high', label: 'Pressure high', kind: 'alarm', operator: '>', direction: 'high', value: 16, escalation: 1 },
]

const every = (stepMs: number, from: number, to: number, value: (t: number) => number): ReadonlyArray<TrendPoint> =>
  Array.from({ length: Math.floor((to - from) / stepMs) + 1 }, (_, index) => from + index * stepMs).map(t => ({ t, v: value(t) }))

/** The y of every vertex of a path. */
const ys = (path: string): ReadonlyArray<number> => [...path.matchAll(/[ML][\d.]+ ([\d.]+)/g)].map(match => Number(match[1]))

describe('lead value sparklines', () => {
  test('draw only what is recorded in the window: a gap in history stays a gap, older values neither draw nor scale', () => {
    const line = sparkline({
      points: [
        // Its hold ends before the window opens.
        { t: start - 120_000, v: 20 },
        { t: start + 50_000, v: 15.6 },
        { t: start + 100_000, v: 15.6 },
        // Over three minutes with nothing recorded, then a value re-recorded each minute.
        ...every(60_000, start + 300_000, now - 60_000, () => 15.4),
        { t: now, v: 15.45 },
      ],
      now, windowMs, size, value: 15.45, thresholds: [],
    })
    expect(line.range).toEqual({ min: 15.4, max: 15.6 })
    expect(line.path.match(/M/g)).toHaveLength(2)
    expect(line.broken).toBe(true)
    expect(sparklineText({ recorded: true, windowMs, unit: 'MPa', line, historyMissing: false, historyError: undefined })).toBe('Last 10 min: 15.4 to 15.6 MPa · broken where nothing was recorded')
    expect(line.path.startsWith(`M${(50_000 / windowMs * (size.width - 4)).toFixed(1)} `)).toBe(true)
    expect(line.end?.x).toBe(size.width - 4)
  })

  test('a value held from before the window draws from its start, and a line whose last value no longer holds has no end', () => {
    const held = sparkline({ points: [{ t: start - 60_000, v: 3400 }, { t: start + 60_000, v: 3400 }], now, windowMs, size, value: 3400, thresholds: [] })
    expect(held.path.startsWith('M0.0 ')).toBe(true)
    // The last value is older than the historian's re-recording interval allows: no dot at now.
    expect(held.end).toBeNull()
    expect(sparkline({ points: [], now, windowMs, size, value: undefined, thresholds: [] })).toEqual({ path: '', end: null, limit: null, range: null, broken: false })
  })

  test('a steady value is a flat line in the middle, a small wobble stays small, and a ramp fills the height', () => {
    // Recorded once a minute, as the historian records an unchanged value.
    const flat = sparkline({ points: every(60_000, start, now, () => 15.5), now, windowMs, size, value: 15.5, thresholds: [] })
    expect(new Set(ys(flat.path))).toEqual(new Set([size.height / 2]))
    expect([flat.path.match(/M/g)?.length, flat.broken]).toEqual([1, false])
    // ±0.01 MPa about 15.51 MPa is noise on a scale at least 1 MPa tall.
    const wobble = ys(sparkline({ points: every(1_000, now - 60_000, now, t => (t / 1_000) % 2 === 0 ? 15.5 : 15.52), now, windowMs, size, value: 15.52, thresholds: [] }).path)
    expect(Math.max(...wobble) - Math.min(...wobble)).toBeLessThan(1)
    // Reactor power falling 200 MW over the window: from near the top to near the bottom.
    const ramp = sparkline({ points: every(10_000, start, now, t => 3400 - 200 * (t - start) / windowMs), now, windowMs, size, value: 3200, thresholds: [] })
    expect(ys(ramp.path)[0]).toBeLessThan(6)
    expect(ramp.end!.y).toBeGreaterThan(size.height - 6)
  })

  test('mark the limit the row names only where it lies inside the plotted range', () => {
    const rising = every(10_000, start, now, t => 15.8 + 0.1 * (t - start) / windowMs)
    const near = sparkline({ points: rising, now, windowMs, size, value: 15.9, thresholds: pressure })
    expect(near.limit?.threshold.ruleId).toBe('alarm-high')
    expect(near.limit!.y).toBeLessThan(near.end!.y)
    // At 15.5 MPa the nearest limit, HI ALM 16 MPa, falls on the scale's edge: not drawn.
    expect(sparkline({ points: every(60_000, start, now, () => 15.5), now, windowMs, size, value: 15.5, thresholds: pressure }).limit).toBeNull()
    // Generator output far above its low alarm keeps its own scale.
    const output = sparkline({
      points: every(60_000, start, now, () => 1100), now, windowMs, size, value: 1100,
      thresholds: [{ ruleId: 'gen-low', label: 'Generator output low', kind: 'alarm', operator: '<', direction: 'low', value: 450, escalation: 1 }],
    })
    expect([output.limit, output.end?.y]).toEqual([null, size.height / 2])
  })

  test('say what the line shows, and why a value has none', () => {
    const line = sparkline({ points: every(10_000, start, now, t => 15.8 + 0.1 * (t - start) / windowMs), now, windowMs, size, value: 15.9, thresholds: pressure })
    const text = (overrides: Partial<Parameters<typeof sparklineText>[0]>) =>
      sparklineText({ recorded: true, windowMs, unit: 'MPa', line, historyMissing: false, historyError: undefined, ...overrides })
    expect(sparklineWindowText(600_000)).toBe('10 min')
    expect(sparklineWindowText(90_000)).toBe('90 s')
    expect(text({})).toBe('Last 10 min: 15.8 to 15.9 MPa · dashed line: HI ALM 16 MPa')
    expect(text({ line: sparkline({ points: [{ t: now, v: 0.101325 }], now, windowMs, size, value: 0.101325, thresholds: [] }), unit: 'MPa', historyMissing: true }))
      .toBe('Last 10 min: steady at 0.101 MPa · nothing recorded before this display opened')
    expect(text({ line: null, historyError: 'Reading history failed with HTTP 503' }))
      .toBe('No values in the last 10 min yet · its history could not be read (Reading history failed with HTTP 503), so the line starts when this display opened')
    expect(text({ recorded: false, line: null })).toBe('Not recorded by this Run\'s historian, so no trend: current value only')
  })
})
