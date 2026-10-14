import { describe, expect, test } from 'bun:test'
import {
  readRunAssistantOffer,
  requestRunAssistant,
  runAssistantOpenMessage,
} from '../src/ui/run-assistant-messages.ts'

const workspaceId = '1e828b43-37fc-4437-aa70-302d7f442ceb'
const parent = { name: 'host' }
const expected = { origin: 'https://leitbild.test', parent }
const run = { workspaceId, simulationRunId: 'run-1' }

const fromHost = (data: unknown) => ({ origin: expected.origin, source: parent, data })

describe('Run Assistant messages', () => {
  test('reads the Host\'s offer from the Host only', () => {
    expect(readRunAssistantOffer(fromHost({ type: 'leitbild:run-assistant-offer', available: true }), expected)).toEqual({ kind: 'offer', available: true })
    expect(readRunAssistantOffer(fromHost({ type: 'leitbild:run-assistant-offer', available: false }), expected)).toEqual({ kind: 'offer', available: false })
    expect(readRunAssistantOffer({ ...fromHost({ type: 'leitbild:run-assistant-offer', available: true }), origin: 'https://elsewhere.test' }, expected)).toBeNull()
    expect(readRunAssistantOffer({ ...fromHost({ type: 'leitbild:run-assistant-offer', available: true }), source: { name: 'agents frame' } }, expected)).toBeNull()
    expect(readRunAssistantOffer(fromHost({ type: 'leitbild:views', views: [] }), expected)).toBeNull()
    expect(readRunAssistantOffer(fromHost('leitbild:run-assistant-offer'), expected)).toBeNull()
  })

  test('refuses an invalid offer, saying why', () => {
    expect(readRunAssistantOffer(fromHost({ type: 'leitbild:run-assistant-offer' }), expected))
      .toMatchObject({ kind: 'rejected', reason: expect.stringContaining('Assistant offer is invalid: available') })
    expect(readRunAssistantOffer(fromHost({ type: 'leitbild:run-assistant-offer', available: true, open: true }), expected))
      .toEqual({ kind: 'rejected', reason: 'Assistant offer is invalid: Unrecognized key: "open"' })
  })

  test('asks the Host, at its origin, for this page\'s Run', () => {
    const posted: Array<{ readonly message: unknown; readonly origin: string }> = []
    requestRunAssistant(run, { parent: { postMessage: (message, origin) => { posted.push({ message, origin }) } }, origin: expected.origin })
    expect(posted).toEqual([{
      message: { type: 'leitbild:run-assistant-open', run: { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-1' } },
      origin: expected.origin,
    }])
  })

  test('never asks for a Run it cannot name', () => {
    expect(() => runAssistantOpenMessage({ workspaceId: 'not-a-workspace', simulationRunId: 'run-1' })).toThrow()
    expect(() => runAssistantOpenMessage({ workspaceId, simulationRunId: '' })).toThrow()
  })
})
