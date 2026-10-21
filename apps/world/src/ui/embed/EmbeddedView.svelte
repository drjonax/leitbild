<script lang="ts">
  import type { EmbeddedViewEnvelope } from '@leitbild/contracts'
  import { readProcessDisplayState, UNSUPPORTED_DISPLAY_FORMAT } from '../../packs/process-plant/displays/composition.ts'
  import ComposedDisplayView from './composed-display/ComposedDisplayView.svelte'
  import { VIGNETTE_VIEW_TYPE } from './vignette/vignette-client.ts'
  import Vignette from './vignette/Vignette.svelte'

  let { envelope }: { envelope: EmbeddedViewEnvelope } = $props()

  const ofRun = $derived(envelope.subject.type === 'world.simulation-run')
  const vignette = $derived(envelope.viewType === VIGNETTE_VIEW_TYPE && ofRun)
  const plantDisplay = $derived(envelope.viewType === 'process-plant.display' && ofRun)
  // A saved display World no longer reads (advice composed before subjects were required) is refused in its frame, as World's view refuses it.
  const readable = $derived(plantDisplay && readProcessDisplayState(envelope.state) !== null)
</script>

{#if vignette}
  <Vignette {envelope} />
{:else if readable}
  <ComposedDisplayView {envelope} />
{:else if plantDisplay}
  <p class="embed-failure">{UNSUPPORTED_DISPLAY_FORMAT}</p>
{:else}
  <p class="embed-failure">Unsupported view: {envelope.viewType} on {envelope.subject.type}.</p>
{/if}
