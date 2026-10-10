// Message rendering — a single chat/system/pass/mute/room-summary message card.
// Handles markdown rendering via bundled marked + DOMPurify.

import type { UIMessage, AgentInfo } from '../render/render-types.ts'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
// Import order matters: mermaid first, then map. Each module self-registers
// its post-render processor at module-load (see ../mermaid/index.ts and
// ../map/index.ts). Adding a new built-in inline-block type = create a new
// module that calls addPostRenderProcessor() at top-level and import it
// here. Pack-gated extensions register/unregister via the extension mount
// layer (../extensions/registry.ts), not via static import.
import '../mermaid/index.ts'
import '../map/index.ts'
import '../live-view/index.ts'
import { getPostRenderProcessors } from '../extensions/post-render-registry.ts'
import { icon } from '../icon.ts'
import { appendWhisperBadge } from '../whisper-badge.ts'
import { showToast } from '../toast.ts'
import { $messageThinking } from '../stores.ts'
import { decorateProductSourceReferences } from '../modals/source-modal.ts'
import { mountMessageComparisons } from '../message-comparisons.ts'
import { applyDisplayReply, displayReplyCaptionElement, displayRequestRow, isDisplayReply, offersDisplayRequest } from '../display-request.ts'

// Clipboard writes use the current Async Clipboard API. Returns false when
// the browser or document context does not permit clipboard access.
const writeClipboard = async (text: string): Promise<boolean> => {
  try {
    if (!navigator.clipboard?.writeText) return false
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

// Render Markdown content safely, then post-process diagrams and source links.
const renderMarkdownContent = (el: HTMLElement, text: string): void => {
  el.className += ' msg-prose'
  el.innerHTML = DOMPurify.sanitize(marked.parse(text) as string)
  decorateProductSourceReferences(el)
  for (const proc of getPostRenderProcessors()) void proc(el)
}

export interface RenderMessageOptions {
  readonly container: HTMLElement
  readonly msg: UIMessage
  readonly agents: Record<string, AgentInfo> | Map<string, AgentInfo>
  readonly onDelete?: (msgId: string) => void
  readonly onViewContext?: (msg: UIMessage) => void
  readonly onBookmark?: (content: string) => void
}

const compactCount = (value: number): string => value.toLocaleString('en-GB')
const compactBytes = (value: number): string => value < 1024
  ? `${value} B`
  : value < 1024 * 1024
    ? `${(value / 1024).toFixed(1)} KB`
    : `${(value / (1024 * 1024)).toFixed(1)} MB`

const appendGenerationInfo = (host: HTMLElement, msg: UIMessage): void => {
  if (msg.generationMs === undefined) return
  const parts: string[] = []
  const providerModel = [msg.provider, msg.model].filter(Boolean).join(' · ')
  if (providerModel) parts.push(providerModel)
  parts.push(`${(msg.generationMs / 1000).toFixed(1)}s`)
  if (msg.modelCalls !== undefined) parts.push(`${msg.modelCalls} model call${msg.modelCalls === 1 ? '' : 's'}`)
  if (msg.toolTrace?.length) parts.push(`${msg.toolTrace.length} tool call${msg.toolTrace.length === 1 ? '' : 's'}`)
  if (msg.toolTrace?.some(trace => trace.resultBytes !== undefined)) {
    parts.push(`${compactBytes(msg.toolTrace.reduce((total, trace) => total + (trace.resultBytes ?? 0), 0))} tool evidence`)
  }
  if (msg.promptTokens !== undefined || msg.completionTokens !== undefined) {
    parts.push(`${compactCount(msg.promptTokens ?? 0)} in · ${compactCount(msg.completionTokens ?? 0)} out`)
  }
  const cache: string[] = []
  if (msg.cacheRead !== undefined) {
    // OpenAI defines cached_tokens as a subset of prompt_tokens. Other
    // providers expose differently-scoped counters, so show their raw values
    // without inventing a percentage from an incomparable denominator.
    const reliableShare = msg.provider?.toLowerCase() === 'openai'
      && msg.promptTokens !== undefined && msg.promptTokens > 0 && msg.cacheRead <= msg.promptTokens
      ? ` (${Math.round((msg.cacheRead / msg.promptTokens) * 100)}%)`
      : ''
    cache.push(`${compactCount(msg.cacheRead)} read${reliableShare}`)
  }
  if (msg.cacheCreation !== undefined) cache.push(`${compactCount(msg.cacheCreation)} written`)
  if (msg.cacheMiss !== undefined) cache.push(`${compactCount(msg.cacheMiss)} miss`)
  parts.push(cache.length > 0 ? `cache ${cache.join(', ')}` : 'cache not reported')
  const info = document.createElement('div')
  info.className = 'text-[10px] text-text-subtle mt-1'
  info.textContent = `Generation · ${parts.join(' · ')}`
  host.appendChild(info)
}

export const renderMessage = (opts: RenderMessageOptions): void => {
  const { container, msg, agents, onDelete, onViewContext, onBookmark } = opts
  const getAgent = (id: string): AgentInfo | undefined =>
    agents instanceof Map ? agents.get(id) : agents[id]

  const isRoutineExternalMirror =
    msg.cause?.kind === 'resource-event' &&
    !msg.content.includes('mirror error') &&
    !msg.content.includes('SIMULATION RUN RESET')
  if (isRoutineExternalMirror) return

  const isJoinLeave = msg.type === 'join' || msg.type === 'leave'
  const ageMs = Date.now() - msg.timestamp
  // Join/leave messages auto-fade 10s after posting; skip rendering if already expired.
  if (isJoinLeave && ageMs > 10_000) return

  const div = document.createElement('div')
  div.setAttribute('data-msg-id', msg.id)
  // Stage cards (script engine setup messages) are sent with senderId='system'
  // but senderName='Stage'. They are scene-boundary markers we want visible,
  // not the muted system-line treatment.
  const isStageCard = msg.senderId === 'system' && msg.senderName === 'Stage' && msg.type === 'chat'
  const isSystem = !isStageCard && (msg.type === 'system' || msg.type === 'join' || msg.type === 'leave' || msg.senderId === 'system')
  const isPass = msg.type === 'pass'
  const isError = msg.type === 'error'
  const isMute = msg.type === 'mute'
  const isRoomSummary = msg.type === 'room_summary'

  if (isError) {
    const senderInfo = getAgent(msg.senderId)
    const senderName = senderInfo?.name ?? msg.senderName ?? msg.senderId
    div.className = 'msg-error text-xs py-1 px-2 border-l-2 border-danger bg-danger/5 text-danger flex items-center gap-2'
    const label = document.createElement('span')
    label.textContent = `⚠ ${senderName} ${msg.content}`
    label.className = 'flex-1'
    div.appendChild(label)
    // Offer "Change model" affordance for failures the user can fix in config.
    const code = msg.errorCode
    const offersChangeModel = code === 'no_api_key' || code === 'model_unavailable' || code === 'provider_down'
    if (offersChangeModel) {
      const btn = document.createElement('button')
      btn.className = 'text-xs underline hover:text-danger-strong'
      btn.textContent = 'Change model'
      btn.onclick = (e) => {
        e.stopPropagation()
        // Open the agent inspector via a custom event the app shell listens for.
        // Falls through silently if no listener is registered.
        window.dispatchEvent(new CustomEvent('open-agent-inspector', {
          detail: { agentId: msg.senderId, focus: 'model' },
        }))
      }
      div.appendChild(btn)
    }
  } else if (isPass) {
    const senderInfo = getAgent(msg.senderId)
    const senderName = senderInfo?.name ?? msg.senderName ?? msg.senderId
    div.className = 'msg-pass text-xs py-1 px-2'
    div.textContent = `${senderName} ${msg.content}`
  } else if (isMute) {
    div.className = 'msg-system text-xs py-1 px-2 text-text-muted'
    div.textContent = msg.content
  } else if (isSystem || isRoomSummary) {
    // System messages are normally plain text (compact, muted). Biometric-
    // caused system messages carry a ```biometric fenced block that must
    // go through the markdown + post-processor pipeline so the inline
    // widget can replace it — otherwise the user sees raw JSON.
    if (msg.cause?.kind === 'biometric') {
      div.className = 'msg-system text-xs py-1 px-2'
      renderMarkdownContent(div, msg.content)
    } else {
      div.className = 'msg-system text-xs py-1 px-2'
      div.textContent = msg.content
    }
  } else {
    // Tint by sender kind so the room reads as a conversation between two
    // distinct populations: humans (blue) vs AI (green). Unresolved senders
    // use message ownership to select a stable class.
    const senderInfo = getAgent(msg.senderId)
    const kindClass = senderInfo?.kind === 'human' ? 'msg-human'
      : senderInfo?.kind === 'ai' ? 'msg-agent'
      : 'msg-agent'
    div.className = `rounded-md px-3 py-2 text-sm border border-border shadow-sm ${kindClass}`

    const header = document.createElement('div')
    header.className = 'flex items-center gap-2 mb-1'

    const nameEl = document.createElement('span')
    nameEl.className = 'font-semibold text-text-strong text-xs'
    const sender = getAgent(msg.senderId)
    nameEl.textContent = sender?.name ?? msg.senderName ?? msg.senderId

    header.appendChild(nameEl)

    // Header field order: time, duration, context (compact %), model.
    // Each piece carries `data-mh-piece="<name>"` so the visibility toggles
    // in the room-header eye popover can hide it via CSS without re-render.
    // See src/ui/modules/message-header-prefs.ts.

    const timeEl = document.createElement('span')
    timeEl.className = 'text-xs text-text-muted'
    timeEl.dataset.mhPiece = 'time'
    // 24-hour HH:MM:SS — locale-invariant, no AM/PM.
    timeEl.textContent = new Date(msg.timestamp).toLocaleTimeString('en-GB', { hour12: false })
    header.appendChild(timeEl)

    if (msg.generationMs) {
      const genEl = document.createElement('span')
      genEl.className = 'text-xs text-accent'
      genEl.dataset.mhPiece = 'duration'
      genEl.textContent = `${(msg.generationMs / 1000).toFixed(1)}s`
      header.appendChild(genEl)
    }

    // Context usage: shown as a compact `N%` (or `N.N%` for low values).
    // Hover tooltip carries the full `prompt / max tok (provider)` detail.
    // Tone reflects pressure: amber at 75%, red at 90%. Unknown context
    // window → grey text + the raw token count in the tooltip.
    const finalPassTokens = msg.lastPromptTokens ?? (msg.modelCalls === undefined || msg.modelCalls <= 1 ? msg.promptTokens : undefined)
    if (finalPassTokens !== undefined) {
      const ctxEl = document.createElement('span')
      const ctx = msg.contextMax ?? 0
      const usage = finalPassTokens
      const pct = ctx > 0 ? (usage / ctx) * 100 : 0
      let tone = 'text-text-muted'
      if (ctx > 0) {
        if (pct >= 90) tone = 'text-danger'
        else if (pct >= 75) tone = 'text-warning'
        else tone = 'text-emerald-500'
      }
      ctxEl.className = `text-xs ${tone}`
      ctxEl.dataset.mhPiece = 'context'
      if (ctx > 0) {
        const display = pct < 1 ? pct.toFixed(2) : pct < 10 ? pct.toFixed(1) : pct.toFixed(0)
        ctxEl.textContent = `${display}%`
        ctxEl.title = `${usage.toLocaleString()} / ${ctx.toLocaleString()} tok in final model pass (${display}%)${msg.promptTokens !== undefined && msg.promptTokens !== usage ? ` · ${msg.promptTokens.toLocaleString()} cumulative input` : ''}${msg.provider ? ` · via ${msg.provider}` : ''}`
      } else {
        ctxEl.textContent = '?%'
        ctxEl.title = `${usage.toLocaleString()} tok in final model pass (context window unknown)${msg.promptTokens !== undefined && msg.promptTokens !== usage ? ` · ${msg.promptTokens.toLocaleString()} cumulative input` : ''}${msg.provider ? ` · via ${msg.provider}` : ''}`
      }
      header.appendChild(ctxEl)
    }

    if (msg.model) {
      // Show only the part after the LAST colon — `gemini:gemini-2.5-pro`
      // becomes `gemini-2.5-pro`. Models without a provider prefix render
      // unchanged. Full `provider:model` lives in the tooltip.
      const modelEl = document.createElement('span')
      modelEl.className = 'text-xs text-text-muted font-mono'
      modelEl.dataset.mhPiece = 'model'
      const colonIdx = msg.model.lastIndexOf(':')
      modelEl.textContent = colonIdx >= 0 ? msg.model.slice(colonIdx + 1) : msg.model
      modelEl.title = msg.provider ? `${msg.model} (via ${msg.provider})` : msg.model
      header.appendChild(modelEl)
    }

    {
      const spacer = document.createElement('span')
      spacer.className = 'ml-auto'
      header.appendChild(spacer)
      div.className += ' group'

      // Copy-to-clipboard. Hover-only, available on every chat message
      // regardless of which other actions are in scope. Uses navigator
      // .clipboard when available; falls back silently on older contexts.
      const copyBtn = document.createElement('button')
      copyBtn.className = 'icon-btn text-text-subtle hover:text-text text-xs opacity-0 group-hover:opacity-100'
      copyBtn.title = 'Copy message to clipboard'
      copyBtn.setAttribute('aria-label', 'Copy message to clipboard')
      copyBtn.appendChild(icon('copy', { size: 12 }))
      copyBtn.onclick = async (e) => {
        e.stopPropagation()
        const ok = await writeClipboard(msg.content)
        if (ok) {
          copyBtn.replaceChildren(icon('check', { size: 12 }))
          setTimeout(() => {
            if (copyBtn.isConnected) copyBtn.replaceChildren(icon('copy', { size: 12 }))
          }, 1200)
          showToast(document.body, 'Copied to clipboard', { type: 'success', position: 'fixed' })
        } else {
          showToast(document.body, 'Copy failed — clipboard unavailable in this browser context', { type: 'error', position: 'fixed' })
        }
      }
      header.appendChild(copyBtn)

      if (onViewContext && msg.generationTraceId) {
        const ctxBtn = document.createElement('button')
        ctxBtn.className = 'icon-btn text-text-subtle hover:text-accent text-xs'
        ctxBtn.appendChild(icon('info', { size: 13 }))
        ctxBtn.title = 'View prompt context and generation details'
        ctxBtn.setAttribute('aria-label', 'View prompt context and generation details')
        ctxBtn.onclick = (e) => { e.stopPropagation(); onViewContext(msg) }
        header.appendChild(ctxBtn)
      }

      if (onBookmark) {
        const bmBtn = document.createElement('button')
        bmBtn.className = 'icon-btn opacity-0 group-hover:opacity-100'
        bmBtn.title = 'Bookmark message'
        bmBtn.setAttribute('aria-label', 'Bookmark message')
        bmBtn.appendChild(icon('bookmark', { size: 12, fill: 'var(--danger)', style: 'transform: rotate(45deg);' }))
        bmBtn.onclick = (e) => { e.stopPropagation(); onBookmark(msg.content) }
        header.appendChild(bmBtn)
      }

      if (onDelete) {
        const delBtn = document.createElement('button')
        delBtn.className = 'text-border-strong hover:text-danger text-xs opacity-0 group-hover:opacity-100'
        delBtn.textContent = '×'
        delBtn.title = 'Delete message'
        delBtn.onclick = (e) => { e.stopPropagation(); onDelete(msg.id) }
        header.appendChild(delBtn)
      }
    }

    const content = document.createElement('div')
    content.className = 'text-text'
    // Generated answers name their turn so ```leitbild-view fences can be
    // resolved against that turn's own execution evidence.
    if (msg.generationTraceId && msg.roomId && msg.type === 'chat') {
      content.dataset.viewRoom = msg.roomId
      content.dataset.viewTurn = msg.generationTraceId
    }
    renderMarkdownContent(content, msg.content)

    div.appendChild(header)

    // Persisted thinking renders above the response so reading
    // order is reasoning → answer. `<details>` is open by default so
    // the user sees the model's chain-of-thought after a kimi-k2.6 or
    // o-series eval; when the user toggles the global "Thinking" piece
    // off in the visibility popover (body.mh-hide-thinking), CSS
    // suppresses the body and collapses to a single-line summary so
    // the thinking pane doesn't dominate the chat. The user can still
    // unfold any one message via the disclosure triangle.
    const thinkingText = $messageThinking.get()[msg.id]
    if (thinkingText && thinkingText.length > 0) {
      const det = document.createElement('details')
      det.className = 'thinking-block text-xs text-text-subtle mb-1 border-l-2 border-border pl-2'
      det.setAttribute('data-mh-piece', 'thinking')
      // Default open when the global pref allows; collapsed when hidden.
      // User can always toggle individual messages via the disclosure
      // triangle regardless of the global pref.
      det.open = !document.body.classList.contains('mh-hide-thinking')
      const sum = document.createElement('summary')
      sum.className = 'cursor-pointer select-none hover:text-text'
      sum.textContent = '💭 reasoning'
      det.appendChild(sum)
      const body = document.createElement('div')
      body.className = 'mt-1 whitespace-pre-wrap break-words italic'
      body.textContent = thinkingText
      det.appendChild(body)
      div.appendChild(det)
    }

    div.appendChild(content)

    // Image attachments — render thumbnails below the text content.
    // Click → full-size modal. Matches the composer-attachments preview
    // pattern. Always inline; no virtualization (V1).
    if (msg.attachments && msg.attachments.length > 0) {
      const attHost = document.createElement('div')
      attHost.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:6px'
      for (const att of msg.attachments) {
        if (att.kind !== 'image') continue
        const wrap = document.createElement('div')
        wrap.style.cssText = 'border:1px solid var(--border, #374151);border-radius:4px;overflow:hidden;cursor:zoom-in;max-width:200px'
        wrap.title = `${att.width}×${att.height}${att.source ? ' · ' + att.source : ''} — click to enlarge`
        const img = document.createElement('img')
        img.src = att.dataUrl
        img.style.cssText = 'display:block;max-width:200px;max-height:140px;object-fit:contain'
        wrap.appendChild(img)
        wrap.addEventListener('click', () => {
          const overlay = document.createElement('div')
          overlay.style.cssText = 'position:fixed;inset:0;z-index:5000;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;cursor:zoom-out'
          overlay.addEventListener('click', () => overlay.remove())
          const big = document.createElement('img')
          big.src = att.dataUrl
          big.style.cssText = 'max-width:95vw;max-height:95vh;box-shadow:0 8px 32px rgba(0,0,0,0.5)'
          overlay.appendChild(big)
          document.body.appendChild(overlay)
        })
        attHost.appendChild(wrap)
      }
      div.appendChild(attHost)
    }

    // Offer to show this answer as a live display. The row stays empty unless
    // the author holds the display Skill.
    if (sender && offersDisplayRequest(msg, sender)) div.appendChild(displayRequestRow(msg, sender.name))

    // If a script is active in this room, append the whisper attached to
    // THIS specific message (looked up by messageId in stepLogs). No-op
    // when no script is active or no whisper has been classified yet.
    appendWhisperBadge(div, msg.senderName, msg.roomId, msg.id)
  }

  appendGenerationInfo(div, msg)

  // Causality caption — surfaces "via script: X step N" / "via trigger: Z"
  // when an automation subsystem produced this message.
  // Subtle (text-text-subtle, small) so it doesn't compete with the message
  // body. Tooltip carries the full attribution. See Message.cause docs.
  // A display-request reply names its requester and links to its answer.
  if (isDisplayReply(msg)) {
    div.appendChild(displayReplyCaptionElement(container, msg))
  } else if (msg.cause) {
    const cap = document.createElement('div')
    cap.className = 'text-[10px] text-text-subtle mt-0.5'
    const stepFragment = msg.cause.step !== undefined ? ` step ${msg.cause.step + 1}` : ''
    const label = `via ${msg.cause.kind}: ${msg.cause.name}${stepFragment}`
    cap.textContent = label
    cap.title = label
    div.appendChild(cap)
  }

  container.appendChild(div)

  if (isDisplayReply(msg)) applyDisplayReply(container, msg)

  if (msg.generationTraceId && msg.roomId && msg.type === 'chat') {
    mountMessageComparisons(div, msg, renderMarkdownContent)
  }

  if (isJoinLeave) {
    const remaining = Math.max(0, 10_000 - ageMs)
    setTimeout(() => {
      if (!div.isConnected) return
      div.classList.add('msg-fading')
      setTimeout(() => { if (div.isConnected) div.remove() }, 500)
    }, remaining)
  }
}
