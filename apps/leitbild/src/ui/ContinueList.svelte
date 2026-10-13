<script lang="ts">
  // "Continue" (plan v2 §6.3): Runs and conversations of this Workspace, live
  // Runs first, three at a time with "Show all N". Each card is one link with
  // its state (Running, Paused…), a visible Delete and a ⋯ for Rename and
  // Inspect. "Select" shows every card with a tick box and one Delete for the
  // ticked ones. Both delete through each Resource's own delete Capability,
  // after one ConfirmDialog. On phones the cards become single-line rows.
  import { tick } from 'svelte'
  import type { ModuleCapabilityDescriptor, ModuleResourceDescriptor, ResourceSummaryItem } from '@leitbild/contracts'
  import ConfirmDialog from './ConfirmDialog.svelte'
  import Icon from './Icon.svelte'
  import InlineName from './InlineName.svelte'
  import MoreMenu, { type MoreMenuItem } from './MoreMenu.svelte'
  import { deletedText, deleteLabel, keepExisting, selectAllState, toggleAll, toggleOne } from './bulk-delete.ts'
  import { workspaceUrl } from './launch-destination.ts'
  import { createResourceRemover, resourceDeleteBody, resourceDeleteItem, resourceNoun, type ResourceDeleteItem } from './resource-delete.ts'
  import { CONTINUE_LIMIT, type ContinueItem } from './workspace-page.ts'

  let { items, workspaceId, capabilities, summaryValue, inspecting, oninspect, onrename, onremoved }: {
    items: ReadonlyArray<ContinueItem>
    workspaceId: string
    capabilities: ReadonlyArray<ModuleCapabilityDescriptor>
    summaryValue: (item: ResourceSummaryItem) => string
    inspecting: boolean
    oninspect: (resource: ModuleResourceDescriptor) => void
    onrename: (resource: ModuleResourceDescriptor, name: string, original: string) => Promise<void>
    /** Something was deleted: the page reads its Resources again. */
    onremoved: () => void
  } = $props()

  const uid = `continue-${Math.random().toString(36).slice(2, 8)}`
  let all = $state(false)
  let selecting = $state(false)
  let selected = $state<ReadonlySet<string>>(new Set())
  let targets = $state<ReadonlyArray<ResourceDeleteItem>>([])
  let confirming = $state(false)
  let status = $state('')
  let renaming = $state<string | null>(null)
  let nameField = $state<{ edit(): Promise<void> } | null>(null)
  let selectAllBox = $state<HTMLInputElement | null>(null)
  let heading = $state<HTMLElement | null>(null)
  const menus: Record<string, { focus(): void } | null> = $state({})
  const keyOf = (resource: ModuleResourceDescriptor): string => `${resource.ref.type}:${resource.ref.id}`
  const shown = $derived(all || selecting ? items : items.slice(0, CONTINUE_LIMIT))
  /** The cards that can be deleted, by key: those whose descriptor names a usable delete Capability. */
  const deletable = $derived(new Map(items.flatMap(item => {
    const entry = resourceDeleteItem(item.resource, capabilities)
    return entry === null ? [] : [[entry.key, entry] as const]
  })))
  const deletableList = $derived([...deletable.values()])
  const chosen = $derived(deletableList.filter(entry => selected.has(entry.key)))
  const allState = $derived(selectAllState(deletableList, selected))
  const remove = $derived(createResourceRemover(workspaceId))
  const hrefOf = (resource: ModuleResourceDescriptor): string => resource.ref.type === 'agents.room'
    ? workspaceUrl(workspaceId, { agents: resource.ref.id })
    : workspaceUrl(workspaceId, { world: resource.ref.id })

  $effect(() => { if (selectAllBox) selectAllBox.indeterminate = allState === 'some' })

  const startRename = async (resource: ModuleResourceDescriptor): Promise<void> => {
    renaming = keyOf(resource)
    await tick()
    await nameField?.edit()
  }
  const menuItems = (resource: ModuleResourceDescriptor): MoreMenuItem[] => [
    ...(resource.renameCapabilityId ? [{ label: 'Rename', icon: 'edit' as const, onselect: () => void startRename(resource) }] : []),
    ...(resource.inspectionCapabilityId ? [{ label: 'Inspect', icon: 'info' as const, disabled: inspecting, onselect: () => oninspect(resource) }] : []),
  ]

  const startSelecting = async (): Promise<void> => {
    selecting = true
    selected = new Set()
    status = ''
    await tick()
    selectAllBox?.focus()
  }
  const stopSelecting = (): void => {
    selecting = false
    selected = new Set()
  }
  const ask = (entries: ReadonlyArray<ResourceDeleteItem>): void => {
    if (entries.length === 0) return
    targets = entries
    status = ''
    confirming = true
  }
  const finished = (removed: ReadonlyArray<ResourceDeleteItem>): void => {
    if (removed.length === 0) return
    status = deletedText(resourceNoun(removed), removed)
    const gone = new Set(removed.map(entry => entry.key))
    selected = keepExisting(selected, deletableList.filter(entry => !gone.has(entry.key)))
    if (deletableList.every(entry => gone.has(entry.key))) selecting = false
    onremoved()
  }
  // A deleted card's Delete is gone: focus goes to the select bar, or the heading (its status line says what happened).
  const focusAfterDelete = (): void => { void tick().then(() => (selecting ? selectAllBox : heading)?.focus()) }
