<script lang="ts">
  import type { BoardView, ClickTarget } from '../board/types.ts'

  /**
   * The action bar: what the next tap sends, and the buttons that do it. For
   * a selected call it holds the proposal as one big button and the
   * alternatives one tap each, then what is still needed and which units
   * cannot come. For a confirmation or a busy asset's choice it names what is
   * dropped; for a highlighted asset it holds its verbs. An asset that
   * lingered highlighted when a call or a site was tapped in the lists is
   * offered as a button of its own. Closing the call is pinned to the right
   * of the first row of buttons, apart from the commit button and in its own
   * colour: the bar scrolls inside past its cap, and only the text line
   * stands above that row, so Close is in view without scrolling, and the
   * row never moves: what a confirmation drops stands below it. The text
   * line is always there, one line high: it holds what the bar says, or
   * while the guard runs, what the next commit acts on, so the guard's hint
   * never pushes the buttons down. The alternatives keep to one row, which
   * scrolls sideways when they do not fit. Every button is a tap target of
   * at least 44 px, and no key is hinted.
   */
  interface Props {
    readonly commit: BoardView['commit']
    readonly selected: BoardView['selected']
    readonly click: (target: ClickTarget) => void
  }

  const { commit, selected, click }: Props = $props()
  const task = $derived(selected?.kind === 'task' && (commit.state === 'ready' || commit.state === 'none' || commit.state === 'preparing') ? selected : null)
</script>

<div class="bar" data-state={commit.state}>
  <p class="text" class:hint={commit.hint !== null}>{commit.hint ?? (commit.button === commit.text ? '' : commit.text)}</p>
  {#if commit.button !== null || commit.offer !== null || commit.options.length > 0 || commit.verbs.length > 0 || commit.cancel !== null || commit.close !== null}
    <div class="buttons">
      <div class="main">
        {#if commit.button !== null}
          <button type="button" class="primary" disabled={!commit.enabled} onclick={() => click({ kind: 'commit' })}>{commit.button}</button>
        {/if}
        {#if commit.offer !== null}
          <button type="button" class="offer" disabled={!commit.enabled} onclick={() => click({ kind: 'offer' })}>{commit.offer}</button>
        {/if}
        {#each commit.options as entry (entry.option)}
          <button type="button" class="primary" disabled={!commit.enabled} onclick={() => click({ kind: 'option', option: entry.option })}>{entry.label}</button>
        {/each}
        {#each commit.verbs as entry (entry.verb)}
          <button type="button" class="verb" onclick={() => click({ kind: 'verb', verb: entry.verb, id: entry.id })}>{entry.label}</button>
        {/each}
        {#if commit.cancel !== null}
          <button type="button" class="cancel" onclick={() => click({ kind: 'cancel' })}>{commit.cancel}</button>
        {/if}
      </div>
      {#if commit.close !== null}
        <button type="button" class="close" onclick={() => click({ kind: 'verb', verb: 'close', id: commit.close!.id })}>{commit.close.label}</button>
      {/if}
    </div>
  {/if}
  {#if commit.detail !== null}<p class="detail">{commit.detail}</p>{/if}
  {#if task !== null}
    {#if task.alternatives.length > 0}
      <div class="alternatives">
        {#each task.alternatives as alternative (alternative.number)}
          <button type="button" class:chosen={alternative.chosen} disabled={commit.hint !== null} onclick={() => click({ kind: 'alternative', number: alternative.number })}>
            <strong>{alternative.label}</strong>
            {#if alternative.etaText !== null}<span class="num">{alternative.etaText}</span>{/if}
            {#if alternative.divertText !== null}<span class="divert">{alternative.divertText}</span>{/if}
          </button>
        {/each}
      </div>
    {/if}
    {#if task.remainderText !== null}<p class="remainder">{task.remainderText}</p>{/if}
    {#each task.ineligible as line, index (index)}<p class="ineligible">{line}</p>{/each}
  {/if}
</div>

<style>
  .bar { display: grid; align-content: start; gap: 4px; }
  p { margin: 0; }
  /* One line, always: the hint takes the text's place rather than a line of its own. */
  .text { min-height: var(--board-line); overflow: hidden; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
  .text.hint { color: var(--warning); font-size: 12px; }
  .detail { color: var(--warning); font-size: 12px; }
  /* The first row: the buttons that act, wrapping among themselves, and Close pinned to its right, never wrapping below them. */
  .buttons { display: flex; align-items: flex-start; gap: 18px; }
  .main { display: flex; flex-wrap: wrap; gap: 6px; }
  /* One row of alternatives, never a second one half cut off: it scrolls sideways. */
  .alternatives { display: flex; flex-wrap: nowrap; gap: 6px; overflow-x: auto; overscroll-behavior: contain; }
  .alternatives button { flex: none; }
  .main { flex: 1 1 auto; min-width: 0; }
  button { min-height: 44px; min-width: 44px; padding: 6px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel-strong); color: inherit; font: inherit; cursor: pointer; touch-action: manipulation; }
  button:disabled { color: var(--muted); cursor: default; }
  .primary { flex: 1 1 auto; border-color: var(--accent); background: var(--accent); color: white; font-weight: 650; font-variant-numeric: tabular-nums; text-align: left; }
  .primary:disabled { border-color: var(--border); background: var(--panel-strong); color: var(--muted); }
  /* Dark text on the warning colour reads at 4.5:1 or better in both themes; white would not in the dark one. */
  .bar[data-state='confirm'] .primary:enabled, .bar[data-state='choice'] .primary:enabled { border-color: var(--warning); background: var(--warning); color: color-mix(in srgb, var(--warning) 15%, black); }
  .cancel { background: var(--panel); }
  .offer { flex: 1 1 auto; border-color: var(--accent); background: var(--panel); color: var(--accent); font-weight: 650; text-align: left; }
  .offer:disabled { border-color: var(--border); color: var(--muted); }
  /* Closing a call ends it: it stands apart from the commit button and reads as no commit. */
  .close { flex: none; background: var(--panel); border-color: var(--critical); color: var(--critical); }
  .alternatives button { display: inline-flex; gap: 6px; align-items: baseline; }
  .alternatives button.chosen { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
  .divert { color: var(--warning); }
  .remainder { color: var(--warning); font-size: 12px; }
  .ineligible { color: var(--muted); font-size: 12px; }
  .num { font-variant-numeric: tabular-nums; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
</style>
