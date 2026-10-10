import { describe, expect, test } from 'bun:test'
import { parseDisplayFrameMessage, type DisplayFrameMessage } from '../src/ui/embed/display-frame-protocol.ts'
import { ADVICE_MIN_WIDTH, adviceExtent, generatedExtent } from '../src/ui/embed/display-extent.ts'
import {
  createViewHost,
  createZoomAccumulator,
  followPresentation,
  trackVisibility,
  wheelZoomFactor,
  zoomStepOfKey,
  type DisplayPresentation,
  type ReceivedMessage,
} from '../src/ui/embed/view-host.ts'

const origin = 'https://leitbild.test'

const framedPage = () => {
  const posted: Array<{ readonly message: DisplayFrameMessage; readonly targetOrigin: string }> = []
  const refused: unknown[] = []
  const parent = { postMessage: (message: DisplayFrameMessage, targetOrigin: string) => { posted.push({ message, targetOrigin }) } }
  let receive: ((message: ReceivedMessage) => void) | null = null
  const host = createViewHost({
    parent,
    origin,
    listen: next => {
      receive = next
      return () => { receive = null }
    },
    refused: data => { refused.push(data) },
  })
  const deliver = (message: ReceivedMessage): void => {
    if (receive === null) throw new Error('the view host is not listening')
    receive(message)
  }
  const fromWindow = (data: unknown): void => deliver({ origin, source: parent, data })
  return { host, parent, posted, refused, deliver, fromWindow, listening: () => receive !== null }
}

describe('a view framed by the display window', () => {
  test('says it is listening, then follows the presentation its window sends', () => {
    const page = framedPage()
    const seen: DisplayPresentation[] = []
    page.host.subscribe(presentation => { seen.push(presentation) })
    expect(page.host.framed).toBe(true)
    expect(page.posted).toEqual([])

    const stop = page.host.listen()
    expect(page.posted).toEqual([{ message: { type: 'world:display-frame-ready' }, targetOrigin: origin }])

    page.fromWindow({ type: 'world:display-frame', shown: false, zoom: 1.5 })
    expect(page.host.current()).toEqual({ shown: false, zoom: 1.5 })
    // The same presentation again changes nothing.
    page.fromWindow({ type: 'world:display-frame', shown: false, zoom: 1.5 })
    page.fromWindow({ type: 'world:display-frame', shown: true, zoom: 1.5 })
    expect(seen).toEqual([{ shown: true, zoom: 1 }, { shown: false, zoom: 1.5 }, { shown: true, zoom: 1.5 }])

    stop()
    expect(page.listening()).toBe(false)
  })

  test('takes its presentation only from its own window on its own origin, and says when that window sends something unreadable', () => {
    const page = framedPage()
    page.host.listen()
    page.deliver({ origin: 'https://elsewhere.test', source: page.parent, data: { type: 'world:display-frame', shown: false, zoom: 2 } })
    page.deliver({ origin, source: {}, data: { type: 'world:display-frame', shown: false, zoom: 2 } })
    expect(page.host.current()).toEqual({ shown: true, zoom: 1 })
    expect(page.refused).toEqual([])

    // Outside the zoom range, or with a field the protocol does not have.
    page.fromWindow({ type: 'world:display-frame', shown: true, zoom: 4 })
    page.fromWindow({ type: 'world:display-frame', shown: true, zoom: 1, extra: true })
    expect(page.host.current()).toEqual({ shown: true, zoom: 1 })
    expect(page.refused).toHaveLength(2)
  })

  // A window presents its frame on the frame's ready message.
  const presented = () => {
    const page = framedPage()
    page.host.listen()
    page.fromWindow({ type: 'world:display-frame', shown: true, zoom: 1 })
    page.posted.length = 0
    return page
  }

  test('reports the room its content needs only when it changes', () => {
    const page = presented()
    const extent = { kind: 'advice', minWidth: 640, width: 900, height: 512 } as const
    page.host.reportExtent(extent)
    page.host.reportExtent({ ...extent })
    page.host.reportExtent({ ...extent, height: 530 })
    expect(page.posted.map(post => post.message)).toEqual([
      { type: 'world:display-extent', ...extent },
      { type: 'world:display-extent', ...extent, height: 530 },
    ])
  })

  test('sends zoom gestures as messages the window reads', () => {
    const page = presented()
    page.host.requestZoom({ step: 'in' })
    page.host.requestZoom({ step: 'reset' })
    page.host.requestZoom({ factor: 0.9 })
    page.host.reportExtent(generatedExtent({ width: 1200, height: 700 }, []))
    for (const { message, targetOrigin } of page.posted) {
      expect(targetOrigin).toBe(origin)
      expect(parseDisplayFrameMessage(JSON.parse(JSON.stringify(message)))).toEqual(message)
    }
    expect(page.posted.map(post => post.message)).toEqual([
      { type: 'world:display-zoom', step: 'in' },
      { type: 'world:display-zoom', step: 'reset' },
      { type: 'world:display-zoom', factor: 0.9 },
      { type: 'world:display-extent', kind: 'generated', minWidth: 1200, width: 1200, height: 700 },
    ])
  })

  test('a frame no window presents (a chat answer\'s inline display) says only that it listens', () => {
    const page = framedPage()
    let started = 0
    page.host.whenPresented(() => { started += 1 })
    page.host.listen()
    page.host.requestZoom({ step: 'in' })
    page.host.reportExtent({ kind: 'advice', minWidth: 640, width: 900, height: 512 })
    expect(page.posted.map(post => post.message)).toEqual([{ type: 'world:display-frame-ready' }])
    expect(started).toBe(0)
    page.fromWindow({ type: 'world:display-frame', shown: true, zoom: 1 })
    page.fromWindow({ type: 'world:display-frame', shown: true, zoom: 1.5 })
    expect(started).toBe(1)
    page.host.whenPresented(() => { started += 1 })
    expect(started).toBe(2)
  })
})

