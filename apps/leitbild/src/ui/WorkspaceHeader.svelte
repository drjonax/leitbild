<script lang="ts">
  // The Workspace page header (plan v2 §6.1): the name, the public note, Copy
  // link and a ⋯ disclosure with Rename and Delete Workspace…. Delete asks
  // once, in a modal that names the Workspace. Several are deleted at once in
  // Manage Workspaces, linked from the Workspaces switcher and the landing footer.
  import type { Workspace } from '@leitbild/contracts'
  import ConfirmDialog from './ConfirmDialog.svelte'
  import Icon from './Icon.svelte'
  import InlineName from './InlineName.svelte'
  import MoreMenu from './MoreMenu.svelte'
  import { WORKSPACE_NOUN } from './bulk-delete.ts'
  import { plainErrorText } from './error-text.ts'
  import { shortDate, workspaceLabel } from './launch-workspace.ts'
  import type { WorkspaceAdmin } from './workspace-admin.ts'
  import { workspaceShareUrl } from './workspace-admin.ts'
  import { PUBLIC_NOTE } from './workspace-page.ts'

  let { workspace, admin, onrenamed, ondeleted }: {
    workspace: Workspace
    admin: WorkspaceAdmin
    onrenamed: (workspace: Workspace) => void
    /** The Workspace is gone (deleted here, or already by someone else). */
    ondeleted: () => void
  } = $props()

  const label = $derived(workspaceLabel(workspace, 'header'))
  let nameField = $state<{ edit(): Promise<void> } | null>(null)
  let menu = $state<{ focus(): void } | null>(null)
  let deleting = $state(false)
  let copyStatus = $state('')
  let copyTimer: ReturnType<typeof setTimeout> | undefined

  const copyLink = async (): Promise<void> => {
    clearTimeout(copyTimer)
    try {
      await navigator.clipboard.writeText(workspaceShareUrl(location.origin, workspace.id))
      copyStatus = 'Link copied.'
    } catch {
      copyStatus = 'Could not copy the link. Copy it from the address bar.'
    }
    copyTimer = setTimeout(() => { copyStatus = '' }, 4_000)
  }

  const rename = async (name: string): Promise<void> => {
    try { onrenamed(await admin.rename(workspace.id, name)) }
    catch (cause) { throw new Error(plainErrorText(cause)) }
  }
</script>

<header class="ws-head">
  <div class="titles">
    <span class="lb-eyebrow">Workspace</span>
    <h1 id="workspace-title"><InlineName bind:this={nameField} value={workspace.name ?? ''} fallback={label} label="Workspace name"
      pencil={false} onsave={rename} onclose={reason => { if (reason !== 'blurred') menu?.focus() }} /></h1>
    <p class="meta">Created {shortDate(new Date(workspace.createdAt))} · {PUBLIC_NOTE}</p>
  </div>
  <div class="actions">
    <button class="lb-btn lb-btn-sm" type="button" onclick={() => void copyLink()}><Icon name="link" size={16} />Copy link</button>
    <MoreMenu bind:this={menu} label="More Workspace actions" items={[
      { label: 'Rename', icon: 'edit', onselect: () => void nameField?.edit() },
      { label: 'Delete Workspace…', danger: true, onselect: () => { deleting = true } },
    ]} />
    <p class="copy-status" role="status">{copyStatus}</p>
  </div>
</header>

<ConfirmDialog bind:open={deleting} items={[{ key: workspace.id, label }]} noun={WORKSPACE_NOUN}
  body="Its simulations and conversations are deleted for everyone. This cannot be undone."
  remove={item => admin.remove(item.key)} onfinished={removed => { if (removed.length > 0) ondeleted() }} returnFocus={() => menu?.focus()} />

<style>
  .ws-head { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--lb-s4) var(--lb-s5); flex-wrap: wrap; }
  .titles { min-width: 0; display: grid; gap: 6px; }
  h1 { margin: 0; color: var(--lb-ink); font-size: var(--lb-fs-h1); line-height: 1.15; font-weight: 750; letter-spacing: -.025em; overflow-wrap: anywhere; }
  h1 :global(.inline-name) { font-weight: inherit; }
  h1 :global(.inline-name input) { width: min(520px, 80vw); min-height: 44px; padding: .2rem .5rem; border: 1px solid var(--lb-control); border-radius: var(--lb-r-md); font: inherit; letter-spacing: inherit; }
  h1 :global(.inline-name input:focus-visible) { outline: 2px solid var(--lb-focus); outline-offset: 2px; }
  .meta { margin: 0; color: var(--lb-ink-3); font-size: var(--lb-fs-small); line-height: 1.45; }
  .actions { position: relative; display: flex; align-items: center; gap: var(--lb-s2); }
  .actions :global(.lb-btn-sm) { min-height: 36px; }
  .copy-status { position: absolute; top: calc(100% + 4px); right: 0; margin: 0; color: var(--lb-ok); font-size: var(--lb-fs-micro); font-weight: 600; white-space: nowrap; }
  @media (pointer: coarse) { .actions :global(.lb-btn-sm) { min-height: 44px; } }
</style>
