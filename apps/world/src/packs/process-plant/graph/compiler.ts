import type { z } from 'zod'
import type {
  CompiledComponent,
  CompiledProcessLink,
  CompiledPlantGraph,
  CompiledPort,
  CompiledVariable,
  ComponentVariableBindingOverride,
  ComponentDefinition,
  ComponentId,
  ComponentKind,
  ConnectionKind,
  ConnectionService,
  ConnectionId,
  LocalVariablePath,
  PlantGraphSpec,
  PortDefinition,
  PortName,
  PortRef,
  ProcessSignalBinding,
  ProcessSignalTagId,
  VariableDescriptor,
  VariablePath,
} from './model.ts'
import { linkVariableSemanticsFor, validateProcessLinkContracts } from './link-contracts.ts'
import { connectionKindSchema, deriveProcessVariableCapabilities, plantGraphSpecSchema } from './model.ts'
import { readingAccepts, type CompiledComponentSemantics, type CompiledEnergyRole, type CompiledStateAspect, type ComponentSemantics, type StateAspectDeclaration } from './semantics.ts'

interface ResolvedPortRef {
  readonly componentId: ComponentId
  readonly portName: string
}

const connectionKinds: ReadonlyArray<ConnectionKind> = connectionKindSchema.options

const emptyLinksByKind = (): Record<ConnectionKind, number[]> => {
  const entries = connectionKinds.map((kind): readonly [ConnectionKind, number[]] => [kind, []])
  return Object.fromEntries(entries) as Record<ConnectionKind, number[]>
}

const parsePortRef = (ref: PortRef): ResolvedPortRef => {
  const separatorIndex = ref.lastIndexOf('.')
  if (separatorIndex < 1 || separatorIndex === ref.length - 1) throw new Error(`invalid port ref: ${ref}`)
  return {
    componentId: ref.slice(0, separatorIndex) as ComponentId,
    portName: ref.slice(separatorIndex + 1),
  }
}

const assertUnique = <T>(items: ReadonlyArray<T>, keyFor: (item: T) => string, label: string): void => {
  const seen = new Set<string>()
  for (const item of items) {
    const key = keyFor(item)
    if (seen.has(key)) throw new Error(`duplicate ${label}: ${key}`)
    seen.add(key)
  }
}

const assertUniqueDefined = <T>(items: ReadonlyArray<T>, keyFor: (item: T) => string | undefined, label: string): void => {
  const seen = new Set<string>()
  for (const item of items) {
    const key = keyFor(item)
    if (key === undefined) continue
    if (seen.has(key)) throw new Error(`duplicate ${label}: ${key}`)
    seen.add(key)
  }
}

const parseWithContext = <T>(schema: z.ZodType<T>, input: unknown, context: string): T => {
  const result = schema.safeParse(input)
  if (result.success) return result.data
  throw new Error(`${context}: ${result.error.issues.map(issue => `${issue.path.join('.') || '<root>'} ${issue.message}`).join('; ')}`)
}

const compilePorts = (definition: ComponentDefinition): Readonly<Record<string, CompiledPort>> =>
  Object.fromEntries(Object.entries(definition.ports).map(([name, port], index) => [
    name,
    {
      index,
      name: name as PortName,
      kind: port.kind,
      direction: port.direction,
      ...(port.circuit === undefined ? {} : { circuit: port.circuit }),
    },
  ]))

const resolveComponentPorts = (
  componentId: ComponentId,
  definition: ComponentDefinition,
  component: PlantGraphSpec['components'][number],
  parameters: unknown,
): Readonly<Record<string, PortDefinition>> => {
  const additionalPorts = definition.resolveAdditionalPorts?.({ component, parameters }) ?? {}
  const ports = { ...definition.ports }
  for (const [name, port] of Object.entries(additionalPorts)) {
    const existing = ports[name]
    if (existing !== undefined) {
      if (existing.kind !== port.kind || existing.direction !== port.direction) {
        throw new Error(`component ${componentId} additional port conflicts with static port: ${name}`)
      }
      continue
    }
    ports[name] = port
  }
  return ports
}

