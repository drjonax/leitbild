<script lang="ts">
  import type { z } from 'zod'
  import { sourceAdapters, roadDatasets } from '../adapters/catalog.ts'
  import { invokeWorld } from '../../../ui/workspace-capability-client.ts'
  import { situationConfigSchema, situationSourceSchema, type SituationConfig, type SituationSource } from '../model.ts'
  import { invokeSituation } from './client.ts'
  import type { MapView } from '../../../ui/map-view.ts'
  const { config, workspaceId, center = [0, 0], mapView = null, onchange }: { config: unknown; workspaceId: string; center?: readonly [number, number]; mapView?: MapView | null; onchange: (value: Record<string, unknown>) => void } = $props()
  const settings = $derived(situationConfigSchema.parse(config))
  let selected = $state<SituationSource['adapter']>('rss')
  type SourceDraft = z.input<typeof situationSourceSchema> & { map: SituationSource['map'] }
  let draft = $state<SourceDraft | null>(null)
  let iconSearch = $state(''), icons = $state<{ id: string; tags: string[]; svg: string }[]>([])
  let discovered = $state<{ id: string; title: string }[] | null>(null)
  let error = $state('')
  let testing = $state(false)
  let preview = $state<{ count: number; records: { title: string }[] } | null>(null)
  const mappingFields = ['id', 'title', 'time', 'url'] as const
  let areaName = $state('')
  let areaBounds = $state('-180, -85, 180, 85')
  function edit(source?: SituationSource) {
    const adapter = sourceAdapters.find(item => item.id === selected)!
    draft = source ? structuredClone(source) : { id: crypto.randomUUID(), name: adapter.title, adapter: selected, enabled: true, intervalSeconds: Math.max(300, adapter.minimumIntervalSeconds), retentionHours: 24, attribution: '', map: { visible: true, opacity: .18, lineWidth: 2 }, ...structuredClone(adapter.defaultParameters), ...(selected === 'met-forecast' ? { point: [...(mapView?.center ?? center)] } : {}) } as SourceDraft
    error = ''; preview = null; icons = []; discovered = null
  }
  async function findIcons() {
    try { icons = (await invokeWorld<{ icons: typeof icons }>('world.map.symbols', { text: iconSearch, limit: 24, artwork: true }, { workspaceId })).icons }
    catch (cause) { error = String(cause) }
  }
  async function discover() {
    if (draft?.adapter !== 'vegvesen') return
    testing = true; error = ''
    try { discovered = (await invokeSituation<{ datasets: { id: string; title: string }[] }>('catalogue.discover', { url: draft.url }, { workspaceId })).datasets }
    catch (cause) { error = String(cause) }
    finally { testing = false }
  }
  function publish(value: SituationConfig) { onchange(situationConfigSchema.parse(value)) }
  function save() {
    try {
      const source = situationSourceSchema.parse(draft)
      const exists = settings.sources.some(item => item.id === source.id)
      publish({ ...settings, sources: exists ? settings.sources.map(item => item.id === source.id ? source : item) : [...settings.sources, source] })
      draft = null; error = ''
    }
    catch (cause) { error = cause instanceof Error ? cause.message : String(cause) }
  }
  async function probe() {
    testing = true; error = ''; preview = null
    try { preview = await invokeSituation('source.probe', { source: situationSourceSchema.parse(draft) }, { workspaceId }) }
    catch (cause) { error = String(cause) }
    finally { testing = false }
  }
  function addArea() {
    try { publish({ ...settings, areas: [...settings.areas, { id: crypto.randomUUID(), name: areaName.trim() || 'Watched area', bounds: areaBounds.split(',').map(Number) as [number, number, number, number] }] }); areaName = ''; error = '' }
    catch (cause) { error = String(cause) }
  }
