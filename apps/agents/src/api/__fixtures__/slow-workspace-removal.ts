// Test-only Agents server process whose Workspace removal answers after 16 s, as
// one still draining agents may. The interval keeps the process busy like a live
// Agents Module: Bun drops an idle request only then. Prints `port=<port>` after the server's own startup lines.
import { createServer } from '../server.ts'

setInterval(() => {}, 100)
const server = createServer({
  registry: { remove: async () => { await Bun.sleep(16_000) } } as never,
  moduleState: {} as never, wsManager: {} as never, diagnostics: {} as never, packManager: {} as never,
  port: 0, bindHost: '127.0.0.1', uiPath: process.argv[2]!,
})
console.log(`port=${server.port}`)
