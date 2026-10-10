import { z } from 'zod'
import { idSchema } from '../../../core/model/index.ts'
import { defineComponent, headerVariables, valveVariables } from './component-definition-helpers.ts'
import { type ComponentDefinition, type ComponentKind, type PortDefinition, variablePathSchema } from './model.ts'
import { aspect, fixedSemantics, type ComponentSemantics, type EquipmentFunction } from './semantics.ts'

const headerPortIdsSchema = z.array(idSchema).min(1).max(128)

const headerPortIdsFrom = (parameters: unknown): ReadonlyArray<string> => {
  const parsed = z.object({
    portIds: headerPortIdsSchema.optional(),
  }).passthrough().parse(parameters)
  return parsed.portIds ?? []
}

// Every port of a header joins the same manifold.
const headerPortsFor = (portIds: ReadonlyArray<string>, kind: PortDefinition['kind']): Readonly<Record<string, PortDefinition>> =>
  Object.fromEntries(portIds.flatMap(portId => [
    [`inlet${portId}`, { kind, direction: 'in' as const, circuit: 'flow' }],
    [`outlet${portId}`, { kind, direction: 'out' as const, circuit: 'flow' }],
  ]))

// The valve behaviour treats a valve without a mode as a control valve.
const valveFunctions: Readonly<Record<string, EquipmentFunction>> = {
  control: 'modulating',
  throttle: 'modulating',
  bypass: 'modulating',
  isolation: 'isolating',
  check: 'nonReturn',
  relief: 'relieving',
  safety: 'relieving',
}

const valveSemantics = (parameters: unknown): ComponentSemantics => {
  const mode = z.object({ valveMode: z.string().default('control') }).passthrough().parse(parameters).valveMode
  const valveFunction = valveFunctions[mode]
  if (valveFunction === undefined) throw new Error(`valve mode ${mode} has no declared function`)
  return {
    function: valveFunction,
    aspects: [aspect('position', { variable: 'effectivePositionFraction', reading: 'value' }, 'positionFraction')],
    embedded: [],
    ratedOutflow: [],
    portFlows: [],
    keyValues: [],
    meaningfulWhile: [],
    energy: [],
  }
}

const valvePositionControllerSchema = z.object({
  kind: z.literal('proportionalPosition'),
  measuredPath: variablePathSchema,
  setpoint: z.number().finite(),
  biasPositionFraction: z.number().finite().min(0).max(1),
  gainPerUnit: z.number().finite().nonnegative(),
  direction: z.enum(['direct', 'reverse']).default('reverse'),
  deadband: z.number().finite().nonnegative().optional(),
  minPositionFraction: z.number().finite().min(0).max(1).optional(),
  maxPositionFraction: z.number().finite().min(0).max(1).optional(),
  timeConstantS: z.number().finite().positive().optional(),
}).strict().superRefine((controller, ctx) => {
  if (
    controller.minPositionFraction !== undefined
    && controller.maxPositionFraction !== undefined
    && controller.minPositionFraction > controller.maxPositionFraction
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['minPositionFraction'],
      message: 'valve controller minPositionFraction cannot exceed maxPositionFraction',
    })
  }
})