</script>

{#if items.length > 0}
  <section class="continue" aria-labelledby="continue-heading">
    <div class="section-head">
      <h2 id="continue-heading" bind:this={heading} tabindex="-1">Continue</h2>
      <span class="count">{items.length > CONTINUE_LIMIT && !all && !selecting ? `${CONTINUE_LIMIT} of ${items.length}` : items.length}</span>
      <span class="head-actions">
        {#if deletable.size > 1 || selecting}
          <button class="text-button" type="button" aria-pressed={selecting}
            onclick={() => { if (selecting) stopSelecting(); else void startSelecting() }}>{selecting ? 'Done' : 'Select'}</button>
        {/if}
        {#if items.length > CONTINUE_LIMIT && !selecting}
          <button class="text-button" type="button" aria-expanded={all} aria-controls="continue-list" onclick={() => { all = !all }}>{all ? 'Show fewer' : `Show all ${items.length}`}</button>
        {/if}
      </span>
    </div>
    {#if selecting}
      <div class="select-bar">
        <label class="select-all">
          <input bind:this={selectAllBox} type="checkbox" checked={allState === 'all'} onchange={() => { selected = toggleAll(deletableList, selected) }} />
          <span>Select all <span class="muted">({deletable.size})</span></span>
        </label>
        <span class="selected-count">{selected.size} selected</span>
        <button class="lb-btn lb-btn-sm lb-btn-danger" type="button" disabled={chosen.length === 0} onclick={() => ask(chosen)}
        ><Icon name="trash" size={16} />{deleteLabel(resourceNoun(chosen.length === 0 ? deletableList : chosen), chosen.length)}</button>
      </div>
    {/if}
    <p class="visually-hidden" role="status">{status}</p>
    <ul id="continue-list" class="cards" class:selecting>
      {#each shown as item (keyOf(item.resource))}
        {@const key = keyOf(item.resource)}
        {@const actions = menuItems(item.resource)}
        {@const removable = deletable.get(key)}
        <li class="card {item.kind}" class:checked={selecting && selected.has(key)}>
          <span class="state"><span class="dot" aria-hidden="true"></span>{item.status}</span>
          {#if selecting}
            {#if removable}
              <label class="title pick" for={`${uid}-${key}`}>{item.resource.title}</label>
            {:else}
              <span class="title">{item.resource.title}</span>
            {/if}
          {:else if renaming === key}
            <span class="title"><InlineName bind:this={nameField} value={item.resource.title} fallback={item.resource.ref.id} label={`Name of ${item.resource.title}`}
              pencil={false} onsave={(name, original) => onrename(item.resource, name, original)}
              onclose={reason => { renaming = null; if (reason !== 'blurred') menus[key]?.focus() }} /></span>
          {:else}
            <a class="title" href={hrefOf(item.resource)}>{item.resource.title}</a>
          {/if}
          {#if item.facts.length > 0}
            <span class="facts">
              {#each item.facts as fact (fact.key)}
                <span class="fact" title={fact.kind === 'timestamp' ? fact.value : undefined}><small>{fact.label}</small><b>{summaryValue(fact)}</b></span>
              {/each}
            </span>
          {/if}
          {#if selecting}
            {#if removable}
              <span class="tools"><input id={`${uid}-${key}`} class="pick-box" type="checkbox" checked={selected.has(key)} onchange={() => { selected = toggleOne(selected, key) }} /></span>
            {/if}
          {:else if removable || actions.length > 0}
            <span class="tools">
              {#if removable}
                <button class="lb-btn lb-btn-sm lb-btn-quiet icon-only card-delete" type="button" aria-label={`Delete ${item.resource.title}`} title={`Delete ${item.resource.title}`}
                  onclick={() => ask([removable])}><Icon name="trash" size={17} /></button>
              {/if}
              {#if actions.length > 0}
                <MoreMenu bind:this={menus[key]} label={`More actions for ${item.resource.title}`} items={actions} triggerClass="lb-btn lb-btn-sm lb-btn-quiet icon-only" />
              {/if}
            </span>
          {/if}
        </li>
      {/each}
    </ul>
  </section>
{/if}

<ConfirmDialog bind:open={confirming} items={targets} noun={resourceNoun(targets)} body={resourceDeleteBody(targets)}
  {remove} onfinished={finished} returnFocus={focusAfterDelete} />

<style>
  .section-head { display: flex; align-items: baseline; gap: var(--lb-s3); margin-bottom: var(--lb-s3); }
  h2 { margin: 0; font-size: var(--lb-fs-h3); font-weight: 700; }
  h2:focus { outline: none; }
  h2:focus-visible { outline: 2px solid var(--lb-focus); outline-offset: 2px; border-radius: 4px; }
  .count { color: var(--lb-ink-3); font-size: var(--lb-fs-small); }
  .head-actions { margin-left: auto; display: inline-flex; gap: 4px; }
  .text-button { min-height: 32px; padding: 0 6px; border: 0; border-radius: 6px; background: transparent; color: var(--lb-accent);
    font: inherit; font-size: .875rem; font-weight: 650; cursor: pointer; }
  .text-button:hover { text-decoration: underline; }
  .text-button:focus-visible { outline: 2px solid var(--lb-focus); outline-offset: 2px; }
  .select-bar { position: sticky; top: calc(var(--lb-topbar-h) + 8px); z-index: 2; display: flex; flex-wrap: wrap; align-items: center; gap: var(--lb-s2) var(--lb-s4);
    margin-bottom: var(--lb-s3); padding: 8px 8px 8px 4px; border: 1px solid var(--lb-line); border-radius: var(--lb-r-lg); background: var(--lb-surface); box-shadow: var(--lb-shadow-sm); }
  .select-all { display: inline-flex; align-items: center; gap: 10px; min-height: 36px; padding: 0 10px; color: var(--lb-ink); font-size: .875rem; font-weight: 600; cursor: pointer; }
  .muted { color: var(--lb-ink-3); font-weight: 500; }
  .selected-count { color: var(--lb-ink-2); font-size: var(--lb-fs-small); }
  .select-bar .lb-btn-danger { margin-left: auto; }
  .select-bar .lb-btn-danger:hover:not([disabled]) { background: #6f2222; border-color: #6f2222; }
  input[type="checkbox"] { flex: none; width: 18px; height: 18px; margin: 0; padding: 0; accent-color: var(--lb-brand-700); cursor: pointer; }
  input[type="checkbox"]:focus-visible { outline: 2px solid var(--lb-focus); outline-offset: 2px; }
  .cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--lb-s3); margin: 0; padding: 0; list-style: none; }
  .card { position: relative; min-width: 0; display: grid; align-content: start; gap: 6px; padding: 14px 16px; border: 1px solid var(--lb-line);
    border-radius: var(--lb-r-lg); background: var(--lb-surface); transition: border-color var(--lb-t-fast) var(--lb-ease), box-shadow var(--lb-t-fast) var(--lb-ease); }
  .card:hover { border-color: var(--lb-line-strong); box-shadow: var(--lb-shadow-sm); }
  .card:has(.title:focus-visible), .card:has(.pick-box:focus-visible) { outline: 2px solid var(--lb-focus); outline-offset: 2px; }
  .card.checked { border-color: var(--lb-brand-600); background: var(--lb-brand-50); }
  /* Room for the Delete and ⋯ buttons (or the tick box) in the top-right corner. */
  .state { display: inline-flex; align-items: center; gap: 7px; padding-right: 80px; color: var(--lb-ink-3); font-size: var(--lb-fs-micro); }
  .selecting .state { padding-right: 40px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--lb-ok); }
  .paused .dot { background: #b5822a; }
  .unavailable .dot { background: var(--lb-danger); }
  .conversation .dot { background: var(--lb-focus); }
  .title { min-width: 0; color: var(--lb-ink); font-size: .9375rem; font-weight: 700; line-height: 1.35; text-decoration: none; overflow-wrap: anywhere; }
  a.title::after, label.pick::after { content: ''; position: absolute; inset: 0; border-radius: inherit; }
  a.title:focus { outline: none; }
  label.pick { cursor: pointer; }
  .title :global(.inline-name input) { width: 100%; min-height: 36px; padding: .2rem .45rem; border: 1px solid var(--lb-control); border-radius: var(--lb-r-sm); font: inherit; }
  .facts { display: flex; flex-wrap: wrap; gap: 6px; }
  .fact { display: grid; gap: 1px; min-width: 64px; padding: 4px 7px; border: 1px solid var(--lb-line); border-radius: var(--lb-r-xs); background: var(--lb-surface-2); }
  .fact small { color: var(--lb-ink-3); font-size: .625rem; font-weight: 650; letter-spacing: .03em; text-transform: uppercase; }
  .fact b { color: var(--lb-ink); font-size: .75rem; font-weight: 700; white-space: nowrap; }
  .tools { position: absolute; z-index: 1; top: 6px; right: 6px; display: inline-flex; align-items: center; gap: 2px; }
  .tools :global(.icon-only) { width: 36px; padding: 0; }
  .card-delete { color: var(--lb-ink-2); }
  .card-delete:hover { color: var(--lb-danger); background: rgba(138, 45, 45, .08); }
  .pick-box { margin: 9px; }
  @media (max-width: 899px) { .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 699px) {
    .cards { grid-template-columns: minmax(0, 1fr); gap: 0; border: 1px solid var(--lb-line); border-radius: var(--lb-r-lg); background: var(--lb-surface); }
    .card { gap: 2px; min-height: 56px; padding: 8px 88px 8px 14px; border: 0; border-radius: 0; background: transparent; }
    .selecting .card { padding-right: 56px; }
    .card.checked { background: var(--lb-brand-50); }
    .card + .card { border-top: 1px solid var(--lb-line); }
    .card:hover { box-shadow: none; }
    .title { grid-row: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .state, .selecting .state { grid-row: 2; padding: 0; }
    .facts { display: none; }
    .tools { top: 50%; transform: translateY(-50%); }
    .select-bar .lb-btn-danger { flex: 1 1 100%; }
  }
  @media (pointer: coarse) {
    .tools :global(.icon-only) { width: 44px; }
    .state { padding-right: 96px; }
  }
  @media (pointer: coarse) and (max-width: 699px) {
    .card { padding-right: 104px; }
    .selecting .card { padding-right: 56px; }
    .state { padding-right: 0; }
  }
  @media (forced-colors: active) { .card.checked { outline: 2px solid Highlight; outline-offset: -2px; } }
  @media (prefers-reduced-motion: reduce) { .card { transition: none; } }
</style>
