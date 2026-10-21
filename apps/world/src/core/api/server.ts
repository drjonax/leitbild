import { resolve, normalize } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { z } from 'zod'
import { actorIdSchema, clientIdSchema, simulationRunIdSchema, nowIso, type SimulationRunId } from '../model/index.ts'
import type { SimulationRunRegistry } from '../simulation-runs/registry.ts'
import {
  createMapArtifactConfigFromEnv,
  createMapArtifactStatus,
  currentPmtilesResponse,
  overviewPmtilesResponse,
  currentTerrainPmtilesResponse,
  currentTerrainRasterTileResponse,
  currentTerrainTileJsonResponse,
  currentVectorTileResponse,
  currentSceneryTilesetResponse,
  currentSceneryTileResponse,
  mapGlyphResponse,
  mapCapabilitiesResponse,
  mapStyleResponse,
  referenceDatasetPmtilesResponse,
  referenceDatasetVectorTileResponse,
  type MapArtifactConfig,
} from '../../map/artifacts.ts'
import {
  buildSimulationRunActor,
  capabilityInvocationRequestSchema,
  handleSimulationRunApi,
} from './simulation-run-routes.ts'
import { createSimulationRunRealtimeManager, emptyRealtimeStatus, type ClientPerspective, type RealtimeStatus, type SimulationRunRealtimeManager } from './realtime.ts'
import { actorForPerspective, assertHoldsRole, isRoleGateRefusal, parseRoleSetParameter, resolveRunPerspective, roleSetParameter } from '../simulation-runs/role-gates.ts'
import { apiError, json } from './responses.ts'
import { workspaceIdSchema, type ModuleFeaturedDefinitionCollection, type WorkspaceId } from '@leitbild/contracts'
import { createOpenAccessContext } from '../workspaces/request-context.ts'
import type { WorldWorkspaceRuntime, WorldWorkspaceRuntimeRegistry } from '../workspaces/runtime-registry.ts'
import { handleWorldActivity, handleWorldFeaturedDefinitions, handleWorldModuleApi } from './workspace-module-api.ts'

const frameAncestorsHeader = "frame-ancestors 'self'"
const capabilityInvokePath = /\/capabilities\/[^/]+\/invoke$/
const workspaceLifecyclePath = /^\/internal\/workspaces\/[^/]+$/
const capabilityInvokeIdleSeconds = 35
const defaultRealtimeInputActorId = actorIdSchema.parse('actor:operator')

interface ServerConfig {
  readonly workspaces: WorldWorkspaceRuntimeRegistry
  /** The bundled featured and listed Scenarios, served without any Workspace. */
  readonly featuredDefinitions: ModuleFeaturedDefinitionCollection
  readonly port?: number
  readonly bindHost?: string
  readonly uiDistPath?: string
  readonly mapArtifacts?: MapArtifactConfig
  readonly workspaceHostUrl?: string
}

interface WSData {
  readonly workspaceId: WorkspaceId
  readonly simulationRunId: SimulationRunId
  /** The connection's role set in a Run that declares roles; `role.set` replaces it in place. */
  perspective: ClientPerspective | null
}

const realtimeClientCapabilityMessageSchema = z.object({
  type: z.literal('capability.invoke'),
  requestId: z.string().min(1).max(128),
  capabilityId: z.string().min(1).max(256),
  invocation: capabilityInvocationRequestSchema,
}).strict()

const realtimeClientRuntimeInputMessageSchema = z.object({
  type: z.literal('runtime.input'),
  input: z.object({
    type: z.string().min(1).max(128),
    actorId: actorIdSchema.default(defaultRealtimeInputActorId),
    clientId: clientIdSchema.optional(),
    payload: z.unknown(),
  }).strict(),
}).strict()

const realtimeClientRoleSetMessageSchema = z.object({
  type: z.literal('role.set'),
  roles: z.array(z.string().min(1).max(128)).max(64),
}).strict()

const realtimeClientMessageSchema = z.union([
  realtimeClientCapabilityMessageSchema,
  realtimeClientRuntimeInputMessageSchema,
  realtimeClientRoleSetMessageSchema,
])

const websocketText = (message: string | Buffer): string =>
  typeof message === 'string' ? message : message.toString('utf8')

