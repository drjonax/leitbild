import { describe, expect, test } from 'bun:test'
import { embeddedViewOpenMessageSchema, newWorkspaceId, type EmbeddedViewOpenMessage } from '@leitbild/contracts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SimulationRunId } from '../src/core/model/index.ts'
import { defaultDisplayEnvelope } from '../src/ui/process-display/default-display.ts'
import type { DisplayFrameMessage } from '../src/ui/embed/display-frame-protocol.ts'
import { createViewHost, type ReceivedMessage } from '../src/ui/embed/view-host.ts'
import { elementOffer, elementParts, openElementDefault, POPOVER_MARGIN, popoverPlacement, popoverRoom, POPOVER_WIDTH } from '../src/ui/embed/vignette/popover.ts'

// An element's pop-over operates the element only where a display window
// presents its display. In a chat answer or a procedure tag's dialog it
// offers the way there in one press: the element's default opened in the
// Workspace's window through the page that frames it. Both pages announce
// themselves with the contract's view-host message, and both receive the same
// view-open message. In a frame no page hosts, it shows the default alone.

const origin = 'https://leitbild.test'
const workspaceId = newWorkspaceId()
const runId = 'run-1' as SimulationRunId

const framed = () => {
  const posted: Array<DisplayFrameMessage | EmbeddedViewOpenMessage> = []
  const parent = { postMessage: (message: DisplayFrameMessage | EmbeddedViewOpenMessage) => { posted.push(message) } }
  let receive: ((message: ReceivedMessage) => void) | null = null
  const host = createViewHost({ parent, origin, listen: next => { receive = next; return () => { receive = null } }, refused: () => {} })
  let opening: Parameters<typeof elementOffer>[0] = null
  host.subscribeOpening(where => { opening = where })
  host.listen()
  posted.length = 0
  return { host, posted, offer: () => elementOffer(opening), fromParent: (data: unknown) => receive!({ origin, source: parent, data }) }
}

const valve = defaultDisplayEnvelope({ workspaceId, simulationRunId: runId, view: { viewType: 'display.vignette', title: 'PORV 1', height: 420, state: '{"subjects":["plant:a#porv1"]}' } })
const from = { key: '{"subjects":["plant:a"]}', title: 'Pressurizer' }

