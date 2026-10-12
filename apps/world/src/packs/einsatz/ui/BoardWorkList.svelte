<script lang="ts">
  import { boardWords } from '../board/text.ts'
  import type { ClickTarget, WorkRow } from '../board/types.ts'
  import BoardIcon from './BoardIcon.svelte'
  import { workFacts } from './board-presenter.ts'
  import { revealKey, revealWhen, waitingAbove } from './reveal.ts'

  /**
   * Calls: one row per open task in the queue, each one tap. With an asset
   * highlighted a tap sends it to the call; with none it selects the call,
   * whose proposal and alternatives the action bar then offers. A call that
   * units hold queued in their job chains says who comes next.
   *
   * Waiting calls come first, so one that arrives while the operator has
   * scrolled the list lands above what it shows: a marker in the list's
   * heading line counts the waiting rows whose title is out of view there,
   * and a tap on it scrolls the list back to the top. It covers no row: it
   * is drawn in the heading line, and only its tap area reaches past it.
   */
  interface Props {
    readonly heading: string
    readonly focused: boolean
    readonly rows: ReadonlyArray<WorkRow>
    readonly empty: string | null
    readonly icon: (id: string) => string | undefined
    readonly click: (target: ClickTarget) => void
  }

  const { heading, focused, rows, empty, icon, click }: Props = $props()

  let scroller = $state<HTMLElement | null>(null)
  let above = $state(0)
  /** Counts the waiting rows scrolled out of view above, as the list is laid out now. */
  const measure = (): void => {
    const list = scroller
    if (list === null) return
    const listed = [...list.querySelectorAll<HTMLElement>('li.row')].map(node => ({ waiting: node.dataset.waiting === 'true', top: node.offsetTop }))
    above = waitingAbove(listed, list.scrollTop)
  }
  // The rows change with every snapshot; once the list is laid out again, the count follows.
  $effect(() => {
    void rows
    measure()
  })
  const toTop = (): void => {
    scroller?.scrollTo({ top: 0 })
    measure()
  }
</script>

<section class="board-section" aria-label={heading}>
  <div class="head">
    <h3 class:focused>{heading}</h3>
    {#if above > 0}
      {#key above}<button type="button" class="above" onclick={toTop}>↑ {above} {boardWords.waitingAbove}</button>{/key}
    {/if}
  </div>
  <div class="list">
  <div class="scroll" bind:this={scroller} onscroll={measure}>
    {#if empty !== null}<p class="empty">{empty}</p>{/if}
    <ol class="rows">
      {#each rows as row, index (row.id)}
        <li class="row" data-waiting={!row.served} class:selected={row.selected} class:fresh={row.fresh} class:served={row.served} use:revealWhen={revealKey(row.selected, index, row.alerts.length)}>
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
              {#if row.nextText !== null}<span class="line sub next">{row.nextText}</span>{/if}
              {#if row.etaText !== null || row.statusText !== null}
                <span class="line sub">
                  {#if row.etaText !== null}<span class="num">{row.etaText}</span>{/if}
                  {#if row.statusText !== null}<span class="status">{row.statusText}</span>{/if}
                </span>
              {/if}
              {#each row.alerts as alert, index (index)}<span class="line alert">{alert}</span>{/each}
            </span>
          </button>
        </li>
      {/each}
    </ol>
  </div>
  </div>
</section>

<style>
  .board-section { min-height: 0; display: grid; grid-template-rows: auto minmax(0, 1fr); gap: var(--heading-gap); }
  h3 { margin: 0; color: var(--muted); font-size: 11px; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
  h3.focused { color: var(--accent); }
  .head { display: flex; align-items: center; gap: 8px; min-width: 0; height: var(--board-line); }
  .list { position: relative; min-height: 0; display: grid; grid-template-rows: minmax(0, 1fr); }
  /* The rows' offsets are measured from the list's own top. */
  .scroll { position: relative; min-height: 0; overflow: auto; overscroll-behavior: contain; }
  /*
   * In the heading line, beside the heading, one line high, so no row moves
   * or hides when it shows. Its tap area, a 44 px target, reaches up over the
   * left of the status line, where only the feedback text stands, and 4 px
   * down, into the gap above the first row.
   */
  .above { position: relative; z-index: 1; height: var(--board-line); box-sizing: border-box; padding: 0 10px; border: 1px solid var(--critical); border-radius: 8px; background: var(--panel); color: var(--critical); font: inherit; font-size: 12px; font-weight: 750; display: inline-flex; align-items: center; cursor: pointer; touch-action: manipulation; animation: fresh 1s ease-in-out 3; }
  .above::before { content: ''; position: absolute; inset: -24px -6px -4px; }
  .empty { margin: 0; color: var(--muted); }
  .rows { margin: 0; padding: 0; list-style: none; display: grid; gap: var(--row-gap); }
  .row { border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
  .row.selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .row.served { opacity: .78; }
  .row.fresh { animation: fresh 1s ease-in-out 3; }
  @keyframes fresh { 50% { background: color-mix(in srgb, var(--warning) 22%, var(--panel)); } }
  .row-main { width: 100%; min-height: 44px; display: flex; gap: 8px; align-items: flex-start; padding: var(--row-pad) 8px; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; touch-action: manipulation; }
  .row-text { flex: 1; min-width: 0; display: grid; gap: var(--line-gap); }
  .line { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
  .sub { color: var(--muted); font-size: 12px; }
  .code { font-weight: 750; color: var(--critical); }
  .need { color: var(--warning); }
  .age { margin-left: auto; color: var(--muted); }
  .status { color: var(--text); }
  .next { color: var(--accent); }
  .alert { color: var(--critical); font-size: 12px; }
  .num { font-variant-numeric: tabular-nums; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
</style>
