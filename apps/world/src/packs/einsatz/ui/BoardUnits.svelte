<script lang="ts">
  import type { ClickTarget, UnitRow } from '../board/types.ts'
  import BoardIcon from './BoardIcon.svelte'
  import { unitFacts, unitIconTone } from './board-presenter.ts'

  /** The unit board: the units the screen commands that can move, free first, each with its verbs. */
  interface Props {
    readonly heading: string
    readonly focused: boolean
    readonly rows: ReadonlyArray<UnitRow>
    /** What the board says while it holds no unit. */
    readonly empty: string | null
    readonly icon: (id: string) => string | undefined
    readonly click: (target: ClickTarget) => void
  }

  const { heading, focused, rows, empty, icon, click }: Props = $props()
</script>

<section class="board-section" aria-label={heading}>
  <h3 class:focused>{heading}</h3>
  {#if empty !== null}<p class="empty">{empty}</p>{/if}
  <ol class="rows">
    {#each rows as row (row.id)}
      <li class="row" class:selected={row.selected} class:free={row.free} class:armed={row.moveArmed} class:destroyed={row.destroyed}>
        <button type="button" class="row-main" aria-pressed={row.selected} title={row.propertiesText ?? undefined} onclick={() => click({ kind: 'row', list: 'units', id: row.id })}>
          <BoardIcon svg={icon(row.icon)} tone={unitIconTone(row)} />
          <span class="row-text">
            <span class="line">
              <strong>{row.label}</strong>
              <span class="type">{row.typeLabel}</span>
              <span class="phase">{row.phaseText} <span class="num">{row.phaseAgeText}</span></span>
            </span>
            {#if unitFacts(row).length > 0}
              <span class="line sub">
                {#each unitFacts(row) as entry, index (index)}<span class:num={entry.numeric}>{entry.text}</span>{/each}
              </span>
            {/if}
            {#each row.alerts as alert, index (index)}<span class="line alert">{alert}</span>{/each}
          </span>
        </button>
        <span class="verbs">
          <button type="button" class="verb" title="R" onclick={() => click({ kind: 'verb', verb: 'recall', id: row.id })}><kbd>R</kbd> {row.recallLabel}</button>
          <button type="button" class="verb" title="H" onclick={() => click({ kind: 'verb', verb: 'hold', id: row.id })}><kbd>H</kbd> {row.holdLabel}</button>
          <button type="button" class="verb" class:armed={row.moveArmed} title="M" onclick={() => click({ kind: 'verb', verb: 'move', id: row.id })}><kbd>M</kbd> {row.moveLabel}</button>
        </span>
      </li>
    {/each}
  </ol>
</section>

<style>
  .board-section { display: grid; gap: 6px; }
  h3 { margin: 0; color: var(--muted); font-size: 11px; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
  h3.focused { color: var(--accent); }
  .empty { margin: 0; color: var(--muted); }
  .rows { margin: 0; padding: 0; list-style: none; display: grid; gap: 4px; }
  .row { display: grid; gap: 2px; padding-bottom: 6px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
  .row.free { border-left: 3px solid var(--success); }
  .row.selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .row.armed { border-style: dashed; }
  .row.destroyed { opacity: .6; }
  .row-main { min-width: 0; display: flex; gap: 8px; align-items: flex-start; padding: 7px 8px 2px; border: 0; background: transparent; color: inherit; text-align: left; cursor: pointer; }
  .row-text { min-width: 0; display: grid; gap: 2px; }
  .line { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
  .sub { color: var(--muted); font-size: 12px; }
  .type { color: var(--muted); }
  .phase { margin-left: auto; }
  .alert { color: var(--critical); font-size: 12px; }
  .num { font-variant-numeric: tabular-nums; }
  .verbs { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 8px 0 38px; }
  .verb { padding: 2px 7px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel-strong); color: inherit; font-size: 12px; cursor: pointer; }
  .verb.armed { border-color: var(--accent); color: var(--accent); }
  kbd { padding: 0 4px; border: 1px solid var(--border); border-radius: 4px; font: inherit; font-size: 11px; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
</style>
