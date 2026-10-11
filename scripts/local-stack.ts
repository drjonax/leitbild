import { mkdtemp, mkdir, open } from 'node:fs/promises'
import { createServer } from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadKnowledge } from '../packages/knowledge/src/index.ts'
import { smokeLocalStack } from './local-stack-smoke.ts'
import { PROVIDER_PROFILES } from '../apps/agents/src/llm/provider-catalog.ts'

const repository = resolve(import.meta.dir, '..')
const loopback = '127.0.0.1'
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
type ModuleName = 'host' | 'world' | 'agents'
// Host tests include DOM typings, which hide Bun's supported header options.
const ClientWebSocket = WebSocket as unknown as { new(url: URL, options: Bun.WebSocketOptions): WebSocket }

export const localModelEnvironment = (enabled: boolean, caller: NodeJS.ProcessEnv): Record<string, string> => {
  if (!enabled) return { PROVIDER: 'ollama', OLLAMA_URL: 'http://127.0.0.1:1' }
  const keys = ['PROVIDER', 'PROVIDER_ORDER', 'OLLAMA_URL', ...Object.keys(PROVIDER_PROFILES).flatMap(name => [`${name.toUpperCase()}_API_KEY`, `${name.toUpperCase()}_MAX_CONCURRENT`])]
  return Object.fromEntries(keys.flatMap(key => caller[key] === undefined ? [] : [[key, caller[key]!]]))
}

/** Deliberately not a Caddy parser: these two named matchers own our route split.
 * Fail if their format changes rather than silently testing a different split. */
export const localRoutes = (caddy: string): ((path: string) => ModuleName) => {
  const patterns = (['world', 'agents'] as const).map(name => {
    const matches = [...caddy.matchAll(new RegExp(`^\\s*@${name} path_regexp ${name} (.+)$`, 'gm'))]
    if (matches.length !== 1) throw new Error(`Expected one Caddy ${name} path matcher`)
    return [name, new RegExp(matches[0]![1]!)] as const
  })
  return path => patterns.find(([, pattern]) => pattern.test(path))?.[0] ?? 'host'
}

export const preflightLocalStack = async (root: string): Promise<void> => {
  for (const path of ['apps/leitbild/src/ui/dist/index.html', 'apps/world/src/ui/dist/index.html', 'apps/agents/src/ui/dist/index.html', 'apps/agents/src/ui/dist/app.js', 'apps/agents/src/ui/dist.css']) {
    if (!await Bun.file(join(root, path)).exists()) throw new Error(`Missing ${path}; run bun run build before dev:stack`)
  }
  await loadKnowledge(join(root, 'knowledge/snapshot.json'))
}

const reservePort = async () => {
  const socket = createServer()
  await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.listen(0, loopback, resolve) })
  const address = socket.address()
  if (!address || typeof address === 'string') throw new Error('No loopback port allocated')
  return { port: address.port, release: () => new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve())) }
}

interface Peer { upstream: WebSocket; pending: Array<string | Uint8Array>; bytes: number }
export const startLocalProxy = (route: (path: string) => ModuleName, ports: Record<ModuleName, number>, port = 0) => Bun.serve<Peer>({
  hostname: loopback, port,
  async fetch(request, server) {
    const url = new URL(request.url)
    url.hostname = loopback; url.port = String(ports[route(url.pathname)])
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      url.protocol = 'ws:'
      const upstream = new ClientWebSocket(url, { headers: Object.fromEntries(request.headers) })
      if (server.upgrade(request, { data: { upstream, pending: [], bytes: 0 } })) return
      upstream.close(); return new Response('Upgrade failed', { status: 502 })
    }
    try { return await fetch(new Request(url, request), { redirect: 'manual' }) }
    catch (error) { return new Response(`Local upstream unavailable: ${String(error)}`, { status: 502 }) }
  },
  websocket: {
    open(socket) {
      const upstream = socket.data.upstream
      upstream.binaryType = 'arraybuffer'
      upstream.addEventListener('open', () => {
        for (const message of socket.data.pending.splice(0)) upstream.send(typeof message === 'string' ? message : new Uint8Array(message).buffer)
        socket.data.bytes = 0
      })
      upstream.addEventListener('message', event => socket.send(typeof event.data === 'string' ? event.data : new Uint8Array(event.data)))
      upstream.addEventListener('close', () => socket.close())
      upstream.addEventListener('error', () => socket.close(1011, 'Local upstream unavailable'))
    },
    message(socket, message) {
      if (socket.data.upstream.readyState === WebSocket.OPEN) socket.data.upstream.send(message)
      else {
        socket.data.bytes += typeof message === 'string' ? Buffer.byteLength(message) : message.byteLength
        if (socket.data.bytes > 1_048_576) return socket.close(1009, 'Upstream connection pending')
        socket.data.pending.push(message)
      }
    },
    close(socket) { socket.data.upstream.close() },
  },
})

