import { resolve } from 'node:path'
import { workspaceIdSchema, type WorkspaceId } from '@leitbild/contracts'
import type { WorkspaceRuntimeRegistry } from '../core/workspaces/runtime-registry.ts'
import type { AgentsModuleState } from '../core/workspaces/module-state.ts'
import type { WSData, WSManager } from './ws-types.ts'
import { DEFAULTS } from '../core/types/constants.ts'
import {
  authEnabled,
  buildSessionCookie,
  getAuthLimiter,
  isValidSession,
  issueSession,
  sessionFromRequest,
  validateToken,
} from './auth.ts'
import { handleAPI, handleUnscopedAPI } from './http-routes.ts'
import { handleWSMessage } from './ws-handler.ts'
import { createOpenAccessContext } from '../core/workspaces/request-context.ts'
import { resolveApplicationApiPath } from './api-path.ts'
import { handleAgentsModuleApi } from './workspace-module-api.ts'
import { CAPABILITY_INVOKE_IDLE_SECONDS, isCapabilityInvokeRequest } from './capability-invoke-timeout.ts'
import type { PackManager } from '../packs/manager.ts'
import { serveAgentsUiAsset } from './ui-assets.ts'

interface ServerConfig {
  readonly registry: WorkspaceRuntimeRegistry
  readonly moduleState: AgentsModuleState
  readonly wsManager: WSManager
  readonly port?: number
  readonly bindHost?: string
  readonly uiPath?: string
  readonly workspaceHostUrl?: string
  readonly diagnostics: import('./routes/types.ts').DiagnosticsCapability
  readonly packManager: PackManager
}

