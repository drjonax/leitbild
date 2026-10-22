<script lang="ts">
  import type { Component } from 'svelte'
  import type { PackSettingsEditorProps } from '../core/packs/protocol.ts'
  import { loadUiPack } from './pack-loader.ts'
  const { packId, config, workspaceId, center, mapView, onchange }: PackSettingsEditorProps & { packId: string } = $props()
  let Editor = $state<Component<PackSettingsEditorProps> | null>(null)
  let error = $state('')
  $effect(() => {
    const id = packId
    let active = true
    Editor = null; error = ''
    void loadUiPack(id).then(async pack => {
      const module = await pack.ui?.settingsEditor?.()
      if (active) Editor = module?.default ?? null
    }).catch(cause => { if (active) error = String(cause) })
    return () => { active = false }
  })
</script>
{#if error}<p role="alert">{error}</p>{/if}
{#if Editor}<Editor {config} {workspaceId} {center} {mapView} {onchange} />{/if}
