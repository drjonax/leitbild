// Start demo (plan v2 §5.3): a featured demo starts through the target
// Workspace's own Definition and its published primary Capability, then the
// page opens the new Run. The Host keeps no demo list: the featured catalogue
// is the Modules' own, re-read at click time.
//
// 0 WebGL 2 is checked before anything is created.
// 2 Re-read /api/featured-definitions; a demo that is gone is said so.
// 3 The chosen Workspace (remembered or explicit), or a new one; World ready.
// 4 Match the demo by identity in the Workspace. An edited demo starts the
//   featured revision; a demo deleted in the remembered Workspace starts in a
//   new Workspace instead; missing in a fresh one is an error.
// 5 cardCapability(…, 'primary') or a visible error, never a no-op.
// 6 Invoke. A lost or timed-out invoke may have started the demo: the user is
//   sent to check, never offered a second start.
// 7 The caller navigates to the Run; the Workspace is remembered first.
//
// Every request carries the caller's AbortSignal: × aborts the client flow and
// nothing navigates later.

import type {
  FeaturedDefinitionCatalog,
  ModuleCapabilityDescriptor,
  ModuleDefinitionDescriptor,
  ModuleFeaturedDefinition,
  ModuleFailure,
  Workspace,
} from '@leitbild/contracts'
import { cardCapability } from './card-actions.ts'
import { CAPACITY_TEXT, plainError } from './error-text.ts'
import { workspaceUrl } from './launch-destination.ts'
import {
  isWorkspaceNotReady, readHostJson, resolveLaunchWorkspace, workspaceLabel,
  type LaunchWorkspaceStep, type RequiredModule, type WorkspaceApi,
} from './launch-workspace.ts'
import { demoKey } from './modal-url.ts'
import { WEBGL_MISSING_TEXT } from './webgl-support.ts'
import type { WorkspaceMemory } from './workspace-memory.ts'

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export const FEATURED_PATH = '/api/featured-definitions'

export const NO_DEMOS_TEXT = 'No demos are available right now.'
export const DEMOS_UNAVAILABLE_TEXT = 'Demos are unavailable right now.'
export const NOT_FEATURED_TEXT = 'This demo is no longer featured.'
export const DEEP_LINK_NOT_FEATURED_TEXT = 'That demo is no longer featured.'
export const NOT_AVAILABLE_TEXT = 'This demo is not available in this Workspace right now.'
export const SLOW_TEXT = 'Still starting. Large simulations can take up to 30 s.'
export const VERY_SLOW_TEXT = 'This is taking longer than usual.'
export const SLOW_AFTER_MS = 8_000
export const VERY_SLOW_AFTER_MS = 30_000

const contracts = () => import('@leitbild/contracts')

const fail = (failure: ModuleFailure): Error & { code: string; status?: number } =>
  Object.assign(new Error(failure.message), { code: failure.code, ...(failure.status === undefined ? {} : { status: failure.status }) })

/**
 * The Modules' featured Definitions. The Host answers with an ETag and
 * `no-cache`, so the browser revalidates a catalogue it already holds.
 */
export const readFeaturedCatalogue = async (fetchImpl: FetchLike, signal?: AbortSignal): Promise<FeaturedDefinitionCatalog> => {
  const response = await fetchImpl(FEATURED_PATH, signal === undefined ? { method: 'GET' } : { method: 'GET', signal })
  const body = await readHostJson(response)
  const { featuredDefinitionCatalogSchema } = await contracts()
  return featuredDefinitionCatalogSchema.parse(body)
}

/** What the Demos surfaces show for a catalogue: its demos, or why there are none. */
export const catalogueView = (catalogue: FeaturedDefinitionCatalog, moduleId = 'world'): {
  readonly demos: ReadonlyArray<ModuleFeaturedDefinition>
  readonly empty: string | null
} => {
  const demos = catalogue.definitions.filter(featured => featured.definition.moduleId === moduleId)
  if (demos.length > 0) return { demos, empty: null }
  const outcome = catalogue.modules.find(item => item.moduleId === moduleId)
  return { demos, empty: outcome?.status === 'failed' ? DEMOS_UNAVAILABLE_TEXT : NO_DEMOS_TEXT }
}

