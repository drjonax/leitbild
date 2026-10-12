import { describe, expect, test } from 'bun:test'
import {
  createCarousel, pickerKeyTarget, pickerLabel, slideLabel, swipeDirection, toggleLabel, type CarouselScheduler,
} from './carousel.ts'

const fakeScheduler = (): CarouselScheduler & { advance(ms: number): void; pending(): number } => {
  let now = 0
  let sequence = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  return {
    setTimeout: (callback, ms) => {
      sequence += 1
      timers.set(sequence, { at: now + ms, callback })
      return sequence
    },
    clearTimeout: handle => { timers.delete(handle as number) },
    now: () => now,
    advance(ms) {
      const end = now + ms
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]
        if (!next || next[1].at > end) break
        timers.delete(next[0])
        now = next[1].at
        next[1].callback()
      }
      now = end
    },
    pending: () => timers.size,
  }
}

const carousel = (options: { count?: number; startStopped?: boolean; initialIndex?: number } = {}) => {
  const scheduler = fakeScheduler()
  const controller = createCarousel({ count: options.count ?? 6, scheduler, ...options })
  return { scheduler, controller }
}

describe('carousel rotation', () => {
  test('advances every 5 s and wraps', () => {
    const { scheduler, controller } = carousel({ count: 3 })
    expect(controller.snapshot()).toMatchObject({ index: 0, rotating: true, stopped: false, live: 'off' })
    scheduler.advance(4999)
    expect(controller.snapshot().index).toBe(0)
    scheduler.advance(1)
    expect(controller.snapshot().index).toBe(1)
    scheduler.advance(10000)
    expect(controller.snapshot().index).toBe(0)
  })

  test('starts stopped for reduced motion, keyboard or deep-link opens, and never rotates until Play', () => {
    const { scheduler, controller } = carousel({ startStopped: true, initialIndex: 2 })
    expect(controller.snapshot()).toMatchObject({ index: 2, stopped: true, rotating: false, live: 'polite' })
    scheduler.advance(60000)
    expect(controller.snapshot().index).toBe(2)
    expect(scheduler.pending()).toBe(0)
    controller.play()
    expect(controller.snapshot()).toMatchObject({ stopped: false, live: 'off' })
    scheduler.advance(5000)
    expect(controller.snapshot().index).toBe(3)
  })

  test('hover holds while hovered and resumes with the remaining time', () => {
    const { scheduler, controller } = carousel()
    scheduler.advance(3000)
    controller.hold('hover')
    expect(controller.snapshot()).toMatchObject({ held: true, rotating: false, stopped: false, live: 'off' })
    scheduler.advance(20000)
    expect(controller.snapshot().index).toBe(0)
    controller.release('hover')
    scheduler.advance(1999)
    expect(controller.snapshot().index).toBe(0)
    scheduler.advance(1)
    expect(controller.snapshot().index).toBe(1)
  })

  test('a held slide never changes the instant the pointer leaves', () => {
    const { scheduler, controller } = carousel()
    scheduler.advance(4900)
    controller.hold('hover')
    controller.release('hover')
    scheduler.advance(499)
    expect(controller.snapshot().index).toBe(0)
    scheduler.advance(1)
    expect(controller.snapshot().index).toBe(1)
  })

  test('keyboard focus inside stops until Play; focus leaving does not resume', () => {
    const { scheduler, controller } = carousel()
    controller.keyboardFocus()
    expect(controller.snapshot()).toMatchObject({ stopped: true, live: 'polite' })
    scheduler.advance(10000)
    expect(controller.snapshot().index).toBe(0)
    controller.toggle()
    expect(controller.snapshot()).toMatchObject({ stopped: false, live: 'off' })
    scheduler.advance(5000)
    expect(controller.snapshot().index).toBe(1)
  })

  test('pointer navigation restarts the full 5 s and keeps rotating', () => {
    const { scheduler, controller } = carousel()
    scheduler.advance(4000)
    controller.next('pointer')
    expect(controller.snapshot()).toMatchObject({ index: 1, stopped: false, rotating: true })
    scheduler.advance(4999)
    expect(controller.snapshot().index).toBe(1)
    scheduler.advance(1)
    expect(controller.snapshot().index).toBe(2)
    controller.goTo(5, 'pointer')
    controller.previous('pointer')
    expect(controller.snapshot().index).toBe(4)
  })

  test('keyboard navigation (arrows on the pickers) stops rotation', () => {
    const { scheduler, controller } = carousel()
    controller.next('keyboard')
    expect(controller.snapshot()).toMatchObject({ index: 1, stopped: true })
    scheduler.advance(20000)
    expect(controller.snapshot().index).toBe(1)
  })

  test('pointer navigation on a stopped carousel leaves it stopped', () => {
    const { scheduler, controller } = carousel({ startStopped: true })
    controller.next('pointer')
    scheduler.advance(20000)
    expect(controller.snapshot()).toMatchObject({ index: 1, stopped: true })
  })

  test('Pause and Play are always available, and Play always resumes', () => {
    const { scheduler, controller } = carousel()
    controller.toggle()
    expect(controller.snapshot().stopped).toBe(true)
    controller.toggle()
    expect(controller.snapshot().stopped).toBe(false)
    controller.stop()
    controller.play()
    scheduler.advance(5000)
    expect(controller.snapshot().index).toBe(1)
  })

  test('hidden tab and offscreen hold independently of hover', () => {
    const { scheduler, controller } = carousel()
    controller.hold('hidden')
    controller.hold('offscreen')
    controller.release('hidden')
    scheduler.advance(10000)
    expect(controller.snapshot().index).toBe(0)
    controller.release('offscreen')
    scheduler.advance(5000)
    expect(controller.snapshot().index).toBe(1)
  })

  test('the progress cycle restarts on every fresh interval, not on holds', () => {
    const { scheduler, controller } = carousel()
    const start = controller.snapshot().cycle
    controller.hold('hover')
    controller.release('hover')
    expect(controller.snapshot().cycle).toBe(start)
    scheduler.advance(5000)
    expect(controller.snapshot().cycle).toBe(start + 1)
    controller.next('pointer')
    expect(controller.snapshot().cycle).toBe(start + 2)
  })

  test('notifies subscribers and stops after destroy', () => {
    const { scheduler, controller } = carousel()
    const seen: number[] = []
    const unsubscribe = controller.subscribe(snapshot => seen.push(snapshot.index))
    scheduler.advance(5000)
    unsubscribe()
    scheduler.advance(5000)
    expect(seen).toEqual([0, 1])
    controller.destroy()
    scheduler.advance(20000)
    expect(controller.snapshot().index).toBe(2)
    expect(scheduler.pending()).toBe(0)
  })

  test('a single slide never rotates', () => {
    const { scheduler, controller } = carousel({ count: 1 })
    expect(controller.snapshot().rotating).toBe(false)
    scheduler.advance(20000)
    expect(controller.snapshot().index).toBe(0)
  })
})

