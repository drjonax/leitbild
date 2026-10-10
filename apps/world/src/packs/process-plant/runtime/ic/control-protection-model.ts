import { z } from 'zod'
import { idSchema } from '../../../../core/model/index.ts'
import { processVariableValueSchema } from '../../graph/index.ts'
import { processPlantSignalReferenceSchema, type ProcessPlantSignalReference } from '../../signals.ts'

export const processPlantIcRuleClassSchema = z.enum([
  'normalControl',
  'protection',
  'alarm',
  'permissive',
  'interlock',
])
export type ProcessPlantIcRuleClass = z.infer<typeof processPlantIcRuleClassSchema>

export const processPlantIcComparisonOperatorSchema = z.enum(['<', '<=', '>', '>=', '==', '!='])
export type ProcessPlantIcComparisonOperator = z.infer<typeof processPlantIcComparisonOperatorSchema>

export const processPlantIcSeveritySchema = z.enum(['info', 'notice', 'warning', 'critical'])
export type ProcessPlantIcSeverity = z.infer<typeof processPlantIcSeveritySchema>

export const processPlantIcAnnunciatorPrioritySchema = z.enum(['low', 'medium', 'high', 'urgent'])
export type ProcessPlantIcAnnunciatorPriority = z.infer<typeof processPlantIcAnnunciatorPrioritySchema>

export const processPlantIcAnnunciatorRoleSchema = z.enum(['symptom', 'cause', 'automaticAction', 'status'])
export type ProcessPlantIcAnnunciatorRole = z.infer<typeof processPlantIcAnnunciatorRoleSchema>

export const processPlantIcAnnunciatorSchema = z.object({
  /** The id of an annunciator system the I&C config declares (processPlantIcAnnunciatorSystemSchema). */
  system: z.string().min(1).optional(),
  equipmentId: idSchema.optional(),
  group: z.string().min(1).optional(),
  firstOutGroup: z.string().min(1).optional(),
  priority: processPlantIcAnnunciatorPrioritySchema.default('medium'),
  role: processPlantIcAnnunciatorRoleSchema.default('symptom'),
}).strict()
export type ProcessPlantIcAnnunciator = z.infer<typeof processPlantIcAnnunciatorSchema>

export const processPlantIcLifecyclePhaseSchema = z.enum([
  'normal',
  'activeUnacknowledged',
  'activeAcknowledged',
  'clearedUnacknowledged',
  'clearedAcknowledged',
  'suppressed',
  'shelved',
  'outOfService',
])
export type ProcessPlantIcLifecyclePhase = z.infer<typeof processPlantIcLifecyclePhaseSchema>

export type ProcessPlantIcCondition =
  | {
      readonly type: 'comparison'
      readonly signal: ProcessPlantSignalReference
      readonly operator: ProcessPlantIcComparisonOperator
      readonly value: number | boolean
    }
  | {
      readonly type: 'all'
      readonly conditions: ReadonlyArray<ProcessPlantIcCondition>
    }
  | {
      readonly type: 'any'
      readonly conditions: ReadonlyArray<ProcessPlantIcCondition>
    }
  | {
      readonly type: 'not'
      readonly condition: ProcessPlantIcCondition
    }
  | {
      readonly type: 'vote'
      readonly required: number
      readonly conditions: ReadonlyArray<ProcessPlantIcCondition>
    }

export const processPlantIcConditionSchema: z.ZodType<ProcessPlantIcCondition> = z.lazy(() => z.union([
  z.object({
    type: z.literal('comparison'),
    signal: processPlantSignalReferenceSchema,
    operator: processPlantIcComparisonOperatorSchema,
    value: z.union([z.number().finite(), z.boolean()]),
  }).strict(),
  z.object({
    type: z.literal('all'),
    conditions: z.array(processPlantIcConditionSchema).min(1),
  }).strict(),
  z.object({
    type: z.literal('any'),
    conditions: z.array(processPlantIcConditionSchema).min(1),
  }).strict(),
  z.object({
    type: z.literal('not'),
    condition: processPlantIcConditionSchema,
  }).strict(),
  z.object({
    type: z.literal('vote'),
    required: z.number().int().positive(),
    conditions: z.array(processPlantIcConditionSchema).min(1),
  }).strict().superRefine((condition, ctx) => {
    if (condition.required > condition.conditions.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['required'],
        message: 'vote required count cannot exceed condition count',
      })
    }
  }),
]) as unknown as z.ZodType<ProcessPlantIcCondition>)

