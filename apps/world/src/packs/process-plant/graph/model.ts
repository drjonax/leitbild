import { z } from 'zod'
import type { Brand } from '../../../core/model/index.ts'
import { idSchema } from '../../../core/model/index.ts'
import {
  ratioMeasurandSchema,
  variableActuationSchema,
  type CompiledComponentSemantics,
  type ComponentSemantics,
  type RatioMeasurand,
  type VariableActuation,
} from './semantics.ts'

export type PlantGraphId = Brand<string, 'PlantGraphId'>
export type ComponentId = Brand<string, 'ProcessPlantComponentId'>
export type ComponentKind = Brand<string, 'ProcessPlantComponentKind'>
export type ConnectionId = Brand<string, 'ProcessPlantConnectionId'>
export type PortName = Brand<string, 'ProcessPlantPortName'>
export type PortRef = Brand<string, 'ProcessPlantPortRef'>
export type LocalVariablePath = Brand<string, 'ProcessPlantLocalVariablePath'>
export type VariablePath = Brand<string, 'ProcessPlantVariablePath'>
export type ConnectionService = Brand<string, 'ProcessPlantConnectionService'>
export type ProcessSignalTagId = Brand<string, 'ProcessPlantSignalTagId'>
export type ProcessEquipmentId = Brand<string, 'ProcessPlantEquipmentId'>
export type ProcessVariableValue = number | boolean

export const plantGraphIdSchema = idSchema.transform(value => value as PlantGraphId)
export const componentIdSchema = idSchema.transform(value => value as ComponentId)
export const componentKindSchema = idSchema.transform(value => value as ComponentKind)
export const connectionIdSchema = idSchema.transform(value => value as ConnectionId)
export const portNameSchema = idSchema.transform(value => value as PortName)
export const portRefSchema = z.string()
  .min(3)
  .max(256)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*\.[a-zA-Z0-9][a-zA-Z0-9._:-]*$/)
  .transform(value => value as PortRef)
export const variablePathSchema = z.string()
  .min(3)
  .max(256)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*(\.[a-zA-Z0-9][a-zA-Z0-9._:-]*)+$/)
  .transform(value => value as VariablePath)
export const localVariablePathSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/)
  .transform(value => value as LocalVariablePath)
export const processSignalTagIdSchema = idSchema.transform(value => value as ProcessSignalTagId)
export const processEquipmentIdSchema = idSchema.transform(value => value as ProcessEquipmentId)

export const portKindSchema = z.enum([
  'hydraulic',
  'thermal',
  'hydraulicThermal',
  'steam',
  'electricalAc',
  'mechanicalShaft',
  'controlSignal',
  'logicSignal',
])
export type PortKind = z.infer<typeof portKindSchema>

export const portDirectionSchema = z.enum(['in', 'out', 'bidirectional'])
export type PortDirection = z.infer<typeof portDirectionSchema>

export const connectionKindSchema = z.enum([
  'fluidFlow',
  'thermalContact',
  'electricalPower',
  'mechanicalTorque',
  'controlSignal',
  'logicSignal',
])
export type ConnectionKind = z.infer<typeof connectionKindSchema>

export const fluidKindSchema = z.enum(['water', 'steam', 'air', 'oil', 'generic'])
export type FluidKind = z.infer<typeof fluidKindSchema>

export const designPhaseSchema = z.enum(['liquid', 'steam', 'gas', 'twoPhase'])
export type DesignPhase = z.infer<typeof designPhaseSchema>

export const fluidSolverModelSchema = z.enum(['incompressibleLiquid', 'compressibleSteam', 'twoPhaseApprox', 'sourceSink'])
export type FluidSolverModel = z.infer<typeof fluidSolverModelSchema>

export const connectionServiceSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/)
  .transform(value => value as ConnectionService)

export const variableKindSchema = z.enum(['state', 'derived', 'control', 'parameter', 'alarm', 'discrete'])
export type VariableKind = z.infer<typeof variableKindSchema>

export const variableDisciplineSchema = z.enum(['hydraulic', 'thermal', 'nuclear', 'electrical', 'control', 'operator', 'radiological', 'chemical'])
export type VariableDiscipline = z.infer<typeof variableDisciplineSchema>

