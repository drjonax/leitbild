import { expect, test } from 'bun:test'
import { localModelEnvironment, localRoutes, localRoutingEnvironment, preflightLocalStack, preflightOsrm, startLocalProxy } from '../../../scripts/local-stack.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const caddy = await Bun.file(new URL('../deploy/sites/leitbild.caddy', import.meta.url)).text()

test('models require explicit opt-in; neither arbitrary keys nor deployment paths leak into child environments', () => {
  const caller = { OPENROUTER_API_KEY: 'test-only', PROVIDER_ORDER: 'openrouter', LEITBILD_MCP_CONFIG: '/private/config', WORKSPACE_HOST_HOME: '/prod', UNRELATED_SECRET: 'secret' }
  expect(localModelEnvironment(false, caller)).toEqual({ PROVIDER: 'ollama', OLLAMA_URL: 'http://127.0.0.1:1' })
  expect(localModelEnvironment(true, caller)).toEqual({ OPENROUTER_API_KEY: 'test-only', PROVIDER_ORDER: 'openrouter' })
})

test('routing is straight-line unless an OSRM endpoint is named, and a named endpoint must answer first', async () => {
  expect(localRoutingEnvironment(undefined)).toEqual({ LEITBILD_ROUTING_PROVIDER: 'direct' })
  expect(localRoutingEnvironment('http://127.0.0.1:5055')).toEqual({ LEITBILD_ROUTING_PROVIDER: 'osrm', LEITBILD_OSRM_URL: 'http://127.0.0.1:5055' })
  const osrm = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname
      if (path === '/ready/nearest/v1/driving/0,0') return Response.json({ code: 'Ok' })
      if (path === '/unloaded/nearest/v1/driving/0,0') return Response.json({ code: 'NoSegment' })
      return Response.json({ code: 'InvalidUrl' }, { status: 400 })
    },
  })
  try {
    await preflightOsrm(`http://127.0.0.1:${osrm.port}/ready/`)
    // World's adapter would refuse these at construction, after the stack had started; the router answering is irrelevant.
    for (const refused of [`http://user:secret@127.0.0.1:${osrm.port}/ready`, `http://127.0.0.1:${osrm.port}/ready?key=1`, `http://127.0.0.1:${osrm.port}/ready#x`, `ftp://127.0.0.1:${osrm.port}/ready`, 'http://user:secret@[x', '']) {
      const rejection = await preflightOsrm(refused).then(() => undefined, (error: Error) => error)
      expect(rejection?.message).toStartWith('--osrm must be an HTTP(S) endpoint without credentials, query or fragment')
      expect(rejection?.message).not.toContain('secret')
    }
    await expect(preflightOsrm(`http://127.0.0.1:${osrm.port}/unloaded`)).rejects.toThrow('OSRM code NoSegment')
    await expect(preflightOsrm(`http://127.0.0.1:${osrm.port}/empty`)).rejects.toThrow('HTTP 400')
  } finally { osrm.stop(true) }
  await expect(preflightOsrm(`http://127.0.0.1:${osrm.port}`)).rejects.toThrow(`OSRM at http://127.0.0.1:${osrm.port}/nearest/v1/driving/0,0?number=1 is not ready`)
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
