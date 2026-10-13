<script lang="ts">
  // The top bar's "Workspaces ▾" (plan v2 §3, VISUAL-SPEC §3.3). A popover at
  // ≥ 640 px and a modal sheet below. Recent in this browser first, every
  // public Workspace behind a collapsed disclosure, a quiet "Manage
  // Workspaces" link (where they are deleted) and an inline "New Workspace".
  // Row logic lives in workspace-switcher.ts.
  import { tick } from 'svelte'
  import type { Workspace } from '@leitbild/contracts'
  import Icon from './Icon.svelte'
  import { plainErrorText } from './error-text.ts'
  import { workspacePath } from './launch-destination.ts'
  import { createWorkspaceApi, newWorkspaceName, workspaceLabel, type WorkspaceApi } from './launch-workspace.ts'
  import { manageHref } from './modal-url.ts'
  import { browserWorkspaceMemory, type WorkspaceMemory } from './workspace-memory.ts'
  import {
    filterRows, matchCountText, SEARCH_THRESHOLD, SWITCHER_FOOTNOTE, SWITCHER_INTRO, switcherGroups, switcherKeyTarget,
    type SwitcherRow,
  } from './workspace-switcher.ts'

  let {
    current = null,
    currentIsPage = false,
    api = createWorkspaceApi(),
    memory = browserWorkspaceMemory(),
    now = () => new Date(),
    onmanage,
  }: {
    /** The Workspace the button names: the page's own (Workspace page) or the remembered one (landing). */
    current?: Pick<Workspace, 'id' | 'name'> | null
    /** true on the Workspace page: its row is `aria-current="page"`. */
    currentIsPage?: boolean
    api?: WorkspaceApi
    memory?: WorkspaceMemory
    now?: () => Date
    /** The landing page opens Manage Workspaces in place; elsewhere the link goes to /workspaces?manage. */
    onmanage?: (event: MouseEvent) => void
  } = $props()

  const uid = `ws-${Math.random().toString(36).slice(2, 8)}`
  const narrowQuery = typeof matchMedia === 'function' ? matchMedia('(max-width: 639px)') : null
  let narrow = $state(narrowQuery?.matches ?? false)
  $effect(() => {
    if (!narrowQuery) return
    const update = (): void => { narrow = narrowQuery.matches }
    narrowQuery.addEventListener('change', update)
    return () => narrowQuery.removeEventListener('change', update)
  })

  let open = $state(false)
  let button = $state<HTMLButtonElement | null>(null)
  let pop = $state<HTMLElement | null>(null)
  let sheet = $state<HTMLDialogElement | null>(null)
  let body = $state<HTMLElement | null>(null)
  let place = $state('')

  let workspaces = $state<ReadonlyArray<Workspace> | null>(null)
  let loading = $state(false)
  let loadError = $state<string | null>(null)
  let query = $state('')
  let browseOpen = $state(false)
  let newName = $state('')
  let defaultName = $state('')
  let creating = $state(false)
  let createError = $state<string | null>(null)
  let createStatus = $state('')

  const groups = $derived(workspaces === null
    ? { recent: [], all: [] }
    : switcherGroups(workspaces, { recent: memory.recent(), current: current?.id ?? null }))
  const showSearch = $derived((workspaces?.length ?? 0) > SEARCH_THRESHOLD)
  const matches = $derived(query.trim() ? filterRows(groups.all, query) : null)
  const countText = $derived(matches === null ? '' : matchCountText(matches.length))
  const buttonLabel = $derived(current ? `Workspace: ${workspaceLabel(current)}` : 'Workspaces')

  const load = async (): Promise<void> => {
    loading = true
    loadError = null
    try {
      workspaces = await api.list()
    } catch (error) {
      console.error('Workspace list failed', error)
      loadError = plainErrorText(error)
    } finally {
      loading = false
    }
  }

  const focusFirst = async (): Promise<void> => {
    await tick()
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
    const candidates = [...(body?.querySelectorAll<HTMLElement>('[data-nav]') ?? [])]
    // Never pop a touch keyboard: on touch, start on the first row instead of the search field.
    candidates.find(element => !(coarse && element instanceof HTMLInputElement))?.focus()
  }

  const opened = (): void => {
    open = true
    query = ''
    browseOpen = false
    createError = null
    defaultName = newWorkspaceName(now())
    // Focus moves in once the list is there, unless the user has already moved it.
    void load().then(() => { if (open && !body?.contains(document.activeElement)) void focusFirst() })
  }

  // Popover (≥ 640 px): place it under the button before it shows.
  const onBeforeToggle = (event: Event): void => {
    if ((event as ToggleEvent).newState !== 'open' || !button) return
    const rect = button.getBoundingClientRect()
    const width = Math.min(344, innerWidth - 24)
    place = `top:${Math.round(rect.bottom + 8)}px;left:${Math.round(Math.max(12, Math.min(rect.left, innerWidth - width - 12)))}px;width:${width}px`
  }
  const onToggle = (event: Event): void => {
    if ((event as ToggleEvent).newState === 'open') opened()
    else {
      open = false
      if (pop?.contains(document.activeElement) || document.activeElement === document.body) button?.focus()
    }
  }
  const close = (): void => {
    if (narrow) sheet?.close()
    else if (pop?.matches(':popover-open')) pop.hidePopover()
  }
  // Focus leaving the switcher closes it (a11y M6); a click on empty space inside does not.
  const onFocusOut = (event: FocusEvent): void => {
    const next = event.relatedTarget
    if (next instanceof Node && !(pop?.contains(next) || sheet?.contains(next) || next === button)) close()
  }

  // Phone: a modal sheet.
  const openSheet = (): void => {
    if (!sheet || sheet.open) return
    sheet.showModal()
    opened()
  }
  const onSheetClose = (): void => { open = false }
  const onSheetClick = (event: MouseEvent): void => { if (event.target === sheet) sheet?.close() }

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const items = [...(body?.querySelectorAll<HTMLElement>('[data-nav]') ?? [])]
    const index = items.indexOf(document.activeElement as HTMLElement)
    // Home/End stay with the search field's caret.
    if ((event.key === 'Home' || event.key === 'End') && document.activeElement instanceof HTMLInputElement) return
    const target = switcherKeyTarget(event.key, index, items.length)
    if (target === null) return
    event.preventDefault()
    items[target]?.focus()
  }

  const pick = (row: SwitcherRow): void => { memory.remember(row.id, 'picked') }
  const manage = (event: MouseEvent): void => {
    if (!onmanage || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    close()
    onmanage(event)
  }

  const create = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault()
    if (creating) return
    creating = true
    createError = null
    createStatus = 'Creating a Workspace…'
    try {
      const workspace = await api.create(newName.trim() || newWorkspaceName(now()))
      memory.remember(workspace.id, 'created')
      createStatus = `Created ${workspaceLabel(workspace)}. Opening it…`
      location.assign(workspacePath(workspace.id))
    } catch (error) {
      console.error('Workspace create failed', error)
      createError = plainErrorText(error)
      createStatus = ''
      creating = false
    }
  }