export const junctionComponentDefinitions: ReadonlyArray<ComponentDefinition> = [
  defineComponent({
    kind: 'processHeader' as ComponentKind,
    label: 'Process Header',
    ports: {
      inletA: { kind: 'hydraulicThermal', direction: 'in', circuit: 'flow' },
      inletB: { kind: 'hydraulicThermal', direction: 'in', circuit: 'flow' },
      inletC: { kind: 'hydraulicThermal', direction: 'in', circuit: 'flow' },
      inletD: { kind: 'hydraulicThermal', direction: 'in', circuit: 'flow' },
      inletE: { kind: 'hydraulicThermal', direction: 'in', circuit: 'flow' },
      inletF: { kind: 'hydraulicThermal', direction: 'in', circuit: 'flow' },
      outletA: { kind: 'hydraulicThermal', direction: 'out', circuit: 'flow' },
      outletB: { kind: 'hydraulicThermal', direction: 'out', circuit: 'flow' },
      outletC: { kind: 'hydraulicThermal', direction: 'out', circuit: 'flow' },
      outletD: { kind: 'hydraulicThermal', direction: 'out', circuit: 'flow' },
      outletE: { kind: 'hydraulicThermal', direction: 'out', circuit: 'flow' },
      outletF: { kind: 'hydraulicThermal', direction: 'out', circuit: 'flow' },
    },
    parametersSchema: z.object({
      initialTemperatureC: z.number().finite().optional(),
      initialPressureMPa: z.number().finite().positive().optional(),
      headerVolumeM3: z.number().finite().positive().optional(),
      nominalDensityKgPerM3: z.number().finite().positive().optional(),
      mixingTimeConstantS: z.number().finite().positive().optional(),
      pressureTimeConstantS: z.number().finite().positive().optional(),
      distributionMode: z.enum(['demandWeighted', 'pressureWeighted']).optional(),
      portIds: headerPortIdsSchema.optional(),
    }).strict(),
    resolveAdditionalPorts: ({ parameters }) => headerPortsFor(headerPortIdsFrom(parameters), 'hydraulicThermal'),
    semantics: fixedSemantics({ aspects: [aspect('throughput', { variable: 'outletFlowKgPerS', reading: 'flow' })] }),
    variables: headerVariables('Process header'),
  }),
  defineComponent({
    kind: 'processValve' as ComponentKind,
    label: 'Process Valve',
    ports: {
      inlet: { kind: 'hydraulicThermal', direction: 'in', circuit: 'flow' },
      outlet: { kind: 'hydraulicThermal', direction: 'out', circuit: 'flow' },
      demand: { kind: 'controlSignal', direction: 'in' },
    },
    parametersSchema: z.object({
      initialPositionFraction: z.number().finite().min(0).max(1).optional(),
      strokeTimeConstantS: z.number().finite().positive().optional(),
      strokeOpenTimeS: z.number().finite().positive().optional(),
      strokeCloseTimeS: z.number().finite().positive().optional(),
      valveMode: z.enum(['control', 'isolation', 'check', 'relief', 'safety', 'throttle', 'bypass']).optional(),
      cvKgPerSPerSqrtMPa: z.number().finite().nonnegative().optional(),
      failPositionFraction: z.number().finite().min(0).max(1).optional(),
      leakageFractionClosed: z.number().finite().min(0).max(1).optional(),
      reverseFlowAllowed: z.boolean().optional(),
      setpointMPa: z.number().finite().positive().optional(),
      reseatMPa: z.number().finite().positive().optional(),
      controller: valvePositionControllerSchema.optional(),
    }).strict(),
    semantics: valveSemantics,
    variables: valveVariables('Process valve'),
  }),
  defineComponent({
    kind: 'steamHeader' as ComponentKind,
    label: 'Steam Header',
    ports: {
      inletA: { kind: 'steam', direction: 'in', circuit: 'flow' },
      inletB: { kind: 'steam', direction: 'in', circuit: 'flow' },
      inletC: { kind: 'steam', direction: 'in', circuit: 'flow' },
      inletD: { kind: 'steam', direction: 'in', circuit: 'flow' },
      inletE: { kind: 'steam', direction: 'in', circuit: 'flow' },
      inletF: { kind: 'steam', direction: 'in', circuit: 'flow' },
      outletA: { kind: 'steam', direction: 'out', circuit: 'flow' },
      outletB: { kind: 'steam', direction: 'out', circuit: 'flow' },
      outletC: { kind: 'steam', direction: 'out', circuit: 'flow' },
      outletD: { kind: 'steam', direction: 'out', circuit: 'flow' },
      outletE: { kind: 'steam', direction: 'out', circuit: 'flow' },
      outletF: { kind: 'steam', direction: 'out', circuit: 'flow' },
    },
    parametersSchema: z.object({
      initialTemperatureC: z.number().finite().optional(),
      initialPressureMPa: z.number().finite().positive().optional(),
      headerVolumeM3: z.number().finite().positive().optional(),
      nominalDensityKgPerM3: z.number().finite().positive().optional(),
      mixingTimeConstantS: z.number().finite().positive().optional(),
      pressureTimeConstantS: z.number().finite().positive().optional(),
      distributionMode: z.enum(['demandWeighted', 'pressureWeighted']).optional(),
      portIds: headerPortIdsSchema.optional(),
    }).strict(),
    resolveAdditionalPorts: ({ parameters }) => headerPortsFor(headerPortIdsFrom(parameters), 'steam'),
    semantics: fixedSemantics({ aspects: [aspect('throughput', { variable: 'outletFlowKgPerS', reading: 'flow' })] }),
    variables: headerVariables('Steam header'),
  }),
  defineComponent({
    kind: 'steamValve' as ComponentKind,
    label: 'Steam Valve',
    ports: {
      inlet: { kind: 'steam', direction: 'in', circuit: 'flow' },
      outlet: { kind: 'steam', direction: 'out', circuit: 'flow' },
      demand: { kind: 'controlSignal', direction: 'in' },
    },
    parametersSchema: z.object({
      initialPositionFraction: z.number().finite().min(0).max(1).optional(),
      strokeTimeConstantS: z.number().finite().positive().optional(),
      strokeOpenTimeS: z.number().finite().positive().optional(),
      strokeCloseTimeS: z.number().finite().positive().optional(),
      valveMode: z.enum(['control', 'isolation', 'check', 'relief', 'safety', 'throttle', 'bypass']).optional(),
      cvKgPerSPerSqrtMPa: z.number().finite().nonnegative().optional(),
      failPositionFraction: z.number().finite().min(0).max(1).optional(),
      leakageFractionClosed: z.number().finite().min(0).max(1).optional(),
      reverseFlowAllowed: z.boolean().optional(),
      setpointMPa: z.number().finite().positive().optional(),
      reseatMPa: z.number().finite().positive().optional(),
      controller: valvePositionControllerSchema.optional(),
    }).strict(),
    semantics: valveSemantics,
    variables: valveVariables('Steam valve'),
  }),
]
