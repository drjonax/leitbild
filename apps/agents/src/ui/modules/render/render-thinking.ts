// Thinking-indicator DOM: renders the yellow-dot card that appears while an
// agent is generating, plus update helpers for label, preview text, tool
// status, context icon, and warnings.

import { isFocusedRoomView } from '../focused-room.ts'

export const renderThinkingIndicator = (
  container: HTMLElement,
  agentName: string,
  onStop: (agentName: string) => void,
): { element: HTMLElement; timer: number } => {
  const div = document.createElement('div')
  div.className = 'rounded px-3 py-2 text-sm msg-agent'
  div.setAttribute('data-thinking-agent', agentName)

  const header = document.createElement('div')
  header.className = 'flex items-center gap-2 mb-1'

  const dot = document.createElement('span')
  dot.className = 'inline-block w-2 h-2 rounded-full bg-thinking typing-indicator shrink-0'
  header.appendChild(dot)

  const label = document.createElement('span')
  label.className = 'font-medium text-text-strong text-xs'
  label.setAttribute('data-thinking-label', agentName)
  let seconds = 0
  label.textContent = `${agentName}: Building context...`
  header.appendChild(label)

  const timerEl = document.createElement('span')
  timerEl.className = 'text-xs text-text-muted'
  header.appendChild(timerEl)

  const spacer = document.createElement('span')
  spacer.className = 'ml-auto'
  header.appendChild(spacer)

  const stopBtn = document.createElement('button')
  stopBtn.className = 'text-danger hover:text-danger-hover text-xs font-medium'
  stopBtn.textContent = '■ stop'
  stopBtn.onclick = (e) => { e.stopPropagation(); onStop(agentName) }
  header.appendChild(stopBtn)

  div.appendChild(header)

  // A newcomer in the Host's conversation view learns that silence is normal.
  if (isFocusedRoomView) {
    const expectation = document.createElement('div')
    expectation.className = 'text-xs text-text-muted'
    expectation.textContent = 'Answers usually take up to two minutes.'
    div.appendChild(expectation)
  }

  const toolStatus = document.createElement('div')
  toolStatus.className = 'text-xs text-text-muted'
  toolStatus.setAttribute('data-thinking-tools', agentName)
  div.appendChild(toolStatus)

  const preview = document.createElement('div')
  preview.className = 'text-text whitespace-pre-wrap break-words'
  preview.setAttribute('data-thinking-preview', agentName)
  div.appendChild(preview)

  const timer = window.setInterval(() => {
    seconds++
    timerEl.textContent = `${seconds}s`
  }, 1000)

  container.appendChild(div)
  container.scrollTop = container.scrollHeight
  return { element: div, timer }
}

export const removeThinkingIndicator = (container: HTMLElement, agentName: string): void => {
  const el = container.querySelector(`[data-thinking-agent="${agentName}"]`)
  el?.remove()
}

export const updateThinkingLabel = (container: HTMLElement, agentName: string, text: string): void => {
  const el = container.querySelector(`[data-thinking-label="${agentName}"]`)
  if (el) el.textContent = text
}

export const updateThinkingPreviewStyle = (container: HTMLElement, agentName: string, isThinking: boolean): void => {
  const el = container.querySelector(`[data-thinking-preview="${agentName}"]`) as HTMLElement | null
  if (!el) return
  el.className = isThinking
    ? 'text-text-muted italic whitespace-pre-wrap break-words'
    : 'text-text whitespace-pre-wrap break-words'
}

export const showContextIcon = (container: HTMLElement, agentName: string, onClick: () => void): void => {
  const indicator = container.querySelector(`[data-thinking-agent="${agentName}"]`)
  if (!indicator || indicator.querySelector('[data-context-btn]')) return
  const btn = document.createElement('button')
  btn.className = 'text-text-muted hover:text-accent text-xs'
  btn.textContent = '\ud83d\udccb'
  btn.title = 'View prompt context'
  btn.setAttribute('data-context-btn', '')
  btn.onclick = (e) => { e.stopPropagation(); onClick() }
  const header = indicator.querySelector('div')
  const stopBtn = header?.querySelector('button')
  if (stopBtn) header!.insertBefore(btn, stopBtn)
  else header?.appendChild(btn)
}

