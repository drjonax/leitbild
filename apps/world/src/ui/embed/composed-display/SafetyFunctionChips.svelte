<script lang="ts">
  import { safetyFunctionStatusWords } from '../../../packs/process-plant/displays/safety-function-content.ts'
  import type { ComposedDisplaySample } from './composed-display-client.ts'

  /** The critical safety functions the Plant declares, as the latest sample judged them. */
  let { functions }: { functions: NonNullable<ComposedDisplaySample['safetyFunctions']> } = $props()
</script>

<!-- One chip per declared function, in declaration order. Colour and text both carry the status: a challenged function names the procedure its colour sends operators to ("HEAT SINK · FR-H.5"); one that cannot be judged reads "?", one not judged in this state "—". Its status tree's path is its tooltip. A chip is never cut: what shares its line gives way first, and where the chips alone are wider than the line they wrap onto another (HMI review of run 25: "INVENTO"). -->
<span class="row" role="list" aria-label="Critical safety functions, reference-model status trees">
  {#each functions as safetyFunction (safetyFunction.id)}
    <span role="listitem" class={`csf ${safetyFunction.status}`} title={safetyFunction.text} aria-label={`${safetyFunction.label}: ${safetyFunctionStatusWords(safetyFunction.status)}`}>
      {safetyFunction.shortLabel}{#if safetyFunction.procedure !== undefined}{' · '}{safetyFunction.procedure}{:else if safetyFunction.status === 'unknown'}{' ?'}{:else if safetyFunction.status === 'not-monitored'}{' —'}{/if}
    </span>
  {/each}
</span>

<style>
  .row { display: inline-flex; flex: none; flex-wrap: wrap; justify-content: flex-end; gap: 3px; max-width: 100%; }
  .csf { flex: none; font-size: 10.5px; font-weight: 700; letter-spacing: 0.03em; line-height: 15px; padding: 0 5px; border-radius: 3px; white-space: nowrap; border: 1px solid transparent; cursor: help; }
  .csf.green { color: var(--alert-running-color); border-color: var(--alert-running-color); }
  .csf.yellow { background: var(--alert-caution-color); color: var(--container-background-color); }
  .csf.orange { background: var(--alert-warning-color); color: var(--container-background-color); }
  .csf.red { background: var(--alert-alarm-color); color: #fff; }
  .csf.unknown, .csf.not-monitored { color: var(--element-neutral-color); border-color: var(--border-outline-color); border-style: dashed; }
</style>