test('a view of its own is shown at 1:1 and sends nothing', () => {
  let listened = false
  const host = createViewHost({ parent: null, origin, listen: () => { listened = true; return () => {} }, refused: () => {} })
  const seen: DisplayPresentation[] = []
  host.subscribe(presentation => { seen.push(presentation) })
  host.listen()()
  host.reportExtent({ kind: 'advice', minWidth: 360, width: 400, height: 300 })
  expect(host.framed).toBe(false)
  expect(listened).toBe(false)
  expect(seen).toEqual([{ shown: true, zoom: 1 }])
})

describe('zoom gestures inside a framed view', () => {
  const key = (value: string, modifiers: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}) =>
    zoomStepOfKey({ key: value, ctrlKey: modifiers.ctrlKey ?? false, metaKey: modifiers.metaKey ?? false, altKey: modifiers.altKey ?? false })

  test('the browser zoom keys step the display zoom', () => {
    expect(key('=', { ctrlKey: true })).toBe('in')
    expect(key('+', { metaKey: true })).toBe('in')
    expect(key('-', { ctrlKey: true })).toBe('out')
    expect(key('0', { metaKey: true })).toBe('reset')
    // Without Ctrl or Cmd, with Alt (AltGr), or another key: not a zoom.
    expect(key('=')).toBeNull()
    expect(key('-', { ctrlKey: true, altKey: true })).toBeNull()
    expect(key('1', { ctrlKey: true })).toBeNull()
  })

  test('a pinch follows the fingers and a wheel notch is held to about one zoom step', () => {
    expect(wheelZoomFactor({ deltaY: 0, deltaMode: 0 })).toBe(1)
    expect(wheelZoomFactor({ deltaY: -5, deltaMode: 0 })).toBeCloseTo(Math.exp(0.05), 10)
    expect(wheelZoomFactor({ deltaY: 5, deltaMode: 0 })).toBeCloseTo(Math.exp(-0.05), 10)
    expect(wheelZoomFactor({ deltaY: -100, deltaMode: 0 })).toBe(1.25)
    expect(wheelZoomFactor({ deltaY: 100, deltaMode: 0 })).toBe(0.8)
    // Lines and pages (a mouse wheel in Firefox) count as their pixels.
    expect(wheelZoomFactor({ deltaY: 3, deltaMode: 1 })).toBe(0.8)
    expect(wheelZoomFactor({ deltaY: -0.01, deltaMode: 2 })).toBeCloseTo(Math.exp(0.08), 10)
  })

  test('the gestures of one frame become one request', () => {
    const requests: number[] = []
    const frames: Array<() => void> = []
    const zoomBy = createZoomAccumulator({ request: factor => { requests.push(factor) }, nextFrame: flush => { frames.push(flush) } })
    zoomBy(1.1)
    zoomBy(1.1)
    zoomBy(0.95)
    expect(frames).toHaveLength(1)
    frames.shift()!()
    expect(requests).toHaveLength(1)
    expect(requests[0]).toBeCloseTo(1.1 * 1.1 * 0.95, 10)
    // Gestures that cancel out within a frame request nothing.
    zoomBy(1.25)
    zoomBy(0.8)
    frames.shift()!()
    expect(requests).toHaveLength(1)
  })
})

