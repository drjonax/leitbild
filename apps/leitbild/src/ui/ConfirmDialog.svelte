<script lang="ts" generics="T extends DeleteItem">
  // Confirm a delete of one or many things (Workspaces, simulations,
  // scenarios): a native modal dialog that names what goes, starts on Cancel
  // and needs one click on the count-specific danger button. While it works
  // it says how far it got and cannot be closed; afterwards it closes on
  // success, or lists what failed and why, with "Try again" for just those.
  // The session, the runner and the words live in bulk-delete.ts.
  import { tick } from 'svelte'
  import {
    createDeleteSession, deleteLabel, deleteTitle, failureBody, failureTitle, progressText,
    type DeleteItem, type DeleteSession, type DeleteSessionState, type Noun, type RemoveOutcome,
  } from './bulk-delete.ts'

  let { open = $bindable(false), items, noun, body, aside = null, remove, onfinished, returnFocus }: {
    open: boolean
    /** What the visitor chose to delete; read when the dialog opens. */
    items: ReadonlyArray<T>
    noun: Noun
    /** What deleting means, e.g. "Its simulations and conversations are deleted for everyone. This cannot be undone." */
    body: string
    /** One more plain line under the body, or null. */
    aside?: string | null
    remove: (item: T) => Promise<RemoveOutcome>
    /**
     * Once the dialog has closed: what was deleted (or already gone), possibly
     * nothing. A returned promise (the caller reloading its list) is waited
     * for before focus moves.
     */
    onfinished?: (removed: ReadonlyArray<T>) => void | Promise<void>
    /** Where focus goes after something was deleted, or when the control that opened the dialog is gone or hidden. */
    returnFocus?: () => void
  } = $props()

  const uid = `confirm-${Math.random().toString(36).slice(2, 8)}`
  let dialog = $state<HTMLDialogElement | null>(null)
  let cancelButton = $state<HTMLButtonElement | null>(null)
  let closeButton = $state<HTMLButtonElement | null>(null)
  let session: DeleteSession<T> | null = null
  let view = $state<DeleteSessionState<T> | null>(null)
  let opener: HTMLElement | null = null
  const phase = $derived(view?.phase ?? 'confirm')
  const pending = $derived(view?.pending ?? [])
  const round = $derived(view?.phase === 'failed' ? view.round : null)
  const title = $derived(round ? failureTitle(noun, round.failed.length, pending.length) : deleteTitle(noun, pending))
  /** Rendered and focusable: a ⋯ menu item has closed with its menu, and a deleted row is gone. */
  const showing = (element: HTMLElement | null): element is HTMLElement => element !== null && element.isConnected && element.getClientRects().length > 0

  $effect(() => {
    if (!dialog) return
    if (open && !dialog.open) {
      const active = document.activeElement
      opener = active instanceof HTMLElement && active !== document.body ? active : null
      session = createDeleteSession([...items], remove, state => { view = state })
      view = session.state()
      dialog.showModal()
      // Cancel first: a destructive dialog never starts on the destructive control (a11y M7).
      void tick().then(() => cancelButton?.focus())
    } else if (!open && dialog.open && session?.mayClose() !== false) dialog.close()
  })

  // While deletes run, Esc does nothing: its keydown is cancelled, so no close request is made at all.
  const onkeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && session && !session.mayClose()) event.preventDefault()
  }

  const onclose = (): void => {
    // A browser lets a page refuse a close request only once per user action, so a second phone Back
    // closes the dialog while deletes run: it opens again, as their outcome must still be shown and reported.
    if (session && !session.mayClose()) {
      dialog?.showModal()
      return
    }
    open = false
    const removed = view?.removed ?? []
    const target = showing(opener) ? opener : null
    opener = null
    session = null
    if (removed.length === 0) {
      if (target) target.focus()
      else returnFocus?.()
      void onfinished?.(removed)
      return
    }
    // What held focus may be gone with what was deleted: the caller says where it goes once its list is read again.
    void Promise.resolve(onfinished?.(removed)).finally(() => { void tick().then(() => returnFocus?.()) })
  }

  const confirm = async (): Promise<void> => {
    if (!session?.mayClose()) return
    const result = await session.start()
    if (result.phase === 'done') {
      dialog?.close()
      return
    }
    // Close, not Try again: a destructive control never takes focus by itself.
    await tick()
    closeButton?.focus()
  }
</script>

<dialog class="confirm-dialog" bind:this={dialog} aria-labelledby={`${uid}-title`} aria-describedby={`${uid}-body`} {onclose} {onkeydown}
  oncancel={event => { if (session && !session.mayClose()) event.preventDefault() }}
