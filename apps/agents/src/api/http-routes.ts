// ============================================================================
// HTTP Routes — Shared helpers + thin route-table dispatcher.
//
// Pure request→response functions. No WebSocket or server lifecycle concerns.
// All routes delegate to AgentsWorkspaceRuntime methods — no business logic here.
//
// Route modules live in routes/ by application concern.
// The dispatcher iterates the route table, matches method+pattern, calls handler.
// ============================================================================

import type { AgentsWorkspaceRuntime } from '../workspace-runtime.ts'
import type { WSOutbound } from '../core/types/ws-protocol.ts'
import { authEnabled, isValidSession, sessionFromRequest } from './auth.ts'
import { runtimeRoutes } from './routes/runtime.ts'
import { workspaceSettingsRoutes } from './routes/workspace-settings.ts'
import { skillRoutes } from './routes/skills.ts'
import { roomRoutes } from './routes/rooms.ts'
import { comparisonRoutes } from './routes/comparisons.ts'
import { displayRequestRoutes } from './routes/display-requests.ts'
import { agentRoutes } from './routes/agents.ts'
import { agentMemoryRoutes } from './routes/agents-memory.ts'
import { messageRoutes } from './routes/messages.ts'
import { ollamaRoutes } from './routes/ollama.ts'
import { providersListRoutes } from './routes/providers-list.ts'
import { providersConfigRoutes } from './routes/providers-config.ts'
import { providersTestRoutes } from './routes/providers-test.ts'
import { triggerRoutes } from './routes/triggers.ts'
import { packsRoutes } from './routes/packs.ts'
import { authResponse, systemInfoResponse, systemRoutes } from './routes/system.ts'
import { json, errorResponse } from './routes/helpers.ts'
import { bugRoutes, submitFeedback } from './routes/bugs.ts'
import { bookmarkRoutes } from './routes/bookmarks.ts'
import { toolRoutes } from './routes/tools.ts'
import { loggingRoutes } from './routes/logging.ts'
import { scriptRoutes } from './routes/scripts.ts'
import { promptDeckRoutes } from './routes/prompt-decks.ts'
import { geodataRoutes } from './routes/geodata.ts'
import { documentRoutes } from './routes/documents.ts'
import { diagnosticRoutes } from './routes/diagnostics.ts'
import { productSourceRoutes } from './routes/product-sources.ts'
import type { RouteContext } from './routes/types.ts'
import type { AccessContext, WorkspaceId } from '@leitbild/contracts'

// Route helpers live in ./routes/helpers.ts to keep http-routes.ts cycle-free.

// === Route Table ===
// Order matters: more-specific patterns (e.g. /rooms/:name/todos/:id) before general ones.

const allRoutes = [
  // Tool routes come before runtimeRoutes so /tools/:name + /tools/rescan
  // are matched before any catch-all patterns elsewhere.
  ...toolRoutes,
  ...runtimeRoutes,
  ...workspaceSettingsRoutes,
  ...skillRoutes,
  ...ollamaRoutes,
  ...providersListRoutes,
  ...providersConfigRoutes,
  ...providersTestRoutes,
  // Trigger routes BEFORE agentRoutes so /agents/:name/triggers matches first.
  ...triggerRoutes,
  ...packsRoutes,
  ...systemRoutes,
  ...bugRoutes,
  ...loggingRoutes,
  ...bookmarkRoutes,
  // Scripts before rooms (avoids /rooms/:name/script being shadowed)
  ...scriptRoutes,
  ...promptDeckRoutes,
  // Geodata routes use Workspace-scoped application paths even though the
  // underlying catalog is process-wide.
  ...geodataRoutes,
  // RAG documents — per-Workspace corpus.
  ...documentRoutes,
  // Read-only, allowlisted deployed product source used by citation modals.
  ...productSourceRoutes,
  ...roomRoutes,
  ...comparisonRoutes,
  ...displayRequestRoutes,
  // Agent-memory routes BEFORE agentRoutes so /agents/:name/memory
  // matches before /agents/:name (which would shadow it).
  ...agentMemoryRoutes,
  // Diagnostic routes BEFORE agentRoutes so /agents/:name/surface
  // matches before /agents/:name. Also covers /diagnostics/*.
  ...diagnosticRoutes,
  ...agentRoutes,
  ...messageRoutes,
]

// === Dispatcher ===

// Per-request dependencies: everything routes need that isn't `req` /
// `pathname` / `system` / `workspaceId`. Bundled into one shape so the
// server.ts → handleAPI seam stays narrow as new cross-cutting capabilities
// land (Workspace context, diagnostics, …).
export interface RouteDeps {
  readonly broadcastAllWorkspaces: (msg: WSOutbound) => void
  readonly subscribeAgentState: RouteContext['subscribeAgentState']
  readonly unsubscribeAgentState?: (agentId: string) => void
  readonly remoteAddress?: string
  readonly broadcastToWorkspace: RouteContext['broadcastToWorkspace']
  readonly packManager: RouteContext['packManager']
  readonly roomDefinitions: RouteContext['roomDefinitions']
  readonly diagnostics?: RouteContext['diagnostics']
}

// Routes that are process-global and intentionally usable without a
// Workspace URL. Dispatch them before registry.getOrLoad.
export const handleUnscopedAPI = async (
  req: Request,
  pathname: string,
  deps: Pick<RouteDeps, 'remoteAddress' | 'diagnostics'>,
): Promise<Response | null> => {
  if (pathname === '/health' && req.method === 'GET') {
    const diagnostics = deps.diagnostics?.snapshot() ?? { workspaces: [], wsSessions: 0 }
    return json({
      status: 'ok',
      scope: 'process',
      workspaces: diagnostics.workspaces.length,
      wsSessions: diagnostics.wsSessions,
    })
  }
  if (pathname === '/api/system/info' && req.method === 'GET') {
    return systemInfoResponse()
  }
  if (pathname === '/api/system/feedback' && req.method === 'POST') {
    // Anonymous product feedback needs neither a Workspace nor an Agent.
    if (req.headers.get('sec-fetch-site') === 'cross-site') return errorResponse('Cross-site feedback is not accepted', 403)
    return submitFeedback(req, deps.remoteAddress)
  }
  if (pathname === '/api/auth' && (req.method === 'GET' || req.method === 'POST')) {
    return authResponse(req, deps.remoteAddress)
  }
  if (pathname === '/api/system/diagnostics' && req.method === 'GET') {
    if (authEnabled() && !isValidSession(sessionFromRequest(req))) {
      return new Response('Unauthorized', { status: 401 })
    }
    if (!deps.diagnostics) return new Response('diagnostics not wired', { status: 500 })
    return json(deps.diagnostics.snapshot())
  }
  return null
}

export const handleAPI = async (
  req: Request,
  pathname: string,
  system: AgentsWorkspaceRuntime,
  workspaceId: WorkspaceId,
  accessContext: AccessContext,
  deps: RouteDeps,
): Promise<Response | null> => {
  const ctx: RouteContext = { system, workspaceId, accessContext, ...deps }

  for (const route of allRoutes) {
    if (route.method !== req.method) continue
    const match = pathname.match(route.pattern)
    if (match) return route.handler(req, match, ctx)
  }

  return null
}
