// The guide's Ask page (plan v2 §4.3): a chip or a typed question opens a
// fresh Assistant conversation through `assistant-handoff.ts`. This module
// holds what the page decides itself: what is sent and titled, the lines under
// the question box, where the browser goes, and the progress shown per step.

import type { Workspace } from '@leitbild/contracts'
import { guideConversationTitle, handoffStatusText, type AssistantHandoffRequest, type AssistantHandoffStep } from './assistant-handoff.ts'
import { QUESTION_MAX_LENGTH, type GuidePrompt } from './guide-content.ts'
import { workspaceLabel } from './launch-workspace.ts'

export type GuideQuestion =
  /** A prompt chip. */
  | { readonly kind: 'suggestion'; readonly prompt: GuidePrompt }
  /** The one-row question box; the last chapter viewed in this modal session, if any. */
  | { readonly kind: 'question'; readonly text: string; readonly lastPageTitle: string | null }

export const EMPTY_QUESTION_TEXT = 'Type a question first'
export const ANSWER_TIME_TEXT = 'Answers usually take up to two minutes. Conversations in a Workspace are public.'

/** The visible error for the question box, or null when it can be sent. */
export const questionError = (text: string): string | null => {
  const trimmed = text.trim()
  if (!trimmed) return EMPTY_QUESTION_TEXT
  if (trimmed.length > QUESTION_MAX_LENGTH) return `Use at most ${QUESTION_MAX_LENGTH} characters`
  return null
}

/**
 * The hand-off request. A chip sends its prompt and names the conversation
 * after its label; a typed question names it after its own first words.
 */
export const guideHandoffRequest = (
  question: GuideQuestion,
  target: { readonly workspaceId: string | null; readonly forceNewWorkspace: boolean },
): AssistantHandoffRequest => ({
  ...(question.kind === 'suggestion'
    ? { text: question.prompt.prompt, title: guideConversationTitle(question.prompt.label), origin: { kind: 'guide-suggestion' } as const }
    : { text: question.text, origin: { kind: 'guide-question', lastPageTitle: question.lastPageTitle } as const }),
  conversation: 'new',
  workspaceId: target.workspaceId,
  forceNewWorkspace: target.forceNewWorkspace,
})

/** What the user asked, as shown in the progress panel. */
export const questionText = (question: GuideQuestion): string =>
  question.kind === 'suggestion' ? question.prompt.label : question.text.trim()

/**
 * The conversation in the Host shell, marked as opened from the guide so the
 * conversation view can offer "← Getting started" (lane L5 reads `from=guide`).
 */
export const guideConversationUrl = (destination: string): string => {
  const url = new URL(destination, 'https://leitbild.invalid')
  url.searchParams.set('from', 'guide')
  return `${url.pathname}${url.search}${url.hash}`
}

/** Where the question goes, said under the question box (plan v2 §4.3). */
export type AskDestination =
  | { readonly kind: 'checking' }
  /** The remembered Workspace; "Use a new Workspace instead" is offered. */
  | { readonly kind: 'remembered'; readonly workspace: Workspace }
  /** No remembered Workspace, or the user chose a new one (then `instead` is the remembered one, to switch back). */
  | { readonly kind: 'new'; readonly instead: Workspace | null }
  /** The remembered Workspace could not be checked; the hand-off still decides and reports. */
  | { readonly kind: 'unknown' }

export const askDestination = (remembered: Workspace | null | undefined, forceNew: boolean): AskDestination => {
  if (remembered === undefined) return { kind: 'checking' }
  if (remembered !== null && !forceNew) return { kind: 'remembered', workspace: remembered }
  return { kind: 'new', instead: remembered }
}

export const destinationName = (workspace: Workspace): string => workspaceLabel(workspace)

/** The three progress steps; the Workspace step names the Workspace once it is known. */
export type AskStepId = 'workspace' | 'conversation' | 'question'
export type AskStepState = 'pending' | 'active' | 'done'

export interface AskProgress {
  readonly steps: ReadonlyArray<{ readonly id: AskStepId; readonly label: string; readonly state: AskStepState }>
  /** The one `role="status"` sentence for the latest step. */
  readonly status: string
}

export const INITIAL_ASK_PROGRESS: AskProgress = {
  steps: [
    { id: 'workspace', label: 'Find your Workspace', state: 'active' },
    { id: 'conversation', label: 'Open a new conversation', state: 'pending' },
    { id: 'question', label: 'Send your question', state: 'pending' },
  ],
  status: '',
}

const order: ReadonlyArray<AskStepId> = ['workspace', 'conversation', 'question']

/** Advances the progress for one hand-off step. */
export const askProgress = (previous: AskProgress, step: AssistantHandoffStep): AskProgress => {
  const active: AskStepId = step.kind === 'opening-conversation' ? 'conversation' : step.kind === 'sending-question' ? 'question' : 'workspace'
  const at = order.indexOf(active)
  const workspaceStepLabel = step.kind === 'creating-workspace'
    ? 'Create a Workspace'
    : step.kind === 'using-workspace' || step.kind === 'created-workspace'
      ? `Use ${workspaceLabel(step.workspace)}`
      : previous.steps[0]!.label
  return {
    steps: previous.steps.map((item, index) => ({
      ...item,
      label: item.id === 'workspace' ? workspaceStepLabel : item.label,
      state: index < at ? 'done' : index === at ? 'active' : 'pending',
    })),
    status: handoffStatusText(step),
  }
}
