import { describe, expect, test } from 'bun:test'
import { cardLines, createTurnCards, storedTurnCards } from './answer-cards.ts'
import { createExecutionStore } from '../core/executions/store.ts'
import { roomRoutes } from '../api/routes/rooms.ts'
import type { RouteContext } from '../api/routes/types.ts'

const at = { at: '2026-01-01T10:16:00.000Z', clock: 'simulation' as const }
const card = (labels: ReadonlyArray<string>, extra: { more?: number; adjusted?: ReadonlyArray<{ kind: 'layout'; text: string }> } = {}) => ({
  at, more: extra.more ?? 0, adjusted: [...(extra.adjusted ?? [])],
  items: labels.map((label, index) => ({ key: `k${index + 1}`, label, reading: `${index + 1}.0 %`, numbers: [{ value: index + 1, decimals: 1 }] })),
})
const compose = (key: string, carried: unknown) => ({ key, operationId: 'world.simulation-run.display.compose', success: true, data: { view: {}, card: carried } })

describe('answer cards', () => {
  test('a card reads as T10\'s lines: its time and clock, one line per item, what it leaves out and how it was fitted', () => {
    expect(cardLines(card(['Line A · loading'], { more: 2, adjusted: [{ kind: 'layout', text: '2 alerts not shown' }] }))).toEqual([
      'card at 2026-01-01T10:16:00.000Z (simulation)', 'k1 · Line A · loading · 1.0 %', '+2 more', 'adjusted (layout): 2 alerts not shown',
    ])
  })

  test('a turn re-keys each further card from its last key + 1', () => {
    const cards = createTurnCards()
    expect(cards.add(card(['A', 'B'])).items.map(item => item.key)).toEqual(['k1', 'k2'])
    expect(cards.add(card(['C'])).items.map(item => item.key)).toEqual(['k3'])
    expect(cards.items().map(item => item.label)).toEqual(['A', 'B', 'C'])
  })

  test('the cards route re-keys a turn\'s stored cards in dispatch order, whatever the clock said', async () => {
    const store = createExecutionStore(':memory:')
    store.beginTurn({ id: 'turn-1', roomId: 'room-1', agentId: 'agent', startedAt: 1 })
    // The second round started "earlier" on the wall clock; the turn still read it second.
    store.recordAttempt('turn-1', { id: 'call_1_0', tool: 'workspace_call', arguments: {}, startedAt: 1 })
    store.recordOutcome('turn-1', 'call_1_0', { success: true, data: { results: [compose('reserve', card(['Reserve']))] } })
    store.recordAttempt('turn-1', { id: 'call_0_0', tool: 'workspace_call', arguments: {}, startedAt: 5 })
    store.recordOutcome('turn-1', 'call_0_0', { success: true, data: { results: [
      compose('loading', card(['Line A', 'Line B'])),
      { key: 'refused', operationId: 'world.simulation-run.display.compose', success: false, error: 'unknown_name' },
    ] } })
    store.recordAttempt('turn-1', { id: 'call_0_1', tool: 'conversation_read', arguments: {}, startedAt: 6 })
    store.recordOutcome('turn-1', 'call_0_1', { success: true, data: { card: card(['not a workspace result']) } })
    const calls = store.listCalls('room-1', 'turn-1').map(call => store.getCall('room-1', 'turn-1', call.id)!)
    expect(storedTurnCards(calls).map(({ viewRef, card }) => [viewRef, card.items.map(item => `${item.key} ${item.label}`)])).toEqual([
      ['call_0_0/loading', ['k1 Line A', 'k2 Line B']],
      ['call_1_0/reserve', ['k3 Reserve']],
    ])

    const route = roomRoutes.find(candidate => candidate.pattern.source.endsWith('\\/cards$'))!
    const system = { rooms: { getRoom: (id: string) => id === 'room-1' ? { profile: { id } } : undefined }, executionStore: store }
    const get = async (path: string) => await route.handler(new Request(`http://agents${path}`), path.match(route.pattern)!, { system } as unknown as RouteContext)
    const response = await get('/rooms/room-1/executions/turn-1/cards')
    expect(response.status).toBe(200)
    expect((await response.json() as { cards: ReadonlyArray<{ viewRef: string }> }).cards.map(entry => entry.viewRef)).toEqual(['call_0_0/loading', 'call_1_0/reserve'])
    expect((await get('/rooms/room-1/executions/no-turn/cards')).status).toBe(404)
    expect((await get('/rooms/no-room/executions/turn-1/cards')).status).toBe(404)
    store.close()
  })
})
