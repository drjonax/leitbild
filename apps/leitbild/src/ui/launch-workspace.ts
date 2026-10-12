// Which Workspace a launch or a question goes to (plan v2 §2, §5.3 step 3):
// the explicit choice, else the remembered one if it still exists, else a new
// "New Workspace · 12 Oct, 22:41". Only Host endpoints are read here, so no
// Module runtime loads before the user acts.

import type { Workspace } from '@leitbild/contracts'
import type { WorkspaceMemory } from './workspace-memory.ts'

export type RequiredModule = 'world' | 'agents'
export type ModuleReadiness = 'ready' | 'provisioning' | 'failed' | 'missing'

export const LAST_WORKSPACE_GONE_TEXT = 'Your last Workspace no longer exists.'

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** An HTTP failure from the Host, shaped like `api.ts` request errors. */
export type HostRequestError = Error & {
  readonly status: number
  readonly code?: string
}

export interface WorkspaceApi {
  /** Null when the Workspace does not exist (404). */
  get(workspaceId: string, signal?: AbortSignal): Promise<Workspace | null>
  list(signal?: AbortSignal): Promise<ReadonlyArray<Workspace>>
  create(name: string | null, signal?: AbortSignal): Promise<Workspace>
  retryModule(workspaceId: string, moduleId: string, signal?: AbortSignal): Promise<Workspace>
}

const hostRequestError = (status: number, code: string | undefined, message: string): HostRequestError =>
  Object.assign(new Error(message), { status, ...(code === undefined ? {} : { code }) })

export const readHostJson = async (response: Response): Promise<unknown> => {
  const body = await response.json().catch(() => undefined) as { error?: { code?: unknown; message?: unknown } } | undefined
  if (!response.ok) {
    const code = typeof body?.error?.code === 'string' ? body.error.code : undefined
    const message = typeof body?.error?.message === 'string' ? body.error.message : `Request failed: ${response.status}`
    throw hostRequestError(response.status, code, message)
  }
  return body
}

// The contract schema validates every Workspace the UI acts on. It is loaded
// on first use so the landing page's first paint does not carry zod.
const parseWorkspace = async (value: unknown): Promise<Workspace> => {
  const { workspaceSchema } = await import('@leitbild/contracts')
  return workspaceSchema.parse(value)
}
const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined

