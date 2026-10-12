<script lang="ts">
  import { runOnMount } from '../svelte-lifecycle.svelte.ts'
  import type { PanelKey } from './panel-key.ts'
  import { installPanelKeyRouter } from './panel-key-router.ts'

  /**
   * Mounted only while an open surface panel declares a keymap: one window
   * key listener for the World frame, removed with the panel.
   */
  interface Props {
    readonly placementActive: () => boolean
    readonly deliver: (key: PanelKey) => boolean
    readonly onActiveChange: (active: boolean) => void
  }

  const { placementActive, deliver, onActiveChange }: Props = $props()

  runOnMount(() => installPanelKeyRouter({
    placementActive: () => placementActive(),
    deliver: key => deliver(key),
    onActiveChange: active => onActiveChange(active),
  }))
</script>