export const variablePublishPolicySchema = z.enum(['internal', 'telemetry', 'alarm', 'leitbild'])
export type VariablePublishPolicy = z.infer<typeof variablePublishPolicySchema>

export const processVariableCapabilitySchema = z.object({
  readable: z.boolean().optional(),
  writable: z.boolean().optional(),
  trendable: z.boolean().optional(),
  alarmable: z.boolean().optional(),
  operatorFacing: z.boolean().optional(),
  aiVisible: z.boolean().optional(),
  procedureRelevant: z.boolean().optional(),
}).strict()
export type ProcessVariableCapability = z.infer<typeof processVariableCapabilitySchema>

export const numericRangeSchema = z.object({
  min: z.number().finite(),
  max: z.number().finite(),
}).strict().superRefine((range, ctx) => {
  if (range.min > range.max) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['min'],
      message: 'range min cannot exceed max',
    })
  }
})
export type NumericRange = z.infer<typeof numericRangeSchema>

export const processVariableAlarmLimitSchema = z.object({
  low: z.number().finite().optional(),
  lowLow: z.number().finite().optional(),
  high: z.number().finite().optional(),
  highHigh: z.number().finite().optional(),
}).strict().superRefine((limits, ctx) => {
  const ordered = [
    ['lowLow', limits.lowLow],
    ['low', limits.low],
    ['high', limits.high],
    ['highHigh', limits.highHigh],
  ] as const
  const present = ordered.filter((entry): entry is readonly [typeof entry[0], number] => entry[1] !== undefined)
  for (let index = 1; index < present.length; index += 1) {
    const previous = present[index - 1]
    const current = present[index]
    if (!previous || !current) continue
    if (previous[1] > current[1]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [current[0]],
        message: 'alarm limits must be ordered lowLow <= low <= high <= highHigh',
      })
      return
    }
  }
})
export type ProcessVariableAlarmLimit = z.infer<typeof processVariableAlarmLimitSchema>

export const processVariableLimitsSchema = z.object({
  normalRange: numericRangeSchema.optional(),
  operatingRange: numericRangeSchema.optional(),
  hardRange: numericRangeSchema.optional(),
  /**
   * The span an instrument indicates over: its indication saturates at
   * either end, so a reading there says only that the measured quantity is
   * at or beyond that end (a narrow-range level at 0 % may be far below it).
   */
  instrumentSpan: numericRangeSchema.optional(),
  alarmLimits: processVariableAlarmLimitSchema.optional(),
}).strict()
export type ProcessVariableLimits = z.infer<typeof processVariableLimitsSchema>

export const processQuantitySchema = z.enum([
  'boolean',
  'concentration',
  'count',
  'countRate',
  'electricalCurrent',
  'energy',
  'energyPerMass',
  'flowRate',
  'flowRateDelta',
  'frequency',
  'head',
  'mass',
  'massDelta',
  'power',
  'powerDelta',
  'pressure',
  'pressureDelta',
  'radiationDoseRate',
  'ratio',
  'reactivity',
  'rotationalSpeed',
  'startupRate',
  'temperatureDelta',
  'temperature',
  'temperatureRate',
  'time',
  'voltage',
  'volume',
])
export type ProcessQuantity = z.infer<typeof processQuantitySchema>

export const processUnitSchema = z.enum([
  'boolean',
  'amps',
  'count',
  'cps',
  'degC',
  'DPM',
  'degC/s',
  'fraction',
  'Hz',
  'kg',
  'kJ/kg',
  'kg/s',
  'kV',
  'kW',
  'MJ',
  'MPa',
  'mSv/h',
  'm3',
  'MW',
  'Pa',
  'pcm',
  'percent',
  'ppm',
  'rpm',
  's',
  'volts_dc',
])
export type ProcessUnit = z.infer<typeof processUnitSchema>