describe('carousel labels and input helpers', () => {
  test('labels slides, pickers and the toggle', () => {
    expect(slideLabel(2, 6, 'Dispatch by touch')).toBe('3 of 6: Dispatch by touch')
    expect(pickerLabel(0, 3, 'Halden: loss of offsite power', 'demo')).toBe('Show demo 1 of 3: Halden: loss of offsite power')
    expect(toggleLabel(false)).toBe('Stop automatic slide show')
    expect(toggleLabel(true)).toBe('Start automatic slide show')
  })

  test('follows the APG tabs keys on the pickers', () => {
    expect(pickerKeyTarget('ArrowRight', 5, 6)).toBe(0)
    expect(pickerKeyTarget('ArrowLeft', 0, 6)).toBe(5)
    expect(pickerKeyTarget('Home', 3, 6)).toBe(0)
    expect(pickerKeyTarget('End', 3, 6)).toBe(5)
    expect(pickerKeyTarget('Enter', 3, 6)).toBeNull()
  })

  test('swipes only on touch or pen, ≥ 60 px and < 30° from horizontal', () => {
    expect(swipeDirection({ x: 200, y: 100 }, { x: 120, y: 110 }, 'touch')).toBe(1)
    expect(swipeDirection({ x: 100, y: 100 }, { x: 180, y: 90 }, 'pen')).toBe(-1)
    expect(swipeDirection({ x: 200, y: 100 }, { x: 120, y: 110 }, 'mouse')).toBe(0)
    expect(swipeDirection({ x: 200, y: 100 }, { x: 150, y: 100 }, 'touch')).toBe(0)
    expect(swipeDirection({ x: 200, y: 100 }, { x: 120, y: 160 }, 'touch')).toBe(0)
  })
})
