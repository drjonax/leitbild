<script lang="ts">
  // Delete a Workspace (plan v2 §6.2, rule 14): a native modal dialog that
  // names the Workspace, starts on Cancel, and enables Delete only when the
  // Workspace's name (or the short id of an unnamed one) is typed exactly.
  // The outcome is always said: deleted, already gone, or why it failed.
  import { tick } from 'svelte'
  import type { Workspace } from '@leitbild/contracts'
  import { workspaceLabel } from './launch-workspace.ts'
  import type { DeleteOutcome, WorkspaceAdmin } from './workspace-admin.ts'
  import { confirmsDeletion, deleteConfirmationText } from './workspace-page.ts'

  let { open = $bindable(false), workspace, admin, ondeleted, returnFocus }: {
    open: boolean
    workspace: Workspace
    admin: WorkspaceAdmin
    /** Called once the visitor has read the outcome; the page then leaves for /workspaces. */
    ondeleted: () => void
    returnFocus: () => void
  } = $props()

  type Phase = 'confirm' | 'deleting' | 'failed' | 'done'
  let dialog = $state<HTMLDialogElement | null>(null)
  let cancelButton = $state<HTMLButtonElement | null>(null)
  let doneButton = $state<HTMLButtonElement | null>(null)
  let typed = $state('')
  let phase = $state<Phase>('confirm')
  let failure = $state('')
  let outcome = $state<DeleteOutcome | null>(null)
  const label = $derived(workspaceLabel(workspace, 'header'))
  const expected = $derived(deleteConfirmationText(workspace))
  const matches = $derived(confirmsDeletion(typed, workspace))

  $effect(() => {
    if (!dialog) return
    if (open && !dialog.open) {
      typed = ''
      phase = 'confirm'
      failure = ''
      outcome = null
      dialog.showModal()
      // Cancel first: a destructive dialog never starts on the destructive control (a11y M7).
      void tick().then(() => cancelButton?.focus())
    } else if (!open && dialog.open) dialog.close()
  })

  const onclose = (): void => {
    open = false
    if (outcome?.kind === 'deleted' || outcome?.kind === 'gone') ondeleted()
    else returnFocus()
  }

  const remove = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault()
    if (!matches || phase === 'deleting') return
    phase = 'deleting'
    failure = ''
    const result = await admin.remove(workspace.id)
    if (result.kind === 'failed') {
      phase = 'failed'
      failure = result.text
      return
    }
    outcome = result
    phase = 'done'
    await tick()
    doneButton?.focus()
  }
</script>

<dialog class="delete-dialog" bind:this={dialog} aria-labelledby="delete-title" aria-describedby="delete-body" {onclose}
  oncancel={event => { if (phase === 'deleting') event.preventDefault() }}
>
  {#if phase === 'done'}
    <div class="body">
      <h2 id="delete-title">{outcome?.kind === 'gone' ? `${label} no longer exists` : `${label} was deleted`}</h2>
      <p id="delete-body" role="status">{outcome?.kind === 'gone'
        ? 'Someone else deleted it first.'
        : 'Its simulations and conversations are gone for everyone.'}</p>
    </div>
    <footer><button bind:this={doneButton} class="lb-btn lb-btn-primary" type="button" onclick={() => dialog?.close()}>Back to Workspaces</button></footer>
  {:else}
    <form onsubmit={remove}>
      <div class="body">
        <h2 id="delete-title">Delete {label}?</h2>
        <p id="delete-body">This deletes its simulations and conversations for everyone. It cannot be undone.</p>
        <label class="confirm" for="delete-confirm">
          <span>Type <b class="expected">{expected}</b> to confirm{workspace.name === null ? ' (the Workspace’s short id)' : ''}</span>
          <input id="delete-confirm" class="lb-input" bind:value={typed} autocomplete="off" autocapitalize="off" spellcheck="false"
            disabled={phase === 'deleting'} aria-describedby={failure ? 'delete-error' : undefined} aria-invalid={failure ? 'true' : undefined} />
        </label>
        {#if failure}<p id="delete-error" class="error" role="alert">{failure}</p>{/if}
        {#if phase === 'deleting'}<p class="progress" role="status">Deleting {label}…</p>{/if}
      </div>
      <footer>
        <button bind:this={cancelButton} class="lb-btn" type="button" disabled={phase === 'deleting'} onclick={() => dialog?.close()}>Cancel</button>
        <button class="lb-btn lb-btn-danger" type="submit" disabled={!matches || phase === 'deleting'}>{phase === 'deleting' ? 'Deleting…' : 'Delete Workspace'}</button>
      </footer>
    </form>
  {/if}
</dialog>

<style>
  .delete-dialog { width: min(480px, calc(100vw - 32px)); padding: 0; border: 1px solid var(--lb-line-strong); border-radius: var(--lb-r-xl);
    color: var(--lb-ink); background: var(--lb-surface); box-shadow: var(--lb-shadow-lg); }
  .delete-dialog::backdrop { background: rgba(10, 16, 12, .56); backdrop-filter: blur(3px); }
  .body { display: grid; gap: var(--lb-s3); padding: var(--lb-s5) var(--lb-s5) var(--lb-s4); }
  h2 { margin: 0; font-size: 1.125rem; line-height: 1.3; font-weight: 700; letter-spacing: -.01em; overflow-wrap: anywhere; }
  p { margin: 0; color: var(--lb-ink-2); font-size: var(--lb-fs-body); line-height: 1.5; }
  .confirm { display: grid; gap: 6px; color: var(--lb-ink-2); font-size: var(--lb-fs-small); }
  .expected { color: var(--lb-ink); font-weight: 700; overflow-wrap: anywhere; }
  .error { color: var(--lb-danger); font-size: var(--lb-fs-small); font-weight: 600; }
  .progress { color: var(--lb-ink-3); font-size: var(--lb-fs-small); }
  footer { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: var(--lb-s2); padding: var(--lb-s3) var(--lb-s5); border-top: 1px solid var(--lb-line);
    background: var(--lb-surface-2); border-radius: 0 0 var(--lb-r-xl) var(--lb-r-xl); }
  .lb-btn-danger:hover:not([disabled]) { background: #6f2222; border-color: #6f2222; }
  @media (forced-colors: active) { .lb-btn-danger { border: 1px solid ButtonText; } }
</style>
