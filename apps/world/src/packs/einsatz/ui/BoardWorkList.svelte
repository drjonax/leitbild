<script lang="ts">
  import type { ClickTarget, SelectedTask, WorkRow } from '../board/types.ts'
  import BoardIcon from './BoardIcon.svelte'
  import { workFacts } from './board-presenter.ts'

  /** The work list: one row per open task in the queue, the selected one opened on its proposal and numbered alternatives. */
  interface Props {
    readonly heading: string
    readonly focused: boolean
    readonly rows: ReadonlyArray<WorkRow>
    readonly empty: string | null
    readonly selected: SelectedTask | null
    readonly icon: (id: string) => string | undefined
    readonly click: (target: ClickTarget) => void
  }

  const { heading, focused, rows, empty, selected, icon, click }: Props = $props()
</script>

<section class="board-section" aria-label={heading}>
  <h3 class:focused>{heading}</h3>
  {#if empty !== null}<p class="empty">{empty}</p>{/if}
  <ol class="rows">
    {#each rows as row (row.id)}
      <li class="row" class:selected={row.selected} class:fresh={row.fresh} class:served={row.served}>
        <div class="row-head">
          <button type="button" class="row-main" aria-pressed={row.selected} onclick={() => click({ kind: 'row', list: 'work', id: row.id })}>
            <BoardIcon svg={icon(row.icon)} tone="task" />
            <span class="row-text">
              <span class="line">
                <strong>{row.label}</strong>
                <span class="code">{row.code}</span>
                {#if row.needText !== null}<span class="need">{row.needText}</span>{/if}
                <span class="num age">{row.ageText}</span>
              </span>
              <span class="line sub">{workFacts(row).map(entry => entry.text).join(' · ')}</span>
              {#if row.etaText !== null || row.statusText !== null}
                <span class="line sub">
                  {#if row.etaText !== null}<span class="num">{row.etaText}</span>{/if}
                  {#if row.statusText !== null}<span class="status">{row.statusText}</span>{/if}
                </span>
              {/if}
              {#each row.alerts as alert, index (index)}<span class="line alert">{alert}</span>{/each}
            </span>
          </button>
          <button type="button" class="verb" title="C" onclick={() => click({ kind: 'verb', verb: 'close', id: row.id })}><kbd>C</kbd> {row.closeLabel}</button>
        </div>
        {#if selected !== null && selected.id === row.id}
          <div class="detail">
            {#if selected.proposal.length > 0}
              <p class="proposal">
                {#each selected.proposal as unit, index (unit.unitId)}
                  {#if index > 0}<span> + </span>{/if}<strong>{unit.label}</strong> <span class="num">{unit.etaText}</span>{#if unit.divertText !== null}<span class="divert"> · {unit.divertText}</span>{/if}
                {/each}
              </p>
            {/if}
            {#if selected.remainderText !== null}<p class="remainder">{selected.remainderText}</p>{/if}
            {#if selected.alternatives.length > 0}
              <ol class="alternatives">
                {#each selected.alternatives as alternative (alternative.number)}
                  <li>
                    <button
                      type="button"
                      class:chosen={alternative.chosen}
                      class:dropped={alternative.dropped !== null}
                      title={alternative.dropped ?? undefined}
                      onclick={() => click({ kind: 'alternative', number: alternative.number })}
                    >
                      <kbd>{alternative.number}</kbd>
                      <span>{alternative.label}</span>
                      {#if alternative.etaText !== null}<span class="num">{alternative.etaText}</span>{/if}
                      {#if alternative.divertText !== null}<span class="divert">{alternative.divertText}</span>{/if}
                      {#if alternative.dropped !== null}<span class="why">{alternative.dropped}</span>{/if}
                    </button>
                  </li>
                {/each}
              </ol>
            {/if}
            {#each selected.ineligible as entry, index (index)}
              <p class="ineligible"><strong>{entry.label}</strong> · {entry.reasons.join(' · ')}</p>
            {/each}
          </div>
        {/if}
      </li>
    {/each}
  </ol>
</section>

<style>
  .board-section { display: grid; gap: 6px; }
  h3 { margin: 0; color: var(--muted); font-size: 11px; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
  h3.focused { color: var(--accent); }
  .empty { margin: 0; color: var(--muted); }
  .rows, .alternatives { margin: 0; padding: 0; list-style: none; display: grid; gap: 4px; }
  .row { border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
  .row.selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .row.served { opacity: .78; }
  .row.fresh { animation: fresh 1s ease-in-out 3; }
  @keyframes fresh { 50% { background: color-mix(in srgb, var(--warning) 22%, var(--panel)); } }
  .row-head { display: flex; align-items: stretch; }
  .row-main { flex: 1; min-width: 0; display: flex; gap: 8px; align-items: flex-start; padding: 7px 8px; border: 0; background: transparent; color: inherit; text-align: left; cursor: pointer; }
  .row-text { min-width: 0; display: grid; gap: 2px; }
  .line { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
  .sub { color: var(--muted); font-size: 12px; }
  .code { font-weight: 750; color: var(--critical); }
  .need { color: var(--warning); }
  .age { margin-left: auto; color: var(--muted); }
  .status { color: var(--text); }
  .alert { color: var(--critical); font-size: 12px; }
  .num { font-variant-numeric: tabular-nums; }
  .verb { flex: 0 0 auto; align-self: center; margin: 0 6px; padding: 3px 7px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel-strong); color: inherit; font-size: 12px; cursor: pointer; }
  kbd { padding: 0 4px; border: 1px solid var(--border); border-radius: 4px; font: inherit; font-size: 11px; font-variant-numeric: tabular-nums; }
  .detail { display: grid; gap: 6px; padding: 0 8px 8px 38px; font-size: 12px; }
  .detail p { margin: 0; }
  .divert { color: var(--warning); }
  .remainder { color: var(--warning); }
  .ineligible { color: var(--muted); }
  .alternatives button { width: 100%; display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; padding: 4px 6px; border: 1px solid var(--border); border-radius: 6px; background: transparent; color: inherit; text-align: left; cursor: pointer; }
  .alternatives button.chosen { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
  .alternatives button.dropped { opacity: .55; }
  .why { color: var(--critical); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
</style>
