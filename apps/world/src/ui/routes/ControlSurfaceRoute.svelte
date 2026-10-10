<script lang="ts">
  import { packDataChangedSchema } from '../../core/packs/protocol.ts'
  import type { MapView } from '../map-view.ts'
  import type { EmbeddedViewListing } from '@leitbild/contracts'
  import type { Component } from 'svelte'
  import { tick, untrack } from 'svelte'
  import type {
    IsoTimestamp,
    OperationalObject,
    SimulationRunId,
    ObjectId,
    ProcedureDocument,
    ProcedureId,
    ProcedureRunScope,
    ProcedureRunState,
    CompiledScenario,
    ScenarioExecutionState,
    SimulationClockState,
  } from '../../core/model/index.ts'
  import { deleteObjectCommandKind } from '../../core/model/index.ts'
  import { createPackPresentationComposer } from '../../core/packs/presentation-composer.ts'
  import type { PackCreateObjectType, PackMapAssignmentMode, PackMapAssignmentTarget, PackObjectPresentation, PackObjectPresentationTier, PackObjectStatusPresentation, PackPresentationContribution, PackProcedureContribution } from '../../core/packs/protocol.ts'
  import type { ActivePackViews } from '../../core/packs/active-views.ts'
  import {
    fetchScenario,
    joinSimulationRun as joinSimulationRunClient,
    resetSimulationRun,
    invokeSimulationRunCapability,
    fetchRunExecution,
    syncSimulationRunSnapshot as syncSimulationRunSnapshotClient,
  } from '../simulation-run-client.ts'
  import {
    parseControlSurfaceRoute,
  } from '../simulation-run-route.ts'
  import {
    applySimulationRunEventBatchMessage,
  } from '../simulation-run-events.ts'
  import { parseDroneMotionFramesRealtimeMessage, type DroneMotionFrame } from '../../packs/drone/realtime.ts'
  import { createMapFeatureLoader } from '../app/map-feature-loader.ts'
  import { installPlacementGlobalEvents } from '../app/placement-global-events.ts'
  import { createRealtimeConnectionController } from '../app/realtime-connection.ts'
  import { completeControlSurfaceStartupFromSnapshot } from '../app/control-surface-session.ts'
  import { loadActivePackViews } from '../pack-loader.ts'
  import {
    categoryRowsFor,
    placementCursorFor,
    selectedControllerObjectFor,
  } from '../control-surface-selectors.ts'
  import { createPlacementState } from '../placement-state.svelte.ts'
  import { createRailLayoutState } from '../rail-layout-state.svelte.ts'
  import { simulationTimeAt } from '../simulation-clock.ts'
  import { runOnMount } from '../svelte-lifecycle.svelte.ts'
  import ControlRail from '../ControlRail.svelte'
  import ScenarioGuidance from '../ScenarioGuidance.svelte'
  import StartupModal from '../StartupModal.svelte'
  import { processPlantIdForObject, type ProcessPlantArtifactKind } from '../process-display/process-display-client.ts'
  import type { DeckRunJoin, DisplayWindowRequest, DisplayWindowTarget } from '../process-display/display-deck.ts'
  import { displayWindowReadyMessage, readDisplayWindowHostMessage } from '../process-display/display-window-messages.ts'
  import { createProcedureSession, type ProcedureSession } from '../procedures/procedure-session.ts'
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
  import type { MapFocusRequest, MapFocusTarget, MapRuntimeDiagnosticsSnapshot } from '../map-runtime/types.ts'
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
  const emptyProcedureRunSummaries: ProcedureRunSummaryGroup = { active: [], inactive: [] }

  interface DroneWindowEntry {
    readonly id: string
    readonly objectId: ObjectId
  }

  type DroneMotionFrameConsumer = (frames: ReadonlyArray<DroneMotionFrame>) => void

  interface ProcedureSystemWindowEntry {
    readonly id: string
    readonly objectId: ObjectId
    readonly initialProcedureId?: ProcedureId
  }

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
  let scenarioDefinition = $state<CompiledScenario | null>(null)
  let selectedControllerId = $state<string | null>(null)
  let status = $state('Starting')
  let mapWarnings = $state('')
  let commandStatus = $state('')
  const routeMode = 'simulation-run'
  let seenRevisions = $state(new Map<string, number>())
  let expectedRealtimeScenarioId = $state<string | null>(null)
  let realtimeAttached = $state(false)
  let routeRevision = $state(0)
  let procedureRevision = $state(0)
  let packDataRevisions = $state<Record<string, number>>({})
  let packPanelSelections = $state<Record<string, string>>({})
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
      commandStatus = nextStatus
    },
  })
  const placementMode = $derived(placement.mode)
  const placementPoints = $derived(placement.points)
  const createDraft = $derived(placement.draft)
  const selectedControllerObject = $derived(activePack
    ? selectedControllerObjectFor(objects, selectedControllerId, activePack)
    : null)
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
  const railVisible = $derived(railConfig !== null)
  const footerVisible = true
  const guidanceOverlayVisible = true
  let categoryMapVisibility = $state<Record<string, boolean>>({})
  const surfacePanels = $derived(activePack?.surfacePanels ?? [])
  const surfacePanelLaunchers = $derived(surfacePanels.map(panel => ({ id: panel.id, label: panel.label, open: surfacePanelOpen[panel.id] ?? panel.defaultOpen })))
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
    ? mapAssignmentContribution.anchorFor(mapAssignmentController, mapAssignment.mode, { objects })
    : null)
  const mapAssignmentHandles = $derived(activePack ? activePack.packs.flatMap(pack => pack.mapAssignment?.handles({ objects }) ?? []) : [])
  const debugMapInput = $derived(new URLSearchParams(location.search).get('debugMapInput') === '1')
  const debugStartup = new URLSearchParams(location.search).get('debugStartup') === '1'
  const categoryRows = $derived<ReadonlyArray<CategoryRow>>(categoryRowsForStartingView(allCategoryRows, railConfig))
  const objectById = $derived(new Map(objects.map(object => [object.id, object])))
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
  const startupModalVisible = $derived(startupModalShouldShow({
    routeMode,
    dismissed: startupDismissed,
    steps: startupSteps,
  }) || startupStatusModalOpen)

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
        commandStatus,
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
      const module = await import('../process-display/ProcessPlantArtifactModal.svelte')
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
      const module = await import('../process-display/ProcessPlantCatalogModal.svelte')
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
      const module = await import('../process-display/ProcessPlantCredibilityModal.svelte')
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
      executionState = await fetchRunExecution(simulationRunId)
      if (executionState.pace === 'maximum') {
        clock = { currentTime: executionState.currentSimulationTime as IsoTimestamp, paused: true, updatedAt: executionState.updatedAt as IsoTimestamp }
      }
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
    if (processPlantIdForObject(object) === null) return
    requestDisplayWindow({ kind: 'overview', objectId: object.id }, true)
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

  // The window steps through the Plants' overviews in rail order; Plants the rail does not list follow.
  const processPlantObjects = $derived.by<ReadonlyArray<OperationalObject>>(() => {
    const inRail = categoryRows.flatMap(row => row.objects).filter(object => processPlantIdForObject(object) !== null)
    const railIds = new Set(inRail.map(object => object.id))
    return [...inRail, ...objects.filter(object => processPlantIdForObject(object) !== null && !railIds.has(object.id))]
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

  const openProcedureSystemAt = (object: OperationalObject, summary?: ProcedureRunSummary): void => {
    if (procedureScopeForObject(object) === null) return
    procedureSystemWindows = [
      ...procedureSystemWindows,
      {
        id: nextFloatingWindowId('procedure-system', object.id),
        objectId: object.id,
        ...(summary?.procedureId === undefined ? {} : { initialProcedureId: summary.procedureId }),
      },
    ]
    void loadProcedureSystemModal()
  }

  const openProcedureSystem = (object: OperationalObject): void => {
    openProcedureSystemAt(object)
  }

  const closeProcedureSystem = (windowId: string): void => {
    procedureSystemWindows = procedureSystemWindows.filter(entry => entry.id !== windowId)
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

  const loadScenarioDefinitionAndPackFromDefinition = async (scenario: CompiledScenario): Promise<CompiledScenario> => {
    markStartup('pack-load:start')
    const nextPack = await loadActivePackViews(scenario.packs)
    markStartup('pack-load:done')
    scenarioDefinition = scenario
    activePack = nextPack
    return scenario
  }

  const defaultName = (type: PackCreateObjectType): string => {
    const creation = requireActivePack().creation
    if (!creation) throw new Error(`no active Pack can create ${type.id}`)
    return creation.defaultObjectLabel(type.id, { objects })
  }

  const syncSimulationRunSnapshot = async (): Promise<void> => {
    if (!simulationRunId) return
    const body = await syncSimulationRunSnapshotClient(simulationRunId)
    objects = [...body.snapshot.objects]
    scenarioState = body.snapshot.scenario
    clock = body.snapshot.clock
  }

  const sendCommand = async (capabilityId: string, input: unknown): Promise<void> => {
    if (!simulationRunId) return
    let body
    try {
      body = await invokeSimulationRunCapability(simulationRunId, { capabilityId, input })
    } catch (err) {
      commandStatus = err instanceof Error ? err.message : 'command failed'
      return
    }
    if (body.kind !== 'command') {
      commandStatus = `Capability ${capabilityId} is not a command`
      return
    }
    if (!body.result.ok) {
      commandStatus = `Command rejected: ${body.result.reason ?? 'unknown reason'}`
      return
    }
    commandStatus = 'Command accepted'
    await syncSimulationRunSnapshot()
  }

  const cancelMapAssignment = (): void => {
    mapAssignment = null
    mapAssignmentPicker = null
    mapAssignmentChoiceIds = []
  }

  const beginMapAssignment = (controller: OperationalObject, mode: PackMapAssignmentMode): void => {
    if (!activePack) return
    const contribution = activePack.packForObject(controller).mapAssignment
    if (!contribution) return
    if (mode === 'start' && !contribution.canStart(controller, { objects })) {
      commandStatus = `${controller.label} is not available for a new assignment`
      return
    }
    placement.cancel()
    mapAssignment = { controllerId: controller.id, mode }
    mapAssignmentPicker = null
    mapAssignmentChoiceIds = []
    commandStatus = mode === 'start' ? `Choose an incident for ${controller.label}` : `Add a stop to ${controller.label}`
  }

  const submitMapAssignmentTarget = async (target: PackMapAssignmentTarget, choiceIds: ReadonlyArray<string>): Promise<void> => {
    if (choiceIds.length < target.minimumChoices || choiceIds.length > target.maximumChoices) {
      commandStatus = `Choose ${target.minimumChoices === target.maximumChoices ? target.minimumChoices : `${target.minimumChoices}–${target.maximumChoices}`} patients`
      return
    }
    const command = target.buildCommand(choiceIds)
    cancelMapAssignment()
    commandStatus = `Assigning ${target.label}`
    await sendCommand(command.kind, command.payload)
  }

  const chooseMapAssignmentTarget = (candidate: OperationalObject, screen: { readonly x: number; readonly y: number }): void => {
    if (!mapAssignment || !mapAssignmentController || !mapAssignmentContribution) return
    const target = mapAssignmentContribution.targetFor(mapAssignmentController, candidate, mapAssignment.mode, { objects })
    if (!target) {
      commandStatus = `${candidate.label} is not a valid next destination`
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
    commandStatus = `Deleting ${object.label}`
    await sendCommand(deleteObjectCommandKind, { objectId: object.id })
  }

  const createObject = async (draft: CreateDraft): Promise<void> => {
    placement.clearDraft()
    commandStatus = `Creating ${draft.objectType.label}`
    const pack = requireActivePack()
    if (!pack.creation) throw new Error('active Packs do not support object creation')
    const command = pack.creation.buildCreateObjectCommand(
      draft.objectType.id,
      draft.label.trim() || defaultName(draft.objectType),
      draft.geometry,
      draft.parameters,
    )
    await sendCommand(command.kind, command.payload)
  }

  const setDestination = async (destination: OperationalObject): Promise<void> => {
    const controller = selectedControllerObject
    if (!controller) {
      commandStatus = 'Select a controller first'
      return
    }
    if (destination.id === controller.id) return
    const pack = requireActivePack()
    if (!pack.targeting?.isTarget(controller, destination, { objects })) return
    commandStatus = `Sending ${controller.label} to ${destination.label}`
    const command = pack.targeting.buildSetTargetCommand(controller, destination, { objects })
    await sendCommand(command.kind, command.payload)
  }

  const selectObject = (object: OperationalObject): void => {
    markSeen(object)
    const pack = requireActivePack()
    if (pack.targeting?.isController(object)) {
      selectedControllerId = object.id
      commandStatus = `Selected ${object.label}; click a valid target`
      return
    }
    const controller = selectedControllerObject
    if (controller && pack.targeting?.isTarget(controller, object, { objects })) {
      void setDestination(object)
    }
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
        if (parsed.clock) clock = parsed.clock
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
        if (applied.commandStatusUpdate) {
          commandStatus = applied.commandStatusUpdate.commandStatus
        }
        if (applied.scenarioUpdate) {
          scenarioState = applied.scenarioUpdate
        }
        if (applied.clockUpdate) {
          clock = applied.clockUpdate
        }
        if (applied.routesChanged) {
          routeRevision += 1
        }
        if (parsed.events.some(event => event.type.startsWith('procedure.') || event.type === 'object.deleted')) {
          procedureRevision += 1
        }
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
    })
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
    if (location.pathname !== route.canonicalPath) history.replaceState(null, '', route.canonicalPath)
    return route.simulationRunId
  }

  const completeStartupFromResponse = async (
    response: SimulationRunResponse,
    config: {
      readonly setActiveStartupStep: (id: StartupStepId) => void
    },
  ): Promise<void> => {
    const scenarioId = response.snapshot.scenario?.scenarioId
    if (!scenarioId) throw new Error('simulation run snapshot is missing scenario state')
    const packScenario = scenarioDefinition?.id === scenarioId
      ? scenarioDefinition
      : response.scenario?.id === scenarioId
        ? await loadScenarioDefinitionAndPackFromDefinition(response.scenario)
        : await loadScenarioDefinitionAndPack(scenarioId)
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
        clock = nextClock
      },
      setExpectedRealtimeScenarioId: scenarioId => {
        expectedRealtimeScenarioId = scenarioId
      },
      setSelectedControllerId: id => {
        selectedControllerId = id
      },
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
      markStartup('join-request:start')
      const body = await joinSimulationRunClient(id)
      markStartup('join-request:done')
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
    realtimeAttached = false
    resetStartupForJoin()
    snapshotReady = false
    mapReady = false
    scenarioDefinition = null
    activePack = null
    status = 'Resetting'
    commandStatus = 'Resetting scenario'
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
      commandStatus = 'Scenario reset'
    } catch (err) {
      failStep(activeStartupStep, err)
      commandStatus = err instanceof Error ? err.message : 'Scenario reset failed'
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
        return
      }
      requestDisplayWindow({ kind: 'listing', listing: message.view }, false)
    }
    window.addEventListener('message', receiveDisplayWindowMessage)
    window.parent.postMessage(displayWindowReadyMessage(), location.origin)
    completeStep('route')
    completeStep('interface')
    preloadOperationalMapModule()
    void joinSimulationRun()
    const executionPoll = window.setInterval(() => { void refreshExecution() }, 1_000)
    return () => {
      window.removeEventListener('message', receiveDisplayWindowMessage)
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
      procedureSession = next
      next.subscribe(state => { procedureRuns = state.runs; procedureRunDocuments = state.documents })
    })
    return () => { next.dispose() }
  })

  $effect(() => {
    const session = procedureSession
    const revision = procedureRevision
    const hasProcessPlant = scenarioDefinition?.packs.includes('process-plant') === true
    if (!session || !hasProcessPlant) return
    let active = true
    untrack(() => {
      void session.refreshRuns().catch(error => {
        if (active) commandStatus = error instanceof Error ? error.message : String(error)
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
        {categoryMapVisibility}
        deferObjectRows={!richOperationalUiReady}
        {presentationFor}
        {detailPresentationFor}
        {hasNewInfo}
        {markSeen}
        {selectObject}
        {deleteObject}
        {openProcessDisplay}
        {openProcedureSystem}
        {openProcedureSystemAt}
        {openProcessPlantArtifact}
        {openProcessPlantCatalog}
        {openProcessPlantCredibility}
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
          {placementMode}
          {placementCursor}
          {placementPoints}
          {theme}
          mapConfig={effectiveMapConfig}
          {clock}
          {routeRevision}
          {debugMapInput}
          highlightedObjectIds={scenarioState?.highlightedObjectIds ?? emptyStringArray}
          {hiddenObjectCategoryIds}
          {hasNewInfo}
          presentationFor={mapPresentationFor}
          {mapFeaturesFor}
          onObjectSelected={selectObject}
          onPlacementPoint={placement.placePoint}
          onObjectSeen={markSeen}
          onMapReady={handleMapReady}
          onMapView={view => panelMapView = view}
          onMapError={handleMapError}
          onMapDiagnostic={handleMapDiagnostic}
          {simulationRunId}
          packDataRevisionKey={JSON.stringify(packDataRevisions)}
          onPackFeatureSelected={selection => { if (surfacePanels.some(panel => panel.id === selection.panelId)) { packPanelSelections = { ...packPanelSelections, [selection.panelId]: selection.itemId }; setSurfacePanelOpen(selection.panelId, true) } }}
          mapLayerGroups={activeMapLayerGroups}
          {mapLayerGroupVisibility}
          referenceStyles={activeReferenceStyles}
          packFeatureLayers={activePackFeatureLayers}
          packFeatureSourcePackIds={activePackFeatureSourcePackIds}
          focusRequest={mapFocusRequest}
          assignmentActive={mapAssignment !== null}
          assignmentAnchor={mapAssignmentAnchor}
          assignmentHandles={mapAssignmentHandles}
          onObjectLongPressed={object => beginMapAssignment(object, 'start')}
          onAssignmentHandleSelected={controllerId => { const controller = objects.find(object => object.id === controllerId); if (controller) beginMapAssignment(controller, 'append') }}
          onAssignmentObjectSelected={chooseMapAssignmentTarget}
          onAssignmentCancelled={cancelMapAssignment}
        />
      {:else if mapVisible}
        <div class="map-loading">Starting map...</div>
      {:else}
        <div class="surface-empty"></div>
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
      {#if richOperationalUiReady && simulationRunId}
        {#each surfacePanels as panel (panel.id)}
          {@const Panel = surfacePanelComponents[panel.id]}
          {#if (surfacePanelOpen[panel.id] ?? panel.defaultOpen) && Panel}
            <Panel {simulationRunId} {objects} mapView={panelMapView} dataRevision={packDataRevisions[panel.id.split('.')[0]! ] ?? 0} selectedItemId={packPanelSelections[panel.id] ?? null} onClose={() => setSurfacePanelOpen(panel.id, false)} onFocusMap={focusMapTarget} />
          {/if}
        {/each}
      {/if}
    </main>

    {#if guidanceOverlayVisible && scenarioState?.guidance}
    <ScenarioGuidance
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
    plantObjects={processPlantObjects}
    listings={conversationDisplays}
    request={displayWindowRequest}
    procedureSummariesFor={procedureSummariesForObject}
    {openProcedureSystemAt}
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
      selectUnit={(objectId: ObjectId) => retargetProcedureSystem(windowEntry.id, objectId)}
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
    {resetScenario}
  />
{/if}
