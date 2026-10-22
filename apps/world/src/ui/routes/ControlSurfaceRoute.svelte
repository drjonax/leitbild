<script lang="ts">
  import { packDataChangedSchema } from '../../core/packs/protocol.ts'
  import type { MapFocusTarget, MapView } from '../map-view.ts'
  import type { EmbeddedViewListing } from '@leitbild/contracts'
  import type { Component } from 'svelte'
  import { tick, untrack } from 'svelte'
  import type {
    GeoJsonPoint,
    IsoTimestamp,
    OperationalObject,
    SimulationRunId,
    ObjectId,
    ProcedureDocument,
    ProcedureRunId,
    ProcedureRunScope,
    ProcedureRunState,
    CompiledScenario,
    RunRoles,
    ScenarioExecutionState,
    SimulationClockState,
  } from '../../core/model/index.ts'
  import { deleteObjectCommandKind, roleClassForRoleSet, runRolesOf, viewerForRoleSet } from '../../core/model/index.ts'
  import { createPackPresentationComposer } from '../../core/packs/presentation-composer.ts'
  import type { PackCreateObjectType, PackMapAssignmentMode, PackMapAssignmentTarget, PackMapFeatureQuery, PackObjectPresentation, PackObjectPresentationTier, PackObjectStatusPresentation, PackPresentationContribution, PackProcedureContribution, PackSurfacePanelContribution, PackTargetContext, PackTargetPreview } from '../../core/packs/protocol.ts'
  import type { PackLiveMapLayerBinding } from '../map-runtime/pack-live-layer.ts'
  import type { ActivePackViews } from '../../core/packs/active-views.ts'
  import {
    fetchScenario,
    joinSimulationRun as joinSimulationRunClient,
    resetSimulationRun,
    invokeSimulationRunCapability,
    querySimulationRunCapability,
    fetchRunExecution,
    fetchRunPresence,
    syncSimulationRunSnapshot as syncSimulationRunSnapshotClient,
    worldApiErrorCode,
  } from '../simulation-run-client.ts'
  import {
    parseControlSurfaceRoute,
  } from '../simulation-run-route.ts'
  import {
    applySimulationRunEventBatchMessage,
  } from '../simulation-run-events.ts'
  import RoleBar from '../roles/RoleBar.svelte'
  import RoleDialog from '../roles/RoleDialog.svelte'
  import { roleSetText, type RoleCommandsDescriber, type RoleSetChange } from '../roles/role-controller.ts'
  import { hiddenOnceHeld, roleDialogChange, seenRoleIdsFor, type RoleDialogResult } from '../roles/role-dialog.ts'
  import { perspectiveKey, storesForPerspective, type RealtimePerspective } from '../roles/perspective.ts'
  import { configureActiveRoleSet, currentActiveRoleSet, hiddenRolesStorageKey, initialRoleSet, readStoredHiddenRoles, roleSetFromSearch, roleSetStorageKey, searchWithRoleSet, writeStoredHiddenRoles, writeStoredRoleSet } from '../roles/role-session.ts'
  import { beginAction, completeAction, commandFeedbackText, emptyCommandFeedback, failAction, noteAction, settleCommand, type CommandFeedback } from '../command-feedback.ts'
  import { parseDroneMotionFramesRealtimeMessage, type DroneMotionFrame } from '../../packs/drone/realtime.ts'
  import { createMapFeatureLoader } from '../app/map-feature-loader.ts'
  import { installPlacementGlobalEvents } from '../app/placement-global-events.ts'
  import { createRealtimeConnectionController } from '../app/realtime-connection.ts'
  import { completeControlSurfaceStartupFromSnapshot } from '../app/control-surface-session.ts'
  import { startupScenarioSource } from '../app/startup-scenario.ts'
  import { loadActivePackViews } from '../pack-loader.ts'
  import { groundClicksWanted, previewObjectTarget, routeGroundClick, routeObjectClick, targetPickingWanted, targetPreviewsWanted, type MapClickContext, type MapClickRoute, type MapTargetPanel } from '../map-target-routing.ts'
  import { assertMapCover, assertPanelInteraction, cameraPaddingFor, mapCameraInteractionFor, openPanelDeclaring, railStartsCollapsed, startingControllerId, surfacePanelPackId, type MapCover, type MapPrompt, type SurfacePanelInteraction } from '../surface-panel-interaction.ts'
  import PanelKeyRouter from '../keys/PanelKeyRouter.svelte'
  import type { PanelKey } from '../keys/panel-key.ts'
  import {
    categoryRowsFor,
    placementCursorFor,
    selectedControllerObjectFor,
  } from '../control-surface-selectors.ts'
  import { createPlacementState } from '../placement-state.svelte.ts'
  import { createRailLayoutState } from '../rail-layout-state.svelte.ts'
  import { simulationTimeAt } from '../simulation-clock.ts'
  import { createWorldClockOrder, executionClockReading } from '../world-clock.ts'
  import { runOnMount } from '../svelte-lifecycle.svelte.ts'
  import ControlRail from '../ControlRail.svelte'
  import ScenarioGuidance from '../ScenarioGuidance.svelte'
  import WorldStatusLine from '../WorldStatusLine.svelte'
  import AlertStrip from '../displays/AlertStrip.svelte'
  import StartupModal from '../StartupModal.svelte'
  import { processPlantIdForObject } from '../../packs/process-plant/model.ts'
  import type { ProcessPlantArtifactKind } from '../../packs/process-plant/ui/plant-client.ts'
  import { observedAssetsOf, packObserves, type DeckRunJoin, type DisplayWindowRequest, type DisplayWindowTarget } from '../process-display/display-deck.ts'
  import { displayWindowReadyMessage, readDisplayWindowHostMessage } from '../process-display/display-window-messages.ts'
  import PlantCard, { type PlantCardAction } from '../../packs/process-plant/ui/PlantCard.svelte'
  import { plantCardView } from '../../packs/process-plant/ui/plant-card.ts'
  import { processPlantPackId } from '../../packs/process-plant/model.ts'
  import type { MapCardFrame } from '../map/object-card-anchor.ts'
  import { readRunAssistantOffer, requestRunAssistant } from '../run-assistant-messages.ts'
  import { createProcedureSession, type ProcedureSession } from '../procedures/procedure-session.ts'
  import {
    procedureAiStartedRunIds,
    procedureAiStartsRead,
    procedureWindowsShowingAiStart,
    type ProcedureSystemWindowEntry,
  } from '../procedures/procedure-follow.ts'
  import {
    procedureRunSummariesForScope,
    type ProcedureRunSummary,
    type ProcedureRunSummaryGroup,
  } from '../procedures/procedure-run-selectors.ts'
  import type { StatusTone } from '../components/StatusDot.svelte'
  import {
    categoryRowsForStartingView,
  } from '../starting-view.ts'
  import { getTheme, initialTheme, toggleTheme as toggleThemeMode, type ThemeMode } from '../theme.ts'
  import {
    completeStartupStep,
    createStartupSteps,
    failStartupStep,
    resetStartupStepsAfter,
    setStartupStepDetails,
    startupHasFailed,
    startupIsReady,
    startupModalShouldShow,
    startStartupStep,
    type StartupStep,
    type StartupStepId,
  } from '../startup.ts'
  import { runtimeDiagnosticDetails } from '../map-runtime/map-diagnostics.ts'
  import { mapPerformanceDiagnostics } from '../map-runtime/map-performance-diagnostics.ts'
  import type { MapFocusRequest, MapRuntimeDiagnosticsSnapshot } from '../map-runtime/types.ts'
  import {
    browserDiagnostics,
    clearCapabilityQueryDiagnostics,
    createLongTaskDiagnosticsMonitor,
    installInternalDiagnosticsGlobal,
    capabilityQueryDiagnostics,
    resourceDiagnostics,
    routeDiagnostics,
    scenarioDiagnosticsFor,
    type InternalDiagnosticsSnapshot,
    type LongTaskDiagnosticsMonitor,
  } from '../internal-diagnostics.ts'
  import type { CategoryRow, SimulationRunResponse, CreateDraft, RunExecutionState } from '../types.ts'

  const appVersion = __LEITBILD_VERSION__
  const emptyStringArray: ReadonlyArray<string> = []
  const emptyMapLayerGroups: NonNullable<PackPresentationContribution['mapLayerGroups']> = []
  const emptyMapFeatureLayers: NonNullable<PackPresentationContribution['mapFeatureLayers']> = []
  const emptyReferenceStyles: NonNullable<PackPresentationContribution['referenceStyles']> = []
  const emptyMapLegends: NonNullable<PackPresentationContribution['mapLegends']> = []
  const emptyLiveMapLayers: ReadonlyArray<PackLiveMapLayerBinding> = []
  const emptyProcedureRunSummaries: ProcedureRunSummaryGroup = { active: [], inactive: [] }

  interface DroneWindowEntry {
    readonly id: string
    readonly objectId: ObjectId
  }

  type DroneMotionFrameConsumer = (frames: ReadonlyArray<DroneMotionFrame>) => void

  interface DroneWindowModel extends DroneWindowEntry {
    readonly object: OperationalObject
    readonly index: number
  }

  interface ProcedureSystemWindowModel extends ProcedureSystemWindowEntry {
    readonly object: OperationalObject
    readonly plantId: string
    readonly provider: PackProcedureContribution
    readonly index: number
  }
  interface MapAssignmentState {
    readonly controllerId: string
    readonly mode: PackMapAssignmentMode
  }
  interface MapAssignmentPicker {
    readonly target: PackMapAssignmentTarget
    readonly x: number
    readonly y: number
  }
  let activePack = $state<ActivePackViews | null>(null)
  let simulationRunId = $state<SimulationRunId | null>(null)
  let objects = $state<OperationalObject[]>([])
  let scenarioState = $state<ScenarioExecutionState | undefined>(undefined)
  let clock = $state<SimulationClockState | undefined>(undefined)
  // Clocks the Run publishes always apply; an execution read's only if none arrived since it was asked for.
  const clockOrder = createWorldClockOrder()
  let scenarioDefinition = $state<CompiledScenario | null>(null)
  let selectedControllerId = $state<string | null>(null)
  let status = $state('Starting')
  let mapWarnings = $state('')
  let commandFeedback = $state.raw<CommandFeedback>(emptyCommandFeedback)
  const routeMode = 'simulation-run'
  let seenRevisions = $state(new Map<string, number>())
  let expectedRealtimeScenarioId = $state<string | null>(null)
  let realtimeAttached = $state(false)
  let routeRevision = $state(0)
  let procedureRevision = $state(0)
  let packDataRevisions = $state<Record<string, number>>({})
  let packPanelSelections = $state<Record<string, string | null>>({})
  // Role Runs only: the role set this screen plays, a switch awaiting its fresh
  // snapshot, the connection's perspective epoch, and the picker shown to a
  // screen that holds no role. A Run without roles leaves all of them empty.
  // Until the Run answers a switch the screen shows, and its requests carry,
  // the held set; it issues no command of its own meanwhile.
  let heldRoleIds = $state<ReadonlyArray<string> | null>(null)
  let pendingRoleIds = $state<ReadonlyArray<string> | null>(null)
  let perspectiveEpoch = $state(0)
  let rolePicker = $state<{ readonly runTitle: string; readonly declaration: RunRoles; readonly holders: Readonly<Record<string, number>> } | null>(null)
  // This tab's unseen roles (the role dialog's See boxes), a display filter no
  // server reads, and whether the role bar opened the dialog.
  let hiddenRoleIds = $state<ReadonlyArray<string>>([])
  let roleDialogOpen = $state(false)
  let panelMapView = $state<MapView | null>(null)
  let startupSteps = $state<ReadonlyArray<StartupStep>>(createStartupSteps())
  let mapReady = $state(false)
  let snapshotReady = $state(false)
  let startupDismissed = $state(false)
  let startupStatusModalOpen = $state(false)
  let settingsModalOpen = $state(false)
  let executionState = $state<RunExecutionState | null>(null)
  let OperationalMap = $state<Component | null>(null)
  let CreateObjectModal = $state<Component | null>(null)
  let SettingsModal = $state<Component | null>(null)
  let DisplayWindow = $state<Component | null>(null)
  let surfacePanelComponents = $state<Record<string, Component>>({})
  let ProcedureSystemModal = $state<Component | null>(null)
  let ProcessPlantArtifactModal = $state<Component | null>(null)
  let ProcessPlantCatalogModal = $state<Component | null>(null)
  let ProcessPlantCredibilityModal = $state<Component | null>(null)
  let DroneControlModal = $state<Component | null>(null)
  let DroneProfileEditorModal = $state<Component | null>(null)
  // The one process display window. The Host relays the conversation's
  // displays and requests to open one; both are kept here from the start, so
  // nothing is lost while the window's code or the Run is still loading. The
  // window needs only the Run named in the address: a display samples its Run
  // itself, so it shows while this page still opens the Run, or after that
  // failed (the window says why its Plant controls are off), and a display of
  // another Run needs nothing from this one.
  let displayWindowRunId = $state<SimulationRunId | null>(null)
  let displayWindowOpen = $state(false)
  // The Plant card a click on a unit's icon or rail row opened, and the rail row that opened it, which Esc gives focus back to.
  let plantCard = $state<{ readonly objectId: ObjectId; readonly opener: HTMLElement | null } | null>(null)
  let plantCardFrame = $state.raw<MapCardFrame | null>(null)
  // Whether the Host offers the Run's Assistant room on this page (`run-assistant-messages.ts`).
  let runAssistantOffered = $state(false)
  let displayWindowRequest = $state.raw<DisplayWindowRequest | null>(null)
  let conversationDisplays = $state.raw<ReadonlyArray<EmbeddedViewListing>>([])
  let displayWindowRequestSequence = 0
  let displayWindowReturnFocus: HTMLElement | null = null
  let droneControlWindows = $state<ReadonlyArray<DroneWindowEntry>>([])
  let droneProfileEditorWindows = $state<ReadonlyArray<DroneWindowEntry>>([])
  let procedureSystemWindows = $state<ReadonlyArray<ProcedureSystemWindowEntry>>([])
  let floatingWindowSequence = 0
  let procedureSession = $state<ProcedureSession | null>(null)
  let procedureRuns = $state<ReadonlyArray<ProcedureRunState>>([])
  let procedureRunDocuments = $state<ReadonlyMap<string, ProcedureDocument>>(new Map())
  /** Runs AI agents started or resumed live, awaiting the Run read that holds them. */
  const aiStartedProcedureRunIds = new Set<ProcedureRunId>()
  let processPlantArtifactModal = $state<{
    readonly object: OperationalObject
    readonly artifact: ProcessPlantArtifactKind
  } | null>(null)
  let processPlantCatalogModal = $state<OperationalObject | null>(null)
  let processPlantCredibilityModal = $state<OperationalObject | null>(null)
  let theme = $state<ThemeMode>('light')
  let weatherLayerVisible = $state(true)
  let surfaceLoadGeneration = 0
  let operationalMapLoadPromise: Promise<Component> | null = null
  let displayWindowLoadPromise: Promise<Component> | null = null
  const surfacePanelLoadPromises = new Map<string, Promise<Component>>()
  let surfacePanelOpen = $state<Record<string, boolean>>({})
  let appliedSurfacePanelKey = ''
  let procedureSystemModalLoadPromise: Promise<Component> | null = null
  let processPlantArtifactModalLoadPromise: Promise<Component> | null = null
  let processPlantCatalogModalLoadPromise: Promise<Component> | null = null
  let processPlantCredibilityModalLoadPromise: Promise<Component> | null = null
  let droneControlModalLoadPromise: Promise<Component> | null = null
  let droneProfileEditorModalLoadPromise: Promise<Component> | null = null
  let pendingRealtimeSimulationRunId = $state<SimulationRunId | null>(null)
  let postReadyPreloadStarted = false
  let startupAutoDismissTimer: number | null = null
  let startupDebugGeneration = 0
  let startupDebugReported = false
  let startupDebugMarks: Array<{ readonly label: string; readonly atMs: number; readonly deltaMs: number }> = []
  let latestMapRuntimeDiagnostics = $state<MapRuntimeDiagnosticsSnapshot | null>(null)
  let mapFocusRequest = $state<MapFocusRequest | null>(null)
  let mapFocusRevision = 0
  let mapAssignment = $state<MapAssignmentState | null>(null)
  let mapAssignmentPicker = $state<MapAssignmentPicker | null>(null)
  let mapAssignmentChoiceIds = $state<ReadonlyArray<string>>([])
  let longTaskMonitor: LongTaskDiagnosticsMonitor | null = null
  let latestDroneMotionFrames: ReadonlyArray<DroneMotionFrame> = []
  const droneMotionFrameConsumers = new Set<DroneMotionFrameConsumer>()
  const realtimeConnection = createRealtimeConnectionController()
  const railLayout = createRailLayoutState()
  const placement = createPlacementState({
    packId: 'leitbild-control',
    defaultName: (type) => defaultName(type),
    setCommandStatus: (nextStatus) => {
      commandFeedback = noteAction(commandFeedback, nextStatus)
    },
  })
  const placementMode = $derived(placement.mode)
  const placementPoints = $derived(placement.points)
  const createDraft = $derived(placement.draft)
  // Targeting acts as the screen's role view, from the role set its connection holds.
  const targetContextFor = (list: ReadonlyArray<OperationalObject>): PackTargetContext => {
    const declaration = scenarioDefinition ? runRolesOf(scenarioDefinition) : null
    return declaration !== null && heldRoleIds !== null ? { objects: list, viewer: viewerForRoleSet(declaration, heldRoleIds) } : { objects: list }
  }
  const targetContext = $derived(targetContextFor(objects))
  // A panel lending its handlers may change which objects its Pack makes controllers, so the selected controller follows them.
  const selectedControllerObject = $derived.by(() => {
    void panelInteractions
    return activePack ? selectedControllerObjectFor(objects, selectedControllerId, activePack, targetContext) : null
  })
  const allCategoryRows = $derived<ReadonlyArray<CategoryRow>>(activePack ? categoryRowsFor(objects, activePack) : [])
  const startingView = $derived(scenarioDefinition?.view ?? null)
  const railConfig = $derived(startingView?.rail ?? null)
  const mapConfig = $derived(startingView?.map ?? null)
  const effectiveMapConfig = $derived(mapConfig === null
    ? null
    : {
        ...mapConfig,
        layers: weatherLayerVisible
          ? mapConfig.layers
          : mapConfig.layers.filter(layer => layer !== 'weather'),
      })
  const mapVisible = $derived(mapConfig !== null)
  /** A Plant has a card, which a click on its icon or rail row opens where the click orders nothing (`map-target-routing.ts`). */
  const opensPlantCard = (object: OperationalObject): boolean => mapReady && object.packId === processPlantPackId
  const railVisible = $derived(railConfig !== null)
  const footerVisible = true
  const guidanceOverlayVisible = true
  // The briefing card's bottom edge, as it last measured itself: the alarm strip starts below it while it shows.
  let guidanceBottom = $state(0)
  let categoryMapVisibility = $state<Record<string, boolean>>({})
  const surfacePanels = $derived(activePack?.surfacePanels ?? [])
  const surfacePanelLaunchers = $derived(surfacePanels.map(panel => ({ id: panel.id, label: panel.label, open: surfacePanelOpen[panel.id] ?? panel.defaultOpen })))
  // Handlers the mounted panels lend the surface; only panels whose contribution declares a hook connect one.
  let panelInteractions = $state.raw<Readonly<Record<string, SurfacePanelInteraction>>>({})
  let panelKeysActive = $state(true)
  // How far each panel last reported reaching over the map; only open panels' reports pad the camera.
  let panelMapCovers = $state.raw<Readonly<Record<string, MapCover>>>({})
  const isSurfacePanelOpen = (panel: PackSurfacePanelContribution): boolean => surfacePanelOpen[panel.id] ?? panel.defaultOpen
  const mapTargetPanelContribution = $derived(openPanelDeclaring(surfacePanels, isSurfacePanelOpen, 'mapTargets'))
  const mapTargetPanel = $derived<MapTargetPanel | null>(mapTargetPanelContribution && activePack
    ? {
        label: mapTargetPanelContribution.label,
        packId: surfacePanelPackId(activePack.packs, mapTargetPanelContribution),
        onMapTarget: panelInteractions[mapTargetPanelContribution.id]?.onMapTarget ?? null,
        previewMapTarget: panelInteractions[mapTargetPanelContribution.id]?.previewMapTarget ?? null,
      }
    : null)
  const keymapPanel = $derived(openPanelDeclaring(surfacePanels, isSurfacePanelOpen, 'keymap'))
  const mapCameraPadding = $derived(cameraPaddingFor(surfacePanels.filter(isSurfacePanelOpen).flatMap(panel => panelMapCovers[panel.id] ?? [])))
  // Each panel's latest map prompt; only the open map-target panel's is drawn.
  let panelMapPrompts = $state.raw<Readonly<Record<string, MapPrompt | null>>>({})
  const mapPrompt = $derived(mapTargetPanelContribution ? panelMapPrompts[mapTargetPanelContribution.id] ?? null : null)
  // A panel lending its handlers may change which objects its Pack lets this screen order, so the muted set follows them.
  const mapMutedObjectIds = $derived.by(() => {
    void panelInteractions
    const mutedOnMap = activePack?.targeting?.mutedOnMap
    return mutedOnMap ? objects.filter(object => mutedOnMap(object, targetContext)).map(object => object.id) : emptyStringArray
  })
  const mapCameraInteraction = $derived(mapCameraInteractionFor(activePack?.packs ?? []))
  const mapClickContext = $derived<MapClickContext>({ controller: selectedControllerObject, targeting: activePack?.targeting, context: targetContext, panel: mapTargetPanel, opensCard: opensPlantCard })
  const mapStartupFailed = $derived(startupSteps.find(step => step.id === 'map')?.status === 'failed')
  const displayRunJoin = $derived.by<DeckRunJoin>(() => {
    if (simulationRunId !== null) return { state: 'joined' }
    const step = startupSteps.find(candidate => candidate.id === 'simulation-run')
    return step?.status === 'failed' ? { state: 'failed', reason: step.error ?? `${step.label} failed` } : { state: 'joining' }
  })
  const richOperationalUiReady = $derived(!mapVisible || mapReady || mapStartupFailed)
  const mapAssignmentController = $derived(mapAssignment ? objects.find(object => object.id === mapAssignment.controllerId) ?? null : null)
  const mapAssignmentContribution = $derived(mapAssignmentController && activePack ? activePack.packForObject(mapAssignmentController).mapAssignment ?? null : null)
  const mapAssignmentAnchor = $derived(mapAssignmentController && mapAssignmentContribution && mapAssignment
    ? mapAssignmentContribution.anchorFor(mapAssignmentController, mapAssignment.mode, targetContext)
    : null)
  const mapAssignmentHandles = $derived(activePack ? activePack.packs.flatMap(pack => pack.mapAssignment?.handles(targetContext) ?? []) : [])
  const debugMapInput = $derived(new URLSearchParams(location.search).get('debugMapInput') === '1')
  const debugStartup = new URLSearchParams(location.search).get('debugStartup') === '1'
  const categoryRows = $derived<ReadonlyArray<CategoryRow>>(categoryRowsForStartingView(allCategoryRows, railConfig))
  const objectById = $derived(new Map(objects.map(object => [object.id, object])))
  const plantCardObject = $derived(plantCard === null ? null : objectById.get(plantCard.objectId) ?? null)
  const mapHighlightedObjectIds = $derived(plantCard === null
    ? scenarioState?.highlightedObjectIds ?? emptyStringArray
    : [...(scenarioState?.highlightedObjectIds ?? emptyStringArray), plantCard.objectId])
  $effect(() => {
    const rows = categoryRows
    untrack(() => {
      const current = categoryMapVisibility
      const next: Record<string, boolean> = {}
      let changed = Object.keys(current).length !== rows.length
      for (const row of rows) {
        const value = current[row.category.id] ?? true
        next[row.category.id] = value
        if (current[row.category.id] === undefined) changed = true
      }
      if (changed) categoryMapVisibility = next
    })
  })
  const hiddenObjectCategoryIds = $derived(
    Object.entries(categoryMapVisibility).flatMap(([categoryId, visible]) => visible ? [] : [categoryId]),
  )
  const placementCursor = $derived(activePack ? placementCursorFor(placementMode, activePack) : null)
  const systemStatusTone = $derived<StatusTone>(
    startupHasFailed(startupSteps) ? 'error' : startupIsReady(startupSteps) ? 'ready' : 'working',
  )
  const startupModalVisible = $derived(rolePicker === null && (startupModalShouldShow({
    routeMode,
    dismissed: startupDismissed,
    steps: startupSteps,
  }) || startupStatusModalOpen))
  const runRoles = $derived(scenarioDefinition ? runRolesOf(scenarioDefinition) : null)
  // A surface panel plays the screen's role set; a role switch remounts it.
  const panelRoleSet = $derived(runRoles !== null && heldRoleIds !== null ? { declaration: runRoles, roleIds: heldRoleIds } : null)
  const describeRoleCommands = $derived.by<RoleCommandsDescriber | undefined>(() => {
    const scenario = scenarioDefinition
    const views = activePack?.packs.flatMap(view => view.roles ? [{ packId: view.descriptor.id, roles: view.roles }] : []) ?? []
    if (!scenario || views.length === 0) return undefined
    return roleId => views.flatMap(({ packId, roles }) => roles.commandsLine(roleId, scenario.packConfigs[packId]) ?? []).join(' · ') || null
  })
  // The roles this screen shows Packs: every declared role but the unseen ones, and always the held ones.
  const seenRoleIds = $derived(runRoles !== null && heldRoleIds !== null ? seenRoleIdsFor(runRoles, heldRoleIds, hiddenRoleIds) : null)
  // Reset, signal and delete are controller acts in a role Run; open mode offers them to everyone.
  const controllerControls = $derived(runRoles === null || (heldRoleIds !== null && roleClassForRoleSet(runRoles, heldRoleIds) === 'controller'))
  // Pack map features belong to one perspective, like every Run store, and are drawn for the roles this tab sees.
  // The map presents objects again when the roles the screen sees change; constant in open mode.
  const mapPresentationKey = $derived(JSON.stringify(seenRoleIds))
  const mapFeatureDataKey = $derived(JSON.stringify([perspectiveEpoch, packDataRevisions, seenRoleIds]))
  // Only while an active Pack draws the selected object differently does a selection change redraw Pack map features.
  const mapFeaturesFollowSelection = $derived(activePack?.presentation.mapFeaturesFollowSelection === true)
  const mapFeatureRevisionKey = $derived(mapFeaturesFollowSelection ? JSON.stringify([mapFeatureDataKey, selectedControllerId]) : mapFeatureDataKey)

  const toggleTheme = (): void => {
    theme = toggleThemeMode()
  }

  const toggleWeatherLayer = (): void => {
    weatherLayerVisible = !weatherLayerVisible
  }

  const setCategoryMapVisibility = (categoryId: string, visible: boolean): void => {
    if ((categoryMapVisibility[categoryId] ?? true) === visible) return
    categoryMapVisibility = {
      ...categoryMapVisibility,
      [categoryId]: visible,
    }
  }

  const toggleCategoryMapVisibility = (categoryId: string): void => {
    setCategoryMapVisibility(categoryId, !(categoryMapVisibility[categoryId] ?? true))
  }

  const setSurfacePanelOpen = (panelId: string, open: boolean): void => {
    surfacePanelOpen = { ...surfacePanelOpen, [panelId]: open }
  }

  const toggleSurfacePanel = (panelId: string): void => {
    const panel = surfacePanels.find(candidate => candidate.id === panelId)
    if (!panel) return
    setSurfacePanelOpen(panelId, !(surfacePanelOpen[panelId] ?? panel.defaultOpen))
  }

  const focusMapTarget = (target: MapFocusTarget): void => {
    mapFocusRevision += 1
    mapFocusRequest = { revision: mapFocusRevision, target }
  }

  // Pack-rail layer-group visibility. Active pack contributes mapLayerGroups
  // (e.g. electric grid: lines, cables, substations); the rail renders
  // toggles and writes here; OperationalMap re-applies on change.
  const activeMapLayerGroups = $derived(activePack?.presentation.mapLayerGroups ?? emptyMapLayerGroups)
  const activePackFeatureLayers = $derived(activePack?.presentation.mapFeatureLayers ?? emptyMapFeatureLayers)
  const activePackFeatureSourcePackIds = $derived(activePack?.mapFeatureSourcePackIds ?? emptyStringArray)
  const activeReferenceDatasetIds = $derived(activePack?.referenceDatasetIds?.map(String) ?? emptyStringArray)
  const activeReferenceStyles = $derived(activePack?.referenceStyles ?? emptyReferenceStyles)
  const activeMapLegends = $derived(activePack?.presentation.mapLegends ?? emptyMapLegends)
  const activeLiveMapLayers = $derived(activePack
    ? activePack.packs.flatMap(pack => (pack.presentation.liveMapLayers ?? []).map(layer => ({ packId: pack.descriptor.id, layer })))
    : emptyLiveMapLayers)
  const queryLiveMapLayer = async (request: PackMapFeatureQuery, signal: AbortSignal): Promise<unknown> => {
    const runId = simulationRunId
    if (!runId) throw new Error('live map layers query a Simulation Run, and none is joined')
    return await querySimulationRunCapability(runId, request.capabilityId, request.input, { signal })
  }
  let mapLayerGroupVisibility = $state<Record<string, boolean>>({})
  // Re-seed when the group list changes. `untrack` keeps the write from
  // re-triggering this effect (a new object literal every time would otherwise
  // loop infinitely and block the event loop).
  $effect(() => {
    const groups = activeMapLayerGroups
    untrack(() => {
      const current = mapLayerGroupVisibility
      const next: Record<string, boolean> = {}
      let changed = Object.keys(current).length !== groups.length
      for (const group of groups) {
        const value = current[group.id] ?? group.defaultVisible
        next[group.id] = value
        if (current[group.id] === undefined) changed = true
      }
      if (changed) mapLayerGroupVisibility = next
    })
  })
  const toggleMapLayerGroup = (groupId: string): void => {
    mapLayerGroupVisibility = {
      ...mapLayerGroupVisibility,
      [groupId]: !(mapLayerGroupVisibility[groupId] ?? activeMapLayerGroups.find(g => g.id === groupId)?.defaultVisible ?? true),
    }
  }

  const currentPackTime = (): IsoTimestamp | undefined =>
    simulationTimeAt(clock)

  const requireActivePack = (): ActivePackViews => {
    if (!activePack) throw new Error('scenario packs are not loaded')
    return activePack
  }

  const presentationComposer = createPackPresentationComposer({
    getContext: () => ({
      pack: activePack,
      objects,
      currentTime: currentPackTime(),
      ...(seenRoleIds === null ? {} : { seenRoleIds }),
    }),
  })

  const presentationFor = (
    object: OperationalObject,
    options: { readonly tier?: PackObjectPresentationTier } = {},
  ): PackObjectPresentation => {
    return presentationComposer.present(object, options)
  }

  const detailPresentationFor = async (object: OperationalObject): Promise<PackObjectPresentation> => {
    const presentation = presentationFor(object, { tier: 'detail' })
    const runId = simulationRunId
    if (!runId) return presentation
    const requests = activePack?.presentation.contextualFieldQueries?.(object) ?? []
    const fields = await Promise.all(requests.map(async request => {
      const result = await invokeSimulationRunCapability(runId, { capabilityId: request.capabilityId, input: request.input })
      return request.toFields(result.result)
    }))
    return { ...presentation, fields: [...presentation.fields, ...fields.flat()] }
  }

  const mapPresentationFor = (object: OperationalObject): PackObjectPresentation =>
    presentationFor(object, { tier: 'map' })

  const statusPresentationFor = (object: OperationalObject): PackObjectStatusPresentation =>
    presentationFor(object).status ?? {
      tone: 'idle',
      label: object.operational.status,
      indicator: { shape: 'dot' },
    }

  const mapFeaturesFor = createMapFeatureLoader({
    pack: () => activePack,
    objects: () => objects,
    simulationRunId: () => simulationRunId,
    currentTime: currentPackTime,
    seenRoleIds: () => seenRoleIds,
    selectedObjectId: () => selectedControllerId,
    dataRevision: () => mapFeatureDataKey,
    onWarnings: messages => { mapWarnings = messages.join(' · ') },
  })

  const hasNewInfo = (object: OperationalObject): boolean => {
    if (!activePack) return false
    const presentation = presentationFor(object)
    if (presentation.noteworthyUpdates !== true) return false
    return (seenRevisions.get(object.id) ?? object.revision) < object.revision
  }

  const markSeen = (object: OperationalObject): void => {
    if ((seenRevisions.get(object.id) ?? -1) >= object.revision) return
    seenRevisions = new Map([...seenRevisions, [object.id, object.revision]])
  }

  const markStartup = (label: string): void => {
    if (!debugStartup) return
    const atMs = performance.now()
    const first = startupDebugMarks[0]?.atMs ?? atMs
    startupDebugMarks = [...startupDebugMarks, { label, atMs, deltaMs: atMs - first }]
    performance.mark(`leitbild-startup:${startupDebugGeneration}:${label}`)
  }

  const resetStartupDebug = (): void => {
    startupDebugGeneration += 1
    startupDebugReported = false
    startupDebugMarks = []
    markStartup('begin')
  }

  const reportStartupDebug = (): void => {
    if (!debugStartup || startupDebugReported) return
    startupDebugReported = true
    console.table(startupDebugMarks.map(mark => ({
      step: mark.label,
      elapsedMs: Number(mark.deltaMs.toFixed(1)),
    })))
  }

  const currentInternalDiagnostics = (): InternalDiagnosticsSnapshot => {
    const currentMapConfig = mapConfig
    const center = currentMapConfig?.center.coordinates
    return {
      capturedAt: new Date().toISOString(),
      appVersion,
      route: routeDiagnostics(),
      browser: browserDiagnostics(),
      startup: {
        status,
        commandStatus: commandFeedbackText(commandFeedback.line),
        dismissed: startupDismissed,
        statusModalOpen: startupStatusModalOpen,
        steps: startupSteps,
        marks: startupDebugMarks,
      },
      simulationRun: {
        id: simulationRunId,
        expectedScenarioId: expectedRealtimeScenarioId,
        snapshotReady,
        realtimeAttached,
        mapReady,
        selectedControllerId,
      },
      scenario: scenarioDiagnosticsFor(scenarioDefinition, objects),
      presentation: presentationComposer.diagnostics(),
      map: {
        visible: mapVisible,
        ready: mapReady,
        config: {
          center: center ? [center[0], center[1]] : null,
          zoom: currentMapConfig?.zoom ?? null,
          layers: currentMapConfig?.layers ?? [],
        },
        layerGroups: activeMapLayerGroups.map(group => ({
          id: group.id,
          visible: mapLayerGroupVisibility[group.id] ?? group.defaultVisible,
        })),
        referenceDatasetIds: activeReferenceDatasetIds,
        runtime: latestMapRuntimeDiagnostics,
      },
      performance: {
        map: mapPerformanceDiagnostics.snapshot(),
        longTasks: longTaskMonitor?.snapshot() ?? {
          supported: false,
          sampleCount: 0,
          worst: null,
          recent: [],
        },
        resources: resourceDiagnostics(),
        capabilityQueries: capabilityQueryDiagnostics(),
      },
    }
  }

  const clearInternalDiagnostics = (): void => {
    mapPerformanceDiagnostics.clear()
    presentationComposer.reset()
    longTaskMonitor?.clear()
    clearCapabilityQueryDiagnostics()
    performance.clearResourceTimings()
  }

  const runWhenIdle = (task: () => void): void => {
    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      window.requestIdleCallback(task, { timeout: 2_000 })
      return
    }
    setTimeout(task, 250)
  }

  const preloadOptionalUiAfterReady = (): void => {
    if (postReadyPreloadStarted) return
    if (mapVisible && !mapReady) return
    const scenario = scenarioDefinition
    if (!scenario?.packs.includes('process-plant')) return
    postReadyPreloadStarted = true
    runWhenIdle(() => {
      void (async (): Promise<void> => {
        try {
          markStartup('process-display-preload:start')
          await loadDisplayWindow()
          markStartup('process-display-preload:done')
        } catch (err) {
          if (debugStartup) console.warn(err)
        }
      })()
    })
  }

  const loadOperationalMap = async (): Promise<Component> => {
    if (OperationalMap) return OperationalMap
    operationalMapLoadPromise ??= (async (): Promise<Component> => {
      const module = await import('../OperationalMap.svelte')
      return module.default
    })()
    try {
      const component = await operationalMapLoadPromise
      OperationalMap = component
      return component
    } catch (err) {
      operationalMapLoadPromise = null
      throw err
    }
  }

  const preloadOperationalMapModule = (): void => {
    if (OperationalMap || operationalMapLoadPromise) return
    markStartup('map-module:preload:start')
    void (async (): Promise<void> => {
      try {
        await loadOperationalMap()
        markStartup('map-module:preload:done')
      } catch (err) {
        if (debugStartup) console.warn('Operational map preload failed:', err)
      }
    })()
  }

  const loadCreateObjectModal = async (): Promise<void> => {
    if (CreateObjectModal) return
    const module = await import('../CreateObjectModal.svelte')
    CreateObjectModal = module.default
  }

  const loadSettingsModal = async (): Promise<void> => {
    if (SettingsModal) return
    const module = await import('../SettingsModal.svelte')
    SettingsModal = module.default
  }

  const loadDisplayWindow = async (): Promise<void> => {
    if (DisplayWindow) return
    displayWindowLoadPromise ??= (async (): Promise<Component> => {
      const module = await import('../process-display/DisplayWindow.svelte')
      return module.default
    })()
    try {
      DisplayWindow = await displayWindowLoadPromise
    } catch (err) {
      displayWindowLoadPromise = null
      throw err
    }
  }

  const loadSurfacePanel = async (panelId: string): Promise<void> => {
    if (surfacePanelComponents[panelId]) return
    const panel = surfacePanels.find(candidate => candidate.id === panelId)
    if (!panel) throw new Error(`unknown Pack surface panel: ${panelId}`)
    let loading = surfacePanelLoadPromises.get(panelId)
    if (!loading) {
      loading = panel.load().then(module => module.default)
      surfacePanelLoadPromises.set(panelId, loading)
    }
    try {
      const component = await loading
      surfacePanelComponents = { ...surfacePanelComponents, [panelId]: component }
    } catch (error) {
      surfacePanelLoadPromises.delete(panelId)
      throw error
    }
  }

  const loadProcedureSystemModal = async (): Promise<void> => {
    if (ProcedureSystemModal) return
    procedureSystemModalLoadPromise ??= (async (): Promise<Component> => {
      const module = await import('../procedures/ProcedureSystemModal.svelte')
      return module.default
    })()
    try {
      ProcedureSystemModal = await procedureSystemModalLoadPromise
    } catch (err) {
      procedureSystemModalLoadPromise = null
      throw err
    }
  }

  const loadProcessPlantArtifactModal = async (): Promise<void> => {
    if (ProcessPlantArtifactModal) return
    processPlantArtifactModalLoadPromise ??= (async (): Promise<Component> => {
      const module = await import('../../packs/process-plant/ui/ProcessPlantArtifactModal.svelte')
      return module.default
    })()
    try {
      ProcessPlantArtifactModal = await processPlantArtifactModalLoadPromise
    } catch (err) {
      processPlantArtifactModalLoadPromise = null
      throw err
    }
  }

  const loadProcessPlantCatalogModal = async (): Promise<void> => {
    if (ProcessPlantCatalogModal) return
    processPlantCatalogModalLoadPromise ??= (async (): Promise<Component> => {
      const module = await import('../../packs/process-plant/ui/ProcessPlantCatalogModal.svelte')
      return module.default
    })()
    try {
      ProcessPlantCatalogModal = await processPlantCatalogModalLoadPromise
    } catch (err) {
      processPlantCatalogModalLoadPromise = null
      throw err
    }
  }

  const loadProcessPlantCredibilityModal = async (): Promise<void> => {
    if (ProcessPlantCredibilityModal) return
    processPlantCredibilityModalLoadPromise ??= (async (): Promise<Component> => {
      const module = await import('../../packs/process-plant/ui/ProcessPlantCredibilityModal.svelte')
      return module.default
    })()
    try {
      ProcessPlantCredibilityModal = await processPlantCredibilityModalLoadPromise
    } catch (err) {
      processPlantCredibilityModalLoadPromise = null
      throw err
    }
  }

  const loadDroneControlModal = async (): Promise<void> => {
    if (DroneControlModal) return
    droneControlModalLoadPromise ??= (async (): Promise<Component> => {
      const module = await import('../drone/DroneControlModal.svelte')
      return module.default
    })()
    try {
      DroneControlModal = await droneControlModalLoadPromise
    } catch (err) {
      droneControlModalLoadPromise = null
      throw err
    }
  }

  const loadDroneProfileEditorModal = async (): Promise<void> => {
    if (DroneProfileEditorModal) return
    droneProfileEditorModalLoadPromise ??= (async (): Promise<Component> => {
      const module = await import('../drone/DroneProfileEditorModal.svelte')
      return module.default
    })()
    try {
      DroneProfileEditorModal = await droneProfileEditorModalLoadPromise
    } catch (err) {
      droneProfileEditorModalLoadPromise = null
      throw err
    }
  }

  const startStep = (id: StartupStepId): void => {
    markStartup(`${id}:start`)
    startupSteps = startStartupStep(startupSteps, id)
  }

  const completeStep = (id: StartupStepId): void => {
    if (startupSteps.find(step => step.id === id)?.status === 'done') return
    markStartup(`${id}:done`)
    startupSteps = completeStartupStep(startupSteps, id)
  }

  const failStep = (id: StartupStepId, err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err)
    markStartup(`${id}:failed`)
    startupSteps = failStartupStep(startupSteps, id, message)
    status = message
  }

  const mapRuntimeDetails = (snapshot: MapRuntimeDiagnosticsSnapshot) => {
    const phases = snapshot.phases.map(phase => ({
      label: phase.phase,
      value: phase.completedAtMs
        ? `${phase.status} · ${((phase.completedAtMs - phase.startedAtMs) / 1000).toFixed(1)}s`
        : phase.status,
    }))
    const details = runtimeDiagnosticDetails(snapshot).slice(0, 12)
    const performanceDetails = snapshot.performance?.summaryDetails.slice(0, 7).map(detail => ({
      label: `Perf ${detail.label}`,
      value: detail.value,
    })) ?? []
    return [
      ...phases,
      ...performanceDetails,
      ...details,
      ...(snapshot.latestError
        ? [{ label: 'Latest error', value: snapshot.latestError.message }]
        : []),
    ]
  }

  const handleMapDiagnostic = (snapshot: MapRuntimeDiagnosticsSnapshot): void => {
    latestMapRuntimeDiagnostics = snapshot
    startupSteps = setStartupStepDetails(startupSteps, 'map', mapRuntimeDetails(snapshot))
  }

  const completeReadyWhenReady = (): void => {
    if (!snapshotReady || !realtimeAttached) return
    if (mapVisible && !mapReady) return
    completeStep('ready')
    reportStartupDebug()
    preloadOptionalUiAfterReady()
  }

  const completeObjectsWhenReady = async (): Promise<void> => {
    if (!snapshotReady) return
    if (mapVisible && !mapReady) return
    await tick()
    completeStep('objects')
    completeReadyWhenReady()
  }

  const loadSurfaceForScenario = async (scenarioId: string): Promise<void> => {
    const generation = ++surfaceLoadGeneration
    const scenario = scenarioDefinition?.id === scenarioId
      ? scenarioDefinition
      : await loadScenarioDefinitionAndPack(scenarioId)
    if (scenario.view.map) {
      mapReady = false
      startStep('map')
      markStartup('map-module:start')
      void (async (): Promise<void> => {
        try {
          await loadOperationalMap()
          if (generation !== surfaceLoadGeneration) return
          markStartup('map-module:done')
        } catch (err) {
          if (generation !== surfaceLoadGeneration) return
          failStep('map', err)
        }
      })()
      return
    }
    OperationalMap = null
    mapReady = false
    completeStep('map')
  }

  const closeStartupModal = (): void => {
    clearStartupAutoDismissTimer()
    startupDismissed = true
    startupStatusModalOpen = false
  }

  const clearStartupAutoDismissTimer = (): void => {
    if (startupAutoDismissTimer === null) return
    window.clearTimeout(startupAutoDismissTimer)
    startupAutoDismissTimer = null
  }

  const openStatusModal = (): void => {
    startupStatusModalOpen = true
  }

  const openSettings = (): void => {
    settingsModalOpen = true
    void loadSettingsModal()
  }

  const refreshExecution = async (): Promise<void> => {
    if (!simulationRunId) return
    try {
      const ticket = clockOrder.readAsked()
      executionState = await fetchRunExecution(simulationRunId)
      const reading = executionClockReading(executionState)
      if (reading && clockOrder.readApplies(ticket)) clock = reading
    } catch (err) {
      status = err instanceof Error ? err.message : String(err)
    }
  }

  const goToStartPage = (): void => {
    window.location.assign('/')
  }

  const nextFloatingWindowId = (prefix: string, objectId: ObjectId): string => {
    floatingWindowSequence += 1
    return `${prefix}:${objectId}:${floatingWindowSequence}`
  }

  const closeDisplayWindow = (): void => {
    displayWindowOpen = false
    displayWindowRequest = null
    const returnFocus = displayWindowReturnFocus
    displayWindowReturnFocus = null
    if (returnFocus?.isConnected) returnFocus.focus()
  }

  // Opened (or jumped) from the rail, the window takes focus and gives it back
  // on close; opened from chat, it leaves focus with the conversation.
  const requestDisplayWindow = (target: DisplayWindowTarget, focus: boolean): void => {
    if (focus) {
      const active = document.activeElement
      displayWindowReturnFocus = active instanceof HTMLElement ? active : null
    } else if (!displayWindowOpen) {
      displayWindowReturnFocus = null
    }
    displayWindowRequestSequence += 1
    displayWindowRequest = { sequence: displayWindowRequestSequence, target, focus }
    displayWindowOpen = true
    void (async (): Promise<void> => {
      try {
        await loadDisplayWindow()
      } catch (err) {
        closeDisplayWindow()
        status = `Could not open the process display window: ${err instanceof Error ? err.message : String(err)}`
      }
    })()
  }

  const openProcessDisplay = (object: OperationalObject): void => {
    if (!observedAssetObjects.some(asset => asset.id === object.id)) return
    requestDisplayWindow({ kind: 'asset', objectId: object.id }, true)
  }

  const openDroneControl = (object: OperationalObject): void => {
    if (object.packId !== 'drone') return
    droneControlWindows = [
      ...droneControlWindows,
      {
        id: nextFloatingWindowId('drone-control', object.id),
        objectId: object.id,
      },
    ]
    void loadDroneControlModal()
  }

  const closeDroneControl = (windowId: string): void => {
    droneControlWindows = droneControlWindows.filter(entry => entry.id !== windowId)
  }

  const openDroneProfileEditor = (object: OperationalObject): void => {
    if (object.packId !== 'drone') return
    droneProfileEditorWindows = [
      ...droneProfileEditorWindows,
      {
        id: nextFloatingWindowId('drone-profile', object.id),
        objectId: object.id,
      },
    ]
    void loadDroneProfileEditorModal()
  }

  const closeDroneProfileEditor = (windowId: string): void => {
    droneProfileEditorWindows = droneProfileEditorWindows.filter(entry => entry.id !== windowId)
  }

  const openProcessPlantArtifact = (object: OperationalObject, artifact: ProcessPlantArtifactKind): void => {
    if (processPlantIdForObject(object) === null) return
    processPlantArtifactModal = { object, artifact }
    void loadProcessPlantArtifactModal()
  }

  const closeProcessPlantArtifact = (): void => {
    processPlantArtifactModal = null
  }

  const openProcessPlantCatalog = (object: OperationalObject): void => {
    if (object.packId !== 'process-plant') return
    processPlantCatalogModal = object
    void loadProcessPlantCatalogModal()
  }

  const closeProcessPlantCatalog = (): void => {
    processPlantCatalogModal = null
  }

  const openProcessPlantCredibility = (object: OperationalObject): void => {
    if (processPlantIdForObject(object) === null) return
    processPlantCredibilityModal = object
    void loadProcessPlantCredibilityModal()
  }

  const closeProcessPlantCredibility = (): void => {
    processPlantCredibilityModal = null
  }

  const procedureUnitContexts = $derived(objects.flatMap(object => {
    const provider = activePack?.packForObject(object).procedures
    const plantId = provider?.scopeIdForObject(object) ?? null
    return plantId === null
      ? []
      : [{
          plantId,
          provider,
          targetObjectId: object.id,
          label: object.label,
          status: statusPresentationFor(object),
        }]
  }))

  // The window steps through the defaults of the assets the Run observes (their Pack declares observations), in
  // rail order; those the rail does not list follow.
  const observedAssetObjects = $derived.by<ReadonlyArray<OperationalObject>>(() => {
    const pack = activePack
    if (pack === null) return []
    return observedAssetsOf(categoryRows.flatMap(row => row.objects), objects, object => packObserves(pack.packForObject(object).descriptor))
  })

  const droneControlWindowModels = $derived<ReadonlyArray<DroneWindowModel>>(
    droneControlWindows.flatMap((entry, index) => {
      const object = objectById.get(entry.objectId)
      return object === undefined ? [] : [{ ...entry, object, index }]
    }),
  )

  const droneProfileEditorWindowModels = $derived<ReadonlyArray<DroneWindowModel>>(
    droneProfileEditorWindows.flatMap((entry, index) => {
      const object = objectById.get(entry.objectId)
      return object === undefined ? [] : [{ ...entry, object, index }]
    }),
  )

  const procedureSystemWindowModels = $derived<ReadonlyArray<ProcedureSystemWindowModel>>(
    procedureSystemWindows.flatMap((entry, index) => {
      const object = objectById.get(entry.objectId)
      if (object === undefined) return []
      const provider = activePack?.packForObject(object).procedures
      const plantId = provider?.scopeIdForObject(object) ?? null
      return plantId === null || provider === undefined ? [] : [{ ...entry, object, plantId, provider, index }]
    }),
  )

  $effect(() => {
    const liveObjectIds = new Set(objects.map(object => object.id))
    untrack(() => {
      const nextDroneControlWindows = droneControlWindows.filter(entry => liveObjectIds.has(entry.objectId))
      if (nextDroneControlWindows.length !== droneControlWindows.length) {
        droneControlWindows = nextDroneControlWindows
      }
      const nextDroneProfileEditorWindows = droneProfileEditorWindows.filter(entry => liveObjectIds.has(entry.objectId))
      if (nextDroneProfileEditorWindows.length !== droneProfileEditorWindows.length) {
        droneProfileEditorWindows = nextDroneProfileEditorWindows
      }
      const nextProcedureSystemWindows = procedureSystemWindows.filter(entry => liveObjectIds.has(entry.objectId))
      if (nextProcedureSystemWindows.length !== procedureSystemWindows.length) {
        procedureSystemWindows = nextProcedureSystemWindows
      }
      if (processPlantArtifactModal && !liveObjectIds.has(processPlantArtifactModal.object.id)) {
        processPlantArtifactModal = null
      }
      if (processPlantCredibilityModal && !liveObjectIds.has(processPlantCredibilityModal.id)) {
        processPlantCredibilityModal = null
      }
    })
  })

  const procedureScopeForObject = (object: OperationalObject): ProcedureRunScope | null => {
    const plantId = activePack?.packForObject(object).procedures?.scopeIdForObject(object) ?? null
    return plantId === null
      ? null
      : { plantId, targetObjectId: object.id, label: object.label }
  }

  const procedureSummariesForObject = (object: OperationalObject): ProcedureRunSummaryGroup => {
    const scope = procedureScopeForObject(object)
    return scope
      ? procedureRunSummariesForScope(procedureRuns, scope, procedureRunDocuments)
      : emptyProcedureRunSummaries
  }

  const openProcedureWindowAt = (object: OperationalObject, procedureId?: ProcedureId): void => {
    if (procedureScopeForObject(object) === null) return
    // One procedure window per unit: opening it again raises and focuses the open one.
    const open = procedureSystemWindows.find(entry => entry.objectId === object.id)
    if (open) {
      procedureSystemWindows = [...procedureSystemWindows.filter(entry => entry.id !== open.id), {
        ...open,
        ...(procedureId === undefined ? {} : { initialProcedureId: procedureId }),
        focusRequest: (open.focusRequest ?? 0) + 1,
      }]
      return
    }
    procedureSystemWindows = [
      ...procedureSystemWindows,
      {
        id: nextFloatingWindowId('procedure-system', object.id),
        objectId: object.id,
        ...(procedureId === undefined ? {} : { initialProcedureId: procedureId }),
      },
    ]
    void loadProcedureSystemModal()
  }

  const openProcedureSystemAt = (object: OperationalObject, summary?: ProcedureRunSummary): void =>
    openProcedureWindowAt(object, summary?.procedureId)

  const openProcedureSystem = (object: OperationalObject): void => {
    openProcedureSystemAt(object)
  }

  const closeProcedureSystem = (windowId: string): void => {
    procedureSystemWindows = procedureSystemWindows.filter(entry => entry.id !== windowId)
  }

  // An AI agent's Run shows in its unit's procedure window, opened if need be, never focused.
  const showAiProcedureRun = (run: ProcedureRunState): void => {
    const object = objects.find(candidate => procedureScopeForObject(candidate)?.plantId === run.scope.plantId)
    if (object === undefined) return
    procedureSystemWindows = procedureWindowsShowingAiStart(procedureSystemWindows, {
      objectId: object.id,
      run,
      newWindowId: () => nextFloatingWindowId('procedure-system', object.id),
    })
    void loadProcedureSystemModal()
  }

  const retargetProcedureSystem = (windowId: string, objectId: ObjectId): void => {
    procedureSystemWindows = procedureSystemWindows.map(entry => entry.id === windowId
      ? { ...entry, objectId }
      : entry)
  }

  const closeSettings = (): void => {
    settingsModalOpen = false
  }

  const resetStartupForJoin = (): void => {
    resetStartupDebug()
    surfaceLoadGeneration += 1
    postReadyPreloadStarted = false
    startupDismissed = false
    latestMapRuntimeDiagnostics = null
    pendingRealtimeSimulationRunId = null
    latestDroneMotionFrames = []
    startupSteps = resetStartupStepsAfter(startupSteps, 'simulation-run')
  }

  const activeRoute = () => parseControlSurfaceRoute(location.pathname)

  const activeWorkspaceId = () => {
    const route = activeRoute()
    return route.workspaceId
  }

  const scenarioIdForReset = (): string | undefined =>
    scenarioState?.scenarioId

  const loadScenarioDefinitionAndPack = async (scenarioId: string): Promise<CompiledScenario> => {
    markStartup('scenario-fetch:start')
    const body = await fetchScenario(scenarioId)
    markStartup('scenario-fetch:done')
    return await loadScenarioDefinitionAndPackFromDefinition(body.scenario)
  }

  // A Pack's start-state layout hint applies once per set of active Packs. The key outlives a Run
  // reset, which reinstalls the same Packs, so the operator's own rail choice stays.
  let appliedSurfaceLayoutKey = ''
  const applySurfaceLayoutHint = (pack: ActivePackViews): void => {
    const key = pack.packs.map(view => view.descriptor.id).join('|')
    if (key === appliedSurfaceLayoutKey) return
    appliedSurfaceLayoutKey = key
    if (railStartsCollapsed(pack.packs)) railLayout.collapse()
  }

  const loadScenarioDefinitionAndPackFromDefinition = async (scenario: CompiledScenario): Promise<CompiledScenario> => {
    markStartup('pack-load:start')
    const nextPack = await loadActivePackViews(scenario.packs)
    markStartup('pack-load:done')
    scenarioDefinition = scenario
    activePack = nextPack
    applySurfaceLayoutHint(nextPack)
    return scenario
  }

  const defaultName = (type: PackCreateObjectType): string => {
    const creation = requireActivePack().creation
    if (!creation) throw new Error(`no active Pack can create ${type.id}`)
    return creation.defaultObjectLabel(type.id, { objects })
  }

  const syncSimulationRunSnapshot = async (): Promise<void> => {
    if (!simulationRunId) return
    const askedAs = perspectiveKey(currentActiveRoleSet())
    const body = await syncSimulationRunSnapshotClient(simulationRunId)
    if (perspectiveKey(currentActiveRoleSet()) !== askedAs) return
    objects = [...body.snapshot.objects]
    scenarioState = body.snapshot.scenario
    clock = clockOrder.published(body.snapshot.clock)
  }

  const switchUnderWay = (): boolean => {
    if (pendingRoleIds === null) return false
    commandFeedback = noteAction(commandFeedback, 'Switching roles; issue this again once the switch completes')
    return true
  }

  const sendCommand = async (capabilityId: string, input: unknown, subject: string): Promise<void> => {
    if (!simulationRunId) return
    if (switchUnderWay()) return
    const issued = beginAction(commandFeedback, subject)
    commandFeedback = issued.feedback
    let body
    try {
      body = await invokeSimulationRunCapability(simulationRunId, { capabilityId, input })
    } catch (err) {
      commandFeedback = failAction(commandFeedback, issued.actionId, err instanceof Error ? err.message : String(err))
      return
    }
    if (body.kind !== 'command') {
      commandFeedback = failAction(commandFeedback, issued.actionId, `Capability ${capabilityId} is not a command`)
      return
    }
    commandFeedback = settleCommand(commandFeedback, issued.actionId, body.result)
    if (body.result.ok) await syncSimulationRunSnapshot()
  }

  const cancelMapAssignment = (): void => {
    mapAssignment = null
    mapAssignmentPicker = null
    mapAssignmentChoiceIds = []
  }

  /** A long press starts a map assignment only on an object whose Pack declares one; on any other it stays a plain click. */
  const canLongPress = (object: OperationalObject): boolean => activePack !== null && activePack.packForObject(object).mapAssignment !== undefined

  const beginMapAssignment = (controller: OperationalObject, mode: PackMapAssignmentMode): void => {
    if (!activePack) return
    const contribution = activePack.packForObject(controller).mapAssignment
    if (!contribution) return
    if (mode === 'start' && !contribution.canStart(controller, targetContext)) {
      commandFeedback = noteAction(commandFeedback, `${controller.label} is not available for a new assignment`)
      return
    }
    placement.cancel()
    mapAssignment = { controllerId: controller.id, mode }
    mapAssignmentPicker = null
    mapAssignmentChoiceIds = []
    commandFeedback = noteAction(commandFeedback, mode === 'start' ? `Choose an incident for ${controller.label}` : `Add a stop to ${controller.label}`)
  }

  const submitMapAssignmentTarget = async (target: PackMapAssignmentTarget, choiceIds: ReadonlyArray<string>): Promise<void> => {
    if (choiceIds.length < target.minimumChoices || choiceIds.length > target.maximumChoices) {
      commandFeedback = noteAction(commandFeedback, `Choose ${target.minimumChoices === target.maximumChoices ? target.minimumChoices : `${target.minimumChoices}–${target.maximumChoices}`} patients`)
      return
    }
    const command = target.buildCommand(choiceIds)
    cancelMapAssignment()
    await sendCommand(command.kind, command.payload, `Assigning ${target.label}`)
  }

  const chooseMapAssignmentTarget = (candidate: OperationalObject, screen: { readonly x: number; readonly y: number }): void => {
    if (!mapAssignment || !mapAssignmentController || !mapAssignmentContribution) return
    const target = mapAssignmentContribution.targetFor(mapAssignmentController, candidate, mapAssignment.mode, targetContext)
    if (!target) {
      commandFeedback = noteAction(commandFeedback, `${candidate.label} is not a valid next destination`)
      cancelMapAssignment()
      return
    }
    const available = target.choices.filter(choice => !choice.disabledReason)
    if (target.choices.length <= 1) {
      void submitMapAssignmentTarget(target, available.map(choice => choice.id))
      return
    }
    mapAssignmentPicker = { target, x: screen.x, y: screen.y }
    mapAssignmentChoiceIds = []
  }

  const toggleMapAssignmentChoice = (id: string): void => {
    mapAssignmentChoiceIds = mapAssignmentChoiceIds.includes(id)
      ? mapAssignmentChoiceIds.filter(value => value !== id)
      : [...mapAssignmentChoiceIds, id]
  }

  const invokeRealtimeCapability = async (invocation: Parameters<typeof realtimeConnection.invokeCapability>[1]) => {
    if (!simulationRunId) throw new Error('simulation run is not ready')
    return await realtimeConnection.invokeCapability(simulationRunId, invocation)
  }

  const sendRealtimeInput = (input: Parameters<typeof realtimeConnection.sendRuntimeInput>[1]): void => {
    if (!simulationRunId) throw new Error('simulation run is not ready')
    realtimeConnection.sendRuntimeInput(simulationRunId, input)
  }

  const subscribeDroneMotionFrames = (consumer: DroneMotionFrameConsumer): (() => void) => {
    droneMotionFrameConsumers.add(consumer)
    if (latestDroneMotionFrames.length > 0) consumer(latestDroneMotionFrames)
    return () => {
      droneMotionFrameConsumers.delete(consumer)
    }
  }

  const publishDroneMotionFrames = (frames: ReadonlyArray<DroneMotionFrame>): void => {
    if (frames.length === 0) return
    latestDroneMotionFrames = frames
    for (const consumer of droneMotionFrameConsumers) consumer(frames)
  }

  const deleteObject = async (object: OperationalObject): Promise<void> => {
    await sendCommand(deleteObjectCommandKind, { objectId: object.id }, `Deleting ${object.label}`)
  }

  const createObject = async (draft: CreateDraft): Promise<void> => {
    placement.clearDraft()
    const pack = requireActivePack()
    if (!pack.creation) throw new Error('active Packs do not support object creation')
    const command = pack.creation.buildCreateObjectCommand(
      draft.objectType.id,
      draft.label.trim() || defaultName(draft.objectType),
      draft.geometry,
      draft.parameters,
    )
    await sendCommand(command.kind, command.payload, `Creating ${draft.objectType.label}`)
  }

  /** One path for map clicks: a map-target panel takes every target click; otherwise the Pack's targeting sends. */
  const followMapClick = (route: MapClickRoute): void => {
    if (route.kind === 'card') {
      if (placementMode === null) openPlantCard(route.objectId)
      return
    }
    // A click on anything else lets the card go; it then does what it always did.
    closePlantCard()
    if (route.kind === 'none') return
    if (route.kind === 'select') {
      selectedControllerId = route.objectId
      if (route.note !== null) commandFeedback = noteAction(commandFeedback, route.note)
      return
    }
    if (route.kind === 'note') {
      commandFeedback = noteAction(commandFeedback, route.text)
      return
    }
    if (route.kind === 'panel') {
      const onMapTarget = mapTargetPanel?.onMapTarget
      if (!onMapTarget) throw new Error('a map target was routed to a panel that has not connected onMapTarget')
      onMapTarget(route.controllerId, route.target)
      return
    }
    void sendCommand(route.command.kind, route.command.payload, route.subject)
  }

  const openPlantCard = (objectId: ObjectId): void => {
    const active = document.activeElement
    const fromRail = active instanceof HTMLElement && active.closest('.control-rail') !== null
    // Another unit's card waits for the map to say where its icon is, never standing a frame at the last one's.
    if (plantCard?.objectId !== objectId) plantCardFrame = null
    plantCard = { objectId, opener: fromRail ? active : plantCard?.opener ?? null }
  }

  const closePlantCard = (): void => {
    plantCard = null
    plantCardFrame = null
  }

  // Esc or the card's close button: focus goes back to the rail row that opened it.
  const dismissPlantCard = (): void => {
    const opener = plantCard?.opener ?? null
    closePlantCard()
    if (opener?.isConnected) opener.focus()
  }

  // Every action opens something on top or beside; the card has done its job and goes. What it
  // opens gives focus back to where the card came from: the rail row, else the map.
  const followPlantCardAction = (action: PlantCardAction): void => {
    const object = plantCardObject
    if (object === null) return
    const view = plantCardView(object, procedureSummariesForObject(object))
    const procedure = view?.procedure.summary ?? undefined
    const returnTo = plantCard?.opener?.isConnected ? plantCard.opener : document.querySelector<HTMLElement>('.surface-main .maplibregl-canvas')
    closePlantCard()
    returnTo?.focus({ preventScroll: true })
    switch (action) {
      case 'overview': return openProcessDisplay(object)
      case 'procedures': return openProcedureSystemAt(object, procedure)
      case 'safety-procedure': return openProcedureWindowAt(object, view?.safetyFunction?.notRunning ?? undefined)
      case 'instructor': return requestDisplayWindow({ kind: 'asset', objectId: object.id }, true)
      case 'assistant': {
        if (simulationRunId === null) throw new Error('the Run\'s Assistant was offered before the Run was joined')
        return requestRunAssistant({ workspaceId: activeWorkspaceId(), simulationRunId }, { parent: window.parent, origin: location.origin })
      }
      case 'component-graph': return openProcessPlantArtifact(object, 'compiled-graph-mermaid')
      case 'specification': return openProcessPlantArtifact(object, 'authored-spec')
      case 'credibility': return openProcessPlantCredibility(object)
      case 'catalog': return openProcessPlantCatalog(object)
    }
  }

  // An order context takes the map over (a unit chosen, a placement, a map-target panel, an assignment), and a removed Plant has no card.
  $effect(() => {
    if (plantCard === null) return
    if (selectedControllerObject !== null || placementMode !== null || mapTargetPanel !== null || mapAssignment !== null || plantCardObject === null) untrack(closePlantCard)
  })

  const selectObject = (object: OperationalObject): void => {
    markSeen(object)
    requireActivePack()
    followMapClick(routeObjectClick(object, mapClickContext))
  }

  const selectGround = (point: GeoJsonPoint): void => {
    followMapClick(routeGroundClick(point, mapClickContext))
  }

  const previewTarget = (object: OperationalObject): PackTargetPreview | null =>
    previewObjectTarget(object, mapClickContext)

  /** A panel's selection, shared with the map; null clears it. */
  const selectObjectById = (objectId: ObjectId | null): void => {
    if (objectId === null) {
      selectedControllerId = null
      return
    }
    const object = objectById.get(objectId)
    if (!object) throw new Error(`a surface panel selected ${objectId}, which this screen does not hold`)
    markSeen(object)
    selectedControllerId = object.id
  }

  const connectPanelInteraction = (panel: PackSurfacePanelContribution, interaction: SurfacePanelInteraction): (() => void) => {
    assertPanelInteraction(panel, interaction)
    panelInteractions = { ...panelInteractions, [panel.id]: interaction }
    return () => {
      if (panelInteractions[panel.id] !== interaction) return
      const { [panel.id]: _released, ...rest } = panelInteractions
      panelInteractions = rest
    }
  }

  const deliverPanelKey = (key: PanelKey): boolean => {
    const panel = keymapPanel
    if (!panel) return false
    return panelInteractions[panel.id]?.onKey?.(key) ?? false
  }

  const connectWebSocket = (id: SimulationRunId): void => {
    if (mapVisible && !mapReady) {
      pendingRealtimeSimulationRunId = id
      startStep('realtime')
      status = 'Waiting for map first frame before realtime updates'
      return
    }
    pendingRealtimeSimulationRunId = null
    startStep('realtime')
    if (realtimeConnection.canCarry(id)) {
      status = realtimeConnection.statusFor(id) === 'open' ? 'Realtime channel open' : 'Connecting'
      completeReadyWhenReady()
      return
    }
    realtimeAttached = false
    latestDroneMotionFrames = []
    realtimeConnection.connect(id, {
      onOpen: () => {
        status = 'Realtime channel open'
      },
      onClose: () => {
        realtimeAttached = false
        status = 'Disconnected'
        if (pendingRoleIds !== null) failRoleSwitch(pendingRoleIds, 'The realtime channel closed before the Run answered; this screen keeps its roles')
      },
      onError: (message) => {
        status = message
        failStep('realtime', message)
      },
      onInvalidMessage: (message) => {
        status = message
      },
      onReady: (parsed) => {
        if (parsed.simulationRunId !== id) {
          failStep('realtime', `Realtime attached to ${parsed.simulationRunId}, expected ${id}`)
          return
        }
        if (expectedRealtimeScenarioId !== null && parsed.scenarioId !== expectedRealtimeScenarioId) {
          failStep('realtime', `Realtime attached to scenario ${parsed.scenarioId ?? 'none'}, expected ${expectedRealtimeScenarioId}`)
          return
        }
        realtimeAttached = true
        if (parsed.clock) clock = clockOrder.published(parsed.clock)
        if (parsed.perspective) adoptPerspective(parsed.perspective)
        status = 'Connected'
        completeStep('realtime')
        completeReadyWhenReady()
      },
      onEvent: (parsed) => {
        if (parsed.simulationRunId !== id) return
        if (expectedRealtimeScenarioId !== null && parsed.scenarioId !== expectedRealtimeScenarioId) return
        if (!realtimeAttached) return
        const applied = applySimulationRunEventBatchMessage({ objects, selectedControllerId, scenarioState }, parsed)
        if (applied.objectUpdate) {
          objects = [...applied.objectUpdate.objects]
          selectedControllerId = applied.objectUpdate.selectedControllerId
        }
        if (applied.scenarioUpdate) {
          scenarioState = applied.scenarioUpdate
        }
        if (applied.clockUpdate) {
          clock = clockOrder.published(applied.clockUpdate)
        }
        if (applied.routesChanged) {
          routeRevision += 1
        }
        if (parsed.events.some(event => event.type.startsWith('procedure.') || event.type === 'object.deleted')) {
          // Only a live batch opens a window: the snapshot and Run reads never do.
          for (const runId of procedureAiStartedRunIds(parsed.events)) aiStartedProcedureRunIds.add(runId)
          procedureRevision += 1
        }
      },
      onRoleRefused: (parsed) => {
        if (pendingRoleIds !== null) failRoleSwitch(pendingRoleIds, parsed.message)
      },
      onRuntimeRealtime: (parsed) => {
        if (parsed.simulationRunId !== id) return
        if (expectedRealtimeScenarioId !== null && parsed.scenarioId !== expectedRealtimeScenarioId) return
        if (!realtimeAttached) return
        for (const message of parsed.messages) if (message.type === 'pack.data.changed') {
          const payload = packDataChangedSchema.safeParse(message.payload)
          if (payload.success) packDataRevisions = { ...packDataRevisions, [payload.data.packId]: payload.data.revision }
        }
        const frames = parsed.messages.flatMap(message => {
          try {
            return parseDroneMotionFramesRealtimeMessage(message)?.payload.frames ?? []
          } catch (err) {
            status = err instanceof Error ? err.message : String(err)
            return []
          }
        })
        publishDroneMotionFrames(frames)
      },
    }, currentActiveRoleSet())
  }

  /** A fresh snapshot of a new perspective replaces every Run-scoped store; the map view and panel sizes stay. */
  const adoptPerspective = (perspective: RealtimePerspective): void => {
    const declaration = runRolesOf(perspective.compiledScenario)
    const perspectiveContext: PackTargetContext = declaration !== null
      ? { objects: perspective.snapshot.objects, viewer: viewerForRoleSet(declaration, perspective.roleIds) }
      : { objects: perspective.snapshot.objects }
    const startingId = activePack ? startingControllerId(perspective.snapshot.objects, activePack, perspectiveContext, isSurfacePanelOpen) : null
    const stores = storesForPerspective(
      perspective,
      { epoch: perspectiveEpoch, roleIds: heldRoleIds, feedback: commandFeedback },
      object => object.id === startingId,
    )
    // A join or reset still installing the Run's scenario and Packs installs
    // this same perspective's Compiled Scenario itself: no switch can be asked
    // for (or under way) while it runs.
    if (scenarioDefinition !== null) scenarioDefinition = stores.compiledScenario
    objects = [...stores.objects]
    scenarioState = stores.scenarioState
    clock = clockOrder.published(stores.clock)
    selectedControllerId = stores.selectedControllerId
    seenRevisions = new Map(stores.seenRevisions)
    packDataRevisions = { ...stores.packDataRevisions }
    packPanelSelections = { ...stores.packPanelSelections }
    commandFeedback = stores.commandFeedback
    cancelMapAssignment()
    placement.cancel()
    latestDroneMotionFrames = []
    routeRevision += 1
    procedureRevision += 1
    // One switch is outstanding at a time, so a new epoch is its answer.
    if (perspective.epoch !== perspectiveEpoch) pendingRoleIds = null
    perspectiveEpoch = perspective.epoch
    heldRoleIds = perspective.roleIds
    configureActiveRoleSet(perspective.roleIds)
    keepRoleSet(perspective.roleIds)
    // A held role is seen, so holding it, however gained, ticks its See box for good.
    keepHiddenRoles(hiddenOnceHeld(hiddenRoleIds, perspective.roleIds))
  }

  const failRoleSwitch = (roleIds: ReadonlyArray<string>, reason: string): void => {
    pendingRoleIds = null
    const subject = runRoles ? `Switching to ${roleSetText(runRoles, roleIds)}` : 'Switching roles'
    const issued = beginAction(commandFeedback, subject)
    commandFeedback = failAction(issued.feedback, issued.actionId, reason)
  }

  const roleSetKey = (): string => {
    const route = activeRoute()
    return roleSetStorageKey(route.workspaceId, route.mode === 'simulation-run' ? route.simulationRunId : '')
  }

  /** This tab's role set lives in the World frame URL and sessionStorage, never in a cookie. */
  const keepRoleSet = (roleIds: ReadonlyArray<string> | null): void => {
    writeStoredRoleSet(sessionStorage, roleSetKey(), roleIds)
    history.replaceState(history.state, '', `${location.pathname}${searchWithRoleSet(location.search, roleIds)}`)
  }

  const hiddenRolesKey = (): string => {
    const route = activeRoute()
    return hiddenRolesStorageKey(route.workspaceId, route.mode === 'simulation-run' ? route.simulationRunId : '')
  }

  /** This tab's unseen roles live in sessionStorage only: a display filter, never sent to the Run. */
  const keepHiddenRoles = (roleIds: ReadonlyArray<string>): void => {
    const changed = roleIds.length !== hiddenRoleIds.length || roleIds.some(roleId => !hiddenRoleIds.includes(roleId))
    hiddenRoleIds = roleIds
    writeStoredHiddenRoles(sessionStorage, hiddenRolesKey(), roleIds)
    // The map projects its objects again, so what this tab no longer sees leaves it, and what it sees again returns.
    if (changed) routeRevision += 1
  }

  /** The role bar's dialog: keep what this tab sees, and ask the Run for the role set when it changed. */
  const applyRoleDialog = (result: RoleDialogResult): void => {
    if (!heldRoleIds) throw new Error('The role dialog applies to a screen that holds roles')
    roleDialogOpen = false
    keepHiddenRoles(result.hidden)
    requestRoleChange(roleDialogChange(heldRoleIds, result))
  }

  const requestRoleChange = (change: RoleSetChange): void => {
    if (change.kind === 'unchanged') return
    if (change.kind === 'refused') {
      commandFeedback = noteAction(commandFeedback, change.reason)
      return
    }
    if (!simulationRunId || !runRoles) throw new Error('A role change needs a joined Run that declares roles')
    if (pendingRoleIds !== null) {
      commandFeedback = noteAction(commandFeedback, 'A role switch is already under way')
      return
    }
    try {
      realtimeConnection.setRoles(simulationRunId, change.roleIds)
    } catch (err) {
      failRoleSwitch(change.roleIds, err instanceof Error ? err.message : String(err))
      return
    }
    pendingRoleIds = change.roleIds
    commandFeedback = beginAction(commandFeedback, `Switching to ${roleSetText(runRoles, change.roleIds)}`).feedback
  }

  /** A role Run refused this screen's role set: show the picker from the public presence. */
  const openRolePicker = async (id: SimulationRunId): Promise<void> => {
    const presence = await fetchRunPresence(id)
    if (!presence.roles) {
      // The Run declares no roles; the URL named some. Play it in open mode.
      keepRoleSet(null)
      configureActiveRoleSet(null)
      commandFeedback = noteAction(commandFeedback, 'This Run declares no roles')
      await joinSimulationRun()
      return
    }
    keepRoleSet(null)
    rolePicker = { runTitle: presence.title, declaration: presence.roles, holders: presence.roles.holders }
  }

  const loadRoleHolders = async (): Promise<Readonly<Record<string, number>>> => {
    const route = activeRoute()
    if (route.mode !== 'simulation-run') throw new Error('simulation run route expected')
    const presence = await fetchRunPresence(route.simulationRunId)
    if (!presence.roles) throw new Error('This Run no longer declares roles')
    return presence.roles.holders
  }

  const joinWithRoles = (result: RoleDialogResult): void => {
    keepRoleSet(result.roleIds)
    keepHiddenRoles(result.hidden)
    rolePicker = null
    void joinSimulationRun()
  }

  const connectPendingRealtime = (): void => {
    const id = pendingRealtimeSimulationRunId
    if (!id) return
    pendingRealtimeSimulationRunId = null
    connectWebSocket(id)
  }

  const simulationRunIdFromPath = (): SimulationRunId => {
    const route = activeRoute()
    if (route.mode !== 'simulation-run') throw new Error('simulation run route expected')
    if (location.pathname !== route.canonicalPath) history.replaceState(null, '', `${route.canonicalPath}${searchWithRoleSet('', roleSetFromSearch(location.search))}`)
    return route.simulationRunId
  }

  const completeStartupFromResponse = async (
    response: SimulationRunResponse,
    config: {
      readonly setActiveStartupStep: (id: StartupStepId) => void
    },
  ): Promise<void> => {
    const source = startupScenarioSource(response, scenarioDefinition, currentActiveRoleSet() !== null)
    const scenarioId = source.kind === 'scenario-fetch' ? source.scenarioId : source.scenario.id
    const packScenario = source.kind === 'installed'
      ? source.scenario
      : source.kind === 'run-read'
        ? await loadScenarioDefinitionAndPackFromDefinition(source.scenario)
        : await loadScenarioDefinitionAndPack(source.scenarioId)
    if (packScenario.id !== scenarioId || !activePack) throw new Error(`scenario packs failed to load for ${scenarioId}`)
    await completeControlSurfaceStartupFromSnapshot({
      response,
      pack: activePack,
      startStep,
      completeStep,
      setActiveStartupStep: config.setActiveStartupStep,
      setSimulationRunId: id => {
        simulationRunId = id
      },
      setObjects: nextObjects => {
        objects = nextObjects
      },
      setScenarioState: nextState => {
        scenarioState = nextState
      },
      setClock: nextClock => {
        clock = clockOrder.published(nextClock)
      },
      setExpectedRealtimeScenarioId: scenarioId => {
        expectedRealtimeScenarioId = scenarioId
      },
      setSelectedControllerId: id => {
        selectedControllerId = id
      },
      targetContext: targetContextFor,
      isSurfacePanelOpen,
      setSeenRevisions: nextSeen => {
        seenRevisions = nextSeen
      },
      setSnapshotReady: ready => {
        snapshotReady = ready
      },
      loadSurfaceForScenario,
      completeObjectsWhenReady,
      connectRealtime: connectWebSocket,
    })
  }

  const joinSimulationRun = async (): Promise<void> => {
    realtimeConnection.disconnect()
    realtimeAttached = false
    resetStartupForJoin()
    snapshotReady = false
    mapReady = false
    scenarioDefinition = null
    activePack = null
    status = 'Starting'
    startStep('simulation-run')
    let activeStartupStep: StartupStepId = 'simulation-run'
    try {
      const id = simulationRunIdFromPath()
      const route = activeRoute()
      if (route.mode !== 'simulation-run') throw new Error('simulation run route expected')
      let requestedRoleIds: ReadonlyArray<string> | null
      try {
        requestedRoleIds = initialRoleSet({ search: location.search, storage: sessionStorage, key: roleSetKey() })
      } catch (err) {
        keepRoleSet(null)
        commandFeedback = noteAction(commandFeedback, `Stored roles were unreadable and were cleared: ${err instanceof Error ? err.message : String(err)}`)
        requestedRoleIds = null
      }
      configureActiveRoleSet(requestedRoleIds)
      heldRoleIds = requestedRoleIds
      try {
        hiddenRoleIds = readStoredHiddenRoles(sessionStorage, hiddenRolesKey())
      } catch (err) {
        keepHiddenRoles([])
        commandFeedback = noteAction(commandFeedback, `Stored See choices were unreadable and were cleared: ${err instanceof Error ? err.message : String(err)}`)
      }
      pendingRoleIds = null
      perspectiveEpoch = 0
      markStartup('join-request:start')
      let body
      try {
        body = await joinSimulationRunClient(id)
      } catch (err) {
        const code = worldApiErrorCode(err)
        if (code !== 'role_required' && code !== 'unknown_role') throw err
        await openRolePicker(id)
        return
      }
      markStartup('join-request:done')
      if (heldRoleIds !== null) keepRoleSet(heldRoleIds)
      await completeStartupFromResponse(body, {
        setActiveStartupStep: id => {
          activeStartupStep = id
        },
      })
      void refreshExecution()
    } catch (err) {
      failStep(activeStartupStep, err)
    }
  }

  const resetScenario = async (): Promise<void> => {
    if (!simulationRunId) return
    if (switchUnderWay()) return
    realtimeAttached = false
    resetStartupForJoin()
    snapshotReady = false
    mapReady = false
    scenarioDefinition = null
    activePack = null
    status = 'Resetting'
    const reset = beginAction(commandFeedback, 'Resetting scenario')
    commandFeedback = reset.feedback
    startStep('simulation-run')
    let activeStartupStep: StartupStepId = 'simulation-run'
    try {
      expectedRealtimeScenarioId = scenarioIdForReset() ?? null
      startStep('realtime')
      const body = await resetSimulationRun(simulationRunId)
      await completeStartupFromResponse(body, {
        setActiveStartupStep: id => {
          activeStartupStep = id
        },
      })
      commandFeedback = completeAction(commandFeedback, reset.actionId)
    } catch (err) {
      failStep(activeStartupStep, err)
      commandFeedback = failAction(commandFeedback, reset.actionId, err instanceof Error ? err.message : String(err))
    }
  }

  const handleMapReady = (): void => {
    mapReady = true
    markStartup('map:ready')
    if (startupSteps.find(step => step.id === 'map')?.status !== 'done') completeStep('map')
    if (startupSteps.find(step => step.id === 'objects')?.status === 'pending') startStep('objects')
    connectPendingRealtime()
    void completeObjectsWhenReady()
    preloadOptionalUiAfterReady()
  }

  const handleMapError = (message: string): void => {
    if (!mapReady) {
      failStep('map', message)
      return
    }
    status = message
  }

  runOnMount(() => {
    longTaskMonitor = createLongTaskDiagnosticsMonitor()
    const cleanupInternalDiagnosticsGlobal = installInternalDiagnosticsGlobal({
      snapshot: currentInternalDiagnostics,
      clear: clearInternalDiagnostics,
    })
    const nextTheme = initialTheme()
    theme = nextTheme
    if (getTheme() !== nextTheme) document.documentElement.classList.toggle('dark', nextTheme === 'dark')
    railLayout.initialize()
    const removePlacementGlobalEvents = installPlacementGlobalEvents({
      placementMode: () => placementMode,
      cancel: placement.cancel,
      finishPolygon: placement.finishPolygon,
    })
    let route
    try {
      route = activeRoute()
      if (route.mode !== 'simulation-run') throw new Error('control surface route expected')
    } catch (err) {
      failStep('route', err)
      return () => {
        cleanupInternalDiagnosticsGlobal()
        longTaskMonitor?.stop()
        longTaskMonitor = null
        removePlacementGlobalEvents()
        railLayout.stopResize()
        clearStartupAutoDismissTimer()
      }
    }
    if (window.self === window.top) {
      window.location.replace(`/workspaces/${encodeURIComponent(route.workspaceId)}?world=${encodeURIComponent(route.simulationRunId)}`)
      return () => {
        cleanupInternalDiagnosticsGlobal()
        longTaskMonitor?.stop()
        longTaskMonitor = null
        removePlacementGlobalEvents()
        railLayout.stopResize()
        clearStartupAutoDismissTimer()
      }
    }
    // Before any awaited startup: the Host may relay displays as soon as this page listens.
    displayWindowRunId = route.simulationRunId
    const workspaceId = route.workspaceId
    const receiveDisplayWindowMessage = (event: MessageEvent): void => {
      const message = readDisplayWindowHostMessage(event, { origin: location.origin, parent: window.parent, workspaceId })
      if (message === null) return
      if (message.kind === 'rejected') {
        status = `Process display window: ${message.reason}`
        return
      }
      if (message.kind === 'views') {
        conversationDisplays = message.views
        // Each refused listing is left out on its own and said; the rest of the list is shown.
        if (message.refused.length > 0) status = `Process display window: ${message.refused.map(refused => refused.reason).join('; ')}`
        return
      }
      if (message.kind === 'subject-open') {
        requestDisplayWindow({ kind: 'subject', runId: message.runId, subject: message.subject, title: message.title }, false)
        return
      }
      requestDisplayWindow({ kind: 'listing', listing: message.view }, false)
    }
    // The Host answers the ready message below with whether the Run offers its Assistant room.
    const receiveRunAssistantOffer = (event: MessageEvent): void => {
      const offer = readRunAssistantOffer(event, { origin: location.origin, parent: window.parent })
      if (offer === null) return
      if (offer.kind === 'rejected') {
        status = `Run Assistant: ${offer.reason}`
        return
      }
      runAssistantOffered = offer.available
    }
    window.addEventListener('message', receiveDisplayWindowMessage)
    window.addEventListener('message', receiveRunAssistantOffer)
    window.parent.postMessage(displayWindowReadyMessage(), location.origin)
    completeStep('route')
    completeStep('interface')
    preloadOperationalMapModule()
    void joinSimulationRun()
    const executionPoll = window.setInterval(() => { void refreshExecution() }, 1_000)
    return () => {
      window.removeEventListener('message', receiveDisplayWindowMessage)
      window.removeEventListener('message', receiveRunAssistantOffer)
      cleanupInternalDiagnosticsGlobal()
      longTaskMonitor?.stop()
      longTaskMonitor = null
      removePlacementGlobalEvents()
      railLayout.stopResize()
      realtimeConnection.disconnect()
      clearStartupAutoDismissTimer()
      window.clearInterval(executionPoll)
    }
  })

  $effect(() => {
    if (
      startupDismissed
      || startupStatusModalOpen
      || startupHasFailed(startupSteps)
      || !startupIsReady(startupSteps)
    ) {
      clearStartupAutoDismissTimer()
      return
    }
    if (startupAutoDismissTimer !== null) return
    startupAutoDismissTimer = window.setTimeout(() => {
      startupAutoDismissTimer = null
      closeStartupModal()
    }, 1_500)
  })

  $effect(() => {
    if (createDraft) void loadCreateObjectModal()
  })

  $effect(() => {
    const panels = surfacePanels
    const key = panels.map(panel => panel.id).join('|')
    if (key === appliedSurfacePanelKey) return
    untrack(() => {
      const next: Record<string, boolean> = {}
      for (const panel of panels) next[panel.id] = surfacePanelOpen[panel.id] ?? panel.defaultOpen
      surfacePanelOpen = next
      appliedSurfacePanelKey = key
    })
  })

  $effect(() => {
    if (!richOperationalUiReady) return
    for (const panel of surfacePanels) {
      if (surfacePanelOpen[panel.id] ?? panel.defaultOpen) void loadSurfacePanel(panel.id)
    }
  })

  $effect(() => {
    const id = simulationRunId
    if (!id) return
    const next = createProcedureSession({
      simulationRunId: id,
      onError: error => { console.warn('Background procedure document load failed; selecting it will retry.', error) },
    })
    untrack(() => {
      aiStartedProcedureRunIds.clear()
      procedureSession = next
      next.subscribe(state => { procedureRuns = state.runs; procedureRunDocuments = state.documents })
    })
    return () => { next.dispose() }
  })

  // An AI agent's live start shows once its Run is read: once per start, so a
  // window the person closes stays closed until an AI agent starts again.
  $effect(() => {
    const runs = procedureRuns
    untrack(() => {
      if (aiStartedProcedureRunIds.size === 0) return
      const read = procedureAiStartsRead(runs, aiStartedProcedureRunIds)
      for (const runId of read.settled) aiStartedProcedureRunIds.delete(runId)
      for (const run of read.show) showAiProcedureRun(run)
    })
  })

  $effect(() => {
    const session = procedureSession
    const revision = procedureRevision
    const hasProcessPlant = scenarioDefinition?.packs.includes('process-plant') === true
    if (!session || !hasProcessPlant) return
    let active = true
    untrack(() => {
      void session.refreshRuns().catch(error => {
        if (active) status = error instanceof Error ? error.message : String(error)
      })
    })
    return () => { active = false }
  })