const allowedUnitsByQuantity: Readonly<Record<ProcessQuantity, ReadonlySet<ProcessUnit>>> = {
  boolean: new Set(['boolean']),
  concentration: new Set(['ppm']),
  // A number of steps or items, as a load sequencer's step.
  count: new Set(['count']),
  countRate: new Set(['cps']),
  electricalCurrent: new Set(['amps']),
  energy: new Set(['MJ']),
  energyPerMass: new Set(['kJ/kg']),
  flowRate: new Set(['kg/s']),
  flowRateDelta: new Set(['kg/s']),
  frequency: new Set(['Hz']),
  head: new Set(['Pa']),
  mass: new Set(['kg']),
  massDelta: new Set(['kg']),
  // A power-range nuclear instrument reads percent of rated thermal power.
  // A diesel generator's wattmeter reads kilowatts.
  power: new Set(['MW', 'kW', 'percent']),
  powerDelta: new Set(['MW']),
  pressure: new Set(['MPa', 'Pa']),
  pressureDelta: new Set(['MPa', 'Pa']),
  radiationDoseRate: new Set(['mSv/h']),
  ratio: new Set(['fraction', 'percent']),
  reactivity: new Set(['pcm']),
  rotationalSpeed: new Set(['rpm']),
  // Decades per minute: how fast neutron flux rises or falls.
  startupRate: new Set(['DPM']),
  temperature: new Set(['degC']),
  temperatureDelta: new Set(['degC']),
  temperatureRate: new Set(['degC/s']),
  time: new Set(['s']),
  // AC buses and generators read kilovolts, the station batteries volts DC.
  voltage: new Set(['kV', 'volts_dc']),
  volume: new Set(['m3']),
}

export const processVariableValueSchema = z.union([z.number().finite(), z.boolean()])

export const portDefinitionSchema = z.object({
  kind: portKindSchema,
  direction: portDirectionSchema,
  /**
   * Ports in the same circuit connect inside the component: flow or power
   * entering one can leave by another. A port in no circuit is a terminal
   * (a pump's power supply, a valve's demand signal).
   */
  circuit: z.string().min(1).optional(),
  /**
   * On a power supply port, the solved power the component draws through it,
   * which the line and the bus feeding it carry. A supply port that names
   * none draws too little to count beside a bus (a valve motor's kilowatts).
   */
  demand: z.string().min(1).optional(),
})
export type PortDefinition = z.infer<typeof portDefinitionSchema>

/**
 * How operators name equipment. Presentation only: it is not part of a Plant's
 * identity, so its digest (and every persisted Run checkpoint) ignores it.
 */
export const processGraphPresentationSchema = z.object({
  /** The operator's short name ("FCV B"). */
  shortLabel: z.string().min(1).max(24).optional(),
  /** Short names of devices the component bundles, by device id ("PORV"). */
  embedded: z.record(idSchema, z.string().min(1).max(24)).optional(),
  /**
   * How operators read its on/off signals that serve no state aspect, by
   * local variable path: "Source-range HV on" and "Source-range HV off",
   * never "Not source-range detector high voltage on".
   */
  states: z.record(z.string().min(1), z.object({ on: z.string().min(1).max(40), off: z.string().min(1).max(40) }).strict()).optional(),
}).strict()
export type ProcessGraphPresentation = z.infer<typeof processGraphPresentationSchema>

export const processGraphMetadataSchema = z.object({
  role: idSchema.optional(),
  groupId: idSchema.optional(),
  loopId: idSchema.optional(),
  trainId: idSchema.optional(),
  ordinal: z.number().int().nonnegative().optional(),
  equipmentClass: idSchema.optional(),
  presentation: processGraphPresentationSchema.optional(),
}).strict()
export type ProcessGraphMetadata = z.infer<typeof processGraphMetadataSchema>

const validateQuantityUnit = (
  descriptor: { readonly quantity: ProcessQuantity; readonly unit: ProcessUnit },
  ctx: z.RefinementCtx,
): void => {
  if (!allowedUnitsByQuantity[descriptor.quantity].has(descriptor.unit)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['unit'],
      message: `unit ${descriptor.unit} is not valid for quantity ${descriptor.quantity}`,
    })
  }
}

