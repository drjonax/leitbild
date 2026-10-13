<script lang="ts">
  // Manage Workspaces (`/workspaces?manage`): every Workspace with a box to
  // tick, "Select all", and one Delete for the ticked ones, plus a Delete on
  // each row. Both ask once in ConfirmDialog, which deletes through the Host
  // (a few at a time) and lists any that failed. A Workspace whose delete did
  // not finish is deleted again from here. Each row says what its Modules
  // report running there, polled while Manage is open, and "Select these"
  // ticks the Workspaces with work running now. Rows and activity: workspace-manage.ts.
  import type { Workspace } from '@leitbild/contracts'
  import ConfirmDialog from './ConfirmDialog.svelte'
  import Icon from './Icon.svelte'
  import Modal from './Modal.svelte'
  import { deletedText, deleteLabel, keepExisting, selectAllState, toggleAll, toggleOne, WORKSPACE_NOUN } from './bulk-delete.ts'
  import { errorDiagnostic, plainErrorText } from './error-text.ts'
  import type { WorkspaceApi } from './launch-workspace.ts'
  import type { ModalCloseReason } from './modal-url.ts'
  import { createWorkspaceAdmin } from './workspace-admin.ts'
  import {
    activityHead, activityText, createActivityPoller, MANAGE_INTRO, MANAGE_TITLE, manageRows, nextActivity, notRecentText,
    selectActiveLabel, STALE_ACTIVITY_SUFFIX, withActivityNotes, type ManageRow, type ShownActivity,
  } from './workspace-manage.ts'
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
  let modal = $state<{ focusTitle(): void } | null>(null)
  let listRequest = 0
  let activity = $state.raw<ShownActivity | null>(null)
  let selectActiveButton = $state<HTMLButtonElement | null>(null)

  const rows = $derived(workspaces === null ? [] : manageRows(workspaces, { recent: memory.recent(), now }))
  const shown = $derived(query.trim() ? filterRows(rows, query) : rows)
  const allState = $derived(selectAllState(shown, selected))
  const chosen = $derived(rows.filter(row => selected.has(row.id)))
  const byWorkspace = $derived(activity?.byWorkspace ?? new Map())
  const head = $derived(activityHead(rows, activity))
  const activeIds = $derived(head.activeIds)

  $effect(() => { if (selectAllBox) selectAllBox.indeterminate = allState === 'some' })

  // "Select these" goes when nothing runs any more; if it had focus, focus moves to Select all
  // before the button leaves the page, so a keyboard user is never dropped on the body.
  $effect.pre(() => {
    if (activeIds.length === 0 && selectActiveButton !== null && document.activeElement === selectActiveButton) selectAllBox?.focus()
  })

  const load = async (): Promise<void> => {
    // A newer read owns the list: an older answer arriving late never overwrites it.
    const token = ++listRequest
    loading = true
    loadError = null
    try {
      const listed = await api.list()
      if (token !== listRequest) return
      workspaces = listed
      now = new Date()
      selected = keepExisting(selected, listed.map(workspace => ({ key: workspace.id })))
    } catch (error) {
      if (token !== listRequest) return
      console.error('Workspace list failed', errorDiagnostic(error))
      loadError = plainErrorText(error)
    } finally {
      if (token === listRequest) loading = false
    }
  }

  // An answer that fails keeps the last labels, marked as not current, until the next good one.
  const poller = createActivityPoller({
    read: signal => api.activity(signal),
    hidden: () => document.hidden,
    onanswer: answer => {
      const before = head.problem
      activity = nextActivity(activity, answer, new Date())
      if (head.problem === before) return
      if (!answer.ok) console.error('Workspace activity failed', errorDiagnostic(answer.error))
      else for (const outcome of answer.catalog.modules) if (outcome.status === 'failed') console.error(`Workspace activity of ${outcome.moduleId} failed`, errorDiagnostic(outcome.failure))
    },
  })

  let wasOpen = false
  $effect(() => {
    if (open && !wasOpen) {
      workspaces = null
      query = ''
      selected = new Set()
      status = ''
      activity = null
      void load()
    }
    wasOpen = open
  })

  // While Manage is open: now, every 15 s while the page is visible, and at once when it is shown again.
  $effect(() => {
    if (!open) return
    const onvisibility = (): void => poller.visibilityChanged()
    poller.start()
    document.addEventListener('visibilitychange', onvisibility)
    return () => {
      document.removeEventListener('visibilitychange', onvisibility)
      poller.stop()
    }
  })

  const ask = (items: ReadonlyArray<ManageRow>): void => {
    if (items.length === 0) return
    targets = withActivityNotes(items, byWorkspace)
    status = ''
    confirming = true
  }
  const finished = async (removed: ReadonlyArray<ManageRow>): Promise<void> => {
    // Even a delete that failed may have stopped some of a Workspace's work.
    poller.refresh()
    if (removed.length === 0) return
    // A deleted Workspace is no longer a launch default or a Recent entry.
    for (const row of removed) memory.forget(row.id)
    status = deletedText(WORKSPACE_NOUN, removed)
    await load()
  }
  // Called once the list was read again: the deleted rows and their buttons are gone, so focus goes
  // to what is left of the list, or to the dialog's title when nothing is.
  const focusAfterDelete = (): void => {
    if (list?.isConnected) list.focus()
    else modal?.focusTitle()
  }
</script>