</script>

{#if !startingView}
  <div class="boot-shell"></div>
{:else}
  <div
    class:rail-collapsed={railLayout.collapsed}
    class:no-rail={!railVisible}
    class="app-shell"
    style={`--rail-width: ${railVisible ? railLayout.width : 0}px`}
  >
    {#if railConfig}
      <ControlRail
        status={mapWarnings || status}
        {systemStatusTone}
        {appVersion}
        {footerVisible}
        collapsed={railLayout.collapsed}
        {categoryRows}
        {railConfig}
        {placementMode}
        {selectedControllerId}
        cardObjectId={plantCard?.objectId ?? null}
        {categoryMapVisibility}
        deferObjectRows={!richOperationalUiReady}
        {presentationFor}
        {detailPresentationFor}
        {hasNewInfo}
        {markSeen}
        {selectObject}
        deleteObject={controllerControls ? deleteObject : undefined}
        {openProcessDisplay}
        {openProcedureSystem}
        {openProcedureSystemAt}
        {openDroneControl}
        {openDroneProfileEditor}
        {procedureSummariesForObject}
        beginPlacement={placement.begin}
        cancelPlacement={placement.cancel}
        {openStatusModal}
        {openSettings}
        {toggleCategoryMapVisibility}
        mapLayerGroups={activeMapLayerGroups}
        mapLegends={activeMapLegends}
        {mapLayerGroupVisibility}
        onMapLayerGroupToggle={toggleMapLayerGroup}
        surfacePanels={surfacePanelLaunchers}
        {toggleSurfacePanel}
      />
      <button
        class="rail-resize-handle"
        class:collapsed={railLayout.collapsed}
        type="button"
        aria-label={railLayout.collapsed ? 'Show control rail' : 'Resize control rail'}
        title={railLayout.collapsed ? 'Show control rail' : 'Drag to resize control rail'}
        onpointerdown={railLayout.startResize}
      ></button>
    {/if}

    <main class="surface-main" class:map-region={mapVisible}>
      {#if mapVisible && OperationalMap}
        <OperationalMap
          {objects}
          {selectedControllerId}
          controllerHighlighted={selectedControllerObject !== null}
          isController={object => activePack?.targeting?.isController(object, targetContext) === true}
          {placementMode}
          {placementCursor}
          {placementPoints}
          {theme}
          mapConfig={effectiveMapConfig}
          {clock}
          {routeRevision}
          {debugMapInput}
          highlightedObjectIds={mapHighlightedObjectIds}
          mutedObjectIds={mapMutedObjectIds}
          prompt={mapPrompt}
          {hiddenObjectCategoryIds}
          {hasNewInfo}
          presentationFor={mapPresentationFor}
          presentationKey={mapPresentationKey}
          {mapFeaturesFor}
          onObjectSelected={selectObject}
          onPlacementPoint={placement.placePoint}
          onObjectSeen={markSeen}
          onMapReady={handleMapReady}
          onMapView={view => panelMapView = view}
          onMapError={handleMapError}
          onMapDiagnostic={handleMapDiagnostic}
          {simulationRunId}
          packDataRevisionKey={mapFeatureRevisionKey}
          {perspectiveEpoch}
          onPackFeatureSelected={selection => { if (surfacePanels.some(panel => panel.id === selection.panelId)) { packPanelSelections = { ...packPanelSelections, [selection.panelId]: selection.itemId }; setSurfacePanelOpen(selection.panelId, true) } }}
          mapLayerGroups={activeMapLayerGroups}
          {mapLayerGroupVisibility}
          referenceStyles={activeReferenceStyles}
          liveMapLayers={activeLiveMapLayers}
          {queryLiveMapLayer}
          packSelections={packPanelSelections}
          packFeatureLayers={activePackFeatureLayers}
          packFeatureSourcePackIds={activePackFeatureSourcePackIds}
          focusRequest={mapFocusRequest}
          assignmentActive={mapAssignment !== null}
          assignmentAnchor={mapAssignmentAnchor}
          assignmentHandles={mapAssignmentHandles}
          onObjectLongPressed={object => beginMapAssignment(object, 'start')}
          {canLongPress}
          onAssignmentHandleSelected={controllerId => { const controller = objects.find(object => object.id === controllerId); if (controller) beginMapAssignment(controller, 'append') }}
          onAssignmentObjectSelected={chooseMapAssignmentTarget}
          onAssignmentCancelled={cancelMapAssignment}
          cameraInteraction={mapCameraInteraction}
          cameraPadding={mapCameraPadding}
          targetPicking={targetPickingWanted(mapClickContext)}
          onGroundSelected={plantCard !== null ? () => closePlantCard() : groundClicksWanted(mapClickContext) ? selectGround : undefined}
          targetPreviewFor={targetPreviewsWanted(mapClickContext) ? previewTarget : undefined}
          takesDiskClicks={opensPlantCard}
          cardObjectId={plantCard?.objectId ?? null}
          onCardFrame={frame => { plantCardFrame = frame }}
        />
      {:else if mapVisible}
        <div class="map-loading">Starting map...</div>
      {:else}
        <div class="surface-empty"></div>
      {/if}
      {#if plantCardObject !== null}
        {@const view = plantCardView(plantCardObject, procedureSummariesForObject(plantCardObject))}
        {@const plantSystemAvailable = processPlantIdForObject(plantCardObject) !== null}
        {#if view !== null}
          <PlantCard
            {view}
            objectId={plantCardObject.id}
            {simulationRunId}
            frame={plantCardFrame}
            instructorOffered={controllerControls && plantSystemAvailable}
            assistantOffered={runAssistantOffered && simulationRunId !== null}
            engineeringOffered={plantSystemAvailable}
            onAction={followPlantCardAction}
            onClose={dismissPlantCard}
          />
        {/if}
      {/if}
      {#if mapAssignmentPicker}
        <section
          class="map-assignment-picker"
          style={`--picker-x:${mapAssignmentPicker.x}px;--picker-y:${mapAssignmentPicker.y}px`}
          aria-label={`Select patients for ${mapAssignmentPicker.target.label}`}
        >
          <div class="map-assignment-picker__header">
            <div>
              <strong>{mapAssignmentPicker.target.label}</strong>
              <span>Select casualties</span>
            </div>
            <button type="button" aria-label="Cancel assignment" title="Cancel" onclick={cancelMapAssignment}>×</button>
          </div>
          <div class="map-assignment-picker__choices">
            {#each mapAssignmentPicker.target.choices as choice (choice.id)}
              <label class:disabled={!!choice.disabledReason} title={choice.disabledReason ?? ''}>
                <input type="checkbox" disabled={!!choice.disabledReason} checked={mapAssignmentChoiceIds.includes(choice.id)} onchange={() => toggleMapAssignmentChoice(choice.id)} />
                <span><strong>{choice.label}</strong><small>{choice.summary}</small>{#if choice.disabledReason}<small class="reason">{choice.disabledReason}</small>{/if}</span>
              </label>
            {/each}
          </div>
          <div class="map-assignment-picker__footer">
            <span>{mapAssignmentChoiceIds.length}/{mapAssignmentPicker.target.maximumChoices} selected</span>
            <button type="button" disabled={mapAssignmentChoiceIds.length < mapAssignmentPicker.target.minimumChoices || mapAssignmentChoiceIds.length > mapAssignmentPicker.target.maximumChoices} onclick={() => void submitMapAssignmentTarget(mapAssignmentPicker!.target, mapAssignmentChoiceIds)}>Assign</button>
          </div>
        </section>
      {/if}
      {#if activePack}
        <AlertStrip {objects} categoryOf={object => presentationFor(object).categoryId} {theme} belowRoles={Boolean(runRoles && heldRoleIds)} railWidth={railVisible ? railLayout.width : 0} clear={{ left: mapCameraPadding.left, right: mapCameraPadding.right, top: guidanceOverlayVisible && scenarioState?.guidance ? guidanceBottom : 0 }} />
      {/if}
      <WorldStatusLine {clock} execution={executionState} feedback={commandFeedback.line} />
      {#if runRoles && heldRoleIds}
        <RoleBar declaration={runRoles} held={heldRoleIds} switchingTo={pendingRoleIds} request={requestRoleChange} openDialog={() => { roleDialogOpen = true }} />
      {/if}
      {#if keymapPanel}
        <!-- RoleBar listens in the capture phase, so a key it consumes (P, then a digit) arrives here defaultPrevented and never reaches the panel. -->
        <PanelKeyRouter placementActive={() => placementMode !== null} deliver={deliverPanelKey} onActiveChange={(active: boolean) => { panelKeysActive = active }} />
      {/if}
      {#if richOperationalUiReady && simulationRunId}
        <!-- A panel's own Run stores belong to one perspective: a role switch remounts it. -->
        {#key perspectiveEpoch}
        {#each surfacePanels as panel (panel.id)}
          {@const Panel = surfacePanelComponents[panel.id]}
          {#if (surfacePanelOpen[panel.id] ?? panel.defaultOpen) && Panel}
            <Panel {simulationRunId} {objects} {seenRoleIds} mapView={panelMapView} dataRevision={packDataRevisions[panel.id.split('.')[0]! ] ?? 0} selectedItemId={packPanelSelections[panel.id] ?? null} onSelectItem={(itemId: string | null) => { packPanelSelections = { ...packPanelSelections, [panel.id]: itemId } }} onClose={() => setSurfacePanelOpen(panel.id, false)} onFocusMap={focusMapTarget} currentTime={currentPackTime} selectedObjectId={selectedControllerId} onSelectObject={selectObjectById} connectInteraction={(interaction: SurfacePanelInteraction) => connectPanelInteraction(panel, interaction)} keysActive={panelKeysActive} roleSet={panelRoleSet} onMapCover={(cover: MapCover) => { panelMapCovers = { ...panelMapCovers, [panel.id]: assertMapCover(panel.id, cover) } }} onMapPrompt={(prompt: MapPrompt | null) => { panelMapPrompts = { ...panelMapPrompts, [panel.id]: prompt } }} />
          {/if}
        {/each}
        {/key}
      {/if}
    </main>

    {#if guidanceOverlayVisible && scenarioState?.guidance}
    <ScenarioGuidance
      bind:bottom={guidanceBottom}
      guidance={scenarioState.guidance}
      close={() => {
        if (!scenarioState) return
        const { guidance: _guidance, ...withoutGuidance } = scenarioState
        scenarioState = withoutGuidance
      }}
    />
    {/if}
  </div>
{/if}

{#if DroneControlModal && simulationRunId}
  {#each droneControlWindowModels as windowEntry (windowEntry.id)}
    <DroneControlModal
      {simulationRunId}
      object={windowEntry.object}
      {objects}
      {invokeRealtimeCapability}
      {sendRealtimeInput}
      subscribeMotionFrames={subscribeDroneMotionFrames}
      windowOffsetIndex={windowEntry.index}
      close={() => closeDroneControl(windowEntry.id)}
    />
  {/each}
{/if}

{#if DroneProfileEditorModal && simulationRunId}
  {#each droneProfileEditorWindowModels as windowEntry (windowEntry.id)}
    <DroneProfileEditorModal
      {simulationRunId}
      object={windowEntry.object}
      windowOffsetIndex={windowEntry.index}
      close={() => closeDroneProfileEditor(windowEntry.id)}
    />
  {/each}
{/if}

{#if DisplayWindow && displayWindowRunId && displayWindowOpen && displayWindowRequest}
  <DisplayWindow
    simulationRunId={displayWindowRunId}
    runJoin={displayRunJoin}
    assetObjects={observedAssetObjects}
    listings={conversationDisplays}
    request={displayWindowRequest}
    runsProcedures={object => procedureScopeForObject(object) !== null}
    procedureSummariesFor={procedureSummariesForObject}
    {openProcedureSystemAt}
    focusMap={focusMapTarget}
    close={closeDisplayWindow}
  />
{/if}

{#if ProcedureSystemModal && simulationRunId && procedureSession}
  {#each procedureSystemWindowModels as windowEntry (windowEntry.id)}
    <ProcedureSystemModal
      {simulationRunId}
      plantId={windowEntry.plantId}
      provider={windowEntry.provider}
      unitName={windowEntry.object.label}
      unitStatus={statusPresentationFor(windowEntry.object)}
      unitContexts={procedureUnitContexts}
      session={procedureSession}
      initialProcedureId={windowEntry.initialProcedureId}
      windowOffsetIndex={windowEntry.index}
      focusRequest={windowEntry.focusRequest ?? 0}
      aiStart={windowEntry.aiStart}
      selectUnit={(objectId: ObjectId) => retargetProcedureSystem(windowEntry.id, objectId)}
      openDisplay={(listing) => requestDisplayWindow({ kind: 'listing', listing }, true)}
      close={() => closeProcedureSystem(windowEntry.id)}
    />
  {/each}
{/if}

{#if processPlantArtifactModal && ProcessPlantArtifactModal && simulationRunId}
  {@const artifactSystemId = processPlantIdForObject(processPlantArtifactModal.object)}
  {#if artifactSystemId}
    <ProcessPlantArtifactModal
      {simulationRunId}
      plantId={artifactSystemId}
      artifact={processPlantArtifactModal.artifact}
      close={closeProcessPlantArtifact}
    />
  {/if}
{/if}

{#if processPlantCatalogModal && ProcessPlantCatalogModal && simulationRunId}
  <ProcessPlantCatalogModal
    {simulationRunId}
    close={closeProcessPlantCatalog}
  />
{/if}

{#if processPlantCredibilityModal && ProcessPlantCredibilityModal && simulationRunId}
  {@const credibilitySystemId = processPlantIdForObject(processPlantCredibilityModal)}
  {#if credibilitySystemId}
    <ProcessPlantCredibilityModal
      {simulationRunId}
      plantId={credibilitySystemId}
      close={closeProcessPlantCredibility}
    />
  {/if}
{/if}

{#if rolePicker}
  <RoleDialog
    mode="join"
    runTitle={rolePicker.runTitle}
    declaration={rolePicker.declaration}
    held={[]}
    hidden={hiddenRoleIds}
    initialHolders={rolePicker.holders}
    loadHolders={loadRoleHolders}
    describeCommands={undefined}
    apply={joinWithRoles}
    cancel={undefined}
  />
{/if}

{#if roleDialogOpen && runRoles && heldRoleIds}
  <RoleDialog
    mode="switch"
    runTitle={scenarioDefinition?.title ?? ''}
    declaration={runRoles}
    held={heldRoleIds}
    hidden={hiddenRoleIds}
    initialHolders={null}
    loadHolders={loadRoleHolders}
    describeCommands={describeRoleCommands}
    apply={applyRoleDialog}
    cancel={() => { roleDialogOpen = false }}
  />
{/if}

{#if startupModalVisible}
  <StartupModal
    steps={startupSteps}
    tone={systemStatusTone}
    retry={joinSimulationRun}
    close={closeStartupModal}
    autoCloseWhenReady={!startupStatusModalOpen}
    closeWhenReadyOnly={!startupStatusModalOpen}
  />
{/if}

{#if createDraft && CreateObjectModal}
  <CreateObjectModal {createDraft} {createObject} cancelCreate={placement.cancel} />
{/if}

{#if settingsModalOpen && SettingsModal}
  <SettingsModal
    {theme}
    weatherLayerAvailable={mapConfig?.layers.includes('weather') ?? false}
    {weatherLayerVisible}
    close={closeSettings}
    {goToStartPage}
    {toggleTheme}
    {toggleWeatherLayer}
    resetScenario={controllerControls ? resetScenario : null}
  />
{/if}
