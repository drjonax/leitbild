<script lang="ts" generics="T extends DeleteItem">
  // Confirm a delete of one or many things (Workspaces, simulations): a
  // native modal dialog that names what goes, starts on Cancel and needs one
  // click on the count-specific danger button. While it works it says how far
  // it got and Esc does nothing; afterwards it closes on success, or lists
  // what failed and why, with "Try again" for just those. The runner and the
  // words live in bulk-delete.ts.
  import { tick } from 'svelte'
  import {
    deleteEach, deleteLabel, deleteTitle, failureTitle, progressText, type DeleteFailure, type DeleteItem, type Noun, type RemoveOutcome,
  } from './bulk-delete.ts'

  let { open = $bindable(false), items, noun, body, remove, onfinished, returnFocus }: {
    open: boolean
    /** What the visitor chose to delete; read when the dialog opens. */
    items: ReadonlyArray<T>
    noun: Noun
    /** What deleting means, e.g. "Its simulations and conversations are deleted for everyone. This cannot be undone." */
    body: string
    remove: (item: T) => Promise<RemoveOutcome>
    /** Once the dialog has closed: what was deleted (or already gone), possibly nothing. */
    onfinished?: (removed: ReadonlyArray<T>) => void
    /** Where focus goes when the control that opened the dialog is gone or hidden. */
    returnFocus?: () => void
  } = $props()

  type Phase = 'confirm' | 'working' | 'failed'
  const uid = `confirm-${Math.random().toString(36).slice(2, 8)}`
  let dialog = $state<HTMLDialogElement | null>(null)
  let cancelButton = $state<HTMLButtonElement | null>(null)
  let retryButton = $state<HTMLButtonElement | null>(null)
  let phase = $state<Phase>('confirm')
  /** The items this round deletes: all at first, then the failed ones. */
  let pending = $state<ReadonlyArray<T>>([])
  let removed = $state<ReadonlyArray<T>>([])
  let failures = $state<ReadonlyArray<DeleteFailure<T>>>([])
  let done = $state(0)
  let opener: HTMLElement | null = null
  const title = $derived(phase === 'failed' ? failureTitle(noun, failures.length, pending.length) : deleteTitle(noun, pending))

  $effect(() => {
    if (!dialog) return
    if (open && !dialog.open) {
      const active = document.activeElement
      opener = active instanceof HTMLElement && active !== document.body ? active : null
      pending = [...items]
      removed = []
      failures = []
      done = 0
      phase = 'confirm'
      dialog.showModal()
      // Cancel first: a destructive dialog never starts on the destructive control (a11y M7).
      void tick().then(() => cancelButton?.focus())
    } else if (!open && dialog.open) dialog.close()
  })

  const onclose = (): void => {
    open = false
    // A ⋯ menu item has closed with its menu, and a deleted row is gone: then the caller says where.
    const target = opener?.isConnected && opener.checkVisibility() ? opener : null
    opener = null
    if (target) target.focus()
    else returnFocus?.()
    onfinished?.(removed)
  }

  const confirm = async (): Promise<void> => {
    if (phase === 'working' || pending.length === 0) return
    phase = 'working'
    done = 0
    const result = await deleteEach(pending, remove, { onprogress: count => { done = count } })
    removed = [...removed, ...result.removed]
    if (result.failed.length === 0) {
      dialog?.close()
      return
    }
    failures = result.failed
    phase = 'failed'
    await tick()
    retryButton?.focus()
  }

  const retry = (): void => {
    pending = failures.map(failure => failure.item)
    failures = []
    void confirm()
  }
</script>

<dialog class="confirm-dialog" bind:this={dialog} aria-labelledby={`${uid}-title`} aria-describedby={`${uid}-body`} {onclose}
  oncancel={event => { if (phase === 'working') event.preventDefault() }}
>
  <div class="body">
    <h2 id={`${uid}-title`}>{title}</h2>
    {#if phase === 'failed'}
      <p id={`${uid}-body`}>{removed.length > 0 ? `${removed.length} deleted. ` : ''}{failures.length === 1 ? 'This one is still there:' : 'These are still there:'}</p>
      <ul class="names failures" role="alert">
        {#each failures as failure (failure.item.key)}
          <li><b>{failure.item.label}</b><span class="why">{failure.text}</span></li>
        {/each}
      </ul>
    {:else}
      <p id={`${uid}-body`}>{body}</p>
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
    <p class="progress" role="status">{phase === 'working' ? progressText(noun, done, pending.length) : ''}</p>
  </div>
  <footer>
    {#if phase === 'failed'}
      <button class="lb-btn" type="button" onclick={() => dialog?.close()}>Close</button>
      <button bind:this={retryButton} class="lb-btn lb-btn-danger" type="button" onclick={retry}>Try again</button>
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
  .progress { color: var(--lb-ink-3); font-size: var(--lb-fs-small); }
  .progress:empty { display: none; }
  footer { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: var(--lb-s2); padding: var(--lb-s3) var(--lb-s5); border-top: 1px solid var(--lb-line);
    background: var(--lb-surface-2); border-radius: 0 0 var(--lb-r-xl) var(--lb-r-xl); }
  .lb-btn-danger:hover:not([disabled]):not([aria-disabled="true"]) { background: #6f2222; border-color: #6f2222; }
  .lb-btn-danger[aria-disabled="true"] { opacity: .75; cursor: progress; }
  @media (max-width: 479px) { footer .lb-btn { flex: 1 1 auto; } }
  @media (forced-colors: active) { .lb-btn-danger { border: 1px solid ButtonText; } }
</style>
