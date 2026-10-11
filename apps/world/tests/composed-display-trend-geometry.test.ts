import { describe, expect, test } from 'bun:test'
import { formatValue } from '../src/packs/process-plant/displays/display-text.ts'
import { appendPoint, HOLD_GAP_MS } from '../src/packs/process-plant/displays/trend-reading.ts'
import {
  coincidentPens,
  paddedDomain,
  rawDomain,
  runText,
  stepPath,
  tickLabels,
  timeTicks,
  limitInScale,
  trendWindowMs,
  valueTicks,
} from '../src/ui/embed/composed-display/trend-geometry.ts'

describe('composed display trend geometry', () => {
  test('pads a fixed domain, never collapses a flat signal, and never magnifies small swings', () => {
    expect(rawDomain([])).toBeNull()
    expect(paddedDomain({ min: 20, max: 70 })).toEqual({ min: 16, max: 74 })
    const flat = paddedDomain({ min: 15.5, max: 15.5 })
    expect([flat.min, flat.max].map(value => Number(value.toFixed(2)))).toEqual([15, 16])
    // A 0.6 °C wobble of Tavg at 291 °C spans at least 4 % of the value, not the whole strip.
    const steady = paddedDomain({ min: 291.2, max: 291.8 })
    expect(Number((steady.max - steady.min).toFixed(2))).toBe(11.67)
    expect(paddedDomain({ min: 0, max: 0 })).toEqual({ min: -1, max: 1 })
    // Near zero a scale still spans one unit: a 5.3 °C subcooling margin is not magnified to 0.2 °C.
    const margin = paddedDomain({ min: 5.3, max: 5.36 })
    expect(Number((margin.max - margin.min).toFixed(2))).toBe(1)
  })

  test('never spans less than a tenth of the instrument\'s span, about the values, inside the span (HMI review of run 23)', () => {
    // A PORV held at 35 % read on a 1 % scale; on its 0–100 % span it spans 10 %, centred.
    const porv = paddedDomain({ min: 0.35, max: 0.35 }, null, { span: { min: 0, max: 1 } })
    expect([porv.min, porv.max].map(value => Number(value.toFixed(6)))).toEqual([0.3, 0.4])
    // Power steady at 100 % with its alarm and trip drawn above: no longer on the axis floor.
    const power = paddedDomain({ min: 100, max: 100 }, null, { span: { min: 0, max: 120 }, limits: [105.9, 110.3] })
    expect((100 - power.min) / (power.max - power.min)).toBeGreaterThan(0.3)
    expect(power.max).toBeGreaterThan(110.3)
    // A level at the bottom of its span is kept inside it, not centred on 0 %.
    expect(paddedDomain({ min: 0, max: 0 }, null, { span: { min: 0, max: 100 } })).toEqual({ min: 0, max: 10 })
    // A range wider than a tenth of the span is padded as before.
    expect(paddedDomain({ min: 20, max: 70 }, null, { span: { min: 0, max: 100 } })).toEqual({ min: 16, max: 74 })
  })

  test('finds traces drawn on one another, and names them by a range', () => {
    const flat = (v: number) => [{ t: 0, v }, { t: 30_000, v }, { t: 60_000, v }]
    const y = (v: number) => 100 - v
    const pens = [{ key: 'A', points: flat(55) }, { key: 'B', points: flat(55.01) }, { key: 'C', points: flat(55) }, { key: 'D', points: flat(55) }, { key: 'E', points: flat(40) }]
    expect(coincidentPens(pens, y, { start: 0, end: 60_000 })).toEqual([['A', 'B', 'C', 'D']])
    // Apart at any change, they do not coincide.
    expect(coincidentPens([{ key: 'A', points: flat(55) }, { key: 'B', points: [{ t: 0, v: 55 }, { t: 30_000, v: 50 }] }], y, { start: 0, end: 60_000 })).toEqual([])
    expect([runText(['A', 'B', 'C', 'D']), runText(['A', 'C']), runText(['A', 'B'])]).toEqual(['A–D', 'A, C', 'A, B'])
  })

  test('spans a young Run\'s history, rounded up to 30 s, until it reaches the horizon', () => {
    expect(trendWindowMs(600_000, 1_000_000, null)).toBe(600_000)
    expect(trendWindowMs(600_000, 1_000_000, 1_000_000 - 20_000)).toBe(60_000)
    expect(trendWindowMs(600_000, 1_000_000, 1_000_000 - 95_000)).toBe(120_000)
    expect(trendWindowMs(600_000, 1_000_000, 0)).toBe(600_000)
    expect(timeTicks(1_000_000, 120_000).map(tick => tick.label)).toEqual(['−2 min', '−90 s', '−1 min', '−30 s', 'now'])
  })

  test('names far limits at the plot edge instead of stretching the scale', () => {
    expect(limitInScale(450, { min: 1080, max: 1120 })).toBe(false)
    expect(limitInScale(30, { min: 34, max: 36 })).toBe(true)
    expect(limitInScale(13.8, { min: 4, max: 15.5 })).toBe(true)
    expect(limitInScale(450, null)).toBe(true)
  })

  test('chooses readable value ticks, never a single one', () => {
    expect(valueTicks({ min: 8.2, max: 10.6 }, 2).length).toBeGreaterThanOrEqual(2)
    expect(valueTicks({ min: 13.6, max: 16.5 })).toEqual([14, 15, 16])
    expect(valueTicks({ min: 16, max: 74 })).toEqual([20, 40, 60])
  })

  test('labels time relative to now', () => {
    expect(timeTicks(1_000_000, 600_000).map(tick => tick.label)).toEqual(['−10 min', '−8 min', '−6 min', '−4 min', '−2 min', 'now'])
    expect(timeTicks(1_000_000, 120_000).map(tick => tick.label)).toEqual(['−2 min', '−90 s', '−1 min', '−30 s', 'now'])
  })

  test('keeps points ordered within the window plus the hold gap', () => {
    const points = [{ t: 0, v: 1 }, { t: 100_000, v: 2 }, { t: 200_000, v: 3 }]
    expect(appendPoint(points, { t: 300_000, v: 4 }, 250_000).map(point => point.t)).toEqual([200_000, 300_000])
    expect(appendPoint(points, { t: 150_000, v: 9 }, 0).map(point => point.t)).toEqual([0, 100_000, 150_000])
  })

  test('holds sampled values and breaks across long gaps', () => {
    const x = (t: number) => t / 1000
    const y = (v: number) => v
    const window = { start: 0, end: 300_000 }
    expect(stepPath([{ t: 0, v: 5 }, { t: 60_000, v: 6 }], x, y, window)).toBe('M0.0 5.0 L60.0 5.0 L60.0 6.0 L150.0 6.0')
    const gap = stepPath([{ t: 0, v: 5 }, { t: HOLD_GAP_MS + 60_000, v: 6 }], x, y, window)
    expect(gap).toBe('M0.0 5.0 L90.0 5.0 M150.0 6.0 L240.0 6.0')
  })

  test('formats values and units for operators', () => {
    expect(formatValue(15.512)).toBe('15.5')
    expect(formatValue(3412.4)).toBe('3412')
    expect(formatValue(0.0123)).toBe('0.012')
    expect(tickLabels([5, 10, 15])).toEqual(['5', '10', '15'])
    expect(tickLabels([0.5, 1, 1.5])).toEqual(['0.5', '1.0', '1.5'])
  })
})