const memoryStatus = (): {
  readonly rssBytes: number
  readonly heapTotalBytes: number
  readonly heapUsedBytes: number
  readonly externalBytes: number
  readonly arrayBuffersBytes: number
} => {
  const memory = process.memoryUsage()
  return {
    rssBytes: memory.rss,
    heapTotalBytes: memory.heapTotal,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
  }
}

export const createHealthDetails = async (config: {
  readonly registry: SimulationRunRegistry
  readonly realtime?: RealtimeStatus
  readonly mapArtifacts: MapArtifactConfig
}): Promise<{
  readonly ok: true
  readonly generatedAt: string
  readonly process: {
    readonly pid: number
    readonly uptimeSeconds: number
    readonly memory: ReturnType<typeof memoryStatus>
  }
  readonly registry: Awaited<ReturnType<SimulationRunRegistry['status']>>
  readonly realtime: RealtimeStatus
  readonly mapArtifacts: Awaited<ReturnType<typeof createMapArtifactStatus>>
}> => ({
  ok: true,
  generatedAt: new Date().toISOString(),
  process: {
    pid: process.pid,
    uptimeSeconds: process.uptime(),
    memory: memoryStatus(),
  },
  registry: await config.registry.status(),
  realtime: config.realtime ?? emptyRealtimeStatus(),
  mapArtifacts: await createMapArtifactStatus(config.mapArtifacts),
})

