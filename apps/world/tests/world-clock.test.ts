import { describe, expect, test } from 'bun:test'
import type { IsoTimestamp, SimulationClockState } from '../src/core/model/index.ts'
import { createWorldClockOrder, worldClockView } from '../src/ui/world-clock.ts'

const readAt = Date.parse('2026-09-03T12:00:00.000Z')

const clockAt = (currentTime: string, paused: boolean): SimulationClockState => ({
  currentTime: currentTime as IsoTimestamp,
  updatedAt: new Date(readAt).toISOString() as IsoTimestamp,
  paused,
})

describe('World clock', () => {
  test('shows the simulated time of day in labelled UTC, whatever offset the scenario wrote', () => {
    const view = worldClockView({ clock: clockAt('2026-09-03T14:32:05.000Z', false), execution: null }, readAt)

    expect(view?.time).toBe('14:32:05 UTC')
    expect(view?.dateTime).toBe('2026-09-03 14:32:05 UTC')
    expect(view?.paused).toBe(false)
    expect(worldClockView({ clock: clockAt('2026-10-25T02:30:00+02:00', true), execution: null }, readAt)?.time).toBe('00:30:00 UTC')
  })

  test('advances with wall time while the Run plays', () => {
    const clock = clockAt('2026-09-03T08:00:00.000Z', false)

    expect(worldClockView({ clock, execution: null }, readAt + 65_400)?.time).toBe('08:01:05 UTC')
  })

  test('freezes while the Run is paused', () => {
    const clock = clockAt('2026-09-03T08:00:00.000Z', true)
    const paused = { playback: 'paused', pace: 'realtime' } as const

    const first = worldClockView({ clock, execution: paused }, readAt)
    const later = worldClockView({ clock, execution: paused }, readAt + 90_000)

    expect(first?.time).toBe('08:00:00 UTC')
    expect(later?.time).toBe('08:00:00 UTC')
    expect(later?.paused).toBe(true)
  })

  test('does not call a Run playing at maximum pace paused while its clock steps with each execution read', () => {
    const clock = clockAt('2026-09-03T09:15:00.000Z', true)

    const view = worldClockView({ clock, execution: { playback: 'playing', pace: 'maximum' } }, readAt + 5_000)

    expect(view?.time).toBe('09:15:00 UTC')
    expect(view?.paused).toBe(false)
    expect(worldClockView({ clock, execution: { playback: 'paused', pace: 'maximum' } }, readAt)?.paused).toBe(true)
  })

  test('shows nothing before the Run clock is known', () => {
    expect(worldClockView({ clock: undefined, execution: null }, readAt)).toBeNull()
  })
})

describe('World clock order', () => {
  test('a read asked before a clock the Run published never applies, so a late poll answer cannot roll the clock back', () => {
    const order = createWorldClockOrder()
    const late = order.readAsked()
    const stopped = clockAt('2026-09-03T08:05:00.000Z', true)
    expect(order.published(stopped)).toBe(stopped)
    expect(order.readApplies(late)).toBe(false)
    // A read asked after it applies.
    expect(order.readApplies(order.readAsked())).toBe(true)
  })

  test('reads apply in the order they were asked: an answer overtaken by a later read is dropped', () => {
    const order = createWorldClockOrder()
    const first = order.readAsked()
    const second = order.readAsked()
    expect(order.readApplies(second)).toBe(true)
    expect(order.readApplies(first)).toBe(false)
    const third = order.readAsked()
    expect(order.readApplies(third)).toBe(true)
    expect(order.readApplies(third)).toBe(false)
  })

  test('a clock the Run publishes always applies, so a reset or a restore still rewinds after any read', () => {
    const order = createWorldClockOrder()
    expect(order.readApplies(order.readAsked())).toBe(true)
    const rewound = clockAt('2026-09-03T08:00:00.000Z', true)
    expect(order.published(rewound)).toBe(rewound)
    expect(order.published(undefined)).toBeUndefined()
    expect(order.readApplies(order.readAsked())).toBe(true)
  })
})
