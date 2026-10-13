<script lang="ts">
  // Manage Workspaces (`/workspaces?manage`): every Workspace with a box to
  // tick, "Select all", and one Delete for the ticked ones, plus a Delete on
  // each row. Both ask once in ConfirmDialog, which deletes through the Host
  // (a few at a time) and lists any that failed. A Workspace whose delete did
  // not finish is deleted again from here. Rows: workspace-manage.ts.
  import { tick } from 'svelte'
  import type { Workspace } from '@leitbild/contracts'
  import ConfirmDialog from './ConfirmDialog.svelte'
  import Icon from './Icon.svelte'
  import Modal from './Modal.svelte'
  import { deletedText, deleteLabel, keepExisting, selectAllState, toggleAll, toggleOne, WORKSPACE_NOUN } from './bulk-delete.ts'
  import { errorDiagnostic, plainErrorText } from './error-text.ts'
  import type { WorkspaceApi } from './launch-workspace.ts'
  import type { ModalCloseReason } from './modal-url.ts'
  import { createWorkspaceAdmin } from './workspace-admin.ts'
  import { MANAGE_INTRO, MANAGE_TITLE, manageRows, type ManageRow } from './workspace-manage.ts'
  import type { WorkspaceMemory } from './workspace-memory.ts'
  import { filterRows, SEARCH_THRESHOLD } from './workspace-switcher.ts'

  let { open = $bindable(false), api, memory, onclose, fallbackFocus }: {
    open: boolean
    api: WorkspaceApi
    memory: WorkspaceMemory
    onclose?: (reason: ModalCloseReason) => void
    fallbackFocus?: () => HTMLElement | null
  } = $props()

  const uid = `manage-${Math.random().toString(36).slice(2, 8)}`
  const admin = createWorkspaceAdmin()
  let workspaces = $state<ReadonlyArray<Workspace> | null>(null)
  let loading = $state(false)
  let loadError = $state<string | null>(null)
  let now = $state(new Date())
  let query = $state('')
  let selected = $state<ReadonlySet<string>>(new Set())
  let targets = $state<ReadonlyArray<ManageRow>>([])
  let confirming = $state(false)
  let status = $state('')
  let selectAllBox = $state<HTMLInputElement | null>(null)
  let list = $state<HTMLElement | null>(null)

  const rows = $derived(workspaces === null ? [] : manageRows(workspaces, { recent: memory.recent(), now }))
  const shown = $derived(query.trim() ? filterRows(rows, query) : rows)
  const allState = $derived(selectAllState(shown, selected))
  const chosen = $derived(rows.filter(row => selected.has(row.id)))

  $effect(() => { if (selectAllBox) selectAllBox.indeterminate = allState === 'some' })

  const load = async (): Promise<void> => {
    loading = true
    loadError = null
    try {
      workspaces = await api.list()
      now = new Date()
      selected = keepExisting(selected, workspaces.map(workspace => ({ key: workspace.id })))
    } catch (error) {
      console.error('Workspace list failed', errorDiagnostic(error))
      loadError = plainErrorText(error)
    } finally {
      loading = false
    }
  }

  let wasOpen = false
  $effect(() => {
    if (open && !wasOpen) {
      workspaces = null
      query = ''
      selected = new Set()
      status = ''
      void load()
    }
    wasOpen = open
  })

  const ask = (items: ReadonlyArray<ManageRow>): void => {
    if (items.length === 0) return
    targets = items
    status = ''
    confirming = true
  }
  const finished = (removed: ReadonlyArray<ManageRow>): void => {
    if (removed.length === 0) return
    // A deleted Workspace is no longer a launch default or a Recent entry.
    for (const row of removed) memory.forget(row.id)
    status = deletedText(WORKSPACE_NOUN, removed)
    void load()
  }
  // A deleted row's Delete button is gone: focus goes to the list, which says what is left.
  const focusAfterDelete = (): void => { void tick().then(() => (list ?? selectAllBox)?.focus()) }
</script>