export type ProcessPlantIcEffect =
  | {
      readonly type: 'alarm.enter'
      readonly id: string
      readonly title: string
      readonly message: string
      readonly severity?: ProcessPlantIcSeverity
      readonly annunciator?: ProcessPlantIcAnnunciator | undefined
    }
  | {
      readonly type: 'trip.enter'
      readonly id: string
      readonly title: string
      readonly message: string
      readonly severity?: ProcessPlantIcSeverity
      readonly annunciator?: ProcessPlantIcAnnunciator | undefined
    }
  | {
      readonly type: 'writeSignal'
      readonly id: string
      readonly signal: ProcessPlantSignalReference
      readonly value: number | boolean
    }

export interface ProcessPlantIcCommandGate {
  readonly signal: ProcessPlantSignalReference
  readonly message?: string
}

export const processPlantIcEffectSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('alarm.enter'),
    id: idSchema,
    title: z.string().min(1),
    message: z.string().min(1),
    severity: processPlantIcSeveritySchema.default('warning'),
    annunciator: processPlantIcAnnunciatorSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal('trip.enter'),
    id: idSchema,
    title: z.string().min(1),
    message: z.string().min(1),
    severity: processPlantIcSeveritySchema.default('critical'),
    annunciator: processPlantIcAnnunciatorSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal('writeSignal'),
    id: idSchema,
    signal: processPlantSignalReferenceSchema,
    value: processVariableValueSchema,
  }).strict(),
])

export const processPlantIcCommandGateSchema = z.object({
  signal: processPlantSignalReferenceSchema,
  message: z.string().min(1).optional(),
}).strict()

export const processPlantIcRuleSchema = z.object({
  id: idSchema,
  label: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
  ruleClass: processPlantIcRuleClassSchema.default('protection'),
  /** The declared operating modes the rule acts in (operatingModes); absent, it acts in every mode. */
  modes: z.array(idSchema).min(1).optional(),
  condition: processPlantIcConditionSchema,
  delayMs: z.number().finite().nonnegative().default(0),
  clearCondition: processPlantIcConditionSchema.optional(),
  clearDelayMs: z.number().finite().nonnegative().default(0),
  latch: z.boolean().default(true),
  resetWhenClear: z.boolean().default(false),
  resetCondition: processPlantIcConditionSchema.optional(),
  effects: z.array(processPlantIcEffectSchema).default([]),
  commandGates: z.array(processPlantIcCommandGateSchema).default([]),
}).strict()
export type ProcessPlantIcRule = z.infer<typeof processPlantIcRuleSchema>

/**
 * A system the Plant's alarms and trips are annunciated by ("Reactor coolant
 * system"), declared once and named by its id on each annunciator. Its label
 * is how operators name it; its short label is how a tile too narrow for the
 * label names it ("RCS"). Declaration order is the order displays show them.
 */
export const processPlantIcAnnunciatorSystemSchema = z.object({
  id: idSchema,
  label: z.string().min(1),
  shortLabel: z.string().min(1).optional(),
}).strict()
export type ProcessPlantIcAnnunciatorSystem = z.infer<typeof processPlantIcAnnunciatorSystemSchema>

/**
 * An operating mode of the Plant ("Power operation"), declared once and named
 * by its id on each rule that acts only in it. The Plant is in the first
 * declared mode whose condition holds, so declaration order resolves overlap;
 * a Plant whose modes cover every state is always in one.
 */
export const processPlantIcOperatingModeSchema = z.object({
  id: idSchema,
  label: z.string().min(1),
  condition: processPlantIcConditionSchema,
}).strict()
export type ProcessPlantIcOperatingMode = z.infer<typeof processPlantIcOperatingModeSchema>

