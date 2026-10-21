<script lang="ts">
  import type { AlertTone, ReadingLook } from './readout.ts'

  // A state on one row (architecture B; visual grammar channel D), in
  // OpenBridge's status indicator: active where it reads "on", inactive
  // otherwise, at its observation's priority where that is caution or worse.
  // An unknown state is a dashed "?" box, the one thing the indicator cannot
  // say (it has no unknown status; register entry in the lane notes). As a
  // header chip it is as narrow as its name and word.
  let { look, label, chip = false }: { look: ReadingLook; label?: string; chip?: boolean } = $props()

  /** The indicator has no emergency status: alarm is its worst (measured gap, lane notes). */
  const STATUS: Readonly<Record<AlertTone, string>> = { caution: 'caution', warning: 'warning', alarm: 'alarm', critical: 'alarm' }
</script>

<span class="state" class:cell={label === undefined} class:chip title={look.title}>
  {#if label !== undefined}<span class="label">{label}</span>{/if}
  {#if look.fill === 'unknown'}
    <span class="unknown">{look.text}</span>
  {:else}
    <obc-status-indicator class="indicator" status={look.tone !== null ? STATUS[look.tone] : look.fill === 'filled' ? 'active' : 'inactive'}><span>{look.text}</span></obc-status-indicator>
  {/if}
  {#if look.note !== null && label !== undefined}<span class="note">{look.note}</span>{/if}
</span>

<style>
  .state { display: flex; align-items: center; gap: 6px; min-width: 0; height: var(--row); white-space: nowrap; }
  .label { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--element-neutral-color); }
  /* OpenBridge's indicator at a row's height, its label set as the row's text (as the faceplate sets it). */
  .indicator { flex: none; display: block; margin: -12px -8px; --global-typography-ui-button-font-size: 13px; --global-typography-ui-button-line-height: 16px; --global-typography-ui-body-font-size: 13px; --global-typography-ui-body-line-height: 16px; }
  .unknown { flex: none; padding: 0 6px; line-height: 18px; border: 1px dashed var(--border-outline-color); border-radius: 3px; color: var(--element-neutral-color); }
  .note { flex: none; color: var(--element-neutral-color); }
  .cell { justify-content: flex-end; }
  /* A header chip: its name and word side by side, as narrow as they are. */
  .chip { flex: 0 1 auto; }
  .chip .label { flex: 0 1 auto; }
</style>