export const startLocalStack = async (port = 43100, models = false) => {
  // Validate prerequisites before starting any child or creating a data directory.
  await preflightLocalStack(repository)
  const route = localRoutes(await Bun.file(join(repository, 'apps/leitbild/deploy/sites/leitbild.caddy')).text())
  const directory = await mkdtemp(join(tmpdir(), 'leitbild-local-'))
  console.log(`Local state and logs retained: ${directory}`)
  const children: ChildProcess[] = []
  const logs: Awaited<ReturnType<typeof open>>[] = []
  const reservations: Awaited<ReturnType<typeof reservePort>>[] = []
  let proxy: ReturnType<typeof startLocalProxy> | undefined
  let stopped: Promise<void> | undefined
  const alive = (child: ChildProcess) => child.pid !== undefined && child.exitCode === null && child.signalCode === null
  const stop = (): Promise<void> => stopped ??= (async () => {
    proxy?.stop(true)
    for (const reservation of reservations.splice(0)) await reservation.release()
    for (const child of children) if (alive(child)) child.kill('SIGTERM')
    const deadline = Date.now() + 8_000
    while (children.some(alive) && Date.now() < deadline) await sleep(50)
    for (const child of children) if (alive(child)) child.kill('SIGKILL')
    for (const child of children) if (alive(child)) await new Promise(resolve => child.once('exit', resolve))
    for (const log of logs) await log.close()
  })()
  const onSignal = () => { void stop().finally(() => process.exit(130)) }
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal)
  try {
    for (let index = 0; index < 3; index++) reservations.push(await reservePort())
    const ports = { host: reservations[0]!.port, world: reservations[1]!.port, agents: reservations[2]!.port }
    proxy = startLocalProxy(route, ports, port)
    const origin = `http://${loopback}:${proxy.port}`
    for (const folder of ['host', 'world', 'agents', 'maps', 'reference']) await mkdir(join(directory, folder))
    // Allow-list environment, and disable Bun's implicit .env loading: never read
    // provider keys, user MCP configuration or a real deployment's data paths.
    const env = {
      PATH: process.env.PATH ?? '', NODE_ENV: 'production',
      WORKSPACE_HOST_URL: origin, LEITBILD_BIND_HOST: loopback, BIND_HOST: loopback,
      WORKSPACE_HOST_HOME: join(directory, 'host'), LEITBILD_HOME: join(directory, 'agents'),
      LEITBILD_DATA_DIR: join(directory, 'world'), LEITBILD_MAP_ROOT: join(directory, 'maps'),
      LEITBILD_REFERENCE_ROOT: join(directory, 'reference'), LEITBILD_ROUTING_PROVIDER: 'direct',
      LEITBILD_KNOWLEDGE_SNAPSHOT: join(repository, 'knowledge/snapshot.json'),
      ...localModelEnvironment(models, process.env),
      WORKSPACE_MODULES: JSON.stringify((['world', 'agents'] as const).map(moduleId => ({ moduleId, internalBaseUrl: `http://${loopback}:${ports[moduleId]}`, manifestPath: '/.well-known/workspace-module' }))),
    }
    for (const [index, name] of (['host', 'world', 'agents'] as const).entries()) {
      if (stopped) throw new Error('Local stack startup interrupted')
      const logPath = join(directory, `${name}.log`)
      const log = await open(logPath, 'w'); logs.push(log)
      await reservations.shift()!.release()
      const child = spawn(process.execPath, ['--no-env-file', 'run', name === 'agents' ? 'src/main.ts' : 'src/index.ts'], {
        cwd: join(repository, 'apps', name === 'host' ? 'leitbild' : name),
        env: { ...env, PORT: String(ports[name]) }, stdio: ['ignore', log.fd, log.fd],
      })
      children.push(child)
      let spawnError: Error | undefined
      child.once('error', error => { spawnError = error })
      child.once('exit', () => {
        if (!stopped) {
          console.error(`${name} stopped unexpectedly; stopping local stack. See ${logPath}`)
          process.exitCode = 1
          void stop()
        }
      })
      const startup = ['Workspace Host listening on', 'Leitbild running at', 'Leitbild Modules listening on'][index]!
      const deadline = Date.now() + 60_000
      for (;;) {
        if (spawnError || child.exitCode !== null || child.signalCode !== null) throw new Error(`${name} exited during startup; see ${logPath}`, { cause: spawnError })
        // A successful response from an unrelated port occupant is not readiness.
        const announced = (await Bun.file(logPath).text()).includes(startup)
        const healthy = announced && await fetch(`http://${loopback}:${ports[name]}/health`, { signal: AbortSignal.timeout(1_000) }).then(response => response.ok, () => false)
        if (healthy) break
        if (Date.now() >= deadline) throw new Error(`${name} startup timed out; see ${logPath}`)
        await sleep(100)
      }
    }
    console.log(`Leitbild local stack: ${origin}\n${models ? 'Provider environment explicitly enabled.' : 'No model credentials loaded.'} No external MCP servers or map/reference artifacts loaded; direct routing is a development limitation.`)
    return { origin, directory, ports, stop: async () => { await stop(); process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal) } }
  } catch (error) {
    await stop(); process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal)
    throw error
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const portArg = args.find(argument => argument.startsWith('--port='))
  if (args.some(argument => argument !== '--smoke' && argument !== '--models' && argument !== portArg)) throw new Error('Usage: bun run dev:stack [--smoke] [--models] [--port=43100]')
  const port = portArg ? Number(portArg.slice(7)) : 43100
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid loopback port')
  const stack = await startLocalStack(port, args.includes('--models'))
  if (args.includes('--smoke')) {
    try { await smokeLocalStack(stack.origin); console.log('Local stack smoke passed') }
    finally { await stack.stop() }
  }
}