export const processPlantIcConfigSchema = z.object({
  operatingModes: z.array(processPlantIcOperatingModeSchema).default([]),
  annunciatorSystems: z.array(processPlantIcAnnunciatorSystemSchema).default([]),
  rules: z.array(processPlantIcRuleSchema).default([]),
}).strict().superRefine((config, ctx) => {
  // A rule names declared modes only, each once.
  const modes = new Set<string>()
  for (const [index, mode] of config.operatingModes.entries()) {
    if (modes.has(mode.id)) ctx.addIssue({ code: 'custom', path: ['operatingModes', index, 'id'], message: `operating mode ${mode.id} is declared twice` })
    modes.add(mode.id)
  }
  for (const [ruleIndex, rule] of config.rules.entries()) {
    for (const [modeIndex, mode] of (rule.modes ?? []).entries()) {
      const path = ['rules', ruleIndex, 'modes', modeIndex]
      if (!modes.has(mode)) ctx.addIssue({ code: 'custom', path, message: `${rule.id} acts in operating mode ${mode}, which is not declared; declared: ${[...modes].join(', ') || 'none'}` })
      if (rule.modes!.indexOf(mode) !== modeIndex) ctx.addIssue({ code: 'custom', path, message: `${rule.id} names operating mode ${mode} twice` })
    }
  }
  // A system's alarms are all its own and all named, so a system that shows quiet is quiet.
  const declared = new Set<string>()
  for (const [index, system] of config.annunciatorSystems.entries()) {
    if (declared.has(system.id)) ctx.addIssue({ code: 'custom', path: ['annunciatorSystems', index, 'id'], message: `annunciator system ${system.id} is declared twice` })
    declared.add(system.id)
  }
  for (const [ruleIndex, rule] of config.rules.entries()) {
    const named = new Set<string>()
    for (const [effectIndex, effect] of rule.effects.entries()) {
      if (effect.type !== 'alarm.enter' && effect.type !== 'trip.enter') continue
      const system = effect.annunciator?.system
      const path = ['rules', ruleIndex, 'effects', effectIndex, 'annunciator', 'system']
      if (system === undefined) {
        if (declared.size > 0) ctx.addIssue({ code: 'custom', path, message: `${rule.id} ${effect.type === 'alarm.enter' ? 'alarm' : 'trip'} ${effect.id} names no annunciator system; this Plant annunciates every alarm on one of ${[...declared].join(', ')}` })
        continue
      }
      if (!declared.has(system)) ctx.addIssue({ code: 'custom', path, message: `${rule.id} names annunciator system ${system}, which is not declared; declared: ${[...declared].join(', ') || 'none'}` })
      named.add(system)
    }
    if (named.size > 1) ctx.addIssue({ code: 'custom', path: ['rules', ruleIndex], message: `${rule.id} annunciates on ${[...named].join(' and ')}; a rule annunciates on one system` })
  }
})
export type ProcessPlantIcConfig = z.infer<typeof processPlantIcConfigSchema>

export const processPlantIcRuleSnapshotSchema = z.object({
  ruleId: idSchema,
  active: z.boolean(),
  latched: z.boolean(),
  activeSinceElapsedMs: z.number().finite().nonnegative().optional(),
  clearSinceElapsedMs: z.number().finite().nonnegative().optional(),
  lastTransitionElapsedMs: z.number().finite().nonnegative().optional(),
  firedCount: z.number().int().nonnegative(),
})
export type ProcessPlantIcRuleSnapshot = z.infer<typeof processPlantIcRuleSnapshotSchema>

