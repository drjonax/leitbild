import { z } from 'zod'
import { componentIdSchema, connectionIdSchema, processVariableValueSchema, variablePathSchema, type ComponentId, type ConnectionId, type VariablePath } from '../graph/index.ts'
import { commandsForProcessPlantAction } from '../actions.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import type { ProcessPlantRuntime } from '../runtime/model.ts'

export type ProcessPlantScheduledAction =
  | {
      readonly id: string
      readonly atMs: number
      readonly type: 'setVariable'
      readonly path: VariablePath
      readonly value: number | boolean
    }
  | {
      readonly id: string
      readonly atMs: number
      readonly type: 'tripComponent'
      readonly componentId: ComponentId
    }
  | {
      readonly id: string
      readonly atMs: number
      readonly type: 'primaryBoundaryLeak'
      readonly connectionId: ConnectionId
      readonly areaFraction: number
    }
  | {
      readonly id: string
      readonly atMs: number
      readonly type: 'steamGeneratorTubeLeak'
      readonly componentId: ComponentId
      readonly leakFraction: number
    }
  | {
      readonly id: string
      readonly atMs: number
      readonly type: 'reactorCoolantPumpTrip'
      readonly componentId: ComponentId
    }
  | {
      readonly id: string
      readonly atMs: number
      readonly type: 'lossOfOffsitePower'
    }

export interface ProcessPlantScheduleConfig {
  readonly actions: ReadonlyArray<ProcessPlantScheduledAction>
}

export interface ProcessPlantScheduleSnapshot {
  readonly schemaVersion: 1
  readonly firedActionIds: ReadonlyArray<string>
}

export interface ProcessPlantScheduleRunner {
  readonly applyDueActions: (runtime: ProcessPlantRuntime, nextElapsedMs: number) => void
  readonly snapshot: () => ProcessPlantScheduleSnapshot
}

const scheduledActionBaseSchema = {
  id: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/),
  atMs: z.number().int().nonnegative(),
}

export const processPlantScheduledActionSchema = z.discriminatedUnion('type', [
  z.object({
    ...scheduledActionBaseSchema,
    type: z.literal('setVariable'),
    path: variablePathSchema,
    value: processVariableValueSchema,
  }).strict(),
  z.object({
    ...scheduledActionBaseSchema,
    type: z.literal('tripComponent'),
    componentId: componentIdSchema,
  }).strict(),
  z.object({
    ...scheduledActionBaseSchema,
    type: z.literal('primaryBoundaryLeak'),
    connectionId: connectionIdSchema,
    areaFraction: z.number().finite().min(0).max(1),
  }).strict(),
  z.object({
    ...scheduledActionBaseSchema,
    type: z.literal('steamGeneratorTubeLeak'),
    componentId: componentIdSchema,
    leakFraction: z.number().finite().min(0).max(1),
  }).strict(),
  z.object({
    ...scheduledActionBaseSchema,
    type: z.literal('reactorCoolantPumpTrip'),
    componentId: componentIdSchema,
  }).strict(),
  z.object({
    ...scheduledActionBaseSchema,
    type: z.literal('lossOfOffsitePower'),
  }).strict(),
])

export const processPlantScheduleConfigSchema = z.object({
  actions: z.array(processPlantScheduledActionSchema).default([]),
}).strict()

export const processPlantScheduleSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  firedActionIds: z.array(z.string().min(1)),
}).strict()

