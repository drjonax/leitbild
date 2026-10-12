<script lang="ts">
  import type { MimicDrawnItem } from '../../../../packs/process-plant/displays/mimic/mimic-model.ts'
  import ReadoutsPanel from '../ReadoutsPanel.svelte'
  import type { MimicQuickLookSource, QuickLookState } from './quick-look-source.ts'

  // An item's quick look: the lead values of its detail, each recorded one
  // with its sparkline, as the detail's column shows them; read while the
  // popover is open (quick-look-source.ts).
  let { source, item, activeRuleIds }: {
    source: MimicQuickLookSource
    item: MimicDrawnItem
    activeRuleIds: ReadonlySet<string>
  } = $props()

  let shown = $state.raw<QuickLookState>({ kind: 'loading' })

  // Reading the item's values is a subscription to the Run, held while the section is drawn.
  $effect(() => source.open(item, next => { shown = next }))
</script>

{#if shown.kind === 'loading'}
  <p class="note">Reading the values of {item.binding.label}…</p>
{:else if shown.kind === 'failed'}
  <p class="note">The quick look cannot be shown: {shown.message}</p>
{:else if shown.panel === null}
  <p class="note">{item.binding.label} has no lead values; its detail shows what is drawn around it.</p>
{:else}
  <ReadoutsPanel panel={shown.panel} latest={shown.latest} {activeRuleIds} column history={shown.history} />
  {#if shown.sampleError !== null}<p class="note">Showing the last received values. {shown.sampleError}</p>{/if}
{/if}

<style>
  .note { margin: 4px 0; font-size: 11.5px; color: var(--element-neutral-color); }
</style>
