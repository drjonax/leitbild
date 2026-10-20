<script lang="ts">
  import type { OperationalObject } from '../../core/model/object.ts'
  import { annunciatorTiles } from '../../features/displays/alerts/annunciator.ts'
  import { alertRows, type AlertRow } from '../../features/displays/alerts/rows.ts'
  import { alertStrip, type StripGroup } from '../../features/displays/alerts/strip.ts'
  import AlertList, { type AlertLine } from './AlertList.svelte'
  import { severityStyle } from './severity.ts'

  // The read-only alarm strip above the operational map (plan v3.1 §2.7; lead
  // ruling R14), shown while the Run has active or returned-unacknowledged
  // alerts. One row per group, the cap on rows: a unit's row names its
  // first-out and counts its others, which head the group's opened list. It acknowledges,
  // shelves and suppresses nothing. Whether the viewer keeps it folded is that
  // viewer's own convenience, in browser storage.
  let { objects, categoryOf, theme, belowRoles, coverRight }: {
    objects: ReadonlyArray<OperationalObject>
    categoryOf: (object: OperationalObject) => string
    theme: 'light' | 'dark'
    belowRoles: boolean
    /** What open surface panels cover of the map's right edge (their declared map cover), which the strip leaves clear. */
    coverRight: number
  } = $props()

  const foldedKey = 'leitbild.alert-strip.folded'
  const readFolded = (): boolean => { try { return localStorage.getItem(foldedKey) === 'true' } catch { return false } }
  let folded = $state(readFolded())
  const fold = (): void => {
    folded = !folded
    try { localStorage.setItem(foldedKey, String(folded)) } catch { /* the strip works the same unremembered */ }
  }

  let innerHeight = $state(800)
  let innerWidth = $state(1280)
  const palette = $derived(theme === 'dark' ? 'dusk' : 'day')
  const rows = $derived(alertRows(objects, object => ({ label: object.label, categoryId: categoryOf(object) })))
  // The rows the frame's share of the height holds (T17: ≤ 30 % on a desk), less the header; a phone row wraps to
  // about two. Every unit's first-out keeps its row (plan §2.10: every unit's first-out visible), so a flood may take more.
  const maxRows = $derived(Math.max(1, Math.floor((innerHeight * 0.3) / (innerWidth < 600 ? 36 : 22)) - 1))
  const strip = $derived(alertStrip(rows, { maxRows }))
  const unack = $derived(strip.groups.reduce((sum, group) => sum + group.counts.unack, 0))
  /** The group's other first-outs (annunciatorTiles), in the order their groups came in. */
  const otherFirstOuts = (group: StripGroup): ReadonlyArray<AlertRow> => annunciatorTiles(rows, group.key)
    .filter(tile => tile.rank === 1 && tile.rowKey !== group.rows[0]!.key)
    .map(tile => group.rows.find(row => row.key === tile.rowKey)!)
  const lineOf = (group: StripGroup): AlertLine => ({
    row: group.rows[0]!, heading: group.label, firstOut: group.firstOut !== null, moreFirstOuts: otherFirstOuts(group).length,
    detail: `${group.counts.unack} unack${group.counts.standing > 0 ? ` · ${group.counts.standing} standing` : ''}`,
  })
  const rule = 'Read-only: acknowledge, shelve and suppress where each alarm is raised. The Assistant may acknowledge alarms where a Pack lets it; a row says "acknowledged by Assistant" where its Pack records who acknowledged.'
</script>

<svelte:window bind:innerHeight bind:innerWidth />

{#if strip.groups.length > 0}
  <section class="alert-strip" class:below={belowRoles} style:--cover-right={`${coverRight}px`} aria-label="Alarms">
    <header title={rule}>
      <span>Alarms · {strip.groups.length} {strip.groups.length === 1 ? 'group' : 'groups'} · {unack} unacknowledged</span>
      <button type="button" aria-expanded={!folded} onclick={fold}>{folded ? 'Show' : 'Fold'}</button>
    </header>
    {#if !folded}
      {#each strip.groups.filter(group => !group.collapsed) as group (group.key)}
        {@const others = otherFirstOuts(group)}
        <details>
          <summary><AlertList lines={[lineOf(group)]} {palette} /></summary>
          <AlertList lines={[...others, ...group.rows.slice(1).filter(row => !others.includes(row))].map(row => ({ row, firstOut: others.includes(row) }))} {palette} />
          <p class="rule">{rule}</p>
        </details>
      {/each}
      {#if strip.collapsed !== null}
        {@const worst = strip.collapsed.worst}
        <details>
          <summary class="more">+{strip.collapsed.groups} {strip.collapsed.groups === 1 ? 'group' : 'groups'} · {worst === null ? 'priority not declared' : severityStyle(worst, 'info')!.word} · {strip.collapsed.unack} unack</summary>
          <AlertList lines={strip.groups.filter(group => group.collapsed).map(lineOf)} {palette} />
        </details>
      {/if}
    {/if}
  </section>
{/if}

<style>
  /* Beside the rail, but never narrower than 640 px: a narrow map (the chat open) lends the strip the rail's edge. */
  .alert-strip { --strip-left: max(12px, min(calc(var(--rail-width, 0px) + 12px), calc(100vw - 652px))); position: fixed; z-index: 16; top: 12px; left: var(--strip-left); box-sizing: border-box; width: min(960px, calc(100vw - var(--strip-left) - var(--cover-right) - 12px)); max-height: 50vh; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; padding: 4px 8px; border: 1px solid var(--border); border-radius: 6px; background: color-mix(in srgb, var(--panel) 96%, transparent); box-shadow: 0 4px 14px rgba(0, 0, 0, 0.16); color: var(--text); font-size: 12px; }
  .alert-strip.below { top: 52px; }
  @media (max-width: 599px) { .alert-strip { max-height: 70vh; } }
  header { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-weight: 650; }
  header button { min-height: 24px; padding: 0 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--panel); color: var(--text); font-size: 12px; cursor: pointer; }
  summary { cursor: pointer; list-style: none; }
  summary::-webkit-details-marker { display: none; }
  details[open] > summary { margin-bottom: 2px; }
  details > :global(.alert-list) { margin-left: 12px; }
  .more { color: var(--muted); font-weight: 650; }
  .rule { margin: 4px 0 2px 12px; color: var(--muted); font-size: 12px; }
</style>
