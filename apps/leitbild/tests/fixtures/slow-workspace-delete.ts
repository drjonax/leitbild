// Test-only Host process whose Modules remove a Workspace after 16 s, as World
// stopping Runs may. Bun's 10 s idle timeout cuts such a request off in a server
// process of its own, unlike a server running inside bun test. Prints
// `ready <json>` with the port and the Workspace id. Exits when the test closes
// its stdin, and after 45 s in any case, so a killed test run cannot leave it behind.
import { coreModuleIds, moduleRegistrationSchema } from '@leitbild/contracts'
import { createWorkspaceHost } from '../../src/host.ts'
import type { ModuleGateway } from '../../src/module-gateway.ts'
import { createWorkspaceHostServer } from '../../src/server.ts'
import { createWorkspaceStore } from '../../src/store.ts'

setTimeout(() => process.exit(1), 45_000)
void Bun.stdin.stream().pipeTo(new WritableStream()).finally(() => process.exit(0))
const unused = async () => { throw new Error('not used by this fixture') }
const modules: ModuleGateway = {
  list: () => coreModuleIds.map(moduleId => moduleRegistrationSchema.parse({ moduleId, internalBaseUrl: `http://${moduleId}.internal`, manifestPath: '/manifest' })),
  has: moduleId => coreModuleIds.includes(moduleId),
  provision: async () => ({ ok: true, value: undefined }),
  remove: async () => { await Bun.sleep(16_000); return { ok: true, value: undefined } },
  definitions: unused, resources: unused, capabilities: unused, featuredDefinitions: unused, activity: unused, invoke: unused,
}
const host = createWorkspaceHost({ store: createWorkspaceStore(':memory:'), modules })
const workspace = await host.create({ name: null })
const server = createWorkspaceHostServer({ host, port: 0, bindHost: '127.0.0.1' })
console.log(`ready ${JSON.stringify({ port: server.port, workspaceId: workspace.id })}`)
