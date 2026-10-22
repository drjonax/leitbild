import { describe, expect, test } from 'bun:test'
import { embeddedViewOpenMessageSchema, newWorkspaceId, type EmbeddedViewOpenMessage } from '@leitbild/contracts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SimulationRunId } from '../src/core/model/index.ts'
import { defaultDisplayEnvelope } from '../src/ui/process-display/default-display.ts'
import type { DisplayFrameMessage } from '../src/ui/embed/display-frame-protocol.ts'
import { createViewHost, type ReceivedMessage } from '../src/ui/embed/view-host.ts'
import { elementOffer, openElementDefault } from '../src/ui/embed/vignette/popover.ts'

// An element's pop-over operates the element only where a display window
// presents its display. In a chat answer it offers the way there: the
// element's default opened in the Workspace's window through the page that
// relays to it. In a procedure tag's dialog, which nothing presents or
// relays, it shows the default alone.

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

  test('in a procedure tag\'s dialog, which no window presents and no page relays, it shows the default alone and opens nothing', () => {
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
    expect(source).toContain('{#if offer === \'actions\'}')
  })
})
