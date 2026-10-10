import { z } from 'zod'
import type { CompiledComponent, CompiledPlantGraph, VariablePath } from './graph/index.ts'

export interface ProcessPlantActionCommand {
  readonly path: VariablePath
  readonly value: number | boolean
}

export interface ProcessPlantActionParameter {
  readonly id: string
  readonly label: string
  readonly unit: string
  readonly defaultValue: number
  readonly min: number
  readonly max: number
  readonly step: number
  readonly digits: number
}

export interface ProcessPlantActionDefinition {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly parameters: ReadonlyArray<ProcessPlantActionParameter>
  readonly commands: (
    values: Readonly<Record<string, unknown>>,
    graph: CompiledPlantGraph,
  ) => ReadonlyArray<ProcessPlantActionCommand>
}

export interface ProcessPlantActionCatalogEntry {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly parameters: ReadonlyArray<ProcessPlantActionParameter>
  readonly inputSchema: Readonly<Record<string, unknown>>
}

const path = (value: string): VariablePath => value as VariablePath

const parameterValue = (
  parameters: ReadonlyArray<ProcessPlantActionParameter>,
  values: Readonly<Record<string, unknown>>,
  id: string,
): number => {
  const parameter = parameters.find(candidate => candidate.id === id)
  if (parameter === undefined) throw new Error(`unknown process plant action parameter: ${id}`)
  const value = values[id] ?? parameter.defaultValue
  const parsed = z.number().finite().min(parameter.min).max(parameter.max).parse(value)
  return parsed
}

const componentsByRole = (
  graph: CompiledPlantGraph,
  role: string,
): ReadonlyArray<CompiledComponent> => graph.components.filter(component => component.metadata?.role === role)

const requiredComponent = (
  graph: CompiledPlantGraph,
  predicate: (component: CompiledComponent) => boolean,
  label: string,
): CompiledComponent => {
  const component = graph.components.find(predicate)
  if (component === undefined) throw new Error(`Plant model has no ${label}`)
  return component
}

const commandsForRole = (
  graph: CompiledPlantGraph,
  role: string,
  localPath: string,
  value: number | boolean,
): ReadonlyArray<ProcessPlantActionCommand> => {
  const components = componentsByRole(graph, role)
  if (components.length === 0) throw new Error(`Plant model has no components with role ${role}`)
  return components.map(component => ({ path: path(`${component.id}.${localPath}`), value }))
}

const leakParameters = [{
  id: 'leakPercent', label: 'Leak', unit: '%', defaultValue: 1.2, min: 0.1, max: 4, step: 0.1, digits: 1,
}] as const
const valveParameters = [{
  id: 'positionPercent', label: 'Position', unit: '%', defaultValue: 35, min: 0, max: 100, step: 5, digits: 0,
}] as const

