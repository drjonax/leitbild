import { describe, expect, test } from 'bun:test'
import { correctionsIn } from './corrections.ts'

const question = { role: 'user', content: '[NEW] [You]: Unit 2: SG B level looks off. What is going on and what should I watch?' }
const tool = { role: 'tool', content: '{"results":[]}' }
const draft = { role: 'assistant', content: 'draft' }

describe('correction causes from a generation query', () => {
  test('reads each correction Agents appended after the turn\'s question, by its cause and rule', () => {
    const messages = [
      { role: 'user', content: '[You]: an earlier question' }, draft,
      question, { role: 'assistant', content: '' }, tool, draft,
      { role: 'user', content: 'The answer and the display it presents disagree, and the operator reads them together:\n- It says the display leads with TAVG, but it leads with SG-B-LVL-NR: name that.\n- It says "over 10 minutes", but the display\'s time axis spans the last 2.5 min.\n\nRe-emit the FULL corrected response' },
      draft,
      { role: 'user', content: 'Your previous response contained one or more invalid fenced blocks:\n\nThis turn composed a display (viewRef call_4_0/display) but the response does not present it. End the response with the block.\n\nRe-emit the FULL corrected response' },
      draft,
      { role: 'user', content: 'The answer says something happened that did not:\n- "I have throttled AFW valve A"\n\nRe-emit the FULL corrected response' },
      { role: 'user', content: 'The reader asked for a live display, and this response presents none. If you have not composed one yet, compose it now.' },
      { role: 'user', content: 'Something new Agents started writing.' },
    ]
    expect(correctionsIn(messages)).toEqual([
      { cause: 'consistency', detail: ['lead', 'span'] },
      { cause: 'fence', detail: ['view-not-presented'] },
      { cause: 'claim', detail: ['execution-claim'] },
      { cause: 'required-view', detail: [] },
      { cause: 'other', detail: ['Something new Agents started writing.'] },
    ])
  })

  test('a "Show display" turn is read from its display request', () => {
    const requestTurn = { role: 'user', content: '[Display request] You asked you to show your answer below as a live display.' }
    const consistency = { role: 'user', content: 'The answer and the display it presents disagree, and the operator reads them together:\n- It says to watch "a mismatch", which the display does not show.\n\nRe-emit' }
    expect(correctionsIn([question, draft, requestTurn, tool, draft, consistency])).toEqual([{ cause: 'consistency', detail: ['watch'] }])
  })

  test('a turn without corrections has none; a context without its question fails loudly', () => {
    expect(correctionsIn([question, tool, draft])).toEqual([])
    expect(() => correctionsIn([tool, draft])).toThrow('[NEW]')
  })
})
