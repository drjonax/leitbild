// Test-only Host process whose Modules remove a Workspace after 16 s, as World
// stopping Runs may. The interval keeps the process busy like a live Host: Bun
// drops an idle request only then. Prints the port and the Workspace id.
import { coreModuleIds, moduleRegistrationSchema } from '@leitbild/contracts'
import { createWorkspaceHost } from '../../src/host.ts'
import type { ModuleGateway } from '../../src/module-gateway.ts'
import { createWorkspaceHostServer } from '../../src/server.ts'
import { createWorkspaceStore } from '../../src/store.ts'

setInterval(() => {}, 100)
const unused = async () => { throw new Error('not used by this fixture') }
const modules: ModuleGateway = {
  list: () => coreModuleIds.map(moduleId => moduleRegistrationSchema.parse({ moduleId, internalBaseUrl: `http://${moduleId}.internal`, manifestPath: '/manifest' })),
  has: moduleId => coreModuleIds.includes(moduleId),
  provision: async () => ({ ok: true, value: undefined }),
  remove: async () => { await Bun.sleep(16_000); return { ok: true, value: undefined } },
  definitions: unused, resources: unused, capabilities: unused, featuredDefinitions: unused, invoke: unused,
}
const host = createWorkspaceHost({ store: createWorkspaceStore(':memory:'), modules })
const workspace = await host.create({ name: null })
const server = createWorkspaceHostServer({ host, port: 0, bindHost: '127.0.0.1' })
console.log(JSON.stringify({ port: server.port, workspaceId: workspace.id }))
