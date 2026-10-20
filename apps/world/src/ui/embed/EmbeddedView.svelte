<script lang="ts">
  import type { EmbeddedViewEnvelope } from '@leitbild/contracts'
  import { readProcessDisplayState, UNSUPPORTED_DISPLAY_FORMAT } from '../../packs/process-plant/displays/composition.ts'
  import ComposedDisplayView from './composed-display/ComposedDisplayView.svelte'

  let { envelope }: { envelope: EmbeddedViewEnvelope } = $props()

  const plantDisplay = $derived(envelope.viewType === 'process-plant.display' && envelope.subject.type === 'world.simulation-run')
  // A saved display World no longer reads (advice composed before subjects were required) is refused in its frame, as World's view refuses it.
  const readable = $derived(plantDisplay && readProcessDisplayState(envelope.state) !== null)
</script>

{#if readable}
  <ComposedDisplayView {envelope} />
{:else if plantDisplay}
  <p class="embed-failure">{UNSUPPORTED_DISPLAY_FORMAT}</p>
{:else}
  <p class="embed-failure">Unsupported view: {envelope.viewType} on {envelope.subject.type}.</p>
{/if}
