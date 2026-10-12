<script lang="ts">
  import type { ClickTarget, UnitRow } from '../board/types.ts'
  import BoardIcon from './BoardIcon.svelte'
  import { unitFacts, unitIconTone } from './board-presenter.ts'
  import { revealWhen } from './reveal.ts'

  /**
   * Assets: the units the screen commands that can move, free first, each one
   * tap. A tap highlights the asset, a second tap lets it go; the action bar
   * then holds its verbs. A highlighted row shows every property, so nothing
   * depends on hover.
   */
  interface Props {
    readonly heading: string
    readonly focused: boolean
    readonly rows: ReadonlyArray<UnitRow>
    /** What the list says while it holds no unit. */
    readonly empty: string | null
    readonly icon: (id: string) => string | undefined
    readonly click: (target: ClickTarget) => void
  }

  const { heading, focused, rows, empty, icon, click }: Props = $props()
</script>

<section class="board-section" aria-label={heading}>
  <h3 class:focused>{heading}</h3>
  <div class="scroll">
    {#if empty !== null}<p class="empty">{empty}</p>{/if}
    <ol class="rows">
      {#each rows as row (row.id)}
        <li class="row" class:selected={row.selected} class:free={row.free} class:armed={row.moveArmed} class:destroyed={row.destroyed} use:revealWhen={row.selected}>
          <button type="button" class="row-main" aria-pressed={row.selected} onclick={() => click({ kind: 'row', list: 'units', id: row.id })}>
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
              {#if row.selected && row.propertiesText !== null}<span class="line sub">{row.propertiesText}</span>{/if}
              {#each row.alerts as alert, index (index)}<span class="line alert">{alert}</span>{/each}
            </span>
          </button>
        </li>
      {/each}
    </ol>
  </div>
</section>

<style>
  .board-section { min-height: 0; display: grid; grid-template-rows: auto minmax(0, 1fr); gap: var(--heading-gap); }
  h3 { margin: 0; color: var(--muted); font-size: 11px; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
  h3.focused { color: var(--accent); }
  .scroll { min-height: 0; overflow: auto; overscroll-behavior: contain; }
  .empty { margin: 0; color: var(--muted); }
  .rows { margin: 0; padding: 0; list-style: none; display: grid; gap: var(--row-gap); }
  .row { border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
  .row.free { border-left: 3px solid var(--success); }
  .row.selected { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent); }
  .row.armed { border-style: dashed; }
  .row.destroyed { opacity: .6; }
  .row-main { width: 100%; min-height: 44px; display: flex; gap: 8px; align-items: flex-start; padding: var(--row-pad) 8px; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; touch-action: manipulation; }
  .row-text { flex: 1; min-width: 0; display: grid; gap: var(--line-gap); }
  .line { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
  .sub { color: var(--muted); font-size: 12px; }
  .type { color: var(--muted); }
  .phase { margin-left: auto; }
  .alert { color: var(--critical); font-size: 12px; }
  .num { font-variant-numeric: tabular-nums; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
</style>
