import { z } from 'zod'
import type { SimulationCapability, SimulationCapabilityKind } from './protocol.ts'

const capabilityIdSchema = z.string().regex(/^world\.[a-z][a-z0-9-]*(?:[._-][a-z0-9-]+)+$/)

export const defineSimulationCapability = (config: SimulationCapability): SimulationCapability => {
  capabilityIdSchema.parse(config.id)
  if (config.title.trim() === '') throw new Error(`Capability ${config.id} has no title`)
  if (config.description.trim() === '') throw new Error(`Capability ${config.id} has no description`)
  if (config.kind === 'query' && config.risk !== 'read') {
    throw new Error(`Query Capability ${config.id} must have read risk`)
  }
  if (config.kind === 'query' && config.schedulable === true) {
    throw new Error(`Query Capability ${config.id} cannot be scheduled`)
  }
  if (config.audience === 'system' && config.kind !== 'query') {
    throw new Error(`System-audience Capability ${config.id} must be a query`)
  }
  if (config.kind === 'query' && config.buildCommand !== undefined) {
    throw new Error(`Query Capability ${config.id} cannot declare command targets`)
  }
  if (config.kind === 'command' && config.buildCommand === undefined) {
    throw new Error(`Command Capability ${config.id} must build a command`)
  }
  return Object.freeze(config)
}

export const defineSimulationQueryCapability = (config: Omit<SimulationCapability, 'kind' | 'risk' | 'idempotent' | 'schedulable' | 'buildCommand'>): SimulationCapability =>
  defineSimulationCapability({ ...config, kind: 'query', risk: 'read', idempotent: true })

export const defineSimulationCommandCapability = (config: Omit<SimulationCapability, 'kind' | 'risk'> & {
  readonly risk?: 'write' | 'destructive'
}): SimulationCapability => defineSimulationCapability({ ...config, kind: 'command', risk: config.risk ?? 'write' })

export const capabilityIds = (
  capabilities: ReadonlyArray<SimulationCapability>,
  kind: SimulationCapabilityKind,
): ReadonlyArray<string> => capabilities.filter(capability => capability.kind === kind).map(capability => capability.id)

export const capabilityJsonSchema = (schema: z.ZodType): Readonly<Record<string, unknown>> =>
  // Capability payloads are JSON wire values. Most transforms only apply a
  // TypeScript brand after validation, so the input view is the truthful wire
  // schema for both request and response catalogs.
  z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' })