const validateInitialValueType = (
  descriptor: { readonly quantity: ProcessQuantity; readonly initialValue: ProcessVariableValue },
  ctx: z.RefinementCtx,
): void => {
  if (descriptor.quantity === 'boolean') {
    if (typeof descriptor.initialValue !== 'boolean') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['initialValue'],
        message: 'boolean quantity requires a boolean initialValue',
      })
    }
    return
  }
  if (typeof descriptor.initialValue !== 'number') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['initialValue'],
      message: `${descriptor.quantity} quantity requires a numeric initialValue`,
    })
  }
}

const validateInitialValueBounds = (
  descriptor: { readonly quantity: ProcessQuantity; readonly unit: ProcessUnit; readonly initialValue: ProcessVariableValue },
  ctx: z.RefinementCtx,
): void => {
  if (typeof descriptor.initialValue !== 'number') return
  if (descriptor.quantity === 'ratio' && descriptor.unit === 'fraction' && (descriptor.initialValue < 0 || descriptor.initialValue > 1)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['initialValue'],
      message: 'fraction initialValue must be between 0 and 1',
    })
  }
  if (descriptor.quantity === 'ratio' && descriptor.unit === 'percent' && (descriptor.initialValue < 0 || descriptor.initialValue > 100)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['initialValue'],
      message: 'percent initialValue must be between 0 and 100',
    })
  }
  if (
    (descriptor.quantity === 'flowRate'
      || descriptor.quantity === 'concentration'
      || descriptor.quantity === 'countRate'
      || descriptor.quantity === 'electricalCurrent'
      || descriptor.quantity === 'head'
      || descriptor.quantity === 'mass'
      || descriptor.quantity === 'power'
      || descriptor.quantity === 'pressure'
      || descriptor.quantity === 'radiationDoseRate'
      || descriptor.quantity === 'rotationalSpeed'
      || descriptor.quantity === 'voltage')
    && descriptor.initialValue < 0
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['initialValue'],
      message: `${descriptor.quantity} initialValue must be non-negative`,
    })
  }
}

const variableDescriptorBaseSchema = z.object({
  path: variablePathSchema,
  label: z.string().min(1),
  kind: variableKindSchema,
  discipline: variableDisciplineSchema,
  writable: z.boolean(),
  publish: variablePublishPolicySchema,
  quantity: processQuantitySchema,
  unit: processUnitSchema,
  tagId: processSignalTagIdSchema.optional(),
  equipmentId: processEquipmentIdSchema.optional(),
  description: z.string().min(1).optional(),
  externalRefs: z.array(z.string().min(1)).optional(),
  capabilities: processVariableCapabilitySchema.optional(),
  limits: processVariableLimitsSchema.optional(),
  /** What writing it does; every writable variable declares one. */
  actuation: variableActuationSchema.optional(),
  /** What a ratio measures; every ratio declares one. */
  measurand: ratioMeasurandSchema.optional(),
  /**
   * A value the model solves that no instrument in a real plant measures: a
   * heat balance's deficit, the true flow through a relief valve or a leak, a
   * bus's spare power. Displays tag it SIM wherever they show it.
   */
  simulatorOnly: z.literal(true).optional(),
})
export const variableDescriptorSchema = variableDescriptorBaseSchema.superRefine(validateQuantityUnit)
export type VariableDescriptor = z.infer<typeof variableDescriptorSchema>

export const deriveProcessVariableCapabilities = (config: {
  readonly descriptor: VariableDescriptor
  readonly published: boolean
}): Required<ProcessVariableCapability> => {
  const publish = config.descriptor.publish
  return {
    readable: true,
    writable: config.descriptor.writable,
    trendable: publish === 'telemetry' || publish === 'alarm' || publish === 'leitbild',
    alarmable: publish === 'alarm',
    operatorFacing: config.descriptor.writable || publish === 'alarm' || publish === 'leitbild',
    aiVisible: config.descriptor.tagId !== undefined || publish !== 'internal',
    procedureRelevant: config.descriptor.tagId !== undefined,
    ...config.descriptor.capabilities,
  }
}

