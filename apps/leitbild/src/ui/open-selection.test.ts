import { describe, expect, test } from 'bun:test'
import { moduleQueryOutcomeSchema, type ModuleQueryOutcome } from '@leitbild/contracts'
import { keptSelection } from './open-selection.ts'
import { room, run } from './workspace-page.test-support.ts'

const outcomes = (...values: unknown[]): ModuleQueryOutcome[] => values.map(value => moduleQueryOutcomeSchema.parse(value))
const ready = outcomes({ moduleId: 'world', status: 'ready' }, { moduleId: 'agents', status: 'ready' })
const worldFailed = outcomes(
  { moduleId: 'world', status: 'failed', failure: { code: 'module_unavailable', message: 'World did not answer', retryable: true } },
  { moduleId: 'agents', status: 'ready' },
)
const open = { world: 'a', agents: null, agentsVisible: false }

describe('what stays open after the Resources are read again', () => {
  test('a Run that is still listed stays open', () => {
    expect(keptSelection(open, [run('a', 'Running', '2026-10-12T21:00:00.000Z')], ready)).toEqual(open)
  })

  test('a missing Run closes when every Module answered', () => {
    expect(keptSelection(open, [run('b', 'Running', '2026-10-12T21:00:00.000Z')], ready)).toEqual({ world: null, agents: null, agentsVisible: false })
  })

  test('a Module that failed to answer keeps its Run open', () => {
    expect(keptSelection(open, [], worldFailed)).toEqual(open)
  })

  test('a missing room closes and hides the Agents pane; a failed World does not close it', () => {
    const chatting = { world: null, agents: 'c', agentsVisible: true }
    expect(keptSelection(chatting, [], ready)).toEqual({ world: null, agents: null, agentsVisible: false })
    expect(keptSelection(chatting, [room('c', '2026-10-12T21:30:00.000Z')], worldFailed)).toEqual(chatting)
  })

  test('nothing open stays nothing open', () => {
    const none = { world: null, agents: null, agentsVisible: false }
    expect(keptSelection(none, [], ready)).toEqual(none)
  })
})