<Modal bind:this={modal} bind:open title={MANAGE_TITLE} width="640px" {onclose} {fallbackFocus}>
  <div class="manage">
    <p class="intro">{MANAGE_INTRO}</p>
    {#if workspaces === null && loading}
      <p class="muted" role="status">Loading Workspaces…</p>
    {:else if loadError}
      <div class="failed"><p role="alert">{loadError}</p><button class="lb-btn lb-btn-sm" type="button" onclick={() => void load()}>Try again</button></div>
    {:else if rows.length === 0}
      <p class="muted">There are no Workspaces.</p>
    {:else}
      <!-- Always one line at least (checking, nothing, running work or what could not be checked), so the list never moves down when it arrives. -->
      <div class="activity-head">
        {#if head.summary}<p class="activity-summary" class:active={head.summary.active} id={`${uid}-summary`}
          >{#if head.summary.active}<span class="summary-dot" class:stale={!head.summary.current} aria-hidden="true"></span>{/if}{head.summary.text}</p>{/if}
        {#if head.problem}<p class="activity-problem">{head.problem}</p>{/if}
      </div>
      <div class="tools">
        <div class="picks">
          <label class="select-all">
            <input bind:this={selectAllBox} type="checkbox" checked={allState === 'all'} onchange={() => { selected = toggleAll(shown, selected) }} />
            <span>Select all{query.trim() ? ' shown' : ''} <span class="muted-count">({shown.length})</span></span>
          </label>
          {#if activeIds.length > 0}
            <button bind:this={selectActiveButton} class="select-active" type="button" aria-describedby={`${uid}-summary`} onclick={() => { selected = new Set(activeIds) }}
            >{selectActiveLabel(activeIds.length)}</button>
          {/if}
        </div>
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
          {@const items = byWorkspace.get(row.id)}
          <li class:checked={selected.has(row.id)}>
            <input id={`${uid}-${row.id}`} type="checkbox" checked={selected.has(row.id)} onchange={() => { selected = toggleOne(selected, row.id) }} />
            <label for={`${uid}-${row.id}`}>
              <span class="name" class:untitled={row.untitled}>{row.label}</span>
              <span class="meta"><span title={row.createdExact}>{row.created}</span>{#if row.recent}<span class="tag">Recent in this browser</span>{/if}{#if row.note}<span class="state">{row.note}</span>{/if}</span>
              {#if items}
                <!-- The words are activityText's; the line people see is the same labels with a dot for running work. It is inline
                     text, so a long line wraps between words, a dot stays with its label and a "·" ends a line rather than starting one. -->
                <span class="activity"><span class="visually-hidden">{activityText(items)}{items.some(item => item.stale) ? STALE_ACTIVITY_SUFFIX : ''}</span
                  ><span aria-hidden="true">{#each items as item (`${item.moduleId}:${item.key}`)}<span class="item" class:active={item.active} class:stale={item.stale}
                    >{#if item.active}<span class="dot">●</span>{'\u00a0'}{/if}{item.label}</span>{' '}{/each}</span></span>
              {/if}
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
    <span class="count">{chosen.length > 0 ? `${chosen.length} selected` : status || 'Tick Workspaces to delete several at once.'}</span>
    <button class="lb-btn lb-btn-danger" type="button" disabled={chosen.length === 0} onclick={() => ask(chosen)}
    ><Icon name="trash" size={16} />{deleteLabel(WORKSPACE_NOUN, chosen.length)}</button>
  {/snippet}
</Modal>

<ConfirmDialog bind:open={confirming} items={targets} noun={WORKSPACE_NOUN} aside={notRecentText(targets, memory.recent())}
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
  .activity-head { display: grid; gap: 2px; min-height: calc(var(--lb-fs-small) * 1.45); }
  .activity-head p { margin: 0; font-size: var(--lb-fs-small); line-height: 1.45; }
  .activity-summary { display: flex; align-items: center; gap: 8px; color: var(--lb-ink-3); }
  .activity-summary.active { color: var(--lb-ink-2); font-weight: 500; }
  .activity-problem { color: var(--lb-ink-3); }
  .tools { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--lb-s2) var(--lb-s4); }
  .picks { display: flex; flex-wrap: wrap; align-items: center; gap: 0 var(--lb-s1); }
  .select-active { min-height: 40px; padding: 0 10px; border: 0; border-radius: var(--lb-r-sm); background: none; color: var(--lb-accent); font: inherit;
    font-size: .875rem; font-weight: 600; cursor: pointer; }
  .select-active:hover { text-decoration: underline; text-underline-offset: 2px; }
  .select-active:focus-visible { outline: 2px solid var(--lb-focus); outline-offset: 2px; }
  @media (pointer: coarse) { .select-active { min-height: 44px; } }
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
  .activity { color: var(--lb-ink-3); font-size: var(--lb-fs-micro); line-height: 1.45; overflow-wrap: anywhere; }
  .activity .item.active { color: var(--lb-ink); font-weight: 600; }
  .activity .item.stale { color: var(--lb-ink-3); font-weight: 500; }
  .activity .item:not(:last-child)::after { content: '\00a0·'; color: var(--lb-ink-3); font-weight: 400; }
  .dot { color: var(--lb-ok); font-size: .85em; }
  .item.stale .dot { color: var(--lb-control); }
  .summary-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--lb-ok); }
  .summary-dot.stale { background: var(--lb-control); }
  .row-delete { color: var(--lb-ink-2); }
  .row-delete:hover { color: var(--lb-danger); background: rgba(138, 45, 45, .08); }
  .count { flex: 1; min-width: 0; color: var(--lb-ink-2); font-size: var(--lb-fs-small); }
  @media (max-width: 639px) {
    .manage { padding: var(--lb-s3) var(--lb-s4) var(--lb-s4); }
    .search { max-width: none; }
  }
  @media (forced-colors: active) {
    .rows li.checked { outline: 2px solid Highlight; outline-offset: -2px; }
    .summary-dot { background: CanvasText; }
  }
</style>
