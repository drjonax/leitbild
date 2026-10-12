// Hands a question to the Leitbild Assistant from a page without a Workspace
// (the wiki, the Getting started guide). Where it came from is visible text in
// the message, not a hidden field: the user sees exactly what the model gets.

import type { Workspace } from '@leitbild/contracts'
import { workspaceUrl } from './launch-destination.ts'
import { readHostJson, resolveLaunchWorkspace, workspaceLabel, type LaunchWorkspacePorts, type LaunchWorkspaceStep } from './launch-workspace.ts'

export interface WikiAssistantPage {
  readonly path: string
  readonly title: string
  readonly revision: string
}

export type AssistantOrigin =
  /** The wiki's Assistant button; the page reference is unchanged from before. */
  | { readonly kind: 'wiki'; readonly page: WikiAssistantPage | null }
  /** A prompt chip on the guide's Ask page. */
  | { readonly kind: 'guide-suggestion' }
  /** A typed question; the last guide page viewed in this modal session, if any. */
  | { readonly kind: 'guide-question'; readonly lastPageTitle: string | null }

export const GUIDE_CONVERSATION_TITLE = 'Getting started question'
export const ASSISTANT_OPEN_CAPABILITY = 'agents.assistance.open'

/** The message sent. The wiki form is a visible reference, not a copy of the wiki or an extra system instruction. */
export const assistantPrompt = (text: string, origin: AssistantOrigin): string => {
  if (origin.kind === 'wiki') {
    const page = origin.page
    if (!page) return text
    return `${text}\n\nWiki page I am viewing: ${page.title}\nSource: knowledge/${page.path}\nKnowledge revision: ${page.revision}`
  }
  if (origin.kind === 'guide-suggestion') return `${text}\n\nAsked from: Getting started guide · suggested question`
  const viewed = origin.lastPageTitle === null ? 'no page viewed' : `last page viewed: “${origin.lastPageTitle}”`
  return `${text}\n\nAsked from: Getting started guide · own question · ${viewed}`
}

/** Open the Host shell with the Agents pane, not the standalone Agents iframe route. */
export const assistantDestination = (workspaceId: string, roomId: string): string => workspaceUrl(workspaceId, { agents: roomId })

export type AssistantHandoffStep =
  | LaunchWorkspaceStep
  | { readonly kind: 'opening-conversation'; readonly workspace: Workspace }
  | { readonly kind: 'sending-question'; readonly workspace: Workspace }

/** One status sentence per step (a11y M3). */
export const handoffStatusText = (step: AssistantHandoffStep): string => {
  if (step.kind === 'using-workspace') return `Using ${workspaceLabel(step.workspace)}.`
  if (step.kind === 'creating-workspace') return 'Creating a Workspace…'
  if (step.kind === 'created-workspace') return `Created ${workspaceLabel(step.workspace)}.`
  if (step.kind === 'opening-conversation') return 'Opening a new conversation…'
  return 'Sending your question…'
}

export interface AssistantHandoffRequest {
  readonly text: string
  readonly origin: AssistantOrigin
  /** 'new' opens a fresh conversation (guide, landing); 'reuse' posts to the Workspace's Assistant conversation (wiki). */
  readonly conversation: 'reuse' | 'new'
  /** Title of a new conversation; defaults to "Getting started question". */
  readonly title?: string
  /** A Workspace the user chose here; otherwise the remembered one, else a new one. */
  readonly workspaceId?: string | null
  readonly forceNewWorkspace?: boolean
}

export interface AssistantHandoffPorts extends LaunchWorkspacePorts {
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>
  readonly onstep?: (step: AssistantHandoffStep) => void
}

export interface AssistantHandoff {
  readonly workspace: Workspace
  readonly created: boolean
  readonly notice: string | null
  readonly roomId: string
  /** `/workspaces/<ws>?agents=<room>`; the caller navigates. */
  readonly destination: string
}

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined

/**
 * Resolves the Workspace (Agents must be ready), checks that it publishes the
 * Workspace-scoped `agents.assistance.open`, invokes it as the human and
 * remembers the Workspace ("asks the Assistant"). Errors are thrown as-is for
 * `error-text.ts`; nothing is retried.
 */
export const openAssistantConversation = async (
  request: AssistantHandoffRequest,
  ports: AssistantHandoffPorts,
): Promise<AssistantHandoff> => {
  const text = request.text.trim()
  if (!text) throw new Error('Type a question first')
  const target = await resolveLaunchWorkspace('agents', ports, {
    workspaceId: request.workspaceId ?? null,
    forceNew: request.forceNewWorkspace === true,
    ...(ports.onstep ? { onstep: ports.onstep } : {}),
  })
  const workspace = target.workspace
  const encoded = encodeURIComponent(workspace.id)
  const init = (body?: unknown): RequestInit => ({
    ...(body === undefined ? { method: 'GET' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    ...(ports.signal ? { signal: ports.signal } : {}),
  })

  ports.onstep?.({ kind: 'opening-conversation', workspace })
  const listing = await readHostJson(await ports.fetch(`/api/workspaces/${encoded}/capabilities?moduleId=agents`, init()))
  const capabilities = field(listing, 'capabilities')
  const open = Array.isArray(capabilities)
    ? capabilities.find(capability => field(capability, 'id') === ASSISTANT_OPEN_CAPABILITY)
    : undefined
  if (open === undefined || field(field(open, 'scope'), 'kind') !== 'workspace') {
    throw Object.assign(new Error('The Leitbild Assistant is not available in this Workspace right now.'), { code: 'assistant_unavailable' })
  }

  ports.onstep?.({ kind: 'sending-question', workspace })
  const input = {
    prompt: assistantPrompt(text, request.origin),
    ...(request.conversation === 'new' ? { conversation: 'new', title: request.title ?? GUIDE_CONVERSATION_TITLE } : {}),
  }
  const response = await readHostJson(await ports.fetch(
    `/api/workspaces/${encoded}/capabilities/${ASSISTANT_OPEN_CAPABILITY}/invoke`,
    init({ input, actor: { kind: 'human' } }),
  ))
  const resource = field(field(response, 'result'), 'resource')
  const roomId = field(resource, 'id')
  const roomWorkspace = field(resource, 'workspaceId')
  if (typeof roomId !== 'string' || roomWorkspace !== workspace.id) {
    throw new Error('The Assistant did not return a conversation in this Workspace.')
  }
  ports.memory.remember(workspace.id, 'asked')
  return { workspace, created: target.created, notice: target.notice, roomId, destination: assistantDestination(workspace.id, roomId) }
}