/** Where `?demos=<key>` opens: that demo's index, or the first with a notice for an unknown key. */
export const deepLinkedDemo = (demos: ReadonlyArray<ModuleFeaturedDefinition>, key: string | null): {
  readonly index: number
  readonly notice: string | null
} => {
  if (key === null) return { index: 0, notice: null }
  const index = demos.findIndex(featured => demoKey(featured.definition) === key)
  return index >= 0 ? { index, notice: null } : { index: 0, notice: DEEP_LINK_NOT_FEATURED_TEXT }
}

export const sameDefinition = (descriptor: ModuleDefinitionDescriptor, featured: ModuleFeaturedDefinition): boolean =>
  descriptor.ref.moduleId === featured.definition.moduleId
  && descriptor.ref.type === featured.definition.type
  && descriptor.ref.id === featured.definition.id

export type DemoLaunchFailureKind =
  | 'webgl' | 'busy' | 'not-featured' | 'workspace-not-ready' | 'not-available'
  | 'cannot-start' | 'outcome-unknown' | 'capacity' | 'failed' | 'aborted'

export type DemoLaunchError = Error & {
  readonly kind: DemoLaunchFailureKind
  /** The Workspace the launch reached, if any (for "Open ‹name›" and the stopped line). */
  readonly workspace: Workspace | null
  readonly created: boolean
  /** The invoke was sent: the demo may exist even though the client gave up. */
  readonly invoked: boolean
  readonly cause?: unknown
}

export const isDemoLaunchError = (error: unknown): error is DemoLaunchError =>
  error instanceof Error && typeof (error as Partial<DemoLaunchError>).kind === 'string' && 'invoked' in error

const launchError = (
  kind: DemoLaunchFailureKind,
  context: { readonly workspace: Workspace | null; readonly created: boolean; readonly invoked: boolean },
  cause?: unknown,
): DemoLaunchError =>
  Object.assign(new Error(kind), { kind, ...context, ...(cause === undefined ? {} : { cause }) })

