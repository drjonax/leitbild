// A Workspace Host serving one Run whose catalog offers a display-composing
// operation, marked (or not) as publishing an embedded view: what "Show
// display" asks of the Host. Test-only; a real local HTTP server.
import { workspaceResourceReferenceSchema, type WorkspaceId } from '@leitbild/contracts'

export const DISPLAY_OPERATION_ID = 'world.process-plant.display.compose'

export const serveDisplayHost = (workspaceId: WorkspaceId, options: { readonly publishes: boolean }) => {
  const run = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId: 'world', type: 'world.simulation-run', id: 'run-1' })
  const modules = [{ moduleId: 'world', status: 'ready' }]
  const server = Bun.serve({
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname
      if (path.endsWith('/resources')) return Response.json({ workspaceId, modules, resources: [
        { ref: run, title: 'Unit 1', capabilityIds: [DISPLAY_OPERATION_ID], links: [], summary: [], observedAt: new Date().toISOString() },
      ] })
      if (path.endsWith('/definitions')) return Response.json({ workspaceId, modules, definitions: [] })
      if (path.endsWith('/capabilities')) return Response.json({ workspaceId, modules, capabilities: [{
        id: DISPLAY_OPERATION_ID, moduleId: 'world', kind: 'query', scope: { kind: 'resource', resourceType: run.type },
        title: 'display · compose', description: 'Compose a small live operator display.', risk: 'read', idempotent: true,
        ...(options.publishes ? { publishes: ['embedded-view'] } : {}),
        inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
      }] })
      return Response.json({ error: { code: 'not_found', message: `No fixture for ${path}` } }, { status: 404 })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}
