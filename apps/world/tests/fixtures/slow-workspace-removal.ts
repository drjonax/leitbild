// Test-only World server process whose Workspace removal answers after 16 s, as
// one still stopping Runs may. Bun's 10 s idle timeout cuts such a request off
// in a server process of its own, unlike a server running inside bun test.
// Prints `port=<port>`. Exits when the test closes its stdin, and
// after 45 s in any case, so a killed test run cannot leave it behind.
import { createServer } from '../../src/core/api/server.ts'
import type { WorldWorkspaceRuntimeRegistry } from '../../src/core/workspaces/runtime-registry.ts'

setTimeout(() => process.exit(1), 45_000)
void Bun.stdin.stream().pipeTo(new WritableStream()).finally(() => process.exit(0))
const workspaces = {
  list: async () => [],
  getLoaded: () => undefined,
  remove: async () => { await Bun.sleep(16_000); return true },
  shutdown: async () => {},
} as unknown as WorldWorkspaceRuntimeRegistry
const server = createServer({ workspaces, featuredDefinitions: { definitions: [], listed: [] }, port: 0, bindHost: '127.0.0.1', mapArtifacts: { rootDir: process.argv[2]! } })
console.log(`port=${server.port}`)
