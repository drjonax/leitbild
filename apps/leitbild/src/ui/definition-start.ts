// Starting a Definition from the Workspace page with visible progress (plan v2
// §5.3 steps 4–7): re-read the Definition and its Module's Capabilities, take
// the declared primary Capability, invoke it, then open what it created. Every
// failure ends in plain text and an explicit next action; a missing Capability
// is an error, never a no-op. One start runs per page at a time.

import type { ModuleCapabilityDescriptor, ModuleDefinitionDescriptor } from '@leitbild/contracts'
import { cardCapability } from './card-actions.ts'
import { errorDiagnostic, plainError, type ErrorAction } from './error-text.ts'
import { launchDestination, type CreatedResourceRef } from './launch-destination.ts'
import { readHostJson } from './launch-workspace.ts'

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export type StartStepId = 'checking' | 'starting' | 'opening'
export interface StartStep {
  readonly id: StartStepId
  readonly label: string
}

export const STILL_STARTING_TEXT = 'Still starting. Large simulations can take up to 30 s.'
export const LONG_START_TEXT = 'This is taking longer than usual.'
export const STILL_STARTING_MS = 8_000
export const LONG_START_MS = 30_000

/** The real steps, one per Host call, worded for what the Module starts. */
export const startSteps = (moduleId: string): ReadonlyArray<StartStep> => [
  { id: 'checking', label: moduleId === 'world' ? 'Checking the scenario' : 'Checking the definition' },
  { id: 'starting', label: moduleId === 'world' ? 'Starting the simulation' : moduleId === 'agents' ? 'Creating the conversation' : 'Starting' },
  { id: 'opening', label: 'Opening' },
]

/** One sentence for the page's status region per step. */
export const startStepStatus = (moduleId: string, step: StartStepId): string =>
  `${startSteps(moduleId).find(item => item.id === step)!.label}…`

export interface StartTarget {
  /** Which card or row shows the progress. */
  readonly key: string
  readonly workspaceId: string
  readonly definition: { readonly moduleId: string; readonly type: string; readonly id: string }
  /** A featured demo starts its featured revision; otherwise the Workspace's current one. */
  readonly revisionId?: string
  readonly featured?: boolean
}

export type StartFailureAction = ErrorAction
export type StartState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'busy'; readonly key: string; readonly moduleId: string; readonly step: StartStepId; readonly slow: 'none' | 'still' | 'long' }
  | { readonly phase: 'failed'; readonly key: string; readonly moduleId: string; readonly step: StartStepId; readonly text: string; readonly action: StartFailureAction }

export interface StartResult {
  /** Where the created Run or conversation opens, or null when the Capability created nothing to open. */
  readonly destination: string | null
}

