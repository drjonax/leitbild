import { describe, expect, test } from 'bun:test'
import {
  answerZoomStore,
  createDisplayZoomStore,
  displayFrameGeometry,
  displayZoomFromSlider,
  fitDisplayZoom,
  initialDisplayZoom,
  overviewZoomKey,
  overviewZoomStore,
  reduceDisplayZoom,
  sliderPercentForZoom,
  steppedDisplayZoom,
  storedDisplayZoom,
  type DisplayZoomContext,
  type DisplayZoomState,
} from '../src/ui/process-display/display-zoom.ts'

const createMemoryStorage = () => {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      values.set(key, value)
    },
  }
}

const body = { width: 1000, height: 600 }

const advice = (overrides: Partial<DisplayZoomContext> = {}): DisplayZoomContext => ({
  kind: 'advice',
  body,
  extent: null,
  envelopeHeight: 800,
  ...overrides,
})

const generated = (overrides: Partial<DisplayZoomContext> = {}): DisplayZoomContext => ({
  kind: 'generated',
  body,
  extent: null,
  envelopeHeight: 0,
  ...overrides,
})

describe('display zoom steps', () => {
  test('− and + walk the ladder and stop at 50 % and 200 %', () => {
    expect(steppedDisplayZoom(1, 'in')).toBe(1.1)
    expect(steppedDisplayZoom(1, 'out')).toBe(0.9)
    expect(steppedDisplayZoom(0.67, 'out')).toBe(0.5)
    expect(steppedDisplayZoom(0.5, 'out')).toBe(0.5)
    expect(steppedDisplayZoom(2, 'in')).toBe(2)
  })

  test('a zoom between steps snaps to the next step in the direction asked', () => {
    expect(steppedDisplayZoom(0.8, 'in')).toBe(0.9)
    expect(steppedDisplayZoom(0.8, 'out')).toBe(0.75)
    expect(steppedDisplayZoom(2 / 3, 'in')).toBe(0.75)
  })

  test('the slider moves in 5 % steps within 50-200 %', () => {
    expect(displayZoomFromSlider(87)).toBe(0.85)
    expect(displayZoomFromSlider(20)).toBe(0.5)
    expect(displayZoomFromSlider(260)).toBe(2)
    expect(sliderPercentForZoom(0.67)).toBe(65)
  })
})

describe('display frame geometry', () => {
  test('a generated display gets the whole body at its zoom', () => {
    expect(displayFrameGeometry({ kind: 'generated', zoom: 0.5, body, extent: null, envelopeHeight: 0 })).toEqual({
      frameWidth: 2000,
      frameHeight: 1200,
      boxWidth: 1000,
      boxHeight: 600,
      bodyScrolls: false,
    })
  })

  test('advice keeps its height, stretches to the body and never gets narrower than its content', () => {
    const extent = { kind: 'advice' as const, minWidth: 900, width: 900, height: 700 }
    expect(displayFrameGeometry({ kind: 'advice', zoom: 2, body, extent, envelopeHeight: 800 })).toEqual({
      frameWidth: 900,
      frameHeight: 700,
      boxWidth: 1800,
      boxHeight: 1400,
      bodyScrolls: true,
    })
    expect(displayFrameGeometry({ kind: 'advice', zoom: 0.5, body, extent: null, envelopeHeight: 800 })).toMatchObject({
      frameWidth: 2000,
      frameHeight: 800,
      boxWidth: 1000,
      boxHeight: 400,
    })
  })
})

