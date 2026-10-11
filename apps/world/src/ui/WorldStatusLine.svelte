<script lang="ts">
  import type { SimulationClockState } from '../core/model/index.ts'
  import type { RunExecutionState } from './types.ts'
  import { commandFeedbackStatus, type CommandFeedbackLine } from './command-feedback.ts'
  import { runOnMount } from './svelte-lifecycle.svelte.ts'
  import { worldClockView } from './world-clock.ts'

  interface Props {
    readonly clock: SimulationClockState | undefined
    readonly execution: RunExecutionState | null
    readonly feedback: CommandFeedbackLine | null
  }

  const { clock, execution, feedback }: Props = $props()

  let wallNow = $state(Date.now())
  const clockView = $derived(worldClockView({ clock, execution }, wallNow))
  const feedbackStatus = $derived(feedback === null ? null : commandFeedbackStatus(feedback.tone))

  runOnMount(() => {
    const ticker = window.setInterval(() => { wallNow = Date.now() }, 250)
    return () => { window.clearInterval(ticker) }
  })
</script>

<div class="world-status-line">
  {#if clockView}
    <span class="world-clock" title={`Simulated time · ${clockView.dateTime}${clockView.paused ? ' · paused' : ''}`}>
      <span class="world-clock-time">{clockView.time}</span>
      {#if clockView.paused}<span class="world-clock-paused">Paused</span>{/if}
    </span>
  {/if}
  <div class="command-feedback-region" role="status" aria-live="polite">
    {#if feedback}
      <p class="command-feedback" data-tone={feedback.tone}>
        <span class="command-feedback-subject">{feedback.subject}{#if feedback.tone === 'pending'}{feedbackStatus}{/if}</span>
        <!-- Reads as commandFeedbackText: "<subject> · refused: <reason>". -->
        {#if feedbackStatus && feedback.tone !== 'pending'}<span class="command-feedback-state">· {feedbackStatus}{#if feedback.detail !== undefined}:{/if}</span>{/if}
        {#if feedback.detail !== undefined}<span class="command-feedback-detail">{feedback.detail}</span>{/if}
      </p>
    {/if}
  </div>
</div>

<style>
  .world-status-line {
    position: fixed;
    z-index: 16;
    left: calc(var(--rail-width, 0px) + 12px);
    bottom: 12px;
    max-width: min(720px, calc(100vw - var(--rail-width, 0px) - 84px));
    display: flex;
    align-items: stretch;
    gap: 6px;
    font-size: 12px;
    line-height: 1.35;
    color: var(--text);
    pointer-events: none;
  }

  .world-clock,
  .command-feedback {
    border: 1px solid var(--border);
    border-radius: 6px;
    background: color-mix(in srgb, var(--panel) 94%, transparent);
    box-shadow: 0 4px 14px rgba(16, 24, 40, 0.16);
    pointer-events: auto;
  }

  .world-clock {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    font-weight: 650;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .world-clock-paused {
    color: var(--warning);
    font-size: 10px;
    font-weight: 750;
    letter-spacing: .06em;
    text-transform: uppercase;
  }

  .command-feedback-region {
    display: flex;
    min-width: 0;
  }

  .command-feedback {
    min-width: 0;
    margin: 0;
    padding: 4px 9px;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 2px 6px;
    overflow-wrap: anywhere;
  }

  .command-feedback-subject {
    font-weight: 600;
  }

  .command-feedback-state {
    font-weight: 700;
  }

  .command-feedback[data-tone='pending'] .command-feedback-subject {
    color: var(--muted);
  }

  .command-feedback[data-tone='accepted'] .command-feedback-state {
    color: var(--success);
  }

  .command-feedback[data-tone='refused'],
  .command-feedback[data-tone='failed'] {
    border-color: color-mix(in srgb, var(--critical) 45%, var(--border));
  }

  .command-feedback[data-tone='refused'] .command-feedback-state,
  .command-feedback[data-tone='failed'] .command-feedback-state {
    color: var(--critical);
  }
</style>
