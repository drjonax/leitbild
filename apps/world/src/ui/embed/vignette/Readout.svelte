<script lang="ts">
  import type { AlertTone, ReadingLook } from './readout.ts'

  // A number on one row (architecture B): its label, the chip of the limit it
  // is past, the value in OpenBridge's readout block with its unit, what it is
  // heading for, and OpenBridge's bar with each limit as an advice zone. Past
  // a limit the block takes OpenBridge's alert frame at the observation's
  // priority; a doubtful value reads in its low-integrity style. Without a
  // label it is a cell of a grouped table, without its bar.
  let { look, label }: { look: ReadingLook; label?: string } = $props()

  /** OpenBridge's alert type for each priority drawn in colour; emergency is its critical level. */
  const ALERT_TYPE: Readonly<Record<AlertTone, string>> = { caution: 'caution', warning: 'warning', alarm: 'alarm', critical: 'level-critical' }
  const BAR = { width: 64, thickness: 8 }
</script>

<span class="readout" class:cell={label === undefined} title={look.title}>
  {#if label !== undefined}<span class="label">{label}</span>{/if}
  {#if look.chip !== null}<span class={`chip ${look.chip.tone ?? 'neutral'}`}>{label === undefined ? look.chip.word : look.chip.text}</span>{/if}
  <span class="reading">
    <obc-readout-block
      variant="value"
      size="small"
      alignment="right"
      hintedZeros={false}
      value={look.value}
      valueType={typeof look.value === 'string' ? 'text' : 'number'}
      fractionDigits={look.decimals}
      off={look.value === null}
      offText={look.text}
      weight={look.emphasis || look.tone !== null ? 'semibold' : 'regular'}
      dataQuality={look.doubtful ? 'low-integrity' : undefined}
      alert={look.tone === null ? false : { status: ALERT_TYPE[look.tone], type: 'regular', thickness: 'small', mode: 'acked-active', showIcon: false, showAlertCategoryIcon: false }}
    ></obc-readout-block>
    {#if look.unit !== ''}<span class="unit">{look.unit}</span>{/if}
  </span>
  {#if look.note !== null && label !== undefined}<span class="note">{look.note}</span>{/if}
  {#if look.bar !== null && label !== undefined}
    <obc-bar-horizontal
      class="bar"
      width={BAR.width}
      minValue={look.bar.min}
      maxValue={look.bar.max}
      value={look.bar.value}
      hasBar={true}
      hasScale={false}
      showLabels={false}
      barThickness={BAR.thickness}
      paddingLeft={0}
      paddingRight={0}
      advices={look.bar.advices}
      advicePosition="center"
    ></obc-bar-horizontal>
  {/if}
</span>

<style>
  .readout { display: flex; align-items: center; gap: 6px; min-width: 0; height: var(--row); white-space: nowrap; }
  .label { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--element-neutral-color); }
  .reading { flex: none; display: inline-flex; align-items: baseline; gap: 3px; }
  .unit { color: var(--element-neutral-color); }
  .note { flex: none; color: var(--element-neutral-color); }
  .chip { flex: none; padding: 0 4px; border: 1px solid; border-radius: 3px; font-weight: 700; letter-spacing: 0.03em; }
  .chip.neutral { color: var(--element-active-color); border-color: var(--border-outline-color); }
  .chip.caution { background: var(--display-caution-fill); color: var(--display-on-caution); border-color: var(--alert-caution-color); }
  .chip.warning { background: var(--display-warning-fill); color: var(--display-on-warning); border-color: var(--alert-warning-color); }
  .chip.alarm { background: var(--display-alarm-fill); color: var(--display-on-alarm); border-color: var(--alert-alarm-color); }
  .chip.critical { background: var(--display-critical-fill); color: var(--display-on-critical); border-color: var(--alert-critical-color); }
  .bar { flex: none; display: block; }
  .cell { justify-content: flex-end; }
  /* A phone keeps the label, the chip and the value; the countdown and the bar give way. */
  @media (max-width: 479px) { .note, .bar { display: none; } }
</style>
