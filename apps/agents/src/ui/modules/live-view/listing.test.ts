import { describe, expect, test } from 'bun:test'
import { EMBEDDED_VIEW_LISTING_MAX, embeddedViewsMessageSchema, newWorkspaceId } from '@leitbild/contracts'
import type { UIMessage } from '../render/render-types.ts'
import {
  answerCaption,
  findPostedAnswer,
  postedAnswerOf,
  roomViewFences,
  viewFenceBodies,
  viewFenceKey,
  viewFenceOf,
  viewListings,
  VIEW_LISTING_MAX,
  type ResolvedViewFence,
} from './listing.ts'
import type { ViewResolution } from './resolve.ts'

const workspaceId = newWorkspaceId()
const run = { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-1' }
const envelope = (title: string) => ({ viewType: 'process-plant.display', title, height: 340, state: '{"composition":{}}', moduleId: 'world', subject: run }) as never
const at = (hours: number, minutes: number, seconds: number): number => new Date(2026, 9, 10, hours, minutes, seconds).getTime()

const fence = (ref: string): string => `\`\`\`leitbild-view\nview ${ref}\n\`\`\``

let ids = 0
const answer = (turnId: string, content: string, timestamp = at(14, 2, 31)): UIMessage =>
  ({ id: `m${++ids}`, senderId: 'agent', content, timestamp, type: 'chat', roomId: 'room-1', generationTraceId: turnId })

describe('display fences in posted answers', () => {
  test('captions a display with the local 24-hour time of its answer', () => {
    expect(answerCaption(at(14, 2, 31))).toBe('Answer 14:02:31')
    expect(answerCaption(at(0, 5, 9))).toBe('Answer 00:05:09')
    expect(answerCaption(at(23, 59, 59))).toBe('Answer 23:59:59')
  })

  test('keys a display by room, turn and its reference, with the fence key encoded as in the fence', () => {
    const posted = { roomId: 'room-1', turnId: 'tr_1', caption: 'Answer 14:02:31' }
    expect(viewFenceKey(posted, { callId: 'call_2_0', key: 'sg b/level' })).toBe('room-1/tr_1/call_2_0/sg%20b%2Flevel')
    expect(viewFenceOf(posted, ' view call_2_0/sg%20b%2Flevel\n')).toEqual({
      kind: 'fence',
      fence: { key: 'room-1/tr_1/call_2_0/sg%20b%2Flevel', answer: posted, ref: { callId: 'call_2_0', key: 'sg b/level' } },
    })
    expect(viewFenceOf(posted, 'https://evil.example/').kind).toBe('invalid')
  })

  test('only a generated chat message of a room is a posted answer', () => {
    expect(postedAnswerOf(answer('tr_1', 'x'))).toEqual({ roomId: 'room-1', turnId: 'tr_1', caption: 'Answer 14:02:31' })
    expect(postedAnswerOf({ ...answer('tr_1', 'x'), generationTraceId: undefined })).toBeNull()
    expect(postedAnswerOf({ ...answer('tr_1', 'x'), type: 'pass' })).toBeNull()
    expect(postedAnswerOf({ ...answer('tr_1', 'x'), roomId: undefined })).toBeNull()
    expect(findPostedAnswer([answer('tr_1', 'a'), answer('tr_2', 'b', at(9, 0, 0))], 'tr_2')).toMatchObject({ turnId: 'tr_2', caption: 'Answer 09:00:00' })
    expect(findPostedAnswer([answer('tr_1', 'a')], 'tr_9')).toBeNull()
  })

  test('finds the fences the renderer turns into chips, and no others', () => {
    const markdown = [
      'Pressure is rising.',
      fence('call_1_0/display'),
      '- in a list:',
      '',
      '  ```leitbild-view trailing words',
      '  view call_2_0/a',
      '  ```',
      '',
      '> ~~~leitbild-view',
      '> view call_3_0/b',
      '> ~~~',
      '',
      '```mermaid\ngraph TD\n```',
      '',
      '    ```leitbild-view',
      '    indented code, not a fence',
      '    ```',
    ].join('\n')
    expect(viewFenceBodies(markdown)).toEqual(['view call_1_0/display', 'view call_2_0/a', 'view call_3_0/b'])
    expect(viewFenceBodies('No display here.')).toEqual([])
  })
})

describe('the list of a room\'s displays', () => {
  test('follows the store order and lists a repeated display once', () => {
    const messages: UIMessage[] = [
      answer('tr_1', `First.\n\n${fence('call_1_0/a')}\n\n${fence('call_1_0/a')}`),
      { ...answer('tr_x', fence('call_9_0/human')), generationTraceId: undefined },
      answer('tr_2', `${fence('call_1_0/b')}\n\n${fence('not a reference')}\n\n${fence('call_2_0/c')}`, at(14, 5, 12)),
    ]
    const fences = roomViewFences(messages)
    expect(fences.map(item => item.key)).toEqual(['room-1/tr_1/call_1_0/a', 'room-1/tr_2/call_1_0/b', 'room-1/tr_2/call_2_0/c'])
    expect(fences.map(item => item.answer.caption)).toEqual(['Answer 14:02:31', 'Answer 14:05:12', 'Answer 14:05:12'])
  })

  test('leaves refused displays out and keeps the most recent, oldest first', () => {
    const messages = Array.from({ length: VIEW_LISTING_MAX + 5 }, (_, index) => answer(`tr_${index}`, fence(`call_1_0/d${index}`), at(10, 0, index)))
    const resolved: ResolvedViewFence[] = roomViewFences(messages).map((item, index) => ({
      fence: item,
      resolution: (index === VIEW_LISTING_MAX + 4
        ? { kind: 'refused', code: 'view_evidence_unavailable', message: 'gone' }
        : { kind: 'view', envelope: envelope(`Display ${index}`) }) as ViewResolution,
    }))
    const listings = viewListings(resolved)
    expect(listings).toHaveLength(VIEW_LISTING_MAX)
    expect(listings[0]).toMatchObject({ key: 'room-1/tr_4/call_1_0/d4', caption: 'Answer 10:00:04', envelope: { title: 'Display 4' } })
    expect(listings.at(-1)).toMatchObject({ key: 'room-1/tr_33/call_1_0/d33', caption: 'Answer 10:00:33' })
    expect(embeddedViewsMessageSchema.parse({ type: 'leitbild:views', views: listings }).views).toHaveLength(VIEW_LISTING_MAX)
  })

  test('caps the list where the contract does', () => {
    expect(VIEW_LISTING_MAX).toBe(EMBEDDED_VIEW_LISTING_MAX)
  })
})
