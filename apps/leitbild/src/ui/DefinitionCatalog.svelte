<script lang="ts">
  // "More scenarios (N)" (plan v2 §6.5): every Definition that is not a
  // featured demo, collapsed by default, as compact rows: title, a one-line
  // summary with an inline "More", Start with staged progress, and a quiet ⋯
  // for Edit, Inspect and Delete. Row bodies never start anything.
  import type { ModuleCapabilityDescriptor, ModuleDefinitionDescriptor } from '@leitbild/contracts'
  import Icon from './Icon.svelte'
  import MoreMenu, { type MoreMenuItem } from './MoreMenu.svelte'
  import StartProgress from './StartProgress.svelte'
  import { cardCapability } from './card-actions.ts'
  import type { StartState } from './definition-start.ts'
  import { summaryHasMore, summaryLead } from './workspace-page.ts'

  let {
    definitions, capabilities, start, keyOf, busy, inspecting, onstart, onretry, ondismiss, oncancel, onreload, onedit, oninspect, ondelete,
  }: {
    definitions: ReadonlyArray<ModuleDefinitionDescriptor>
    capabilities: ReadonlyArray<ModuleCapabilityDescriptor>
    start: StartState
    keyOf: (definition: ModuleDefinitionDescriptor) => string
    /** Another page action (a delete) is running. */
    busy: boolean
    inspecting: boolean
    onstart: (definition: ModuleDefinitionDescriptor) => void
    onretry: () => void
    ondismiss: () => void
    oncancel: () => void
    onreload: () => void
    onedit: (definition: ModuleDefinitionDescriptor) => void
    oninspect: (definition: ModuleDefinitionDescriptor) => void
    ondelete: (definition: ModuleDefinitionDescriptor, capability: ModuleCapabilityDescriptor) => void
  } = $props()

  const uid = `scen-${Math.random().toString(36).slice(2, 8)}`
  let open = $state(false)
  let expanded = $state<ReadonlySet<string>>(new Set())
  const starting = $derived(start.phase === 'busy')
  const toggleText = (key: string): void => {
    const next = new Set(expanded)
    if (!next.delete(key)) next.add(key)
    expanded = next
  }
  const menuItems = (definition: ModuleDefinitionDescriptor): MoreMenuItem[] => {
    const remove = cardCapability(definition, 'delete', capabilities)
    return [
      ...(definition.uiPath ? [{ label: 'Edit', icon: 'edit' as const, onselect: () => onedit(definition) }] : []),
      ...(definition.inspectionCapabilityId ? [{ label: 'Inspect', icon: 'info' as const, disabled: inspecting, onselect: () => oninspect(definition) }] : []),
      ...(remove ? [{ label: 'Delete…', danger: true, disabled: busy, onselect: () => ondelete(definition, remove) }] : []),
    ]
  }
</script>

{#if definitions.length > 0}
  <section class="more-scenarios" aria-labelledby={`${uid}-toggle`}>
    <h2 class="toggle-heading">
      <button id={`${uid}-toggle`} class="toggle" type="button" aria-expanded={open} aria-controls={`${uid}-list`} onclick={() => { open = !open }}>
        <Icon name={open ? 'down' : 'right'} size={18} />More scenarios <span class="count">({definitions.length})</span>
      </button>
    </h2>
    <ul id={`${uid}-list`} class="list" hidden={!open}>
      {#each definitions as definition, index (keyOf(definition))}
        {@const key = keyOf(definition)}
        {@const progress = start.phase !== 'idle' && start.key === key ? start : null}
        {@const items = menuItems(definition)}
        {@const textOpen = expanded.has(key)}
        <li class="scen">
          <div class="main">
            <h3 id={`${uid}-t${index}`}>{definition.title}</h3>
            {#if definition.description}
              <div class="desc" class:open={textOpen}>
                <span id={`${uid}-d${index}`} class="desc-text">{textOpen ? definition.description : summaryLead(definition.description)}</span>
                {#if summaryHasMore(definition.description)}
                  <button class="more-link" type="button" aria-expanded={textOpen} aria-controls={`${uid}-d${index}`} aria-describedby={`${uid}-t${index}`}
                    onclick={() => toggleText(key)}>{textOpen ? 'Less' : 'More'}</button>
                {/if}
              </div>
            {/if}
          </div>
          {#if !progress}
            <div class="row-actions">
              {#if definition.primaryCapabilityId}
                <button class="lb-btn lb-btn-sm" type="button" aria-disabled={starting ? 'true' : undefined} aria-describedby={`${uid}-t${index}`}
                  onclick={() => { if (!starting) onstart(definition) }}><Icon name="play" size={14} />Start</button>
              {/if}
              {#if items.length > 0}
                <MoreMenu label={`More actions for ${definition.title}`} {items} triggerClass="lb-btn lb-btn-sm lb-btn-quiet icon-only" />
              {/if}
            </div>
          {:else}
            <div class="progress"><StartProgress {progress} title={definition.title} {onretry} {ondismiss} {oncancel} {onreload} /></div>
          {/if}
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .toggle-heading { margin: 0; font-size: var(--lb-fs-h3); }
  .toggle { display: inline-flex; align-items: center; gap: 6px; min-height: 44px; padding: 0 10px 0 4px; border: 0; border-radius: var(--lb-r-sm);
    background: transparent; color: var(--lb-ink); font: inherit; font-weight: 700; cursor: pointer; }
  .toggle:hover { background: rgba(23, 32, 25, .06); }
  .toggle:focus-visible { outline: 2px solid var(--lb-focus); outline-offset: 2px; }
  .count { color: var(--lb-ink-3); font-size: var(--lb-fs-small); font-weight: 400; }
  .list { margin: var(--lb-s2) 0 0; padding: 0; list-style: none; border: 1px solid var(--lb-line); border-radius: var(--lb-r-lg); background: var(--lb-surface); }
  .list[hidden] { display: none; }
  .scen { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 6px var(--lb-s4); min-height: 60px; padding: 10px 12px 10px 18px; }
  .scen + .scen { border-top: 1px solid var(--lb-line); }
  .main { min-width: 0; display: grid; gap: 2px; }
  h3 { margin: 0; color: var(--lb-ink); font-size: .9375rem; line-height: 1.35; font-weight: 650; }
  .desc { display: flex; align-items: baseline; gap: 4px; min-width: 0; color: var(--lb-ink-2); font-size: .8125rem; line-height: 1.5; }
  .desc-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .desc.open { display: block; }
  .desc.open .desc-text { white-space: normal; }
  .more-link { flex: none; min-height: 0; padding: 0 2px; border: 0; border-radius: 4px; background: transparent; color: var(--lb-accent);
    font: inherit; font-weight: 650; cursor: pointer; }
  .desc.open .more-link { margin-left: 4px; }
  .more-link:hover { text-decoration: underline; }
  .more-link:focus-visible { outline: 2px solid var(--lb-focus); outline-offset: 1px; }
  .row-actions { display: flex; align-items: center; gap: 4px; }
  .row-actions :global(.icon-only) { width: 36px; padding: 0; }
  .progress { grid-column: 1 / -1; padding: 4px 0 6px; }
  @media (max-width: 699px) {
    .scen { grid-template-columns: minmax(0, 1fr); padding: 12px 14px; }
    .row-actions { justify-content: flex-start; }
  }
  @media (pointer: coarse) {
    .more-link { padding: 10px 4px; margin: -10px 0; }
    .row-actions :global(.icon-only) { width: 44px; }
  }
</style>