// Patch the thinking preview with the FULL accumulated text (store-driven).
// Auto-scrolls if the user is near the bottom.
export const updateThinkingPreview = (container: HTMLElement, agentName: string, fullText: string): void => {
  const el = container.querySelector(`[data-thinking-preview="${agentName}"]`)
  if (!el) return
  el.textContent = fullText
  if (container.scrollHeight - container.scrollTop - container.clientHeight < 150) {
    container.scrollTop = container.scrollHeight
  }
}

export const updateThinkingTool = (container: HTMLElement, agentName: string, text: string): void => {
  const el = container.querySelector(`[data-thinking-tools="${agentName}"]`)
  if (el) el.textContent = text
}

export const addThinkingWarning = (container: HTMLElement, agentName: string, message: string): void => {
  const indicator = container.querySelector(`[data-thinking-agent="${agentName}"]`)
  if (!indicator) return
  const warn = document.createElement('div')
  warn.className = 'text-xs text-warning bg-warning-bg rounded px-2 py-0.5 mt-1'
  warn.textContent = `⚠ ${message}`
  const preview = indicator.querySelector(`[data-thinking-preview="${agentName}"]`)
  if (preview) indicator.insertBefore(warn, preview)
  else indicator.appendChild(warn)
}

// Inline "agent has used N tool calls without finishing" notice with
// [Continue] [Stop] buttons. Replaces the silent maxToolIterations
// cliff — the user decides whether to extend or stop. onContinue calls
// POST to the Workspace-scoped Agent continue-tools endpoint; onStop calls the existing
// cancel-generation path. Removed automatically by clearThinkingIndicator
// when the agent goes idle (eval completes or is cancelled).
export const addToolCheckinNotice = (
  container: HTMLElement,
  agentName: string,
  iterations: number,
  recentTools: ReadonlyArray<{ tool: string; success: boolean }>,
  onContinue: () => void,
  onStop: () => void,
): void => {
  const indicator = container.querySelector(`[data-thinking-agent="${agentName}"]`)
  if (!indicator) return
  // Replace any prior checkin notice for this agent (don't stack).
  indicator.querySelector('[data-checkin-notice]')?.remove()

  const box = document.createElement('div')
  box.setAttribute('data-checkin-notice', '')
  box.className = 'text-xs rounded px-2 py-1 mt-1 border border-warning/40 bg-warning-bg flex items-center gap-2 flex-wrap'

  const label = document.createElement('span')
  const recent = recentTools.length > 0
    ? ` (recent: ${recentTools.slice(-2).map(t => `${t.tool}${t.success ? '' : '✗'}`).join(', ')})`
    : ''
  label.textContent = `Agent used ${iterations} tool calls without finishing${recent}. Continue?`
  box.appendChild(label)

  const cont = document.createElement('button')
  cont.className = 'px-2 py-0.5 rounded border border-success/40 text-success-text hover:bg-success/10 ml-auto'
  cont.textContent = 'Continue'
  cont.onclick = (e) => { e.stopPropagation(); cont.disabled = true; stop.disabled = true; onContinue() }
  box.appendChild(cont)

  const stop = document.createElement('button')
  stop.className = 'px-2 py-0.5 rounded border border-danger/40 text-danger hover:bg-danger/10'
  stop.textContent = 'Stop'
  stop.onclick = (e) => { e.stopPropagation(); cont.disabled = true; stop.disabled = true; onStop() }
  box.appendChild(stop)

  const preview = indicator.querySelector(`[data-thinking-preview="${agentName}"]`)
  if (preview) indicator.insertBefore(box, preview)
  else indicator.appendChild(box)
}
