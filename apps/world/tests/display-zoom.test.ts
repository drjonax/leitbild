import { describe, expect, test } from 'bun:test'
import {
  answerZoomStore,
  createDisplayZoomStore,
  displayFrameGeometry,
  displayZoomFromSlider,
  displayZoomPercent,
  FIT_MIN_ZOOM,
  fitDisplayZoom,
  initialDisplayZoom,
  overviewZoomKey,
  overviewZoomStore,
  presentedFrameGeometry,
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

const manualAt = (zoom: number): DisplayZoomState => ({ zoom, fit: false, auto: false, corrections: 0 })

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

  test('the slider shows the zoom the readout shows, in whole percent within 50-200 %', () => {
    expect(displayZoomFromSlider(87)).toBe(0.87)
    expect(displayZoomFromSlider(20)).toBe(0.5)
    expect(displayZoomFromSlider(260)).toBe(2)
    // One zoom feeds both: every ladder step and every fitted zoom reads the same on the slider and the readout.
    for (const zoom of [0.5, 0.67, 0.75, FIT_MIN_ZOOM, 0.952, 1, 1.183, 2]) expect(sliderPercentForZoom(zoom)).toBe(displayZoomPercent(zoom))
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

  test('a hidden frame keeps the size it was hidden at and takes the window\'s once shown again', () => {
    const at = (width: number, zoom: number) => displayFrameGeometry({ kind: 'generated', zoom, body: { width, height: 600 }, extent: null, envelopeHeight: 0 })
    let presented = presentedFrameGeometry(null, at(1000, 1), true)
    expect(presented).toEqual(at(1000, 1))
    // Hidden, the window is resized (and its zoom refitted) many times: the frame is not drawn for any of it.
    for (const width of [1010, 1100, 1300]) {
      presented = presentedFrameGeometry(presented, at(width, 0.8), false)
      expect(presented).toEqual(at(1000, 1))
    }
    // Shown again, one resize to the window's current geometry.
    presented = presentedFrameGeometry(presented, at(1300, 0.8), true)
    expect(presented).toEqual(at(1300, 0.8))
  })
})

describe('display fit', () => {
  test('Fit never takes the 12 px operational text below 11 px', () => {
    expect(FIT_MIN_ZOOM).toBe(0.917)
    expect(12 * FIT_MIN_ZOOM).toBeGreaterThanOrEqual(11)
  })

  test('advice fits its whole height and narrowest width, up to 200 %, and scrolls below the text floor', () => {
    expect(fitDisplayZoom(advice({ extent: { kind: 'advice', minWidth: 500, width: 500, height: 300 } }), 1)).toBe(2)
    expect(fitDisplayZoom(advice({ extent: { kind: 'advice', minWidth: 1050, width: 1050, height: 300 } }), 1)).toBe(0.952)
    expect(fitDisplayZoom(advice({ extent: { kind: 'advice', minWidth: 1250, width: 1250, height: 300 } }), 1)).toBe(FIT_MIN_ZOOM)
    // Until the frame reports, the published height stands in.
    expect(fitDisplayZoom(advice({ body: { width: 1000, height: 760 } }), 1)).toBe(0.95)
    expect(fitDisplayZoom(advice(), 1)).toBe(FIT_MIN_ZOOM)
    // Rounded down: 734 / 620 fits at 118.3 %, never at 118.4 %.
    expect(fitDisplayZoom(advice({ body: { width: 1256, height: 734 }, extent: { kind: 'advice', minWidth: 660, width: 660, height: 620 } }), 1)).toBe(1.183)
  })

  test('a generated display fits the room it reported needing, is never magnified and scrolls below the text floor', () => {
    const extent = { kind: 'generated' as const, minWidth: 1, width: 1050, height: 600 }
    expect(fitDisplayZoom(generated({ extent }), 1)).toBe(0.952)
    expect(fitDisplayZoom(generated({ extent: { ...extent, width: 500, height: 300 } }), 1)).toBe(1)
    // A unit overview at 1280 x 800 asked about 51 % (about 6 px text) before the floor.
    expect(fitDisplayZoom(generated({ extent: { ...extent, width: 1960, height: 1180 } }), 1)).toBe(FIT_MIN_ZOOM)
    expect(fitDisplayZoom(generated({ extent: { ...extent, width: 5000 } }), 1)).toBe(FIT_MIN_ZOOM)
  })

  test('Fit on a generated display allows one correction after the next report, then stops', () => {
    const first = { kind: 'generated' as const, minWidth: 1, width: 1050, height: 600 }
    let state = reduceDisplayZoom(initialDisplayZoom(generated(), null), { type: 'toggle-fit' }, generated({ extent: first }))
    expect(state).toEqual({ zoom: 0.952, fit: true, auto: false, corrections: 1 })

    // Relaid out for its new size, the display needs more room: one correction.
    state = reduceDisplayZoom(state, { type: 'extent' }, generated({ extent: { ...first, width: 1080 } }))
    expect(state).toEqual({ zoom: 0.925, fit: true, auto: false, corrections: 0 })

    // Further reports never move it again: no oscillation across layouts.
    state = reduceDisplayZoom(state, { type: 'extent' }, generated({ extent: { ...first, width: 4000, height: 1200 } }))
    expect(state.zoom).toBe(0.925)

    // A new body size is a new fit, with its own correction; it keeps the room the display last needed.
    const settled = { ...first, width: 1080, height: 600 }
    state = reduceDisplayZoom(state, { type: 'body' }, generated({ body: { width: 2000, height: 1200 }, extent: settled }))
    expect(state).toEqual({ zoom: 1, fit: true, auto: false, corrections: 1 })
    state = reduceDisplayZoom(state, { type: 'body' }, generated({ body: { width: 1000, height: 600 }, extent: settled }))
    expect(state.zoom).toBe(0.925)
  })

  test('Fit on a generated display drawn whole below 100 % tries 100 %, then corrects once', () => {
    // At 60 % the frame is 1000/0.6 x 600/0.6 and the display needs no more: it may fit larger.
    const whole = { kind: 'generated' as const, minWidth: 1, width: 1667, height: 1000 }
    let state = reduceDisplayZoom(manualAt(0.6), { type: 'toggle-fit' }, generated({ extent: whole }))
    expect(state).toEqual({ zoom: 1, fit: true, auto: false, corrections: 1 })
    // Drawn for 100 %, it needs 1050 x 600: one correction to 95.2 %, then it stays.
    state = reduceDisplayZoom(state, { type: 'extent' }, generated({ extent: { ...whole, width: 1050, height: 600 } }))
    expect(state).toEqual({ zoom: 0.952, fit: true, auto: false, corrections: 0 })
    // Drawn whole at 100 %, it stays there.
    expect(reduceDisplayZoom(manualAt(0.6), { type: 'toggle-fit' }, generated({ extent: whole })).zoom).toBe(1)
    expect(reduceDisplayZoom({ zoom: 1, fit: true, auto: false, corrections: 1 }, { type: 'extent' }, generated({ extent: { ...whole, width: 1000, height: 600 } })).zoom).toBe(1)
  })

  test('Fit settled on a generated display follows window resizes without flip-flopping', () => {
    // Settled at 95.2 %: the display needs 1050 x 600 and the body is 1000 x 600.
    const needed = { kind: 'generated' as const, minWidth: 1, width: 1050, height: 600 }
    let state: DisplayZoomState = { zoom: 0.952, fit: true, auto: false, corrections: 0 }
    const zooms: number[] = []
    for (const width of [1002, 1004, 1006, 1008, 1010]) {
      state = reduceDisplayZoom(state, { type: 'body' }, generated({ body: { width, height: 600 }, extent: needed }))
      zooms.push(state.zoom)
    }
    expect(zooms).toEqual([0.954, 0.956, 0.958, 0.96, 0.961])
  })

  test('advice under Fit refits on every report and body change', () => {
    let state = reduceDisplayZoom(initialDisplayZoom(advice(), null), { type: 'toggle-fit' }, advice())
    expect(state.fit).toBe(true)
    state = reduceDisplayZoom(state, { type: 'extent' }, advice({ extent: { kind: 'advice', minWidth: 400, width: 400, height: 400 } }))
    expect(state.zoom).toBe(1.5)
    state = reduceDisplayZoom(state, { type: 'body' }, advice({ body: { width: 1000, height: 380 }, extent: { kind: 'advice', minWidth: 400, width: 400, height: 400 } }))
    expect(state.zoom).toBe(0.95)
    state = reduceDisplayZoom(state, { type: 'body' }, advice({ body: { width: 1000, height: 300 }, extent: { kind: 'advice', minWidth: 400, width: 400, height: 400 } }))
    expect(state.zoom).toBe(FIT_MIN_ZOOM)
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

  test('advice opens at Fit held to the text floor-100 % and follows its extent until the operator zooms', () => {
    let state = initialDisplayZoom(advice({ body: null }), null)
    expect(state).toEqual({ zoom: 1, fit: false, auto: true, corrections: 1 })
    state = reduceDisplayZoom(state, { type: 'body' }, advice())
    expect(state.zoom).toBe(FIT_MIN_ZOOM)
    state = reduceDisplayZoom(state, { type: 'extent' }, advice({ extent: { kind: 'advice', minWidth: 400, width: 400, height: 300 } }))
    expect(state.zoom).toBe(1)
    expect(storedDisplayZoom(state)).toBeNull()
    // Its correction spent, a report may only shrink it: a caption that re-wraps with the zoom cannot make it oscillate.
    state = reduceDisplayZoom(state, { type: 'extent' }, advice({ extent: { kind: 'advice', minWidth: 400, width: 400, height: 620 } }))
    expect(state.zoom).toBe(0.967)
    state = reduceDisplayZoom(state, { type: 'extent' }, advice({ extent: { kind: 'advice', minWidth: 400, width: 400, height: 300 } }))
    expect(state.zoom).toBe(0.967)

    state = reduceDisplayZoom(state, { type: 'step', step: 'out' }, advice())
    expect(state.auto).toBe(false)
    state = reduceDisplayZoom(state, { type: 'extent' }, advice({ extent: { kind: 'advice', minWidth: 400, width: 400, height: 2000 } }))
    expect(state.zoom).toBe(0.9)
    expect(storedDisplayZoom(state)).toEqual({ zoom: 0.9 })
  })

  test('a remembered zoom wins over the default; Fit is never remembered', () => {
    expect(initialDisplayZoom(advice(), { zoom: 1.5 }).zoom).toBe(1.5)
    expect(initialDisplayZoom(generated(), { zoom: 0.75 })).toEqual({ zoom: 0.75, fit: false, auto: false, corrections: 0 })
    // A fitted zoom belongs to the window it was fitted in: choosing Fit forgets the remembered zoom.
    const fittedState = reduceDisplayZoom(manualAt(0.75), { type: 'toggle-fit' }, generated({ extent: { kind: 'generated', minWidth: 1, width: 1050, height: 600 } }))
    expect(fittedState.fit).toBe(true)
    expect(storedDisplayZoom(fittedState)).toBeNull()
  })
})

describe('display zoom storage', () => {
  test('remembers overview zoom per Run and Plant in a bounded list', () => {
    const storage = createMemoryStorage()
    const store = createDisplayZoomStore({ storageKey: 'zoom-test', limit: 2, storage })
    store.write(overviewZoomKey('run-1', 'unit-a'), { zoom: 1.25 })
    store.write(overviewZoomKey('run-1', 'unit-b'), { zoom: 0.75 })
    store.write(overviewZoomKey('run-1', 'unit-a'), { zoom: 1.5 })
    store.write(overviewZoomKey('run-1', 'unit-c'), { zoom: 2 })

    expect(store.read('run-1:unit-a')).toEqual({ zoom: 1.5 })
    expect(store.read('run-1:unit-b')).toBeNull()
    expect(store.read('run-1:unit-c')).toEqual({ zoom: 2 })
    store.forget('run-1:unit-a')
    expect(store.read('run-1:unit-a')).toBeNull()
    expect(store.read('run-1:unit-c')).toEqual({ zoom: 2 })
  })

  test('overview zoom goes to the given local storage and answer zoom to the session storage', () => {
    const local = createMemoryStorage()
    const session = createMemoryStorage()
    overviewZoomStore(local).write('run-1:unit-a', { zoom: 1.1 })
    answerZoomStore(session).write('room/turn/call/key', { zoom: 0.9 })
    expect([...local.values.keys()]).toEqual(['leitbild.processDisplayZoom.v2'])
    expect([...session.values.keys()]).toEqual(['leitbild.processDisplayAnswerZoom.v2'])
  })

  test('rejects unreadable storage visibly instead of overwriting it', () => {
    const storage = createMemoryStorage()
    const store = createDisplayZoomStore({ storageKey: 'zoom-test', limit: 10, storage })
    storage.setItem('zoom-test', '[["run-1:unit-a",{"zoom":9}]]')
    expect(() => store.read('run-1:unit-a')).toThrow('out of range')
    expect(() => store.write('run-1:unit-b', { zoom: 1 })).toThrow('out of range')
    storage.setItem('zoom-test', '[["run-1:unit-a",{"zoom":0.51,"fit":true}]]')
    expect(() => store.read('run-1:unit-a')).toThrow('unknown fields: fit')
    storage.setItem('zoom-test', 'not json')
    expect(() => store.read('run-1:unit-a')).toThrow('invalid JSON')
  })
})
