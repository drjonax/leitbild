/**
 * The World view's feedback line: what this screen last did and what became
 * of it. Several screens can share one Run, and the realtime channel reports
 * every screen's command results, so the line never reads them. It holds only
 * this screen's own actions, each settled by the reply to this screen's own
 * invoke, which carries the Run's result and its commandId. A line stays
 * until this screen's next action replaces it.
 */

/** The Run's result of a command, as the reply to this screen's invoke carries it. */
export type CommandOutcome =
  | { readonly commandId: string; readonly ok: true }
  | { readonly commandId: string; readonly ok: false; readonly reason: string }

export type CommandFeedbackTone = 'notice' | 'pending' | 'accepted' | 'refused' | 'failed'

export interface CommandFeedbackLine {
  readonly actionId: number
  readonly tone: CommandFeedbackTone
  /** The action in this screen's words, e.g. "Deleting Unit 4". */
  readonly subject: string
  /** A refusal reason or failure message, exactly as reported. */
  readonly detail?: string
  /** Known once this screen's own invoke has answered. */
  readonly commandId?: string
}

export interface CommandFeedback {
  readonly nextActionId: number
  readonly line: CommandFeedbackLine | null
}

export interface IssuedCommand {
  readonly feedback: CommandFeedback
  readonly actionId: number
}

export const emptyCommandFeedback: CommandFeedback = { nextActionId: 1, line: null }

const replaceLine = (feedback: CommandFeedback, line: Omit<CommandFeedbackLine, 'actionId'>): IssuedCommand => {
  const actionId = feedback.nextActionId
  return { feedback: { nextActionId: actionId + 1, line: { ...line, actionId } }, actionId }
}

/** A prompt or local outcome of this screen's action, e.g. "Selected Unit 4". */
export const noteAction = (feedback: CommandFeedback, text: string): CommandFeedback =>
  replaceLine(feedback, { tone: 'notice', subject: text }).feedback

/** This screen starts an action whose outcome is still unknown. */
export const beginAction = (feedback: CommandFeedback, subject: string): IssuedCommand =>
  replaceLine(feedback, { tone: 'pending', subject })

const currentLineFor = (feedback: CommandFeedback, actionId: number): CommandFeedbackLine | null =>
  feedback.line?.actionId === actionId ? feedback.line : null

/** The reply to this screen's own invoke. A reply to an action this screen has since replaced changes nothing. */
export const settleCommand = (feedback: CommandFeedback, actionId: number, outcome: CommandOutcome): CommandFeedback => {
  const line = currentLineFor(feedback, actionId)
  if (line === null) return feedback
  const { actionId: id, subject } = line
  return {
    ...feedback,
    line: outcome.ok
      ? { actionId: id, subject, tone: 'accepted', commandId: outcome.commandId }
      : { actionId: id, subject, tone: 'refused', detail: outcome.reason, commandId: outcome.commandId },
  }
}

/** This screen's action completed without a Run command, e.g. a scenario reset. */
export const completeAction = (feedback: CommandFeedback, actionId: number): CommandFeedback => {
  const line = currentLineFor(feedback, actionId)
  return line === null ? feedback : { ...feedback, line: { ...line, tone: 'accepted' } }
}

/** This screen's action failed before the Run answered, e.g. the request did not reach it. */
export const failAction = (feedback: CommandFeedback, actionId: number, message: string): CommandFeedback => {
  const line = currentLineFor(feedback, actionId)
  return line === null ? feedback : { ...feedback, line: { ...line, tone: 'failed', detail: message } }
}

/** The state word shown after the subject; a notice has none. */
export const commandFeedbackStatus = (tone: CommandFeedbackTone): string | null => {
  if (tone === 'pending') return '…'
  if (tone === 'accepted') return 'accepted'
  if (tone === 'refused') return 'refused'
  if (tone === 'failed') return 'failed'
  return null
}

/** The whole line as one sentence, for diagnostics and assistive technology. */
export const commandFeedbackText = (line: CommandFeedbackLine | null): string => {
  if (line === null) return ''
  const status = commandFeedbackStatus(line.tone)
  if (status === null) return line.subject
  if (line.tone === 'pending') return `${line.subject}${status}`
  return line.detail === undefined ? `${line.subject} · ${status}` : `${line.subject} · ${status}: ${line.detail}`
}
