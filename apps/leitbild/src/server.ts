import { normalize, resolve } from 'node:path'
import { z } from 'zod'
import {
  accessContextSchema,
  capabilityIdSchema,
  createWorkspaceInputSchema,
  moduleIdSchema,
  newRequestId,
  platformError,
  renameWorkspaceInputSchema,
  workspaceIdSchema,
  workspaceCapabilityInvocationRequestSchema,
} from '@leitbild/contracts'
import { isHostError } from './errors.ts'
import type { WorkspaceHost } from './host.ts'
import { knowledgeResponse } from './knowledge-api.ts'

const contentTypeFor = (path: string): string => {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8'
  if (path.endsWith('.css')) return 'text/css; charset=utf-8'
  if (path.endsWith('.js') || path.endsWith('.mjs')) return 'application/javascript; charset=utf-8'
  if (path.endsWith('.svg')) return 'image/svg+xml'
  if (path.endsWith('.png')) return 'image/png'
  if (path.endsWith('.ico')) return 'image/x-icon'
  return 'application/octet-stream'
}

const serveUi = async (pathname: string, uiDistPath: string): Promise<Response | null> => {
  const applicationRoute = pathname === '/wiki' || pathname === '/workspaces' || /^\/workspaces\/[^/]+$/.test(pathname)
  const relativePath = applicationRoute ? '/index.html' : pathname
  if (!relativePath.startsWith('/assets/') && relativePath !== '/index.html' && relativePath !== '/favicon.ico') return null
  const filePath = normalize(`${uiDistPath}${relativePath}`)
  if (!filePath.startsWith(uiDistPath)) return new Response('Forbidden', { status: 403 })
  const file = Bun.file(filePath)
  if (!await file.exists()) {
    return applicationRoute
      ? Response.json({ error: { code: 'workspace_ui_unavailable', message: 'Build the Workspace Host UI before starting the server' } }, { status: 503 })
      : null
  }
  return new Response(file, {
    headers: {
      'Content-Type': contentTypeFor(filePath),
      'Cache-Control': relativePath === '/index.html' ? 'no-store' : 'public, max-age=31536000, immutable',
    },
  })
}

// An exact content ETag lets a client revalidate a catalogue it already holds.
const revalidatedJson = (request: Request, body: string, cacheControl: string): Response => {
  const etag = '"' + new Bun.CryptoHasher('sha256').update(body).digest('hex') + '"'
  const headers = { ETag: etag, 'Cache-Control': cacheControl, 'Content-Type': 'application/json' }
  return request.headers.get('if-none-match') === etag
    ? new Response(null, { status: 304, headers })
    : new Response(body, { headers })
}

const jsonError = (
  status: number,
  code: string,
  message: string,
  retryable = false,
  details?: Readonly<Record<string, unknown>>,
): Response => Response.json(
  platformError({ code, message, retryable, ...(details === undefined ? {} : { details }) }),
  { status },
)

const parseJson = async (request: Request): Promise<unknown> => {
  try {
    return await request.json()
  } catch (error) {
    throw error instanceof SyntaxError ? error : new SyntaxError('Request body must be valid JSON')
  }
}

