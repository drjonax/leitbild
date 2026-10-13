import { describe, expect, test } from 'bun:test'
import {
  avatarTone, badgeText, chatRows, initials, isDefaultName, messageCounterText, messageSendable, messageText, nameCounterText, nameProblem,
  NAME_TEXT, normaliseName, pillText, previewText, rowLabel, triggerLabel, type ChatItem,
} from './people-format.ts'

const NOW = new Date(2026, 9, 13, 14, 30).getTime()
const MINUTE = 60_000

describe('names', () => {
  test('initials follow the spec examples', () => {
    expect(initials('User12')).toBe('U12')
    expect(initials('Ben (turbine)')).toBe('BT')
    expect(initials('Dora Lindqvist')).toBe('DL')
    expect(initials('ben')).toBe('B')
    expect(initials('User1234')).toBe('U12')
    expect(initials('...')).toBe('?')
  })

  test('normalising collapses whitespace and line breaks; the client checks empty and length only', () => {
    expect(normaliseName('  Ben \n  (turbine)\t')).toBe('Ben (turbine)')
    expect(nameProblem('')).toBe(NAME_TEXT.empty)
    expect(nameProblem('x'.repeat(32))).toBeNull()
    expect(nameProblem('x'.repeat(33))).toBe(NAME_TEXT.tooLong)
    expect(nameCounterText('x'.repeat(25))).toBeNull()
    expect(nameCounterText('x'.repeat(28))).toEqual({ text: '28/32', over: false })
    expect(nameCounterText('x'.repeat(34))).toEqual({ text: '34/32', over: true })
    expect(isDefaultName('User3')).toBe(true)
    expect(isDefaultName('User0')).toBe(false)
    expect(isDefaultName('Anna')).toBe(false)
  })

  test('the avatar tone is stable per id and within the six tones', () => {
    expect(avatarTone('person-ben')).toBe(avatarTone('person-ben'))
    for (const id of ['a', 'person-1', 'person-ffff']) expect(avatarTone(id)).toBeLessThan(6)
  })
})

describe('labels', () => {
  test('the trigger names who is here, the state and the unread count', () => {
    expect(triggerLabel('loading', 0, 0)).toBe('People in this simulation, loading')
    expect(triggerLabel('live', 0, 0)).toBe('People in this simulation: just you')
    expect(triggerLabel('live', 1, 1)).toBe('People in this simulation: you and 1 other, 1 unread message')
    expect(triggerLabel('live', 3, 12)).toBe('People in this simulation: you and 3 others, 12 unread messages')
    expect(triggerLabel('reconnecting', 3, 0)).toBe('People in this simulation, reconnecting')
    expect(triggerLabel('unavailable', 0, 2)).toBe('People in this simulation, unavailable, 2 unread messages')
    expect(badgeText(9)).toBe('9')
    expect(badgeText(10)).toBe('9+')
    expect(pillText(120)).toBe('99+')
    expect(rowLabel('User3', true, 2)).toBe('User3, in this simulation, 2 unread messages')
    expect(rowLabel('Dora', false, 0)).toBe('Dora, not here')
  })

  test('previews are one line of at most 80 characters', () => {
    expect(previewText('Can you\ncheck  it?')).toBe('Can you check it?')
    const long = previewText('x'.repeat(200))
    expect([...long]).toHaveLength(80)
    expect(long.endsWith('…')).toBe(true)
  })

  test('messages: trailing whitespace trimmed, the limit counted in characters, a counter near it', () => {
    expect(messageText('Hello  \n ')).toBe('Hello')
    expect(messageSendable('  \n ')).toBe(false)
    expect(messageSendable('🙂'.repeat(2_000))).toBe(true)
    expect(messageSendable('🙂'.repeat(2_001))).toBe(false)
    expect(messageCounterText('x'.repeat(1_799))).toBeNull()
    expect(messageCounterText('x'.repeat(1_850))).toEqual({ text: '1,850 / 2,000', over: false })
    expect(messageCounterText('x'.repeat(2_012))).toEqual({ text: '12 characters over the limit.', over: true })
    expect(messageCounterText('x'.repeat(2_001))).toEqual({ text: '1 character over the limit.', over: true })
  })
})

describe('chat rows', () => {
  const theirs = (key: string, at: number, text = key): ChatItem => ({ kind: 'message', key, seq: at, mine: false, text, at })
  const mine = (key: string, at: number): ChatItem => ({ kind: 'message', key, seq: at, mine: true, text: key, at })

  test('groups by sender within 3 minutes, separates days and places the New divider', () => {
    const yesterday = NOW - 24 * 60 * MINUTE
    const rows = chatRows([
      theirs('a', yesterday),
      mine('b', NOW - 30 * MINUTE),
      mine('c', NOW - 29 * MINUTE),
      theirs('d', NOW - 12 * MINUTE),
      theirs('e', NOW - 5 * MINUTE),
      theirs('f', NOW - 4 * MINUTE),
      { kind: 'note', key: 'n', oldName: 'Ben', newName: 'Benjamin', at: NOW - 3 * MINUTE },
      { kind: 'outgoing', key: 'g', text: 'g', at: NOW, stage: 'sending', reason: null, note: null },
      { kind: 'outgoing', key: 'h', text: 'h', at: NOW, stage: 'failed', reason: 'couldn’t reach Leitbild.', note: null },
    ], 'e', NOW)
    expect(rows.map(row => row.kind === 'group' ? `${row.mine ? 'mine' : 'theirs'}:${row.bubbles.map(bubble => bubble.key).join('')}` : row.kind === 'day' ? row.label : row.kind))
      .toEqual(['Yesterday', 'theirs:a', 'Today', 'mine:bc', 'theirs:d', 'new', 'theirs:ef', 'note', 'mine:gh'])
  })

  test('a message keeps its group and key when it is delivered, so its node is not rebuilt', () => {
    const before = chatRows([mine('a', NOW - MINUTE), { kind: 'outgoing', key: 'b', text: 'b', at: NOW, stage: 'sending', reason: null, note: null }], null, NOW)
    const after = chatRows([mine('a', NOW - MINUTE), { kind: 'message', key: 'b', seq: 2, mine: true, text: 'b', at: NOW + 400 }], null, NOW)
    const shape = (rows: ReturnType<typeof chatRows>) => rows.map(row => row.kind === 'group' ? `${row.key}:${row.bubbles.map(bubble => bubble.key).join(',')}` : row.key)
    expect(shape(after)).toEqual(shape(before))
    expect(shape(after)).toEqual(['day:a', 'group:a:a,b'])
  })

  test('row keys come from their first item, so appending keeps earlier rows', () => {
    const before = chatRows([theirs('a', NOW - MINUTE)], null, NOW)
    const after = chatRows([theirs('a', NOW - MINUTE), theirs('b', NOW)], null, NOW)
    expect(after.map(row => row.key)).toEqual(before.map(row => row.key))
  })
})