export const processPlantIcLifecycleStateSchema = z.object({
  id: idSchema,
  ruleId: idSchema,
  effectId: idSchema,
  kind: z.enum(['alarm', 'trip']),
  title: z.string().min(1),
  message: z.string().min(1),
  severity: processPlantIcSeveritySchema,
  annunciator: processPlantIcAnnunciatorSchema.optional(),
  phase: processPlantIcLifecyclePhaseSchema.default('normal'),
  active: z.boolean(),
  acknowledged: z.boolean(),
  latched: z.boolean(),
  suppressed: z.boolean(),
  shelved: z.boolean().default(false),
  outOfService: z.boolean().default(false),
  resettable: z.boolean(),
  firstOut: z.boolean().default(false),
  firstOutRank: z.number().int().positive().optional(),
  firstOutElapsedMs: z.number().finite().nonnegative().optional(),
  firstActiveElapsedMs: z.number().finite().nonnegative().optional(),
  lastActiveElapsedMs: z.number().finite().nonnegative().optional(),
  lastClearedElapsedMs: z.number().finite().nonnegative().optional(),
  lastAcknowledgedElapsedMs: z.number().finite().nonnegative().optional(),
  lastResetElapsedMs: z.number().finite().nonnegative().optional(),
  lastSuppressedElapsedMs: z.number().finite().nonnegative().optional(),
  lastShelvedElapsedMs: z.number().finite().nonnegative().optional(),
  shelvedUntilElapsedMs: z.number().finite().nonnegative().optional(),
  lastTransitionElapsedMs: z.number().finite().nonnegative().optional(),
  lastActorId: idSchema.optional(),
  lastClientId: idSchema.optional(),
  lastReason: z.string().min(1).optional(),
  transitionCount: z.number().int().nonnegative(),
  occurrenceCount: z.number().int().nonnegative().default(0),
  clearCount: z.number().int().nonnegative().default(0),
  acknowledgeCount: z.number().int().nonnegative().default(0),
})
export type ProcessPlantIcLifecycleState = z.infer<typeof processPlantIcLifecycleStateSchema>

export const processPlantIcLifecycleActionSchema = z.enum([
  'acknowledge',
  'reset',
  'suppress',
  'unsuppress',
  'shelve',
  'unshelve',
])
export type ProcessPlantIcLifecycleAction = z.infer<typeof processPlantIcLifecycleActionSchema>

export const processPlantIcFailureSchema = z.object({
  ruleId: idSchema,
  effectId: idSchema.optional(),
  elapsedMs: z.number().finite().nonnegative(),
  message: z.string().min(1),
})
export type ProcessPlantIcFailure = z.infer<typeof processPlantIcFailureSchema>

export const processPlantIcLifecycleTransitionSchema = z.enum([
  'entered',
  'cleared',
  'acknowledged',
  'reset',
  'suppressed',
  'unsuppressed',
  'shelved',
  'unshelved',
  'shelveExpired',
  'firstOut',
])
export type ProcessPlantIcLifecycleTransition = z.infer<typeof processPlantIcLifecycleTransitionSchema>

export const processPlantIcLifecycleHistoryEntrySchema = z.object({
  id: idSchema,
  lifecycleId: idSchema,
  ruleId: idSchema,
  effectId: idSchema,
  kind: z.enum(['alarm', 'trip']),
  transition: processPlantIcLifecycleTransitionSchema,
  elapsedMs: z.number().finite().nonnegative(),
  title: z.string().min(1),
  severity: processPlantIcSeveritySchema,
  phase: processPlantIcLifecyclePhaseSchema,
  actorId: idSchema.optional(),
  clientId: idSchema.optional(),
  reason: z.string().min(1).optional(),
})
export type ProcessPlantIcLifecycleHistoryEntry = z.infer<typeof processPlantIcLifecycleHistoryEntrySchema>

export const processPlantIcSnapshotSchema = z.object({
  rules: z.array(processPlantIcRuleSnapshotSchema),
  alarms: z.array(processPlantIcLifecycleStateSchema),
  trips: z.array(processPlantIcLifecycleStateSchema),
  failures: z.array(processPlantIcFailureSchema),
  history: z.array(processPlantIcLifecycleHistoryEntrySchema).default([]),
})
export type ProcessPlantIcSnapshot = z.infer<typeof processPlantIcSnapshotSchema>

export const processPlantProtectionRuleSchema = processPlantIcRuleSchema
export type ProcessPlantProtectionRule = ProcessPlantIcRule
export const processPlantProtectionConfigSchema = processPlantIcConfigSchema
export type ProcessPlantProtectionConfig = ProcessPlantIcConfig
export const processPlantProtectionRuleSnapshotSchema = processPlantIcRuleSnapshotSchema
export type ProcessPlantProtectionRuleSnapshot = ProcessPlantIcRuleSnapshot
export const processPlantProtectionSnapshotSchema = processPlantIcSnapshotSchema
export type ProcessPlantProtectionSnapshot = ProcessPlantIcSnapshot