export const componentVariableBindingOverrideSchema = z.object({
  path: localVariablePathSchema,
  tagId: processSignalTagIdSchema.optional(),
  equipmentId: processEquipmentIdSchema.optional(),
  description: z.string().min(1).optional(),
  externalRefs: z.array(z.string().min(1)).optional(),
  capabilities: processVariableCapabilitySchema.optional(),
  limits: processVariableLimitsSchema.optional(),
}).strict()
export type ComponentVariableBindingOverride = z.infer<typeof componentVariableBindingOverrideSchema>

export const componentVariableDescriptorSchema = variableDescriptorBaseSchema.extend({
  path: localVariablePathSchema,
}).superRefine(validateQuantityUnit)
export type ComponentVariableDescriptor = z.infer<typeof componentVariableDescriptorSchema>

export const connectionPhysicalSpecSchema = z.object({
  lengthM: z.number().finite().positive().optional(),
  diameterM: z.number().finite().positive().optional(),
  roughnessM: z.number().finite().nonnegative().optional(),
  volumeM3: z.number().finite().positive().optional(),
  nominalResistance: z.number().finite().nonnegative().optional(),
  nominalFlowKgPerS: z.number().finite().positive().optional(),
  leakCoefficientKgPerSPerSqrtMPa: z.number().finite().nonnegative().optional(),
}).strict()
export type ConnectionPhysicalSpec = z.infer<typeof connectionPhysicalSpecSchema>

export const processLinkVariableDescriptorSchema = variableDescriptorBaseSchema.extend({
  path: localVariablePathSchema,
  initialValue: processVariableValueSchema,
}).superRefine((descriptor, ctx) => {
  validateQuantityUnit(descriptor, ctx)
  validateInitialValueType(descriptor, ctx)
  validateInitialValueBounds(descriptor, ctx)
})
export type ProcessLinkVariableDescriptor = z.infer<typeof processLinkVariableDescriptorSchema>

export const timestepSpecSchema = z.object({
  fixedStepMs: z.number().int().positive().max(10_000),
})
export type TimestepSpec = z.infer<typeof timestepSpecSchema>

export const componentInstanceSpecSchema = z.object({
  id: componentIdSchema,
  kind: componentKindSchema,
  label: z.string().min(1),
  parameters: z.unknown(),
  metadata: processGraphMetadataSchema.optional(),
  variables: z.array(componentVariableBindingOverrideSchema).default([]),
}).strict()
export type ComponentInstanceSpec = z.infer<typeof componentInstanceSpecSchema>

export const connectionSpecSchema = z.object({
  id: connectionIdSchema,
  from: portRefSchema,
  to: portRefSchema,
  connectionKind: connectionKindSchema,
  service: connectionServiceSchema.optional(),
  nominalFluid: fluidKindSchema.optional(),
  designPhase: designPhaseSchema.optional(),
  solverModel: fluidSolverModelSchema.optional(),
  physical: connectionPhysicalSpecSchema.optional(),
  metadata: processGraphMetadataSchema.optional(),
  variables: z.array(processLinkVariableDescriptorSchema).default([]),
}).strict().superRefine((connection, ctx) => {
  const fluidMetadata = connection.service !== undefined
    || connection.nominalFluid !== undefined
    || connection.designPhase !== undefined
    || connection.solverModel !== undefined
  if (connection.connectionKind !== 'fluidFlow' && fluidMetadata) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['connectionKind'],
      message: 'fluid metadata requires connectionKind fluidFlow',
    })
  }
  if (connection.connectionKind === 'fluidFlow' && connection.service === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['service'],
      message: 'fluidFlow connections require service',
    })
  }
})
export type ConnectionSpec = z.infer<typeof connectionSpecSchema>

export const plantGraphSpecSchema = z.object({
  schemaVersion: z.literal(1),
  id: plantGraphIdSchema,
  title: z.string().min(1),
  timestep: timestepSpecSchema,
  components: z.array(componentInstanceSpecSchema).min(1),
  connections: z.array(connectionSpecSchema),
  publishedVariables: z.array(variablePathSchema).default([]),
}).strict()
export type PlantGraphSpec = z.infer<typeof plantGraphSpecSchema>