describe('display fit', () => {
  test('advice fits its whole height and narrowest width, up to 200 %', () => {
    expect(fitDisplayZoom(advice({ extent: { kind: 'advice', minWidth: 500, width: 500, height: 300 } }), 1)).toBe(2)
    expect(fitDisplayZoom(advice({ extent: { kind: 'advice', minWidth: 1250, width: 1250, height: 300 } }), 1)).toBe(0.8)
    // Until the frame reports, the published height stands in.
    expect(fitDisplayZoom(advice(), 1)).toBe(0.75)
    // Rounded down: 734 / 620 fits at 118.3 %, never at 118.4 %.
    expect(fitDisplayZoom(advice({ body: { width: 1256, height: 734 }, extent: { kind: 'advice', minWidth: 660, width: 660, height: 620 } }), 1)).toBe(1.183)
  })

  test('a generated display fits the room it reported needing and is never magnified', () => {
    const extent = { kind: 'generated' as const, minWidth: 1, width: 1250, height: 600 }
    expect(fitDisplayZoom(generated({ extent }), 1)).toBe(0.8)
    expect(fitDisplayZoom(generated({ extent: { ...extent, width: 500, height: 300 } }), 1)).toBe(1)
    expect(fitDisplayZoom(generated({ extent: { ...extent, width: 5000 } }), 1)).toBe(0.5)
  })

  test('Fit on a generated display allows one correction after the next report, then stops', () => {
    const first = { kind: 'generated' as const, minWidth: 1, width: 1250, height: 600 }
    let state = reduceDisplayZoom(initialDisplayZoom(generated(), null), { type: 'toggle-fit' }, generated({ extent: first }))
    expect(state).toEqual({ zoom: 0.8, fit: true, auto: false, corrections: 1 })

    // Relaid out for its new size, the display needs more room: one correction.
    state = reduceDisplayZoom(state, { type: 'extent' }, generated({ extent: { ...first, width: 2000 } }))
    expect(state).toEqual({ zoom: 0.5, fit: true, auto: false, corrections: 0 })

    // Further reports never move it again: no oscillation across layouts.
    state = reduceDisplayZoom(state, { type: 'extent' }, generated({ extent: { ...first, width: 4000, height: 1200 } }))
    expect(state.zoom).toBe(0.5)

    // A new body size is a new fit, with its own correction; it keeps the room the display last needed.
    const settled = { ...first, width: 2000, height: 1200 }
    state = reduceDisplayZoom(state, { type: 'body' }, generated({ body: { width: 2000, height: 1200 }, extent: settled }))
    expect(state).toEqual({ zoom: 1, fit: true, auto: false, corrections: 1 })
    state = reduceDisplayZoom(state, { type: 'body' }, generated({ body: { width: 1000, height: 600 }, extent: settled }))
    expect(state.zoom).toBe(0.5)
  })

  test('advice under Fit refits on every report and body change', () => {
    let state = reduceDisplayZoom(initialDisplayZoom(advice(), null), { type: 'toggle-fit' }, advice())
    expect(state.fit).toBe(true)
    state = reduceDisplayZoom(state, { type: 'extent' }, advice({ extent: { kind: 'advice', minWidth: 400, width: 400, height: 400 } }))
    expect(state.zoom).toBe(1.5)
    state = reduceDisplayZoom(state, { type: 'body' }, advice({ body: { width: 1000, height: 300 }, extent: { kind: 'advice', minWidth: 400, width: 400, height: 400 } }))
    expect(state.zoom).toBe(0.75)
  })

  test('any manual zoom turns Fit off, and toggling Fit off keeps the zoom', () => {
    const fittedState: DisplayZoomState = { zoom: 0.8, fit: true, auto: false, corrections: 1 }
    expect(reduceDisplayZoom(fittedState, { type: 'step', step: 'in' }, generated())).toEqual({ zoom: 0.9, fit: false, auto: false, corrections: 0 })
    expect(reduceDisplayZoom(fittedState, { type: 'set', zoom: 1.35 }, generated()).fit).toBe(false)
    expect(reduceDisplayZoom(fittedState, { type: 'scale', factor: 1.1 }, generated()).zoom).toBe(0.88)
    expect(reduceDisplayZoom(fittedState, { type: 'toggle-fit' }, generated())).toEqual({ zoom: 0.8, fit: false, auto: false, corrections: 0 })
    expect(reduceDisplayZoom(fittedState, { type: 'step', step: 'reset' }, generated()).zoom).toBe(1)
  })
})

