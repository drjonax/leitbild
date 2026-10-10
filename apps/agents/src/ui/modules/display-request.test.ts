import { describe, expect, test } from 'bun:test'
import { displayReplyCaption, offersDisplayRequest, refusalMessage } from './display-request.ts'
import type { UIMessage } from './render/render-types.ts'

const answer: UIMessage = {
  id: 'answer-1',
  senderId: 'agent-1',
  content: 'The feed pump runs at 82 % load.',
  timestamp: 1,
  type: 'chat',
  roomId: 'room-1',
  generationTraceId: 'turn-1',
}
const ai = { kind: 'ai' }

describe('offersDisplayRequest', () => {
  test('offers the request under an AI answer without a live display', () => {
    expect(offersDisplayRequest(answer, ai)).toBe(true)
    expect(offersDisplayRequest({ ...answer, cause: { kind: 'script', name: 'Drill', step: 0 } }, ai)).toBe(true)
  })

  test('never offers it on human, unknown-sender, error, pass or untraced messages', () => {
    expect(offersDisplayRequest(answer, { kind: 'human' })).toBe(false)
    expect(offersDisplayRequest(answer, undefined)).toBe(false)
    expect(offersDisplayRequest({ ...answer, type: 'error' }, ai)).toBe(false)
    expect(offersDisplayRequest({ ...answer, type: 'pass' }, ai)).toBe(false)
    const { generationTraceId: _turn, ...untraced } = answer
    expect(offersDisplayRequest(untraced, ai)).toBe(false)
    const { roomId: _room, ...roomless } = answer
    expect(offersDisplayRequest(roomless, ai)).toBe(false)
  })

  test('never offers it on an answer that shows a display or on a display-request reply', () => {
    expect(offersDisplayRequest({ ...answer, content: 'Here it is:\n```leitbild-view\n{"view":"plant"}\n```' }, ai)).toBe(false)
    expect(offersDisplayRequest({ ...answer, cause: { kind: 'display-request', name: 'Hilde' }, inReplyTo: ['answer-0'] }, ai)).toBe(false)
  })

  test('an unclosed view fence is not a display', () => {
    expect(offersDisplayRequest({ ...answer, content: 'Use a ```leitbild-view fence to show it.' }, ai)).toBe(true)
  })
})

describe('displayReplyCaption', () => {
  test('names the requester and the time of the answer it shows', () => {
    const at = new Date(2026, 9, 10, 14, 5, 9).getTime()
    expect(displayReplyCaption('Hilde', at)).toBe('Display requested by Hilde for the answer at 14:05:09')
  })

  test('refers to an earlier answer when that answer is not shown', () => {
    expect(displayReplyCaption('Hilde', undefined)).toBe('Display requested by Hilde for an earlier answer')
  })
})

describe('refusalMessage', () => {
  test('tells the reader the rule a refusal names', () => {
    const body = JSON.stringify({ error: 'Ada is running a script; ask again when it ends.', code: 'script_running' })
    expect(refusalMessage(409, body)).toEqual({ text: 'Ada is running a script; ask again when it ends.', expected: true })
  })

  test('reports any other failure by its status', () => {
    expect(refusalMessage(502, '<html>Bad gateway</html>')).toEqual({ text: 'Display request failed (HTTP 502)', expected: false })
    expect(refusalMessage(500, '{"message":"boom"}')).toEqual({ text: 'Display request failed (HTTP 500)', expected: false })
    expect(refusalMessage(500, 'null')).toEqual({ text: 'Display request failed (HTTP 500)', expected: false })
  })
})
