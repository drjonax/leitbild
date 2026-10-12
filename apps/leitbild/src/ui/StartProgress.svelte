<script lang="ts">
  // The staged progress of one Start (plan v2 §5.3): the real steps with text
  // state, one status sentence per step, the slow states, and on failure the
  // plain error with its next action. Rendered in place of the card's or the
  // row's actions, so nothing else on the page moves. The page announces each
  // step from its own persistent status region (startAnnouncement).
  import { onMount, tick } from 'svelte'
  import Icon from './Icon.svelte'
  import { LONG_START_TEXT, STILL_STARTING_TEXT, startStepStatus, startSteps, type StartState } from './definition-start.ts'

  let { progress, title, onretry, ondismiss, oncancel, onreload }: {
    progress: Exclude<StartState, { phase: 'idle' }>
    /** What is starting, for the heading ("Starting Supply run"). */
    title: string
    onretry: () => void
    ondismiss: () => void
    oncancel: () => void
    /** After an unknown outcome: read the page's catalogue again. */
    onreload: () => void
  } = $props()

  let heading = $state<HTMLElement | null>(null)
  let action = $state<HTMLElement | null>(null)
  const steps = $derived(startSteps(progress.moduleId))
  const index = $derived(steps.findIndex(step => step.id === progress.step))

  // Focus moves to the progress before the Start button disappears (a11y M2),
  // and to the first action when it fails.
  onMount(() => { heading?.focus() })
  $effect(() => {
    if (progress.phase === 'failed') void tick().then(() => action?.focus())
  })
</script>

<div class="start-progress" class:failed={progress.phase === 'failed'}>
  <p class="heading" tabindex="-1" bind:this={heading}>{progress.phase === 'failed' ? `Could not start ${title}` : `Starting ${title}`}</p>
  <ol>
    {#each steps as step, position (step.id)}
      {@const done = position < index}
      {@const current = position === index}
      <li class:done class:current aria-current={current && progress.phase === 'busy' ? 'step' : undefined}>
        <span class="mark" aria-hidden="true">{#if done}<Icon name="check" size={13} />{:else if current && progress.phase === 'failed'}!{/if}</span>
        {step.label}<span class="visually-hidden">{done ? ' (done)' : current ? (progress.phase === 'failed' ? ' (failed)' : ' (in progress)') : ''}</span>
      </li>
    {/each}
  </ol>
  {#if progress.phase === 'busy'}
    <p class="note">{progress.slow === 'long' ? LONG_START_TEXT : progress.slow === 'still' ? STILL_STARTING_TEXT : startStepStatus(progress.moduleId, progress.step)}</p>
    {#if progress.slow === 'long'}<button class="lb-btn lb-btn-sm" type="button" onclick={oncancel}>Stop waiting</button>{/if}
  {:else}
    <p class="error" role="alert">{progress.text}</p>
    <div class="actions">
      {#if progress.action === 'try-again' || progress.action === 'wait'}
        <button bind:this={action} class="lb-btn lb-btn-sm" type="button" onclick={onretry}>Try again</button>
      {:else if progress.action === 'check'}
        <button bind:this={action} class="lb-btn lb-btn-sm" type="button" onclick={onreload}>Check again</button>
      {:else}
        <button bind:this={action} class="lb-btn lb-btn-sm" type="button" onclick={() => location.reload()}>Reload</button>
      {/if}
      <button class="lb-btn lb-btn-sm lb-btn-quiet" type="button" onclick={ondismiss}>Close</button>
    </div>
  {/if}
</div>

<style>
  .start-progress { display: grid; gap: 8px; min-width: 0; }
  .heading { margin: 0; color: var(--lb-ink); font-size: .875rem; font-weight: 700; }
  .heading:focus { outline: none; }
  .heading:focus-visible { outline: 2px solid var(--lb-focus); outline-offset: 2px; border-radius: 4px; }
  ol { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
  li { display: flex; align-items: center; gap: 8px; color: var(--lb-ink-3); font-size: var(--lb-fs-small); }
  li.current, li.done { color: var(--lb-ink); }
  li.current { font-weight: 650; }
  .mark { display: inline-grid; place-items: center; flex: none; width: 18px; height: 18px; border: 2px solid var(--lb-line-strong); border-radius: 50%;
    color: #fff; font-size: 11px; font-weight: 800; line-height: 1; }
  li.done .mark { border-color: var(--lb-ok); background: var(--lb-ok); }
  li.current .mark { border-color: var(--lb-accent); border-right-color: transparent; animation: spin 800ms linear infinite; }
  .failed li.current .mark { border-color: var(--lb-danger); background: var(--lb-danger); animation: none; }
  .note { margin: 0; color: var(--lb-ink-2); font-size: var(--lb-fs-small); }
  .error { margin: 0; color: var(--lb-danger); font-size: var(--lb-fs-small); font-weight: 600; line-height: 1.45; }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { li.current .mark { animation: none; border-right-color: var(--lb-accent); } }
  @media (forced-colors: active) { li.done .mark, li.current .mark { border-color: CanvasText; } li.done .mark { background: CanvasText; } }
</style>