const isAbort = (error: unknown, signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')

export type DemoLaunchStep =
  | { readonly kind: 'checking' }
  | LaunchWorkspaceStep
  | { readonly kind: 'starting'; readonly workspace: Workspace; readonly original: boolean }
  | { readonly kind: 'opening'; readonly workspace: Workspace; readonly destination: string }

export interface DemoLaunchRequest {
  /** `demoKey(...)`, e.g. "world:halden-offsite-power-restoration". */
  readonly demo: string
  /** A Workspace named on this surface (Retry after a Module retry). Wins over the remembered one. */
  readonly workspaceId?: string | null
  /** "Use a new Workspace instead". */
  readonly forceNewWorkspace?: boolean
}

export interface DemoLaunchPorts {
  readonly api: WorkspaceApi
  readonly memory: WorkspaceMemory
  readonly now: () => Date
  readonly fetch: FetchLike
  readonly webgl: () => boolean
  readonly signal?: AbortSignal
  readonly onstep?: (step: DemoLaunchStep) => void
}

export interface DemoLaunchResult {
  readonly workspace: Workspace
  readonly created: boolean
  readonly runId: string
  /** `/workspaces/<ws>?world=<run>`; the caller navigates with `location.assign`. */
  readonly destination: string
  /** The Workspace had edited the demo, so the featured revision was started. */
  readonly original: boolean
  readonly notice: string | null
}

interface WorkspaceCatalogue {
  readonly definitions: ReadonlyArray<ModuleDefinitionDescriptor>
  readonly capabilities: ReadonlyArray<ModuleCapabilityDescriptor>
}

const readWorkspaceCatalogue = async (
  workspace: Workspace, moduleId: string, ports: Pick<DemoLaunchPorts, 'fetch' | 'signal'>,
): Promise<WorkspaceCatalogue> => {
  const base = `/api/workspaces/${encodeURIComponent(workspace.id)}`
  const query = `?moduleId=${encodeURIComponent(moduleId)}`
  const init: RequestInit = ports.signal === undefined ? { method: 'GET' } : { method: 'GET', signal: ports.signal }
  const [definitionBody, capabilityBody] = await Promise.all([
    ports.fetch(`${base}/definitions${query}`, init).then(readHostJson),
    ports.fetch(`${base}/capabilities${query}`, init).then(readHostJson),
  ])
  const { workspaceDefinitionCatalogSchema, workspaceCapabilityCatalogSchema } = await contracts()
  const definitions = workspaceDefinitionCatalogSchema.parse(definitionBody)
  const capabilities = workspaceCapabilityCatalogSchema.parse(capabilityBody)
  const failed = [...definitions.modules, ...capabilities.modules].find(outcome => outcome.moduleId === moduleId && outcome.status === 'failed')
  if (failed?.status === 'failed') throw fail(failed.failure)
  return { definitions: definitions.definitions, capabilities: capabilities.capabilities }
}

/** Steps 4–7 in a known Workspace; the Workspace page's Start uses this directly. */
export const startFeaturedInWorkspace = async (
  workspace: Workspace,
  featured: ModuleFeaturedDefinition,
  catalogue: WorkspaceCatalogue,
  ports: Pick<DemoLaunchPorts, 'fetch' | 'memory' | 'signal' | 'onstep'>,
  context: { readonly created: boolean; readonly notice: string | null },
): Promise<DemoLaunchResult> => {
  const at = { workspace, created: context.created, invoked: false }
  const descriptor = catalogue.definitions.find(definition => sameDefinition(definition, featured))
  if (!descriptor) throw launchError('not-available', at)
  let capability: ModuleCapabilityDescriptor | undefined
  try {
    capability = cardCapability(descriptor, 'primary', catalogue.capabilities)
  } catch (error) {
    throw launchError('cannot-start', at, error)
  }
  if (!capability) throw launchError('cannot-start', at)
  const original = descriptor.currentRevisionId !== featured.revisionId
  ports.onstep?.({ kind: 'starting', workspace, original })
  const path = `/api/workspaces/${encodeURIComponent(workspace.id)}/capabilities/${encodeURIComponent(capability.id)}/invoke`
  const body = JSON.stringify({
    definition: { ...descriptor.ref, revisionId: featured.revisionId },
    input: {},
    actor: { kind: 'human' },
  })
  const sent = { ...at, invoked: true }
  let response: Response
  try {
    response = await ports.fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      ...(ports.signal === undefined ? {} : { signal: ports.signal }),
    })
  } catch (error) {
    // The request may have reached the Host: the outcome is unknown.
    throw launchError(isAbort(error, ports.signal) ? 'aborted' : 'outcome-unknown', sent, error)
  }
  let result: unknown
  try {
    result = await readHostJson(response)
  } catch (error) {
    if (isAbort(error, ports.signal)) throw launchError('aborted', sent, error)
    const { code, status } = plainError(error)
    if (code === 'module_outcome_unknown' || status === 504) throw launchError('outcome-unknown', sent, error)
    if (code === 'workspace_capacity_exceeded' || status === 503) throw launchError('capacity', sent, error)
    throw launchError('failed', sent, error)
  }
  const { moduleCapabilityInvocationResultSchema } = await contracts()
  const parsed = moduleCapabilityInvocationResultSchema.safeParse(result)
  const run = parsed.success
    ? parsed.data.createdResources?.find(resource => resource.workspaceId === workspace.id && resource.type === 'world.simulation-run')
    : undefined
  if (!run) throw launchError('outcome-unknown', sent, parsed.success ? new Error('The start reported no Run') : parsed.error)
  if (ports.signal?.aborted) throw launchError('aborted', sent)
  const destination = workspaceUrl(workspace.id, { world: run.id })
  ports.memory.remember(workspace.id, 'launched')
  ports.onstep?.({ kind: 'opening', workspace, destination })
  return { workspace, created: context.created, runId: run.id, destination, original, notice: context.notice }
}