export const createWorkspaceHostServer = (config: {
  readonly host: WorkspaceHost
  readonly port?: number
  readonly bindHost?: string
  readonly uiDistPath?: string
  readonly publicOrigin?: string
}) => {
  const uiDistPath = resolve(config.uiDistPath ?? `${import.meta.dir}/ui/dist`)
  const publicOrigin = config.publicOrigin === undefined ? null : new URL(config.publicOrigin).origin
  const publicUrl = (path: string, requestUrl: URL): string => new URL(path, publicOrigin ?? requestUrl.origin).href
  return Bun.serve({
    port: config.port ?? 3100,
    hostname: config.bindHost ?? '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url)
      try {
        if (url.pathname === '/health' && request.method === 'GET') {
          return Response.json({ status: 'ok', workspaces: config.host.list().length })
        }

        if (url.pathname === '/' && request.method === 'GET') {
          const workspaces = config.host.list()
          if (workspaces.length === 1) {
            const workspace = workspaces[0]!
            return Response.redirect(publicUrl(`/workspaces/${workspace.id}`, url), 303)
          }
          return Response.redirect(publicUrl('/workspaces', url), 303)
        }

        const uiResponse = request.method === 'GET' ? await serveUi(url.pathname, uiDistPath) : null
        if (uiResponse) return uiResponse

        if (url.pathname.startsWith('/api/knowledge/') && request.method === 'GET') return knowledgeResponse(request)

        if (url.pathname === '/api/featured-definitions' && request.method === 'GET') {
          return revalidatedJson(request, JSON.stringify(await config.host.featuredDefinitions()), 'public, no-cache')
        }
        if (url.pathname === '/api/modules' && request.method === 'GET') {
          return Response.json({ modules: config.host.installedModuleIds().map(moduleId => ({ id: moduleId })) })
        }
        if (url.pathname === '/api/workspaces' && request.method === 'GET') {
          return Response.json({ workspaces: config.host.list() })
        }
        if (url.pathname === '/api/workspaces' && request.method === 'POST') {
          const input = createWorkspaceInputSchema.parse(await parseJson(request))
          return Response.json({ workspace: await config.host.create(input) }, { status: 201 })
        }

        const invocationMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/capabilities\/([^/]+)\/invoke$/)
        if (invocationMatch && request.method === 'POST') {
          const workspaceId = workspaceIdSchema.parse(decodeURIComponent(invocationMatch[1] ?? ''))
          const capabilityId = capabilityIdSchema.parse(decodeURIComponent(invocationMatch[2] ?? ''))
          const requestInput = workspaceCapabilityInvocationRequestSchema.parse(await parseJson(request))
          const input = {
            ...(requestInput.definition === undefined ? {} : { definition: requestInput.definition }),
            ...(requestInput.resource === undefined ? {} : { resource: requestInput.resource }),
            ...(requestInput.expectedRevision === undefined ? {} : { expectedRevision: requestInput.expectedRevision }),
            ...(requestInput.idempotencyKey === undefined ? {} : { idempotencyKey: requestInput.idempotencyKey }),
            input: requestInput.input,
          }
          const access = accessContextSchema.parse({
            workspaceId,
            requestId: newRequestId(),
            actor: requestInput.actor ?? { kind: 'anonymous' },
            client: { id: 'workspace-host', kind: 'service' },
          })
          return Response.json(await config.host.invoke(workspaceId, capabilityId, input, access, request.signal))
        }

        const resourcesMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/resources$/)
        if (resourcesMatch && request.method === 'GET') {
          const workspaceId = workspaceIdSchema.parse(decodeURIComponent(resourcesMatch[1] ?? ''))
          const moduleId = url.searchParams.has('moduleId') ? moduleIdSchema.parse(url.searchParams.get('moduleId')) : undefined
          return Response.json(await config.host.resources(workspaceId, moduleId))
        }
        const definitionsMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/definitions$/)
        if (definitionsMatch && request.method === 'GET') {
          const workspaceId = workspaceIdSchema.parse(decodeURIComponent(definitionsMatch[1] ?? ''))
          const moduleId = url.searchParams.has('moduleId') ? moduleIdSchema.parse(url.searchParams.get('moduleId')) : undefined
          return Response.json(await config.host.definitions(workspaceId, moduleId))
        }
        const capabilitiesMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/capabilities$/)
        if (capabilitiesMatch && request.method === 'GET') {
          const workspaceId = workspaceIdSchema.parse(decodeURIComponent(capabilitiesMatch[1] ?? ''))
          const moduleId = url.searchParams.has('moduleId') ? moduleIdSchema.parse(url.searchParams.get('moduleId')) : undefined
          return revalidatedJson(request, JSON.stringify(await config.host.capabilities(workspaceId, moduleId)), 'private, no-cache')
        }

        const moduleMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/modules\/([^/]+)(\/retry)?$/)
        if (moduleMatch) {
          const workspaceId = workspaceIdSchema.parse(decodeURIComponent(moduleMatch[1] ?? ''))
          const moduleId = moduleIdSchema.parse(decodeURIComponent(moduleMatch[2] ?? ''))
          const retry = moduleMatch[3] !== undefined
          if (retry && request.method === 'POST') return Response.json({ workspace: await config.host.retryModule(workspaceId, moduleId) })
        }

        const workspaceApiMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)$/)
        if (workspaceApiMatch) {
          const workspaceId = workspaceIdSchema.parse(decodeURIComponent(workspaceApiMatch[1] ?? ''))
          if (request.method === 'GET') {
            const workspace = config.host.get(workspaceId)
            return workspace ? Response.json({ workspace }) : jsonError(404, 'workspace_not_found', 'Workspace not found')
          }
          if (request.method === 'PATCH') {
            const input = renameWorkspaceInputSchema.parse(await parseJson(request))
            return Response.json({ workspace: config.host.rename(workspaceId, input) })
          }
          if (request.method === 'DELETE') {
            await config.host.delete(workspaceId)
            return new Response(null, { status: 204 })
          }
        }
        return jsonError(404, 'route_not_found', 'Route not found')
      } catch (error) {
        if (error instanceof z.ZodError || error instanceof SyntaxError) {
          return jsonError(400, 'invalid_request', error.message)
        }
        if (isHostError(error)) {
          return jsonError(error.status, error.code, error.message, error.retryable, error.details)
        }
        console.error('Workspace Host request failed', error)
        return jsonError(500, 'internal_error', 'Internal Workspace Host error')
      }
    },
  })
}
