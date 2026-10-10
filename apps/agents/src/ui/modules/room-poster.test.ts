import { describe, expect, test } from 'bun:test'
import { resolveRoomPoster } from './room-poster.ts'

const agents = {
  ada: { id: 'ada', kind: 'ai' },
  hilde: { id: 'hilde', kind: 'human' },
  ola: { id: 'ola', kind: 'human' },
}

describe('resolveRoomPoster', () => {
  test('the human chosen for the Room posts', () => {
    expect(resolveRoomPoster('room-1', { 'room-1': 'ola' }, agents, ['ada', 'hilde', 'ola'])).toEqual({ kind: 'chosen', humanId: 'ola' })
  })

  test('without a choice, the Room\'s only human member posts', () => {
    expect(resolveRoomPoster('room-1', { 'room-2': 'ola' }, agents, ['ada', 'hilde'])).toEqual({ kind: 'only-human', humanId: 'hilde' })
  })

  test('the reader chooses when the Room has several humans or none', () => {
    expect(resolveRoomPoster('room-1', {}, agents, ['ada', 'hilde', 'ola'])).toEqual({ kind: 'undecided' })
    expect(resolveRoomPoster('room-1', {}, agents, ['ada'])).toEqual({ kind: 'undecided' })
    // Humans outside the Room do not count.
    expect(resolveRoomPoster('room-1', {}, agents, [])).toEqual({ kind: 'undecided' })
  })
})