const staticContentTypes: Readonly<Record<string, string>> = {
  '.avif': 'image/avif',
  '.css': 'text/css',
  '.html': 'text/html',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.map': 'application/json',
  '.mjs': 'application/javascript',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

export const staticContentTypeForPath = (filePath: string): string => {
  const lowerPath = filePath.toLowerCase()
  const extension = Object.keys(staticContentTypes)
    .find(candidate => lowerPath.endsWith(candidate))
  return extension ? staticContentTypes[extension]! : 'application/octet-stream'
}

/**
 * Everything the UI build puts under assets/world is content-addressed: Vite
 * names each chunk and asset by its hash (vite.config.ts assetsDir), and each
 * public file there carries its own (built-ui-scan.test.ts), so a browser keeps
 * them for good. The HTML pages name the current bundles; they revalidate so
 * an open chat view never starts an older bundle after a deploy.
 */
const contentAddressedDirectory = '/assets/world/'
const staticCacheControl = (servedPath: string): Readonly<Record<string, string>> => {
  if (servedPath.endsWith('.html')) return { 'Cache-Control': 'no-cache' }
  return servedPath.startsWith(contentAddressedDirectory) ? { 'Cache-Control': 'public, max-age=31536000, immutable' } : {}
}

const serveStatic = async (pathname: string, uiDistPath: string): Promise<Response | null> => {
  const normalizedPath = /^\/workspaces\/[^/]+\/world\/embed\//.test(pathname)
    ? '/embed.html'
    : pathname.startsWith('/workspaces/') ? '/index.html' : pathname
  const filePath = normalize(`${uiDistPath}${normalizedPath}`)
  if (!filePath.startsWith(uiDistPath)) return new Response('Forbidden', { status: 403 })
  const file = Bun.file(filePath)
  if (!await file.exists()) return null
  return new Response(file, { headers: { 'Content-Type': staticContentTypeForPath(filePath), ...staticCacheControl(filePath.slice(uiDistPath.length)) } })
}

const withSecurityHeaders = (response: Response): Response => {
  // Keep the original body: reconstructing a Bun file response from its stream
  // discards a sliced file's offsets and serves the whole archive for a range.
  response.headers.set('Content-Security-Policy', frameAncestorsHeader)
  response.headers.delete('X-Frame-Options')
  return response
}

export const createServer = (config: ServerConfig): { readonly stop: () => Promise<void>; readonly port: number } => {
  const port = config.port ?? Number(process.env.PORT ?? 3000)
  const bindHost = config.bindHost ?? process.env.LEITBILD_BIND_HOST ?? '0.0.0.0'
  const uiDistPath = resolve(config.uiDistPath ?? `${import.meta.dir}/../../ui/dist`)
  const mapArtifacts = config.mapArtifacts ?? createMapArtifactConfigFromEnv()
  const realtimeByWorkspace = new Map<WorkspaceId, { runtime: WorldWorkspaceRuntime; realtime: SimulationRunRealtimeManager<ServerWebSocket<WSData>> }>()

  const realtimeFor = (workspaceRuntime: WorldWorkspaceRuntime): SimulationRunRealtimeManager<ServerWebSocket<WSData>> => {
    for (const [id, entry] of realtimeByWorkspace) {
      if (config.workspaces.getLoaded(id) !== entry.runtime) { entry.realtime.stop(); realtimeByWorkspace.delete(id) }
    }
    const current = realtimeByWorkspace.get(workspaceRuntime.workspaceId)
    if (current) return current.realtime
    const realtime = createSimulationRunRealtimeManager<ServerWebSocket<WSData>>({
      registry: workspaceRuntime.simulationRuns,
      send: (socket, message) => socket.send(JSON.stringify(message)),
      sendReady: (socket, message) => socket.send(JSON.stringify(message)),
      perspectiveOf: socket => socket.data.perspective,
    })
    realtimeByWorkspace.set(workspaceRuntime.workspaceId, { runtime: workspaceRuntime, realtime })
    return realtime
  }

  // A reply belongs to the epoch its request arrived in, so a screen that has
  // since switched roles discards it rather than mixing perspectives.
  const epochStamp = (epoch: number | null): { readonly epoch?: number } =>
    epoch === null ? {} : { epoch }

  const sendRealtimeCapabilityError = (
    socket: ServerWebSocket<WSData>,
    requestId: string | undefined,
    error: unknown,
    epoch: number | null,
  ): void => {
    // Role gates name their refusal, so a screen can tell them apart.
    const code = isRoleGateRefusal(error) ? error.code : undefined
    socket.send(JSON.stringify({
      type: 'capability.error',
      workspaceId: socket.data.workspaceId,
      simulationRunId: socket.data.simulationRunId,
      ...(requestId === undefined ? {} : { requestId }),
      ...(code === undefined ? {} : { code }),
      message: error instanceof Error ? error.message : String(error),
      ...epochStamp(epoch),
    }))
  }

  const sendRealtimeInputError = (
    socket: ServerWebSocket<WSData>,
    inputType: string | undefined,
    message: string,
    epoch: number | null,
  ): void => {
    socket.send(JSON.stringify({
      type: 'runtime.input.error',
      workspaceId: socket.data.workspaceId,
      simulationRunId: socket.data.simulationRunId,
      ...(inputType === undefined ? {} : { inputType }),
      message,
      ...epochStamp(epoch),
    }))
  }

  const sendRoleRefusal = (socket: ServerWebSocket<WSData>, error: { readonly code: string; readonly message: string; readonly details?: unknown }): void => {
    socket.send(JSON.stringify({
      type: 'role.refused',
      workspaceId: socket.data.workspaceId,
      simulationRunId: socket.data.simulationRunId,
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
      ...epochStamp(socket.data.perspective?.epoch ?? null),
    }))
  }

  /** Swaps a connection's role set in place and answers with a fresh ready snapshot in a new epoch. */
  const setConnectionRoles = (socket: ServerWebSocket<WSData>, requested: ReadonlyArray<string>): void => {
    const workspaceRuntime = config.workspaces.getLoaded(socket.data.workspaceId)
    const runtime = workspaceRuntime?.simulationRuns.get(socket.data.simulationRunId)
    if (!workspaceRuntime || !runtime) {
      sendRoleRefusal(socket, { code: 'simulation_run_not_found', message: 'simulation run not found' })
      return
    }
    let perspective
    try {
      perspective = resolveRunPerspective(runtime.roles(), requested)
      assertHoldsRole(perspective)
    } catch (error) {
      if (!isRoleGateRefusal(error)) throw error
      sendRoleRefusal(socket, error)
      return
    }
    if (perspective.kind !== 'roles') throw new Error('a role set resolved without roles')
    // The new epoch's first message is its ready snapshot: nothing is sent in
    // between, and a failed send leaves the connection in its old epoch.
    const previous = socket.data.perspective
    socket.data.perspective = { roleIds: perspective.roleIds, epoch: (previous?.epoch ?? 0) + 1 }
    try {
      realtimeFor(workspaceRuntime).sendReady(socket.data.simulationRunId, socket)
    } catch (error) {
      socket.data.perspective = previous
      sendRoleRefusal(socket, { code: 'realtime_unavailable', message: error instanceof Error ? error.message : String(error) })
    }
  }

  const invokeRealtimeCapability = async (
    workspaceId: WorkspaceId,
    simulationRunId: SimulationRunId,
    capabilityId: string,
    rawInvocation: unknown,
    roleIds: ReadonlyArray<string> | null,
  ) => {
    return await config.workspaces.withRuntime(workspaceId, async workspace => {
    const runtime = workspace.simulationRuns.get(simulationRunId)
    if (!runtime) throw new Error('simulation run not found')
    const release = workspace.simulationRuns.acquireLease(simulationRunId, 'api')
    try {
    const invocation = capabilityInvocationRequestSchema.parse(rawInvocation)
    const perspective = resolveRunPerspective(runtime.roles(), roleIds)
    return await runtime.invokeCapability(actorForPerspective(buildSimulationRunActor(defaultRealtimeInputActorId), perspective), {
      capabilityId,
      input: invocation.input,
      ...(invocation.expectedRevision === undefined ? {} : { expectedRevision: invocation.expectedRevision }),
      ...(invocation.idempotencyKey === undefined ? {} : { idempotencyKey: invocation.idempotencyKey }),
    })
    } finally { release() }
    })
  }

  const handleRealtimeClientMessage = async (
    socket: ServerWebSocket<WSData>,
    message: string | Buffer,
  ): Promise<void> => {
    // The perspective in force when this message arrived.
    const perspective = socket.data.perspective
    const epoch = perspective?.epoch ?? null
    let parsed
    try {
      parsed = realtimeClientMessageSchema.parse(JSON.parse(websocketText(message)) as unknown)
    } catch (err) {
      sendRealtimeCapabilityError(socket, undefined, err, epoch)
      return
    }
    if (parsed.type === 'role.set') {
      setConnectionRoles(socket, parsed.roles)
      return
    }
    if (parsed.type === 'runtime.input') {
      try {
        const runtime = config.workspaces.getLoaded(socket.data.workspaceId)?.simulationRuns.get(socket.data.simulationRunId)
        if (!runtime) {
          sendRealtimeInputError(socket, parsed.input.type, 'simulation run not found', epoch)
          return
        }
        await runtime.receiveRealtimeInput({
          type: parsed.input.type,
          at: nowIso(),
          ...(parsed.input.actorId === undefined ? {} : { actorId: parsed.input.actorId }),
          ...(parsed.input.clientId === undefined ? {} : { clientId: parsed.input.clientId }),
          payload: parsed.input.payload,
        })
      } catch (err) {
        sendRealtimeInputError(socket, parsed.input.type, err instanceof Error ? err.message : String(err), epoch)
      }
      return
    }
    try {
      const outcome = await invokeRealtimeCapability(
        socket.data.workspaceId,
        socket.data.simulationRunId,
        parsed.capabilityId,
        parsed.invocation,
        perspective?.roleIds ?? null,
      )
      socket.send(JSON.stringify({
        type: 'capability.result',
        workspaceId: socket.data.workspaceId,
        simulationRunId: socket.data.simulationRunId,
        requestId: parsed.requestId,
        outcome,
        ...epochStamp(epoch),
      }))
    } catch (err) {
      sendRealtimeCapabilityError(socket, parsed.requestId, err, epoch)
    }
  }

  const server = Bun.serve<WSData>({
    port,
    hostname: bindHost,
    async fetch(req, serverApi) {
      const secure = (response: Response): Response => withSecurityHeaders(response)
      const url = new URL(req.url)
      if (url.pathname === '/health') {
        return secure(json({
          ok: true,
          mapArtifacts: await createMapArtifactStatus(mapArtifacts),
        }))
      }
      if (url.pathname === '/health/details') {
        const workspaces = await config.workspaces.list()
        return secure(json({
          ok: true,
          generatedAt: new Date().toISOString(),
          process: { pid: process.pid, uptimeSeconds: process.uptime(), memory: memoryStatus() },
          mapArtifacts: await createMapArtifactStatus(mapArtifacts),
          workspaces: await Promise.all(workspaces.map(async workspace => {
            const runtime = config.workspaces.getLoaded(workspace.workspaceId)
            return {
              workspaceId: workspace.workspaceId,
              moduleId: workspace.moduleId,
              createdAt: workspace.createdAt,
              loaded: runtime !== undefined,
              ...(runtime === undefined ? {} : { registry: await runtime.simulationRuns.status() }),
              realtime: realtimeByWorkspace.get(workspace.workspaceId)?.realtime.status() ?? emptyRealtimeStatus(),
            }
          })),
        }))
      }
      // Bun drops a request idle for 10 s. A Capability may answer later than
      // that (world.simulation-run.wait holds up to 20 s); the Host's gateway
      // waits 30 s, so an invocation may stay open a little longer.
      if (req.method === 'POST' && capabilityInvokePath.test(url.pathname)) serverApi.timeout(req, capabilityInvokeIdleSeconds)
      // The gateway waits as long for a Workspace lifecycle answer: a removal
      // still stopping Runs must not be cut off and read as a lost connection.
      if ((req.method === 'PUT' || req.method === 'DELETE') && workspaceLifecyclePath.test(url.pathname)) serverApi.timeout(req, capabilityInvokeIdleSeconds)
      const featuredResponse = handleWorldFeaturedDefinitions(req, url, config.featuredDefinitions)
      if (featuredResponse) return secure(featuredResponse)
      const activityResponse = await handleWorldActivity(req, url, config.workspaces)
      if (activityResponse) return secure(activityResponse)
      const workspaceModuleResponse = await handleWorldModuleApi(req, url, config.workspaces)
      if (workspaceModuleResponse) return secure(workspaceModuleResponse)
      if ((url.pathname === '/' || url.pathname === '/index.html') && req.method === 'GET') {
        const location = config.workspaceHostUrl ?? process.env.WORKSPACE_HOST_URL
        return location
          ? secure(new Response(null, { status: 303, headers: { Location: location } }))
          : secure(apiError(404, 'workspace_host_required', 'Open this Module through the Workspace Host'))
      }
      if (url.pathname === '/map/capabilities.json') return secure(await mapCapabilitiesResponse(mapArtifacts))
      if (url.pathname === '/map/style.json') return secure(await mapStyleResponse(url.searchParams.get('theme'), mapArtifacts))
      if (url.pathname.startsWith('/map/tiles/')) {
        const tileResponse = await currentVectorTileResponse(req, url, mapArtifacts)
        if (tileResponse) return secure(tileResponse)
      }
      if (url.pathname === '/map/tiles/current.pmtiles') return secure(await currentPmtilesResponse(req, mapArtifacts))
      if (url.pathname === '/map/tiles/overview.pmtiles') return secure(await overviewPmtilesResponse(req, mapArtifacts))
      if (url.pathname === '/map/terrain/current.pmtiles') return secure(await currentTerrainPmtilesResponse(req, mapArtifacts))
      if (url.pathname === '/map/terrain/current/tiles.json') return secure(await currentTerrainTileJsonResponse(mapArtifacts))
      if (url.pathname.startsWith('/map/terrain/current/')) {
        const terrainResponse = await currentTerrainRasterTileResponse(url, mapArtifacts)
        if (terrainResponse) return secure(terrainResponse)
      }
      if (url.pathname === '/map/scenery/current/tileset.json') return secure(await currentSceneryTilesetResponse(mapArtifacts))
      if (url.pathname.startsWith('/map/scenery/current/')) {
        const sceneryResponse = await currentSceneryTileResponse(url, mapArtifacts)
        if (sceneryResponse) return secure(sceneryResponse)
      }
      if (url.pathname.startsWith('/map/datasets/')) {
        const referenceVectorTileResponse = await referenceDatasetVectorTileResponse(req, url)
        if (referenceVectorTileResponse) return secure(referenceVectorTileResponse)
        const referenceTilesResponse = await referenceDatasetPmtilesResponse(req, url)
        if (referenceTilesResponse) return secure(referenceTilesResponse)
      }
      if (url.pathname.startsWith('/map/fonts/')) {
        const glyphResponse = await mapGlyphResponse(url, mapArtifacts)
        if (glyphResponse) return secure(glyphResponse)
      }

      const workspaceScopeMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/world(?:\/|$)/)
      if (workspaceScopeMatch) {
        const workspaceIdResult = workspaceIdSchema.safeParse(decodeURIComponent(workspaceScopeMatch[1] ?? ''))
        if (!workspaceIdResult.success) return secure(apiError(400, 'invalid_request', workspaceIdResult.error.message))
        const workspaceId = workspaceIdResult.data
        try {
          return await config.workspaces.withRuntime(workspaceId, async workspaceRuntime => {
        const realtime = realtimeFor(workspaceRuntime)
      const simulationRunApiResponse = await handleSimulationRunApi(req, url, {
          registry: workspaceRuntime.simulationRuns,
          accessContext: createOpenAccessContext(workspaceId, req),
          roleHolders: simulationRunId => realtime.roleHolders(simulationRunId),
      })
      if (simulationRunApiResponse) {
        realtime.reconcile()
        return secure(simulationRunApiResponse)
      }

        if (url.pathname === `/api/workspaces/${encodeURIComponent(workspaceId)}/world/ws`) {
        const rawSimulationRunId = url.searchParams.get('simulationRun')
        if (!rawSimulationRunId) return secure(new Response('Missing simulationRun', { status: 400 }))
          const simulationRunIdResult = simulationRunIdSchema.safeParse(rawSimulationRunId)
          if (!simulationRunIdResult.success) return secure(new Response('Invalid Simulation Run id', { status: 400 }))
          const simulationRunId = simulationRunIdResult.data
          let runtime
          try {
            runtime = await workspaceRuntime.simulationRuns.load(simulationRunId)
          } catch (err) {
            if ((err as Error).message.startsWith('Simulation Run not found:')) {
              return secure(new Response('Simulation Run not found', { status: 404 }))
            }
            throw err
          }
          let perspective: ClientPerspective | null
          try {
            const resolved = resolveRunPerspective(runtime.roles(), parseRoleSetParameter(url.searchParams.get(roleSetParameter)))
            assertHoldsRole(resolved)
            perspective = resolved.kind === 'roles' ? { roleIds: resolved.roleIds, epoch: 1 } : null
          } catch (err) {
            if (isRoleGateRefusal(err)) return secure(apiError(err.status, err.code, err.message, err.details))
            throw err
          }
        const upgraded = serverApi.upgrade(req, { data: { workspaceId, simulationRunId, perspective } })
        return upgraded ? undefined : secure(new Response('WebSocket upgrade failed', { status: 400 }))
        }
        return secure(new Response('Not found', { status: 404 }))
          })
        } catch (err) {
          if ((err as Error).message.startsWith('World Module not provisioned:')) return secure(apiError(404, 'workspace_not_found', 'World is not enabled in this Workspace'))
          if (err instanceof Error && 'code' in err && err.code === 'workspace_closing') return secure(apiError(409, 'workspace_closing', err.message))
          if (err instanceof Error && 'code' in err && err.code === 'workspace_capacity_exceeded') return secure(apiError(503, 'workspace_capacity_exceeded', err.message))
          throw err
        }
      }

      const staticResponse = await serveStatic(url.pathname, uiDistPath)
      if (staticResponse) return secure(staticResponse)
      return secure(new Response('Not found', { status: 404 }))
    },
    websocket: {
      open(socket) {
        const workspaceRuntime = config.workspaces.getLoaded(socket.data.workspaceId)
        if (!workspaceRuntime) return socket.close(1011, 'Workspace runtime unavailable')
        realtimeFor(workspaceRuntime).addClient(socket.data.simulationRunId, socket)
      },
      close(socket) {
        realtimeByWorkspace.get(socket.data.workspaceId)?.realtime.removeClient(socket.data.simulationRunId, socket)
      },
      message(socket, message) {
        void handleRealtimeClientMessage(socket, message)
      },
    },
  })

  let stopping: Promise<void> | undefined
  return {
    port: server.port ?? port,
    stop: () => {
      stopping ??= (async () => {
        // Stop admitting work and detach viewers before draining operations and
        // checkpointing Pack mechanics together with the final Run clock.
        const stopped = server.stop(true)
        for (const { realtime } of realtimeByWorkspace.values()) realtime.stop()
        realtimeByWorkspace.clear()
        await config.workspaces.shutdown()
        await stopped
      })()
      return stopping
    },
  }
}
