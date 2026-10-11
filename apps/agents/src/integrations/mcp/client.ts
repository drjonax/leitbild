// ============================================================================
// MCP Client — Connects to MCP servers and registers their tools.
//
// One function: registerMCPServer. Spawns a server process, discovers its
// tools via the MCP protocol, and registers each as a Tool in the global
// ToolRegistry. Agents see MCP tools alongside built-in tools — no special
// handling needed.
//
// Config format matches Claude Desktop's mcp config for familiarity.
// ============================================================================

import { Client } from '@modelcontextprotocol/sdk/client'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import type { ToolRegistry } from '../../core/types/tool.ts'

export interface MCPServerConfig {
  readonly command: string
  readonly args?: ReadonlyArray<string>
  readonly env?: Record<string, string>
}

export interface MCPConfig {
  readonly mcpServers?: Record<string, MCPServerConfig>
}

interface MCPConnection {
  readonly name: string
  readonly client: Client
  readonly transport: StdioClientTransport
  readonly toolNames: ReadonlyArray<string>
}

const configSchema = z.object({ mcpServers: z.record(z.string().min(1), z.object({
  command: z.string().min(1), args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
}).strict()).optional() }).strict()

/** External servers are operator-installed, opt-in deployment configuration. */
export const loadMCPConfig = async (path: string | undefined): Promise<MCPConfig> => {
  if (path === undefined) return {}
  if (!isAbsolute(path)) throw new Error('LEITBILD_MCP_CONFIG must be an absolute path')
  return configSchema.parse(await Bun.file(path).json())
}

export interface MCPRegistrationResult {
  readonly totalTools: number
  readonly disconnect: () => Promise<void>
}

const registerMCPServer = async (
  registry: ToolRegistry,
  serverName: string,
  config: MCPServerConfig,
  connections: MCPConnection[],
): Promise<number> => {
  const client = new Client({ name: `leitbild-${serverName}`, version: '1.0.0' })
  const transport = new StdioClientTransport({
    command: config.command,
    args: [...(config.args ?? [])],
    env: config.env ? { ...process.env, ...config.env } as Record<string, string> : undefined,
    // Drain through the service log; an unread pipe can block a verbose server.
    stderr: 'inherit',
  })

  const registered: string[] = []
  try {
    await client.connect(transport)
    const tools = []
    let cursor: string | undefined
    const cursors = new Set<string>()
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined)
      tools.push(...page.tools)
      cursor = page.nextCursor
      if (cursor && cursors.has(cursor)) throw new Error(`MCP "${serverName}" repeated a tool-list cursor`)
      if (cursor) cursors.add(cursor)
    } while (cursor)
    const names = tools.map(tool => `${serverName}__${tool.name}`)
    if (new Set(names).size !== names.length || names.some(name => registry.has(name))) {
      throw new Error(`MCP "${serverName}" has duplicate or already registered tool names`)
    }
    for (const tool of tools) {
      const toolName = `${serverName}__${tool.name}`
      registry.register({
        name: toolName,
        description: tool.description ?? tool.name,
        parameters: tool.inputSchema,
        execute: async (params, context) => {
          try {
            const result = await client.callTool({ name: tool.name, arguments: params }, undefined, { signal: context.signal })
            const isError = result.isError ?? false
            // Extract text content from MCP response.
            const textParts = (result.content as ReadonlyArray<{ type: string; text?: string }>)
              .filter(c => c.type === 'text' && c.text)
              .map(c => c.text!)
            const data = textParts.join('\n')
            return isError ? { success: false, error: data } : { success: true, data }
          } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : 'MCP tool call failed' }
          }
        },
      })
      registered.push(toolName)
    }
    connections.push({ name: serverName, client, transport, toolNames: registered })
    return registered.length
  } catch (error) {
    for (const name of registered) registry.unregister(name)
    try { await transport.close() }
    catch (closeError) { console.error(`MCP "${serverName}" cleanup failed:`, closeError) }
    throw error
  }
}

export const registerAllMCPServers = async (
  registry: ToolRegistry,
  config: MCPConfig,
): Promise<MCPRegistrationResult> => {
  const connections: MCPConnection[] = []
  const servers = config.mcpServers ?? {}

  for (const [name, serverConfig] of Object.entries(servers)) {
    try {
      const count = await registerMCPServer(registry, name, serverConfig, connections)
      console.log(`MCP "${name}": ${count} tools registered`)
    } catch (err) {
      console.error(`MCP "${name}" failed to connect:`, err instanceof Error ? err.message : err)
    }
  }

  const totalTools = connections.reduce((sum, c) => sum + c.toolNames.length, 0)
  return {
    totalTools,
    disconnect: async () => {
      await Promise.all(connections.splice(0).map(async c => {
        for (const name of c.toolNames) registry.unregister(name)
        try { await c.client.close() }
        catch (error) { console.error(`MCP "${c.name}" disconnect failed:`, error) }
      }))
    },
  }
}