<Modal bind:open title={MANAGE_TITLE} width="640px" {onclose} {fallbackFocus}>
  <div class="manage">
    <p class="intro">{MANAGE_INTRO}</p>
    {#if workspaces === null && loading}
      <p class="muted" role="status">Loading Workspaces…</p>
    {:else if loadError}
      <div class="failed"><p role="alert">{loadError}</p><button class="lb-btn lb-btn-sm" type="button" onclick={() => void load()}>Try again</button></div>
    {:else if rows.length === 0}
      <p class="muted">There are no Workspaces.</p>
    {:else}
      <div class="tools">
        <label class="select-all">
          <input bind:this={selectAllBox} type="checkbox" checked={allState === 'all'} onchange={() => { selected = toggleAll(shown, selected) }} />
          <span>Select all{query.trim() ? ' shown' : ''} <span class="muted-count">({shown.length})</span></span>
        </label>
        {#if rows.length > SEARCH_THRESHOLD}
          <label class="search">
            <span class="visually-hidden">Find a Workspace</span>
            <Icon name="search" size={16} class="search-icon" />
            <input class="lb-input" type="search" placeholder="Find a Workspace" autocomplete="off" bind:value={query} />
          </label>
        {/if}
      </div>
      <ul class="rows" bind:this={list} tabindex="-1" aria-label={`Workspaces (${rows.length})`}>
        {#each shown as row (row.id)}
          <li class:checked={selected.has(row.id)}>
            <input id={`${uid}-${row.id}`} type="checkbox" checked={selected.has(row.id)} onchange={() => { selected = toggleOne(selected, row.id) }} />
            <label for={`${uid}-${row.id}`}>
              <span class="name" class:untitled={row.untitled}>{row.label}</span>
              <span class="meta"><span title={row.createdExact}>{row.created}</span>{#if row.recent}<span class="tag">Recent in this browser</span>{/if}{#if row.note}<span class="state">{row.note}</span>{/if}</span>
            </label>
            <button class="lb-icon-btn row-delete" type="button" aria-label={`Delete ${row.label}`} title={`Delete ${row.label}`} onclick={() => ask([row])}><Icon name="trash" size={18} /></button>
          </li>
        {:else}
          <li class="none">No Workspace matches.</li>
        {/each}
      </ul>
    {/if}
    <p class="visually-hidden" role="status">{status}</p>
  </div>
  {#snippet footer()}
    <span class="count">{selected.size > 0 ? `${selected.size} selected` : status || 'Tick Workspaces to delete several at once.'}</span>
    <button class="lb-btn lb-btn-danger" type="button" disabled={chosen.length === 0} onclick={() => ask(chosen)}
    ><Icon name="trash" size={16} />{deleteLabel(WORKSPACE_NOUN, chosen.length)}</button>
  {/snippet}
</Modal>

<ConfirmDialog bind:open={confirming} items={targets} noun={WORKSPACE_NOUN}
  body={targets.length === 1
    ? 'Its simulations and conversations are deleted for everyone. This cannot be undone.'
    : 'Their simulations and conversations are deleted for everyone. This cannot be undone.'}
  remove={row => admin.remove(row.id)} onfinished={finished} returnFocus={focusAfterDelete} />

<style>
  .manage { display: grid; gap: var(--lb-s3); padding: var(--lb-s4) var(--lb-s5) var(--lb-s5); }
  .intro { margin: 0; color: var(--lb-ink-2); font-size: var(--lb-fs-small); line-height: 1.5; }
  .muted { margin: 0; color: var(--lb-ink-3); font-size: var(--lb-fs-small); }
  .failed { display: flex; flex-wrap: wrap; align-items: center; gap: var(--lb-s3); }
  .failed p { margin: 0; color: var(--lb-danger); font-size: var(--lb-fs-small); }
  .tools { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--lb-s2) var(--lb-s4); }
  .select-all { display: inline-flex; align-items: center; gap: 10px; min-height: 40px; padding: 0 12px; color: var(--lb-ink); font-size: .875rem; font-weight: 600; cursor: pointer; }
  .muted-count { color: var(--lb-ink-3); font-weight: 500; }
  input[type="checkbox"] { flex: none; width: 18px; height: 18px; margin: 0; padding: 0; accent-color: var(--lb-brand-700); cursor: pointer; }
  input[type="checkbox"]:focus-visible { outline: 2px solid var(--lb-focus); outline-offset: 2px; }
  .search { position: relative; flex: 1 1 220px; max-width: 320px; }
  .search :global(.search-icon) { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--lb-ink-3); pointer-events: none; }
  .search input { min-height: 40px; padding-left: 2rem; }
  .rows { margin: 0; padding: 0; list-style: none; border: 1px solid var(--lb-line); border-radius: var(--lb-r-lg); background: var(--lb-surface); }
  .rows:focus { outline: none; }
  .rows:focus-visible { outline: 2px solid var(--lb-focus); outline-offset: 2px; }
  .rows li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 2px 10px; min-height: 56px; padding: 4px 4px 4px 12px; }
  .rows li + li { border-top: 1px solid var(--lb-line); }
  .rows li.checked { background: var(--lb-brand-50); }
  .rows li.none { display: block; padding: 14px; color: var(--lb-ink-3); font-size: var(--lb-fs-small); }
  .rows label { min-width: 0; display: grid; gap: 2px; padding: 6px 0; cursor: pointer; }
  .name { overflow: hidden; color: var(--lb-ink); font-size: .9rem; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
  .name.untitled { color: var(--lb-ink-2); font-weight: 500; }
  .meta { display: flex; flex-wrap: wrap; gap: 2px 10px; color: var(--lb-ink-3); font-size: var(--lb-fs-micro); }
  .tag { color: var(--lb-accent); font-weight: 600; }
  .state { color: var(--lb-warn); font-weight: 650; }
  .row-delete { color: var(--lb-ink-2); }
  .row-delete:hover { color: var(--lb-danger); background: rgba(138, 45, 45, .08); }
  .count { flex: 1; min-width: 0; color: var(--lb-ink-2); font-size: var(--lb-fs-small); }
  @media (max-width: 639px) {
    .manage { padding: var(--lb-s3) var(--lb-s4) var(--lb-s4); }
    .search { max-width: none; }
  }
  @media (forced-colors: active) { .rows li.checked { outline: 2px solid Highlight; outline-offset: -2px; } }
</style>
