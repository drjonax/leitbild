<script lang="ts">
  import { BookOpen, Bug, Check, ChevronLeft, ChevronRight, ExternalLink, GripVertical, Info, MessageSquare, Play, RefreshCw, Star, X } from 'lucide-svelte'
  import { tick, untrack } from 'svelte'
  import type { ProcedureSession } from './procedure-session.ts'
  import { procedureBindingStatusWord, procedureComparisonText, procedureCsfChip, procedureDescriptionText, procedureDisplayReading, procedureElapsedText, procedureStepBindingSummary } from './procedure-view.ts'
  import { readProcedureTagValue } from './procedure-client.ts'
  import { procedureViewKey, procedureCategories, procedureStepItems, procedureStepTagBindings, procedureTextSegments, procedureBlockLabel, procedureObservationEvidence, procedureObservationBasis, procedureObservationLabel, procedureSourceEvidenceRequest, procedureUnitJump } from './procedure-view.ts'
  import type {
    SimulationRunId,
    ObjectId,
    ProcedureAssessment,
    ProcedureCatalog,
    ProcedureBranch,
    ProcedureDocument,
    ProcedureId,
    ProcedureRunScope,
    ProcedureRunState,
    ProcedureStep,
    ProcedureStepId,
    ProcedureStepRunState,
    ProcedureTag,
    ProcedureTagId,
  } from '../../core/model/index.ts'
  import type { PackObjectStatusPresentation, PackProcedureContribution } from '../../core/packs/protocol.ts'
  import StatusIndicator from '../components/StatusIndicator.svelte'
  import { runOnMount } from '../svelte-lifecycle.svelte.ts'
  import ProcedureRunBadges from './ProcedureRunBadges.svelte'
  import { procedureDialog } from './procedure-dialog.ts'
  import ProcedureTagDisplay from './ProcedureTagDisplay.svelte'
  import type { EmbeddedViewListing } from '@leitbild/contracts'
  import {
    closeProcedureRun,
    driveProcedureRun,
    transitionProcedureRun,
    evaluateProcedureCsfs,
    readProcedureSourceEvidence,
    resetProcedureRun,
    startProcedureRun,
    updateProcedureStep,
    validateProcedureTags,
    type ProcedureCsfEvaluation,
    type ProcedureTagValidation,
    type ProcedureSourceEvidence,
    type ProcedureSourceEvidenceRequest,
  } from './procedure-client.ts'
  import {
    furthestTouchedStep,
    procedureCurrentStep,
    procedureBranchActionText,
    procedureActorIsAi,
    procedureActorLabel,
    procedureCompletionWarning,
    procedureDecisionTargetText,
    procedureDecisionTone,
    procedureDriverView,
    procedureFirstStep,
    procedureOffPathConfirmation,
    procedurePlantTime,
    procedureStepRangeText,
    procedureStepRows,
    procedureRunFor,
    procedureRunSummariesForScope,
    procedureRunVisualStateFor as selectedProcedureRunVisualStateFor,
    procedureStepById,
    procedureStepDisplayName,
    procedureStepHoverLabel,
    type ProcedureRunSummary,
    type ProcedureRunVisualState,
  } from './procedure-run-selectors.ts'
  import {
    floatingWindowBoundsForDrag,
    normalizeFloatingWindowBounds,
    type FloatingWindowBounds,
    type FloatingWindowDragMode,
  } from '../window-bounds.ts'

  interface Props {
    readonly simulationRunId: SimulationRunId
    readonly plantId: string
    readonly provider: PackProcedureContribution
    readonly unitName?: string
    readonly unitStatus?: PackObjectStatusPresentation
    readonly unitContexts?: ReadonlyArray<ProcedureUnitContext>
    readonly session: ProcedureSession
    readonly initialProcedureId?: ProcedureId
    readonly windowOffsetIndex?: number
    /** Raised by the route when this unit's procedures are opened again: focus this window (and its requested procedure). */
    readonly focusRequest?: number
    readonly selectUnit: (objectId: ObjectId) => void
    /** Opens a display in the Workspace's process display window, where it can be operated. */
    readonly openDisplay?: (listing: EmbeddedViewListing) => void
    readonly close: () => void
  }

  interface ProcedureUnitContext {
    readonly plantId: string
    readonly provider?: PackProcedureContribution
    readonly targetObjectId?: ObjectId
    readonly label: string
    readonly status?: PackObjectStatusPresentation
  }

  type LoadStageId = 'source' | 'runs' | 'document' | 'tags' | 'csfs'
  type LoadStageStatus = 'pending' | 'running' | 'done' | 'failed'
  type ProcedureTocMode = 'detail' | 'compact' | 'collapsed'
  type ProcedureConfirmation = 'run' | 'completed' | 'reset' | 'transition' | 'off-path'

  interface ProcedureWindowDragState {
    readonly pointerId: number
    readonly mode: FloatingWindowDragMode
    readonly pointerStart: { readonly x: number; readonly y: number }
    readonly origin: FloatingWindowBounds
  }


  interface LoadStage {
    readonly id: LoadStageId
    readonly label: string
    readonly status: LoadStageStatus
    readonly detail?: string
  }

  interface ProcedureTransition {
    readonly sourceRunId: ProcedureRunState['runId']
    readonly fromProcedure: ProcedureDocument
    readonly fromStep: ProcedureStep
    readonly branch: ProcedureBranch
    readonly targetProcedure: ProcedureDocument
    readonly targetStep: ProcedureStep
  }

  interface ProcedureToast {
    readonly message: string
    readonly placement: 'corner' | 'center'
    readonly tone: 'notice' | 'success' | 'transition'
    readonly durationMs: number
  }

  let {
    simulationRunId,
    plantId,
    provider,
    unitName = undefined,
    unitStatus = undefined,
    unitContexts = [],
    session,
    initialProcedureId = undefined,
    windowOffsetIndex = 0,
    focusRequest = 0,
    selectUnit,
    openDisplay = undefined,
    close,
  }: Props = $props()

  const minWindowWidth = 48
  const minWindowHeight = 32
  const viewportMargin = 12
  const windowOffsetStepPx = 32
  const minProcedureFontScale = 0.65
  const maxProcedureFontScale = 1.6
  const procedureFontScaleStep = 0.1

  let loading = $state(true)
  let refreshing = $state(false)
  let error = $state<string | null>(null)
  let catalog = $state<ProcedureCatalog | null>(null)
  let document = $state<ProcedureDocument | null>(null)
  let runs = $state<ReadonlyArray<ProcedureRunState>>([])
  let runDocuments = $state<ReadonlyMap<string, ProcedureDocument>>(new Map())
  let selectedProcedureId = $state<string | null>(null)
  let loadingProcedureId = $state<string | null>(null)
  let confirmation = $state<ProcedureConfirmation | null>(null)
  let tagValidation = $state<ReadonlyMap<string, ProcedureTagValidation>>(new Map())
  let csfEvaluations = $state<ReadonlyMap<string, ProcedureCsfEvaluation>>(new Map())
  let csfError = $state<string | null>(null)
  let csfReadAt = $state<string | null>(null)
  let csfPresentationTime = $state(Date.now())
  let basisRequest = $state<ProcedureSourceEvidenceRequest | null>(null)
  let basisEvidence = $state<ProcedureSourceEvidence | null>(null)
  let basisError = $state<string | null>(null)
  let basisLoading = $state(false)
  let basisReadGeneration = 0
  let openTagId = $state<ProcedureTagId | null>(null)
  let commentOpen = $state<Record<string, boolean>>({})
  let summaryOpen = $state(false)
  let openStepInfoId = $state<string | null>(null)
  /** Live values of the open step ⓘ's tags, read when it opened. */
  let stepInfoReadings = $state<Record<string, { readonly formatted?: string; readonly error?: string }>>({})
  let stepInfoGeneration = 0
  /** Decided steps and bypassed groups the person opened, by view key; the rest stay folded. */
  let expandedSteps = $state<Record<string, boolean>>({})
  let commentDrafts = $state<Record<string, string>>({})
  let pendingTransition = $state<ProcedureTransition | null>(null)
  let pendingOffPath = $state<{ readonly from: ProcedureStep; readonly branch: ProcedureBranch } | null>(null)
  let procedureToast = $state<ProcedureToast | null>(null)
  let loadStages = $state<Record<LoadStageId, LoadStage>>(createLoadStages())
  let procedureTocMode = $state<ProcedureTocMode>('detail')
  let procedureFontScale = $state(1)
  let windowBounds = $state<FloatingWindowBounds>({ x: 48, y: 48, width: 1500, height: 940 })
  let windowDragState = $state<ProcedureWindowDragState | null>(null)
  /** The control whose write is on its way; it shows Recording… and every other write waits. */
  let pendingControl = $state<string | null>(null)
  let boundsInitialized = false
  let csfRefreshInFlight = false
  let toastTimer: number | null = null
  let latestProcedureLoadRequest = 0
  let observationScopeKey: string | undefined
  let disposed = false
  let releasePrefetch: (() => void) | null = null
  let scrollFrame: number | null = null
  let catalogRequest = 0
  let procedureDocumentBodyElement = $state<HTMLDivElement | null>(null)
  let procedureWindowElement = $state<HTMLDivElement | null>(null)
  /** The unit the shown document was loaded for; its scroll position is remembered under that unit. */
  let documentScope: ProcedureRunScope | null = null
  const procedureScrollPositions = new Map<string, number>()

  const currentUnitContext = $derived(unitContexts.find(unit => unit.plantId === plantId) ?? {
    plantId: plantId,
    label: unitName ?? plantId,
    ...(unitStatus === undefined ? {} : { status: unitStatus }),
  } satisfies ProcedureUnitContext)
  const currentScope = $derived(procedureScopeFor(currentUnitContext))
  const currentProvider = $derived(currentUnitContext.provider ?? provider)
  const procedureUnits = $derived(unitContexts.length > 0 ? unitContexts : [currentUnitContext])
  const selectedProcedureRun = $derived(document ? procedureRunFor(runs, {
    sourceId: document.source.sourceId,
    procedureId: document.procedureId,
    scope: currentScope,
  }) : null)
  const activeRun = $derived(selectedProcedureRun?.status === 'active' ? selectedProcedureRun : null)
  const completedRun = $derived(selectedProcedureRun?.status === 'completed' ? selectedProcedureRun : null)
  const selectedRun = $derived(activeRun)
  const procedureLoadPanelVisible = $derived(loading || (error !== null && (catalog === null || document === null)))
  const stepStates = $derived(new Map((selectedProcedureRun?.stepStates ?? []).map(state => [state.stepId, state])))
  const currentProcedureStep = $derived(document && selectedProcedureRun
    ? procedureCurrentStep(selectedProcedureRun, document)
    : null)
  const driverView = $derived(procedureDriverView(selectedProcedureRun))
  const busy = $derived(pendingControl !== null)
  const procedureRows = $derived(document ? procedureStepRows(document, selectedProcedureRun) : [])
  const catalogCategories = $derived(procedureCategories(catalog?.procedures ?? []))
  const sourceLabel = $derived(catalog
    ? `${catalog.source.repository}@${catalog.source.revision.slice(0, 8)}`
    : 'Procedure source')
  const displayUnitName = $derived(currentUnitContext.label)
  const displayUnitStatus = $derived(currentUnitContext.status ?? unitStatus ?? {
    tone: 'idle',
    label: 'Unit status unavailable',
    indicator: { shape: 'dot' },
  } satisfies PackObjectStatusPresentation)
  const csfIds = $derived([...new Set(catalog?.procedures.flatMap(item => item.csfsMonitored) ?? [])])

  const procedureRunVisualStateFor = (procedureId: string): ProcedureRunVisualState => {
    return selectedProcedureRunVisualStateFor(runs, {
      ...(catalog ? { sourceId: catalog.source.sourceId } : {}),
      procedureId: procedureId as ProcedureId,
      scope: currentScope,
    })
  }

  const cycleProcedureTocMode = (): void => {
    if (procedureTocMode === 'detail') {
      procedureTocMode = 'compact'
      return
    }
    if (procedureTocMode === 'compact') {
      procedureTocMode = 'collapsed'
      return
    }
    procedureTocMode = 'detail'
  }

  const defaultWindowBounds = (): FloatingWindowBounds => {
    if (typeof window === 'undefined') return windowBounds
    const width = Math.max(minWindowWidth, Math.min(1500, window.innerWidth - 2 * viewportMargin))
    const height = Math.max(minWindowHeight, Math.min(940, window.innerHeight - 2 * viewportMargin))
    const offset = windowOffsetIndex * windowOffsetStepPx
    return {
      x: Math.max(viewportMargin, Math.round((window.innerWidth - width) / 2) + offset),
      y: Math.max(viewportMargin, Math.round((window.innerHeight - height) / 2) + offset),
      width,
      height,
    }
  }

  const clampWindowBounds = (bounds: FloatingWindowBounds): FloatingWindowBounds => {
    if (typeof window === 'undefined') return bounds
    return normalizeFloatingWindowBounds(bounds, {
      width: window.innerWidth,
      height: window.innerHeight,
    }, {
      minWidth: minWindowWidth,
      minHeight: minWindowHeight,
      margin: viewportMargin,
    })
  }

  const nextBoundsForDrag = (
    drag: ProcedureWindowDragState,
    event: PointerEvent,
  ): FloatingWindowBounds => {
    if (typeof window === 'undefined') return drag.origin
    return floatingWindowBoundsForDrag({
      mode: drag.mode,
      origin: drag.origin,
      dx: event.clientX - drag.pointerStart.x,
      dy: event.clientY - drag.pointerStart.y,
    }, {
      width: window.innerWidth,
      height: window.innerHeight,
    }, {
      minWidth: minWindowWidth,
      minHeight: minWindowHeight,
      margin: viewportMargin,
    })
  }

  const startWindowDrag = (event: PointerEvent, mode: FloatingWindowDragMode): void => {
    if (event.button !== 0) return
    const target = event.target
    if (target instanceof Element && target.closest('button, a, textarea, input, .procedure-csf-shell, .procedure-run-badges')) return
    event.preventDefault()
    const element = event.currentTarget as Element
    element.setPointerCapture(event.pointerId)
    windowDragState = {
      pointerId: event.pointerId,
      mode,
      pointerStart: { x: event.clientX, y: event.clientY },
      origin: windowBounds,
    }
  }

  const updateWindowDrag = (event: PointerEvent): void => {
    const drag = windowDragState
    if (!drag || drag.pointerId !== event.pointerId) return
    windowBounds = nextBoundsForDrag(drag, event)
  }

  const finishWindowDrag = (event: PointerEvent): void => {
    const drag = windowDragState
    if (!drag || drag.pointerId !== event.pointerId) return
    windowBounds = nextBoundsForDrag(drag, event)
    windowDragState = null
  }

  const increaseProcedureFontSize = (): void => {
    procedureFontScale = Math.min(maxProcedureFontScale, Math.round((procedureFontScale + procedureFontScaleStep) * 10) / 10)
  }

  const decreaseProcedureFontSize = (): void => {
    procedureFontScale = Math.max(minProcedureFontScale, Math.round((procedureFontScale - procedureFontScaleStep) * 10) / 10)
  }

  const procedureTocModeLabel = (): string => {
    if (procedureTocMode === 'detail') return 'Show compact procedure list'
    if (procedureTocMode === 'compact') return 'Collapse procedure list'
    return 'Open procedure list'
  }

  function createLoadStages(): Record<LoadStageId, LoadStage> {
    return {
      source: { id: 'source', label: 'Discover procedure catalog', status: 'pending' },
      runs: { id: 'runs', label: 'Read active runs', status: 'pending' },
      document: { id: 'document', label: 'Load selected procedure', status: 'pending' },
      tags: { id: 'tags', label: 'Resolve plant tags', status: 'pending' },
      csfs: { id: 'csfs', label: 'Evaluate critical safety functions', status: 'pending' },
    }
  }

  function procedureScopeFor(unit: ProcedureUnitContext): ProcedureRunScope {
    return { plantId: unit.plantId,
      ...(unit.targetObjectId === undefined ? {} : { targetObjectId: unit.targetObjectId }), label: unit.label }
  }

  const documentRequest = (procedureId: string, sourceConfig: {
    readonly sourceId?: string; readonly sourceRevision?: string; readonly sourcePath?: string
  } = {}) => {
    const sourceId = sourceConfig.sourceId ?? catalog?.source.sourceId
    const sourceRevision = sourceConfig.sourceRevision ?? catalog?.source.revision
    if (!sourceId || !sourceRevision) throw new Error('procedure catalog is not loaded')
    const sourcePath = sourceConfig.sourcePath ?? (sourceRevision === catalog?.source.revision
      ? catalog.procedures.find(item => item.procedureId === procedureId)?.sourcePath : undefined)
    return { sourceId, sourceRevision, procedureId, ...(sourcePath === undefined ? {} : { sourcePath }) }
  }

  const readDocumentFor = (procedureId: string, sourceConfig: {
    readonly sourceId?: string; readonly sourceRevision?: string; readonly sourcePath?: string
  } = {}) => session.readDocument(documentRequest(procedureId, sourceConfig))

  const unitProcedureSummariesFor = (unit: ProcedureUnitContext): {
    readonly active: ReadonlyArray<ProcedureRunSummary>
    readonly completed: ReadonlyArray<ProcedureRunSummary>
  } =>
    procedureRunSummariesForScope(runs, procedureScopeFor(unit), runDocuments)

  const statusForUnit = (unit: ProcedureUnitContext): PackObjectStatusPresentation =>
    unit.status ?? (unit.plantId === plantId ? displayUnitStatus : {
      tone: 'idle',
      label: 'Unit status unavailable',
      indicator: { shape: 'dot' },
    })

  const setLoadStage = (id: LoadStageId, status: LoadStageStatus, detail?: string): void => {
    loadStages = {
      ...loadStages,
      [id]: {
        ...loadStages[id],
        status,
        ...(detail === undefined ? {} : { detail }),
      },
    }
  }

  const errorMessage = (err: unknown): string =>
    err instanceof Error ? err.message : String(err)

  const branchControlKey = (step: ProcedureStep, branch: ProcedureBranch): string =>
    `branch:${step.id}:${step.branches.indexOf(branch)}`

  // One write at a time: its control says Recording… until World answers.
  const recording = async (control: string, write: () => Promise<void>): Promise<void> => {
    if (pendingControl !== null) return
    pendingControl = control
    try { await write() }
    finally { if (!disposed) pendingControl = null }
  }

  const procedureLoadRows = $derived<ReadonlyArray<LoadStage>>([
    loadStages.source,
    loadStages.runs,
    loadStages.document,
    loadStages.tags,
    loadStages.csfs,
  ])

  const assessmentClass = (state: ProcedureStepRunState | undefined): string =>
    state?.assessment ?? 'blank'

  const loadCatalogAndRuns = async (refresh = false): Promise<void> => {
    const request = ++catalogRequest
    try {
      releasePrefetch?.()
      releasePrefetch = null
      loading = document === null
      refreshing = refresh
      error = null
      loadStages = createLoadStages()
      setLoadStage('source', 'running', refresh ? 'Refreshing manifest' : 'Reading manifest')
      setLoadStage('runs', 'running')
      const [nextCatalog] = await Promise.all([session.readCatalog(refresh), session.refreshRuns()])
      if (disposed || request !== catalogRequest) return
      catalog = nextCatalog
      setLoadStage('source', 'done', `${nextCatalog.procedures.length} procedures available`)
      setLoadStage('runs', 'done', `${runs.length} tracked runs`)
      selectedProcedureId = selectedProcedureId ?? initialProcedureId ?? nextCatalog.procedures[0]?.procedureId ?? null
      if (selectedProcedureId) await loadProcedure(selectedProcedureId, !loading)
      if (disposed || request !== catalogRequest) return
    } catch (err) {
      if (disposed || request !== catalogRequest) return
      error = errorMessage(err)
      const activeStage = procedureLoadRows.find(stage => stage.status === 'running')
      if (activeStage) setLoadStage(activeStage.id, 'failed', error)
    } finally {
      if (!disposed && request === catalogRequest) {
        loading = false
        refreshing = false
      }
    }
  }

  const refreshRuns = async (): Promise<void> => {
    try { await session.refreshRuns() }
    catch (err) { if (!disposed) error = errorMessage(err) }
  }

  const loadProcedure = async (
    procedureId: string,
    showSelectionLoading = true,
    sourceConfig: {
      readonly sourceId?: string
      readonly sourceRevision?: string
      readonly sourcePath?: string
      readonly rememberCurrentPosition?: boolean
    } = {},
  ): Promise<void> => {
    const requestId = ++latestProcedureLoadRequest
    const targetUnit = currentUnitContext
    const targetScope = procedureScopeFor(targetUnit)
    try {
      if (sourceConfig.rememberCurrentPosition !== false) rememberCurrentProcedureScroll()
      error = null
      confirmation = null
      pendingTransition = null
      pendingOffPath = null
      closeTag()
      tagValidation = new Map()
      csfEvaluations = new Map()
      csfReadAt = null
      csfError = null
      selectedProcedureId = procedureId
      setLoadStage('document', 'running', procedureId)
      const sourceId = sourceConfig.sourceId ?? catalog?.source.sourceId
      const currentRun = procedureRunFor(runs, {
        ...(sourceId === undefined ? {} : { sourceId }),
        procedureId: procedureId as ProcedureId,
        scope: targetScope,
      })
      const sourceRevision = sourceConfig.sourceRevision ?? currentRun?.sourceRevision
      const sourcePath = sourceConfig.sourcePath ?? currentRun?.sourcePath
      const resolvedSourceConfig = {
        ...(sourceId === undefined ? {} : { sourceId }),
        ...(sourceRevision === undefined ? {} : { sourceRevision }),
        ...(sourcePath === undefined ? {} : { sourcePath }),
      }
      if (showSelectionLoading && !session.cachedDocument(documentRequest(procedureId, resolvedSourceConfig))) {
        loadingProcedureId = procedureId
      }
      const nextDocument = await readDocumentFor(procedureId as ProcedureId, resolvedSourceConfig)
      if (disposed || requestId !== latestProcedureLoadRequest) return
      const unitChanged = documentScope !== null && documentScope.plantId !== targetScope.plantId
      document = nextDocument
      documentScope = targetScope
      loading = false
      if (catalog && !releasePrefetch) releasePrefetch = session.retainPrefetch(catalog)
      loadingProcedureId = null
      setLoadStage('document', 'done', `${nextDocument.steps.length} steps`)
      await restoreProcedurePosition(nextDocument, targetScope, requestId, unitChanged)
      if (disposed || requestId !== latestProcedureLoadRequest) return
      const loadTagValidation = async (): Promise<ReadonlyMap<string, ProcedureTagValidation>> => {
        try {
          setLoadStage('tags', 'running', `${nextDocument.tags.length} tags`)
          const nextTagValidation = await validateProcedureTags(simulationRunId, targetUnit.plantId, nextDocument.tags, targetUnit.provider ?? provider)
          const missingCount = [...nextTagValidation.values()].filter(validation => validation.status === 'missing').length
          if (!disposed && requestId === latestProcedureLoadRequest) setLoadStage('tags', 'done', missingCount === 0
            ? `${nextDocument.tags.length} tags resolved`
            : `${nextDocument.tags.length - missingCount}/${nextDocument.tags.length} tags resolved`)
          return nextTagValidation
        } catch (err) {
          if (!disposed && requestId === latestProcedureLoadRequest) setLoadStage('tags', 'failed', errorMessage(err))
          throw err
        }
      }
      const loadCsfEvaluations = async (): Promise<ReadonlyMap<string, ProcedureCsfEvaluation>> => {
        try {
          setLoadStage('csfs', 'running', `${csfIds.length} functions`)
          const nextCsfEvaluations = csfIds.length > 0
            ? await evaluateProcedureCsfs(simulationRunId, targetUnit.plantId, csfIds, targetUnit.provider ?? provider)
            : new Map<string, ProcedureCsfEvaluation>()
          if (!disposed && requestId === latestProcedureLoadRequest) setLoadStage('csfs', 'done', `${nextCsfEvaluations.size} functions evaluated`)
          return nextCsfEvaluations
        } catch (err) {
          if (!disposed && requestId === latestProcedureLoadRequest) setLoadStage('csfs', 'failed', errorMessage(err))
          throw err
        }
      }
      const [nextTagValidation, nextCsfEvaluations] = await Promise.all([
        loadTagValidation(),
        loadCsfEvaluations(),
      ])
      if (disposed || requestId !== latestProcedureLoadRequest) return
      tagValidation = nextTagValidation
      csfEvaluations = nextCsfEvaluations
      csfReadAt = new Date().toISOString()
    } catch (err) {
      if (disposed || requestId !== latestProcedureLoadRequest) return
      error = errorMessage(err)
      selectedProcedureId = document?.procedureId ?? null
    } finally {
      if (!disposed && requestId === latestProcedureLoadRequest) loadingProcedureId = null
    }
  }

  const startSelectedProcedure = async (): Promise<void> => {
    const current = document
    const request = latestProcedureLoadRequest
    if (!current) return
    await recording('run', async () => { try {
      await startProcedureRun(simulationRunId, {
        sourceId: current.source.sourceId,
        sourceRevision: current.source.revision,
        procedureId: current.procedureId,
        scope: currentScope,
      })
      await refreshRuns()
    } catch (err) {
      if (!disposed && request === latestProcedureLoadRequest) error = errorMessage(err)
    } })
  }

  const closeActiveRun = async (status: 'completed' | 'abandoned'): Promise<boolean> => {
    const request = latestProcedureLoadRequest
    if (!activeRun) return false
    try {
      await closeProcedureRun(simulationRunId, { runId: activeRun.runId, status })
      await refreshRuns()
      return !disposed && request === latestProcedureLoadRequest
    } catch (err) {
      if (!disposed && request === latestProcedureLoadRequest) error = errorMessage(err)
      return false
    }
  }

  const draftKey = (stepId: string): string => `${document ? procedureViewKey(document, currentScope) : ''}:${stepId}`

  const setStepExpanded = (stepId: string, expanded: boolean): void => {
    expandedSteps = { ...expandedSteps, [draftKey(stepId)]: expanded }
  }

  const rememberCurrentProcedureScroll = (): void => {
    if (!document || !documentScope || !procedureDocumentBodyElement) return
    procedureScrollPositions.set(
      procedureViewKey(document, documentScope),
      procedureDocumentBodyElement.scrollTop,
    )
  }

  const scrollToProcedureStep = (
    stepId: string,
    behavior: ScrollBehavior = 'smooth',
  ): void => {
    const request = latestProcedureLoadRequest
    if (scrollFrame !== null) window.cancelAnimationFrame(scrollFrame)
    scrollFrame = window.requestAnimationFrame(() => {
      if (disposed || request !== latestProcedureLoadRequest) return
      const stepElement = [...(procedureDocumentBodyElement?.querySelectorAll<HTMLElement>('[data-procedure-step-id]') ?? [])]
        .find(element => element.dataset.procedureStepId === stepId)
      stepElement?.scrollIntoView({
        block: 'start',
        behavior,
      })
    })
  }

  const restoreProcedurePosition = async (
    nextDocument: ProcedureDocument,
    scope: ProcedureRunScope,
    requestId = latestProcedureLoadRequest,
    unitChanged = false,
  ): Promise<void> => {
    await tick()
    if (disposed || requestId !== latestProcedureLoadRequest || !procedureDocumentBodyElement) return
    const run = procedureRunFor(runs, {
      sourceId: nextDocument.source.sourceId,
      procedureId: nextDocument.procedureId,
      scope,
    })
    const sharedStep = run ? procedureCurrentStep(run, nextDocument) : null
    if (sharedStep) {
      scrollToProcedureStep(sharedStep.step.id, 'auto')
      return
    }
    // A unit hop opens where that unit stands, else at the top: never at another unit's place.
    procedureDocumentBodyElement.scrollTop = unitChanged ? 0 : procedureScrollPositions.get(
      procedureViewKey(nextDocument, scope),
    ) ?? 0
  }

  const openProcedureRunSummary = async (summary: ProcedureRunSummary, unit: ProcedureUnitContext): Promise<void> => {
    const request = ++latestProcedureLoadRequest
    confirmation = null
    pendingTransition = null
    pendingOffPath = null
    try {
      rememberCurrentProcedureScroll()
      if (unit.targetObjectId === undefined) throw new Error('procedure unit requires a target object')
      selectUnit(unit.targetObjectId)
      await tick()
      if (disposed || request !== latestProcedureLoadRequest) return
      await loadProcedure(summary.procedureId, true, {
        sourceId: summary.run.sourceId,
        sourceRevision: summary.run.sourceRevision,
        sourcePath: summary.run.sourcePath,
        rememberCurrentPosition: false,
      })
    } catch (err) {
      if (!disposed && request === latestProcedureLoadRequest) error = errorMessage(err)
    }
  }

  // A unit in the strip opens where that unit stands: the same procedure where it runs it,
  // else its first active procedure, else the same procedure there, not yet run.
  const jumpToUnit = async (unit: ProcedureUnitContext): Promise<void> => {
    const jump = procedureUnitJump(unitProcedureSummariesFor(unit).active, document?.procedureId ?? null)
    if (unit.plantId === plantId) {
      if (jump.kind === 'run' && jump.summary.procedureId !== document?.procedureId) await openProcedureRunSummary(jump.summary, unit)
      else if (currentProcedureStep) scrollToProcedureStep(currentProcedureStep.step.id)
      return
    }
    if (jump.kind === 'run') {
      await openProcedureRunSummary(jump.summary, unit)
      return
    }
    if (unit.targetObjectId === undefined) {
      error = 'procedure unit requires a target object'
      return
    }
    // The scope effect reloads the selected procedure for the new unit.
    rememberCurrentProcedureScroll()
    selectUnit(unit.targetObjectId)
  }

  const targetDocumentForBranch = (branch: ProcedureBranch): ProcedureDocument | undefined =>
    branch.targetKind === 'procedure' && document
      ? session.cachedDocument({ sourceId: document.source.sourceId, sourceRevision: document.source.revision, procedureId: branch.target })
      : undefined

  const branchActionTextFor = (branch: ProcedureBranch): string => {
    if (branch.targetKind === 'end') return 'End this procedure run'
    if (branch.targetKind === 'retry') return 'Repeat this step'
    if (branch.targetKind === 'abort') return 'Abort this procedure run'
    if (!document) return branch.target
    const targetDocument = targetDocumentForBranch(branch)
    if (targetDocument) {
      const targetRun = procedureRunFor(runs, { sourceId: targetDocument.source.sourceId, procedureId: targetDocument.procedureId, scope: currentScope })
      if (targetRun && (targetRun.status === 'active' || targetRun.status === 'transferred')
        && targetRun.sourceRevision === targetDocument.source.revision && targetRun.sourcePath === targetDocument.sourcePath) {
        const destination = procedureCurrentStep(targetRun, targetDocument)?.step
        if (destination) return `${targetRun.status === 'transferred' ? 'Resume' : 'Go to'} ${targetDocument.procedureId}, step ${destination.label}: ${procedureStepDisplayName(destination)}`
      }
    }
    return procedureBranchActionText({ currentDocument: document, branch,
      ...(targetDocument === undefined ? {} : { targetDocument }) })
  }

  const showProcedureToast = (
    message: string,
    config: {
      readonly placement?: ProcedureToast['placement']
      readonly tone?: ProcedureToast['tone']
      readonly durationMs?: number
    } = {},
  ): void => {
    if (toastTimer !== null) window.clearTimeout(toastTimer)
    procedureToast = {
      message,
      placement: config.placement ?? 'corner',
      tone: config.tone ?? 'notice',
      durationMs: config.durationMs ?? 10_000,
    }
    toastTimer = window.setTimeout(() => {
      procedureToast = null
      toastTimer = null
    }, procedureToast.durationMs)
  }

  const cancelConfirmation = (): void => {
    confirmation = null
    pendingTransition = null
    pendingOffPath = null
  }

  const completeStepAndJump = async (fromStep: ProcedureStep, branch: ProcedureBranch): Promise<void> => {
    if (!selectedRun || !document || branch.targetKind !== 'step') return
    const targetStep = procedureStepById(document, branch.target)
    if (!targetStep) {
      error = `Procedure branch target step not found: ${branch.target}`
      return
    }
    await transitionProcedureRun(simulationRunId, { runId: selectedRun.runId, stepId: fromStep.id, branchIndex: fromStep.branches.indexOf(branch) })
    await refreshRuns()
    scrollToProcedureStep(targetStep.id)
  }

  const openProcedureTransition = async (fromStep: ProcedureStep, branch: ProcedureBranch): Promise<void> => {
    if (!selectedRun || !document || branch.targetKind !== 'procedure') return
    const sourceRunId = selectedRun.runId
    const request = latestProcedureLoadRequest
    try {
      const targetProcedure = await readDocumentFor(branch.target as ProcedureId, {
        sourceId: document.source.sourceId,
        sourceRevision: document.source.revision,
      })
      if (disposed || request !== latestProcedureLoadRequest) return
      const targetRun = procedureRunFor(runs, { sourceId: targetProcedure.source.sourceId, procedureId: targetProcedure.procedureId, scope: currentScope })
      const targetStep = branch.targetStepId !== undefined ? procedureStepById(targetProcedure, branch.targetStepId)
        : targetRun && (targetRun.status === 'active' || targetRun.status === 'transferred')
        && targetRun.sourceRevision === targetProcedure.source.revision && targetRun.sourcePath === targetProcedure.sourcePath
        ? procedureCurrentStep(targetRun, targetProcedure)?.step
        : procedureFirstStep(targetProcedure)
      if (!targetStep) {
        error = `Procedure ${targetProcedure.procedureId} has no steps to enter.`
        return
      }
      pendingTransition = {
        sourceRunId,
        fromProcedure: document,
        fromStep,
        branch,
        targetProcedure,
        targetStep,
      }
      confirmation = 'transition'
    } catch (err) {
      if (!disposed && request === latestProcedureLoadRequest) error = errorMessage(err)
    }
  }

  // Only the current step's branches act at once; another step's branch first says
  // where the Run stands and where the branch takes it.
  const branchIsOffPath = (step: ProcedureStep): boolean =>
    currentProcedureStep !== null && currentProcedureStep.step.id !== step.id

  const requestBranch = async (fromStep: ProcedureStep, branch: ProcedureBranch): Promise<void> => {
    if (!selectedRun || busy) return
    if (branch.targetKind !== 'procedure' && branchIsOffPath(fromStep)) {
      pendingOffPath = { from: fromStep, branch }
      confirmation = 'off-path'
      return
    }
    await activateBranch(fromStep, branch)
  }

  const activateBranch = async (fromStep: ProcedureStep, branch: ProcedureBranch): Promise<void> => {
    if (!selectedRun || busy) return
    try {
      pendingControl = branchControlKey(fromStep, branch)
      if (branch.targetKind === 'step') await completeStepAndJump(fromStep, branch)
      else if (branch.targetKind === 'procedure') await openProcedureTransition(fromStep, branch)
      else if (branch.targetKind !== 'unknown') {
        await transitionProcedureRun(simulationRunId, { runId: selectedRun.runId, stepId: fromStep.id, branchIndex: fromStep.branches.indexOf(branch) })
        await refreshRuns()
      }
    } catch (err) {
      error = errorMessage(err)
    } finally {
      if (!disposed) pendingControl = null
    }
  }

  const offPathConfirmation = $derived(pendingOffPath && document && currentProcedureStep
    ? procedureOffPathConfirmation({ document, current: currentProcedureStep.step, from: pendingOffPath.from, branch: pendingOffPath.branch })
    : null)

  // Leaving by a transfer holds this procedure at the step the branch was selected on.
  const transitionReturnText = (transition: ProcedureTransition): string => {
    const proc = transition.fromProcedure.procedureId
    const held = transition.branch.execution === 'parallel'
      ? `${proc} stays active at step ${transition.fromStep.label}.`
      : `${proc} holds at step ${transition.fromStep.label} as its return point.`
    const current = currentProcedureStep?.step
    return current && current.id !== transition.fromStep.id
      ? `${proc} is at step ${current.label} now. ${held}`
      : held
  }

  const transitionFromLabel = (transition: ProcedureTransition): string =>
    `${transition.fromProcedure.procedureId} (${transition.fromProcedure.title}) step ${transition.fromStep.label} (${procedureStepDisplayName(transition.fromStep)})`

  const transitionToLabel = (transition: ProcedureTransition): string =>
    `${transition.targetProcedure.procedureId} (${transition.targetProcedure.title}), step ${transition.targetStep.label} (${procedureStepDisplayName(transition.targetStep)})`

  const confirmProcedureTransition = async (): Promise<void> => {
    const transition = pendingTransition
    const request = latestProcedureLoadRequest
    if (!transition || busy) return
    try {
      pendingControl = branchControlKey(transition.fromStep, transition.branch)
      await transitionProcedureRun(simulationRunId, {
        runId: transition.sourceRunId,
        stepId: transition.fromStep.id,
        branchIndex: transition.fromStep.branches.indexOf(transition.branch),
      })
      await refreshRuns()
      if (disposed || request !== latestProcedureLoadRequest) return
      await loadProcedure(transition.targetProcedure.procedureId, true, {
        sourceId: transition.targetProcedure.source.sourceId,
        sourceRevision: transition.targetProcedure.source.revision,
        sourcePath: transition.targetProcedure.sourcePath,
      })
    } catch (err) {
      if (!disposed && request === latestProcedureLoadRequest) error = errorMessage(err)
    } finally {
      if (!disposed) pendingControl = null
      if (request === latestProcedureLoadRequest) pendingTransition = null
    }
  }

  const completeActiveProcedure = async (): Promise<void> => {
    const current = document
    if (!activeRun || !current) return
    const unitLabel = displayUnitName
    await recording('complete', async () => {
      if (!await closeActiveRun('completed')) return
      showProcedureToast(`${current.procedureId} completed for ${unitLabel}. Reset the procedure to run it again.`, {
        placement: 'center',
        tone: 'success',
        durationMs: 4_000,
      })
    })
  }

  // Take over (claim as a person) also pauses an AI driver; hand back (release) shares the Run again.
  const driveSelectedRun = async (action: 'claim' | 'release'): Promise<void> => {
    const run = activeRun
    const request = latestProcedureLoadRequest
    if (!run) return
    await recording('drive', async () => { try {
      await driveProcedureRun(simulationRunId, { runId: run.runId, action })
      await refreshRuns()
    } catch (err) {
      if (!disposed && request === latestProcedureLoadRequest) error = errorMessage(err)
    } })
  }

  const resetSelectedProcedure = async (): Promise<void> => {
    const current = document
    const request = latestProcedureLoadRequest
    if (!current) return
    await recording('reset', async () => { try {
      await resetProcedureRun(simulationRunId, {
        sourceId: current.source.sourceId,
        procedureId: current.procedureId,
        scope: currentScope,
      })
      await refreshRuns()
    } catch (err) {
      if (!disposed && request === latestProcedureLoadRequest) error = errorMessage(err)
    } })
  }

  const confirmProcedureAction = async (): Promise<void> => {
    const action = confirmation
    confirmation = null
    if (action === 'run') {
      await startSelectedProcedure()
      return
    }
    if (action === 'completed') {
      await completeActiveProcedure()
      return
    }
    if (action === 'reset') {
      await resetSelectedProcedure()
      return
    }
    if (action === 'transition') {
      await confirmProcedureTransition()
      return
    }
    if (action === 'off-path') {
      const offPath = pendingOffPath
      pendingOffPath = null
      if (offPath) await activateBranch(offPath.from, offPath.branch)
    }
  }

  const confirmationTitle = (): string => {
    if (!document || !confirmation) return ''
    if (confirmation === 'transition') return pendingTransition ? `${transitionAction(pendingTransition)} on ${displayUnitName}?` : ''
    if (confirmation === 'off-path') return offPathConfirmation?.title ?? ''
    if (confirmation === 'run') return `${selectedProcedureRun?.status === 'transferred' ? 'Resume' : 'Run'} ${document.procedureId} on ${displayUnitName}?`
    if (confirmation === 'completed') return `Complete ${document.procedureId} on ${displayUnitName}?`
    return `Reset ${document.procedureId} on ${displayUnitName}?`
  }

  // Every confirmation's primary button says what it does.
  const transitionAction = (transition: ProcedureTransition): string => {
    const target = procedureRunFor(runs, { sourceId: transition.targetProcedure.source.sourceId, procedureId: transition.targetProcedure.procedureId, scope: currentScope })
    return `${target?.status === 'transferred' ? 'Resume' : 'Go to'} ${transition.targetProcedure.procedureId}`
  }

  const confirmationAction = (): string => {
    if (!document || !confirmation) return ''
    if (confirmation === 'transition') return pendingTransition ? transitionAction(pendingTransition) : ''
    if (confirmation === 'off-path') return offPathConfirmation?.action ?? ''
    if (confirmation === 'run') return selectedProcedureRun?.status === 'transferred' ? `Resume ${document.procedureId}` : `Run ${document.procedureId} on ${displayUnitName}`
    if (confirmation === 'completed') return `Complete ${document.procedureId}`
    return `Reset ${document.procedureId}`
  }

  const confirmationBody = (): string => {
    if (!document || !confirmation) return ''
    if (confirmation === 'transition') return ''
    if (confirmation === 'off-path') return offPathConfirmation?.body ?? ''
    const currentStep = selectedProcedureRun
      ? procedureCurrentStep(selectedProcedureRun, document)?.progress ?? furthestTouchedStep(selectedProcedureRun, document)
      : null
    if (confirmation === 'run') {
      return `Confirm that you want to run ${document.procedureId} - ${document.title} on ${displayUnitName}.`
    }
    if (confirmation === 'completed') {
      const warning = selectedProcedureRun ? procedureCompletionWarning(document, selectedProcedureRun) : null
      return warning ?? `${document.procedureId} on ${displayUnitName} is marked completed at step ${currentStep?.label ?? '-'}.`
    }
    return `Reset clears the current run state, step assessments, comments, and favorites for ${document.procedureId} on ${displayUnitName}.`
  }

  const procedureRunStatusLabel = (run: ProcedureRunState | null): string => {
    if (run?.status === 'active') return 'Active'
    if (run?.status === 'completed') return 'Completed'
    if (run?.status === 'transferred') return 'Held'
    return 'Not started'
  }

  const assessmentAfter = (assessment: ProcedureAssessment | undefined): ProcedureAssessment => {
    if (!assessment || assessment === 'blank') return 'complete'
    if (assessment === 'complete') return 'failed'
    if (assessment === 'failed') return 'unknown'
    return 'blank'
  }

  const updateStep = async (
    step: ProcedureStep,
    update: {
      readonly assessment?: ProcedureAssessment
      readonly comment?: string
      readonly favorite?: boolean
      readonly currentStepId?: ProcedureStepId
    },
  ): Promise<boolean> => {
    if (!selectedRun) return false
    const request = latestProcedureLoadRequest
    try {
      await updateProcedureStep(simulationRunId, {
        runId: selectedRun.runId,
        stepId: step.id,
        ...update,
      })
      await refreshRuns()
      return !disposed && request === latestProcedureLoadRequest
    } catch (err) {
      if (!disposed && request === latestProcedureLoadRequest) error = errorMessage(err)
      return false
    }
  }

  const cycleStepAssessment = async (step: ProcedureStep): Promise<void> => {
    const current = stepStates.get(step.id)
    // A checkmark records a judgement on its step; only a branch moves the Run.
    await recording(`assess:${step.id}`, async () => { await updateStep(step, { assessment: assessmentAfter(current?.assessment) }) })
  }

  const toggleFavorite = async (step: ProcedureStep): Promise<void> => {
    const current = stepStates.get(step.id)
    await recording(`favorite:${step.id}`, async () => { await updateStep(step, { favorite: !(current?.favorite ?? false) }) })
  }

  const saveComment = async (step: ProcedureStep): Promise<void> => {
    await recording(`comment:${step.id}`, async () => { await updateStep(step, { comment: commentDrafts[draftKey(step.id)] ?? '' }) })
  }

  const tagFor = (tagId: ProcedureTagId): ProcedureTag | undefined =>
    document?.tags.find(tag => tag.id === tagId)

  const validationFor = (tagId: ProcedureTagId): ProcedureTagValidation | undefined =>
    tagValidation.get(tagId)

  // A status tree read older than 6 s keeps its colour, marked stale: lost data is never shown as blank.
  const csfStale = $derived(csfReadAt !== null && csfPresentationTime - Date.parse(csfReadAt) > 6_000)
  const csfAgeText = (): string => {
    if (csfReadAt === null) return '—'
    const seconds = Math.max(0, Math.round((csfPresentationTime - Date.parse(csfReadAt)) / 1000))
    return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`
  }

  const csfSignalTone = (signal: ProcedureCsfEvaluation['signals'][number]): 'satisfied' | 'challenged' | 'unknown' => {
    if (signal.matches === true) return 'satisfied'
    if (signal.matches === false) return 'challenged'
    return 'unknown'
  }


  const refreshCsfStatus = async (csfs = csfIds): Promise<void> => {
    if (csfs.length === 0 || csfRefreshInFlight || disposed) return
    const request = latestProcedureLoadRequest
    const unit = currentUnitContext.plantId
    try {
      csfRefreshInFlight = true
      const result = await evaluateProcedureCsfs(simulationRunId, unit, csfs, currentProvider)
      if (!disposed && request === latestProcedureLoadRequest && unit === currentUnitContext.plantId) {
        csfEvaluations = result
        csfReadAt = new Date().toISOString()
        csfError = null
      }
    } catch (err) {
      if (!disposed && request === latestProcedureLoadRequest && unit === currentUnitContext.plantId) {
        csfError = errorMessage(err)
      }
    } finally {
      csfRefreshInFlight = false
    }
  }

  const toggleStepInfo = (step: ProcedureStep): void => {
    const generation = ++stepInfoGeneration
    stepInfoReadings = {}
    if (openStepInfoId === step.id) {
      openStepInfoId = null
      return
    }
    openStepInfoId = step.id
    const unit = currentUnitContext
    for (const tagId of step.tagIds) {
      const tag = tagFor(tagId)
      if (!tag || validationFor(tagId)?.status === 'missing') continue
      void (async () => {
        try {
          const value = await readProcedureTagValue(simulationRunId, unit.plantId, tag, unit.provider ?? provider)
          if (!disposed && generation === stepInfoGeneration) stepInfoReadings = { ...stepInfoReadings, [tagId]: { formatted: value.formatted } }
        } catch (err) {
          if (!disposed && generation === stepInfoGeneration) stepInfoReadings = { ...stepInfoReadings, [tagId]: { error: errorMessage(err) } }
        }
      })()
    }
  }

  const closeTag = (): void => {
    openTagId = null
  }

  // The display window's listing for a tag's display: one key per unit and tag.
  const tagDisplayListing = (tagId: ProcedureTagId, envelope: EmbeddedViewListing['envelope']): EmbeddedViewListing => ({
    key: `procedure-tag:${currentUnitContext.plantId}:${tagId}`,
    caption: `From ${document?.procedureId ?? 'procedure'} ${tagId}`.slice(0, 120),
    envelope,
  })

  const closeBasis = (): void => {
    basisReadGeneration++
    basisRequest = null
    basisEvidence = null
    basisError = null
    basisLoading = false
  }

  const loadBasis = async (request: ProcedureSourceEvidenceRequest): Promise<void> => {
    const generation = ++basisReadGeneration
    basisRequest = request
    basisEvidence = null
    basisError = null
    basisLoading = true
    try {
      const evidence = await readProcedureSourceEvidence(simulationRunId, request)
      if (!disposed && generation === basisReadGeneration) basisEvidence = evidence
    } catch (err) {
      if (!disposed && generation === basisReadGeneration) basisError = errorMessage(err)
    } finally {
      if (!disposed && generation === basisReadGeneration) basisLoading = false
    }
  }

  const openIssue = (step: ProcedureStep): void => {
    if (!document) return
    const body = [
      `Procedure: ${document.procedureId} - ${document.title}`,
      `Step: ${step.label} (${step.id})`,
      `Source: ${document.sourceUrl}`,
      `Source revision: ${document.source.revision}`,
      `Leitbild simulation run: ${simulationRunId}`,
      '',
      'Describe the procedure text or procedure-system problem here:',
    ].join('\n')
    const params = new URLSearchParams({
      path: document.sourcePath,
      revision: document.source.revision,
      section: step.id,
      quote: body,
    })
    window.open(`/api/knowledge/feedback?${params.toString()}`, '_blank', 'noopener,noreferrer')
  }

  runOnMount(() => {
    if (!boundsInitialized) {
      windowBounds = clampWindowBounds(defaultWindowBounds())
      boundsInitialized = true
    }
    const unsubscribe = session.subscribe(state => { runs = state.runs; runDocuments = state.documents })
    void loadCatalogAndRuns()
    const interval = window.setInterval(() => {
      csfPresentationTime = Date.now()
      void refreshCsfStatus()
    }, 2_000)
    const handleResize = (): void => {
      windowBounds = clampWindowBounds(windowBounds)
    }
    window.addEventListener('resize', handleResize)
    return () => {
      disposed = true
      latestProcedureLoadRequest++
      catalogRequest++
      basisReadGeneration++
      releasePrefetch?.()
      unsubscribe()
      if (scrollFrame !== null) window.cancelAnimationFrame(scrollFrame)
      window.clearInterval(interval)
      window.removeEventListener('resize', handleResize)
      if (toastTimer !== null) window.clearTimeout(toastTimer)
    }
  })

  // Opening this unit's procedures again focuses this window instead of a second one.
  $effect(() => {
    if (focusRequest === 0) return
    untrack(() => {
      procedureWindowElement?.focus()
      if (initialProcedureId !== undefined && initialProcedureId !== document?.procedureId) void loadProcedure(initialProcedureId)
    })
  })

  // Another operator may start this procedure at a different pinned revision.
  // Synchronize its document only when identity changes, never on each checkmark.
  $effect(() => {
    const run = selectedProcedureRun
    const current = document
    if (!run || !current || selectedProcedureId !== current.procedureId) return
    if (run.sourceRevision === current.source.revision && run.sourcePath === current.sourcePath) return
    untrack(() => { void loadProcedure(run.procedureId, true, run) })
  })

  $effect(() => {
    const key = JSON.stringify([simulationRunId, currentScope.plantId, currentScope.targetObjectId])
    if (observationScopeKey === key) return
    const previous = observationScopeKey
    observationScopeKey = key
    if (previous === undefined) return
    untrack(() => {
      csfEvaluations = new Map()
      csfReadAt = null
      tagValidation = new Map()
      closeTag()
      closeBasis()
      openStepInfoId = null
      if (selectedProcedureId) void loadProcedure(selectedProcedureId)
    })
  })

</script>

{#snippet procedureText(text: string, tagIds: readonly string[])}
  {#each procedureTextSegments(text, tagIds, document?.sourceUrl) as segment}
    {#if segment.kind === 'tag'}
      <button type="button" class="procedure-tag" title="Show {segment.text} on a process display" onclick={() => { openTagId = segment.text as ProcedureTagId }}>{segment.text}</button>
    {:else if segment.kind === 'link'}
      {@const sourceRequest = document ? procedureSourceEvidenceRequest(segment.href, document) : undefined}
      {#if sourceRequest}
        <button type="button" class="procedure-basis-link" onclick={() => void loadBasis(sourceRequest)} title="Read retained source at this procedure's exact revision">{segment.text}</button>
      {:else}
        <a href={segment.href} target="_blank" rel="noopener noreferrer" title={segment.href.startsWith('/api/knowledge/source?') ? 'Inspect current deployed implementation; historical code is not retained with the procedure' : undefined}>{segment.text}{segment.href.startsWith('/api/knowledge/source?') ? ' (current implementation)' : ''}</a>
      {/if}
    {:else}{segment.text}{/if}
  {/each}
{/snippet}

{#snippet stepInfoButton(step: ProcedureStep)}
  {@const summary = procedureStepBindingSummary(document ? procedureStepTagBindings(step, document.tags, tagValidation) : [])}
  <button
    type="button"
    class="procedure-info-button small binding-{summary.worst}"
    aria-label="Plant tags in step {step.label}: {summary.text}"
    title={summary.worst === 'none' ? 'No plant tags in this step' : summary.text}
    aria-expanded={openStepInfoId === step.id}
    onclick={() => toggleStepInfo(step)}
  >
    <Info size={16} aria-hidden="true" />
  </button>
{/snippet}

{#snippet stepInfoPanel(step: ProcedureStep)}
  {@const bindings = document ? procedureStepTagBindings(step, document.tags, tagValidation) : []}
  <div class="procedure-step-info" role="region" aria-label="Plant tags in step {step.label}" onkeydown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); openStepInfoId = null } }}>
    <div class="procedure-popover-head">
      <b>{bindings.length === 0 ? 'No plant tags in this step' : procedureStepBindingSummary(bindings).text}</b>
      <button type="button" aria-label="Close plant tags" onclick={() => { openStepInfoId = null }}><X size={14} aria-hidden="true" /></button>
    </div>
    {#if bindings.length === 0}
      <p>Its indications are read and judged by the operator.</p>
    {:else}
      {#each bindings as binding (binding.tagId)}
        {@const reading = stepInfoReadings[binding.tagId]}
        <div class="procedure-step-info-tag {binding.status}">
          <b class="procedure-step-info-id">{binding.tagId}</b>
          <span class="procedure-step-info-value">{binding.status === 'missing' ? '—' : reading === undefined ? '…' : reading.formatted !== undefined ? procedureDisplayReading(reading.formatted) : 'unavailable'}</span>
          <span class="procedure-step-info-status">{procedureBindingStatusWord(binding.status)}</span>
          {#if binding.description}<span class="procedure-step-info-detail">{binding.description}</span>{/if}
          {#if binding.status === 'missing'}
            <em class="procedure-step-info-detail">Not in this unit's plant model.</em>
          {:else if binding.reads}
            <span class="procedure-step-info-detail">Reads {binding.reads}</span>
          {/if}
          {#if reading?.error}<em class="procedure-step-info-detail">{reading.error}</em>{/if}
          {#each binding.warnings as warning}<em class="procedure-step-info-detail">{warning}</em>{/each}
          {#each binding.notes as note}<span class="procedure-step-info-detail procedure-step-info-note"><b>{note.label}</b> {note.text}</span>{/each}
        </div>
      {/each}
    {/if}
    <small>Values read when this opened. World does not evaluate this step's checks; a selected branch records a judgement.</small>
  </div>
{/snippet}

{#snippet stepArticle(step: ProcedureStep, role: 'current' | 'decided' | 'open')}
  {@const state = stepStates.get(step.id)}
  {@const observation = selectedProcedureRun?.observations?.find(item => item.stepId === step.id)}
  <article data-procedure-step-id={step.id} class="procedure-step {role}" class:complete={state?.assessment === 'complete'} class:failed={state?.assessment === 'failed'} class:unknown={state?.assessment === 'unknown'}>
    <div class="procedure-step-main">
      <button
        type="button"
        class="procedure-assessment {assessmentClass(state)}"
        class:busy={busy}
        disabled={!selectedRun || busy}
        aria-busy={pendingControl === `assess:${step.id}`}
        title="Human placekeeping assessment; not an automatic equipment check"
        aria-label="Cycle human assessment"
        onclick={() => void cycleStepAssessment(step)}
      >
        {#if pendingControl === `assess:${step.id}`}
          <span class="procedure-spinner" aria-label="Recording…"></span>
        {:else if state?.assessment === 'complete'}
          <Check size={17} aria-hidden="true" />
        {:else if state?.assessment === 'failed'}
          <X size={17} aria-hidden="true" />
        {:else if state?.assessment === 'unknown'}
          <span aria-hidden="true">?</span>
        {/if}
        {#if state?.decision && procedureActorIsAi(state.decision.selectedBy)}<span class="procedure-ai-mark" title="This step's branch was selected by an AI">AI</span>{/if}
      </button>
      <div class="procedure-step-content">
        <h3>
          {#if role === 'current'}<span class="procedure-current-chip">Current</span>{/if}
          Step {step.label}<span class="procedure-step-name">{procedureStepDisplayName(step)}</span>{@render stepInfoButton(step)}
          {#if role === 'decided'}<button type="button" class="procedure-step-collapse" onclick={() => setStepExpanded(step.id, false)}>Collapse</button>{/if}
        </h3>
        {#if openStepInfoId === step.id}{@render stepInfoPanel(step)}{/if}
        <div class="procedure-two-column">
          {#each procedureStepItems(step) as item}
            <div class="procedure-column" class:response={!item.primary}>
              {#if item.kind === 'block'}
                <p class="block-{item.block.kind}">{#if item.block.kind !== 'text'}<b>{procedureBlockLabel(item.block.kind)}</b>{/if} {@render procedureText(item.block.text, item.block.tagIds)}</p>
                {#if item.block.paths?.length}<ol>{#each item.block.paths as path}<li>{@render procedureText(path, item.block.tagIds)}</li>{/each}</ol>{/if}
              {:else}
                {@const taken = state?.decision !== undefined && state.decision.branchIndex === step.branches.indexOf(item.branch) ? state.decision : undefined}
                <button
                  type="button"
                  class="procedure-branch {taken ? `taken tone-${procedureDecisionTone(taken)}` : ''}"
                  class:untaken={state?.decision !== undefined && taken === undefined}
                  class:off-path={activeRun !== null && branchIsOffPath(step)}
                  class:busy={busy}
                  disabled={!activeRun || busy || item.branch.targetKind === 'unknown'}
                  title={!selectedRun ? 'Start the procedure to use branch actions' : branchIsOffPath(step) ? `Step ${step.label} is not the current step: asks before moving ${document?.procedureId ?? 'the Run'}` : branchActionTextFor(item.branch)}
                  onclick={() => void requestBranch(step, item.branch)}
                >
                  <strong>{#if taken}<span class="procedure-taken-mark" aria-hidden="true">✓</span>{/if}{item.branch.label}</strong>
                  <span>{branchActionTextFor(item.branch)}</span>
                  {#if pendingControl === branchControlKey(step, item.branch)}{@render recordingNote()}{/if}
                  {#if taken}
                    {@const who = procedureActorLabel(taken.selectedBy, taken.selectedByLabel)}
                    {#if procedureActorIsAi(taken.selectedBy)}
                      <small class="procedure-decision-line ai">Taken by AI{who === 'AI' ? '' : ` · ${who}`} · {procedurePlantTime(taken.simulationTime)}</small>
                    {:else}
                      <small class="procedure-decision-line">Taken {procedurePlantTime(taken.simulationTime)} · {who}</small>
                    {/if}
                  {/if}
                </button>
                {#if taken && (taken.basis !== undefined || (taken.evidence?.length ?? 0) > 0)}
                  <div class="procedure-decision-basis" class:ai={procedureActorIsAi(taken.selectedBy)}>
                    {#if taken.basis}<p>{taken.basis}</p>{/if}
                    {#each taken.evidence ?? [] as evidence (evidence.tagId)}
                      <div class="procedure-evidence-row"><b>{evidence.tagId}</b><span>{evidence.reading}</span></div>
                    {/each}
                  </div>
                {/if}
                {#if item.branch.because}<p class="procedure-branch-rationale"><b>Because</b> {@render procedureText(item.branch.because, item.branch.tagIds)}</p>{/if}
                {#if item.branch.against}<p class="procedure-branch-rationale"><b>Against</b> {@render procedureText(item.branch.against, item.branch.tagIds)}</p>{/if}
              {/if}
            </div>
          {/each}
        </div>
        {#if step.assessment}
          <details class="procedure-observation">
            <summary>Evaluation criteria — authored specification</summary>
            <p>Declared evidence and decision rules, not a live assessment or automatic command.</p>
            <pre>{JSON.stringify(step.assessment, null, 2)}</pre>
          </details>
        {/if}
        {#if step.observation}
          <details class="procedure-observation">
            <summary>Read-only observation specification</summary>
            <p>The configured query is separate from its latest result and human placekeeping.</p>
            <pre>{JSON.stringify(step.observation, null, 2)}</pre>
          </details>
        {/if}
        {#if observation}
          <details class="procedure-observation">
            <summary>{procedureObservationLabel(observation.result)}: {observation.result.status} · acquired at simulation time {observation.simulationTime}</summary>
            {#if observation.result.reason}<p>{observation.result.reason}</p>{/if}
            <p>{@render procedureText(procedureObservationBasis(observation.result), [])}</p>
            {#each procedureObservationEvidence(observation.result) as evidence}
              <p><b>{evidence.label}</b>: {evidence.value} · criterion {evidence.criterion} · {evidence.status}{evidence.reason ? ` · ${evidence.reason}` : ''}</p>
            {/each}
            <small>{procedureObservationLabel(observation.result) === 'Model comparison' ? 'Comparison of runtime model values; instrumentation validity is not established. ' : ''}Last acquisition shown in simulation time, not proof that evidence remains current. Human placekeeping remains separately recorded.</small>
          </details>
        {/if}
        {#if commentOpen[draftKey(step.id)]}
          <div class="procedure-comment-editor">
            <textarea
              value={commentDrafts[draftKey(step.id)] ?? state?.comment ?? ''}
              oninput={(event) => { commentDrafts = { ...commentDrafts, [draftKey(step.id)]: event.currentTarget.value } }}
              placeholder="Add handling annotation..."
            ></textarea>
            <button type="button" disabled={busy} aria-busy={pendingControl === `comment:${step.id}`} onclick={() => void saveComment(step)}>{#if pendingControl === `comment:${step.id}`}{@render recordingNote()}{:else}Save comment{/if}</button>
          </div>
        {/if}
        {#if state?.comment}
          <div class="procedure-comment">{state.comment}</div>
        {/if}
      </div>
    </div>
    <div class="procedure-step-actions">
      <button type="button" class:active={commentOpen[draftKey(step.id)] === true} disabled={!selectedRun} title="Comment" aria-label="Comment" onclick={() => { commentOpen = { ...commentOpen, [draftKey(step.id)]: !commentOpen[draftKey(step.id)] }; commentDrafts = { ...commentDrafts, [draftKey(step.id)]: state?.comment ?? '' } }}>
        <MessageSquare size={16} aria-hidden="true" />
      </button>
      <button type="button" class:active={state?.favorite === true} class:busy={busy} disabled={!selectedRun || busy} title="Favorite" aria-label="Favorite" onclick={() => void toggleFavorite(step)}>
        {#if pendingControl === `favorite:${step.id}`}<span class="procedure-spinner" aria-label="Recording…"></span>{:else}<Star size={16} aria-hidden="true" />{/if}
      </button>
      <button type="button" title="Report procedure issue" aria-label="Report procedure issue" onclick={() => openIssue(step)}>
        <Bug size={16} aria-hidden="true" />
      </button>
    </div>
  </article>
{/snippet}

{#snippet recordingNote()}
  <span class="procedure-recording" role="status"><span class="procedure-spinner" aria-hidden="true"></span>Recording…</span>
{/snippet}

{#snippet errorStrips()}
  {#if error}
    <div class="procedure-error-strip" role="alert">
      <span title={error}>{error}</span>
      <button type="button" aria-label="Dismiss message" onclick={() => { error = null }}><X size={14} aria-hidden="true" /></button>
    </div>
  {/if}
{/snippet}

{#snippet stepSummary(step: ProcedureStep)}
  {@const state = stepStates.get(step.id)}
  {@const decision = state?.decision}
  <button
    type="button"
    class="procedure-step-summary {decision ? `tone-${procedureDecisionTone(decision)}` : ''}"
    data-procedure-step-id={step.id}
    aria-expanded="false"
    title="Show step {step.label}"
    onclick={() => setStepExpanded(step.id, true)}
  >
    <span class="procedure-summary-box {assessmentClass(state)}" aria-hidden="true">{state?.assessment === 'complete' ? '✓' : state?.assessment === 'failed' ? '✗' : state?.assessment === 'unknown' ? '?' : ''}</span>
    <strong>Step {step.label}</strong>
    <span class="procedure-summary-name">{procedureStepDisplayName(step)}</span>
    {#if decision && document}
      <span class="procedure-summary-decision">— {decision.label ?? step.branches[decision.branchIndex]?.label ?? `branch ${decision.branchIndex + 1}`} → {procedureDecisionTargetText(document, decision)}</span>
      <small>{#if procedureActorIsAi(decision.selectedBy)}<span class="procedure-ai-tag" title="Selected by {procedureActorLabel(decision.selectedBy, decision.selectedByLabel)}">AI</span> {/if}{procedurePlantTime(decision.simulationTime, 'minutes')}</small>
    {/if}
  </button>
{/snippet}

<div class="procedure-window-layer">
  <div
    class="procedure-modal procedure-window"
    bind:this={procedureWindowElement}
    role="dialog"
    aria-modal="true"
    aria-label="Computer-based procedure system"
    tabindex="-1"
    style={`left: ${windowBounds.x}px; top: ${windowBounds.y}px; width: ${windowBounds.width}px; height: ${windowBounds.height}px; --procedure-font-scale: ${procedureFontScale};`}
    onmousedown={(event) => event.stopPropagation()}
  >
    <header class="procedure-header">
      <div
        class="procedure-header-bar"
        role="toolbar"
        tabindex="0"
        aria-label="Units and procedure window controls"
        onpointerdown={(event) => startWindowDrag(event, 'move')}
        onpointermove={updateWindowDrag}
        onpointerup={finishWindowDrag}
        onpointercancel={finishWindowDrag}
      >
        <span class="procedure-grip" aria-hidden="true" title="Drag to move"><GripVertical size={16} /></span>
        <div class="procedure-cross-unit-strip" aria-label="Units and their procedures">
          {#each procedureUnits as unit (unit.plantId)}
            {@const unitStatusPresentation = statusForUnit(unit)}
            {@const unitSummaries = unitProcedureSummariesFor(unit)}
            <div class="procedure-cross-unit" class:current={unit.plantId === plantId}>
              <button
                type="button"
                class="procedure-unit-jump"
                aria-current={unit.plantId === plantId ? 'true' : undefined}
                title={unit.plantId === plantId ? `${unit.label}: shown` : `Show ${unit.label}`}
                onclick={() => void jumpToUnit(unit)}
              >
                <StatusIndicator tone={unitStatusPresentation.tone} label={unitStatusPresentation.label} indicator={unitStatusPresentation.indicator} />
                <span class="procedure-cross-unit-name">{unit.label}</span>
              </button>
              <ProcedureRunBadges
                summaries={unitSummaries}
                openProcedureId={unit.plantId === plantId ? document?.procedureId ?? null : null}
                onOpen={(summary) => openProcedureRunSummary(summary, unit)}
              />
            </div>
          {/each}
        </div>
        <div class="procedure-header-actions">
          <button class="procedure-font-button large" type="button" title="Increase procedure font size" aria-label="Increase procedure font size" onclick={increaseProcedureFontSize}>
            A
          </button>
          <button class="procedure-font-button small" type="button" title="Decrease procedure font size" aria-label="Decrease procedure font size" onclick={decreaseProcedureFontSize}>
            A
          </button>
          <button type="button" title="Refresh procedure source" aria-label="Refresh procedure source" onclick={() => void loadCatalogAndRuns(true)}>
            <RefreshCw size={16} aria-hidden="true" />
          </button>
          <button type="button" title="Close procedures" aria-label="Close procedures" onclick={close}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div class="procedure-csf-strip" aria-label="Critical safety functions">
        {#each csfIds as csf}
          {@const evaluation = csfEvaluations.get(csf)}
          {@const chip = procedureCsfChip(csf, evaluation, csfStale)}
          <div class="procedure-csf-shell">
            <button type="button" class="procedure-csf {chip.tone}" class:stale={chip.stale} aria-label="{chip.label}: {evaluation ? evaluation.status.replace('-', ' ') : 'not read yet'}{chip.stale ? ', stale' : ''}">
              <span class="procedure-csf-glyph" aria-hidden="true">{chip.glyph}</span>
              <span>{chip.label}</span>
              {#if chip.stale}<span class="procedure-csf-stale">Stale</span>{/if}
            </button>
            <div class="procedure-csf-popover" role="tooltip">
              {#if evaluation}
                <strong>
                  {evaluation.label}:
                  <span class="procedure-csf-status-text {evaluation.status}">{evaluation.status.replace('-', ' ')}{evaluation.procedure === undefined ? '' : ` · ${evaluation.procedure}`}</span>
                </strong>
                {#if chip.stale}<p class="procedure-csf-stale-note">Last read {csfAgeText()} ago; this colour may no longer hold.</p>{/if}
                {#if evaluation.reason}
                  <p>{evaluation.reason}</p>
                {/if}
                <small>Status tree path: {evaluation.signalCount} comparison{evaluation.signalCount === 1 ? '' : 's'}. Criterion: {evaluation.qualification.replaceAll('-', ' ')}, not a qualified plant procedure.</small>
                <small>{evaluation.simTimeMs === undefined ? '' : `Plant time ${procedureElapsedText(evaluation.simTimeMs)} · `}read {csfAgeText()} ago; refreshes while this window is open.</small>
                {#if evaluation.modelRef}<small>Model: {evaluation.modelRef}{evaluation.modelDigest ? ` (${evaluation.modelDigest.slice(0, 12)})` : ''}.</small>{/if}
                <div class="procedure-csf-signals">
                  {#each evaluation.signals as signal (signal.id)}
                    <div class="procedure-csf-signal {csfSignalTone(signal)}">
                      <span>{signal.label}</span>
                      <b>{procedureComparisonText(signal.formatted, signal.operator, signal.expected)}</b>
                    </div>
                  {/each}
                </div>
              {:else}
                <strong>{csf}: <span class="procedure-csf-status-text unknown">not read yet</span></strong>
                <small>{csfError ? `The status tree could not be read: ${csfError}` : 'Reading the status tree…'}</small>
              {/if}
            </div>
          </div>
        {/each}
        {#if csfError}<span class="procedure-csf-error" role="status" title={csfError}>Status trees not read: {csfError}</span>{/if}
      </div>
    </header>

    {#if !document}{@render errorStrips()}{/if}

    {#if procedureLoadPanelVisible}
      <section class="procedure-loading-panel" aria-live="polite" aria-label="Procedure system loading status">
        <div>
          <h2>{refreshing ? 'Refreshing procedure system' : 'Loading procedure system'}</h2>
          <p>{sourceLabel}</p>
        </div>
        <div class="procedure-load-steps">
          {#each procedureLoadRows as stage (stage.id)}
            <div class="procedure-load-step {stage.status}">
              <span class="procedure-load-dot" aria-hidden="true"></span>
              <strong>{stage.label}</strong>
              <small>{stage.detail ?? (stage.status === 'pending' ? 'Pending' : stage.status)}</small>
            </div>
          {/each}
        </div>
      </section>
    {:else}
      <div class="procedure-layout toc-{procedureTocMode}">
        {#if procedureTocMode !== 'collapsed'}
        <aside class="procedure-list" aria-label="Procedure list">
            {#each catalogCategories as category (category.id)}
              <section>
                <h3>{category.label}</h3>
                {#each category.procedures as item (item.procedureId)}
                  {@const runState = procedureRunVisualStateFor(item.procedureId)}
                  <button
                    type="button"
                    class:active={selectedProcedureId === item.procedureId}
                    class:run-active={runState === 'active'}
                    class:run-completed={runState === 'completed'}
                    aria-busy={loadingProcedureId === item.procedureId}
                    onclick={() => void loadProcedure(item.procedureId)}
                  >
                    <span class="procedure-book-icon {runState}">
                      <BookOpen size={15} aria-hidden="true" />
                    </span>
                    <span>{item.procedureId}</span>
                    <small>{item.title}</small>
                  </button>
                {/each}
              </section>
            {/each}
        </aside>
        {/if}

        <button
          type="button"
          class="procedure-toc-handle"
          title={procedureTocModeLabel()}
          aria-label={procedureTocModeLabel()}
          onclick={cycleProcedureTocMode}
        >
          {#if procedureTocMode === 'collapsed'}
            <ChevronRight size={17} aria-hidden="true" />
          {:else}
            <ChevronLeft size={17} aria-hidden="true" />
          {/if}
        </button>

        <main
          class="procedure-document"
          class:completed-run={selectedProcedureRun?.status === 'completed'}
          aria-busy={loadingProcedureId !== null}
        >
          {#if document}
          <div class="procedure-document-toolbar">
            <div class="procedure-document-title">
              <span class="procedure-unit-chip" title="Procedures in this window are for {displayUnitName}">{displayUnitName}</span>
              <h2>{document.procedureId} — {document.title}</h2>
              <span class="procedure-info-shell">
                <button type="button" class="procedure-info-button" aria-label="About {document.procedureId}" aria-expanded={summaryOpen} onclick={() => { summaryOpen = !summaryOpen }}>
                  <Info size={17} aria-hidden="true" />
                </button>
                {#if summaryOpen}
                <div class="procedure-info-popover procedure-summary-popover" role="dialog" aria-label="About {document.procedureId}" tabindex="-1" onkeydown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); summaryOpen = false } }}>
                  <div class="procedure-popover-head">
                    <b>About {document.procedureId}</b>
                    <button type="button" aria-label="Close" onclick={() => { summaryOpen = false }}><X size={14} aria-hidden="true" /></button>
                  </div>
                  {#if document.description}<p class="procedure-summary-text">{@render procedureText(procedureDescriptionText(document.description), [])}</p>{/if}
                  {#if document.appliesTo}<p><b>Applies to</b> {document.appliesTo}</p>{/if}
                  {#if document.referencePlant}<p><b>Reference plant</b> {document.referencePlant}</p>{/if}
                  {#each Object.entries(document.annotations ?? {}) as [key, value]}<p><b>{key}</b> {value}</p>{/each}
                  {#if document.diagnostics?.length}
                    <p><b>Format notes</b></p>
                    <ul>{#each document.diagnostics as diagnostic}<li>{diagnostic}</li>{/each}</ul>
                  {/if}
                </div>
                {/if}
              </span>
              <button type="button" class="procedure-source-icon" onclick={() => document && void loadBasis({ sourceId: document.source.sourceId, sourceRevision: document.source.revision, sourcePath: document.sourcePath, lineCount: 100 })} title="Read retained procedure source" aria-label="Read retained procedure source">
                <ExternalLink size={15} aria-hidden="true" />
              </button>
            </div>
            <div class="procedure-mode-actions">
              <span class="procedure-status-pill {selectedProcedureRun?.status ?? 'idle'}">
                <span class="procedure-status-dot" aria-hidden="true"></span>
                {procedureRunStatusLabel(selectedProcedureRun)}
                {#if currentProcedureStep}
                  ·
                  <button
                    type="button"
                    class="procedure-step-counter"
                    title={`Scroll to ${procedureStepHoverLabel(currentProcedureStep.step)}`}
                    onclick={() => currentProcedureStep && scrollToProcedureStep(currentProcedureStep.step.id)}
                  >step {currentProcedureStep.step.label}/{document.steps.length}</button>
                {/if}
              </span>
              {#if completedRun}
                <button type="button" class="reset" class:busy={busy} disabled={busy} onclick={() => { confirmation = 'reset' }}>{#if pendingControl === 'reset'}{@render recordingNote()}{:else}Reset…{/if}</button>
              {:else if activeRun}
                <button type="button" class="complete" class:busy={busy} disabled={busy} onclick={() => { confirmation = 'completed' }}>
                  {#if pendingControl === 'complete'}{@render recordingNote()}{:else}Complete…{/if}
                </button>
                <button type="button" class="reset" class:busy={busy} disabled={busy} onclick={() => { confirmation = 'reset' }}>{#if pendingControl === 'reset'}{@render recordingNote()}{:else}Reset…{/if}</button>
              {:else}
                <button type="button" class="run" class:busy={busy} disabled={busy} onclick={() => { confirmation = 'run' }}>
                  {#if pendingControl === 'run'}{@render recordingNote()}{:else}<Play size={13} aria-hidden="true" /> {selectedProcedureRun?.status === 'transferred' ? 'Resume' : 'Run'}{/if}
                </button>
              {/if}
            </div>
          </div>
          {@render errorStrips()}
          {#if driverView}
            <div class="procedure-driver-band {driverView.kind}" role="status">
              {#if driverView.kind === 'ai'}
                <span class="procedure-ai-tag">AI</span>
                <span class="procedure-driver-text"><b>{driverView.label} driving {document.procedureId}</b> on {displayUnitName} · since {driverView.since} · {driverView.aiSteps} {driverView.aiSteps === 1 ? 'step' : 'steps'}</span>
                <button type="button" title="Drive {document.procedureId} yourself; the AI only reads it until you hand it back. Ticking a step or selecting a branch also takes over." class:busy={busy} disabled={busy} onclick={() => void driveSelectedRun('claim')}>{#if pendingControl === 'drive'}{@render recordingNote()}{:else}Take over{/if}</button>
              {:else}
                <span class="procedure-driver-text"><b>You are driving {document.procedureId}</b>{driverView.handBackTo ? '' : ' · AI agents only read it'}</span>
                <button type="button" title={driverView.handBackTo ? `Let ${driverView.handBackTo} continue ${document.procedureId}` : `Share ${document.procedureId} again`} class:busy={busy} disabled={busy} onclick={() => void driveSelectedRun('release')}>{#if pendingControl === 'drive'}{@render recordingNote()}{:else}{driverView.handBackTo ? `Hand back to ${driverView.handBackTo}` : 'Release'}{/if}</button>
              {/if}
            </div>
          {/if}

          <div
            class="procedure-document-body"
            bind:this={procedureDocumentBodyElement}
            onscroll={rememberCurrentProcedureScroll}
          >
            <div class="procedure-steps">
              {#each procedureRows as row (row.kind === 'step' ? row.step.id : `bypassed:${row.steps[0]!.id}`)}
                {#if row.kind === 'bypassed'}
                  {@const bypassKey = draftKey(`bypassed:${row.steps[0]!.id}`)}
                  <button
                    type="button"
                    class="procedure-bypassed"
                    aria-expanded={expandedSteps[bypassKey] === true}
                    onclick={() => { expandedSteps = { ...expandedSteps, [bypassKey]: !expandedSteps[bypassKey] } }}
                  >
                    {row.steps.length === 1 ? `Step ${row.steps[0]!.label}` : `Steps ${procedureStepRangeText(row.steps, document)}`} bypassed (step {row.from.label} → {row.to.label})
                  </button>
                  {#if expandedSteps[bypassKey]}
                    {#each row.steps as step (step.id)}{@render stepArticle(step, 'open')}{/each}
                  {/if}
                {:else if row.role === 'decided' && !expandedSteps[draftKey(row.step.id)]}
                  {@render stepSummary(row.step)}
                {:else}
                  {@render stepArticle(row.step, row.role)}
                {/if}
              {/each}
            </div>
          </div>
          {#if loadingProcedureId !== null}
            <div class="procedure-document-loading" role="status" aria-live="polite" aria-label="Loading procedure {loadingProcedureId}">
              <span class="procedure-document-spinner" aria-hidden="true"></span>
              <strong>Loading {loadingProcedureId}</strong>
            </div>
          {/if}
        {:else}
          <div class="procedure-loading">No procedure selected.</div>
        {/if}
        </main>
      </div>
    {/if}

    {#if openTagId}
      {@const openTag = tagFor(openTagId)}
      {#if openTag}
        {#key `${currentUnitContext.plantId}:${openTagId}`}
          <ProcedureTagDisplay
            {simulationRunId}
            plantId={currentUnitContext.plantId}
            unitLabel={displayUnitName}
            tag={openTag}
            validation={validationFor(openTagId)}
            provider={currentProvider}
            close={closeTag}
            openInDisplayWindow={openDisplay === undefined ? undefined : (envelope) => { if (openTagId) openDisplay(tagDisplayListing(openTagId, envelope)) }}
          />
        {/key}
      {/if}
    {/if}

    {#if refreshing}
      <div class="procedure-refreshing">Refreshing procedure source...</div>
    {/if}

    {#if basisRequest}
      <div class="procedure-confirm-backdrop" role="presentation" onmousedown={closeBasis}>
        <div class="procedure-confirm procedure-basis-dialog" role="dialog" aria-modal="true" aria-label="Retained technical basis" tabindex="-1" onmousedown={(event) => event.stopPropagation()} {@attach procedureDialog(closeBasis)}>
          <header class="procedure-basis-header">
            <h2>{basisEvidence?.title ?? 'Retained technical basis'}</h2>
            <button type="button" class="procedure-dialog-close" aria-label="Close retained source" data-dialog-primary onclick={closeBasis}><X size={16} aria-hidden="true" /></button>
          </header>
          <div class="procedure-basis-body">
            <p>{basisRequest.sourcePath}{basisRequest.section ? ` · ${basisRequest.section}` : ''}</p>
            <small>Exact source revision: {basisRequest.sourceRevision}</small>
            {#if basisLoading}<p role="status">Reading retained source…</p>{/if}
            {#if basisError}<p class="procedure-error">{basisError}</p>{/if}
            {#if basisEvidence}
              <p>Lines {basisEvidence.startLine}–{basisEvidence.endLine} of {basisEvidence.totalLines}</p>
              <pre class="procedure-basis-content">{basisEvidence.content}</pre>
            {/if}
          </div>
          {#if basisEvidence?.nextLine || basisError}
            <div class="procedure-confirm-actions">
              {#if basisEvidence?.nextLine}<button type="button" onclick={() => basisRequest && basisEvidence?.nextLine && void loadBasis({ ...basisRequest, startLine: basisEvidence.nextLine })}>Read next lines</button>{/if}
              {#if basisError}<button type="button" onclick={() => basisRequest && void loadBasis(basisRequest)}>Retry</button>{/if}
            </div>
          {/if}
        </div>
      </div>
    {/if}

    {#if confirmation}
      <div class="procedure-confirm-backdrop" role="presentation" onmousedown={cancelConfirmation}>
        <div class="procedure-confirm" role="dialog" aria-modal="true" aria-label={confirmationTitle()} tabindex="-1" onmousedown={(event) => event.stopPropagation()} {@attach procedureDialog(cancelConfirmation)}>
          <h2>{confirmationTitle()}</h2>
          {#if confirmation === 'transition' && pendingTransition}
            <p>
              Transition from {transitionFromLabel(pendingTransition)} to
              <br />
              <strong>{transitionToLabel(pendingTransition)}</strong>
            </p>
            <p>{transitionReturnText(pendingTransition)}</p>
          {:else}
            <p>{confirmationBody()}</p>
          {/if}
          <div class="procedure-confirm-actions">
            <button type="button" onclick={cancelConfirmation}>Cancel</button>
            <button type="button" class="primary" class:critical={confirmation === 'reset'} data-dialog-primary disabled={busy} onclick={() => void confirmProcedureAction()}>{confirmationAction()}</button>
          </div>
        </div>
      </div>
    {/if}

    {#if procedureToast}
      <div
        class="procedure-toast {procedureToast.placement} {procedureToast.tone}"
        style={`--procedure-toast-duration: ${procedureToast.durationMs}ms;`}
        role="status"
      >
        {procedureToast.message}
      </div>
    {/if}
    <div
      class="procedure-resize-handle north"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize procedure system from top"
      onpointerdown={(event) => startWindowDrag(event, 'resize-north')}
      onpointermove={updateWindowDrag}
      onpointerup={finishWindowDrag}
      onpointercancel={finishWindowDrag}
    ></div>
    <div
      class="procedure-resize-handle east"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize procedure system from right"
      onpointerdown={(event) => startWindowDrag(event, 'resize-east')}
      onpointermove={updateWindowDrag}
      onpointerup={finishWindowDrag}
      onpointercancel={finishWindowDrag}
    ></div>
    <div
      class="procedure-resize-handle south"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize procedure system from bottom"
      onpointerdown={(event) => startWindowDrag(event, 'resize-south')}
      onpointermove={updateWindowDrag}
      onpointerup={finishWindowDrag}
      onpointercancel={finishWindowDrag}
    ></div>
    <div
      class="procedure-resize-handle west"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize procedure system from left"
      onpointerdown={(event) => startWindowDrag(event, 'resize-west')}
      onpointermove={updateWindowDrag}
      onpointerup={finishWindowDrag}
      onpointercancel={finishWindowDrag}
    ></div>
    <div
      class="procedure-resize-handle corner north-east"
      role="separator"
      aria-label="Resize procedure system from top right"
      onpointerdown={(event) => startWindowDrag(event, 'resize-north-east')}
      onpointermove={updateWindowDrag}
      onpointerup={finishWindowDrag}
      onpointercancel={finishWindowDrag}
    ></div>
    <div
      class="procedure-resize-handle corner north-west"
      role="separator"
      aria-label="Resize procedure system from top left"
      onpointerdown={(event) => startWindowDrag(event, 'resize-north-west')}
      onpointermove={updateWindowDrag}
      onpointerup={finishWindowDrag}
      onpointercancel={finishWindowDrag}
    ></div>
    <div
      class="procedure-resize-handle corner south-east"
      role="separator"
      aria-label="Resize procedure system from bottom right"
      onpointerdown={(event) => startWindowDrag(event, 'resize-south-east')}
      onpointermove={updateWindowDrag}
      onpointerup={finishWindowDrag}
      onpointercancel={finishWindowDrag}
    ></div>
    <div
      class="procedure-resize-handle corner south-west"
      role="separator"
      aria-label="Resize procedure system from bottom left"
      onpointerdown={(event) => startWindowDrag(event, 'resize-south-west')}
      onpointermove={updateWindowDrag}
      onpointerup={finishWindowDrag}
      onpointercancel={finishWindowDrag}
    ></div>
  </div>
</div>
