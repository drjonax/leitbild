import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createToolRegistry } from '../../core/tool-registry.ts'
import { loadMCPConfig, registerAllMCPServers } from './client.ts'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const directory = async () => {
  const path = await mkdtemp(join(tmpdir(), 'leitbild-mcp-test-'))
  cleanup.push(() => rm(path, { recursive: true, force: true }))
  return path
}

// Actual SDK and stdio child, confined to tests. No downloaded external server.
const server = `
import { Server } from '${import.meta.resolve('@modelcontextprotocol/sdk/server/index.js')}';
import { StdioServerTransport } from '${import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js')}';
import { ListToolsRequestSchema, CallToolRequestSchema } from '${import.meta.resolve('@modelcontextprotocol/sdk/types.js')}';
await Bun.write(process.env.PID_FILE, String(process.pid));
const server = new Server({name:'fixture', version:'1'}, {capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema, async request => {
  if(process.env.MODE === 'fail') throw Error('fixture list failure');
  const second = !!request.params?.cursor;
  return { tools:[{name:second?'second':'nested', description:'Test nested schema', inputSchema:{type:'object', properties:{selection:{type:'object', properties:{ids:{type:'array',items:{type:'string'}}}, required:['ids']}},required:['selection'],additionalProperties:false}}],
    ...(!second || process.env.MODE === 'loop' ? {nextCursor:'page-2'} : {}) };
});
server.setRequestHandler(CallToolRequestSchema, async request => ({content:[{type:'text',text:JSON.stringify(request.params.arguments)}]}));
await server.connect(new StdioServerTransport());
`

const config = async (mode = 'ok') => {
  const pidFile = join(await directory(), 'pid')
  return { pidFile, mcpServers: { fixture: { command: process.execPath, args: ['-e', server], env: { PID_FILE: pidFile, MODE: mode } } } }
}
const stopped = async (pidFile: string) => {
  const pid = Number(await Bun.file(pidFile).text())
  expect(() => process.kill(pid, 0)).toThrow()
}

describe('opt-in MCP lifecycle', () => {
  test('no configured file means no external tools; explicit bad configuration fails', async () => {
    const registry = createToolRegistry()
    const result = await registerAllMCPServers(registry, await loadMCPConfig(undefined))
    expect(result.totalTools).toBe(0)
    expect(registry.list()).toEqual([])
    await result.disconnect()
    await expect(loadMCPConfig('')).rejects.toThrow('absolute')
    await expect(loadMCPConfig('relative.json')).rejects.toThrow('absolute')
    await expect(loadMCPConfig(join(await directory(), 'missing.json'))).rejects.toThrow()
    const path = join(await directory(), 'config.json')
    await Bun.write(path, JSON.stringify({ mcpServers: { fixture: { command: 'bun', bogus: true } } }))
    await expect(loadMCPConfig(path)).rejects.toThrow()
    await Bun.write(path, JSON.stringify({ mcpServers: { fixture: { command: 'bun', args: ['server.ts'] } } }))
    expect((await loadMCPConfig(path)).mcpServers?.fixture?.command).toBe('bun')
  })

  test('preserves required/nested schemas, discovers pages, calls tools and disconnects twice safely', async () => {
    const registry = createToolRegistry()
    const conf = await config()
    const result = await registerAllMCPServers(registry, conf)
    cleanup.push(result.disconnect)
    expect(result.totalTools).toBe(2)
    expect(registry.get('fixture__nested')?.parameters).toMatchObject({
      type: 'object', required: ['selection'], additionalProperties: false,
      properties: { selection: { required: ['ids'], properties: { ids: { type: 'array', items: { type: 'string' } } } } },
    })
    expect(await registry.get('fixture__nested')!.execute({ selection: { ids: ['x'] } }, { callerId: 'test', callerName: 'test' }))
      .toEqual({ success: true, data: JSON.stringify({ selection: { ids: ['x'] } }) })
    await result.disconnect()
    await result.disconnect()
    expect(registry.list()).toEqual([])
    await stopped(conf.pidFile)
  })

  for (const mode of ['fail', 'loop']) test(`failed discovery ${mode} closes the child and registers nothing`, async () => {
    const registry = createToolRegistry()
    const conf = await config(mode)
    const result = await registerAllMCPServers(registry, conf)
    cleanup.push(result.disconnect)
    expect(result.totalTools).toBe(0)
    expect(registry.list()).toEqual([])
    await stopped(conf.pidFile)
  })

  test('name collision leaves the original registration intact and closes the rejected child', async () => {
    const registry = createToolRegistry()
    const original = { name: 'fixture__second', description: 'Original', parameters: {}, execute: async () => ({ success: true }) }
    registry.register(original)
    const conf = await config()
    const result = await registerAllMCPServers(registry, conf)
    cleanup.push(result.disconnect)
    expect(result.totalTools).toBe(0)
    expect(registry.list()).toEqual([original])
    await stopped(conf.pidFile)
  })
})
