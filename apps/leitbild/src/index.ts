import { resolve } from 'node:path'
import { z } from 'zod'
import {
  moduleRegistrationSchema,
} from '@leitbild/contracts'
import { createWorkspaceHost } from './host.ts'
import { createModuleGateway } from './module-gateway.ts'
import { createWorkspaceHostServer } from './server.ts'
import { createWorkspaceStore } from './store.ts'

const parseEnvironmentJson = <T>(key: string, schema: z.ZodType<T>, fallback: T): T => {
  const raw = process.env[key]
  if (raw === undefined) return fallback
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch (error) {
    throw new Error(`${key} must be valid JSON`, { cause: error })
  }
  return schema.parse(value)
}

const registrations = parseEnvironmentJson('WORKSPACE_MODULES', z.array(moduleRegistrationSchema), [])

const hostHome = resolve(process.env.WORKSPACE_HOST_HOME ?? './data/workspace-host')
const store = createWorkspaceStore(resolve(hostHome, 'workspaces.sqlite'))
const host = createWorkspaceHost({
  store,
  modules: createModuleGateway({ registrations }),
})
const server = createWorkspaceHostServer({
  host,
  port: Number(process.env.PORT) || 3100,
  bindHost: process.env.BIND_HOST ?? '127.0.0.1',
})

const shutdown = (): void => {
  server.stop(true)
  store.close()
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

console.log(`Workspace Host listening on http://${server.hostname}:${server.port}`)
console.log(`Installed Modules: ${registrations.map(registration => registration.moduleId).join(', ') || '(none)'}`)