export interface ComponentDefinition {
  readonly kind: ComponentKind
  readonly label: string
  readonly ports: Readonly<Record<string, PortDefinition>>
  readonly resolveAdditionalPorts?: (context: {
    readonly component: ComponentInstanceSpec
    readonly parameters: unknown
  }) => Readonly<Record<string, PortDefinition>>
  readonly parametersSchema: z.ZodType<unknown>
  readonly variables: ReadonlyArray<ComponentVariableDescriptor>
  /** What the kind is and does, from its parsed parameters. */
  readonly semantics: (parameters: unknown) => ComponentSemantics
}

export interface CompiledPort {
  readonly index: number
  readonly name: PortName
  readonly kind: PortKind
  readonly direction: PortDirection
  readonly circuit?: string
  readonly demand?: LocalVariablePath
}

export interface CompiledComponent {
  readonly index: number
  readonly id: ComponentId
  readonly kind: ComponentKind
  readonly label: string
  readonly parameters: unknown
  readonly metadata?: ProcessGraphMetadata
  readonly ports: Readonly<Record<string, CompiledPort>>
  readonly variables: ReadonlyArray<VariableDescriptor>
  readonly semantics: CompiledComponentSemantics
}

export interface CompiledProcessLink {
  readonly index: number
  readonly id: ConnectionId
  readonly kind: ConnectionKind
  readonly fromComponentIndex: number
  readonly fromPortIndex: number
  readonly fromPortName: PortName
  readonly toComponentIndex: number
  readonly toPortIndex: number
  readonly toPortName: PortName
  readonly service?: ConnectionService
  readonly nominalFluid?: FluidKind
  readonly designPhase?: DesignPhase
  readonly solverModel?: FluidSolverModel
  readonly physical?: ConnectionPhysicalSpec
  readonly metadata?: ProcessGraphMetadata
  readonly variables: ReadonlyArray<VariableDescriptor>
}

export interface CompiledVariable {
  readonly path: VariablePath
  readonly owner:
    | { readonly type: 'component'; readonly componentIndex: number }
    | { readonly type: 'link'; readonly linkIndex: number }
  readonly descriptor: VariableDescriptor
  readonly published: boolean
  readonly initialValue?: ProcessVariableValue
}

export interface ProcessSignalBinding {
  readonly path: VariablePath
  readonly tagId?: ProcessSignalTagId
  readonly equipmentId?: ProcessEquipmentId
  readonly description?: string
  readonly externalRefs?: ReadonlyArray<string>
  readonly capabilities?: ProcessVariableCapability
  readonly limits?: ProcessVariableLimits
  readonly label: string
  readonly kind: VariableKind
  readonly discipline: VariableDiscipline
  readonly quantity: ProcessQuantity
  readonly unit: ProcessUnit
  readonly writable: boolean
  readonly actuation?: VariableActuation
  readonly measurand?: RatioMeasurand
  /** A value only the simulator computes (variableDescriptorBaseSchema.simulatorOnly). */
  readonly simulatorOnly?: true
  readonly published: boolean
  readonly owner:
    | { readonly type: 'component'; readonly componentIndex: number }
    | { readonly type: 'link'; readonly linkIndex: number }
}

export interface CompiledPlantGraph {
  readonly specId: PlantGraphId
  readonly title: string
  readonly timestep: TimestepSpec
  readonly components: ReadonlyArray<CompiledComponent>
  readonly componentIndexById: ReadonlyMap<ComponentId, number>
  readonly links: ReadonlyArray<CompiledProcessLink>
  readonly linksByKind: Readonly<Record<ConnectionKind, ReadonlyArray<number>>>
  readonly incomingLinksByComponent: ReadonlyArray<ReadonlyArray<number>>
  readonly outgoingLinksByComponent: ReadonlyArray<ReadonlyArray<number>>
  readonly linksByService: ReadonlyMap<ConnectionService, ReadonlyArray<number>>
  readonly variables: ReadonlyArray<CompiledVariable>
  readonly signalBindings: ReadonlyArray<ProcessSignalBinding>
  readonly signalBindingByPath: ReadonlyMap<VariablePath, ProcessSignalBinding>
  readonly signalBindingByTagId: ReadonlyMap<ProcessSignalTagId, ProcessSignalBinding>
  readonly signalBindingByExternalRef: ReadonlyMap<string, ProcessSignalBinding>
}