export const createProcessPlantScheduleRunner = (config: {
  readonly system?: CompiledProcessPlant
  readonly schedule?: ProcessPlantScheduleConfig
  readonly restoredSnapshot?: ProcessPlantScheduleSnapshot
}): ProcessPlantScheduleRunner => {
  const schedule = processPlantScheduleConfigSchema.parse(config.schedule ?? { actions: [] })
  const restored = config.restoredSnapshot === undefined
    ? undefined
    : processPlantScheduleSnapshotSchema.parse(config.restoredSnapshot)
  const actionIds = new Set<string>()
  for (const action of schedule.actions) {
    if (actionIds.has(action.id)) throw new Error(`duplicate process plant scheduled action id: ${action.id}`)
    actionIds.add(action.id)
  }
  const firedActionIds = new Set(restored?.firedActionIds ?? [])
  for (const firedActionId of firedActionIds) {
    if (!actionIds.has(firedActionId)) throw new Error(`restored process plant schedule fired unknown action: ${firedActionId}`)
  }

  const actions = [...schedule.actions].sort((left, right) => left.atMs - right.atMs || left.id.localeCompare(right.id))

  const commandsForAction = (action: ProcessPlantScheduledAction): ReadonlyArray<{ readonly path: VariablePath; readonly value: number | boolean }> => {
    if (action.type === 'setVariable') return [{ path: action.path, value: action.value }]
    if (action.type === 'tripComponent' || action.type === 'reactorCoolantPumpTrip') {
      const path = `${action.componentId}.running` as VariablePath
      const variable = config.system?.graph.variables.find(candidate => candidate.path === path)
      if (!variable) throw new Error(`process plant ${action.type} action references component without running variable: ${action.componentId}`)
      if (variable.descriptor.quantity !== 'boolean') throw new Error(`process plant ${action.type} action requires boolean running variable: ${path}`)
      if (action.type === 'reactorCoolantPumpTrip') {
        const component = config.system?.graph.components.find(candidate => candidate.id === action.componentId)
        if (component?.kind !== 'centrifugalPump') throw new Error(`process plant reactorCoolantPumpTrip action requires centrifugalPump component: ${action.componentId}`)
      }
      return [{ path, value: false }]
    }
    if (action.type === 'primaryBoundaryLeak') {
      return [{ path: `${action.connectionId}.leak.areaFraction` as VariablePath, value: action.areaFraction }]
    }
    if (action.type === 'steamGeneratorTubeLeak') {
      const component = config.system?.graph.components.find(candidate => candidate.id === action.componentId)
      if (component !== undefined && component.kind !== 'steamGenerator') throw new Error(`process plant steamGeneratorTubeLeak action requires steamGenerator component: ${action.componentId}`)
      return [{ path: `${action.componentId}.tubeLeakFraction` as VariablePath, value: action.leakFraction }]
    }
    // A scheduled loss of offsite power is the named action operators inject.
    if (config.system === undefined) throw new Error(`process plant ${action.type} action ${action.id} requires the Plant it applies to`)
    return commandsForProcessPlantAction({ actionId: 'loss-offsite-power', parameters: {}, graph: config.system.graph })
  }

  if (config.system !== undefined) {
    for (const action of actions) {
      for (const command of commandsForAction(action)) {
        const variable = config.system.graph.variables.find(candidate => candidate.path === command.path)
        if (!variable) throw new Error(`process plant scheduled action ${action.id} references unknown variable: ${command.path}`)
        if (!variable.descriptor.writable) throw new Error(`process plant scheduled action ${action.id} targets non-writable variable: ${command.path}`)
        const expectedType = variable.descriptor.quantity === 'boolean' ? 'boolean' : 'number'
        if (typeof command.value !== expectedType) throw new Error(`process plant scheduled action ${action.id} value for ${command.path} must be ${expectedType}`)
      }
    }
  }

  return {
    applyDueActions: (runtime: ProcessPlantRuntime, nextElapsedMs: number): void => {
      for (const action of actions) {
        if (firedActionIds.has(action.id)) continue
        if (action.atMs > nextElapsedMs) continue
        for (const command of commandsForAction(action)) {
          runtime.writeCommand({ type: 'setVariable', path: command.path, value: command.value })
        }
        firedActionIds.add(action.id)
      }
    },
    snapshot: (): ProcessPlantScheduleSnapshot => ({
      schemaVersion: 1,
      firedActionIds: [...firedActionIds],
    }),
  }
}