const compatiblePortKinds = (from: PortDefinition, to: PortDefinition): boolean => {
  if (from.kind === to.kind) return true
  if (from.kind === 'hydraulicThermal' && (to.kind === 'hydraulic' || to.kind === 'thermal')) return true
  if (to.kind === 'hydraulicThermal' && (from.kind === 'hydraulic' || from.kind === 'thermal')) return true
  return false
}

const directionAllowsConnection = (from: PortDefinition, to: PortDefinition): boolean => {
  const fromCanSend = from.direction === 'out' || from.direction === 'bidirectional'
  const toCanReceive = to.direction === 'in' || to.direction === 'bidirectional'
  return fromCanSend && toCanReceive
}

const inferConnectionKind = (from: PortDefinition, to: PortDefinition): ConnectionKind => {
  if (!compatiblePortKinds(from, to)) throw new Error(`cannot infer link kind for incompatible port kinds ${from.kind} -> ${to.kind}`)
  if (from.kind === 'electricalAc' && to.kind === 'electricalAc') return 'electricalPower'
  if (from.kind === 'mechanicalShaft' && to.kind === 'mechanicalShaft') return 'mechanicalTorque'
  if (from.kind === 'controlSignal' && to.kind === 'controlSignal') return 'controlSignal'
  if (from.kind === 'logicSignal' && to.kind === 'logicSignal') return 'logicSignal'
  if (from.kind === 'thermal' || to.kind === 'thermal') return 'thermalContact'
  return 'fluidFlow'
}

const resolveDefinition = (
  registry: ReadonlyMap<ComponentKind, ComponentDefinition>,
  kind: ComponentKind,
): ComponentDefinition => {
  const definition = registry.get(kind)
  if (!definition) throw new Error(`unknown process plant component kind: ${kind}`)
  return definition
}

const variablePathFor = (componentId: ComponentId, localPath: LocalVariablePath): VariablePath =>
  `${componentId}.${localPath}` as VariablePath

const processLinkVariablePathFor = (connectionId: ConnectionId, localPath: LocalVariablePath): VariablePath =>
  `${connectionId}.${localPath}` as VariablePath

const assertComponentVariableOverridesValid = (
  componentId: ComponentId,
  definition: ComponentDefinition,
  overrides: ReadonlyArray<ComponentVariableBindingOverride>,
): void => {
  assertUnique(overrides, override => override.path, `component ${componentId} variable metadata path`)
  const definitionPaths = new Set(definition.variables.map(variable => variable.path))
  for (const override of overrides) {
    if (!definitionPaths.has(override.path)) {
      throw new Error(`component ${componentId} variable metadata references unknown local variable: ${override.path}`)
    }
  }
}

const applyComponentVariableOverride = (
  variable: VariableDescriptor,
  override: ComponentVariableBindingOverride | undefined,
): VariableDescriptor => {
  if (override === undefined) return variable
  const { path: _path, ...metadata } = override
  return {
    ...variable,
    ...metadata,
  }
}

