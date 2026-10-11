import { describe, expect, test } from 'bun:test'
import {
  beginAction,
  commandFeedbackText,
  completeAction,
  emptyCommandFeedback,
  failAction,
  noteAction,
  settleCommand,
} from '../src/ui/command-feedback.ts'

// The Pack's own refusal reaching a screen's line through the real Run is
// tested in ambulance-run-races.test.ts; this is any refusal reason.
const refusal = 'Target is out of range; choose a nearer one'

describe('command feedback line', () => {
  test('shows its own command in flight, then the refusal reason verbatim', () => {
    const issued = beginAction(emptyCommandFeedback, 'Assigning Incident 3')
    expect(issued.feedback.line).toMatchObject({ tone: 'pending', subject: 'Assigning Incident 3' })
    expect(commandFeedbackText(issued.feedback.line)).toBe('Assigning Incident 3…')

    const settled = settleCommand(issued.feedback, issued.actionId, { commandId: 'command:own', ok: false, reason: refusal })

    expect(settled.line).toMatchObject({ tone: 'refused', subject: 'Assigning Incident 3', detail: refusal, commandId: 'command:own' })
    expect(settled.line?.detail).toBe(refusal)
    expect(commandFeedbackText(settled.line)).toBe(`Assigning Incident 3 · refused: ${refusal}`)
  })

  test('shows its own accepted command', () => {
    const issued = beginAction(emptyCommandFeedback, 'Deleting Unit 4')
    const settled = settleCommand(issued.feedback, issued.actionId, { commandId: 'command:own', ok: true })

    expect(settled.line).toMatchObject({ tone: 'accepted', subject: 'Deleting Unit 4', commandId: 'command:own' })
    expect(settled.line?.detail).toBeUndefined()
    expect(commandFeedbackText(settled.line)).toBe('Deleting Unit 4 · accepted')
  })

  test('keeps a result until this screen\'s next action, which an earlier reply cannot overwrite', () => {
    const first = beginAction(emptyCommandFeedback, 'Deleting Unit 4')
    const second = beginAction(first.feedback, 'Sending Unit 5 to Incident 2')

    const lateReply = settleCommand(second.feedback, first.actionId, { commandId: 'command:first', ok: false, reason: 'gone' })
    expect(lateReply).toBe(second.feedback)
    expect(failAction(second.feedback, first.actionId, 'network down')).toBe(second.feedback)

    const settled = settleCommand(second.feedback, second.actionId, { commandId: 'command:second', ok: true })
    expect(settled.line).toMatchObject({ subject: 'Sending Unit 5 to Incident 2', tone: 'accepted' })

    const next = noteAction(settled, 'Selected Unit 5; click a valid target')
    expect(next.line).toMatchObject({ tone: 'notice', subject: 'Selected Unit 5; click a valid target' })
    expect(next.line?.commandId).toBeUndefined()
    expect(commandFeedbackText(next.line)).toBe('Selected Unit 5; click a valid target')
  })

  test('reports a failed request with its message and a completed local action', () => {
    const failed = beginAction(emptyCommandFeedback, 'Creating Incident')
    expect(commandFeedbackText(failAction(failed.feedback, failed.actionId, 'capability invocation failed: 502').line))
      .toBe('Creating Incident · failed: capability invocation failed: 502')

    const reset = beginAction(failed.feedback, 'Resetting scenario')
    expect(completeAction(reset.feedback, reset.actionId).line).toMatchObject({ tone: 'accepted', subject: 'Resetting scenario' })
    expect(commandFeedbackText(null)).toBe('')
  })
})