>
  <div class="body">
    <h2 id={`${uid}-title`}>{title}</h2>
    {#if round}
      <div class="failed" role="alert">
        <p id={`${uid}-body`}>{failureBody(round)}</p>
        <ul class="names failures">
          {#each round.failed as failure (failure.item.key)}
            <li><b>{failure.item.label}</b><span class="why">{failure.text}</span></li>
          {/each}
        </ul>
      </div>
    {:else}
      <p id={`${uid}-body`}>{body}</p>
      {#if aside}<p class="aside">{aside}</p>{/if}
      {#if pending.length > 1}
        <ul class="names" aria-label={`The ${pending.length} ${noun.many}`}>
          {#each pending as item (item.key)}
            <li><b>{item.label}</b>{#if item.note}<span class="note">{item.note}</span>{/if}</li>
          {/each}
        </ul>
      {:else if pending[0]?.note}
        <p class="single-note">{pending[0].note}</p>
      {/if}
    {/if}
    <p class="progress" role="status">{phase === 'working' ? progressText(noun, view?.done ?? 0, pending.length) : ''}</p>
  </div>
  <footer>
    {#if round}
      <button bind:this={closeButton} class="lb-btn" type="button" onclick={() => dialog?.close()}>Close</button>
      <button class="lb-btn lb-btn-danger" type="button" onclick={() => void confirm()}>Try again</button>
    {:else}
      <button bind:this={cancelButton} class="lb-btn" type="button" disabled={phase === 'working'} onclick={() => dialog?.close()}>Cancel</button>
      <button class="lb-btn lb-btn-danger" type="button" aria-disabled={phase === 'working' ? 'true' : undefined} onclick={() => void confirm()}
      >{phase === 'working' ? 'Deleting…' : deleteLabel(noun, pending.length)}</button>
    {/if}
  </footer>
</dialog>

<style>
  .confirm-dialog { width: min(480px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); padding: 0; border: 1px solid var(--lb-line-strong); border-radius: var(--lb-r-xl);
    color: var(--lb-ink); background: var(--lb-surface); box-shadow: var(--lb-shadow-lg); font-family: var(--lb-font); font-size: var(--lb-fs-body); text-align: left; }
  .confirm-dialog[open] { display: grid; grid-template-rows: minmax(0, 1fr) auto; }
  .confirm-dialog::backdrop { background: rgba(10, 16, 12, .56); backdrop-filter: blur(3px); }
  .body { min-height: 0; overflow-y: auto; display: grid; align-content: start; gap: var(--lb-s3); padding: var(--lb-s5) var(--lb-s5) var(--lb-s4); }
  h2 { margin: 0; color: var(--lb-ink); font-size: 1.125rem; line-height: 1.3; font-weight: 700; letter-spacing: -.01em; overflow-wrap: anywhere; }
  p { margin: 0; color: var(--lb-ink-2); font-size: var(--lb-fs-body); line-height: 1.5; }
  .names { max-height: min(40dvh, 280px); overflow-y: auto; margin: 0; padding: 4px 0; list-style: none; border: 1px solid var(--lb-line); border-radius: var(--lb-r-md);
    background: var(--lb-surface-2); }
  .names li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; padding: 6px 12px; font-size: var(--lb-fs-small); line-height: 1.4; }
  .names li + li { border-top: 1px solid var(--lb-line); }
  .names b { min-width: 0; color: var(--lb-ink); font-weight: 600; overflow-wrap: anywhere; }
  .note, .single-note { color: var(--lb-warn); font-size: var(--lb-fs-micro); font-weight: 650; }
  .failures .why { flex-basis: 100%; color: var(--lb-danger); }
  .aside { color: var(--lb-ink); font-weight: 600; }
  .failed { display: grid; gap: var(--lb-s3); }
  .progress { color: var(--lb-ink-3); font-size: var(--lb-fs-small); }
  /* Empty, the live region stays in the page (so its next message is read) but takes no room. */
  .progress:empty { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  footer { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: var(--lb-s2); padding: var(--lb-s3) var(--lb-s5); border-top: 1px solid var(--lb-line);
    background: var(--lb-surface-2); border-radius: 0 0 var(--lb-r-xl) var(--lb-r-xl); }
  .lb-btn-danger:hover:not([disabled]):not([aria-disabled="true"]) { background: #6f2222; border-color: #6f2222; }
  .lb-btn-danger[aria-disabled="true"] { opacity: .75; cursor: progress; }
  @media (max-width: 479px) { footer .lb-btn { flex: 1 1 auto; } }
  @media (forced-colors: active) { .lb-btn-danger { border: 1px solid ButtonText; } }
</style>
