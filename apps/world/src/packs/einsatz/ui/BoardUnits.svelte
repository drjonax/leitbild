<script lang="ts">
  import type { ClickTarget, UnitRow } from '../board/types.ts'
  import BoardIcon from './BoardIcon.svelte'
  import { unitFacts, unitIconTone } from './board-presenter.ts'
  import { revealWhen } from './reveal.ts'

  /**
   * Assets: the units the screen commands that can move, free first, each one
   * tap. A tap highlights the asset, a second tap lets it go; the action bar
   * then holds its verbs. Each row shows its job chain, the active step and
   * then the queued ones as "next", and a + that makes the next target tap
   * join the end of the chain. A highlighted row shows every property and a
   * × on each step, so nothing depends on hover.
   */
  interface Props {
    readonly heading: string
    readonly focused: boolean
    readonly rows: ReadonlyArray<UnitRow>
    /** What the list says while it holds no unit. */
    readonly empty: string | null
    /** The labels of the + and × buttons, for assistive technology; the buttons show the signs. */
    readonly addLabel: string
    readonly removeLabel: string
    readonly icon: (id: string) => string | undefined
    readonly click: (target: ClickTarget) => void
  }

  const { heading, focused, rows, empty, addLabel, removeLabel, icon, click }: Props = $props()
</script>

<section class="board-section" aria-label={heading}>
  <h3 class:focused>{heading}</h3>
  <div class="scroll">
    {#if empty !== null}<p class="empty">{empty}</p>{/if}
    <ol class="rows">
      {#each rows as row (row.id)}
        <li class="row" class:selected={row.selected} class:free={row.free} class:armed={row.moveArmed || row.adding} class:destroyed={row.destroyed} use:revealWhen={row.selected}>
          <div class="row-head">
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
              {#if !row.selected && row.chain.length > 0}
                <span class="line chain">{#each row.chain as step (step.stepId)}<span class:active={step.active}>{step.text}</span>{/each}</span>
              {/if}
              {#if row.selected && row.propertiesText !== null}<span class="line sub">{row.propertiesText}</span>{/if}
              {#each row.alerts as alert, index (index)}<span class="line alert">{alert}</span>{/each}
            </span>
          </button>
          {#if row.canAdd}
            <button type="button" class="add" class:on={row.adding} aria-pressed={row.adding} aria-label={`${addLabel} · ${row.label}`} onclick={() => click({ kind: 'verb', verb: 'add', id: row.id })}>+</button>
          {/if}
          </div>
          {#if row.selected && row.chain.length > 0}
            <ol class="steps">
              {#each row.chain as step (step.stepId)}
                <li class="step" class:active={step.active}>
                  <span class="step-text">{step.text}</span>
                  {#if step.removable}
                    <button type="button" class="remove" aria-label={`${removeLabel} ${step.text}`} onclick={() => click({ kind: 'remove-step', unitId: row.id, stepId: step.stepId })}>×</button>
                  {/if}
                </li>
              {/each}
            </ol>
          {/if}
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
  .row-head { display: flex; align-items: stretch; }
  .add { flex: none; width: 44px; min-height: 44px; border: 0; border-left: 1px solid var(--border); border-radius: 0 8px 8px 0; background: transparent; color: var(--accent); font: inherit; font-size: 20px; font-weight: 650; cursor: pointer; touch-action: manipulation; }
  .add.on { background: var(--accent); color: white; }
  .chain { color: var(--muted); font-size: 12px; }
  .chain .active { color: var(--text); }
  .steps { margin: 0; padding: 0 8px 6px 46px; list-style: none; display: grid; gap: 4px; }
  .step { display: flex; align-items: center; gap: 6px; min-height: 44px; padding-left: 8px; border: 1px solid var(--border); border-radius: 6px; font-size: 12px; }
  .step.active { border-color: var(--accent); }
  .step-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .remove { flex: none; width: 44px; min-height: 44px; border: 0; border-left: 1px solid var(--border); border-radius: 0 6px 6px 0; background: transparent; color: var(--critical); font: inherit; font-size: 18px; cursor: pointer; touch-action: manipulation; }
  .row-main { flex: 1; min-width: 0; min-height: 44px; display: flex; gap: 8px; align-items: flex-start; padding: var(--row-pad) 8px; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; touch-action: manipulation; }
  .row-text { flex: 1; min-width: 0; display: grid; gap: var(--line-gap); }
  .line { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
  .sub { color: var(--muted); font-size: 12px; }
  .type { color: var(--muted); }
  .phase { margin-left: auto; }
  .alert { color: var(--critical); font-size: 12px; }
  .num { font-variant-numeric: tabular-nums; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
</style>