// A kind's semantics name its own variables and ports; every name must exist,
// a state must be solved (or an outside boundary), and a command must be one.
const compileComponentSemantics = (
  componentId: ComponentId,
  semantics: ComponentSemantics,
  variables: ReadonlyArray<VariableDescriptor>,
  ports: Readonly<Record<string, PortDefinition>>,
  parameters: unknown,
): CompiledComponentSemantics => {
  const context = `component ${componentId} semantics`
  const byPath = new Map(variables.map(variable => [String(variable.path), variable]))
  const resolve = (local: LocalVariablePath): VariableDescriptor => {
    const variable = byPath.get(variablePathFor(componentId, local))
    if (variable === undefined) throw new Error(`${context} names unknown variable ${local}`)
    return variable
  }
  const compileAspect = (declaration: StateAspectDeclaration): CompiledStateAspect => {
    const state = declaration.state
    if (state !== undefined) {
      const variable = resolve(state.variable)
      if (variable.writable && variable.actuation !== 'boundary') throw new Error(`${context}: ${declaration.aspect} state ${state.variable} is writable, so it would draw a demand as the state`)
      if (!readingAccepts(state.reading, variable)) throw new Error(`${context}: ${declaration.aspect} state ${state.variable} (${variable.quantity}) cannot be read as ${state.reading}`)
      if (state.reading === 'closedWhileTrue' && declaration.aspect !== 'position') throw new Error(`${context}: only a position reads closed while true, not ${declaration.aspect}`)
    }
    if (declaration.command !== undefined) {
      const command = resolve(declaration.command)
      if (!command.writable || command.actuation !== 'command') throw new Error(`${context}: ${declaration.aspect} command ${declaration.command} is not a writable command`)
    }
    return {
      aspect: declaration.aspect,
      ...(state === undefined ? {} : { state: { path: variablePathFor(componentId, state.variable), reading: state.reading } }),
      ...(declaration.command === undefined ? {} : { command: variablePathFor(componentId, declaration.command) }),
    }
  }
  const portName = (name: string): PortName => {
    if (ports[name] === undefined) throw new Error(`${context} names unknown port ${name}`)
    return name as PortName
  }
  const record = parameters !== null && typeof parameters === 'object' && !Array.isArray(parameters) ? parameters as Record<string, unknown> : {}
  return {
    ...(semantics.function === undefined ? {} : { function: semantics.function }),
    aspects: semantics.aspects.map(compileAspect),
    embedded: semantics.embedded.map(device => ({
      id: device.id,
      label: device.label,
      function: device.function,
      port: portName(device.port),
      aspects: device.aspects.map(compileAspect),
      variables: device.variables.map(local => {
        resolve(local as LocalVariablePath)
        return variablePathFor(componentId, local as LocalVariablePath)
      }),
    })),
    // An outlet whose rating the instance leaves out, or sets to zero, is unrated; readers then cannot judge "no flow" there.
    ratedOutflow: semantics.ratedOutflow.flatMap(rating => {
      const port = ports[rating.port]
      if (port === undefined || port.direction === 'in') throw new Error(`${context}: rated outflow names ${rating.port}, which is not an outlet`)
      const flow = record[rating.parameter]
      if (flow === undefined || flow === 0) return []
      if (typeof flow !== 'number' || !(flow > 0)) throw new Error(`${context}: rated outflow parameter ${rating.parameter} must be a non-negative number`)
      return [{ port: rating.port as PortName, flowKgPerS: flow }]
    }),
    portFlows: semantics.portFlows.map(flow => {
      const variable = resolve(flow.variable as LocalVariablePath)
      if (variable.quantity !== 'flowRate' || variable.writable) throw new Error(`${context}: flow through ${flow.port} names ${flow.variable}, which is not a solved flow`)
      return { port: portName(flow.port), path: variablePathFor(componentId, flow.variable as LocalVariablePath) }
    }),
    keyValues: semantics.keyValues.map(local => {
      const variable = resolve(local as LocalVariablePath)
      if (variable.writable) throw new Error(`${context}: key value ${local} is writable`)
      return variablePathFor(componentId, local as LocalVariablePath)
    }),
    meaningfulWhile: semantics.meaningfulWhile.map(qualified => {
      const flag = resolve(qualified.flag as LocalVariablePath)
      if (flag.quantity !== 'boolean' || flag.writable) throw new Error(`${context}: readings are meaningful while ${qualified.flag}, which is not a solved flag`)
      return {
        flag: variablePathFor(componentId, qualified.flag as LocalVariablePath),
        variables: qualified.variables.map(local => {
          resolve(local as LocalVariablePath)
          return variablePathFor(componentId, local as LocalVariablePath)
        }),
      }
    }),
    energy: semantics.energy.map((role): CompiledEnergyRole => {
      const circuits = new Set(Object.values(ports).map(port => port.circuit))
      const named = role.role === 'transfer' ? [role.from, role.to] : [role.circuit]
      for (const circuit of named) if (!circuits.has(circuit)) throw new Error(`${context}: energy ${role.role} names circuit ${circuit}, which no port has`)
      if (role.role === 'transfer') {
        if (role.from === role.to) throw new Error(`${context}: energy transfer within circuit ${role.from}`)
        return role
      }
      const rate = resolve(role.rate as LocalVariablePath)
      if (rate.quantity !== 'power' || rate.writable) throw new Error(`${context}: energy ${role.role} rate ${role.rate} must be a solved power`)
      return { ...role, rate: variablePathFor(componentId, role.rate as LocalVariablePath) }
    }),
  }
}