export const processPlantActions: ReadonlyArray<ProcessPlantActionDefinition> = [
  {
    id: 'steam-generator-tube-leak-a',
    title: 'SG A tube leak',
    description: 'Introduce a primary-to-secondary leak in the steam generator assigned to loop A.',
    parameters: leakParameters,
    commands: (values, graph) => {
      const steamGenerator = requiredComponent(
        graph,
        component => component.metadata?.equipmentClass === 'steam-generator' && component.metadata.loopId === 'A',
        'loop A steam generator',
      )
      return [{ path: path(`${steamGenerator.id}.tubeLeakFraction`), value: parameterValue(leakParameters, values, 'leakPercent') / 100 }]
    },
  },
  {
    id: 'trip-reactor-coolant-pumps',
    title: 'Trip all RCPs',
    description: 'Trip every component identified by the model as a reactor coolant pump.',
    parameters: [],
    commands: (_values, graph) => commandsForRole(graph, 'primary-pump', 'running', false),
  },
  {
    id: 'loss-main-feedwater',
    title: 'Loss of main feedwater',
    description: 'Trip every component identified by the model as a main feedwater pump.',
    parameters: [],
    commands: (_values, graph) => commandsForRole(graph, 'main-feedwater-pump', 'running', false),
  },
  {
    id: 'steam-generator-b-feedwater-runback',
    title: 'SG B feedwater runback',
    description: 'Fail the loop B feedwater control valve to the selected position.',
    parameters: valveParameters,
    commands: (values, graph) => {
      const valve = requiredComponent(
        graph,
        component => component.metadata?.equipmentClass === 'feedwater-control-valve' && component.metadata.loopId === 'B',
        'loop B feedwater control valve',
      )
      return [
        { path: path(`${valve.id}.positionFailureActive`), value: true },
        { path: path(`${valve.id}.failedPositionFraction`), value: parameterValue(valveParameters, values, 'positionPercent') / 100 },
      ]
    },
  },
  {
    id: 'pressurizer-relief-open',
    title: 'Pressurizer relief stuck open',
    description: 'Fail the pressurizer relief path to the selected open position.',
    parameters: valveParameters,
    commands: (values, graph) => {
      const pressurizer = requiredComponent(graph, component => component.metadata?.equipmentClass === 'pressurizer', 'pressurizer')
      return [
        { path: path(`${pressurizer.id}.reliefValveFailureActive`), value: true },
        { path: path(`${pressurizer.id}.reliefValveFailedPositionFraction`), value: parameterValue(valveParameters, values, 'positionPercent') / 100 },
      ]
    },
  },
  {
    id: 'pressurizer-porv-block-valve-close',
    title: 'Close PORV block valve',
    description: 'Close the motor-operated block valve in series with the pressurizer PORV, isolating the relief line whatever the PORV does.',
    parameters: [],
    commands: (_values, graph) => {
      const pressurizer = requiredComponent(graph, component => component.metadata?.equipmentClass === 'pressurizer', 'pressurizer')
      return [{ path: path(`${pressurizer.id}.blockValvePositionFraction`), value: 0 }]
    },
  },
  {
    id: 'block-low-pressure-safety-injection',
    title: 'Block low-pressure SI',
    description: 'Press the block for safety injection on low pressurizer pressure, for a planned cooldown and depressurization. Accepted only below P-11 with the reactor tripped; the block resets when pressure rises above P-11.',
    parameters: [],
    commands: (_values, graph) => {
      const logic = requiredComponent(graph, component => component.kind === 'safetyInjectionBlockLogic', 'safety injection block logic')
      return [{ path: path(`${logic.id}.blockPushbutton`), value: true }]
    },
  },
  {
    id: 'turbine-trip',
    title: 'Turbine trip',
    description: 'Close the turbine stop valve and reject turbine load.',
    parameters: [],
    commands: (_values, graph) => [
      ...commandsForRole(graph, 'turbine-stop', 'positionFraction', 0),
      ...commandsForRole(graph, 'turbine-generator', 'loadFraction', 0),
    ],
  },
  {
    id: 'loss-offsite-power',
    title: 'Loss of offsite power',
    description: 'Mark the offsite grid unavailable and open every breaker that feeds a bus from offsite power.',
    parameters: [],
    commands: (_values, graph) => [
      ...commandsForRole(graph, 'offsite-power-source', 'available', false),
      ...commandsForRole(graph, 'offsite-power-breaker', 'closed', false),
    ],
  },
]

const actionById = new Map(processPlantActions.map(action => [action.id, action]))

export const processPlantActionCatalog = (): ReadonlyArray<ProcessPlantActionCatalogEntry> =>
  processPlantActions.map(action => ({
    id: action.id,
    title: action.title,
    description: action.description,
    parameters: action.parameters,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(action.parameters.map(parameter => [parameter.id, {
        type: 'number',
        minimum: parameter.min,
        maximum: parameter.max,
        default: parameter.defaultValue,
        title: parameter.label,
      }])),
    },
  }))

export const commandsForProcessPlantAction = (config: {
  readonly actionId: string
  readonly parameters: Readonly<Record<string, unknown>>
  readonly graph: CompiledPlantGraph
}): ReadonlyArray<ProcessPlantActionCommand> => {
  const action = actionById.get(config.actionId)
  if (action === undefined) throw new Error(`unknown process plant action: ${config.actionId}`)
  const commands = action.commands(config.parameters, config.graph)
  const variablesByPath = new Map(config.graph.variables.map(variable => [variable.path, variable]))
  for (const command of commands) {
    const variable = variablesByPath.get(command.path)
    if (variable === undefined) throw new Error(`process plant action ${config.actionId} references unknown variable: ${command.path}`)
    if (!variable.descriptor.writable) throw new Error(`process plant action ${config.actionId} targets non-writable variable: ${command.path}`)
  }
  return commands
}
