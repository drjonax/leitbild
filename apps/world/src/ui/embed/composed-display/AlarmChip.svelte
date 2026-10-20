<script lang="ts">
  import { chipName } from '../../../packs/process-plant/displays/display-text.ts'
  import type { ComposedDisplayThreshold } from '../../../packs/process-plant/ic/thresholds.ts'
  import { alertTypeOf } from './panel-presenters.ts'

  /**
   * `compact`: without its action, where its row's tag would otherwise be cut; the margin under it names the action.
   * `expected`: the first-out group every active alarm of its rule came in after (expectedOfRule): drawn faded.
   */
  let { threshold, compact = false, expected = null }: { threshold: ComposedDisplayThreshold; compact?: boolean; expected?: string | null } = $props()
</script>

<!-- Shown only while the threshold's I&C rule is active in a mode it acts in; colour and text both carry the state, in the words its alarm row uses ("LO-LO · RX TRIP", "L LO & F LO · ALM"); faded where it is expected after a first-out, as the drawing's frame and the list's row are. -->
<span class={`chip ${alertTypeOf(threshold.severity ?? 'warning')}`} class:expected={expected !== null} title={`${chipName(threshold)}: ${threshold.label}${expected === null ? '' : ` · expected after ${expected}`}`}>{chipName(threshold, compact)}</span>

<style>
  .chip { font-size: 10.5px; font-weight: 700; letter-spacing: 0.03em; padding: 0 5px; border-radius: 3px; white-space: nowrap; color: var(--container-background-color); }
  /* Severity reaches colour through one map (alertTypeOf) for chips, alarm rows, tiles and the drawing. */
  .chip.alarm { background: var(--alert-alarm-color); color: #fff; }
  .chip.warning { background: var(--alert-warning-color); }
  .chip.caution { background: var(--alert-caution-color); }
  .chip.expected { opacity: 0.45; }
</style>