/** Steps 0–7. Throws `DemoLaunchError`. */
export const launchDemo = async (request: DemoLaunchRequest, ports: DemoLaunchPorts): Promise<DemoLaunchResult> => {
  let reached: { workspace: Workspace | null; created: boolean; invoked: boolean } = { workspace: null, created: false, invoked: false }
  const guard = (): void => { if (ports.signal?.aborted) throw launchError('aborted', reached) }
  try {
    if (!ports.webgl()) throw launchError('webgl', reached)
    ports.onstep?.({ kind: 'checking' })
    const catalogue = await readFeaturedCatalogue(ports.fetch, ports.signal)
    guard()
    const featured = catalogue.definitions.find(item => demoKey(item.definition) === request.demo)
    if (!featured) {
      const moduleId = request.demo.split(':')[0]
      const outcome = catalogue.modules.find(item => item.moduleId === moduleId)
      if (outcome?.status === 'failed') throw launchError('failed', reached, fail(outcome.failure))
      throw launchError('not-featured', reached)
    }
    const owner: string = featured.definition.moduleId
    if (owner !== 'world' && owner !== 'agents') throw launchError('cannot-start', reached)
    const moduleId: RequiredModule = owner

    const resolve = async (forceNew: boolean) => {
      const resolved = await resolveLaunchWorkspace(moduleId, ports, {
        ...(forceNew ? { forceNew: true } : request.workspaceId ? { workspaceId: request.workspaceId } : {}),
        onstep: step => {
          if (step.kind !== 'creating-workspace') reached = { ...reached, workspace: step.workspace, created: step.kind === 'created-workspace' }
          ports.onstep?.(step)
        },
      })
      reached = { ...reached, workspace: resolved.workspace, created: resolved.created }
      guard()
      return resolved
    }

    let target = await resolve(request.forceNewWorkspace === true)
    let workspaceCatalogue = await readWorkspaceCatalogue(target.workspace, moduleId, ports)
    guard()
    let notice = target.notice
    if (!target.created && !workspaceCatalogue.definitions.some(definition => sameDefinition(definition, featured))) {
      // Deleted in the chosen Workspace: start it in a new one and say so.
      notice = `${workspaceLabel(target.workspace)} no longer has this demo, so it starts in a new Workspace.`
      target = await resolve(true)
      workspaceCatalogue = await readWorkspaceCatalogue(target.workspace, moduleId, ports)
      guard()
    }
    return await startFeaturedInWorkspace(target.workspace, featured, workspaceCatalogue, ports, { created: target.created, notice })
  } catch (error) {
    if (isDemoLaunchError(error)) throw error
    if (isAbort(error, ports.signal)) throw launchError('aborted', reached, error)
    if (isWorkspaceNotReady(error)) {
      throw launchError('workspace-not-ready', { workspace: error.workspace, created: error.created, invoked: false }, error)
    }
    const { code, status } = plainError(error)
    if (code === 'workspace_capacity_exceeded' || status === 503) throw launchError('capacity', reached, error)
    throw launchError('failed', reached, error)
  }
}

export type DemoLaunchAction = 'try-again' | 'retry-module' | 'open'

/** The sentence and the actions for a failed launch (plain text; the code goes to the console). */
export const launchFailureView = (error: DemoLaunchError): { readonly text: string; readonly actions: ReadonlyArray<DemoLaunchAction> } => {
  const name = error.workspace ? workspaceLabel(error.workspace) : null
  const open: ReadonlyArray<DemoLaunchAction> = name ? ['open'] : []
  switch (error.kind) {
    case 'webgl': return { text: WEBGL_MISSING_TEXT, actions: [] }
    case 'busy': return { text: 'A demo is already starting.', actions: [] }
    case 'not-featured': return { text: NOT_FEATURED_TEXT, actions: [] }
    case 'workspace-not-ready': return { text: error.cause instanceof Error ? error.cause.message : 'World is not ready.', actions: ['retry-module', ...open] }
    case 'not-available': return { text: NOT_AVAILABLE_TEXT, actions: open }
    case 'cannot-start': return { text: name ? `This demo cannot be started in ${name} right now.` : 'This demo cannot be started right now.', actions: ['try-again', ...open] }
    case 'outcome-unknown': return { text: name ? `The demo may have started. Open ${name} to check.` : 'The demo may have started.', actions: open }
    case 'capacity': return { text: CAPACITY_TEXT, actions: ['try-again'] }
    case 'aborted': return { text: stoppedText(error) ?? 'Stopped.', actions: [] }
    case 'failed': {
      const plain = plainError(error.cause)
      // A lost connection asks for a reload; anything else may be tried again from the catalogue.
      return { text: plain.text, actions: plain.action === 'check' ? open : ['try-again'] }
    }
  }
}

/** The landing page's line after × stopped a launch, or null when nothing was left behind. */
export const stoppedText = (error: DemoLaunchError): string | null => {
  if (!error.workspace) return null
  const name = workspaceLabel(error.workspace)
  if (error.created) return error.invoked ? `Stopped. ${name} was created; the demo may appear there.` : `Stopped. ${name} was created.`
  return error.invoked ? `Stopped. The demo may appear in ${name}.` : null
}

