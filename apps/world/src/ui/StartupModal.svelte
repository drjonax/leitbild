<script lang="ts">
  import ModalShell from './components/ModalShell.svelte'
  import type { StatusTone } from './components/StatusDot.svelte'
  import { runOnMount } from './svelte-lifecycle.svelte.ts'
  import { startupHasFailed, startupIsReady, type StartupStep } from './startup.ts'

  interface Props {
    readonly steps: ReadonlyArray<StartupStep>
    readonly tone: StatusTone
    readonly retry: () => Promise<void>
    readonly close: () => void
    readonly autoCloseWhenReady?: boolean
    readonly closeWhenReadyOnly?: boolean
  }

  const {
    steps,
    tone,
    retry,
    close,
    autoCloseWhenReady = true,
    closeWhenReadyOnly = true,
  }: Props = $props()

  let nowMs = $state(performance.now())
  let retrying = $state(false)
  let closeDelayTimer = $state<number | null>(null)
  let fadeTimer = $state<number | null>(null)
  let fading = $state(false)
  const ready = $derived(startupIsReady(steps))
  const failed = $derived(startupHasFailed(steps))
  const failedStep = $derived(steps.find(step => step.status === 'failed') ?? null)
  const canClose = $derived(!closeWhenReadyOnly || ready || failed)

  const clearCloseTimers = (): void => {
    if (closeDelayTimer !== null) window.clearTimeout(closeDelayTimer)
    if (fadeTimer !== null) window.clearTimeout(fadeTimer)
    closeDelayTimer = null
    fadeTimer = null
  }

  const elapsedSeconds = (step: StartupStep): string => {
    if (!step.startedAtMs) return ''
    const endMs = step.completedAtMs ?? nowMs
    const seconds = Math.max(0, (endMs - step.startedAtMs) / 1000)
    if (seconds < 1) return ''
    return `${seconds.toFixed(1)}s`
  }

  const statusLabel = (step: StartupStep): string => {
    if (step.status === 'done') return 'Done'
    if (step.status === 'running') return 'Running'
    if (step.status === 'failed') return 'Failed'
    return 'Pending'
  }

  const retryStartup = async (): Promise<void> => {
    if (retrying) return
    retrying = true
    try {
      await retry()
    } finally {
      retrying = false
    }
  }

  runOnMount(() => {
    const interval = window.setInterval(() => {
      nowMs = performance.now()
    }, 250)
    return () => {
      window.clearInterval(interval)
      clearCloseTimers()
    }
  })

  $effect(() => {
    if (failed) {
      clearCloseTimers()
      fading = false
    } else if (autoCloseWhenReady && ready && closeDelayTimer === null && fadeTimer === null && !fading) {
      closeDelayTimer = window.setTimeout(() => {
        closeDelayTimer = null
        fading = true
        fadeTimer = window.setTimeout(() => {
          fadeTimer = null
          close()
        }, 250)
      }, 750)
    } else if (!ready) {
      clearCloseTimers()
      fading = false
    }
  })
</script>

<div class:fading class="startup-modal-frame">
  <ModalShell
    title="Starting Leitbild"
    description="Opening the control surface and checking each startup step."
    close={close}
    closeOnBackdrop={canClose}
    closeOnEscape={canClose}
    showClose={canClose}
    titleTone={tone}
    size="medium"
  >
  <ol class="startup-steps" role="status" aria-live="polite">
    {#each steps as step (step.id)}
      <li class:done={step.status === 'done'} class:running={step.status === 'running'} class:failed={step.status === 'failed'}>
        <span class="startup-indicator"></span>
        <span class="startup-step-main">
          <span class="startup-step-label">{step.label}</span>
          {#if step.error}
            <span class="startup-step-error">{step.error}</span>
          {/if}
          {#if step.details?.length}
            <!-- Measurements are for diagnosis, not for the player: folded away unless the step failed. -->
            <details class="startup-step-diagnostics" open={step.status === 'failed'}>
              <summary>Diagnostics</summary>
              <span class="startup-step-details">
                {#each step.details as detail}
                  <span><strong>{detail.label}</strong> {detail.value}</span>
                {/each}
              </span>
            </details>
          {/if}
        </span>
        <span class="startup-step-status">
          {statusLabel(step)}
          {#if elapsedSeconds(step)}
            · {elapsedSeconds(step)}
          {/if}
        </span>
      </li>
    {/each}
  </ol>
  {#snippet footer()}
    {#if failedStep}
      <div class="startup-actions">
        <button class="command-button" disabled={retrying} onclick={retryStartup}>
          {retrying ? 'Retrying' : 'Retry'}
        </button>
      </div>
    {/if}
  {/snippet}
  </ModalShell>
</div>