// Names readers resolve must be unambiguous: an operator's short label names
// one component, and a signal tag never reads as a component id.
const assertNamesUnambiguous = (components: ReadonlyArray<CompiledComponent>, variables: ReadonlyArray<CompiledVariable>): void => {
  assertUniqueDefined(components, component => component.metadata?.presentation?.shortLabel, 'component short label')
  const componentIds = new Set(components.map(component => String(component.id)))
  for (const variable of variables) {
    const tag = variable.descriptor.tagId
    if (tag !== undefined && componentIds.has(String(tag))) throw new Error(`signal tag ${tag} equals a component id`)
  }
}

// What writing a variable does, and what a ratio measures, are declared for
// every variable, so no reader has to guess a command from a name.
const assertVariableSemantics = (variables: ReadonlyArray<CompiledVariable>): void => {
  for (const variable of variables) {
    if (variable.descriptor.writable && variable.descriptor.actuation === undefined) throw new Error(`writable variable ${variable.path} must declare its actuation`)
    if (!variable.descriptor.writable && variable.descriptor.actuation !== undefined) throw new Error(`read-only variable ${variable.path} cannot declare an actuation`)
    if (variable.descriptor.quantity === 'ratio' && variable.descriptor.measurand === undefined) throw new Error(`ratio variable ${variable.path} must declare its measurand`)
  }
}

const signalBindingFor = (variable: CompiledVariable): ProcessSignalBinding => ({
  path: variable.path,
  ...(variable.descriptor.tagId === undefined ? {} : { tagId: variable.descriptor.tagId }),
  ...(variable.descriptor.equipmentId === undefined ? {} : { equipmentId: variable.descriptor.equipmentId }),
  ...(variable.descriptor.description === undefined ? {} : { description: variable.descriptor.description }),
  ...(variable.descriptor.externalRefs === undefined ? {} : { externalRefs: variable.descriptor.externalRefs }),
  capabilities: deriveProcessVariableCapabilities({ descriptor: variable.descriptor, published: variable.published }),
  ...(variable.descriptor.limits === undefined ? {} : { limits: variable.descriptor.limits }),
  label: variable.descriptor.label,
  kind: variable.descriptor.kind,
  discipline: variable.descriptor.discipline,
  quantity: variable.descriptor.quantity,
  unit: variable.descriptor.unit,
  writable: variable.descriptor.writable,
  ...(variable.descriptor.actuation === undefined ? {} : { actuation: variable.descriptor.actuation }),
  ...(variable.descriptor.measurand === undefined ? {} : { measurand: variable.descriptor.measurand }),
  published: variable.published,
  owner: variable.owner,
})

const validateSignalMetadata = (variables: ReadonlyArray<CompiledVariable>): void => {
  for (const variable of variables) {
    if (variable.descriptor.tagId === undefined) continue
    const capabilities = deriveProcessVariableCapabilities({ descriptor: variable.descriptor, published: variable.published })
    if (!capabilities.aiVisible && !capabilities.procedureRelevant && !capabilities.operatorFacing) {
      throw new Error(`process signal tag ${variable.descriptor.tagId} on ${variable.path} is not visible to AI, procedures, or operators`)
    }
  }
}

const parameterRecord = (component: CompiledComponent): Record<string, unknown> => {
  if (!component.parameters || typeof component.parameters !== 'object' || Array.isArray(component.parameters)) {
    throw new Error(`component ${component.id} parameters are not an object`)
  }
  return component.parameters as Record<string, unknown>
}

const assertPortConnected = (
  component: CompiledComponent,
  links: ReadonlyArray<CompiledProcessLink>,
  portName: string,
  direction: 'incoming' | 'outgoing',
): void => {
  const connected = links.some(link =>
    direction === 'incoming'
      ? link.toComponentIndex === component.index && String(link.toPortName) === portName
      : link.fromComponentIndex === component.index && String(link.fromPortName) === portName,
  )
  if (!connected) throw new Error(`component ${component.id} ${component.kind} requires ${direction} connection on port ${portName}`)
}