</script>

{#snippet rowLink(row: SwitcherRow)}
  <a class="row" href={workspacePath(row.id)} data-nav onclick={() => pick(row)}
    aria-current={row.current ? (currentIsPage ? 'page' : 'true') : undefined}
  >
    <span class="avatar" aria-hidden="true">{row.initial}</span>
    <span class="row-text"><span class="row-name" class:untitled={row.untitled}>{row.label}</span><span class="row-meta">{row.meta}</span></span>
    {#if row.current}<Icon name="check" size={16} class="row-check" />{/if}
  </a>
{/snippet}

{#snippet content()}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="body" bind:this={body} onkeydown={onKeydown} onfocusout={onFocusOut}>
    <p class="intro">{SWITCHER_INTRO}</p>
    {#if showSearch}
      <label class="search">
        <span class="visually-hidden">Find a Workspace</span>
        <Icon name="search" size={16} class="search-icon" />
        <input class="lb-input" type="search" placeholder="Find a Workspace" autocomplete="off" bind:value={query} data-nav />
      </label>
    {/if}
    <p class="visually-hidden" role="status">{countText}</p>
    <div class="scroll">
      {#if loading && workspaces === null}
        <p class="muted">Loading Workspaces…</p>
      {:else if loadError}
        <p class="error" role="alert">{loadError}</p>
        <button class="lb-btn lb-btn-sm" type="button" data-nav onclick={() => void load()}>Try again</button>
      {:else if matches !== null}
        <div role="group" aria-label="Matching Workspaces">
          {#each matches as row (row.id)}{@render rowLink(row)}{/each}
        </div>
      {:else}
        {#if groups.recent.length > 0}
          <div role="group" aria-labelledby={`${uid}-recent`}>
            <p class="group-label" id={`${uid}-recent`}>Recent in this browser</p>
            {#each groups.recent as row (row.id)}{@render rowLink(row)}{/each}
          </div>
        {/if}
        {#if groups.all.length > 0}
          <button class="disclosure" type="button" data-nav aria-expanded={browseOpen} aria-controls={`${uid}-all`}
            onclick={() => { browseOpen = !browseOpen }}
          ><span>Browse public Workspaces ({groups.all.length})</span><Icon name="down" size={16} class="chevron" /></button>
          <div id={`${uid}-all`} role="group" aria-label="Public Workspaces" hidden={!browseOpen}>
            {#if browseOpen}{#each groups.all as row (row.id)}{@render rowLink(row)}{/each}{/if}
          </div>
        {:else if workspaces !== null}
          <p class="muted">There are no Workspaces yet.</p>
        {/if}
      {/if}
    </div>
    <a class="manage" href={manageHref()} data-nav aria-haspopup={onmanage ? 'dialog' : undefined} onclick={manage}><Icon name="list" size={16} />Manage Workspaces</a>
    <form class="new" onsubmit={create}>
      <label class="new-label" for={`${uid}-name`}><Icon name="plus" size={16} />New Workspace</label>
      <div class="new-row">
        <input id={`${uid}-name`} class="lb-input" placeholder="Name (optional)" maxlength="256" autocomplete="off" bind:value={newName}
          aria-describedby={createError ? `${uid}-error ${uid}-note` : `${uid}-note`} aria-invalid={createError ? 'true' : undefined}
          title={`Left empty, it is named “${defaultName}”`}
        />
        <button class="lb-btn lb-btn-primary" type="submit" aria-disabled={creating ? 'true' : undefined}>{creating ? 'Creating…' : 'Create'}</button>
      </div>
      {#if createError}<p class="error" id={`${uid}-error`} role="alert">{createError}</p>{/if}
      <p class="note" id={`${uid}-note`}>{SWITCHER_FOOTNOTE}</p>
      <p class="visually-hidden" role="status">{createStatus}</p>
    </form>
  </div>
{/snippet}

<div class="switch">
  {#if narrow}
    <button bind:this={button} class="ws-button" type="button" aria-haspopup="dialog" aria-expanded={open} onclick={openSheet}>
      <Icon name="layers" size={18} /><span class="visually-hidden">{buttonLabel}</span><Icon name="down" size={16} />
    </button>
  {:else}
    <button bind:this={button} class="ws-button" type="button" aria-haspopup="dialog" aria-expanded={open} popovertarget={`${uid}-pop`}>
      <Icon name="layers" size={18} />
      {#if current}<span class="kicker">Workspace<span class="visually-hidden">:</span></span><span class="name">{workspaceLabel(current)}</span>
      {:else}<span class="name">Workspaces</span>{/if}
      <Icon name="down" size={16} />
    </button>
  {/if}
</div>

{#if narrow}
  <dialog bind:this={sheet} class="sheet" aria-labelledby={`${uid}-sheet-title`} onclose={onSheetClose} onclick={onSheetClick}>
    <div class="grabber" aria-hidden="true"></div>
    <header class="sheet-head">
      <h2 id={`${uid}-sheet-title`}>Workspaces</h2>
      <button class="lb-icon-btn" type="button" aria-label="Close" onclick={() => sheet?.close()}><Icon name="close" size={20} /></button>
    </header>
    {@render content()}
  </dialog>
{:else}
  <div bind:this={pop} id={`${uid}-pop`} class="pop" popover="auto" role="dialog" aria-label="Workspaces" style={place}
    onbeforetoggle={onBeforeToggle} ontoggle={onToggle}
  >{@render content()}</div>
{/if}

<style>
  .switch { position: relative; min-width: 0; }
  /* Never wider than the room the bar leaves it: the name ellipsises instead of running under the links beside it. */
  .ws-button { display: inline-flex; align-items: center; gap: .5rem; max-width: min(300px, 100%); min-height: 36px; padding: 0 .6rem 0 .65rem;
    border: 1px solid var(--lb-on-dark-line); border-radius: var(--lb-r-sm); background: #1d2d22; color: var(--lb-on-dark);
    font-size: .8125rem; font-weight: 550; cursor: pointer; }
  .ws-button:hover { border-color: #4d6352; background: #24372a; }
  .ws-button:focus-visible { outline: 2px solid var(--lb-focus-on-dark); outline-offset: 2px; }
  .ws-button :global(svg) { color: var(--lb-on-dark-2); }
  .kicker { color: var(--lb-on-dark-2); font-weight: 500; }
  .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .pop { position: fixed; inset: auto; margin: 0; padding: 0; max-width: calc(100vw - 24px); border: 1px solid var(--lb-line);
    border-radius: var(--lb-r-lg); background: var(--lb-surface); color: var(--lb-ink); box-shadow: var(--lb-shadow-pop); overflow: hidden; }

  .body { display: flex; flex-direction: column; max-height: min(560px, calc(100dvh - 80px)); }
  .intro { margin: 0; padding: 12px 14px 8px; color: var(--lb-ink-2); font-size: var(--lb-fs-small); line-height: 1.45; }
  .search { position: relative; display: block; padding: 0 10px 8px; }
  .search :global(.search-icon) { position: absolute; left: 20px; top: 13px; color: var(--lb-ink-3); pointer-events: none; }
  .search input { min-height: 40px; padding-left: 2rem; }
  .scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 6px 8px; border-top: 1px solid var(--lb-line); }
  .group-label { margin: 0; padding: 8px 8px 4px; color: var(--lb-ink-3); font-size: var(--lb-fs-eyebrow); font-weight: 750; letter-spacing: .1em; text-transform: uppercase; }
  .row { display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; align-items: center; gap: 8px; min-height: 44px; padding: 6px 8px;
    border-radius: var(--lb-r-sm); color: var(--lb-ink); text-decoration: none; }
  .row:hover { background: var(--lb-surface-2); }
  .row:focus-visible { outline: 2px solid var(--lb-focus); outline-offset: -2px; background: var(--lb-surface-2); }
  .row[aria-current] { background: var(--lb-brand-50); }
  .avatar { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 7px; background: var(--lb-brand-100); color: var(--lb-brand-600); font-size: .75rem; font-weight: 750; }
  .row-text { min-width: 0; }
  .row-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .875rem; font-weight: 600; }
  .row-name.untitled { color: var(--lb-ink-2); font-weight: 500; }
  .row-meta { display: block; color: var(--lb-ink-3); font-size: var(--lb-fs-micro); }
  .row :global(.row-check) { color: var(--lb-accent); }
  .disclosure { display: flex; align-items: center; justify-content: space-between; width: 100%; min-height: 44px; margin-top: 4px; padding: 0 8px;
    border: 0; border-radius: var(--lb-r-sm); background: transparent; color: var(--lb-ink); font-size: .875rem; font-weight: 600; text-align: left; cursor: pointer; }
  .disclosure:hover { background: var(--lb-surface-2); }
  .disclosure:focus-visible { outline: 2px solid var(--lb-focus); outline-offset: -2px; }
  .disclosure :global(.chevron) { color: var(--lb-ink-3); transition: transform var(--lb-t-fast) var(--lb-ease); }
  .disclosure[aria-expanded="true"] :global(.chevron) { transform: rotate(180deg); }
  .muted { margin: 0; padding: 10px 8px; color: var(--lb-ink-3); font-size: var(--lb-fs-small); }
  .manage { display: flex; align-items: center; gap: 8px; min-height: 40px; padding: 0 14px; border-top: 1px solid var(--lb-line);
    color: var(--lb-ink-2); font-size: .8125rem; font-weight: 600; text-decoration: none; }
  .manage:hover { color: var(--lb-ink); background: var(--lb-surface-2); }
  .manage:focus-visible { outline: 2px solid var(--lb-focus); outline-offset: -2px; }
  .manage :global(svg) { color: var(--lb-ink-3); }
  .error { margin: 6px 8px; color: var(--lb-danger); font-size: var(--lb-fs-small); }

  .new { display: grid; gap: 8px; margin: 0; padding: 10px; border-top: 1px solid var(--lb-line); background: var(--lb-surface-2); }
  .new-label { display: inline-flex; align-items: center; gap: 6px; color: var(--lb-ink); font-size: .8125rem; font-weight: 650; }
  .new-row { display: flex; gap: 8px; }
  .new-row input { flex: 1; min-width: 0; min-height: 40px; }
  .new .error { margin: 0; }
  .note { margin: 0; color: var(--lb-ink-3); font-size: var(--lb-fs-micro); line-height: 1.4; }

  /* Phone: a modal bottom sheet with a scrim, title and close. */
  .sheet { inset: auto 0 0 0; width: 100vw; max-width: none; max-height: 88dvh; margin: 0; padding: 0; border: 0; border-radius: 16px 16px 0 0;
    background: var(--lb-surface); color: var(--lb-ink); box-shadow: var(--lb-shadow-lg); }
  .sheet[open] { display: flex; flex-direction: column; }
  .sheet::backdrop { background: rgba(10, 16, 12, .45); }
  .grabber { width: 36px; height: 4px; margin: 8px auto 0; border-radius: 2px; background: var(--lb-line-strong); }
  .sheet-head { display: flex; align-items: center; justify-content: space-between; min-height: 48px; padding: 0 6px 0 16px; }
  .sheet-head h2 { margin: 0; font-size: 1.0625rem; font-weight: 700; }
  .sheet .body { max-height: none; min-height: 0; flex: 1; }
  /* Mid widths: the name gets the room; "Workspace:" stays in the button's accessible name. */
  @media (max-width: 899px) {
    .kicker { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  }
  @media (max-width: 639px) {
    .ws-button { min-height: 40px; gap: 2px; padding: 0 6px; }
  }
  @media (pointer: coarse) {
    .ws-button { min-height: 44px; }
    .manage { min-height: 44px; }
  }
</style>
