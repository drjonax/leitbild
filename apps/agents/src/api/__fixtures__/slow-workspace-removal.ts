// Test-only Agents server process whose Workspace removal answers after 16 s, as
// one still draining agents may. Bun's 10 s idle timeout cuts such a request off
// in a server process of its own, unlike a server running inside bun test.
// Prints `port=<port>` after the server's own startup lines. Exits when the test
// closes its stdin, and after 45 s in any case, so a killed test run cannot leave it behind.
import { createServer } from '../server.ts'

setTimeout(() => process.exit(1), 45_000)
void Bun.stdin.stream().pipeTo(new WritableStream()).finally(() => process.exit(0))
const server = createServer({
  registry: { remove: async () => { await Bun.sleep(16_000) } } as never,
  moduleState: {} as never, wsManager: {} as never, diagnostics: {} as never, packManager: {} as never,
  port: 0, bindHost: '127.0.0.1', uiPath: process.argv[2]!,
})
console.log(`port=${server.port}`)