</script>
<div class="source-editor">
  <h3>External sources</h3>
  <p>Collection uses real time, independently of simulation pause or speed. Sources never change physical assets.</p>
  {#each settings.sources as source (source.id)}
    <div class="source-row"><button class="name" onclick={() => edit(source)}>{source.name}<small>{source.adapter} · {source.enabled ? 'Enabled' : 'Paused'}</small></button><button aria-label={'Remove ' + source.name} onclick={() => publish({ ...settings, sources: settings.sources.filter(item => item.id !== source.id) })}>×</button></div>
  {/each}
  <div class="row"><select aria-label="Source format" bind:value={selected}>{#each sourceAdapters as adapter}<option value={adapter.id}>{adapter.title}</option>{/each}</select><button onclick={() => edit()} disabled={settings.sources.length >= 40}>Add source</button></div>
  {#if draft}
    <fieldset><legend>{draft.adapter} source</legend>
      <p>{sourceAdapters.find(adapter => adapter.id === draft!.adapter)?.description}</p>
      <label>Name<input bind:value={draft.name} /></label>
      {#if draft.adapter !== 'met-forecast'}<label>Public HTTPS URL<input type="url" bind:value={draft.url} /></label>{/if}
      {#if draft.adapter === 'met-forecast'}
        <div class="row"><label>Longitude<input type="number" min="-180" max="180" step="any" bind:value={draft.point[0]} /></label><label>Latitude<input type="number" min="-90" max="90" step="any" bind:value={draft.point[1]} /></label></div>
        <button onclick={() => { if (draft?.adapter === 'met-forecast') draft.point = [...(mapView?.center ?? center)] }}>Use map centre</button>
      {/if}
      {#if draft.adapter === 'geojson' && draft.mapping}<details><summary>Property pointers</summary>{#each mappingFields as field}<label>{field}<input bind:value={draft.mapping[field]} /></label>{/each}<small>JSON Pointers, e.g. /properties/title or /properties/links/0/url. Literal dots work; escape / as ~1 and ~ as ~0. Every feature needs a stable ID.</small></details>{/if}
      {#if draft.adapter === 'vegvesen'}
        <label>Dataset<select bind:value={draft.dataset}>{#each roadDatasets as dataset}<option value={dataset.id}>{dataset.title}</option>{/each}</select></label>
        <button disabled={testing} onclick={discover}>Discover provider datasets</button>
        {#if discovered}<p>{discovered.length ? 'Provider advertises: ' + discovered.map(dataset => dataset.title).join(', ') : 'No compatible datasets advertised.'}</p>{/if}
        <p>{draft.bounds ? 'Collection extent: ' + draft.bounds.join(', ') : 'Collect full provider coverage'}</p>
        {#if mapView}<button onclick={() => { if (draft?.adapter === 'vegvesen') draft.bounds = [...mapView!.bounds] }}>Restrict collection to visible map</button>{/if}
        {#if draft.bounds}<button onclick={() => { if (draft?.adapter === 'vegvesen') delete draft.bounds }}>Use full coverage</button>{/if}
      {/if}
      {#if draft.adapter === 'media'}<label>Playback format<select bind:value={draft.format}><option value="image">Image</option><option value="youtube">YouTube</option><option value="video">Video file</option><option value="audio">Audio file</option><option value="hls">HLS stream</option></select></label>
        {#if draft.point}<div class="row"><label>Longitude<input type="number" step="any" bind:value={draft.point[0]} /></label><label>Latitude<input type="number" step="any" bind:value={draft.point[1]} /></label></div><button onclick={() => { if (draft?.adapter === 'media') delete draft.point }}>Remove location</button>{/if}
        <button onclick={() => { if (draft?.adapter === 'media') draft.point = [...(mapView?.center ?? center)] }}>Place at map centre</button>
      {/if}
      <div class="row"><label>Refresh (seconds)<input type="number" min="60" max="86400" bind:value={draft.intervalSeconds} /></label><label>Cache lifetime (hours)<input type="number" min="1" max="168" bind:value={draft.retentionHours} /></label></div>
      <small>Latest complete snapshot, not a history of all observations. Failed requests never extend its cache lifetime.</small>
      <details><summary>Map appearance</summary>
        <label class="row"><input type="checkbox" bind:checked={draft.map.visible} />Show on map</label>
        <label>Fill opacity<input type="range" min="0" max="1" step=".05" bind:value={draft.map.opacity} /></label>
        <label>Line width<input type="number" min="0" max="12" bind:value={draft.map.lineWidth} /></label>
        <label>Colour override<input type="color" value={draft.map.color ?? '#38bdf8'} oninput={event => { draft!.map.color = event.currentTarget.value }} /></label>
        <button onclick={() => { delete draft!.map.color }}>Use provider severity / record kind</button>
        <label>Icon name<input placeholder="Automatic by record kind" value={draft.map.icon ?? ''} oninput={event => { if (event.currentTarget.value) draft!.map.icon = event.currentTarget.value; else delete draft!.map.icon }} /></label>
        <div class="row"><input aria-label="Search icon names and tags" placeholder="camera, rain, emergency…" bind:value={iconSearch} /><button onclick={findIcons}>Find icons</button></div>
        <div class="icons">{#each icons as icon}<button title={icon.tags.join(', ')} onclick={() => { draft!.map.icon = icon.id }}><img alt="" src={'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(icon.svg)} />{icon.id}</button>{/each}</div>
      </details>
      <label>Attribution<input bind:value={draft.attribution} /></label>
      <label class="row"><input type="checkbox" bind:checked={draft.enabled} />Enabled</label>
      <details><summary>Server credential reference</summary><p>Optional server-configured bearer credential name, never the secret. Preview cannot use it.</p><input aria-label="Credential reference" value={draft.credentialRef ?? ''} oninput={event => { if (event.currentTarget.value) draft!.credentialRef = event.currentTarget.value; else delete draft!.credentialRef }} /></details>
      <div class="row"><button onclick={save}>Apply source</button><button onclick={probe} disabled={testing}>{testing ? 'Testing…' : draft.adapter === 'media' ? 'Preview metadata' : 'Test source'}</button><button onclick={() => draft = null}>Cancel</button></div>
      {#if preview}<p>{preview.count} records returned{draft.adapter === 'media' ? ' (playback not tested)' : ''}.</p>{#each preview.records as record}<small class="preview">{record.title}</small>{/each}{/if}
    </fieldset>
  {/if}
  <h3>Watched areas</h3><p>No areas means global coverage. Areas filter located records, not headlines without locations; they do not move or restrict the map.</p>
  {#each settings.areas as area}<div class="source-row"><span>{area.name}<small>{area.bounds.join(', ')}</small></span><button aria-label={'Remove ' + area.name} onclick={() => publish({ ...settings, areas: settings.areas.filter(item => item.id !== area.id) })}>×</button></div>{/each}
  <details><summary>Add rectangular area</summary><label>Name<input bind:value={areaName} /></label><label>West, south, east, north<input bind:value={areaBounds} /></label><small>West greater than east crosses the date line.</small>{#if mapView}<button onclick={() => areaBounds = mapView!.bounds.map(value => value.toFixed(4)).join(', ')}>Use visible map extent</button>{/if}<button onclick={addArea} disabled={settings.areas.length >= 20}>Add area</button></details>
  {#if error}<p role="alert">{error}</p>{/if}
</div>
<style>
  .icons{display:grid;grid-template-columns:repeat(3,1fr);gap:4px}.icons button{font-size:10px;overflow-wrap:anywhere}.icons img{display:block;width:24px;height:24px;margin:auto;background:#334155;border-radius:4px}
  .source-editor{font-size:13px}p,small{color:var(--muted,#94a3b8)}small{display:block}h3{margin:18px 0 8px}.row,.source-row{display:flex;gap:8px;align-items:center;margin:8px 0}.row>*{min-width:0;flex:1}.source-row{justify-content:space-between;border-bottom:1px solid #64748b44;padding:6px 0}.name{text-align:left;flex:1}label{display:block;margin:8px 0}input:not([type=checkbox]),select{box-sizing:border-box;width:100%;padding:7px;background:var(--panel,#182333);color:inherit;border:1px solid #64748b88;border-radius:5px}input[type=checkbox]{flex:0}button{cursor:pointer;padding:7px 9px;border-radius:5px;border:1px solid #64748b88;background:transparent;color:inherit}fieldset{border:1px solid #64748b66;margin:12px 0;padding:10px;min-width:0}details{margin:10px 0}summary{cursor:pointer}[role=alert]{color:#f87171;white-space:pre-wrap;overflow-wrap:anywhere}.preview{padding:3px 0}
</style>
