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
  let { objects, categoryOf, theme, belowRoles, clear }: {
    objects: ReadonlyArray<OperationalObject>
    categoryOf: (object: OperationalObject) => string
    theme: 'light' | 'dark'
    belowRoles: boolean
    /** What the strip keeps clear of: the map covers open surface panels declare on either side, and the briefing card's bottom edge above it. */
    clear: { readonly left: number; readonly right: number; readonly top: number }
  } = $props()

  const foldedKey = 'leitbild.alert-strip.folded'
  const readFolded = (): boolean => { try { return localStorage.getItem(foldedKey) === 'true' } catch { return false } }
  let folded = $state(readFolded())
  const fold = (): void => {
    folded = !folded
    try { localStorage.setItem(foldedKey, String(folded)) } catch { /* the strip works the same unremembered */ }
  }

  let innerHeight = $state(800)
  const palette = $derived(theme === 'dark' ? 'dusk' : 'day')
  const rows = $derived(alertRows(objects, object => ({ label: object.label, categoryId: categoryOf(object) })))
  // The rows the frame's share of the height holds (T17: ≤ 30 % on a desk), less the header; a narrow strip keeps each
  // group to one line. Every unit's first-out keeps its row (plan §2.10: every unit's first-out visible).
  const maxRows = $derived(Math.max(1, Math.floor((innerHeight * 0.3) / 22) - 1))
  const strip = $derived(alertStrip(rows, { maxRows }))
  const unack = $derived(strip.groups.reduce((sum, group) => sum + group.counts.unack, 0))
  /** The group's other first-outs (annunciatorTiles), in the order their groups came in. */
  const otherFirstOuts = (group: StripGroup): ReadonlyArray<AlertRow> => annunciatorTiles(rows, group.key)
    .filter(tile => tile.rank === 1 && tile.rowKey !== group.rows[0]!.key)
    .map(tile => group.rows.find(row => row.key === tile.rowKey)!)
  const lineOf = (group: StripGroup): AlertLine => ({
    row: group.rows[0]!, heading: group.label, firstOut: group.firstOut !== null, moreFirstOuts: otherFirstOuts(group).length,
    detail: `${group.counts.unack} unack${group.counts.standing > 0 ? ` · ${group.counts.standing} standing` : ''}${group.counts.advisory > 0 ? ` · ${group.counts.advisory} advisory` : ''}`,
  })
  const rule = 'Read-only: acknowledge, shelve and suppress where each alarm is raised. The Assistant may acknowledge alarms where a Pack lets it; a row says "acknowledged by Assistant" where its Pack records who acknowledged.'
</script>

<svelte:window bind:innerHeight />

{#if strip.groups.length > 0}
  <section class="alert-strip" class:below={belowRoles} style:--cover-left={`${clear.left}px`} style:--cover-right={`${clear.right}px`} style:--clear-top={`${clear.top}px`} aria-label="Alarms">
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
  /* Clear of declared covers on both sides and below the briefing card, but never below half the pane and never past
     its bottom. A narrow map (the chat open) lends the strip the rail's edge, so it keeps 640 px, but never a left
     cover's: 12 px + cover × 1000 is 12 px only when none. */
  .alert-strip { --want: calc(var(--rail-width, 0px) + var(--cover-left) + 12px); --edge: calc(100vw - var(--cover-right) - 12px); --strip-left: max(min(var(--want), calc(12px + var(--cover-left) * 1000)), min(var(--want), calc(var(--edge) - 640px)));
    --strip-top: min(max(var(--top-min, 12px), calc(var(--clear-top) + 8px)), 50vh); position: fixed; z-index: 16; top: var(--strip-top); left: var(--strip-left); box-sizing: border-box; width: min(960px, calc(var(--edge) - var(--strip-left))); max-height: min(50vh, calc(100vh - var(--strip-top) - 12px)); overflow-y: auto; container: alert-strip / inline-size; display: flex; flex-direction: column; gap: 2px; padding: 4px 8px; border: 1px solid var(--border); border-radius: 6px; background: color-mix(in srgb, var(--panel) 96%, transparent); box-shadow: 0 4px 14px rgba(0, 0, 0, 0.16); color: var(--text); font-size: 12px; }
  .alert-strip.below { --top-min: 52px; }
  @media (max-width: 599px) { .alert-strip { max-height: min(70vh, calc(100vh - var(--strip-top) - 12px)); } }
  header { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-weight: 650; }
  header button { min-height: 24px; padding: 0 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--panel); color: var(--text); font-size: 12px; cursor: pointer; }
  summary { cursor: pointer; list-style: none; }
  summary::-webkit-details-marker { display: none; }
  details[open] > summary { margin-bottom: 2px; }
  details > :global(.alert-list) { margin-left: 12px; }
  .more { color: var(--muted); font-weight: 650; }
  .rule { margin: 4px 0 2px 12px; color: var(--muted); font-size: 12px; }
</style>