/** One status sentence per step (a11y M3). */
export const launchStatusText = (step: DemoLaunchStep, title: string): string => {
  switch (step.kind) {
    case 'checking': return `Starting ${title}…`
    case 'using-workspace': return `Using ${workspaceLabel(step.workspace)}.`
    case 'creating-workspace': return 'Creating a Workspace…'
    case 'created-workspace': return `Created ${workspaceLabel(step.workspace)}.`
    case 'starting': return step.original ? 'Starting the original demo…' : 'Starting the simulation…'
    case 'opening': return 'Opening the simulation…'
  }
}

export type LaunchStepState = 'pending' | 'doing' | 'done'
export interface LaunchStepView {
  readonly id: 'workspace' | 'start' | 'open'
  readonly label: string
  readonly detail: string
  readonly state: LaunchStepState
}

const PUBLIC_NOTE = 'Public: anyone can see, open, change or delete it.'

/** The three real steps, before the first call: the chosen Workspace, or a new one. */
export const initialLaunchSteps = (destination: Pick<Workspace, 'id' | 'name'> | null, title: string): ReadonlyArray<LaunchStepView> => [
  destination
    ? { id: 'workspace', label: `Using ${workspaceLabel(destination)}`, detail: 'Your chosen Workspace', state: 'doing' }
    : { id: 'workspace', label: 'Creating a Workspace', detail: PUBLIC_NOTE, state: 'doing' },
  { id: 'start', label: 'Starting the simulation', detail: title, state: 'pending' },
  { id: 'open', label: 'Opening', detail: 'You can bookmark the address to come back', state: 'pending' },
]

export const advanceLaunchSteps = (steps: ReadonlyArray<LaunchStepView>, step: DemoLaunchStep): ReadonlyArray<LaunchStepView> =>
  steps.map(view => {
    switch (step.kind) {
      case 'checking': return view
      case 'using-workspace':
        if (view.id === 'workspace') return { ...view, label: `Using ${workspaceLabel(step.workspace)}`, detail: 'Your chosen Workspace', state: 'done' }
        return view.id === 'start' ? { ...view, state: 'doing' } : view
      case 'creating-workspace':
        if (view.id === 'workspace') return { ...view, label: 'Creating a Workspace', detail: PUBLIC_NOTE, state: 'doing' }
        return { ...view, state: 'pending' }
      case 'created-workspace':
        if (view.id === 'workspace') return { ...view, label: `Created ${workspaceLabel(step.workspace)}`, detail: PUBLIC_NOTE, state: 'done' }
        return view.id === 'start' ? { ...view, state: 'doing' } : view
      case 'starting':
        if (view.id === 'workspace') return { ...view, state: 'done' }
        if (view.id === 'start') return { ...view, state: 'doing', ...(step.original ? { detail: 'Starts the original demo' } : {}) }
        return view
      case 'opening':
        return view.id === 'open' ? { ...view, state: 'doing' } : { ...view, state: 'done' }
    }
  })

export interface SlowScheduler {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

/** Calls `onlevel(1)` at 8 s and `onlevel(2)` at 30 s; returns the cancel function. */
export const watchSlowLaunch = (scheduler: SlowScheduler, onlevel: (level: 1 | 2) => void): () => void => {
  const handles = [
    scheduler.setTimeout(() => onlevel(1), SLOW_AFTER_MS),
    scheduler.setTimeout(() => onlevel(2), VERY_SLOW_AFTER_MS),
  ]
  return () => { for (const handle of handles) scheduler.clearTimeout(handle) }
}

export interface DemoLauncher {
  busy(): boolean
  /** Starts a launch; a second start while one runs is refused with kind 'busy'. */
  start(request: DemoLaunchRequest, ports: Omit<DemoLaunchPorts, 'signal'>): Promise<DemoLaunchResult>
  /** × while busy: abort the client flow. The pending start rejects with kind 'aborted'. */
  cancel(): void
}

/** The page's one in-flight flag: create one per page. */
export const createDemoLauncher = (): DemoLauncher => {
  let controller: AbortController | null = null
  return {
    busy: () => controller !== null,
    start: async (request, ports) => {
      if (controller) throw launchError('busy', { workspace: null, created: false, invoked: false })
      const own = new AbortController()
      controller = own
      try {
        return await launchDemo(request, { ...ports, signal: own.signal })
      } finally {
        if (controller === own) controller = null
      }
    },
    cancel: () => {
      const current = controller
      controller = null
      current?.abort()
    },
  }
}
