<script lang="ts">
  import { workspaceDefinitionRevisionReferenceSchema } from '@leitbild/contracts'
  import { untrack } from 'svelte'
  import type { ObjectId } from '../../core/model/index.ts'
  import { scenarioAuthoringCatalogSchema, type ScenarioAuthoringCatalog } from '../../core/scenarios/authoring.ts'
  import { scenarioDefinitionSchema } from '../../core/scenarios/definition.ts'
  import { scenarioPreviewSchema, scenarioWriteResultSchema, type ScenarioPreview } from '../../core/scenarios/authoring-preview.ts'
  import { createLatestPreview } from '../latest-preview.ts'
  import { runOnMount } from '../svelte-lifecycle.svelte.ts'
  import AuthoringFields from '../AuthoringFields.svelte'
  import AdvancedConfiguration from '../AdvancedConfiguration.svelte'
  import PackSettingsEditor from '../PackSettingsEditor.svelte'
  import TimelineEditor from '../TimelineEditor.svelte'
  import ScenarioBuilderMap from '../ScenarioBuilderMap.svelte'
  import type { MapView } from '../map-view.ts'
  import { parseControlSurfaceRoute } from '../simulation-run-route.ts'
  import {
    createEmptyScenarioDefinition,
    deepCopy,
    itemTypeFor,
    newCollectionRow,
    needsPlacement,
    selectionFor,
    setValueAtPath,
    valueAtPath,
    type AuthoringPack,
    type AuthoringField,
    type AuthoringItemType,
    type ScenarioDraft,
  } from '../scenario-builder-model.ts'

  interface InvocationResponse {
    readonly result: unknown
    readonly createdResources?: ReadonlyArray<{ readonly moduleId: string; readonly type: string; readonly id: string }>
  }

  type CreateResult = import('zod').z.infer<typeof scenarioWriteResultSchema>

  type Selection = { readonly kind: 'scenario' } | { readonly kind: 'pack'; readonly id: string } | { readonly kind: 'item'; readonly id: string }

  const route = parseControlSurfaceRoute(location.pathname)
  if (route.mode !== 'scenario-builder') throw new Error('Scenario Builder route expected')
  const workspaceId = route.workspaceId
  const query = new URLSearchParams(location.search)
  const embedded = query.get('embed') === '1'
  const definitionId = query.get('definition')
  const requestedRevisionId = query.get('revision')

  let catalog = $state<ScenarioAuthoringCatalog | null>(null)
  let draft = $state<ScenarioDraft>(createEmptyScenarioDefinition())
  let selection = $state<Selection>({ kind: 'scenario' })
  let placementItemId = $state<string | null>(null)
  let packToAdd = $state('')
  let loading = $state(true)
  let saving = $state(false)
  let error = $state<string | null>(null)
  let saved = $state<CreateResult | null>(null)
  let editing = $state<CreateResult['definition'] | null>(null)
  let preview = $state<ScenarioPreview | null>(null)
  let previewError = $state<string | null>(null)
  let systemEndpointKey = $state('')
  let networkEndpointKey = $state('')
  let savedDocument = $state('')
  let editorMapView = $state<MapView | null>(null)
  const dirty = $derived(!loading && savedDocument !== JSON.stringify(draft))

  const invoke = async <T,>(capabilityId: string, input: unknown, definition?: CreateResult['definition']): Promise<T> => {
    const response = await fetch(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/capabilities/${encodeURIComponent(capabilityId)}/invoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input, ...(definition ? { definition } : {}), actor: { kind: 'human' } }),
      },
    )
    const body = await response.json() as T & { error?: { message?: string } }
    if (!response.ok) throw new Error(body.error?.message ?? `Request failed: ${response.status}`)
    return body
  }

  const loadEditor = async (): Promise<void> => {
    try {
      const [catalogResponse, definitionResponse] = await Promise.all([
        invoke<InvocationResponse>('world.scenario-authoring.describe', { detail: 'editor' }),
        definitionId === null
          ? Promise.resolve(null)
          : fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/world/scenarios/${encodeURIComponent(definitionId)}`).then(async response => {
              const body = await response.json() as { source?: ScenarioDraft; revisionId?: string; error?: { message?: string } }
              if (!response.ok || !body.source || !body.revisionId) throw new Error(body.error?.message ?? `Request failed: ${response.status}`)
              return body as { source: ScenarioDraft; revisionId: string }
            }),
      ])
      const { detail: _detail, ...editorCatalog } = catalogResponse.result as Record<string, unknown>
      catalog = scenarioAuthoringCatalogSchema.parse(editorCatalog)
      if (definitionResponse) {
        if (requestedRevisionId !== null && requestedRevisionId !== definitionResponse.revisionId) {
          throw new Error('This Scenario has changed. Reopen the editor from the Workspace homepage.')
        }
        const parsed = scenarioDefinitionSchema.parse(definitionResponse.source)
        draft = deepCopy({ ...parsed, timeline: parsed.timeline ?? { cues: [] } }) as ScenarioDraft
        editing = workspaceDefinitionRevisionReferenceSchema.parse({
          workspaceId,
          moduleId: 'world',
          type: 'world.scenario',
          id: definitionResponse.source.id,
          revisionId: definitionResponse.revisionId,
        })
      }
      savedDocument = JSON.stringify(draft)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      loading = false
    }
  }

  const mapCenter = (): [number, number] => draft.view.map.center
  const mapZoom = (): number => draft.view.map.zoom
  const activePacks = (): ReadonlyArray<AuthoringPack> => catalog?.packs.filter(pack => selectionFor(draft, pack.id) !== undefined) ?? []
  const availablePacks = (): ReadonlyArray<AuthoringPack> => catalog?.packs.filter(pack => selectionFor(draft, pack.id) === undefined) ?? []
  const allItems = () => draft.packs.flatMap(pack => pack.items.map(item => ({ packId: pack.id, item })))
  const electricalEndpoints = () => preview?.assets.flatMap(asset => asset.electricalPorts.map(port => ({
    key: `${asset.id}\u0000${port.id}`,
    objectId: asset.id,
    objectLabel: asset.label,
    packId: asset.packId,
    ...port,
  }))) ?? []
  const systemElectricalEndpoints = () => electricalEndpoints().filter(endpoint => endpoint.role === 'system')
  const networkElectricalEndpoints = () => electricalEndpoints().filter(endpoint => endpoint.role === 'network')
  const selectedEntry = () => {
    const current = selection
    return current.kind === 'item' ? allItems().find(entry => entry.item.id === current.id) : undefined
  }
  const selectedPack = () => {
    const current = selection
    return current.kind === 'pack' ? catalog?.packs.find(pack => pack.id === current.id) : undefined
  }
  const selectedItem = () => selectedEntry()?.item
  const recordingSelectionFor = (packId: string) => selectionFor(draft, packId)?.recording
  const selectedType = (): AuthoringItemType | undefined => {
    const item = selectedItem()
    const entry = selectedEntry()
    return entry && catalog ? itemTypeFor(catalog, entry.packId, entry.item) : undefined
  }

  const placementFor = (itemId: string | null): AuthoringItemType['placement'] | undefined => {
    if (!itemId || !catalog) return undefined
    const entry = allItems().find(candidate => candidate.item.id === itemId)
    return entry ? itemTypeFor(catalog, entry.packId, entry.item)?.placement : undefined
  }

  const mapPoints = (): ReadonlyArray<{ id: string; label: string; coordinates: [number, number] }> => !catalog ? [] : allItems().flatMap(({ packId, item }) => {
    const type = itemTypeFor(catalog!, packId, item)
    if (!type?.placement) return []
    const value = valueAtPath(item, type.placement.path)
    return Array.isArray(value) && typeof value[0] === 'number' && typeof value[1] === 'number'
      ? [{ id: item.id, label: item.label, coordinates: [value[0], value[1]] as [number, number] }]
      : []
  })

  const beginPlacement = (itemId: string): void => {
    placementItemId = itemId
  }

  const cancelPlacement = (): void => {
    const entry = allItems().find(entry => entry.item.id === placementItemId)
    const placement = placementFor(placementItemId)
    if (entry && needsPlacement(entry.item, placement)) {
      const pack = selectionFor(draft, entry.packId)!
      pack.items = pack.items.filter(item => item.id !== entry.item.id)
      if (selection.kind === 'item' && selection.id === entry.item.id) selection = { kind: 'pack', id: entry.packId }
    }
    placementItemId = null
  }

  const updateRailSections = (): void => {
    if (!draft.view.rail) return
    const active = new Set(activePacks().flatMap(pack => pack.categoryIds))
    draft.view.rail.sections = draft.view.rail.sections.filter(section => active.has(section.categoryId))
  }

  const addPack = (): void => {
    const pack = catalog?.packs.find(candidate => candidate.id === packToAdd)
    if (!pack || selectionFor(draft, pack.id)) return
    draft.packs.push({ id: pack.id, config: deepCopy(pack.configDefaults), items: [] })
    updateRailSections()
    draft = { ...draft }
    selection = { kind: 'pack', id: pack.id }
    packToAdd = ''
  }

  const removePack = (pack: AuthoringPack): void => {
    if (!confirm(`Remove ${pack.title} and all of its items from this scenario?`)) return
    const removedItems = selectionFor(draft, pack.id)?.items ?? []
    draft.packs = draft.packs.filter(selection => selection.id !== pack.id)
    const removedIds = new Set(removedItems.map(item => item.id))
    draft.connections = draft.connections.filter(connection =>
      !removedIds.has(connection.system.objectId) && !removedIds.has(connection.network.objectId))
    updateRailSections()
    draft = { ...draft }
    selection = { kind: 'scenario' }
    if (placementItemId && removedItems.some(item => item.id === placementItemId)) cancelPlacement()
  }

  const setRecordingProfile = (pack: AuthoringPack, profileId: string): void => {
    const selection = selectionFor(draft, pack.id)
    if (!selection) return
    const profile = pack.recordingProfiles.find(candidate => candidate.id === profileId)
    if (profile) selection.recording = { profileId: profile.id, intervalMs: profile.defaultIntervalMs }
    else delete selection.recording
    draft = { ...draft }
  }

  const setRecordingInterval = (pack: AuthoringPack, seconds: number): void => {
    const selection = recordingSelectionFor(pack.id)
    const profile = pack.recordingProfiles.find(candidate => candidate.id === selection?.profileId)
    if (!selection || !profile || !Number.isFinite(seconds)) return
    selection.intervalMs = Math.max(profile.minimumIntervalMs, Math.round(seconds * 1_000))
    draft = { ...draft }
  }

  const addItem = (packDescription: AuthoringPack, type: AuthoringItemType): void => {
    const id = `${type.idPrefix}-${crypto.randomUUID()}`
    const pack = selectionFor(draft, packDescription.id)
    if (!pack) return
    const count = pack.items.filter(item => item.type === type.id).length + 1
    const item = {
      type: type.id,
      id,
      label: `${type.label} ${count}`,
      ...deepCopy(type.defaultItem),
    }
    pack.items.push(item)
    selection = { kind: 'item', id }
    if (type.placement) beginPlacement(id)
    draft = { ...draft }
  }

  const removeItem = (item: ScenarioDraft['packs'][number]['items'][number]): void => {
    const entry = allItems().find(candidate => candidate.item.id === item.id)
    if (!entry) return
    const pack = selectionFor(draft, entry.packId)!
    pack.items = pack.items.filter(candidate => candidate.id !== item.id)
    draft.connections = draft.connections.filter(connection =>
      connection.system.objectId !== item.id && connection.network.objectId !== item.id)
    draft = { ...draft }
    selection = { kind: 'pack', id: entry.packId }
    if (placementItemId === item.id) cancelPlacement()
  }

  const duplicateItem = (): void => {
    const entry = selectedEntry()
    if (!entry) return
    const item = { ...deepCopy(entry.item), id: `${selectedType()!.idPrefix}-${crypto.randomUUID()}`, label: `${entry.item.label} copy` }
    selectionFor(draft, entry.packId)!.items.push(item)
    selection = { kind: 'item', id: item.id }
  }

  const applyAdvanced = async (value: unknown, target: 'scenario' | 'pack' | 'item'): Promise<void> => {
    let candidate = deepCopy(draft)
    if (target === 'scenario') {
      const parsed = scenarioDefinitionSchema.parse(value)
      candidate = { ...parsed, timeline: parsed.timeline ?? { cues: [] } } as ScenarioDraft
    }
    else if (target === 'pack') selectionFor(candidate, selectedPack()!.id)!.config = value as Record<string, unknown>
    else {
      const entry = selectedEntry()!
      const pack = selectionFor(candidate, entry.packId)!
      const replacement = value as typeof entry.item
      if (replacement.id !== entry.item.id || replacement.type !== entry.item.type) throw new Error('Use Duplicate to create a new identity; item id and type cannot be changed here.')
      pack.items = pack.items.map(item => item.id === entry.item.id ? replacement : item)
    }
    draft = candidate
  }

  const launchSaved = async (): Promise<void> => {
    if (!saved) return
    const started = await invoke<InvocationResponse>('world.scenario.start', {}, saved.definition)
    const run = started.createdResources?.find(resource => resource.type === 'world.simulation-run')
    if (!run) throw new Error('Scenario was saved, but the Simulation Run was not returned')
    window.parent.location.href = `/workspaces/${encodeURIComponent(workspaceId)}?world=${encodeURIComponent(run.id)}`
  }

  const setMapView = (center: [number, number], zoom: number): void => {
    draft.view.map.center = center
    draft.view.map.zoom = Math.round(zoom * 100) / 100
    draft = { ...draft }
  }

  const placeItem = (coordinates: [number, number]): void => {
    const entry = allItems().find(candidate => candidate.item.id === placementItemId)
    const type = entry && catalog ? itemTypeFor(catalog, entry.packId, entry.item) : undefined
    if (!entry || !type?.placement) return
    setValueAtPath(entry.item, type.placement.path, coordinates)
    if (type.placement.orReference) setValueAtPath(entry.item, type.placement.orReference, undefined)
    draft = { ...draft }
    cancelPlacement()
  }

  const updateField = (field: AuthoringField, value: unknown): void => {
    const target = selectedItem()
    if (!target) return
    setValueAtPath(target, field.path, value)
    const placement = selectedType()?.placement
    if (value && placement?.orReference?.join('.') === field.path.join('.')) {
      setValueAtPath(target, placement.path, undefined)
      placementItemId = null
    }
    draft = { ...draft }
  }

  const addElectricalConnection = (): void => {
    const system = electricalEndpoints().find(endpoint => endpoint.key === systemEndpointKey)
    const network = electricalEndpoints().find(endpoint => endpoint.key === networkEndpointKey)
    if (!system || !network) return
    if (system.objectId === network.objectId) {
      previewError = 'Connect ports on two different assets.'
      return
    }
    if (system.nominalKv !== network.nominalKv) {
      previewError = `Voltage mismatch: ${system.nominalKv} kV and ${network.nominalKv} kV.`
      return
    }
    const endpointAlreadyConnected = draft.connections.some(connection =>
      (connection.system.objectId === system.objectId && connection.system.portId === system.id)
      || (connection.network.objectId === system.objectId && connection.network.portId === system.id)
      || (connection.system.objectId === network.objectId && connection.system.portId === network.id)
      || (connection.network.objectId === network.objectId && connection.network.portId === network.id))
    if (endpointAlreadyConnected) {
      previewError = 'Each electrical port can have only one connection.'
      return
    }
    draft.connections.push({
      id: `electrical-${crypto.randomUUID()}`,
      type: 'electrical',
      system: { objectId: system.objectId, portId: system.id },
      network: { objectId: network.objectId, portId: network.id },
    })
    draft = { ...draft }
    systemEndpointKey = ''
    networkEndpointKey = ''
  }

  const removeConnection = (id: string): void => {
    draft.connections = draft.connections.filter(connection => connection.id !== id)
    draft = { ...draft }
  }

  const scenarioObjectDenies = (objectId: ObjectId): ReadonlyArray<'inspect' | 'change'> =>
    draft.agentRestrictions.objects.find(entry => entry.objectId === objectId)?.deny ?? []
  const setScenarioObjectRestriction = (objectId: ObjectId, effect: 'inspect' | 'change', denied: boolean): void => {
    const current = scenarioObjectDenies(objectId)
    const deny = denied ? [...new Set([...current, effect])] : current.filter(value => value !== effect)
    draft.agentRestrictions.objects = deny.length === 0
      ? draft.agentRestrictions.objects.filter(entry => entry.objectId !== objectId)
      : [...draft.agentRestrictions.objects.filter(entry => entry.objectId !== objectId), { objectId, deny }]
    draft = { ...draft }
  }
  const setScenarioOperationRestrictions = (value: string): void => {
    draft.agentRestrictions.operationIds = [...new Set(value.split('\n').map(entry => entry.trim()).filter(Boolean))]
    draft = { ...draft }
  }

  const validationError = (): string | null => {
    if (draft.title.trim().length === 0) return 'Give the scenario a title.'
    if (draft.packs.length === 0) return 'Add at least one Pack.'
    if (placementItemId) return 'Place the selected item on the map.'
    if (catalog && allItems().some(({ packId, item }) => {
      const type = catalog ? itemTypeFor(catalog, packId, item) : undefined
      return needsPlacement(item, type?.placement)
    })) return 'Every map item needs a position.'
    return null
  }

  const save = async (start: boolean): Promise<void> => {
    const invalid = validationError()
    if (invalid) { error = invalid; return }
    saving = true
    error = null
    try {
      draft.title = draft.title.trim()
      if (draft.description?.trim()) draft.description = draft.description.trim()
      else delete draft.description
      const document = JSON.stringify(draft)
      const response = editing === null
        ? await invoke<InvocationResponse>('world.scenario.create', { source: JSON.parse(document) })
        : await invoke<InvocationResponse>('world.scenario.update', { source: JSON.parse(document) }, editing)
      saved = scenarioWriteResultSchema.parse(response.result)
      savedDocument = document
      editing = saved.definition
      window.parent.postMessage({ type: 'leitbild:scenario-saved', subject: saved.definition }, location.origin)
      if (start) await launchSaved()
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      saving = false
    }
  }

  const reset = (): void => {
    draft = createEmptyScenarioDefinition()
    editing = null
    selection = { kind: 'scenario' }
    placementItemId = null
    saved = null
    error = null
    savedDocument = JSON.stringify(draft)
  }

  const previews = createLatestPreview({
    delayMs: 250,
    run: async (source: ScenarioDraft) => scenarioPreviewSchema.parse((await invoke<InvocationResponse>('world.scenario.preview', { source })).result),
    success: result => { preview = result; previewError = null },
    failure: cause => { preview = null; previewError = cause instanceof Error ? cause.message : String(cause) },
  })
  const structuralKey = $derived(JSON.stringify({ packs: draft.packs, connections: draft.connections, timeline: draft.timeline, world: draft.world }))
  $effect(() => {
    void structuralKey
    if (loading || catalog === null) return
    if (draft.packs.length === 0) {
      previews.cancel()
      preview = null
      previewError = null
      return
    }
    untrack(() => previews.schedule(deepCopy(draft)))
  })

  $effect(() => { window.parent.postMessage({ type: 'leitbild:scenario-dirty', dirty }, location.origin) })
  runOnMount(() => {
    void loadEditor()
    const warn = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', warn)
    return () => { previews.dispose(); window.removeEventListener('beforeunload', warn) }
  })
</script>

<main class:embedded class="scenario-builder">
  <header class="scenario-builder-header">
    <div><p class="eyebrow">World</p><h1>{editing ? 'Edit scenario' : 'Build a scenario'}</h1><p>Choose Packs, place items, then save the result as a reusable card.</p></div>
    {#if !embedded}<a class="command-button" href={`/workspaces/${encodeURIComponent(workspaceId)}`}>Workspace home</a>{/if}
  </header>

  {#if loading}
    <section class="builder-message">Discovering World Packs…</section>
  {:else if !catalog}
    <section class="builder-message error">{error ?? 'Scenario authoring is unavailable.'}</section>
  {:else}
    <section class="builder-toolbar">
      <label>Scenario title <input maxlength="160" value={draft.title} oninput={event => { draft.title = event.currentTarget.value; draft = { ...draft } }} /></label>
      <label class="feature-picker">Add Pack <select bind:value={packToAdd}><option value="">Choose…</option>{#each availablePacks() as pack (pack.id)}<option value={pack.id}>{pack.title}</option>{/each}</select></label>
      <button disabled={!packToAdd} onclick={addPack}>Add</button>
      <span class="builder-spacer"></span>
      <button class="primary" disabled={saving} onclick={() => void save(false)}>{editing ? 'Save revision' : 'Save'}</button>
      <button disabled={saving} onclick={() => void save(true)}>Save & start</button>
    </section>
    {#if error}<p class="builder-inline-error">{error}</p>{/if}
    {#if saved}<p role="status">Saved: {saved.title}{dirty ? ' · Unsaved changes' : ''}. <button disabled={saving || dirty} onclick={async () => { saving = true; error = null; try { await launchSaved() } catch (cause) { error = cause instanceof Error ? cause.message : String(cause) } finally { saving = false } }}>Start saved revision</button> <button onclick={() => { if (!dirty || confirm('Discard unsaved changes?')) reset() }}>Build another</button></p>{/if}
    <section class="builder-workbench">
      <aside class="builder-outline">
        <button class:active={selection.kind === 'scenario'} onclick={() => { selection = { kind: 'scenario' }; cancelPlacement() }}><strong>Scenario</strong><small>Starting view</small></button>
        {#each activePacks() as pack (pack.id)}
          <section class="outline-feature">
            <button class:active={selection.kind === 'pack' && selection.id === pack.id} onclick={() => { selection = { kind: 'pack', id: pack.id }; cancelPlacement() }}><strong>{pack.title}</strong><small>{selectionFor(draft, pack.id)?.items.length ?? 0} items</small></button>
            {#each selectionFor(draft, pack.id)?.items ?? [] as item (item.id)}
              <button class:active={selection.kind === 'item' && selection.id === item.id} class="outline-item" onclick={() => { selection = { kind: 'item', id: item.id }; cancelPlacement() }}><span>{item.label}</span><small>{item.type}</small></button>
            {/each}
          </section>
        {/each}
        {#if draft.packs.length === 0}<p class="outline-empty">Add a Pack to begin.</p>{/if}
      </aside>

      <section class="builder-map-panel">
        {#if placementItemId}<div class="placement-banner">Click the map to place {allItems().find(entry => entry.item.id === placementItemId)?.item.label}
          <button onclick={cancelPlacement}>Cancel</button>
        </div>{/if}
        <ScenarioBuilderMap
          center={mapCenter()} zoom={mapZoom()} points={mapPoints()} assets={preview?.assets ?? []}
          selectedId={selection.kind === 'item' ? selection.id : null}
          placementActive={placementItemId !== null} editView={selection.kind === 'scenario'}
          onviewchange={setMapView} onplace={placeItem}
          onmapview={view => editorMapView = view}
          onselect={id => { selection = { kind: 'item', id }; cancelPlacement() }}
        />
        {#if selection.kind === 'scenario'}<span class="map-hint">Pan and zoom to set the starting view</span>{/if}
      </section>

      <aside class="builder-properties">
        {#if selection.kind === 'scenario'}
          <h2>Scenario</h2><p>The map position is the starting frame users will see.</p>
          <AdvancedConfiguration value={draft} onapply={value => applyAdvanced(value, 'scenario')} />
          <TimelineEditor cues={draft.timeline.cues} commands={catalog.commands.filter(command => command.runtimeId === 'world.core' || activePacks().some(pack => command.packId === pack.id && command.runtimeId === (selectionFor(draft, pack.id)?.runtime ?? pack.defaultRuntimeId)))} onchange={cues => { draft.timeline = { cues } }} />
          <label>Objectives <textarea rows="3" placeholder="One objective per line" value={draft.objectives.join('\n')} onchange={event => { draft.objectives = event.currentTarget.value.split('\n').map(line => line.trim()).filter(Boolean) }}></textarea></label>
          <label>Description <textarea rows="4" placeholder="Optional" value={draft.description ?? ''} oninput={event => { draft.description = event.currentTarget.value; draft = { ...draft } }}></textarea></label>
          <details class="agent-restrictions"><summary>Initial AI restrictions</summary><p>Runs start open to scoped Agents except for these entries. Object limits block targeted details and changes, not existence or aggregate results. A user can replace this policy while a Run is active.</p>
            <label>Blocked operation IDs <textarea rows="3" placeholder="One operation ID per line" value={draft.agentRestrictions.operationIds.join('\n')} onchange={event => setScenarioOperationRestrictions(event.currentTarget.value)}></textarea></label>
            {#each preview?.assets ?? [] as asset (asset.id)}
              <div><span title={asset.id}>{asset.label}<small>{asset.packId}</small></span><label><input type="checkbox" checked={scenarioObjectDenies(asset.id).includes('inspect')} onchange={event => setScenarioObjectRestriction(asset.id, 'inspect', event.currentTarget.checked)} /> Details</label><label><input type="checkbox" checked={scenarioObjectDenies(asset.id).includes('change')} onchange={event => setScenarioObjectRestriction(asset.id, 'change', event.currentTarget.checked)} /> Change</label></div>
            {/each}
          </details>
          <dl><div><dt>Center</dt><dd>{mapCenter().map(value => value.toFixed(4)).join(', ')}</dd></div><div><dt>Zoom</dt><dd>{mapZoom().toFixed(1)}</dd></div></dl>
          <h3>Electrical connections</h3>
          {#if systemElectricalEndpoints().length === 0 || networkElectricalEndpoints().length === 0}
            <p>Add both a system asset and a network asset with compatible electrical ports.</p>
          {:else}
            <label>System port
              <select bind:value={systemEndpointKey}>
                <option value="">Choose…</option>
                {#each systemElectricalEndpoints() as endpoint (endpoint.key)}
                  <option value={endpoint.key}>{endpoint.objectLabel} · {endpoint.label} · {endpoint.nominalKv} kV</option>
                {/each}
              </select>
            </label>
            <label>Network port
              <select bind:value={networkEndpointKey}>
                <option value="">Choose…</option>
                {#each networkElectricalEndpoints() as endpoint (endpoint.key)}
                  <option value={endpoint.key}>{endpoint.objectLabel} · {endpoint.label} · {endpoint.nominalKv} kV</option>
                {/each}
              </select>
            </label>
            <button disabled={!systemEndpointKey || !networkEndpointKey} onclick={addElectricalConnection}>Connect ports</button>
          {/if}
          {#if previewError}<p class="connection-error">{previewError}</p>{/if}
          {#if draft.connections.length > 0}
            <div class="connection-list">
              {#each draft.connections as connection (connection.id)}
                {@const system = electricalEndpoints().find(endpoint => endpoint.objectId === connection.system.objectId && endpoint.id === connection.system.portId)}
                {@const network = electricalEndpoints().find(endpoint => endpoint.objectId === connection.network.objectId && endpoint.id === connection.network.portId)}
                <div>
                  <span>{system?.objectLabel ?? connection.system.objectId} ↔ {network?.objectLabel ?? connection.network.objectId}</span>
                  <small>{system?.label ?? connection.system.portId} · {network?.label ?? connection.network.portId}</small>
                  <button aria-label={`Remove ${connection.id}`} title="Remove connection" onclick={() => removeConnection(connection.id)}>×</button>
                </div>
              {/each}
            </div>
          {/if}
        {:else if selection.kind === 'pack'}
          {@const pack = selectedPack()}
          {#if pack}
            {@const packSelection = selectionFor(draft, pack.id)}
            <h2>{pack.title}</h2><p>{pack.description}</p>
            {#if packSelection && pack.runtimes.length > 1}
              <label>Runtime
                <select value={packSelection.runtime ?? pack.defaultRuntimeId} onchange={event => { packSelection.runtime = event.currentTarget.value; draft = { ...draft } }}>
                  {#each pack.runtimes as runtime (runtime.id)}<option value={runtime.id}>{runtime.label} · {runtime.kind}</option>{/each}
                </select>
              </label>
            {/if}
            {#if pack.recordingProfiles.length > 0}
              {@const recording = recordingSelectionFor(pack.id)}
              <label>Recording
                <select value={recording?.profileId ?? ''} onchange={event => setRecordingProfile(pack, event.currentTarget.value)}>
                  <option value="">Off</option>
                  {#each pack.recordingProfiles as profile (profile.id)}<option value={profile.id}>{profile.title}</option>{/each}
                </select>
              </label>
              {#if recording}
                {@const profile = pack.recordingProfiles.find(candidate => candidate.id === recording.profileId)}
                {#if profile}
                  <p>{profile.description}</p>
                  <label>Sample interval (seconds)
                    <input type="number" min={profile.minimumIntervalMs / 1_000} step={profile.minimumIntervalMs / 1_000} value={(recording.intervalMs ?? profile.defaultIntervalMs) / 1_000} onchange={event => setRecordingInterval(pack, event.currentTarget.valueAsNumber)} />
                  </label>
                  {#if preview?.recording}
                    {@const estimate = preview.recording.selections.find(selection => selection.packId === pack.id)}
                    <p>{estimate?.initialSeriesCount ?? 'Unknown'} initial series · {estimate?.samplesPerSimulationSecond?.toFixed(1) ?? 'unknown'} samples/s at full sampling, measured in simulation time.</p>
                    {#if preview.recording.sampleWindowSimulationSeconds !== null}
                      <p>All selected Packs share {preview.recording.sampleBudget.toLocaleString()} samples: approximately {Math.round(preview.recording.sampleWindowSimulationSeconds).toLocaleString()} simulation seconds at full sampling. Unchanged-value suppression may extend this; new assets may shorten it.</p>
                    {/if}
                    <p>History also stops at its byte budget ({Math.round(preview.recording.byteBudget / 1024 / 1024)} MiB); observations expire after at most {Math.round(preview.recording.ageLimitSeconds / 86400)} real days. These are ceilings, not guaranteed retention.</p>
                  {/if}
                {/if}
              {/if}
            {/if}
            {#if packSelection}
              <PackSettingsEditor packId={pack.id} config={packSelection.config} {workspaceId} center={mapCenter()} mapView={editorMapView} onchange={value => { packSelection.config = value; draft = { ...draft } }} />
              <AuthoringFields fields={pack.configFields} targetFor={()=>packSelection.config} onchange={(field,value)=>{setValueAtPath(packSelection.config,field.path,value);draft={...draft}}} />
              <AdvancedConfiguration value={packSelection.config} onapply={value => applyAdvanced(value, 'pack')} />
            {/if}
            {#if pack.itemTypes.length}<h3>Add item</h3><div class="item-type-list">{#each pack.itemTypes as type (type.id)}<button onclick={() => addItem(pack, type)}><strong>{type.label}</strong><small>{type.description}</small></button>{/each}</div>{/if}<button class="danger-text" onclick={() => removePack(pack)}>Remove Pack</button>
          {/if}
        {:else}
          {@const item = selectedItem()}
          {@const type = selectedType()}
          {#if item && type}
            <p class="eyebrow">{catalog.packs.find(pack => pack.id === selectedEntry()?.packId)?.title}</p><h2>{type.label}</h2>
            <label>Name <input value={item.label} oninput={event => { item.label = event.currentTarget.value; draft = { ...draft } }} /></label>
            <AuthoringFields fields={type.fields} targetFor={() => item} items={allItems().filter(entry => entry.item.id !== item.id).map(entry => entry.item)} packConfig={selectionFor(draft, selectedEntry()!.packId)!.config} onchange={updateField} />
            {#each type.collections as collection (collection.path.join('.'))}
              {@const rows = (valueAtPath(item,collection.path) ?? []) as Record<string,unknown>[]}
              <h3>{collection.label}</h3>
              {#each rows as row, index}
                <details class="authoring-record">
                  <summary>{collection.keyframes ? 'Keyframe' : 'Record'} {index + 1}</summary>
                  <AuthoringFields fields={collection.fields} targetFor={() => row} fallbackFor={field => collection.keyframes ? [ ...rows.slice(0,index).reverse(),item ].map(candidate => valueAtPath(candidate,field.path)).find(value => value !== undefined) : undefined} onchange={(field,value)=>{setValueAtPath(row,field.path,value);draft={...draft}}} />
                  <button class="danger-text" onclick={()=>{rows.splice(index,1);setValueAtPath(item,collection.path,rows);draft={...draft}}}>Remove record</button>
                </details>
              {/each}
              <button disabled={rows.length >= collection.maxItems} onclick={()=>{
                setValueAtPath(item,collection.path,[...rows,newCollectionRow(collection, rows)]);draft={...draft}
              }}>Add record</button>
            {/each}
            {#if type.placement}<button onclick={() => beginPlacement(item.id)}>Move on map</button>{/if}
            <button class="danger-text" onclick={() => removeItem(item)}>Remove item</button>
            <button onclick={duplicateItem}>Duplicate item</button>
            <AdvancedConfiguration value={item} onapply={value => applyAdvanced(value, 'item')} />
          {/if}
        {/if}
      </aside>
    </section>
  {/if}
</main>
