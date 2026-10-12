<script lang="ts">
  // "Continue" (plan v2 §6.3): Runs and conversations of this Workspace, live
  // Runs first, three at a time with "Show all N". Each card is one link; its
  // ⋯ keeps Rename, Inspect and Delete as quiet sibling controls. On phones
  // the cards become single-line rows.
  import { tick } from 'svelte'
  import type { ModuleCapabilityDescriptor, ModuleResourceDescriptor, ResourceSummaryItem } from '@leitbild/contracts'
  import InlineName from './InlineName.svelte'
  import MoreMenu, { type MoreMenuItem } from './MoreMenu.svelte'
  import { cardCapability } from './card-actions.ts'
  import { workspaceUrl } from './launch-destination.ts'
  import { CONTINUE_LIMIT, type ContinueItem } from './workspace-page.ts'

  let { items, workspaceId, capabilities, summaryValue, busy, inspecting, oninspect, ondelete, onrename }: {
    items: ReadonlyArray<ContinueItem>
    workspaceId: string
    capabilities: ReadonlyArray<ModuleCapabilityDescriptor>
    summaryValue: (item: ResourceSummaryItem) => string
    busy: boolean
    inspecting: boolean
    oninspect: (resource: ModuleResourceDescriptor) => void
    ondelete: (resource: ModuleResourceDescriptor, capability: ModuleCapabilityDescriptor) => void
    onrename: (resource: ModuleResourceDescriptor, name: string, original: string) => Promise<void>
  } = $props()

  let all = $state(false)
  let renaming = $state<string | null>(null)
  let nameField = $state<{ edit(): Promise<void> } | null>(null)
  const menus: Record<string, { focus(): void } | null> = $state({})
  const shown = $derived(all ? items : items.slice(0, CONTINUE_LIMIT))
  const keyOf = (resource: ModuleResourceDescriptor): string => `${resource.ref.type}:${resource.ref.id}`
  const hrefOf = (resource: ModuleResourceDescriptor): string => resource.ref.type === 'agents.room'
    ? workspaceUrl(workspaceId, { agents: resource.ref.id })
    : workspaceUrl(workspaceId, { world: resource.ref.id })

  const startRename = async (resource: ModuleResourceDescriptor): Promise<void> => {
    renaming = keyOf(resource)
    await tick()
    await nameField?.edit()
  }
  const menuItems = (resource: ModuleResourceDescriptor): MoreMenuItem[] => {
    const remove = cardCapability(resource, 'delete', capabilities)
    return [
      ...(resource.renameCapabilityId ? [{ label: 'Rename', icon: 'edit' as const, onselect: () => void startRename(resource) }] : []),
      ...(resource.inspectionCapabilityId ? [{ label: 'Inspect', icon: 'info' as const, disabled: inspecting, onselect: () => oninspect(resource) }] : []),
      ...(remove ? [{ label: `${remove.title}…`, danger: true, disabled: busy, onselect: () => ondelete(resource, remove) }] : []),
    ]
  }
</script>

