<script lang="ts">
  import type { ReadingLook } from './readout.ts'

  // A state on one row (architecture B; visual grammar channel D): its word in
  // a box, filled while true, hollow while false or for an enum's word, dashed
  // with "?" while unknown; in an alert's fill only at its observation's
  // priority. "since" says when it last changed.
  let { look, label }: { look: ReadingLook; label?: string } = $props()
</script>

<span class="state" class:cell={label === undefined} title={look.title}>
  {#if label !== undefined}<span class="label">{label}</span>{/if}
  <span class={`word ${look.fill} ${look.tone ?? ''}`} class:emphasis={look.emphasis}>{look.text}</span>
  {#if look.note !== null && label !== undefined}<span class="note">{look.note}</span>{/if}
</span>

<style>
  .state { display: flex; align-items: center; gap: 6px; min-width: 0; height: var(--row); white-space: nowrap; }
  .label { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--element-neutral-color); }
  .word { flex: none; padding: 0 6px; line-height: 18px; border: 1px solid var(--border-outline-color); border-radius: 3px; }
  .word.filled { background: var(--element-active-color); color: var(--container-background-color); border-color: var(--element-active-color); }
  .word.unknown { border-style: dashed; color: var(--element-neutral-color); }
  .emphasis { font-weight: 700; }
  .word.caution { background: var(--display-caution-fill); color: var(--display-on-caution); border-color: var(--alert-caution-color); font-weight: 700; }
  .word.warning { background: var(--display-warning-fill); color: var(--display-on-warning); border-color: var(--alert-warning-color); font-weight: 700; }
  .word.alarm { background: var(--display-alarm-fill); color: var(--display-on-alarm); border-color: var(--alert-alarm-color); font-weight: 700; }
  .word.critical { background: var(--display-critical-fill); color: var(--display-on-critical); border-color: var(--alert-critical-color); font-weight: 700; }
  .note { flex: none; color: var(--element-neutral-color); }
  .cell { justify-content: flex-end; }
</style>
