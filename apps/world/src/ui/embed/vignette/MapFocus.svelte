<script lang="ts">
  import { runOnMount } from '../../svelte-lifecycle.svelte.ts'
  import { embeddedDisplayFrame, type DisplayOpening } from '../view-host.ts'
  import { mapCaption } from './collection.ts'
  import type { VignetteSample } from './model.ts'

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
  <button type="button" disabled={!usable} title={opening === 'window' ? (frame?.bounds == null ? 'Nothing here has a position' : 'Frame the live map on these') : 'Open this display in the display window to frame the map'}
    onclick={() => { if (frame?.bounds != null) embeddedDisplayFrame().showOnMap(frame.bounds) }}>Show on map</button>
</div>

<style>
  .map-focus p { margin: 0; height: var(--row); line-height: var(--row); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  button { height: 20px; margin-top: 2px; padding: 0 10px; font: inherit; font-size: 12px; border: 1px solid var(--border-outline-color); border-radius: 4px; background: var(--container-section-color); color: var(--element-active-color); cursor: pointer; }
  button:disabled { cursor: default; color: var(--element-neutral-color); }
  button:focus-visible { outline: 2px solid var(--border-focus-color); outline-offset: 1px; }
</style>
