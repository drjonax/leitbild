<script lang="ts">
  import { safetyFunctionStatusWords, type SafetyFunctionChip } from '../../../packs/process-plant/displays/safety-function-content.ts'
  import type { ComposedDisplaySample } from './composed-display-client.ts'

  /**
   * The critical safety functions the Plant declares, as the latest sample judged them. `open`: where the view can
   * open a display, a chip whose tree names its deciding equipment opens it.
   */
  let { functions, open }: {
    functions: NonNullable<ComposedDisplaySample['safetyFunctions']>
    open?: (chip: SafetyFunctionChip) => void
  } = $props()
</script>

{#snippet words(safetyFunction: SafetyFunctionChip)}{safetyFunction.shortLabel}{#if safetyFunction.procedure !== undefined}{' · '}{safetyFunction.procedure}{:else if safetyFunction.status === 'unknown'}{' ?'}{:else if safetyFunction.status === 'not-monitored'}{' —'}{/if}{/snippet}

<!-- One chip per declared function, in declaration order. Colour and text both carry the status: a challenged function names the procedure its colour sends operators to ("HEAT SINK · FR-H.5"); one that cannot be judged reads "?", one not judged in this state "—". Its status tree's path is its tooltip. A chip is never cut: what shares its line gives way first, and where the chips alone are wider than the line they wrap onto another (HMI review of run 25: "INVENTO"). A chip that opens the equipment on its tree's deciding branch says so by pointer and focus ring only, never by a button's look that would compete with its status colour (HF-21). -->
<span class="row" role="list" aria-label="Critical safety functions, reference-model status trees">
  {#each functions as safetyFunction (safetyFunction.id)}
    {#if open !== undefined && safetyFunction.opens !== undefined}
      <span role="listitem" class="item">
        <button type="button" class={`csf ${safetyFunction.status}`} title={`${safetyFunction.text}\nOpens the equipment that decides it.`} aria-label={`${safetyFunction.label}: ${safetyFunctionStatusWords(safetyFunction.status)}; open the equipment that decides it`} onclick={() => open(safetyFunction)}>{@render words(safetyFunction)}</button>
      </span>
    {:else}
      <span role="listitem" class={`csf ${safetyFunction.status}`} title={safetyFunction.text} aria-label={`${safetyFunction.label}: ${safetyFunctionStatusWords(safetyFunction.status)}`}>{@render words(safetyFunction)}</span>
    {/if}
  {/each}
</span>

<style>
  .row { display: inline-flex; flex: none; flex-wrap: wrap; justify-content: flex-end; gap: 3px; max-width: 100%; }
  .item { display: inline-flex; flex: none; }
  .csf { flex: none; font-family: inherit; font-size: 10.5px; font-weight: 700; letter-spacing: 0.03em; line-height: 15px; margin: 0; padding: 0 5px; border-radius: 3px; white-space: nowrap; border: 1px solid transparent; background: none; cursor: help; }
  button.csf { cursor: pointer; }
  button.csf:focus-visible { outline: 2px solid var(--border-focus-color); outline-offset: 1px; }
  /* Status colour as border or fill, text always readable (embed.css): green text read 3.3:1 in dusk. */
  .csf.green { color: var(--element-active-color); border-color: var(--alert-running-color); }
  .csf.yellow { background: var(--display-caution-fill); color: var(--display-on-caution); border-color: var(--alert-caution-color); }
  .csf.orange { background: var(--display-warning-fill); color: var(--display-on-warning); border-color: var(--alert-warning-color); }
  .csf.red { background: var(--display-alarm-fill); color: var(--display-on-alarm); border-color: var(--alert-alarm-color); }
  .csf.unknown, .csf.not-monitored { color: var(--element-neutral-color); border-color: var(--border-outline-color); border-style: dashed; }
</style>
