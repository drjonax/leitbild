// UI-local view types, shared across render-*.ts modules. Minimal mirror of
// server-side types — widen to the full server type on the next refactor.
//
// MessageCause is imported from the server-side type module so the kind union
// (script/trigger/biometric/...) lives in exactly one place.

import type { MessageAttachment, MessageCause, ToolTraceEntry } from '../../../core/types/messaging.ts'

export interface UIMessage {
  id: string
  senderId: string
  senderName?: string   // forwarded from server Message; used as render fallback
                        // when the sender isn't in the local agents map (e.g.
                        // the local human before their AgentJoined snapshot).
  content: string
  timestamp: number
  type: string
  roomId?: string
  recipientId?: string
  generationMs?: number
  generationTraceId?: string
  // Tokens/context metrics forwarded via server message metadata.
  promptTokens?: number
  lastPromptTokens?: number
  completionTokens?: number
  cacheCreation?: number
  cacheRead?: number
  cacheMiss?: number
  modelCalls?: number
  contextMax?: number
  provider?: string
  model?: string
  // Error telemetry (set when type === 'error')
  errorCode?: string
  errorProvider?: string
  // Causality: which automation subsystem produced this message. Mirrors
  // server Message.cause; rendered as a small caption under the bubble.
  cause?: MessageCause
  // Messages this one was produced in response to. A display-request reply
  // names the answer it shows first.
  inReplyTo?: ReadonlyArray<string>
  // Image attachments forwarded from server Message.attachments. Rendered
  // as inline thumbnails below the message body; click → full-size modal.
  attachments?: ReadonlyArray<MessageAttachment>
  toolTrace?: ReadonlyArray<ToolTraceEntry>
}

export interface RoomProfile {
  id: string
  name: string
}

export interface AgentInfo {
  id: string
  name: string
  kind: string
  state: string
  model?: string
  context?: string
  tags?: ReadonlyArray<string>
}