describe('a framed view samples only while it can be seen', () => {
  const setup = () => {
    const page = framedPage()
    page.host.listen()
    let tabVisible = true
    let tabChanged: (() => void) | null = null
    const calls: boolean[] = []
    const stop = trackVisibility({
      host: page.host,
      documentVisible: () => tabVisible,
      onDocumentVisibility: changed => {
        tabChanged = changed
        return () => { tabChanged = null }
      },
      setVisible: visible => { calls.push(visible) },
    })
    const tab = (visible: boolean): void => {
      tabVisible = visible
      tabChanged?.()
    }
    return { page, calls, tab, stop, tracking: () => tabChanged !== null }
  }

  test('shown by its window in a visible tab', () => {
    const { page, calls, tab, stop, tracking } = setup()
    expect(calls).toEqual([true])
    page.fromWindow({ type: 'world:display-frame', shown: false, zoom: 1 })
    expect(calls).toEqual([true, false])
    // A zoom change while hidden is not a visibility change.
    page.fromWindow({ type: 'world:display-frame', shown: false, zoom: 1.25 })
    page.fromWindow({ type: 'world:display-frame', shown: true, zoom: 1.25 })
    expect(calls).toEqual([true, false, true])
    tab(false)
    expect(calls).toEqual([true, false, true, false])
    // Shown again while its tab is hidden, it stays paused until the tab is visible.
    page.fromWindow({ type: 'world:display-frame', shown: false, zoom: 1.25 })
    page.fromWindow({ type: 'world:display-frame', shown: true, zoom: 1.25 })
    expect(calls).toEqual([true, false, true, false])
    tab(true)
    expect(calls).toEqual([true, false, true, false, true])
    stop()
    expect(tracking()).toBe(false)
    page.fromWindow({ type: 'world:display-frame', shown: false, zoom: 1.25 })
    expect(calls).toEqual([true, false, true, false, true])
  })
})

test('stepping to a view or zooming it in its window counts as the operator attending to it', () => {
  const page = framedPage()
  page.host.listen()
  let presented = 0
  const stop = followPresentation({ host: page.host, presented: () => { presented += 1 } })
  // Subscribing and the first presentation of a view already shown are not acts of the operator.
  page.fromWindow({ type: 'world:display-frame', shown: true, zoom: 1 })
  expect(presented).toBe(0)
  page.fromWindow({ type: 'world:display-frame', shown: true, zoom: 1.25 })
  expect(presented).toBe(1)
  page.fromWindow({ type: 'world:display-frame', shown: false, zoom: 1.25 })
  page.fromWindow({ type: 'world:display-frame', shown: false, zoom: 1.5 })
  expect(presented).toBe(1)
  page.fromWindow({ type: 'world:display-frame', shown: true, zoom: 1.5 })
  expect(presented).toBe(2)
  stop()
  page.fromWindow({ type: 'world:display-frame', shown: true, zoom: 2 })
  expect(presented).toBe(2)
})

describe('the room an embedded display needs', () => {
  test('advice is as tall as its content and no narrower than its drawing with the card padding', () => {
    expect(adviceExtent({ width: 900.4, height: 611.2, widestDrawing: 720, padding: 20 })).toEqual({ kind: 'advice', minWidth: 740, width: 901, height: 612 })
    // Without a drawing, or with a small one, the floor applies.
    expect(adviceExtent({ width: 500, height: 400, widestDrawing: 0, padding: 20 }).minWidth).toBe(ADVICE_MIN_WIDTH)
    expect(adviceExtent({ width: 500, height: 400, widestDrawing: 200, padding: 20 }).minWidth).toBe(ADVICE_MIN_WIDTH)
  })

  test('a generated display needs its frame plus the largest overflow of its scrollers', () => {
    const fits = { scrollWidth: 1180, clientWidth: 1180, scrollHeight: 640, clientHeight: 640 }
    expect(generatedExtent({ width: 1200, height: 700 }, [fits])).toEqual({ kind: 'generated', minWidth: 1200, width: 1200, height: 700 })
    const stacked = { scrollWidth: 1180, clientWidth: 1180, scrollHeight: 980, clientHeight: 640 }
    const wideDrawing = { scrollWidth: 1500, clientWidth: 1180, scrollHeight: 400, clientHeight: 400 }
    expect(generatedExtent({ width: 1200, height: 700 }, [stacked, wideDrawing])).toEqual({ kind: 'generated', minWidth: 1520, width: 1520, height: 1040 })
  })
})
