<script lang="ts">
  import type { ProposalListEntry } from '../operation/operation-presenter.ts'

  // The display window's pending proposals (plan §4.3, QA-10): one chip in
  // the window's toolbar, beside its position, for every display it shows;
  // absent when none waits. Its list puts the one that lapses first first,
  // then the oldest; each opens its item's
  // popover on its own detail, where a person decides. Part of the window's
  // chrome, it is drawn with the window's own buttons, as its "New ›" is.

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
    <button
      type="button"
      class="chip"
      aria-haspopup="true"
      aria-expanded={expanded}
      aria-controls={listId}
      title={`${entries.length} pending: ${entries[0]!.text}`}
      onclick={() => { expanded = !expanded }}
    >{label} <span class="count">{entries.length}</span></button>
    {#if expanded}
      <ul id={listId} class="list" aria-label="Pending proposals, the one that lapses first first">
        {#each entries as entry (entry.id)}
          <li><button type="button" class="entry" onclick={() => choose(entry)}><span class="who">{entry.proposer} ?</span> {entry.text}</button></li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}

<style>
  .proposals { position: relative; flex: none; }
  /* The window's accent, as its "New ›" announces a new display: a person's decision waits. */
  .chip { padding: 0 8px; gap: 6px; white-space: nowrap; font-weight: 650; color: var(--accent); border-color: color-mix(in srgb, var(--accent) 55%, transparent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
  .count { min-width: 16px; padding: 0 4px; border-radius: 8px; color: var(--panel); background: var(--accent); font-size: 11px; line-height: 16px; text-align: center; }
  .list { position: absolute; right: 0; top: calc(100% + 4px); z-index: 20; list-style: none; margin: 0; padding: 6px; min-width: 320px; max-width: 520px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); box-shadow: 0 12px 32px rgba(16, 24, 40, 0.24); }
  .list li + li { margin-top: 4px; }
  .entry { width: 100%; height: auto; min-height: 30px; padding: 4px 8px; justify-content: flex-start; text-align: left; white-space: normal; color: var(--text); }
  .who { font-weight: 700; color: var(--accent); }
</style>
