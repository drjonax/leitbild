<script lang="ts">
  import { onDestroy, onMount, tick, untrack } from 'svelte'
  import {
    type FeaturedDefinitionCatalog,
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
  import SimulationRunControls from './SimulationRunControls.svelte'
  import AssistantLauncher from './AssistantLauncher.svelte'
  import RunRoomControls from './RunRoomControls.svelte'
  import Wordmark from './Wordmark.svelte'
  import Icon from './Icon.svelte'
  import MoreMenu from './MoreMenu.svelte'
  import WorkspaceHeader from './WorkspaceHeader.svelte'
  import ContinueList from './ContinueList.svelte'
  import FeaturedRow from './FeaturedRow.svelte'
  import DefinitionCatalog from './DefinitionCatalog.svelte'
  import WorkspaceSwitcher from './WorkspaceSwitcher.svelte'
  import PeopleControl from './PeopleControl.svelte'
  import PeopleChat from './PeopleChat.svelte'
  import { request, jsonRequest } from './api.ts'
  import { cardCapability } from './card-actions.ts'
  import { roomScopeIncludingRun, roomSelectsRun, roomServesRun, roomUsesFamily, runDeclaresRoles, runFamilyFor, sameResource } from './run-room-scope.ts'
  import { keptSelection } from './open-selection.ts'
  import { withUnreadCount, workspacePageTitle } from './page-title.ts'
  import { ageText, moduleTitle, workspaceLabel } from './launch-workspace.ts'
  import { workspacePath, workspaceUrl } from './launch-destination.ts'
  import { createPeopleSession, type PeopleSession, type PeopleState } from './people-session.ts'
  import { browserPeoplePorts } from './people-browser.ts'
  import { PEOPLE_SYNC_CAPABILITY_ID, type PersonWire } from './people-wire.ts'
  import { browserWorkspaceMemory } from './workspace-memory.ts'
  import { demosHref, guideHref } from './modal-url.ts'
  import { createWorkspaceAdmin } from './workspace-admin.ts'
  import { errorDiagnostic, plainError, plainErrorText } from './error-text.ts'
  import { createStartRunner, startAnnouncement, type StartState, type StartTarget } from './definition-start.ts'
  import { readFeaturedCatalogue } from './featured-catalogue.ts'
  import { continueItems, featuredStartRevision, openedFromGuide, workspaceDemos, type FeaturedCard } from './workspace-page.ts'

  type Page = { readonly kind: 'workspace'; readonly id: string }
  interface InvocationResponse {
    readonly result: unknown
    readonly createdResources?: ReadonlyArray<ModuleResourceDescriptor['ref']>
  }
  type InspectionSubject =
    | { readonly kind: 'definition'; readonly descriptor: ModuleDefinitionDescriptor }
    | { readonly kind: 'resource'; readonly descriptor: ModuleResourceDescriptor }

  // `/workspaces` itself is the landing page (Landing.svelte); this shell serves one Workspace.
  const page = (): Page => {
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
  // A conversation the Getting started guide opened links back to it (plan v2 §2).
  const fromGuide = openedFromGuide(initialSelection)
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
  const workspaceTitle = $derived(workspace ? workspaceLabel(workspace, 'header') : 'Workspace')
  const showingComposer = $derived(selectedWorldRunId !== null || selectedAgentsRoomId !== null)
  const continuing = $derived(continueItems(resources))
  const memory = browserWorkspaceMemory()
  const admin = createWorkspaceAdmin()
  let featuredCatalog = $state<FeaturedDefinitionCatalog | null>(null)
  let featuredFailed = $state(false)
  const demos = $derived(workspaceDemos(definitions, featuredCatalog))
  const startRunner = createStartRunner({ fetch: (input, init) => fetch(input, init) })
  let startState = $state<StartState>(startRunner.state())
  startRunner.subscribe(state => { startState = state })
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
  const pageTitle = $derived(workspacePageTitle({
    workspace: workspace ? workspaceTitle : null,
    run: selectedWorldResource?.title,
    room: selectedAgentsResource?.title,
  }))

  /** The Modules' answers to the last Resource read, so Back and Forward can check a restored selection too. */
  let resourceOutcomes: ReadonlyArray<ModuleQueryOutcome> = []
  const normalizeOpenSelection = (catalog: ReadonlyArray<ModuleResourceDescriptor>, modules: ReadonlyArray<ModuleQueryOutcome>): void => {
    resourceOutcomes = modules
    const kept = keptSelection({ world: selectedWorldRunId, agents: selectedAgentsRoomId, agentsVisible }, catalog, modules)
    selectedWorldRunId = kept.world
    selectedAgentsRoomId = kept.agents
    agentsVisible = kept.agentsVisible
    const url = new URL(location.href)
    if (selectedWorldRunId) url.searchParams.set('world', selectedWorldRunId)
    else url.searchParams.delete('world')
    if (selectedAgentsRoomId && agentsVisible) url.searchParams.set('agents', selectedAgentsRoomId)
    else url.searchParams.delete('agents')
    history.replaceState(null, '', url)
  }

  // People and direct chat (Agents' people Capabilities). One session per page,
  // made the first time a Run is open and Agents publishes people; it lives
  // across Run switches, so an open chat stays open. Its failures stay inside
  // the control: they never reach this page's error banner.
  const peopleAvailable = $derived(capabilities.some(capability => capability.id === PEOPLE_SYNC_CAPABILITY_ID))
  let people = $state.raw<PeopleSession | null>(null)
  let peopleState = $state.raw<PeopleState | null>(null)
  let peopleControl = $state<ReturnType<typeof PeopleControl> | null>(null)
  let worldPane = $state<HTMLElement | null>(null)
  let chatFocusRequest = $state(0)
  const peopleShown = $derived(people !== null && peopleState !== null && peopleAvailable && selectedWorldResource !== undefined)
  const peopleRunUrl = $derived(workspace && selectedWorldRunId ? `${location.origin}${workspaceUrl(workspace.id, { world: selectedWorldRunId })}` : '')
  $effect(() => {
    if (people !== null || !workspace || !peopleAvailable || !selectedWorldResource) return
    const workspaceId = workspace.id
    untrack(() => {
      const session = createPeopleSession({ workspaceId, ports: browserPeoplePorts() })
      peopleState = session.state()
      session.subscribe(state => { peopleState = state })
      people = session
    })
  })
  $effect(() => {
    const viewing = peopleAvailable ? selectedWorldResource?.ref ?? null : null
    const session = people
    untrack(() => session?.setViewing(viewing))
  })
  onDestroy(() => people?.dispose())
  const openPeopleChat = (person: PersonWire): void => {
    people?.openChat(person)
    chatFocusRequest += 1
  }
  const closePeopleChat = (): void => {
    people?.closeChat()
    peopleControl?.focusTrigger()
  }

  $effect(() => {
    // "(3) PWR 4-loop · Leitbild.ai": unread direct messages lead the title while a Run is open.
    document.title = withUnreadCount(pageTitle, peopleState?.active ? peopleState.unreadTotal : 0)
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
      normalizeOpenSelection(resources, resourceResponse.modules)
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
    // An open Run or conversation that no longer exists (deleted here or elsewhere) closes.
    const openRun = selectedWorldRunId
    normalizeOpenSelection(resources, response.modules)
    if (openRun !== null && selectedWorldRunId === null) error = 'The simulation you had open was deleted.'
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
      const workspaceId = encodeURIComponent(currentPage.id)
      await Promise.all([
        request<{ workspace: Workspace }>(`/api/workspaces/${workspaceId}`).then(response => {
          workspace = response.workspace
          // Opening a Workspace adds it to "Recent in this browser"; it never becomes the default (rule 6).
          memory.visited(response.workspace.id)
        }),
        loadWorkspaceCatalog(currentPage.id),
      ])
    } catch (cause) {
      const plain = plainError(cause)
      console.error(errorDiagnostic(cause))
      // A Workspace that no longer exists stops being a launch default or a Recent entry.
      if (plain.code === 'workspace_not_found') memory.forget(currentPage.id)
      error = plain.text
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

  // The featured list needs no Workspace runtime; it is read once, when the home first shows.
  let featuredRequested = false
  $effect(() => {
    if (workspace && !showingComposer && !featuredRequested) {
      featuredRequested = true
      void loadFeatured()
    }
  })
  const loadFeatured = async (): Promise<void> => {
    try {
      featuredCatalog = await readFeaturedCatalogue((input, init) => fetch(input, init))
      featuredFailed = false
    } catch (cause) {
      console.error('Featured Definitions are unavailable', cause)
      featuredFailed = true
    }
  }

  const featuredKey = (card: FeaturedCard): string => `featured:${card.definition.ref.moduleId}:${card.definition.ref.type}:${card.definition.ref.id}`
  const definitionKey = (definition: ModuleDefinitionDescriptor): string => `definition:${definition.ref.moduleId}:${definition.ref.type}:${definition.ref.id}`

  // Start from the Workspace page (plan v2 §5.3 steps 4–7): the runner shows each
  // step; arriving opens what was created and makes this Workspace the default.
  const startFrom = async (target: StartTarget): Promise<void> => {
    if (!workspace) return
    const result = await startRunner.start(target)
    if (result === null) return
    if (result.destination !== null) {
      memory.remember(workspace.id, 'launched')
      location.assign(result.destination)
      return
    }
    startRunner.cancel()
    await run(() => loadWorkspaceCatalog(workspace!.id))
  }
  const startFeatured = (card: FeaturedCard): void => {
    if (!workspace) return
    void startFrom({ key: featuredKey(card), workspaceId: workspace.id, definition: card.definition.ref, revisionId: featuredStartRevision(card), featured: true })
  }
  const startDefinition = (definition: ModuleDefinitionDescriptor): void => {
    if (!workspace) return
    void startFrom({ key: definitionKey(definition), workspaceId: workspace.id, definition: definition.ref })
  }
  const retryStart = async (): Promise<void> => {
    const result = await startRunner.retry()
    if (result === null || !workspace) return
    if (result.destination !== null) {
      memory.remember(workspace.id, 'launched')
      location.assign(result.destination)
      return
    }
    startRunner.cancel()
    await run(() => loadWorkspaceCatalog(workspace!.id))
  }
  const reloadAfterStart = (): void => {
    startRunner.dismiss()
    if (workspace) void run(() => loadWorkspaceCatalog(workspace!.id))
  }
  const openEditor = async (path: string, subject: WorkspaceSubjectReference | null): Promise<void> => {
    scenarioEditorSubject = subject
    scenarioEditorPath = path
    await tick()
    scenarioEditorFrame?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }
  const workspaceDeleted = (): void => {
    if (workspace) memory.forget(workspace.id)
    location.assign('/workspaces')
  }

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

  const switchWorldRun = (runId: string, replace = false): void => {
    selectedWorldRunId = runId
    const nextRun = resources.find(candidate => candidate.ref.type === 'world.simulation-run' && candidate.ref.id === runId)
    if (selectedAgentsResource && nextRun && !roomServesRun(selectedAgentsResource, nextRun)) {
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

  // The process display window opens a chat display's Run beside the chat only
  // when this Workspace lists it, reading the catalog again on a miss (an agent
  // may just have started the Run), and when the shown room's scope contains it,
  // so opening the Run never closes the chat the display was opened from.
  const runRefusal = async (run: WorkspaceResourceReference): Promise<string | null> => {
    const listed = (): ModuleResourceDescriptor | undefined =>
      resources.find(resource => resource.ref.type === 'world.simulation-run' && sameResource(resource.ref, run))
    if (listed() === undefined && workspace) await refreshResources(workspace.id)
    const found = listed()
    if (found === undefined) return 'The display\'s Run is not in this Workspace'
    if (selectedAgentsResource && runDeclaresRoles(found)) {
      return 'The display\'s Run has roles, so it offers no Assistant beside it; open the Run to see the display'
    }
    if (selectedAgentsResource && !roomSelectsRun(selectedAgentsResource, found)) {
      return 'The display\'s Run is outside this room\'s scope; open the Run to see the display'
    }
    return null
  }

  // The open Run was deleted: its address is replaced, so Back does not return to it.
  const closeWorldRun = (): void => {
    location.replace(workspace ? `/workspaces/${encodeURIComponent(workspace.id)}` : '/workspaces')
  }

  const restoreUrlSelection = (): void => {
    const selection = new URLSearchParams(location.search)
    selectedWorldRunId = selection.get('world')
    selectedAgentsRoomId = selection.get('agents')
    agentsVisible = selectedAgentsRoomId !== null
    // Back to a Run or conversation deleted since is the Workspace page, not a dead view.
    if (!loading) normalizeOpenSelection(resources, resourceOutcomes)
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
    // Asking the Assistant here makes this Workspace the default (rule 6).
    memory.remember(workspace.id, 'asked')
    selectedAgentsRoomId = response.result.resource.id
    selectedWorldRunId = null
    agentsVisible = true
    const url = new URL(location.href)
    url.searchParams.set('agents', response.result.resource.id)
    url.searchParams.delete('world')
    history.pushState(null, '', url)
    void refreshResources(workspace.id).catch(cause => { refreshError = String(cause) })
  }
  // A Run offers its Assistant where it belongs to a run family, Agents
  // publishes the Assistant and the Run declares no roles; its World page then
  // offers it too.
  const runAssistantAvailable = $derived(workspace !== null && selectedWorldResource !== undefined && selectedRunFamily !== undefined
    && assistantCapability !== undefined && !runDeclaresRoles(selectedWorldResource))
  // Shows the shown Run's Assistant room: the room shown when it serves the
  // Run, else one that does, else a family room whose scope is widened to the
  // Run, else a new one. It never hides the room, so the World page may ask
  // for it as often as it likes.
  // One open at a time, whoever asks (the toolbar launcher or a World page): a second click
  // while the first is still finding or creating the room waits for it, so no second room is made.
  let runAssistantOpening: Promise<void> | null = null
  const openRunAssistant = (): Promise<void> => {
    runAssistantOpening ??= openRunAssistantRoom().finally(() => { runAssistantOpening = null })
    return runAssistantOpening
  }
  const openRunAssistantRoom = async (): Promise<void> => {
    if (!runAssistantAvailable || !workspace || !selectedWorldResource || !selectedRunFamily || !assistantCapability) {
      throw new Error('Run Assistant is unavailable for this Run')
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
  const toggleRunAssistant = async (): Promise<void> => {
    if (!agentsVisible) return openRunAssistant()
    agentsVisible = false
    const url = new URL(location.href)
    url.searchParams.delete('agents')
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
  const summaryValue = (item: ResourceSummaryItem): string =>
    item.kind === 'timestamp' ? ageText(new Date(item.value), new Date(summaryClock)) : String(item.value)
  const refreshInterval = setInterval(() => {
    summaryClock = Date.now()
    if (workspace && !showingComposer) {
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

{#if showingComposer && !workspace}
  <header class="workspace-bar"><div class="workspace-identity"><Wordmark href="/workspaces" tone="dark" label="Leitbild.ai home" /></div></header>
{:else if showingComposer && workspace}
  <header class="workspace-bar">
    <div class="workspace-identity"><Wordmark href="/workspaces" tone="dark" compact label="Leitbild.ai home" /><a class="workspace-name" href={workspacePath(workspace.id)} title={workspaceTitle}><span>{workspaceTitle}</span></a>
      {#if peopleShown && people && peopleState && selectedWorldResource}<PeopleControl bind:this={peopleControl} session={people} people={peopleState}
        runUrl={peopleRunUrl} runId={selectedWorldResource.ref.id} onOpenChat={openPeopleChat} />{/if}
      {#if fromGuide}<a class="guide-back" href={guideHref('ask')}>← Getting started</a>{/if}</div>
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
        {#if agentsVisible && selectedRunFamily && !runDeclaresRoles(selectedWorldResource)}
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
        {#if !runDeclaresRoles(selectedWorldResource)}
          <AssistantLauncher disabled={assistantCapability === undefined} toggle={toggleRunAssistant} active={agentsVisible} onError={message => { error = message }} />
        {/if}
      {:else}
        <AssistantLauncher disabled={assistantCapability === undefined} submit={openAssistant} />
      {/if}
      <WikiLink />
    </div>
  </header>
{:else}
  <a class="lb-skip-link" href="#main">Skip to content</a>
  <header class="ws-topbar">
    <Wordmark href="/workspaces" tone="dark" mark label="Leitbild.ai home" />
    <span class="topbar-sep" aria-hidden="true"></span>
    {#if workspace}<WorkspaceSwitcher current={workspace} currentIsPage {memory} />{/if}
    <nav class="ws-nav" aria-label="Main">
      <div class="nav-wide">
        <a class="nav-link" href={guideHref('start')}><Icon name="compass" size={18} /><span>Getting started</span></a>
        <a class="nav-link" href={demosHref()}><Icon name="demos" size={18} /><span>Demos</span></a>
        <a class="nav-link" href="/wiki"><Icon name="book" size={18} /><span class="wiki-text">Wiki</span></a>
      </div>
      <div class="nav-narrow">
        <MoreMenu label="Menu" tone="dark" triggerClass="nav-link nav-menu" items={[
          { label: 'Getting started', icon: 'compass', href: guideHref('start') },
          { label: 'Demos', icon: 'demos', href: demosHref() },
          { label: 'Wiki', icon: 'book', href: '/wiki' },
        ]}>{#snippet trigger()}<Icon name="dots" size={18} /><span>Menu</span>{/snippet}</MoreMenu>
      </div>
      {#if workspace}<AssistantLauncher label="Ask" disabled={assistantCapability === undefined} submit={openAssistant} />{/if}
    </nav>
  </header>
{/if}

<main id="main" tabindex="-1" class:workspace-main={showingComposer} class:ws-page={!showingComposer}>
  {#if loading}
    <section class="notice">Loading Workspace…</section>
  {:else if error && !workspace}
    <section class="notice error"><h1>Workspace unavailable</h1><p>{error}</p><a href="/workspaces">Back to Workspaces</a></section>
  {:else if workspace}
    {#each workspace.modules as moduleState (moduleState.moduleId)}
      {#if moduleState.status !== 'ready'}
        <section class="notice error" role="alert"><p>{moduleTitle(moduleState.moduleId)}: {moduleState.failure?.message ?? moduleState.status}</p>
          {#if moduleState.status === 'provision_failed'}<button disabled={busy} onclick={() => void retryModule(moduleState.moduleId)}>Retry setup</button>{/if}
          {#if moduleState.status === 'remove_failed' || moduleState.status === 'removing'}<span>Deleting this Workspace did not finish. Use ⋯ → Delete Workspace… to try again.</span>{/if}
        </section>
      {/if}
    {/each}
    {#each catalogFailures as outcome (outcome.moduleId)}{#if outcome.status === 'failed'}<p class="notice error" role="alert">{moduleTitle(outcome.moduleId)}: {outcome.failure.message}</p>{/if}{/each}
    {#if refreshError}<p class="notice error" role="alert">Catalog refresh failed: {refreshError}</p>{/if}
    {#if showingComposer}
    <WorkspaceComposer workspaceId={workspace.id} worldRunId={selectedWorldRunId} {focusedSubjects} agentsRoomId={selectedAgentsRoomId} {agentsVisible} onShowAgents={showRunAssistant}
      {runRefusal} onOpenRun={runId => switchWorldRun(runId)} {runAssistantAvailable} onOpenRunAssistant={openRunAssistant}
      onError={message => { error = message }} bind:worldPane />
    {#if peopleShown && people && peopleState?.chat}<PeopleChat session={people} chat={peopleState.chat} notice={peopleState.notice} outboxSaved={peopleState.outboxSaved} anchor={worldPane}
      focusRequest={chatFocusRequest} onClose={closePeopleChat} />{/if}
    {:else}
      <div class="ws-home">
        <WorkspaceHeader {workspace} {admin} onrenamed={updated => { workspace = updated }} ondeleted={workspaceDeleted} />
        {#if error}<p class="notice error" role="alert">{error}</p>{/if}
        <p class="visually-hidden" role="status">{startAnnouncement(startState)}</p>
        <ContinueList items={continuing} workspaceId={workspace.id} {capabilities} {summaryValue} inspecting={inspectionLoading}
          oninspect={resource => void inspect({ kind: 'resource', descriptor: resource })}
          onrename={(resource, name, original) => renameResource(resource, name, original)}
          onremoved={() => refreshResources(workspace!.id).catch(cause => { refreshError = String(cause) })} />
        <FeaturedRow cards={demos.cards} unavailable={featuredFailed || demos.unavailable.length > 0} start={startState} keyOf={featuredKey}
          onstart={startFeatured} onretry={() => void retryStart()} ondismiss={() => startRunner.dismiss()} oncancel={() => startRunner.cancel()} onreload={reloadAfterStart} />
        <DefinitionCatalog definitions={demos.others} listed={featuredCatalog?.listed ?? []} {capabilities} workspaceId={workspace.id} start={startState} keyOf={definitionKey} inspecting={inspectionLoading}
          onstart={startDefinition} onretry={() => void retryStart()} ondismiss={() => startRunner.dismiss()} oncancel={() => startRunner.cancel()} onreload={reloadAfterStart}
          onedit={definition => { if (definition.uiPath) void openEditor(definition.uiPath, { ...definition.ref, revisionId: definition.currentRevisionId }) }}
          oninspect={definition => void inspect({ kind: 'definition', descriptor: definition })}
          onremoved={() => loadWorkspaceCatalog(workspace!.id).catch(cause => { error = plainErrorText(cause) })} />
        {#if scenarioEditorPath}
          <section class="scenario-builder-frame" aria-label="Scenario editor"><button class="builder-close" type="button" onclick={() => { if (!scenarioEditorDirty || confirm('Discard unsaved scenario changes?')) { scenarioEditorPath = null; scenarioEditorSubject = null; scenarioEditorDirty = false } }}>Close editor</button><iframe bind:this={scenarioEditorFrame} title="World Scenario Editor" src={`${scenarioEditorPath}${scenarioEditorPath.includes('?') ? '&' : '?'}embed=1`}></iframe></section>
        {:else}
          <section class="build" aria-labelledby="build-heading">
            <span class="build-icon" aria-hidden="true"><Icon name="edit" size={18} /></span>
            <div><h2 id="build-heading">Build your own scenario</h2><p>Pick World Packs, place assets on the map and save it as a reusable scenario.</p></div>
            <button class="lb-btn" type="button" onclick={() => { if (workspace) void openEditor(`/workspaces/${encodeURIComponent(workspace.id)}/world/scenarios/new`, null) }}>Open editor</button>
          </section>
        {/if}
      </div>
    {/if}

    {#if error && showingComposer}<p class="workspace-error" role="alert">{error}<button type="button" aria-label="Dismiss" onclick={() => { error = null }}>×</button></p>{/if}
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

<style>
  /* Workspace page top bar (plan v2 §2; VISUAL-SPEC §3.2). The Run view keeps its 42 px .workspace-bar. */
  .ws-topbar { position: sticky; top: 0; z-index: 20; min-height: var(--lb-topbar-h); padding: 0 var(--lb-gutter); display: flex; align-items: center; gap: 12px;
    color: var(--lb-on-dark); background: var(--lb-brand-900); border-bottom: 1px solid #0d150f; }
  .topbar-sep { flex: none; width: 1px; height: 24px; background: var(--lb-on-dark-line); }
  .ws-nav { margin-left: auto; display: flex; align-items: center; gap: 4px; }
  .nav-wide { display: flex; align-items: center; gap: 2px; }
  .nav-narrow { display: none; }
  .ws-topbar :global(.nav-link) { display: inline-flex; align-items: center; gap: 8px; min-height: 40px; padding: 0 10px; border: 0; border-radius: var(--lb-r-sm);
    color: var(--lb-on-dark); background: transparent; font-size: .875rem; font-weight: 550; text-decoration: none; white-space: nowrap; cursor: pointer; }
  .ws-topbar :global(.nav-link:hover) { background: rgba(255, 255, 255, .08); }
  .ws-topbar :global(.nav-link:focus-visible) { outline: 2px solid var(--lb-focus-on-dark); outline-offset: 2px; }
  .ws-topbar :global(.nav-link .lb-icon) { color: var(--lb-on-dark-2); }
  .ws-topbar :global(.assistant-launch.labelled) { margin-left: 6px; }
  @media (max-width: 1023px) {
    .wiki-text { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  }
  @media (max-width: 699px) {
    .ws-topbar { gap: 8px; min-height: 52px; }
    .topbar-sep { display: none; }
    .nav-wide { display: none; }
    .nav-narrow { display: block; }
  }
  @media (pointer: coarse) { .ws-topbar :global(.nav-link) { min-height: 44px; } }

  /* A crowded Run bar gives way in order, so nothing overlaps: first the Workspace name
     ellipsises down to four letters, never further, as it is the way back to the Workspace
     page; then the Run's title; then, at 760 px and below, the Run's controls scroll
     sideways in their own strip (SimulationRunControls.svelte). The identity never gets
     narrower than its mark, those letters and the people control (the name's grid column
     has no minimum, so the name adds only its four letters to that), its shrink weight
     makes it give way before the Run's controls, and no other control in the bar shrinks. */
  .workspace-identity { min-width: auto; flex-shrink: 100; }
  .workspace-name { display: grid; grid-template-columns: minmax(0, auto); min-width: 4ch; }
  .workspace-name > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .workspace-actions > :global(:not(.run-controls)) { flex-shrink: 0; }
  .guide-back { flex: none; color: #aebbb0; font-size: .78rem; text-decoration: none; white-space: nowrap; }
  .guide-back:hover { color: white; }
  .guide-back:focus-visible { outline: 2px solid var(--lb-focus-on-dark); outline-offset: 2px; border-radius: 4px; }

  /* Workspace page body (plan v2 §6): 28 px from the bar, sections 36 px apart. */
  main.ws-page { width: 100%; max-width: calc(1200px + 2 * var(--lb-gutter)); margin: 0 auto; padding: 28px var(--lb-gutter) 64px; }
  main:focus { outline: none; }
  .ws-home { display: grid; gap: 36px; min-width: 0; }
  .ws-home > :global(*) { min-width: 0; }
  .build { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--lb-s4); padding: 16px 20px;
    border: 1px dashed var(--lb-line-strong); border-radius: var(--lb-r-lg); background: rgba(255, 255, 255, .5); }
  .build-icon { display: grid; place-items: center; width: 40px; height: 40px; border-radius: var(--lb-r-md); color: var(--lb-brand-600); background: var(--lb-brand-50); }
  .build h2 { margin: 0 0 2px; font-size: .9375rem; font-weight: 700; }
  .build p { margin: 0; color: var(--lb-ink-3); font-size: var(--lb-fs-small); line-height: 1.45; }
  @media (max-width: 699px) {
    .ws-home { gap: 28px; }
    .build { grid-template-columns: minmax(0, 1fr); }
    .build-icon { display: none; }
  }
</style>
