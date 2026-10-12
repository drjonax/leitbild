<script lang="ts">
  import type { BoardView, ClickTarget } from '../board/types.ts'

  /**
   * The action bar: what the next tap sends, and the buttons that do it. For
   * a selected call it holds the proposal as one big button and the
   * alternatives one tap each, then what is still needed and which units
   * cannot come. For a confirmation or a busy asset's choice it names what is
   * dropped; for a highlighted asset it holds its verbs. Every button is a
   * tap target of at least 44 px, and no key is hinted.
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
  {#if commit.button !== commit.text}<p class="text">{commit.text}</p>{/if}
  {#if commit.detail !== null}<p class="detail">{commit.detail}</p>{/if}
  {#if commit.button !== null || commit.options.length > 0 || commit.verbs.length > 0 || commit.cancel !== null}
    <div class="buttons">
      {#if commit.button !== null}
        <button type="button" class="primary" disabled={!commit.enabled} onclick={() => click({ kind: 'commit' })}>{commit.button}</button>
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
  {/if}
  {#if commit.hint !== null}<p class="hint">{commit.hint}</p>{/if}
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
  .text { font-weight: 650; }
  .detail { color: var(--warning); font-size: 12px; }
  .buttons, .alternatives { display: flex; flex-wrap: wrap; gap: 6px; }
  button { min-height: 44px; min-width: 44px; padding: 6px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel-strong); color: inherit; font: inherit; cursor: pointer; touch-action: manipulation; }
  button:disabled { color: var(--muted); cursor: default; }
  .primary { flex: 1 1 auto; border-color: var(--accent); background: var(--accent); color: white; font-weight: 650; font-variant-numeric: tabular-nums; text-align: left; }
  .primary:disabled { border-color: var(--border); background: var(--panel-strong); color: var(--muted); }
  /* Dark text on the warning colour reads at 4.5:1 or better in both themes; white would not in the dark one. */
  .bar[data-state='confirm'] .primary:enabled, .bar[data-state='choice'] .primary:enabled { border-color: var(--warning); background: var(--warning); color: color-mix(in srgb, var(--warning) 15%, black); }
  .cancel { background: var(--panel); }
  .alternatives button { display: inline-flex; gap: 6px; align-items: baseline; }
  .alternatives button.chosen { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
  .divert { color: var(--warning); }
  .hint { color: var(--warning); font-size: 12px; }
  .remainder { color: var(--warning); font-size: 12px; }
  .ineligible { color: var(--muted); font-size: 12px; }
  .num { font-variant-numeric: tabular-nums; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
</style>