describe('display zoom defaults', () => {
  test('a generated display opens at 100 %', () => {
    expect(initialDisplayZoom(generated(), null)).toEqual({ zoom: 1, fit: false, auto: false, corrections: 0 })
  })

  test('advice opens at Fit held to 75-100 % and follows its extent until the operator zooms', () => {
    let state = initialDisplayZoom(advice({ body: null }), null)
    expect(state).toEqual({ zoom: 1, fit: false, auto: true, corrections: 0 })
    state = reduceDisplayZoom(state, { type: 'body' }, advice())
    expect(state.zoom).toBe(0.75)
    state = reduceDisplayZoom(state, { type: 'extent' }, advice({ extent: { kind: 'advice', minWidth: 400, width: 400, height: 300 } }))
    expect(state.zoom).toBe(1)
    expect(storedDisplayZoom(state)).toBeNull()

    state = reduceDisplayZoom(state, { type: 'step', step: 'out' }, advice())
    expect(state.auto).toBe(false)
    state = reduceDisplayZoom(state, { type: 'extent' }, advice({ extent: { kind: 'advice', minWidth: 400, width: 400, height: 2000 } }))
    expect(state.zoom).toBe(0.9)
    expect(storedDisplayZoom(state)).toEqual({ zoom: 0.9, fit: false })
  })

  test('a remembered zoom wins over the default, and a remembered Fit fits', () => {
    expect(initialDisplayZoom(advice(), { zoom: 1.5, fit: false }).zoom).toBe(1.5)
    expect(initialDisplayZoom(generated({ extent: { kind: 'generated', minWidth: 1, width: 2000, height: 600 } }), { zoom: 1, fit: true }))
      .toEqual({ zoom: 0.5, fit: true, auto: false, corrections: 1 })
  })
})

describe('display zoom storage', () => {
  test('remembers overview zoom per Run and Plant in a bounded list', () => {
    const storage = createMemoryStorage()
    const store = createDisplayZoomStore({ storageKey: 'zoom-test', limit: 2, storage })
    store.write(overviewZoomKey('run-1', 'unit-a'), { zoom: 1.25, fit: false })
    store.write(overviewZoomKey('run-1', 'unit-b'), { zoom: 0.75, fit: true })
    store.write(overviewZoomKey('run-1', 'unit-a'), { zoom: 1.5, fit: false })
    store.write(overviewZoomKey('run-1', 'unit-c'), { zoom: 2, fit: false })

    expect(store.read('run-1:unit-a')).toEqual({ zoom: 1.5, fit: false })
    expect(store.read('run-1:unit-b')).toBeNull()
    expect(store.read('run-1:unit-c')).toEqual({ zoom: 2, fit: false })
  })

  test('overview zoom goes to the given local storage and answer zoom to the session storage', () => {
    const local = createMemoryStorage()
    const session = createMemoryStorage()
    overviewZoomStore(local).write('run-1:unit-a', { zoom: 1.1, fit: false })
    answerZoomStore(session).write('room/turn/call/key', { zoom: 0.9, fit: true })
    expect([...local.values.keys()]).toEqual(['leitbild.processDisplayZoom.v1'])
    expect([...session.values.keys()]).toEqual(['leitbild.processDisplayAnswerZoom.v1'])
  })

  test('rejects unreadable storage visibly instead of overwriting it', () => {
    const storage = createMemoryStorage()
    const store = createDisplayZoomStore({ storageKey: 'zoom-test', limit: 10, storage })
    storage.setItem('zoom-test', '[["run-1:unit-a",{"zoom":9,"fit":false}]]')
    expect(() => store.read('run-1:unit-a')).toThrow('out of range')
    expect(() => store.write('run-1:unit-b', { zoom: 1, fit: false })).toThrow('out of range')
    storage.setItem('zoom-test', 'not json')
    expect(() => store.read('run-1:unit-a')).toThrow('invalid JSON')
  })
})
