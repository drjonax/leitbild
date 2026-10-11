import type { CompiledComponent, CompiledProcessLink, VariablePath } from '../../../graph/index.ts'
import { componentVariablePath, processLinkVariablePath, type ComponentBehaviorDefinition, type ComponentInitialReconciliationDefinition } from '../../behavior-contract.ts'
import {
  firstFluidService,
  fluidLinksForService,
  incomingComponentLinks,
  outgoingComponentLinks,
  sumProcessLinkValue,
} from '../../component-link-helpers.ts'
import { clamp, optionalParameterNumber, optionalParameterString, relaxToward } from '../../component-helpers.ts'

type ValveMode = 'control' | 'isolation' | 'check' | 'relief' | 'safety' | 'throttle' | 'bypass'
type ValvePositionControllerDirection = 'direct' | 'reverse'

interface ValvePositionController {
  readonly kind: 'proportionalPosition'
  readonly measuredPath: VariablePath
  readonly setpoint: number
  readonly biasPositionFraction: number
  readonly gainPerUnit: number
  readonly direction: ValvePositionControllerDirection
  readonly deadband: number
  readonly minPositionFraction: number
  readonly maxPositionFraction: number
  readonly timeConstantS: number
  readonly permissive: { readonly path: VariablePath; readonly minimum: number } | null
}

const valveModes: ReadonlySet<ValveMode> = new Set(['control', 'isolation', 'check', 'relief', 'safety', 'throttle', 'bypass'])
const valveControllerByComponent = new WeakMap<CompiledComponent, ValvePositionController | null>()

const valvePositionControllerFor = (component: CompiledComponent): ValvePositionController | null => {
  const cached = valveControllerByComponent.get(component)
  if (cached !== undefined) return cached
  const parameters = component.parameters
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
    valveControllerByComponent.set(component, null)
    return null
  }
  const controller = (parameters as Record<string, unknown>).controller
  if (controller === undefined) {
    valveControllerByComponent.set(component, null)
    return null
  }
  if (!controller || typeof controller !== 'object' || Array.isArray(controller)) {
    throw new Error(`component ${component.id} valve controller must be an object`)
  }
  const config = controller as Record<string, unknown>
  if (config.kind !== 'proportionalPosition') {
    throw new Error(`component ${component.id} valve controller kind must be proportionalPosition`)
  }
  if (typeof config.measuredPath !== 'string') throw new Error(`component ${component.id} valve controller measuredPath must be a variable path`)
  if (typeof config.setpoint !== 'number' || !Number.isFinite(config.setpoint)) throw new Error(`component ${component.id} valve controller setpoint must be numeric`)
  if (typeof config.biasPositionFraction !== 'number' || !Number.isFinite(config.biasPositionFraction)) throw new Error(`component ${component.id} valve controller biasPositionFraction must be numeric`)
  if (typeof config.gainPerUnit !== 'number' || !Number.isFinite(config.gainPerUnit)) throw new Error(`component ${component.id} valve controller gainPerUnit must be numeric`)
  const direction = config.direction ?? 'reverse'
  if (direction !== 'direct' && direction !== 'reverse') throw new Error(`component ${component.id} valve controller direction must be direct or reverse`)
  const minPositionFraction = typeof config.minPositionFraction === 'number' ? config.minPositionFraction : 0
  const maxPositionFraction = typeof config.maxPositionFraction === 'number' ? config.maxPositionFraction : 1
  const parsed: ValvePositionController = {
    kind: 'proportionalPosition',
    measuredPath: config.measuredPath as VariablePath,
    setpoint: config.setpoint,
    biasPositionFraction: clamp(config.biasPositionFraction, 0, 1),
    gainPerUnit: Math.max(0, config.gainPerUnit),
    direction,
    deadband: typeof config.deadband === 'number' && Number.isFinite(config.deadband) ? Math.max(0, config.deadband) : 0,
    minPositionFraction: clamp(minPositionFraction, 0, 1),
    maxPositionFraction: clamp(maxPositionFraction, 0, 1),
    timeConstantS: typeof config.timeConstantS === 'number' && Number.isFinite(config.timeConstantS) ? Math.max(1e-9, config.timeConstantS) : 1,
    permissive: permissiveFor(component, config.permissive),
  }
  valveControllerByComponent.set(component, parsed)
  return parsed
}

const permissiveFor = (component: CompiledComponent, value: unknown): ValvePositionController['permissive'] => {
  if (value === undefined) return null
  const permissive = value as Record<string, unknown>
  if (typeof permissive.path !== 'string' || typeof permissive.minimum !== 'number' || !Number.isFinite(permissive.minimum)) {
    throw new Error(`component ${component.id} valve controller permissive needs a variable path and a numeric minimum`)
  }
  return { path: permissive.path as VariablePath, minimum: permissive.minimum }
}

const deadbandedError = (error: number, deadband: number): number => {
  if (Math.abs(error) <= deadband) return 0
  return error - Math.sign(error) * deadband
}

