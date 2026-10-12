<script lang="ts">
  import { BookOpen, Bug, Check, ChevronLeft, ChevronRight, ExternalLink, HelpCircle, Info, MessageSquare, Play, RefreshCw, Star, X } from 'lucide-svelte'
  import { tick, untrack } from 'svelte'
  import type { ProcedureSession } from './procedure-session.ts'
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
  import ProcedureTagDisplay from './ProcedureTagDisplay.svelte'
  import type { EmbeddedViewListing } from '@leitbild/contracts'
  import {
    closeProcedureRun,
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
    procedureFirstStep,
    procedureOffPathConfirmation,
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
  let commentDrafts = $state<Record<string, string>>({})
  let pendingTransition = $state<ProcedureTransition | null>(null)
  let pendingOffPath = $state<{ readonly from: ProcedureStep; readonly branch: ProcedureBranch } | null>(null)
  let procedureToast = $state<ProcedureToast | null>(null)
  let loadStages = $state<Record<LoadStageId, LoadStage>>(createLoadStages())
  let procedureTocMode = $state<ProcedureTocMode>('detail')
  let procedureFontScale = $state(1)
  let windowBounds = $state<FloatingWindowBounds>({ x: 48, y: 48, width: 1500, height: 940 })
  let windowDragState = $state<ProcedureWindowDragState | null>(null)
  let transitionInProgress = $state(false)
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
      document = nextDocument
      loading = false
      if (catalog && !releasePrefetch) releasePrefetch = session.retainPrefetch(catalog)
      loadingProcedureId = null
      setLoadStage('document', 'done', `${nextDocument.steps.length} steps`)
      await restoreProcedurePosition(nextDocument, targetScope, requestId)
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
    try {
      await startProcedureRun(simulationRunId, {
        sourceId: current.source.sourceId,
        sourceRevision: current.source.revision,
        procedureId: current.procedureId,
        scope: currentScope,
      })
      await refreshRuns()
    } catch (err) {
      if (!disposed && request === latestProcedureLoadRequest) error = errorMessage(err)
    }
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

  const rememberCurrentProcedureScroll = (): void => {
    if (!document || !procedureDocumentBodyElement) return
    procedureScrollPositions.set(
      procedureViewKey(document, currentScope),
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
    procedureDocumentBodyElement.scrollTop = procedureScrollPositions.get(
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
    if (!selectedRun || transitionInProgress) return
    if (branch.targetKind !== 'procedure' && branchIsOffPath(fromStep)) {
      pendingOffPath = { from: fromStep, branch }
      confirmation = 'off-path'
      return
    }
    await activateBranch(fromStep, branch)
  }

  const activateBranch = async (fromStep: ProcedureStep, branch: ProcedureBranch): Promise<void> => {
    if (!selectedRun || transitionInProgress) return
    try {
      transitionInProgress = true
      if (branch.targetKind === 'step') await completeStepAndJump(fromStep, branch)
      else if (branch.targetKind === 'procedure') await openProcedureTransition(fromStep, branch)
      else if (branch.targetKind !== 'unknown') {
        await transitionProcedureRun(simulationRunId, { runId: selectedRun.runId, stepId: fromStep.id, branchIndex: fromStep.branches.indexOf(branch) })
        await refreshRuns()
      }
    } catch (err) {
      error = errorMessage(err)
    } finally {
      transitionInProgress = false
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
    if (!transition || transitionInProgress) return
    try {
      transitionInProgress = true
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
      if (!disposed) transitionInProgress = false
      if (request === latestProcedureLoadRequest) pendingTransition = null
    }
  }

  const completeActiveProcedure = async (): Promise<void> => {
    const current = document
    if (!activeRun || !current) return
    const unitLabel = displayUnitName
    if (!await closeActiveRun('completed')) return
    showProcedureToast(`${current.procedureId} completed for ${unitLabel}. Reset the procedure to run it again.`, {
      placement: 'center',
      tone: 'success',
      durationMs: 4_000,
    })
  }

  const resetSelectedProcedure = async (): Promise<void> => {
    const current = document
    const request = latestProcedureLoadRequest
    if (!current) return
    try {
      await resetProcedureRun(simulationRunId, {
        sourceId: current.source.sourceId,
        procedureId: current.procedureId,
        scope: currentScope,
      })
      await refreshRuns()
    } catch (err) {
      if (!disposed && request === latestProcedureLoadRequest) error = errorMessage(err)
    }
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
    if (confirmation === 'transition') return 'Confirm procedure transition'
    if (confirmation === 'off-path') return offPathConfirmation?.title ?? ''
    if (confirmation === 'run') return `Run ${document.procedureId} on ${displayUnitName}?`
    if (confirmation === 'completed') return `Complete ${document.procedureId} on ${displayUnitName}?`
    return `Reset ${document.procedureId} on ${displayUnitName}?`
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
      return `Confirm that ${document.procedureId} on ${displayUnitName} should be marked completed on step ${currentStep?.label ?? '-'}.`
    }
    return `Reset clears the current run state, step assessments, comments, and favorites for ${document.procedureId} on ${displayUnitName}.`
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
    await updateStep(step, { assessment: assessmentAfter(current?.assessment) })
  }

  const toggleFavorite = async (step: ProcedureStep): Promise<void> => {
    const current = stepStates.get(step.id)
    await updateStep(step, { favorite: !(current?.favorite ?? false) })
  }

  const saveComment = async (step: ProcedureStep): Promise<void> => {
    await updateStep(step, { comment: commentDrafts[draftKey(step.id)] ?? '' })
  }

  const tagFor = (tagId: ProcedureTagId): ProcedureTag | undefined =>
    document?.tags.find(tag => tag.id === tagId)

  const validationFor = (tagId: ProcedureTagId): ProcedureTagValidation | undefined =>
    tagValidation.get(tagId)

  const csfEvaluationFor = (csf: string): ProcedureCsfEvaluation | undefined =>
    csfReadAt !== null && csfPresentationTime - Date.parse(csfReadAt) <= 6_000 ? csfEvaluations.get(csf) : undefined

  const csfSignalTone = (signal: ProcedureCsfEvaluation['signals'][number]): 'satisfied' | 'challenged' | 'unknown' => {
    if (signal.matches === true) return 'satisfied'
    if (signal.matches === false) return 'challenged'
    return 'unknown'
  }

  const csfSignalValueText = (signal: ProcedureCsfEvaluation['signals'][number]): string =>
    signal.operator === undefined
      ? signal.formatted
      : `${signal.formatted} ${signal.operator} ${String(signal.expected)}`

  const refreshCsfStatus = async (csfs = csfIds): Promise<void> => {
    if (csfs.length === 0 || csfRefreshInFlight || disposed) return
    const request = latestProcedureLoadRequest
    const unit = currentUnitContext.plantId
    try {
      csfRefreshInFlight = true
      csfError = null
      const result = await evaluateProcedureCsfs(simulationRunId, unit, csfs, currentProvider)
      if (!disposed && request === latestProcedureLoadRequest && unit === currentUnitContext.plantId) {
        csfEvaluations = result
        csfReadAt = new Date().toISOString()
      }
    } catch (err) {
      if (!disposed && request === latestProcedureLoadRequest && unit === currentUnitContext.plantId) {
        csfEvaluations = new Map()
        csfReadAt = null
        csfError = errorMessage(err)
      }
    } finally {
      csfRefreshInFlight = false
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

{#snippet stepInfo(step: ProcedureStep)}
  {@const bindings = document ? procedureStepTagBindings(step, document.tags, tagValidation) : []}
  <span class="procedure-info-shell step">
    <button type="button" class="procedure-info-button small" aria-label="Plant tags in step {step.label}">
      <Info size={15} aria-hidden="true" />
    </button>
    <div class="procedure-info-popover procedure-step-info-popover" role="tooltip">
      {#if bindings.length === 0}
        <p>No plant tags in this step: its indications are read and judged by the operator.</p>
      {:else}
        <p class="procedure-step-info-heading">Plant tags in this step</p>
        {#each bindings as binding (binding.tagId)}
          <div class="procedure-step-info-tag {binding.status}">
            <span><b>{binding.tagId}</b>{binding.description ? ` — ${binding.description}` : ''}</span>
            {#if binding.status === 'missing'}
              <em>Not in this unit's plant model.</em>
            {:else if binding.status === 'unchecked'}
              <em>Binding not checked yet.</em>
            {:else if binding.reads}
              <span>Reads {binding.reads}</span>
            {/if}
            {#each binding.warnings as warning}<em>{warning}</em>{/each}
            {#each binding.notes as note}<span class="procedure-step-info-note"><b>{note.label}</b> {note.text}</span>{/each}
          </div>
        {/each}
      {/if}
      <small>World does not evaluate this step's checks; a selected branch records a judgement.</small>
    </div>
  </span>
{/snippet}

<div class="procedure-window-layer">
  <div
    class="procedure-modal procedure-window"
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
          {@const evaluation = csfEvaluationFor(csf)}
          <div class="procedure-csf-shell">
            <button type="button" class="procedure-csf {evaluation?.status ?? 'unknown'}">
              <span>{evaluation?.label ?? csf.replaceAll('-', ' ')}</span>
            </button>
            <div class="procedure-csf-popover" role="tooltip">
              {#if evaluation}
                <strong>
                  {evaluation.label}:
                  <span class="procedure-csf-status-text {evaluation.status}">{evaluation.status.replace('-', ' ')}{evaluation.procedure === undefined ? '' : ` · ${evaluation.procedure}`}</span>
                </strong>
                {#if evaluation.reason}
                  <p>{evaluation.reason}</p>
                {/if}
                <small>Status tree path: {evaluation.signalCount} comparison{evaluation.signalCount === 1 ? '' : 's'}. Criterion: {evaluation.qualification.replaceAll('-', ' ')}, not a qualified plant procedure.</small>
                {#if evaluation.simTimeMs !== undefined}<small>Simulation time: {(evaluation.simTimeMs / 1000).toFixed(1)} s.</small>{/if}
                {#if csfReadAt}<small>Snapshot received: {csfReadAt}. Refreshes while this window is open.</small>{/if}
                {#if evaluation.modelRef}<small>Model: {evaluation.modelRef}{evaluation.modelDigest ? ` (${evaluation.modelDigest})` : ''}.</small>{/if}
                <div class="procedure-csf-signals">
                  {#each evaluation.signals as signal (signal.id)}
                    <div class="procedure-csf-signal {csfSignalTone(signal)}">
                      <span>{signal.label}</span>
                      <b>{csfSignalValueText(signal)}</b>
                      {#if signal.path}<code>{signal.path}</code>{/if}
                    </div>
                  {/each}
                </div>
              {:else}
                <strong>{csf.replaceAll('-', ' ')}: <span class="procedure-csf-status-text unknown">unknown</span></strong>
                <small>{csfReadAt ? 'Observation snapshot expired. A new acquisition is required.' : 'CSF observation is unavailable.'}</small>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    </header>

    {#if csfError}
      <div class="procedure-error">{csfError}</div>
    {/if}

    {#if error}
      <div class="procedure-error">{error}</div>
    {/if}

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
              <h2>{document.procedureId} — {document.title}</h2>
              <span class="procedure-info-shell">
                <button type="button" class="procedure-info-button" aria-label="About this procedure">
                  <Info size={17} aria-hidden="true" />
                </button>
                <div class="procedure-info-popover procedure-summary-popover" role="tooltip">
                  {#if document.description}<p class="procedure-summary-text">{@render procedureText(document.description, [])}</p>{/if}
                  {#if document.appliesTo}<p><b>Applies to</b> {document.appliesTo}</p>{/if}
                  {#if document.referencePlant}<p><b>Reference plant</b> {document.referencePlant}</p>{/if}
                  {#each Object.entries(document.annotations ?? {}) as [key, value]}<p><b>{key}</b> {value}</p>{/each}
                  {#if document.diagnostics?.length}
                    <p><b>Format notes</b></p>
                    <ul>{#each document.diagnostics as diagnostic}<li>{diagnostic}</li>{/each}</ul>
                  {/if}
                </div>
              </span>
              <button type="button" class="procedure-source-icon" onclick={() => document && void loadBasis({ sourceId: document.source.sourceId, sourceRevision: document.source.revision, sourcePath: document.sourcePath, lineCount: 100 })} title="Read retained procedure source" aria-label="Read retained procedure source">
                <ExternalLink size={15} aria-hidden="true" />
              </button>
              <button
                type="button"
                class="procedure-step-counter"
                disabled={currentProcedureStep === null}
                title={currentProcedureStep ? `Scroll to ${procedureStepHoverLabel(currentProcedureStep.step)}` : 'No active procedure step'}
                onclick={() => currentProcedureStep && scrollToProcedureStep(currentProcedureStep.step.id)}
              >Step {currentProcedureStep?.step.label ?? '-'}/{document.steps.length}</button>
            </div>
            <div class="procedure-mode-actions">
              {#if completedRun}
                <button type="button" class="completed" disabled>Completed</button>
                <button type="button" class="reset" onclick={() => { confirmation = 'reset' }}>Reset</button>
              {:else if activeRun}
                <button type="button" class="run running" onclick={() => { confirmation = 'completed' }}>
                  <Play size={13} aria-hidden="true" /> Active
                </button>
                <button type="button" class="reset" onclick={() => { confirmation = 'reset' }}>Reset</button>
              {:else}
                <button type="button" class="run" onclick={() => { confirmation = 'run' }}>
                  <Play size={13} aria-hidden="true" /> {selectedProcedureRun?.status === 'transferred' ? 'Resume' : 'Run'}
                </button>
              {/if}
            </div>
          </div>

          <div
            class="procedure-document-body"
            bind:this={procedureDocumentBodyElement}
            onscroll={rememberCurrentProcedureScroll}
          >
            <div class="procedure-steps">
              {#each document.steps as step (step.id)}
                {@const state = stepStates.get(step.id)}
                {@const observation = selectedProcedureRun?.observations?.find(item => item.stepId === step.id)}
                <article data-procedure-step-id={step.id} class="procedure-step" class:complete={state?.assessment === 'complete'} class:failed={state?.assessment === 'failed'}>
                  <div class="procedure-step-main">
                    <button
                      type="button"
                      class="procedure-assessment {assessmentClass(state)}"
                      disabled={!selectedRun}
                      title="Human placekeeping assessment; not an automatic equipment check"
                      aria-label="Cycle human assessment"
                      onclick={() => void cycleStepAssessment(step)}
                    >
                      {#if state?.assessment === 'complete'}
                        <Check size={17} aria-hidden="true" />
                      {:else if state?.assessment === 'failed'}
                        <X size={17} aria-hidden="true" />
                      {:else if state?.assessment === 'unknown'}
                        <HelpCircle size={17} aria-hidden="true" />
                      {/if}
                    </button>
                    <div class="procedure-step-content">
                      <h3>Step {step.label}<span>{procedureStepDisplayName(step)}</span>{@render stepInfo(step)}</h3>
                      <div class="procedure-two-column">
                        {#each procedureStepItems(step) as item}
                          <div class="procedure-column" class:response={!item.primary}>
                            {#if item.kind === 'block'}
                              <p class="block-{item.block.kind}">{#if item.block.kind !== 'text'}<b>{procedureBlockLabel(item.block.kind)}</b>{/if} {@render procedureText(item.block.text, item.block.tagIds)}</p>
                              {#if item.block.paths?.length}<ol>{#each item.block.paths as path}<li>{@render procedureText(path, item.block.tagIds)}</li>{/each}</ol>{/if}
                            {:else}
                              <button
                                type="button"
                                class="procedure-branch"
                                class:off-path={activeRun !== null && branchIsOffPath(step)}
                                disabled={!activeRun || transitionInProgress || item.branch.targetKind === 'unknown'}
                                title={!selectedRun ? 'Start the procedure to use branch actions' : branchIsOffPath(step) ? `Step ${step.label} is not the current step: asks before moving ${document.procedureId}` : branchActionTextFor(item.branch)}
                                onclick={() => void requestBranch(step, item.branch)}
                              >
                                <strong>{item.branch.label}</strong>
                                <span>{branchActionTextFor(item.branch)}</span>
                              </button>
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
                          <button type="button" onclick={() => void saveComment(step)}>Save comment</button>
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
                    <button type="button" class:active={state?.favorite === true} disabled={!selectedRun} title="Favorite" aria-label="Favorite" onclick={() => void toggleFavorite(step)}>
                      <Star size={16} aria-hidden="true" />
                    </button>
                    <button type="button" title="Report procedure issue" aria-label="Report procedure issue" onclick={() => openIssue(step)}>
                      <Bug size={16} aria-hidden="true" />
                    </button>
                  </div>
                </article>
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
        <div class="procedure-confirm procedure-basis-dialog" role="dialog" aria-modal="true" aria-label="Retained technical basis" tabindex="-1" onmousedown={(event) => event.stopPropagation()}>
          <h2>{basisEvidence?.title ?? 'Retained technical basis'}</h2>
          <p>{basisRequest.sourcePath}{basisRequest.section ? ` · ${basisRequest.section}` : ''}</p>
          <small>Exact source revision: {basisRequest.sourceRevision}</small>
          {#if basisLoading}<p role="status">Reading retained source…</p>{/if}
          {#if basisError}<p class="procedure-error">{basisError}</p>{/if}
          {#if basisEvidence}
            <p>Lines {basisEvidence.startLine}–{basisEvidence.endLine} of {basisEvidence.totalLines}</p>
            <pre class="procedure-basis-content">{basisEvidence.content}</pre>
          {/if}
          <div class="procedure-confirm-actions">
            {#if basisEvidence?.nextLine}<button type="button" onclick={() => basisRequest && basisEvidence?.nextLine && void loadBasis({ ...basisRequest, startLine: basisEvidence.nextLine })}>Read next lines</button>{/if}
            {#if basisError}<button type="button" onclick={() => basisRequest && void loadBasis(basisRequest)}>Retry</button>{/if}
            <button type="button" onclick={closeBasis}>Close</button>
          </div>
        </div>
      </div>
    {/if}

    {#if confirmation}
      <div class="procedure-confirm-backdrop" role="presentation" onmousedown={cancelConfirmation}>
        <div class="procedure-confirm" role="dialog" aria-modal="true" aria-label={confirmationTitle()} tabindex="-1" onmousedown={(event) => event.stopPropagation()}>
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
            <button type="button" class="primary" disabled={transitionInProgress} onclick={() => void confirmProcedureAction()}>Confirm</button>
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