const validateValveComponent = (component: CompiledComponent): void => {
  if (component.kind !== 'processValve' && component.kind !== 'steamValve') return
  const parameters = parameterRecord(component)
  const mode = parameters.valveMode
  if ((mode === 'relief' || mode === 'safety') && parameters.setpointMPa === undefined) {
    throw new Error(`component ${component.id} ${mode} valve requires setpointMPa`)
  }
  if (typeof parameters.reseatMPa === 'number' && typeof parameters.setpointMPa === 'number' && parameters.reseatMPa > parameters.setpointMPa) {
    throw new Error(`component ${component.id} valve reseatMPa cannot exceed setpointMPa`)
  }
}

const validateValveControllerBindings = (
  components: ReadonlyArray<CompiledComponent>,
  variables: ReadonlyArray<CompiledVariable>,
): void => {
  const variableByPath = new Map(variables.map(variable => [variable.path, variable]))
  for (const component of components) {
    if (component.kind !== 'processValve' && component.kind !== 'steamValve') continue
    const parameters = parameterRecord(component)
    const controller = parameters.controller
    if (controller === undefined) continue
    const measuredPath = (controller as { readonly measuredPath?: unknown }).measuredPath
    if (typeof measuredPath !== 'string') {
      throw new Error(`component ${component.id} valve controller measuredPath must be a variable path`)
    }
    const measuredVariable = variableByPath.get(measuredPath as VariablePath)
    if (!measuredVariable) {
      throw new Error(`component ${component.id} valve controller references unknown measuredPath ${measuredPath}`)
    }
    if (measuredVariable.descriptor.quantity === 'boolean') {
      throw new Error(`component ${component.id} valve controller measuredPath must reference a numeric variable: ${measuredPath}`)
    }
  }
}

const validateHeatExchangerComponent = (component: CompiledComponent, links: ReadonlyArray<CompiledProcessLink>): void => {
  if (component.kind !== 'heatExchanger') return
  assertPortConnected(component, links, 'hotIn', 'incoming')
  assertPortConnected(component, links, 'hotOut', 'outgoing')
  assertPortConnected(component, links, 'coldIn', 'incoming')
  assertPortConnected(component, links, 'coldOut', 'outgoing')
}

const validateAccumulatorComponent = (component: CompiledComponent, links: ReadonlyArray<CompiledProcessLink>): void => {
  if (component.kind !== 'accumulator') return
  const parameters = parameterRecord(component)
  const totalVolume = parameters.totalVolumeM3
  const initialInventory = parameters.initialLiquidInventoryKg
  const density = parameters.liquidDensityKgPerM3 ?? 950
  if (typeof totalVolume !== 'number' || typeof initialInventory !== 'number' || typeof density !== 'number') {
    throw new Error(`component ${component.id} accumulator parameters failed numeric validation`)
  }
  if (initialInventory / density >= totalVolume) throw new Error(`component ${component.id} accumulator initial liquid inventory must leave gas volume`)
  if (typeof parameters.minimumUsableInventoryKg === 'number' && parameters.minimumUsableInventoryKg > initialInventory) {
    throw new Error(`component ${component.id} accumulator minimumUsableInventoryKg cannot exceed initialLiquidInventoryKg`)
  }
  assertPortConnected(component, links, 'outlet', 'outgoing')
}

const validateContainmentComponent = (component: CompiledComponent, links: ReadonlyArray<CompiledProcessLink>): void => {
  if (component.kind !== 'containmentVolume') return
  assertPortConnected(component, links, 'massEnergyIn', 'incoming')
}

const validateStrongComponentContracts = (
  components: ReadonlyArray<CompiledComponent>,
  links: ReadonlyArray<CompiledProcessLink>,
): void => {
  for (const component of components) {
    validateValveComponent(component)
    validateHeatExchangerComponent(component, links)
    validateAccumulatorComponent(component, links)
    validateContainmentComponent(component, links)
  }
}