const maxLinkValue = (
  links: ReadonlyArray<CompiledProcessLink>,
  localPath: string,
  context: Parameters<ComponentBehaviorDefinition['update']>[0]['context'],
): number | null => {
  let value: number | null = null
  for (const link of links) {
    const path = processLinkVariablePath(link, localPath)
    if (!context.has(path)) continue
    const current = context.readNumber(path)
    value = value === null ? current : Math.max(value, current)
  }
  return value
}

const minLinkValue = (
  links: ReadonlyArray<CompiledProcessLink>,
  localPath: string,
  context: Parameters<ComponentBehaviorDefinition['update']>[0]['context'],
): number | null => {
  let value: number | null = null
  for (const link of links) {
    const path = processLinkVariablePath(link, localPath)
    if (!context.has(path)) continue
    const current = context.readNumber(path)
    value = value === null ? current : Math.min(value, current)
  }
  return value
}

const updateValveFlowDiagnostics = (
  input: Parameters<ComponentBehaviorDefinition['update']>[0],
): void => {
  const { system, component, context } = input
  const incomingLinks = incomingComponentLinks(system, component)
  const outgoingLinks = outgoingComponentLinks(system, component)
  const service = firstFluidService([...incomingLinks, ...outgoingLinks])
  const matchingIncoming = fluidLinksForService(incomingLinks, service)
  const matchingOutgoing = fluidLinksForService(outgoingLinks, service)
  const inletFlow = sumProcessLinkValue(matchingIncoming, 'flowKgPerS', context)
  const outletFlow = sumProcessLinkValue(matchingOutgoing, 'flowKgPerS', context)
  const upstreamPressure = maxLinkValue(matchingIncoming, 'pressureMPa', context) ?? optionalParameterNumber(component, 'initialPressureMPa', component.kind === 'steamValve' ? 6.9 : 1)
  const downstreamPressure = minLinkValue(matchingOutgoing, 'pressureMPa', context) ?? upstreamPressure
  const pressureDrop = Math.max(0, upstreamPressure - downstreamPressure)
  const effectivePosition = clamp(context.readNumber(componentVariablePath(component, 'effectivePositionFraction')), 0, 1)
  const cv = optionalParameterNumber(component, 'cvKgPerSPerSqrtMPa', Number.POSITIVE_INFINITY)
  const capacityLimitedFlow = Number.isFinite(cv) ? cv * Math.sqrt(pressureDrop) * effectivePosition : outletFlow
  const leakageFraction = optionalParameterNumber(component, 'leakageFractionClosed', 0)
  const leakageFlow = inletFlow * leakageFraction * (1 - effectivePosition)
  const reverseFlowAllowed = optionalParameterString(component, 'valveMode', 'control', valveModes) !== 'check'
    && Boolean((component.parameters as Record<string, unknown>).reverseFlowAllowed ?? true)
  const reverseFlow = reverseFlowAllowed ? Math.max(0, outletFlow - inletFlow) : 0
  context.write(componentVariablePath(component, 'inletFlowKgPerS'), inletFlow)
  context.write(componentVariablePath(component, 'outletFlowKgPerS'), outletFlow)
  context.write(componentVariablePath(component, 'flowBalanceResidualKgPerS'), inletFlow - outletFlow)
  context.write(componentVariablePath(component, 'availablePressureDropMPa'), pressureDrop)
  context.write(componentVariablePath(component, 'capacityLimitedFlowKgPerS'), capacityLimitedFlow)
  context.write(componentVariablePath(component, 'leakageFlowKgPerS'), leakageFlow)
  context.write(componentVariablePath(component, 'reverseFlowKgPerS'), reverseFlow)
}

const updateValvePositionController = (
  input: Parameters<ComponentBehaviorDefinition['update']>[0],
): void => {
  const { component, context } = input
  const controller = valvePositionControllerFor(component)
  if (controller === null) return
  const positionPath = componentVariablePath(component, 'positionFraction')
  // Under an isolation signal the controller yields: it demands the valve shut until the signal is released.
  if (context.readBoolean(componentVariablePath(component, 'isolationSignal'))) {
    context.write(positionPath, 0)
    return
  }
  const measured = context.readNumber(controller.measuredPath)
  const error = deadbandedError(measured - controller.setpoint, controller.deadband)
  const action = controller.direction === 'direct' ? error : -error
  // Without its permissive the controller holds the valve at its minimum.
  const permitted = controller.permissive === null || context.readNumber(controller.permissive.path) >= controller.permissive.minimum
  const target = permitted
    ? clamp(controller.biasPositionFraction + controller.gainPerUnit * action, controller.minPositionFraction, controller.maxPositionFraction)
    : controller.minPositionFraction
  context.write(
    positionPath,
    relaxToward(context.readNumber(positionPath), target, context.dtSeconds, controller.timeConstantS),
  )
}

