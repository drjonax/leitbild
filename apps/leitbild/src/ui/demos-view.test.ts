import { describe, expect, test } from 'bun:test'
import { createCarousel, type CarouselScheduler } from './carousel.ts'
import { demosModalTop, showDemos, showScenarios, type ParkedCarousel } from './demos-view.ts'

// A clock the test drives: one pending rotation timer at a time.
const manualClock = (): CarouselScheduler & { advance(ms: number): void } => {
  let now = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  let sequence = 0
  return {
    setTimeout: (callback, ms) => { timers.set(++sequence, { at: now + ms, callback }); return sequence },
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
  }
}

const demos = ['halden-offsite-power-restoration', 'nordland-corridor-security', 'halden-emergency']
  .map(id => ({ definition: { moduleId: 'world', id } }))

const rotating = () => {
  const clock = manualClock()
  const controller = createCarousel({ count: demos.length, scheduler: clock })
  const carousel: ParkedCarousel = { stop: () => controller.stop(), current: () => controller.snapshot().index }
  return { clock, controller, carousel }
}

describe('the Demos modal\'s More scenarios switch', () => {
  test('opening the list stops rotation for good and replaces the URL with ?scenarios', () => {
    const { clock, controller, carousel } = rotating()
    clock.advance(5000)
    expect(controller.snapshot()).toMatchObject({ index: 1, stopped: false })

    expect(showScenarios({ busy: false, carousel })).toEqual({ kind: 'scenarios' })
    clock.advance(60_000)
    expect(controller.snapshot()).toMatchObject({ index: 1, stopped: true, rotating: false })
  })

  test('back to the demos shows the slide the carousel kept, still stopped', () => {
    const { clock, controller, carousel } = rotating()
    clock.advance(5000)
    showScenarios({ busy: false, carousel })
    clock.advance(20_000)

    expect(showDemos({ busy: false, carousel, demos })).toEqual({ kind: 'demos', demo: 'world:nordland-corridor-security' })
    expect(controller.snapshot()).toMatchObject({ index: 1, stopped: true })
    controller.play()
    clock.advance(5000)
    expect(controller.snapshot().index).toBe(2)
  })

  test('neither switch runs while a launch is in flight, so its progress stays in view', () => {
    const { controller, carousel } = rotating()
    expect(showScenarios({ busy: true, carousel })).toBeNull()
    expect(controller.snapshot().stopped).toBe(false)
    expect(showDemos({ busy: true, carousel, demos })).toBeNull()
  })

  test('a list opened by deep link, before any carousel exists, goes back to the Demos route without a key', () => {
    expect(showScenarios({ busy: false, carousel: null })).toEqual({ kind: 'scenarios' })
    expect(showDemos({ busy: false, carousel: null, demos })).toEqual({ kind: 'demos', demo: null })
  })
})

describe('the anchored top of the Demos modal', () => {
  test('is where the demos view sits when centred, so the header does not move between views', () => {
    // 1440×900: header 65 px + border 2 px, carousel 673 px → 740 px tall, centred at 80 px.
    expect(demosModalTop({ viewportHeight: 900, chrome: 67, demosBody: 673 })).toBe(80)
    expect(demosModalTop({ viewportHeight: 768, chrome: 67, demosBody: 621 })).toBe(40)
  })

  test('keeps the modal\'s 16 px margin when the demos view is as tall as the viewport', () => {
    expect(demosModalTop({ viewportHeight: 700, chrome: 67, demosBody: 673 })).toBe(16)
  })
})
