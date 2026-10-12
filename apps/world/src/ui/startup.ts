export type StartupStepId =
  | 'route'
  | 'interface'
  | 'simulation-run'
  | 'snapshot'
  | 'map'
  | 'objects'
  | 'realtime'
  | 'ready'

export type StartupStepStatus = 'pending' | 'running' | 'done' | 'failed'

export interface StartupStepDetail {
  readonly label: string
  readonly value: string
}

export interface StartupStep {
  readonly id: StartupStepId
  readonly label: string
  readonly status: StartupStepStatus
  readonly startedAtMs?: number
  readonly completedAtMs?: number
  readonly error?: string
  readonly details?: ReadonlyArray<StartupStepDetail>
}

export const createStartupSteps = (nowMs = performance.now()): ReadonlyArray<StartupStep> => [
  { id: 'route', label: 'Read route', status: 'pending' },
  { id: 'interface', label: 'Prepare interface', status: 'pending' },
  { id: 'simulation-run', label: 'Open Simulation Run', status: 'pending' },
  { id: 'snapshot', label: 'Load snapshot', status: 'pending' },
  { id: 'map', label: 'Start map', status: 'pending', startedAtMs: nowMs },
  { id: 'objects', label: 'Render operational objects', status: 'pending' },
  { id: 'realtime', label: 'Connect realtime updates', status: 'pending' },
  { id: 'ready', label: 'Ready', status: 'pending' },
]

const updateStep = (
  steps: ReadonlyArray<StartupStep>,
  id: StartupStepId,
  update: (step: StartupStep) => StartupStep,
): ReadonlyArray<StartupStep> => {
  let changed = false
  const next = steps.map(step => {
    if (step.id !== id) return step
    const updated = update(step)
    if (updated !== step) changed = true
    return updated
  })
  return changed ? next : steps
}

export const startStartupStep = (
  steps: ReadonlyArray<StartupStep>,
  id: StartupStepId,
  nowMs = performance.now(),
): ReadonlyArray<StartupStep> =>
  updateStep(steps, id, step => {
    const { error: _error, ...stepWithoutError } = step
    return {
      ...stepWithoutError,
      status: step.status === 'done' ? 'done' : 'running',
      startedAtMs: step.startedAtMs ?? nowMs,
    }
  })

export const completeStartupStep = (
  steps: ReadonlyArray<StartupStep>,
  id: StartupStepId,
  nowMs = performance.now(),
): ReadonlyArray<StartupStep> =>
  updateStep(steps, id, step => {
    if (step.status === 'done') return step
    const { error: _error, ...stepWithoutError } = step
    return {
      ...stepWithoutError,
      status: 'done',
      startedAtMs: step.startedAtMs ?? nowMs,
      completedAtMs: nowMs,
    }
  })

export const failStartupStep = (
  steps: ReadonlyArray<StartupStep>,
  id: StartupStepId,
  error: string,
  nowMs = performance.now(),
): ReadonlyArray<StartupStep> =>
  updateStep(steps, id, step => ({
    ...step,
    status: 'failed',
    startedAtMs: step.startedAtMs ?? nowMs,
    completedAtMs: nowMs,
  error,
}))

export const setStartupStepDetails = (
  steps: ReadonlyArray<StartupStep>,
  id: StartupStepId,
  details: ReadonlyArray<StartupStepDetail>,
): ReadonlyArray<StartupStep> =>
  updateStep(steps, id, step => {
    const existing = step.details ?? []
    const unchanged = existing.length === details.length
      && existing.every((detail, index) => (
        detail.label === details[index]?.label
        && detail.value === details[index]?.value
      ))
    return unchanged ? step : { ...step, details }
  })

export const resetStartupStepsAfter = (
  steps: ReadonlyArray<StartupStep>,
  firstResetStepId: StartupStepId,
): ReadonlyArray<StartupStep> => {
  const firstResetIndex = steps.findIndex(step => step.id === firstResetStepId)
  if (firstResetIndex < 0) throw new Error(`unknown startup step: ${firstResetStepId}`)
  return steps.map((step, index) => (
    index < firstResetIndex
      ? step
      : {
          id: step.id,
          label: step.label,
          status: 'pending',
        }
  ))
}

export const startupIsReady = (steps: ReadonlyArray<StartupStep>): boolean =>
  steps.find(step => step.id === 'ready')?.status === 'done'
  && !startupHasFailed(steps)

export const startupHasFailed = (steps: ReadonlyArray<StartupStep>): boolean =>
  steps.some(step => step.status === 'failed')

/** The startup checklist shows while steps run or after one failed; once every step succeeded there is nothing to read. */
export const startupModalShouldShow = (config: {
  readonly routeMode: 'picker' | 'simulation-run'
  readonly dismissed: boolean
  readonly steps: ReadonlyArray<StartupStep>
}): boolean =>
  config.routeMode === 'simulation-run'
  && !config.dismissed
  && !startupIsReady(config.steps)
