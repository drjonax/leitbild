<script lang="ts">
  import type { ContactsView } from '../board/types.ts'
  import BoardIcon from './BoardIcon.svelte'
  import { contactFacts, contactIconTone } from './board-presenter.ts'

  /**
   * The Contacts list: the screen's tracks, engageable first, each group
   * nearest first; nothing collapsed. A screen holding several sides' tracks
   * shows each side under its label.
   */
  interface Props {
    readonly contacts: ContactsView
    readonly icon: (id: string) => string | undefined
  }

  const { contacts, icon }: Props = $props()
</script>

<section class="board-section" aria-label={contacts.heading}>
  <h3 title={contacts.hover}>{contacts.heading}</h3>
  {#each contacts.sides as side, sideIndex (sideIndex)}
    <div class="side" class:labelled={side.label !== null}>
      {#if side.label !== null}<h4 class="side-label">{side.label}</h4>{/if}
      {#each [side.engageable, side.other] as group, groupIndex (groupIndex)}
        <div class="group">
          <h5>{group.heading} <span class="num">{group.rows.length}</span></h5>
          {#if group.empty !== null}<p class="empty">{group.empty}</p>{/if}
          <ol class="rows">
            {#each group.rows as row (row.id)}
              <li class="row" class:destroyed={row.destroyed} title={contacts.hover}>
                <BoardIcon svg={icon(row.icon)} tone={contactIconTone(row)} />
                <span class="row-text">
                  <strong>{row.label}</strong>
                  <span class="line sub">
                    {#each contactFacts(row) as entry, index (index)}<span class:num={entry.numeric}>{entry.text}</span>{/each}
                  </span>
                </span>
              </li>
            {/each}
          </ol>
        </div>
      {/each}
    </div>
  {/each}
</section>

<style>
  .board-section { display: grid; gap: 6px; }
  h3 { margin: 0; color: var(--muted); font-size: 11px; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
  .side { display: grid; gap: 6px; }
  .side.labelled { padding-left: 6px; border-left: 2px solid var(--border); }
  h4 { margin: 0; font-size: 12px; font-weight: 750; }
  h5 { margin: 0; font-size: 12px; font-weight: 650; }
  .group { display: grid; gap: 4px; }
  .empty { margin: 0; color: var(--muted); font-size: 12px; }
  .rows { margin: 0; padding: 0; list-style: none; display: grid; gap: 3px; }
  .row { display: flex; gap: 8px; align-items: flex-start; padding: 5px 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
  .row.destroyed { opacity: .6; }
  .row-text { min-width: 0; display: grid; gap: 2px; }
  .line { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
  .sub { color: var(--muted); font-size: 12px; }
  .num { font-variant-numeric: tabular-nums; }
</style>
