import { expect, test } from 'bun:test'
import { localModelEnvironment, localRoutes, preflightLocalStack, startLocalProxy } from '../../../scripts/local-stack.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const caddy = await Bun.file(new URL('../deploy/sites/leitbild.caddy', import.meta.url)).text()

test('models require explicit opt-in; neither arbitrary keys nor deployment paths leak into child environments', () => {
  const caller = { OPENROUTER_API_KEY: 'test-only', PROVIDER_ORDER: 'openrouter', LEITBILD_MCP_CONFIG: '/private/config', WORKSPACE_HOST_HOME: '/prod', UNRELATED_SECRET: 'secret' }
  expect(localModelEnvironment(false, caller)).toEqual({ PROVIDER: 'ollama', OLLAMA_URL: 'http://127.0.0.1:1' })
  expect(localModelEnvironment(true, caller)).toEqual({ OPENROUTER_API_KEY: 'test-only', PROVIDER_ORDER: 'openrouter' })
})

test('local route split consumes production matchers, not a second routing table', () => {
  const route = localRoutes(caddy)
  expect(route('/api/workspaces/w/world/ws')).toBe('world')
  expect(route('/api/workspaces/w/agents/ws')).toBe('agents')
  expect(route('/assets/agents/app.js')).toBe('agents')
  expect(route('/wiki')).toBe('host')
  expect(() => localRoutes(caddy.replace('@world path_regexp world', '@changed path_regexp changed'))).toThrow()
  expect(() => localRoutes(`${caddy}\n@world path_regexp world .*`)).toThrow()
})

test('preflight fails before runtime startup when built artifacts are missing', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'leitbild-preflight-test-'))
  try { await expect(preflightLocalStack(empty)).rejects.toThrow('run bun run build') }
  finally { await rm(empty, { recursive: true }) }
})

test('loopback proxy retains HTTP path/query/body and forwards WebSocket frames both ways', async () => {
  const upstream = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request, server) {
      if (request.headers.get('upgrade') === 'websocket') {
        if (server.upgrade(request)) return
        return new Response('Upgrade failed', { status: 500 })
      }
      const url = new URL(request.url)
      return Response.json({ path: url.pathname, query: url.search, body: await request.text() })
    },
    websocket: { open(socket) { socket.send('ready') }, message(socket, message) { socket.send(message) } },
  })
  const proxy = startLocalProxy(localRoutes(caddy), { host: upstream.port!, agents: upstream.port!, world: upstream.port! })
  try {
    expect(() => startLocalProxy(localRoutes(caddy), { host: upstream.port!, agents: upstream.port!, world: upstream.port! }, upstream.port!)).toThrow()
    const response = await fetch(`http://127.0.0.1:${proxy.port}/api/workspaces/w/world/example?value=a%20b`, { method: 'POST', body: 'payload' })
    expect(await response.json()).toEqual({ path: '/api/workspaces/w/world/example', query: '?value=a%20b', body: 'payload' })
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${proxy.port}/api/workspaces/w/world/ws?simulationRun=r`)
      const timer = setTimeout(() => { socket.close(); reject(new Error('Proxy WebSocket timed out')) }, 2_000)
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Proxy WebSocket failed')) })
      socket.addEventListener('message', event => {
        if (event.data === 'ready') socket.send('client-frame')
        else {
          clearTimeout(timer)
          try { expect(event.data).toBe('client-frame'); socket.close(); resolve() }
          catch (error) { socket.close(); reject(error) }
        }
      })
    })
  } finally { proxy.stop(true); upstream.stop(true) }
})
