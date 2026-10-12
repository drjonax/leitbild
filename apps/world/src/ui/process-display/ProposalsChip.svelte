<script lang="ts">
  import '@oicl/openbridge-webcomponents/dist/components/badge/badge.js'
  import '@oicl/openbridge-webcomponents/dist/components/button/button.js'
  import type { ProposalListEntry } from '../embed/composed-display/operation/operation-presenter.ts'

  // The display window's pending proposals (plan §4.3, QA-10): one chip in
  // the window's toolbar, beside its position, for every display it shows;
  // absent when none waits. Its list puts the most time-critical first, by
  // World's projected time to a limit, then the oldest; each opens its item's
  // popover on its own detail, where a person decides.

  let { entries, open }: {
    entries: ReadonlyArray<ProposalListEntry>
    /** Opens the item's own detail with its popover pinned on the proposal. */
    open: (entry: ProposalListEntry) => void
  } = $props()

  let expanded = $state(false)
  const listId = `proposals-${Math.random().toString(36).slice(2)}`
  const label = $derived(`${entries.every(entry => entry.proposer === 'AI') ? 'AI proposals' : 'Proposals'}`)

  const choose = (entry: ProposalListEntry): void => {
    expanded = false
    open(entry)
  }

  const keydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !expanded) return
    event.stopPropagation()
    expanded = false
  }
</script>

{#if entries.length > 0}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="proposals" onkeydown={keydown}>
    <!-- An obc-button is a button: the native button inside it takes Enter and Space. -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <obc-button variant="flat" aria-haspopup="true" aria-expanded={expanded} aria-controls={listId} title={`${entries.length} pending: ${entries[0]!.text}`} onclick={() => { expanded = !expanded }}>
      {label}
      <obc-badge type="enhance" number={entries.length} size="regular" variant="default"></obc-badge>
    </obc-button>
    {#if expanded}
      <ul id={listId} class="list" aria-label="Pending proposals, most time-critical first">
        {#each entries as entry (entry.id)}
          <li>
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <obc-button variant="flat" onclick={() => choose(entry)}>
              <span class="who">{entry.proposer} ?</span> {entry.text}
            </obc-button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}

<style>
  .proposals { position: relative; flex: none; }
  .list { position: absolute; right: 0; top: calc(100% + 4px); z-index: 20; list-style: none; margin: 0; padding: 4px; min-width: 320px; max-width: 480px; background: var(--container-section-color); border: 1px solid var(--border-outline-color); border-radius: 4px; }
  .list li + li { margin-top: 2px; }
  .who { font-weight: 700; }
</style>
