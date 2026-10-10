<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import {
    type InspectionView,
    type ModuleCapabilityDescriptor,
    type ModuleDefinitionDescriptor,
    type ModuleResourceDescriptor,
    type ResourceSummaryItem,
    type Workspace,
    type ModuleQueryOutcome,
    type WorkspaceResourceReference,
    type WorkspaceSubjectReference,
  } from '@leitbild/contracts'
  import JsonTree from './JsonTree.svelte'
  import WikiLink from './WikiLink.svelte'
  import WorkspaceComposer from './WorkspaceComposer.svelte'
  import WorkspacePicker from './WorkspacePicker.svelte'
  import InlineName from './InlineName.svelte'
  import SimulationRunControls from './SimulationRunControls.svelte'
  import AssistantLauncher from './AssistantLauncher.svelte'
  import RunRoomControls from './RunRoomControls.svelte'
  import { request, jsonRequest } from './api.ts'
  import { cardCapability } from './card-actions.ts'
  import { roomScopeIncludingRun, roomSelectsRun, roomUsesFamily, runFamilyFor, sameResource } from './run-room-scope.ts'

  type Page = { readonly kind: 'list' } | { readonly kind: 'workspace'; readonly id: string }
  interface InvocationResponse {
    readonly result: unknown
    readonly createdResources?: ReadonlyArray<ModuleResourceDescriptor['ref']>
  }
  type InspectionSubject =
    | { readonly kind: 'definition'; readonly descriptor: ModuleDefinitionDescriptor }
    | { readonly kind: 'resource'; readonly descriptor: ModuleResourceDescriptor }

  const moduleTitles: Readonly<Record<string, string>> = { world: 'World', agents: 'Agents' }
  const page = (): Page => {
    if (location.pathname === '/workspaces') return { kind: 'list' }
    const match = location.pathname.match(/^\/workspaces\/([^/]+)$/)
    if (!match) throw new Error('Unknown Workspace route')
    return { kind: 'workspace', id: decodeURIComponent(match[1] ?? '') }
  }

  const currentPage = page()
  const initialSelection = new URLSearchParams(location.search)
  const initialAgentsVisible = initialSelection.get('agents') !== null
  let selectedWorldRunId = $state(initialSelection.get('world'))
  let selectedAgentsRoomId = $state(initialSelection.get('agents'))
  let agentsVisible = $state(initialAgentsVisible)
  let workspaces = $state<ReadonlyArray<Workspace>>([])
  let workspace = $state<Workspace | null>(null)
  let loading = $state(true)
  let busy = $state(false)
  let error = $state<string | null>(null)
  let inspectionDialog = $state<HTMLDialogElement | null>(null)
  let inspectionSubject = $state<InspectionSubject | null>(null)
  let inspectionView = $state<InspectionView | null>(null)
  let inspectionLoading = $state(false)
  let inspectionError = $state<string | null>(null)
  let inspectionCopied = $state(false)
  let catalogFailures = $state<ReadonlyArray<ModuleQueryOutcome>>([])
  let refreshError = $state<string | null>(null)
  let definitions = $state<ReadonlyArray<ModuleDefinitionDescriptor>>([])
  let resources = $state<ReadonlyArray<ModuleResourceDescriptor>>([])
  let capabilities = $state<ReadonlyArray<ModuleCapabilityDescriptor>>([])
  let summaryClock = $state(Date.now())
  let scenarioEditorPath = $state<string | null>(null)
  let scenarioEditorFrame = $state<HTMLIFrameElement | null>(null)
  let scenarioEditorDirty = $state(false)
  let scenarioEditorSubject = $state<WorkspaceSubjectReference | null>(null)
  const workspaceTitle = $derived(workspace?.name ?? workspace?.id ?? 'Workspace')
  const showingComposer = $derived(selectedWorldRunId !== null || selectedAgentsRoomId !== null)
  const continuableResources = $derived(resources.filter(resource => resource.ref.type === 'world.simulation-run' && resource.uiPath !== undefined))
  const selectedWorldResource = $derived(resources.find(resource =>
    resource.ref.type === 'world.simulation-run' && resource.ref.id === selectedWorldRunId,
  ))
  const selectedAgentsResource = $derived(resources.find(resource =>
    resource.ref.moduleId === 'agents' && resource.ref.id === selectedAgentsRoomId,
  ))
  const selectedRunFamily = $derived(selectedWorldResource?.links.find(link =>
    link.rel === 'member-of' && link.ref.type === 'world.run-family',
  )?.ref)
  const familyRunRooms = $derived(selectedRunFamily === undefined ? [] : resources.filter(resource =>
    resource.ref.type === 'agents.room' && roomUsesFamily(resource, selectedRunFamily),
  ))
  const applicableRunRooms = $derived(selectedWorldResource === undefined ? [] : familyRunRooms.filter(resource =>
    roomSelectsRun(resource, selectedWorldResource),
  ))
  const focusedSubjects = $derived([
    ...(scenarioEditorSubject === null ? [] : [scenarioEditorSubject]),
    ...(selectedWorldResource === undefined ? [] : [selectedWorldResource.ref]),
  ].slice(0, 4))
  const pageTitle = $derived(currentPage.kind === 'list'
    ? 'Leitbild'
    : `${selectedWorldResource?.title ?? selectedAgentsResource?.title ?? workspaceTitle} · Leitbild`)

  const normalizeOpenSelection = (catalog: ReadonlyArray<ModuleResourceDescriptor>): void => {
    const run = catalog.find(resource => resource.ref.type === 'world.simulation-run' && resource.ref.id === selectedWorldRunId)
    const room = catalog.find(resource => resource.ref.type === 'agents.room' && resource.ref.id === selectedAgentsRoomId)
    if (selectedWorldRunId && !run) selectedWorldRunId = null
    if (selectedAgentsRoomId && !room) {
      selectedAgentsRoomId = null
      agentsVisible = false
    }
    if (run && room) {
      if (!roomSelectsRun(room, run)) {
        selectedAgentsRoomId = null
        agentsVisible = false
      }
    }
    const url = new URL(location.href)
    if (selectedWorldRunId) url.searchParams.set('world', selectedWorldRunId)
    else url.searchParams.delete('world')
    if (selectedAgentsRoomId && agentsVisible) url.searchParams.set('agents', selectedAgentsRoomId)
    else url.searchParams.delete('agents')
    history.replaceState(null, '', url)
  }

  $effect(() => {
    document.title = pageTitle
  })

  let catalogRequest = 0
  let resourceRequest = 0
  const loadWorkspaceCatalog = async (workspaceId: string): Promise<void> => {
    const token = ++catalogRequest
    const resourceToken = ++resourceRequest
    const encoded = encodeURIComponent(workspaceId)
    const [definitionResponse, resourceResponse, capabilityResponse] = await Promise.all([
      request<{ definitions: ReadonlyArray<ModuleDefinitionDescriptor>; modules: ModuleQueryOutcome[] }>(`/api/workspaces/${encoded}/definitions`),
      request<{ resources: ReadonlyArray<ModuleResourceDescriptor>; modules: ModuleQueryOutcome[] }>(`/api/workspaces/${encoded}/resources`),
      request<{ capabilities: ReadonlyArray<ModuleCapabilityDescriptor>; modules: ModuleQueryOutcome[] }>(`/api/workspaces/${encoded}/capabilities`),
    ])
    if (token !== catalogRequest) return // A newer catalog request owns the UI.
    catalogFailures = [...new Map([...definitionResponse.modules, ...resourceResponse.modules, ...capabilityResponse.modules]
      .filter(outcome => outcome.status === 'failed').map(outcome => [outcome.moduleId, outcome])).values()]
    definitions = definitionResponse.definitions
    if (resourceToken === resourceRequest) {
      resources = resourceResponse.resources
      normalizeOpenSelection(resources)
      refreshError = null
    }
    capabilities = capabilityResponse.capabilities
  }

  const refreshResources = async (workspaceId: string): Promise<void> => {
    const token = ++resourceRequest
    const response = await request<{ resources: ReadonlyArray<ModuleResourceDescriptor>; modules: ModuleQueryOutcome[] }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/resources`,
    )
    if (token !== resourceRequest) return
    resources = response.resources
    refreshError = response.modules.filter(outcome => outcome.status === 'failed').map(outcome => outcome.failure.message).join('; ') || null
  }

  const handleWindowMessage = (event: MessageEvent): void => {
    if (event.origin !== location.origin || !workspace) return
    if (typeof event.data !== 'object' || event.data === null) return
    if (event.source !== scenarioEditorFrame?.contentWindow) return
    const data = event.data as { readonly type?: unknown; readonly dirty?: unknown; readonly subject?: unknown }
    if (data.type === 'leitbild:scenario-dirty') scenarioEditorDirty = data.dirty === true
    if (data.type === 'leitbild:scenario-saved') {
      if (typeof data.subject === 'object' && data.subject !== null) scenarioEditorSubject = data.subject as WorkspaceSubjectReference
      void run(() => loadWorkspaceCatalog(workspace!.id))
    }
  }

  const load = async (): Promise<void> => {
    loading = true
    error = null
    try {
      if (currentPage.kind === 'list') {
        workspaces = (await request<{ workspaces: ReadonlyArray<Workspace> }>('/api/workspaces')).workspaces
      } else {
        const workspaceId = encodeURIComponent(currentPage.id)
        await Promise.all([
          request<{ workspace: Workspace }>(`/api/workspaces/${workspaceId}`).then(response => { workspace = response.workspace }),
          loadWorkspaceCatalog(currentPage.id),
        ])
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      loading = false
    }
  }

  const run = async (action: () => Promise<void>): Promise<void> => {
    if (busy) return
    busy = true
    error = null
    try { await action() }
    catch (cause) { error = cause instanceof Error ? cause.message : String(cause) }
    finally { busy = false }
  }

  const retryModule = (moduleId: string): Promise<void> => run(async () => {
    if (!workspace) return
    workspace = (await request<{ workspace: Workspace }>(
      `/api/workspaces/${workspace.id}/modules/${encodeURIComponent(moduleId)}/retry`, { method: 'POST' },
    )).workspace
    await loadWorkspaceCatalog(workspace.id)
  })

  const openResources = (created: ReadonlyArray<ModuleResourceDescriptor['ref']>): void => {
    const world = created.find(resource => resource.moduleId === 'world' && resource.type === 'world.simulation-run')
    const agents = created.find(resource => resource.moduleId === 'agents' && resource.type === 'agents.room')
    const params = new URLSearchParams()
    if (world) params.set('world', world.id)
    else if (selectedWorldRunId) params.set('world', selectedWorldRunId)
    if (agents) params.set('agents', agents.id)
    else if (!world && selectedAgentsRoomId) params.set('agents', selectedAgentsRoomId)
    location.href = `${location.pathname}${params.size > 0 ? `?${params}` : ''}`
  }

  const invokeDefinition = (definition: ModuleDefinitionDescriptor, capability: ModuleCapabilityDescriptor): Promise<void> => run(async () => {
    if (!workspace) return
    if (capability.risk === 'destructive' && !confirm(`${capability.title}: ${definition.title}? Existing live resources will remain.`)) return
    const response = await request<InvocationResponse>(
      `/api/workspaces/${workspace.id}/capabilities/${encodeURIComponent(capability.id)}/invoke`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          definition: { ...definition.ref, revisionId: definition.currentRevisionId },
          input: {}, actor: { kind: 'human' },
        }),
      },
    )
    if (response.createdResources?.length) openResources(response.createdResources)
    else await loadWorkspaceCatalog(workspace.id)
  })

  const invokeResource = (resource: ModuleResourceDescriptor, capability: ModuleCapabilityDescriptor): Promise<void> => run(async () => {
    if (!workspace) return
    if (capability.risk === 'destructive' && !confirm(`${capability.title}: ${resource.title}? This cannot be undone.`)) return
    await request<InvocationResponse>(
      `/api/workspaces/${workspace.id}/capabilities/${encodeURIComponent(capability.id)}/invoke`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resource: resource.ref, input: {}, actor: { kind: 'human' } }),
      },
    )
    await loadWorkspaceCatalog(workspace.id)
  })

  const inspect = async (subject: InspectionSubject): Promise<void> => {
    if (!workspace) return
    const capabilityId = subject.descriptor.inspectionCapabilityId
    const capability = capabilityId === undefined ? undefined : capabilityFor(capabilityId)
    const correctlyScoped = capability !== undefined && (
      subject.kind === 'definition'
        ? capability.scope.kind === 'definition' && capability.scope.definitionType === subject.descriptor.ref.type
        : capability.scope.kind === 'resource' && capability.scope.resourceType === subject.descriptor.ref.type
    )
    if (!capability || capability.kind !== 'query' || capability.risk !== 'read' || !correctlyScoped) {
      error = 'This item does not publish a valid read-only Inspection Capability.'
      return
    }
    inspectionSubject = subject
    inspectionView = null
    inspectionError = null
    inspectionCopied = false
    inspectionLoading = true
    inspectionDialog?.showModal()
    try {
      const response = await request<InvocationResponse>(
        `/api/workspaces/${workspace.id}/capabilities/${encodeURIComponent(capability.id)}/invoke`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(subject.kind === 'definition'
              ? { definition: { ...subject.descriptor.ref, revisionId: subject.descriptor.currentRevisionId } }
              : { resource: subject.descriptor.ref }),
            input: {}, actor: { kind: 'human' },
          }),
        },
      )
      inspectionView = response.result as InspectionView
    } catch (cause) {
      inspectionError = cause instanceof Error ? cause.message : String(cause)
    } finally {
      inspectionLoading = false
    }
  }

  const inspectedCapabilities = (): ReadonlyArray<ModuleCapabilityDescriptor> => inspectionSubject === null
    ? []
    : inspectionSubject.descriptor.capabilityIds.flatMap(id => {
      const capability = capabilityFor(id)
      return capability === undefined ? [] : [capability]
    })

  const inspectionExport = (): unknown => inspectionSubject === null ? null : {
    kind: inspectionSubject.kind,
    descriptor: inspectionSubject.descriptor,
    capabilities: inspectedCapabilities(),
    inspection: inspectionView,
  }

  const copyInspection = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(inspectionExport(), null, 2))
      inspectionCopied = true
      setTimeout(() => { inspectionCopied = false }, 1_500)
    } catch (cause) {
      inspectionError = cause instanceof Error ? cause.message : String(cause)
    }
  }

  const openResource = (resource: ModuleResourceDescriptor): void => {
    const params = new URLSearchParams()
    if (resource.ref.type === 'world.simulation-run') params.set('world', resource.ref.id)
    if (resource.ref.type === 'agents.room') params.set('agents', resource.ref.id)
    if (params.size > 0) location.href = `${location.pathname}?${params}`
    else if (resource.uiPath) location.href = resource.uiPath
  }

  const switchWorldRun = (runId: string, replace = false): void => {
    selectedWorldRunId = runId
    const nextRun = resources.find(candidate => candidate.ref.type === 'world.simulation-run' && candidate.ref.id === runId)
    if (selectedAgentsResource && nextRun && !roomSelectsRun(selectedAgentsResource, nextRun)) {
      selectedAgentsRoomId = null
      agentsVisible = false
    }
    const url = new URL(location.href)
    url.searchParams.set('world', runId)
    if (selectedAgentsRoomId) url.searchParams.set('agents', selectedAgentsRoomId)
    else url.searchParams.delete('agents')
    if (replace) history.replaceState(null, '', url)
    else history.pushState(null, '', url)
  }

  // The process display window opens a chat display's Run only when this Workspace lists it.
  const listsRun = (run: WorkspaceResourceReference): boolean =>
    resources.some(resource => resource.ref.type === 'world.simulation-run' && sameResource(resource.ref, run))

  const closeWorldRun = (): void => {
    location.href = workspace ? `/workspaces/${encodeURIComponent(workspace.id)}` : '/workspaces'
  }

  const restoreUrlSelection = (): void => {
    const selection = new URLSearchParams(location.search)
    selectedWorldRunId = selection.get('world')
    selectedAgentsRoomId = selection.get('agents')
    agentsVisible = selectedAgentsRoomId !== null
  }

  const capabilityFor = (id: string): ModuleCapabilityDescriptor | undefined => capabilities.find(item => item.id === id)
  const assistantCapability = $derived(capabilities.find(item => item.id === 'agents.assistance.open' && item.scope.kind === 'workspace'))
  const openAssistant = async (prompt: string): Promise<void> => {
    if (!workspace || !assistantCapability) throw new Error('Leitbild Assistant is unavailable')
    const response = await request<InvocationResponse & { result: { resource: ModuleResourceDescriptor['ref']; uiPath: string; reused: boolean } }>(
      `/api/workspaces/${workspace.id}/capabilities/${encodeURIComponent(assistantCapability.id)}/invoke`,
      jsonRequest('POST', {
        input: {
          prompt,
          focusedSubjects,
        },
        actor: { kind: 'human' },
      }),
    )
    selectedAgentsRoomId = response.result.resource.id
    selectedWorldRunId = null
    agentsVisible = true
    const url = new URL(location.href)
    url.searchParams.set('agents', response.result.resource.id)
    url.searchParams.delete('world')
    history.pushState(null, '', url)
    void refreshResources(workspace.id).catch(cause => { refreshError = String(cause) })
  }
  const toggleRunAssistant = async (): Promise<void> => {
    if (!workspace || !selectedWorldResource || !selectedRunFamily || !assistantCapability) return
    if (agentsVisible) {
      agentsVisible = false
      const url = new URL(location.href)
      url.searchParams.delete('agents')
      history.replaceState(null, '', url)
      return
    }
    const existing = selectedAgentsResource && roomSelectsRun(selectedAgentsResource, selectedWorldResource)
      ? selectedAgentsResource
      : applicableRunRooms[0]
    if (existing) {
      selectedAgentsRoomId = existing.ref.id
    } else if (familyRunRooms[0]) {
      const room = familyRunRooms[0]
      const capabilityId = 'agents.room.scope.set'
      if (!capabilities.some(capability => capability.id === capabilityId)) throw new Error('Room scope controls are unavailable')
      const expectedRevision = Number(room.summary.find(item => item.key === 'scope-revision')?.value ?? 0)
      await request(
        `/api/workspaces/${workspace.id}/capabilities/${encodeURIComponent(capabilityId)}/invoke`,
        jsonRequest('POST', {
          resource: room.ref,
          input: {
            scope: roomScopeIncludingRun(room, selectedRunFamily, selectedWorldResource.ref),
            expectedRevision,
          },
          actor: { kind: 'human' },
        }),
      )
      selectedAgentsRoomId = room.ref.id
      agentsVisible = true
      const url = new URL(location.href)
      url.searchParams.set('agents', selectedAgentsRoomId)
      history.replaceState(null, '', url)
      void refreshResources(workspace.id).catch(cause => { refreshError = String(cause) })
      return
    } else {
      const response = await request<InvocationResponse & { result: { resource: ModuleResourceDescriptor['ref']; uiPath: string; reused: boolean } }>(
        `/api/workspaces/${workspace.id}/capabilities/${encodeURIComponent(assistantCapability.id)}/invoke`,
        jsonRequest('POST', {
          input: {
            scope: { kind: 'collection', collection: selectedRunFamily, members: { mode: 'all', except: [] } },
            title: selectedWorldResource.title,
            focusedSubjects: [selectedWorldResource.ref],
          },
          actor: { kind: 'human' },
        }),
      )
      selectedAgentsRoomId = response.result.resource.id
      agentsVisible = true
      const url = new URL(location.href)
      url.searchParams.set('agents', selectedAgentsRoomId)
      history.replaceState(null, '', url)
      void refreshResources(workspace.id).catch(cause => { refreshError = String(cause) })
      return
    }
    agentsVisible = true
    const url = new URL(location.href)
    url.searchParams.set('agents', selectedAgentsRoomId!)
    history.replaceState(null, '', url)
  }
  const showRunAssistant = (): void => {
    if (!selectedAgentsRoomId) return
    agentsVisible = true
    const url = new URL(location.href)
    url.searchParams.set('agents', selectedAgentsRoomId)
    history.replaceState(null, '', url)
  }
  const selectRunRoom = (roomId: string): void => {
    selectedAgentsRoomId = roomId
    agentsVisible = true
    const url = new URL(location.href)
    url.searchParams.set('agents', roomId)
    history.replaceState(null, '', url)
  }
  const refreshAndSelectRunRoom = async (roomId: string): Promise<void> => {
    if (!workspace) return
    await refreshResources(workspace.id)
    const updatedRoom = resources.find(resource => resource.ref.type === 'agents.room' && resource.ref.id === roomId)
    if (selectedWorldResource && updatedRoom && !roomSelectsRun(updatedRoom, selectedWorldResource)) {
      selectedAgentsRoomId = null
      agentsVisible = false
      const url = new URL(location.href)
      url.searchParams.delete('agents')
      history.replaceState(null, '', url)
      return
    }
    selectRunRoom(roomId)
  }
  const renameResource = async (resource: ModuleResourceDescriptor, name: string, expectedTitle: string): Promise<void> => {
    if (!workspace) throw new Error('Workspace is unavailable')
    const capability = cardCapability(resource, 'rename', capabilities)
    if (!capability) throw new Error('This Resource cannot be renamed')
    ++resourceRequest
    await request(`/api/workspaces/${workspace.id}/capabilities/${encodeURIComponent(capability.id)}/invoke`,
      jsonRequest('POST', { resource: resource.ref, input: { name: name || null, expectedTitle }, actor: { kind: 'human' } }))
    await refreshResources(workspace.id)
  }
  const definitionsFor = (moduleId: string): ReadonlyArray<ModuleDefinitionDescriptor> => definitions.filter(item => item.ref.moduleId === moduleId)
  const resourcesFor = (moduleId: string): ReadonlyArray<ModuleResourceDescriptor> => continuableResources.filter(item => item.ref.moduleId === moduleId)
  const relativeTime = (timestamp: string): string => {
    const deltaSeconds = Math.round((summaryClock - Date.parse(timestamp)) / 1000)
    const future = deltaSeconds < 0
    const seconds = Math.abs(deltaSeconds)
    if (seconds < 10) return 'just now'
    const [value, unit] = seconds < 60
      ? [seconds, 's']
      : seconds < 3_600
        ? [Math.round(seconds / 60), 'm']
        : seconds < 86_400
          ? [Math.round(seconds / 3_600), 'h']
          : [Math.round(seconds / 86_400), 'd']
    return future ? `in ${value}${unit}` : `${value}${unit} ago`
  }
  const summaryValue = (item: ResourceSummaryItem): string =>
    item.kind === 'timestamp' ? relativeTime(item.value) : String(item.value)
  const refreshInterval = setInterval(() => {
    summaryClock = Date.now()
    if (currentPage.kind === 'workspace' && workspace && !showingComposer) {
      void refreshResources(workspace.id).catch(cause => { refreshError = String(cause) })
    }
  }, 20_000)
  onDestroy(() => clearInterval(refreshInterval))

  onMount(() => {
    window.addEventListener('popstate', restoreUrlSelection)
    void load()
    return () => window.removeEventListener('popstate', restoreUrlSelection)
  })
</script>

<svelte:window onmessage={handleWindowMessage} />

{#if currentPage.kind === 'workspace' && workspace}
  <header class="workspace-bar">
    <div class="workspace-identity"><a class="brand" href="/workspaces">Leitbild</a><a class="workspace-name" href={`/workspaces/${workspace.id}`} title={workspaceTitle}>[{workspaceTitle}]</a></div>
    <div class="workspace-actions">
      {#if selectedWorldResource}
        <SimulationRunControls
          workspaceId={workspace.id}
          resource={selectedWorldResource}
          {resources}
          {capabilities}
          onSwitch={switchWorldRun}
          onClose={closeWorldRun}
          refreshResources={() => refreshResources(workspace!.id)}
          reportError={message => { error = message }}
        />
        {#if agentsVisible && selectedRunFamily}
          {@const familyResource = resources.find(resource => resource.ref.type === 'world.run-family' && resource.ref.id === selectedRunFamily.id)}
          {#if familyResource}
            <RunRoomControls
              workspaceId={workspace.id}
              family={familyResource}
              currentRun={selectedWorldResource}
              rooms={applicableRunRooms}
              activeRoomId={selectedAgentsRoomId}
              activeRoom={selectedAgentsResource}
              {capabilities}
              onRoomSelected={selectRunRoom}
              onChanged={refreshAndSelectRunRoom}
            />
          {/if}
        {/if}
      {/if}
      {#if selectedWorldResource}
        <AssistantLauncher disabled={assistantCapability === undefined} toggle={toggleRunAssistant} active={agentsVisible} onError={message => { error = message }} />
      {:else}
        <AssistantLauncher disabled={assistantCapability === undefined} submit={openAssistant} />
      {/if}
      <WikiLink />
    </div>
  </header>
{:else}
  <header class="topbar"><a class="brand" href="/workspaces">Leitbild</a><span class="tagline">— A modular microworld simulation and AI agent sandbox system</span><WikiLink /></header>
{/if}

<main class:workspace-main={currentPage.kind === 'workspace' && showingComposer}>
  {#if loading}
    <section class="notice">Loading Workspace…</section>
  {:else if error && currentPage.kind === 'workspace' && !workspace}
    <section class="notice error"><h1>Workspace unavailable</h1><p>{error}</p><a href="/workspaces">Back to Workspaces</a></section>
  {:else if currentPage.kind === 'list'}
    {#if error}<p class="notice error" role="alert">{error}</p>{/if}
    <WorkspacePicker {workspaces} />
  {:else if workspace}
    {#each workspace.modules as moduleState (moduleState.moduleId)}
      {#if moduleState.status !== 'ready'}
        <section class="notice error" role="alert"><p>{moduleTitles[moduleState.moduleId]}: {moduleState.failure?.message ?? moduleState.status}</p>
          {#if moduleState.status === 'provision_failed'}<button disabled={busy} onclick={() => void retryModule(moduleState.moduleId)}>Retry setup</button>{/if}
          {#if moduleState.status === 'remove_failed' || moduleState.status === 'removing'}<a href="/workspaces">Manage workspaces to retry deletion</a>{/if}
        </section>
      {/if}
    {/each}
    {#each catalogFailures as outcome (outcome.moduleId)}{#if outcome.status === 'failed'}<p class="notice error" role="alert">{moduleTitles[outcome.moduleId]}: {outcome.failure.message}</p>{/if}{/each}
    {#if refreshError}<p class="notice error" role="alert">Catalog refresh failed: {refreshError}</p>{/if}
    {#if showingComposer}
    <WorkspaceComposer workspaceId={workspace.id} worldRunId={selectedWorldRunId} {focusedSubjects} agentsRoomId={selectedAgentsRoomId} {agentsVisible} onShowAgents={showRunAssistant}
      hasRun={listsRun} onOpenRun={runId => switchWorldRun(runId)} onError={message => { error = message }} />
    {:else}
      <section class="workspace-home">
        {#if error}<p class="notice error">{error}</p>{/if}
        <section class="catalog-section-home scenario-builder-home">
          <header><h2>Create</h2><span>World scenario</span></header>
          {#if scenarioEditorPath}
            <div class="scenario-builder-frame"><button class="builder-close" type="button" onclick={() => { if (!scenarioEditorDirty || confirm('Discard unsaved scenario changes?')) { scenarioEditorPath = null; scenarioEditorSubject = null; scenarioEditorDirty = false } }}>Close editor</button><iframe bind:this={scenarioEditorFrame} title="World Scenario Editor" src={`${scenarioEditorPath}${scenarioEditorPath.includes('?') ? '&' : '?'}embed=1`}></iframe></div>
          {:else}
            <article class="scenario-builder-launch"><div><h3>Build a scenario</h3><p>Pick World Packs, place assets on the map, and save the result as a reusable scenario.</p></div><button class="primary" onclick={() => { if (workspace) { scenarioEditorSubject = null; scenarioEditorPath = `/workspaces/${encodeURIComponent(workspace.id)}/world/scenarios/new` } }}>Open editor</button></article>
          {/if}
        </section>
        <section class="catalog-section-home"><header><h2>World</h2><span>{definitionsFor('world').length} scenarios</span></header><div class="catalog-grid">
            {#each definitionsFor('world') as definition (`${definition.ref.type}:${definition.ref.id}`)}
              {@const primary = cardCapability(definition, 'primary', capabilities)}
              {@const remove = cardCapability(definition, 'delete', capabilities)}
              <article class="catalog-card clickable-card" aria-busy={busy}>
                {#if primary}<button class="card-hit-target" disabled={busy} aria-label={`Start ${definition.title}`} onclick={() => void invokeDefinition(definition, primary)}></button>{/if}
                <div>{#if definition.category}<span class="card-category">{definition.category}</span>{/if}<h3>{definition.title}</h3><p>{definition.description ?? definition.ref.id}</p></div>
                <div class="card-actions card-control">
                  {#if definition.uiPath}<button onclick={() => { scenarioEditorSubject = { ...definition.ref, revisionId: definition.currentRevisionId }; scenarioEditorPath = definition.uiPath ?? null }}>Edit</button>{/if}
                  {#if definition.inspectionCapabilityId}<button disabled={inspectionLoading} onclick={() => void inspect({ kind: 'definition', descriptor: definition })}>Inspect</button>{/if}
                </div>
                {#if remove}<button class="card-delete card-control" disabled={busy} aria-label={`Delete ${definition.title}`} title="Delete scenario" onclick={() => void invokeDefinition(definition, remove)}>×</button>{/if}
              </article>
            {/each}
          </div></section>
        {#if continuableResources.length > 0}
          <section class="catalog-section-home">
            <header><h2>Continue</h2><span>{continuableResources.length} resources</span></header>
            <div class="resource-columns">
                <div><h3>World</h3>
                  {#each resourcesFor('world') as resource (`${resource.ref.type}:${resource.ref.id}`)}
                    {@const deleteCapability = cardCapability(resource, 'delete', capabilities)}
                    <article class="resource-card clickable-card">
                      <button class="card-hit-target" aria-label={`Continue ${resource.title}`} onclick={() => openResource(resource)}></button>
                      <div class="resource-open">
                        {#if resource.renameCapabilityId}<InlineName value={resource.title} fallback={resource.ref.id} label={`Rename ${resource.title}`} onsave={(name, original) => renameResource(resource, name, original)} />{:else}<strong>{resource.title}</strong>{/if}
                        {#if resource.description}<span class="resource-description">{resource.description}</span>{/if}
                        {#if resource.summary.length > 0}
                          <span class="resource-summary">
                            {#each resource.summary as item (item.key)}
                              <span class="resource-fact" title={item.kind === 'timestamp' ? item.value : undefined}>
                                <small>{item.label}</small><b>{summaryValue(item)}</b>
                              </span>
                            {/each}
                          </span>
                        {/if}
                      </div>
                      <span class="resource-tools card-control">
                        {#if resource.inspectionCapabilityId}<button class="resource-inspect" type="button" aria-label={`Inspect ${resource.title}`} disabled={inspectionLoading} onclick={() => void inspect({ kind: 'resource', descriptor: resource })}>Inspect</button>{/if}
                        {#if deleteCapability}<button class="resource-delete" type="button" aria-label={`${deleteCapability.title}: ${resource.title}`} title={deleteCapability.title} disabled={busy} onclick={() => void invokeResource(resource, deleteCapability)}>×</button>{/if}
                      </span>
                    </article>
                  {/each}
                </div>
            </div>
          </section>
        {/if}
      </section>
    {/if}

    {#if error && showingComposer}<p class="workspace-error">{error}</p>{/if}
    <dialog class="inspection-dialog" bind:this={inspectionDialog}>
      <header>
        <div><p class="eyebrow">{inspectionSubject?.kind === 'definition' ? 'Reusable definition' : 'Live resource'}</p><h2>{inspectionView?.title ?? inspectionSubject?.descriptor.title ?? 'Inspect'}</h2>{#if inspectionView?.description}<p>{inspectionView.description}</p>{/if}</div>
        <button class="dialog-close" type="button" aria-label="Close inspection" onclick={() => inspectionDialog?.close()}>×</button>
      </header>
      <div class="inspection-toolbar"><span>{inspectionSubject?.descriptor.ref.moduleId} · {inspectionSubject?.descriptor.ref.type}</span><button disabled={inspectionLoading || inspectionView === null} onclick={() => void copyInspection()}>{inspectionCopied ? 'Copied' : 'Copy all JSON'}</button></div>
      {#if inspectionLoading}<section class="inspection-message">Loading configuration and live state…</section>
      {:else if inspectionError}<section class="inspection-message error">{inspectionError}</section>
      {:else if inspectionView && inspectionSubject}
        <section class="inspection-section">
          <details open><summary>Catalog metadata</summary><JsonTree value={inspectionSubject.descriptor} /></details>
        </section>
        {#each inspectionView.sections as section, index (section.id)}
          <section class="inspection-section">
            <details open={index < 2}><summary>{section.title}</summary>{#if section.description}<p>{section.description}</p>{/if}<JsonTree value={section.data} /></details>
          </section>
        {/each}
        <section class="inspection-section">
          <details><summary>Available capabilities ({inspectedCapabilities().length})</summary><JsonTree value={inspectedCapabilities()} /></details>
        </section>
      {/if}
    </dialog>
  {/if}
</main>