export const createWorkspaceApi = (fetchImpl: FetchLike = (input, init) => fetch(input, init)): WorkspaceApi => {
  const send = (path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> =>
    fetchImpl(path, signal === undefined ? init : { ...init, signal })
  const json = (method: string, body: unknown): RequestInit => ({
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return {
    get: async (workspaceId, signal) => {
      const response = await send(`/api/workspaces/${encodeURIComponent(workspaceId)}`, { method: 'GET' }, signal)
      if (response.status === 404) return null
      return parseWorkspace(field(await readHostJson(response), 'workspace'))
    },
    list: async signal => {
      const body = await readHostJson(await send('/api/workspaces', { method: 'GET' }, signal))
      const items = field(body, 'workspaces')
      if (!Array.isArray(items)) throw new Error('The Workspace list response has no workspaces')
      return Promise.all(items.map(parseWorkspace))
    },
    create: async (name, signal) => {
      const body = await readHostJson(await send('/api/workspaces', json('POST', { name }), signal))
      return parseWorkspace(field(body, 'workspace'))
    },
    retryModule: async (workspaceId, moduleId, signal) => {
      const path = `/api/workspaces/${encodeURIComponent(workspaceId)}/modules/${encodeURIComponent(moduleId)}/retry`
      const body = await readHostJson(await send(path, { method: 'POST' }, signal))
      return parseWorkspace(field(body, 'workspace'))
    },
  }
}

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
const two = (value: number): string => String(value).padStart(2, '0')

/** "12 Oct, 22:41" in the browser's local time (copy style §4.4). */
export const shortDateTime = (at: Date): string =>
  `${at.getDate()} ${months[at.getMonth()]}, ${two(at.getHours())}:${two(at.getMinutes())}`

/** "12 Oct" */
export const shortDate = (at: Date): string => `${at.getDate()} ${months[at.getMonth()]}`

/** The name of a Workspace created for a launch or a question. */
export const newWorkspaceName = (at: Date): string => `New Workspace · ${shortDateTime(at)}`

/** Never a raw UUID: "Untitled · b56b1d" in rows, "Untitled Workspace · b56b1d" in headers. */
export const workspaceLabel = (workspace: { readonly id: string; readonly name: string | null }, form: 'row' | 'header' = 'row'): string =>
  workspace.name ?? `${form === 'header' ? 'Untitled Workspace' : 'Untitled'} · ${workspace.id.slice(0, 6)}`

export const moduleReadiness = (workspace: Pick<Workspace, 'modules'>, moduleId: string): ModuleReadiness => {
  const state = workspace.modules.find(item => item.moduleId === moduleId)
  if (!state) return 'missing'
  if (state.status === 'ready') return 'ready'
  if (state.status === 'provisioning') return 'provisioning'
  return 'failed'
}

const moduleNames: Readonly<Record<RequiredModule, string>> = { world: 'World', agents: 'Agents' }

/** The Workspace exists but the Module the action needs is not ready. Offer Retry and Open. */
export type WorkspaceNotReadyError = Error & {
  readonly code: 'workspace_module_not_ready'
  readonly workspace: Workspace
  readonly moduleId: RequiredModule
  readonly created: boolean
}

export const workspaceNotReady = (workspace: Workspace, moduleId: RequiredModule, created: boolean): WorkspaceNotReadyError =>
  Object.assign(new Error(created
    ? `${moduleNames[moduleId]} could not be prepared in the new Workspace.`
    : `${moduleNames[moduleId]} is not ready in ${workspaceLabel(workspace)}.`), {
    code: 'workspace_module_not_ready' as const, workspace, moduleId, created,
  })

export const isWorkspaceNotReady = (error: unknown): error is WorkspaceNotReadyError =>
  error instanceof Error && (error as Partial<WorkspaceNotReadyError>).code === 'workspace_module_not_ready'

export interface LaunchWorkspace {
  readonly workspace: Workspace
  readonly created: boolean
  /** "Your last Workspace no longer exists." when the remembered one was gone. */
  readonly notice: string | null
}

export interface LaunchWorkspacePorts {
  readonly api: WorkspaceApi
  readonly memory: WorkspaceMemory
  readonly now: () => Date
  readonly signal?: AbortSignal
}

export type LaunchWorkspaceStep =
  | { readonly kind: 'using-workspace'; readonly workspace: Workspace }
  | { readonly kind: 'creating-workspace' }
  | { readonly kind: 'created-workspace'; readonly workspace: Workspace }

export interface LaunchWorkspaceOptions {
  /** A Workspace the user chose on this surface (the wiki's select). Wins over the remembered one. */
  readonly workspaceId?: string | null
  /** "Use a new Workspace instead", or the remembered one lost the demo. */
  readonly forceNew?: boolean
  readonly onstep?: (step: LaunchWorkspaceStep) => void
}

/**
 * The remembered Workspace if it still exists (Host GET only). A 404 forgets
 * it and returns the one-time notice. Used for "Continue in …" and the
 * destination lines; it never loads a Module runtime.
 */
export const rememberedWorkspace = async (
  ports: Pick<LaunchWorkspacePorts, 'api' | 'memory' | 'signal'>,
): Promise<{ readonly workspace: Workspace | null; readonly notice: string | null }> => {
  const id = ports.memory.remembered()
  if (id === null) return { workspace: null, notice: null }
  const workspace = await ports.api.get(id, ports.signal)
  if (workspace) return { workspace, notice: null }
  ports.memory.forget(id)
  return { workspace: null, notice: LAST_WORKSPACE_GONE_TEXT }
}

/**
 * Resolves the target Workspace and checks the required Module is ready.
 * A created Workspace is remembered at once ("creates a Workspace here"), so an
 * aborted or failed launch reuses it next time instead of creating another.
 * Throws `WorkspaceNotReadyError` when the Module is not ready.
 */
export const resolveLaunchWorkspace = async (
  moduleId: RequiredModule,
  ports: LaunchWorkspacePorts,
  options: LaunchWorkspaceOptions = {},
): Promise<LaunchWorkspace> => {
  let notice: string | null = null
  if (options.forceNew !== true) {
    let existing: Workspace | null = null
    if (options.workspaceId) {
      existing = await ports.api.get(options.workspaceId, ports.signal)
      if (!existing) {
        ports.memory.forget(options.workspaceId)
        notice = 'That Workspace no longer exists.'
      }
    } else {
      const remembered = await rememberedWorkspace(ports)
      existing = remembered.workspace
      notice = remembered.notice
    }
    if (existing) {
      options.onstep?.({ kind: 'using-workspace', workspace: existing })
      if (moduleReadiness(existing, moduleId) !== 'ready') throw workspaceNotReady(existing, moduleId, false)
      return { workspace: existing, created: false, notice }
    }
  }
  options.onstep?.({ kind: 'creating-workspace' })
  const workspace = await ports.api.create(newWorkspaceName(ports.now()), ports.signal)
  ports.memory.remember(workspace.id, 'created')
  options.onstep?.({ kind: 'created-workspace', workspace })
  if (moduleReadiness(workspace, moduleId) !== 'ready') throw workspaceNotReady(workspace, moduleId, true)
  return { workspace, created: true, notice }
}