export const compilePlantGraph = (
  input: unknown,
  registry: ReadonlyMap<ComponentKind, ComponentDefinition>,
): CompiledPlantGraph => {
  const spec = plantGraphSpecSchema.parse(input)
  assertUnique(spec.components, component => component.id, 'component id')
  assertUnique(spec.connections, connection => connection.id, 'connection id')
  assertUnique(spec.publishedVariables, path => path, 'published variable')

  const componentIndexById = new Map<ComponentId, number>()
  const definitions = new Map<ComponentId, ComponentDefinition>()
  const portDefinitions = new Map<ComponentId, Readonly<Record<string, PortDefinition>>>()
  const components: CompiledComponent[] = spec.components.map((component, index) => {
    const definition = resolveDefinition(registry, component.kind)
    assertComponentVariableOverridesValid(component.id, definition, component.variables)
    const overrideByPath = new Map(component.variables.map(override => [override.path, override]))
    const parameters = parseWithContext(definition.parametersSchema, component.parameters, `component ${component.id} parameters`)
    const ports = resolveComponentPorts(component.id, definition, component, parameters)
    componentIndexById.set(component.id, index)
    definitions.set(component.id, definition)
    portDefinitions.set(component.id, ports)
    const variables = definition.variables.map(variable => applyComponentVariableOverride({
      ...variable,
      path: variablePathFor(component.id, variable.path),
    }, overrideByPath.get(variable.path)))
    const compiled: CompiledComponent = {
      index,
      id: component.id,
      kind: component.kind,
      label: component.label,
      parameters,
      ...(component.metadata === undefined ? {} : { metadata: component.metadata }),
      ports: compilePorts({ ...definition, ports }),
      variables,
      semantics: compileComponentSemantics(component.id, definition.semantics(parameters), variables, ports, parameters),
    }
    return compiled
  })

  const linksByKind = emptyLinksByKind()
  const incomingLinksByComponent: number[][] = spec.components.map(() => [])
  const outgoingLinksByComponent: number[][] = spec.components.map(() => [])
  const mutableLinksByService = new Map<ConnectionService, number[]>()
  const links: CompiledProcessLink[] = spec.connections.map((connection, index) => {
    const from = parsePortRef(connection.from)
    const to = parsePortRef(connection.to)
    const fromComponentIndex = componentIndexById.get(from.componentId)
    const toComponentIndex = componentIndexById.get(to.componentId)
    if (fromComponentIndex === undefined) throw new Error(`connection ${connection.id} references unknown component: ${from.componentId}`)
    if (toComponentIndex === undefined) throw new Error(`connection ${connection.id} references unknown component: ${to.componentId}`)
    const fromDefinition = definitions.get(from.componentId)
    const toDefinition = definitions.get(to.componentId)
    if (!fromDefinition || !toDefinition) throw new Error(`connection ${connection.id} failed to resolve component definitions`)
    const fromPorts = portDefinitions.get(from.componentId)
    const toPorts = portDefinitions.get(to.componentId)
    if (!fromPorts || !toPorts) throw new Error(`connection ${connection.id} failed to resolve component ports`)
    const fromPort = fromPorts[from.portName]
    const toPort = toPorts[to.portName]
    if (!fromPort) throw new Error(`connection ${connection.id} references unknown port: ${from.componentId}.${from.portName}`)
    if (!toPort) throw new Error(`connection ${connection.id} references unknown port: ${to.componentId}.${to.portName}`)
    if (!compatiblePortKinds(fromPort, toPort)) throw new Error(`connection ${connection.id} has incompatible port kinds: ${fromPort.kind} -> ${toPort.kind}`)
    if (!directionAllowsConnection(fromPort, toPort)) throw new Error(`connection ${connection.id} has invalid port directions: ${fromPort.direction} -> ${toPort.direction}`)
    const inferredKind = inferConnectionKind(fromPort, toPort)
    const kind = connection.connectionKind
    if (kind !== inferredKind) {
      throw new Error(`connection ${connection.id} declares connection kind ${kind} but port kinds require ${inferredKind}`)
    }
    const compiled: CompiledProcessLink = {
      index,
      id: connection.id,
      kind,
      fromComponentIndex,
      fromPortIndex: components[fromComponentIndex]?.ports[from.portName]?.index ?? -1,
      fromPortName: from.portName as PortName,
      toComponentIndex,
      toPortIndex: components[toComponentIndex]?.ports[to.portName]?.index ?? -1,
      toPortName: to.portName as PortName,
      ...(connection.service === undefined ? {} : { service: connection.service }),
      ...(connection.nominalFluid === undefined ? {} : { nominalFluid: connection.nominalFluid }),
      ...(connection.designPhase === undefined ? {} : { designPhase: connection.designPhase }),
      ...(connection.solverModel === undefined ? {} : { solverModel: connection.solverModel }),
      ...(connection.physical === undefined ? {} : { physical: connection.physical }),
      ...(connection.metadata === undefined ? {} : { metadata: connection.metadata }),
      variables: connection.variables.map(variable => ({
        ...variable,
        ...linkVariableSemanticsFor(variable.path),
        path: processLinkVariablePathFor(connection.id, variable.path),
      })),
    }
    linksByKind[kind].push(index)
    incomingLinksByComponent[toComponentIndex]?.push(index)
    outgoingLinksByComponent[fromComponentIndex]?.push(index)
    if (connection.service !== undefined) {
      const serviceLinks = mutableLinksByService.get(connection.service) ?? []
      serviceLinks.push(index)
      mutableLinksByService.set(connection.service, serviceLinks)
    }
    return compiled
  })
  const published = new Set(spec.publishedVariables)
  const componentVariables: CompiledVariable[] = components.flatMap(component =>
    component.variables.map(descriptor => ({
      path: descriptor.path,
      owner: { type: 'component' as const, componentIndex: component.index },
      descriptor,
      published: published.has(descriptor.path),
    })),
  )
  const linkVariables: CompiledVariable[] = links.flatMap(link =>
    link.variables.map(descriptor => {
      const source = spec.connections[link.index]?.variables.find(variable => processLinkVariablePathFor(link.id, variable.path) === descriptor.path)
      if (!source) throw new Error(`connection ${link.id} failed to resolve variable ${descriptor.path}`)
      return {
        path: descriptor.path,
        owner: { type: 'link' as const, linkIndex: link.index },
        descriptor,
        published: published.has(descriptor.path),
        initialValue: source.initialValue,
      }
    }),
  )
  const variables = [...componentVariables, ...linkVariables]
  assertUnique(variables, variable => variable.path, 'variable path')
  assertUniqueDefined(variables, variable => variable.descriptor.tagId, 'process signal tag id')
  validateSignalMetadata(variables)
  assertVariableSemantics(variables)
  assertNamesUnambiguous(components, variables)
  validateValveControllerBindings(components, variables)
  validateProcessLinkContracts(links)
  validateStrongComponentContracts(components, links)
  const availableVariablePaths = new Set(variables.map(variable => variable.path))
  for (const path of published) {
    if (!availableVariablePaths.has(path)) throw new Error(`published variable does not exist: ${path}`)
  }

  const signalBindings = variables.map(signalBindingFor)
  const signalBindingByPath = new Map(signalBindings.map(binding => [binding.path, binding]))
  const signalBindingByTagId = new Map<ProcessSignalTagId, ProcessSignalBinding>()
  const signalBindingByExternalRef = new Map<string, ProcessSignalBinding>()
  for (const binding of signalBindings) {
    if (binding.tagId !== undefined) signalBindingByTagId.set(binding.tagId, binding)
    for (const externalRef of binding.externalRefs ?? []) {
      const existing = signalBindingByExternalRef.get(externalRef)
      if (existing !== undefined) throw new Error(`duplicate process signal external ref: ${externalRef}`)
      signalBindingByExternalRef.set(externalRef, binding)
    }
  }

  return {
    specId: spec.id,
    title: spec.title,
    timestep: spec.timestep,
    components,
    componentIndexById,
    links,
    linksByKind,
    incomingLinksByComponent,
    outgoingLinksByComponent,
    linksByService: new Map([...mutableLinksByService.entries()].map(([service, indexes]) => [service, [...indexes]])),
    variables,
    signalBindings,
    signalBindingByPath,
    signalBindingByTagId,
    signalBindingByExternalRef,
  }
}