export interface StartScheduler {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface StartRunnerPorts {
  readonly fetch: FetchLike
  readonly scheduler?: StartScheduler
}

export interface StartRunner {
  state(): StartState
  subscribe(listener: (state: StartState) => void): () => void
  /** Null when another start is in flight, it failed (see `state()`) or it was cancelled. */
  start(target: StartTarget): Promise<StartResult | null>
  /** Try again: restarts from the check, with the same target. */
  retry(): Promise<StartResult | null>
  /** Stops waiting on the client; the Module may still finish. */
  cancel(): void
  /** Clears a failure. */
  dismiss(): void
}

type StartError = Error & { readonly startText: string; readonly startAction: StartFailureAction }
const startError = (text: string, action: StartFailureAction, cause?: unknown): StartError =>
  Object.assign(new Error(text, cause === undefined ? undefined : { cause }), { startText: text, startAction: action })
const isStartError = (error: unknown): error is StartError =>
  error instanceof Error && typeof (error as Partial<StartError>).startText === 'string'
const isAbort = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError'

export const notAvailableText = (target: Pick<StartTarget, 'featured' | 'definition'>): string =>
  target.featured
    ? 'This demo is not available in this Workspace right now.'
    : target.definition.moduleId === 'world' ? 'This scenario is no longer in this Workspace.' : 'This is no longer in this Workspace.'
export const cannotStartText = (target: Pick<StartTarget, 'definition'>): string =>
  target.definition.moduleId === 'world' ? 'This scenario cannot be started right now.' : 'This cannot be started right now.'
export const outcomeUnknownText = (target: Pick<StartTarget, 'definition'>): string =>
  target.definition.moduleId === 'world'
    ? 'The simulation may have started. Check Continue on this page before starting it again.'
    : 'It may have started. Check Continue on this page before starting it again.'

const sameIdentity = (descriptor: ModuleDefinitionDescriptor, target: StartTarget): boolean =>
  descriptor.ref.moduleId === target.definition.moduleId && descriptor.ref.type === target.definition.type && descriptor.ref.id === target.definition.id

const browserScheduler: StartScheduler = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export const createStartRunner = (ports: StartRunnerPorts): StartRunner => {
  const scheduler = ports.scheduler ?? browserScheduler
  const listeners = new Set<(state: StartState) => void>()
  let current: StartState = { phase: 'idle' }
  let lastTarget: StartTarget | null = null
  let controller: AbortController | null = null
  let timers: unknown[] = []

  // Read through a function: the callbacks below change `current` behind the compiler's narrowing.
  const now = (): StartState => current
  const set = (next: StartState): void => {
    current = next
    for (const listener of listeners) listener(current)
  }
  const clearTimers = (): void => {
    for (const handle of timers) scheduler.clearTimeout(handle)
    timers = []
  }
  const step = (target: StartTarget, id: StartStepId): void => {
    set({ phase: 'busy', key: target.key, moduleId: target.definition.moduleId, step: id, slow: current.phase === 'busy' ? current.slow : 'none' })
  }
  const slow = (level: 'still' | 'long'): void => {
    if (current.phase === 'busy') set({ ...current, slow: level })
  }

  const getJson = async (path: string, signal: AbortSignal): Promise<unknown> =>
    readHostJson(await ports.fetch(path, { method: 'GET', signal }))

  const run = async (target: StartTarget, signal: AbortSignal): Promise<StartResult> => {
    const workspace = encodeURIComponent(target.workspaceId)
    const module = encodeURIComponent(target.definition.moduleId)
    const [definitionBody, capabilityBody] = await Promise.all([
      getJson(`/api/workspaces/${workspace}/definitions?moduleId=${module}`, signal),
      getJson(`/api/workspaces/${workspace}/capabilities?moduleId=${module}`, signal),
    ])
    const { workspaceDefinitionCatalogSchema, workspaceCapabilityCatalogSchema } = await import('@leitbild/contracts')
    const definitions = workspaceDefinitionCatalogSchema.parse(definitionBody)
    const capabilityCatalog = workspaceCapabilityCatalogSchema.parse(capabilityBody)
    const failure = [...definitions.modules, ...capabilityCatalog.modules].find(outcome => outcome.status === 'failed')
    if (failure?.status === 'failed') {
      console.error(errorDiagnostic(failure.failure))
      throw startError(plainError(failure.failure).text, 'try-again')
    }
    const descriptor = definitions.definitions.find(candidate => sameIdentity(candidate, target))
    if (descriptor === undefined) throw startError(notAvailableText(target), 'check')
    let capability: ModuleCapabilityDescriptor | undefined
    try {
      capability = cardCapability(descriptor, 'primary', capabilityCatalog.capabilities)
    } catch (error) {
      console.error(error)
      throw startError(cannotStartText(target), 'try-again')
    }
    if (capability === undefined) throw startError(cannotStartText(target), 'try-again')

    step(target, 'starting')
    let response: { readonly createdResources?: ReadonlyArray<CreatedResourceRef> }
    try {
      response = await readHostJson(await ports.fetch(`/api/workspaces/${workspace}/capabilities/${encodeURIComponent(capability.id)}/invoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          definition: { ...descriptor.ref, revisionId: target.revisionId ?? descriptor.currentRevisionId },
          input: {},
          actor: { kind: 'human' },
        }),
        signal,
      })) as typeof response
    } catch (error) {
      if (isAbort(error)) throw error
      console.error(errorDiagnostic(error))
      const plain = plainError(error)
      // World refuses idempotency keys, so a lost answer is never retried blindly.
      if (plain.code === 'module_outcome_unknown') throw startError(outcomeUnknownText(target), 'check', error)
      throw startError(plain.text, plain.action, error)
    }

    step(target, 'opening')
    const created = response.createdResources ?? []
    const opens = created.some(resource =>
      (resource.moduleId === 'world' && resource.type === 'world.simulation-run') || (resource.moduleId === 'agents' && resource.type === 'agents.room'))
    return { destination: opens ? launchDestination(target.workspaceId, created) : null }
  }

  const start = async (target: StartTarget): Promise<StartResult | null> => {
    if (current.phase === 'busy') return null
    lastTarget = target
    const ownController = new AbortController()
    controller = ownController
    clearTimers()
    set({ phase: 'busy', key: target.key, moduleId: target.definition.moduleId, step: 'checking', slow: 'none' })
    timers = [
      scheduler.setTimeout(() => slow('still'), STILL_STARTING_MS),
      scheduler.setTimeout(() => slow('long'), LONG_START_MS),
    ]
    try {
      const result = await run(target, ownController.signal)
      if (controller !== ownController) return null
      return result
    } catch (error) {
      if (controller !== ownController || isAbort(error)) return null
      const state = now()
      const failedStep = state.phase === 'busy' ? state.step : 'checking'
      if (isStartError(error)) {
        set({ phase: 'failed', key: target.key, moduleId: target.definition.moduleId, step: failedStep, text: error.startText, action: error.startAction })
      } else {
        console.error(errorDiagnostic(error))
        const plain = plainError(error)
        set({ phase: 'failed', key: target.key, moduleId: target.definition.moduleId, step: failedStep, text: plain.text, action: plain.action })
      }
      return null
    } finally {
      if (controller === ownController) {
        clearTimers()
        controller = null
      }
    }
  }

  return {
    state: () => current,
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    start,
    retry: () => {
      if (lastTarget === null || current.phase === 'busy') return Promise.resolve(null)
      return start(lastTarget)
    },
    cancel: () => {
      controller?.abort()
      controller = null
      clearTimers()
      set({ phase: 'idle' })
    },
    dismiss: () => {
      if (current.phase === 'failed') set({ phase: 'idle' })
    },
  }
}

/** The page's one status sentence for the current state (empty when idle or failed; failures are alerts). */
export const startAnnouncement = (state: StartState): string => {
  if (state.phase !== 'busy') return ''
  if (state.slow === 'long') return LONG_START_TEXT
  if (state.slow === 'still') return STILL_STARTING_TEXT
  return startStepStatus(state.moduleId, state.step)
}
