<script lang="ts">
  import { tick } from 'svelte'
  import type { Snippet } from 'svelte'

  interface Props {
    readonly disabled?: boolean
    readonly submit?: (prompt: string) => Promise<void>
    readonly toggle?: () => Promise<void>
    readonly active?: boolean
    readonly onError?: (message: string) => void
    readonly onOpen?: () => Promise<void>
    readonly details?: Snippet<[busy: boolean]>
    /** Visible text beside the sparkle ("Ask" on the Workspace page); icon only without it. */
    readonly label?: string
  }

  let { disabled = false, submit, toggle, active = false, onError, onOpen, details, label }: Props = $props()
  let dialog = $state<HTMLDialogElement | null>(null)
  let input = $state<HTMLTextAreaElement | null>(null)
  let prompt = $state('')
  let busy = $state(false)
  let error = $state('')

  const open = async (): Promise<void> => {
    if (busy) return
    if (toggle) {
      if (busy) return
      busy = true
      error = ''
      try { await toggle() }
      catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause)
        onError?.(error)
      }
      finally { busy = false }
      return
    }
    error = ''
    dialog?.showModal()
    if (onOpen) {
      busy = true
      try { await onOpen() }
      catch (cause) { error = cause instanceof Error ? cause.message : String(cause) }
      finally { busy = false }
    }
    await tick()
    input?.focus()
  }

  const send = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault()
    const content = prompt.trim()
    if (busy || content.length === 0 || !submit) return
    busy = true
    error = ''
    try {
      await submit(content)
      prompt = ''
      dialog?.close()
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally { busy = false }
  }

  const keydown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      input?.form?.requestSubmit()
    }
  }
</script>

<button
  class="assistant-launch"
  class:labelled={label !== undefined}
  class:active
  class:busy
  type="button"
  disabled={disabled || busy}
  aria-busy={busy}
  aria-label={active ? 'Hide Agents' : label === undefined ? 'Open Leitbild Assistant' : `${label} the Leitbild Assistant`}
  aria-pressed={toggle ? active : undefined}
  title={disabled ? 'Leitbild Assistant is unavailable' : active ? 'Hide Agents' : toggle ? 'Open Run Assistant' : 'Ask Leitbild Assistant'}
  onclick={() => void open()}
>
  {#if busy}
    <svg class="assistant-spinner" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/></svg>
  {:else}
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3zm6 11l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8L18 14z"/></svg>
  {/if}
  {#if label !== undefined}<span class="launch-label">{label}</span>{/if}
</button>

{#if !toggle}
<dialog class="assistant-dialog" bind:this={dialog} onclose={() => { error = '' }} oncancel={event => { if (busy) event.preventDefault() }}>
  <form onsubmit={send}>
    <header>
      <div><span>Leitbild Assistant</span><h2>How can I help?</h2></div>
      <button class="assistant-close" type="button" aria-label="Close Assistant" disabled={busy} onclick={() => dialog?.close()}>×</button>
    </header>
    <p>Ask about Leitbild, explore the current simulation, or describe a scenario you want to create.</p>
    {@render details?.(busy)}
    <textarea aria-label="Question for Leitbild Assistant" disabled={busy} bind:this={input} bind:value={prompt} onkeydown={keydown} maxlength="64000" rows="6" placeholder="Ask a question, explore the system, or describe something you want to create…"></textarea>
    {#if error}<p class="assistant-error" role="alert">{error}</p>{/if}
    <footer><span>Enter to send · Shift+Enter for a new line</span><button class="primary" type="submit" disabled={busy || !submit || prompt.trim().length === 0}>{busy ? 'Opening…' : 'Ask Assistant'}</button></footer>
  </form>
</dialog>
{/if}

<style>
  /* The labelled launcher in the 56 px Workspace bar (VISUAL-SPEC §3.2: "✦ Ask", 36 px, #2b4a35 fill). */
  .assistant-launch.labelled { width: auto; min-height: 36px; gap: 6px; padding: 0 12px 0 10px; border-color: #3f6249; border-radius: var(--lb-r-sm);
    color: var(--lb-on-dark); background: #2b4a35; font-size: .875rem; font-weight: 650; }
  .assistant-launch.labelled:hover { border-color: #6f9277; background: #345a40; }
  .assistant-launch.labelled:focus-visible { outline: 2px solid var(--lb-focus-on-dark); outline-offset: 2px; }
  .assistant-launch.labelled svg { width: 16px; height: 16px; }
  @media (pointer: coarse) { .assistant-launch.labelled { min-height: 44px; } }
</style>