const valveControlBehavior = (componentKind: 'processValve' | 'steamValve'): ComponentBehaviorDefinition => ({
  id: `${componentKind}-effective-position`,
  phase: 'solveFluidFlowComponents',
  componentKind,
  reads: ['positionFraction', 'positionFailureActive', 'failedPositionFraction', 'isolationSignal', 'incoming:pressureMPa', 'availablePressureDropMPa', 'autoOpenActive'],
  writes: ['demandPositionFraction', 'effectivePositionFraction', 'autoOpenActive'],
  update: ({ system, component, context }): void => {
    // An isolation signal shuts the valve whatever its demand; a failed actuator or a self-acting relief still decides.
    const manualTarget = context.readBoolean(componentVariablePath(component, 'isolationSignal'))
      ? 0
      : clamp(context.readNumber(componentVariablePath(component, 'positionFraction')), 0, 1)
    const failureActive = context.readBoolean(componentVariablePath(component, 'positionFailureActive'))
    const failedPosition = clamp(context.readNumber(componentVariablePath(component, 'failedPositionFraction')), 0, 1)
    const mode = optionalParameterString(component, 'valveMode', 'control', valveModes)
    const incomingLinks = incomingComponentLinks(system, component)
    const upstreamPressure = maxLinkValue(
      fluidLinksForService(incomingLinks, firstFluidService(incomingLinks)),
      'pressureMPa',
      context,
    )
    const pressureDrop = context.has(componentVariablePath(component, 'availablePressureDropMPa'))
      ? context.readNumber(componentVariablePath(component, 'availablePressureDropMPa'))
      : 0
    const setpoint = optionalParameterNumber(component, 'setpointMPa', Number.POSITIVE_INFINITY)
    const reseat = optionalParameterNumber(component, 'reseatMPa', setpoint * 0.98)
    const wasAutoOpen = context.readBoolean(componentVariablePath(component, 'autoOpenActive'))
    const automaticPressure = upstreamPressure ?? pressureDrop
    const autoOpen = (mode === 'relief' || mode === 'safety') && (automaticPressure >= setpoint || (wasAutoOpen && automaticPressure > reseat))
    const target = failureActive ? failedPosition : autoOpen ? 1 : manualTarget
    const current = context.readNumber(componentVariablePath(component, 'effectivePositionFraction'))
    const timeConstant = target >= current
      ? optionalParameterNumber(component, 'strokeOpenTimeS', optionalParameterNumber(component, 'strokeTimeConstantS', 0.1))
      : optionalParameterNumber(component, 'strokeCloseTimeS', optionalParameterNumber(component, 'strokeTimeConstantS', 0.1))
    const nextPosition = relaxToward(current, target, context.dtSeconds, timeConstant)
    const minimumPosition = optionalParameterNumber(component, 'leakageFractionClosed', 0)
    context.write(
      componentVariablePath(component, 'effectivePositionFraction'),
      clamp(Math.max(nextPosition, minimumPosition), 0, 1),
    )
    context.write(componentVariablePath(component, 'demandPositionFraction'), target)
    context.write(componentVariablePath(component, 'autoOpenActive'), autoOpen)
  },
})

const valvePositionControllerBehavior = (componentKind: 'processValve' | 'steamValve'): ComponentBehaviorDefinition => ({
  id: `${componentKind}-position-controller`,
  phase: 'updateControlLogic',
  componentKind,
  reads: ['positionFraction', 'isolationSignal', 'controller.measuredPath', 'controller.permissive.path?'],
  writes: ['positionFraction'],
  update: updateValvePositionController,
})

const valveDiagnosticsBehavior = (componentKind: 'processValve' | 'steamValve'): ComponentBehaviorDefinition => ({
  id: `${componentKind}-flow-diagnostics`,
  phase: 'updateComponentState',
  componentKind,
  reads: ['incoming:flowKgPerS', 'outgoing:flowKgPerS', 'incoming:pressureMPa', 'outgoing:pressureMPa', 'effectivePositionFraction'],
  writes: ['inletFlowKgPerS', 'outletFlowKgPerS', 'flowBalanceResidualKgPerS', 'availablePressureDropMPa', 'capacityLimitedFlowKgPerS', 'reverseFlowKgPerS', 'leakageFlowKgPerS'],
  update: updateValveFlowDiagnostics,
})

const valveDiagnosticsReconciliation = (componentKind: 'processValve' | 'steamValve'): ComponentInitialReconciliationDefinition => ({
  id: `${componentKind}-initial-flow-diagnostics`,
  componentKind,
  afterLinks: true,
  reads: valveDiagnosticsBehavior(componentKind).reads,
  writes: valveDiagnosticsBehavior(componentKind).writes,
  reconcile: updateValveFlowDiagnostics,
})

export const valveInitialReconciliationDefinitions: ReadonlyArray<ComponentInitialReconciliationDefinition> = [
  valveDiagnosticsReconciliation('processValve'),
  valveDiagnosticsReconciliation('steamValve'),
]

export const valveBehaviorDefinitions: ReadonlyArray<ComponentBehaviorDefinition> = [
  valvePositionControllerBehavior('processValve'),
  valvePositionControllerBehavior('steamValve'),
  valveControlBehavior('processValve'),
  valveControlBehavior('steamValve'),
  valveDiagnosticsBehavior('processValve'),
  valveDiagnosticsBehavior('steamValve'),
]