{#if items.length > 0}
  <section class="continue" aria-labelledby="continue-heading">
    <div class="section-head">
      <h2 id="continue-heading">Continue</h2>
      <span class="count">{items.length > CONTINUE_LIMIT && !all ? `${CONTINUE_LIMIT} of ${items.length}` : items.length}</span>
      {#if items.length > CONTINUE_LIMIT}
        <button class="show-all" type="button" aria-expanded={all} aria-controls="continue-list" onclick={() => { all = !all }}>{all ? 'Show fewer' : `Show all ${items.length}`}</button>
      {/if}
    </div>
    <ul id="continue-list" class="cards">
      {#each shown as item (keyOf(item.resource))}
        {@const key = keyOf(item.resource)}
        {@const actions = menuItems(item.resource)}
        <li class="card {item.kind}">
          <span class="state"><span class="dot" aria-hidden="true"></span>{item.status}</span>
          {#if renaming === key}
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
          {#if actions.length > 0}
            <span class="tools"><MoreMenu bind:this={menus[key]} label={`More actions for ${item.resource.title}`} items={actions} triggerClass="lb-btn lb-btn-sm lb-btn-quiet icon-only" /></span>
          {/if}
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .section-head { display: flex; align-items: baseline; gap: var(--lb-s3); margin-bottom: var(--lb-s3); }
  h2 { margin: 0; font-size: var(--lb-fs-h3); font-weight: 700; }
  .count { color: var(--lb-ink-3); font-size: var(--lb-fs-small); }
  .show-all { margin-left: auto; min-height: 32px; padding: 0 6px; border: 0; border-radius: 6px; background: transparent; color: var(--lb-accent);
    font: inherit; font-size: .875rem; font-weight: 650; cursor: pointer; }
  .show-all:hover { text-decoration: underline; }
  .show-all:focus-visible { outline: 2px solid var(--lb-focus); outline-offset: 2px; }
  .cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--lb-s3); margin: 0; padding: 0; list-style: none; }
  .card { position: relative; min-width: 0; display: grid; align-content: start; gap: 6px; padding: 14px 16px; border: 1px solid var(--lb-line);
    border-radius: var(--lb-r-lg); background: var(--lb-surface); transition: border-color var(--lb-t-fast) var(--lb-ease), box-shadow var(--lb-t-fast) var(--lb-ease); }
  .card:hover { border-color: var(--lb-line-strong); box-shadow: var(--lb-shadow-sm); }
  .card:has(.title:focus-visible) { outline: 2px solid var(--lb-focus); outline-offset: 2px; }
  .state { display: inline-flex; align-items: center; gap: 7px; padding-right: 40px; color: var(--lb-ink-3); font-size: var(--lb-fs-micro); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--lb-ok); }
  .paused .dot { background: #b5822a; }
  .unavailable .dot { background: var(--lb-danger); }
  .conversation .dot { background: var(--lb-focus); }
  .title { min-width: 0; color: var(--lb-ink); font-size: .9375rem; font-weight: 700; line-height: 1.35; text-decoration: none; overflow-wrap: anywhere; }
  a.title::after { content: ''; position: absolute; inset: 0; border-radius: inherit; }
  a.title:focus { outline: none; }
  .title :global(.inline-name input) { width: 100%; min-height: 36px; padding: .2rem .45rem; border: 1px solid var(--lb-control); border-radius: var(--lb-r-sm); font: inherit; }
  .facts { display: flex; flex-wrap: wrap; gap: 6px; }
  .fact { display: grid; gap: 1px; min-width: 64px; padding: 4px 7px; border: 1px solid var(--lb-line); border-radius: var(--lb-r-xs); background: var(--lb-surface-2); }
  .fact small { color: var(--lb-ink-3); font-size: .625rem; font-weight: 650; letter-spacing: .03em; text-transform: uppercase; }
  .fact b { color: var(--lb-ink); font-size: .75rem; font-weight: 700; white-space: nowrap; }
  .tools { position: absolute; z-index: 1; top: 6px; right: 6px; }
  .tools :global(.icon-only) { width: 36px; padding: 0; }
  @media (max-width: 899px) { .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 699px) {
    .cards { grid-template-columns: minmax(0, 1fr); gap: 0; border: 1px solid var(--lb-line); border-radius: var(--lb-r-lg); background: var(--lb-surface); }
    .card { gap: 2px; min-height: 56px; padding: 8px 56px 8px 14px; border: 0; border-radius: 0; background: transparent; }
    .card + .card { border-top: 1px solid var(--lb-line); }
    .card:hover { box-shadow: none; }
    .title { grid-row: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .state { grid-row: 2; padding: 0; }
    .facts { display: none; }
    .tools { top: 50%; transform: translateY(-50%); }
  }
  @media (pointer: coarse) { .tools :global(.icon-only) { width: 44px; } }
  @media (prefers-reduced-motion: reduce) { .card { transition: none; } }
</style>