describe('an element\'s pop-over by where its display is shown', () => {
  test('in the display window it offers the element\'s Pack actions', () => {
    const page = framed()
    page.fromParent({ type: 'world:display-frame', shown: true, zoom: 1 })
    expect(page.offer()).toBe('actions')
  })

  test('in a chat answer it offers no actions: "Open in the display window" opens the element\'s default there, captioned with the display it came from', () => {
    const page = framed()
    page.fromParent({ type: 'leitbild:view-host' })
    expect(page.offer()).toBe('open-in-window')
    expect(openElementDefault(page.host, from, valve)).toBe(true)
    expect(page.posted).toHaveLength(1)
    const message = embeddedViewOpenMessageSchema.parse(page.posted[0])
    expect(message.view.envelope).toEqual(valve)
    expect(message.view.caption).toBe('From Pressurizer')
    // The same element opened again from the same display is the same listing; from another display, another.
    openElementDefault(page.host, from, valve)
    openElementDefault(page.host, { ...from, key: '{"subjects":["plant:b"]}' }, valve)
    const keys = page.posted.map(posted => embeddedViewOpenMessageSchema.parse(posted).view.key)
    expect(keys[1]).toBe(keys[0]!)
    expect(keys[2]).not.toBe(keys[0]!)
  })

  test('in a procedure tag\'s dialog, whose page opens the display window itself, the same button posts the same open request to that page', () => {
    // The dialog (ProcedureTagDisplay.svelte) answers the frame's ready message with view-host, never with a presentation.
    const page = framed()
    page.fromParent({ type: 'leitbild:view-host' })
    expect(page.offer()).toBe('open-in-window')
    const tag = { key: '{"subjects":["plant:a#pressurizer"]}', title: 'Halden Unit 1 · Pressurizer' }
    expect(openElementDefault(page.host, tag, valve)).toBe(true)
    const message = embeddedViewOpenMessageSchema.parse(page.posted[0])
    expect(message).toEqual({ type: 'leitbild:view-open', view: { key: expect.stringMatching(/^opened:[0-9a-f]{8}$/), caption: 'From Halden Unit 1 · Pressurizer', envelope: valve } })
  })

  test('in a frame no page hosts, it shows the default alone and opens nothing', () => {
    const page = framed()
    expect(page.offer()).toBe('nothing')
    expect(openElementDefault(page.host, from, valve)).toBe(false)
    expect(page.posted).toEqual([])
  })

  test('the pop-over loads its Pack\'s actions only under the display window\'s offer', () => {
    const source = readFileSync(join(import.meta.dir, '../src/ui/embed/vignette/ElementPopover.svelte'), 'utf8')
    expect(source.match(/loadEmbedPack\(/g)).toHaveLength(1)
    const guard = source.indexOf('if (elementOffer(where) !== \'actions\' || actionsAsked) return')
    expect(guard).toBeGreaterThan(0)
    expect(source.indexOf('loadEmbedPack(packId)')).toBeGreaterThan(guard)
    expect(source).toContain('{#each elementParts(offer) as part (part)}')
  })

  test('in the display window its actions come first, a pending proposal\'s Approve with them, the default under them; elsewhere the default first', () => {
    expect(elementParts('actions')).toEqual(['actions', 'default'])
    expect(elementParts('open-in-window')).toEqual(['default', 'open-in-window'])
    expect(elementParts('nothing')).toEqual(['default', 'nothing'])
  })
})

describe('an element\'s pop-over on screen', () => {
  // E2b: a valve's pop-over in the window was about 2,000 px tall in an 816 px embed (1440×900), Approve at y ≈ 1,014.
  const embed = { width: 1440, height: 816 }
  const tall = 2_000
  const onScreen = (place: { x: number; y: number }, size: { width: number; height: number }, page: { width: number; height: number }, scale: number) =>
    place.x >= POPOVER_MARGIN / scale - 1e-9 && place.y >= POPOVER_MARGIN / scale - 1e-9
    && place.x + size.width / scale <= page.width - POPOVER_MARGIN / scale + 1e-9 && place.y + size.height / scale <= page.height - POPOVER_MARGIN / scale + 1e-9

  test('it is never taller than the page on screen, less its margins, at any zoom', () => {
    expect(popoverRoom(embed, 1)).toBe(816 - 2 * POPOVER_MARGIN)
    expect(popoverRoom({ height: 636 }, 1)).toBe(636 - 2 * POPOVER_MARGIN)
    // Zoomed in, the page has fewer px but the pop-over is drawn at 1 / zoom: its own px are the screen's.
    expect(popoverRoom(embed, 1.27)).toBeCloseTo(816 * 1.27 - 2 * POPOVER_MARGIN)
  })

  test('held to its room, it stands wholly on screen beside its item near every edge, never over it', () => {
    for (const scale of [0.75, 1, 1.27]) {
      const page = { width: embed.width / scale, height: embed.height / scale }
      const size = { width: POPOVER_WIDTH, height: Math.min(tall, popoverRoom(page, scale)) }
      for (const item of [{ x: 40, y: 700, width: 48, height: 48 }, { x: page.width - 60, y: 20, width: 48, height: 48 }, { x: page.width - 60, y: page.height - 60, width: 48, height: 48 }, { x: page.width / 2, y: page.height / 2, width: 48, height: 48 }]) {
        const place = popoverPlacement(item, size, page, scale)
        expect(onScreen(place, size, page, scale)).toBe(true)
        const covers = place.x < item.x + item.width && place.x + size.width / scale > item.x && place.y < item.y + item.height && place.y + size.height / scale > item.y
        expect(covers).toBe(false)
      }
    }
  })

  test('on a page narrower than it, it keeps its left margin', () => {
    expect(popoverPlacement({ x: 100, y: 100, width: 48, height: 48 }, { width: POPOVER_WIDTH, height: 300 }, { width: 320, height: 600 }, 1).x).toBe(POPOVER_MARGIN)
  })
})
