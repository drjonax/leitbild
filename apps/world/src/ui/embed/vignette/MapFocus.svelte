<script lang="ts">
  import { runOnMount } from '../../svelte-lifecycle.svelte.ts'
  import { embeddedDisplayFrame, type DisplayOpening } from '../view-host.ts'
  import { mapCaption } from './collection.ts'
  import type { VignetteSample } from '../../../features/displays/compose/model.ts'

  // Where the vignette's objects are (architecture B2): what the frame holds
  // and how many have no position, and "Show on map", which asks the display
  // window to frame the live map on the bounds World computed. It draws no
  // map of its own; in a chat answer the button says where it works.
  let { frame }: { frame: NonNullable<VignetteSample['maps']>[number] | undefined } = $props()

  let opening = $state<DisplayOpening | null>(null)
  runOnMount(() => embeddedDisplayFrame().subscribeOpening(where => { opening = where }))
  const usable = $derived(opening === 'window' && frame?.bounds != null)
</script>

<div class="map-focus">
  <p>{mapCaption(frame)}</p>
  <!-- An obc-button is a button: the native button inside it takes Enter and Space. -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <obc-button variant="normal" disabled={!usable} title={opening === 'window' ? (frame?.bounds == null ? 'Nothing here has a position' : 'Frame the live map on these') : 'Open this display in the display window to frame the map'}
    onclick={() => { if (frame?.bounds != null) embeddedDisplayFrame().showOnMap(frame.bounds) }}>Show on map</obc-button>
</div>

<style>
  /* OpenBridge's button is 48 px tall at its smallest size (measured): it takes both rows, the words beside it. */
  .map-focus { display: flex; align-items: center; gap: 8px; height: calc(2 * var(--row)); }
  .map-focus p { flex: 1 1 0; min-width: 0; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  obc-button { flex: none; }
</style>