const workspaceIdFromPagePath = (pathname: string): WorkspaceId | null => {
  const match = pathname.match(/^\/workspaces\/([^/]+)\/agents$/)
  if (!match) return null
  try {
    const parsed = workspaceIdSchema.safeParse(decodeURIComponent(match[1] ?? ''))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

const serveStatic = async (pathname: string, uiPath: string): Promise<Response | null> => {
  if (workspaceIdFromPagePath(pathname) !== null || pathname === '/index.html') {
    const file = Bun.file(`${uiPath}/dist/index.html`)
    if (await file.exists()) return new Response(file, { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' } })
    return new Response('<h1>Leitbild</h1><p>UI unavailable.</p>', { headers: { 'Content-Type': 'text/html' } })
  }

  return await serveAgentsUiAsset(pathname, uiPath)
}

const applySecurityHeaders = (response: Response): Response => {
  response.headers.set('X-Content-Type-Options', 'nosniff')
  response.headers.set('X-Frame-Options', 'SAMEORIGIN')
  if (!response.headers.has('Referrer-Policy')) response.headers.set('Referrer-Policy', 'same-origin')
  return response
}

export const createServer = (config: ServerConfig) => {
  const { registry, wsManager } = config
  const port = config.port ?? DEFAULTS.port
  const bindHost = config.bindHost ?? process.env.LEITBILD_BIND_HOST ?? '0.0.0.0'
  const uiPath = resolve(config.uiPath ?? `${import.meta.dir}/../ui`)

  const server = Bun.serve<WSData>({
    port,
    hostname: bindHost,
    async fetch(request, bunServer) {
      const url = new URL(request.url)
      const pathname = url.pathname
      const secure = applySecurityHeaders

      if (isCapabilityInvokeRequest(request, url)) bunServer.timeout(request, CAPABILITY_INVOKE_IDLE_SECONDS)
      const moduleResponse = await handleAgentsModuleApi(request, url, {
        state: config.moduleState,
        registry,
      })
      if (moduleResponse) return secure(moduleResponse)

      if (authEnabled()) {
        const token = url.searchParams.get('token')
        if (token) {
          const remoteAddress = bunServer.requestIP(request)?.address
          const limit = getAuthLimiter().check(remoteAddress)
          if (!limit.ok) {
            const retryAfter = Math.ceil(limit.retryAfterMs / 1_000)
            return secure(new Response('Too many auth attempts', {
              status: 429,
              headers: { 'Retry-After': String(retryAfter) },
            }))
          }
          if (validateToken(token)) {
            const target = new URL(url)
            target.searchParams.delete('token')
            return secure(new Response(null, {
              status: 303,
              headers: {
                Location: `${target.pathname}${target.search}`,
                'Set-Cookie': buildSessionCookie(issueSession()),
              },
            }))
          }
          console.warn(`[auth] failed ?token= attempt from ${remoteAddress ?? 'unknown'}`)
        }
      }

      const unscoped = await handleUnscopedAPI(request, pathname, {
        remoteAddress: bunServer.requestIP(request)?.address,
        diagnostics: config.diagnostics,
      })
      if (unscoped) return secure(unscoped)

      if ((pathname === '/' || pathname === '/index.html') && request.method === 'GET') {
        const location = config.workspaceHostUrl ?? process.env.WORKSPACE_HOST_URL
        return location
          ? secure(new Response(null, { status: 303, headers: { Location: location } }))
          : secure(Response.json({ error: { code: 'workspace_host_required', message: 'Open this Module through the Workspace Host' } }, { status: 404 }))
      }

      const applicationPath = resolveApplicationApiPath(pathname)
      if (applicationPath.kind === 'invalid-api') {
        return secure(Response.json({ error: { code: applicationPath.code, message: applicationPath.message } }, {
          status: applicationPath.code === 'invalid_workspace_id' ? 400 : 404,
        }))
      }

      const pageWorkspaceId = workspaceIdFromPagePath(pathname)
      const workspaceId = applicationPath.kind === 'workspace'
        ? applicationPath.workspaceId
        : pageWorkspaceId

      const staticResponse = await serveStatic(pathname, uiPath)
      if (staticResponse) {
        if (pageWorkspaceId !== null && !(await registry.exists(pageWorkspaceId))) {
          return secure(Response.json({ error: { code: 'workspace_not_provisioned', message: 'Leitbild is not enabled in this Workspace' } }, { status: 404 }))
        }
        return secure(staticResponse)
      }
      if (pathname === '/favicon.ico') return secure(new Response(null, { status: 204 }))

      const isRealtime = applicationPath.kind === 'workspace' && applicationPath.internalPath === '/ws'
      if (isRealtime) {
        if (authEnabled() && !isValidSession(sessionFromRequest(request))) return secure(new Response('Unauthorized', { status: 401 }))
        if (!(await registry.exists(applicationPath.workspaceId))) {
          return secure(Response.json({ error: { code: 'workspace_not_provisioned', message: 'Leitbild is not enabled in this Workspace' } }, { status: 404 }))
        }
        const sessionToken = url.searchParams.get('session') ?? crypto.randomUUID()
        wsManager.releaseSessionForWorkspaceSwitch(sessionToken, applicationPath.workspaceId)
        const focusedRoomId = url.searchParams.get('room')?.trim() || undefined
        const upgraded = bunServer.upgrade(request, {
          data: { sessionToken, workspaceId: applicationPath.workspaceId, ...(focusedRoomId ? { focusedRoomId } : {}) },
        })
        return upgraded ? undefined : secure(new Response('WebSocket upgrade failed', { status: 500 }))
      }

      if (applicationPath.kind !== 'workspace' || workspaceId === null) {
        return secure(Response.json({ error: { code: 'route_not_found', message: 'Unknown Module route' } }, { status: 404 }))
      }
      if (authEnabled() && !isValidSession(sessionFromRequest(request))) return secure(new Response('Unauthorized', { status: 401 }))
      if (!(await registry.exists(workspaceId))) {
        return secure(Response.json({ error: { code: 'workspace_not_provisioned', message: 'Leitbild is not enabled in this Workspace' } }, { status: 404 }))
      }

      return await registry.withWorkspace(workspaceId, async () => {
      const runtime = await registry.getOrLoad(workspaceId)
      const apiResponse = await handleAPI(
        request,
        applicationPath.internalPath,
        runtime,
        workspaceId,
        createOpenAccessContext(workspaceId, request),
        {
          broadcastAllWorkspaces: wsManager.broadcastAllWorkspaces,
          subscribeAgentState: wsManager.subscribeAgentState,
          unsubscribeAgentState: wsManager.unsubscribeAgentState,
          remoteAddress: bunServer.requestIP(request)?.address,
          broadcastToWorkspace: wsManager.broadcastToWorkspace,
          packManager: config.packManager,
          roomDefinitions: registry.definitionsFor(workspaceId),
          diagnostics: config.diagnostics,
        },
      )
      return secure(apiResponse ?? Response.json({ error: { code: 'route_not_found', message: 'Unknown API route' } }, { status: 404 }))
      })
    },

    websocket: {
      async open(ws) {
        await registry.getOrLoad(ws.data.workspaceId)
        const existing = wsManager.sessions.get(ws.data.sessionToken)
        const sameView = existing?.focusedRoomId === ws.data.focusedRoomId
        const session = existing && sameView ? existing : {
          workspaceId: ws.data.workspaceId,
          sessionToken: ws.data.sessionToken,
          ...(ws.data.focusedRoomId ? { focusedRoomId: ws.data.focusedRoomId } : {}),
          lastActivity: Date.now(),
        }
        wsManager.sessions.set(ws.data.sessionToken, session)
        session.lastActivity = Date.now()
        wsManager.wsConnections.set(ws.data.sessionToken, ws)
        const snapshot = wsManager.buildSnapshot(ws.data.workspaceId, ws.data.sessionToken)
        if (!snapshot) {
          ws.close(4001, 'Workspace unavailable')
          return
        }
        wsManager.safeSend(ws, JSON.stringify(snapshot))
      },
      async message(ws, raw) {
        const session = wsManager.sessions.get(ws.data.sessionToken)
        if (!session) return
        if (session.workspaceId !== ws.data.workspaceId) {
          ws.close(4003, 'Workspace switched')
          return
        }
        session.lastActivity = Date.now()
        await registry.withWorkspace(ws.data.workspaceId, async () => handleWSMessage(
          ws,
          session,
          typeof raw === 'string' ? raw : raw.toString(),
          await registry.getOrLoad(ws.data.workspaceId),
          wsManager,
        ))
      },
      close(ws) {
        if (wsManager.wsConnections.get(ws.data.sessionToken) === ws) {
          wsManager.wsConnections.delete(ws.data.sessionToken)
        }
      },
    },
  })

  console.log(`Leitbild Modules listening on http://${bindHost}:${port}`)
  return server
}
