// Test-only World server process whose Workspace removal answers after 16 s, as
// one still stopping Runs may. The interval keeps the process busy like a World
// with running Runs: Bun drops an idle request only then. Prints the port.
import { createServer } from '../../src/core/api/server.ts'
import type { WorldWorkspaceRuntimeRegistry } from '../../src/core/workspaces/runtime-registry.ts'

setInterval(() => {}, 100)
const workspaces = {
  list: async () => [],
  getLoaded: () => undefined,
  remove: async () => { await Bun.sleep(16_000); return true },
  shutdown: async () => {},
} as unknown as WorldWorkspaceRuntimeRegistry
const server = createServer({ workspaces, featuredDefinitions: { definitions: [], listed: [] }, port: 0, bindHost: '127.0.0.1', mapArtifacts: { rootDir: process.argv[2]! } })
console.log(server.port)
