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
  /** The id of a first-out group the I&C config declares (processPlantIcFirstOutGroupSchema). */
  firstOutGroup: z.string().min(1).optional(),
  priority: processPlantIcAnnunciatorPrioritySchema.default('medium'),
  role: processPlantIcAnnunciatorRoleSchema.default('symptom'),
  /**
   * The first-out group whose actuation brings this alarm in as its
   * expected consequence (a steam generator's low level as its level
   * shrinks after a reactor trip): coming in within `withinMs` after that
   * group's first-out, and not first out itself, displays show it as
   * expected, de-emphasised but never hidden (ISA-18.2 state-based
   * handling). Coming in before, with it, or later, it stands out as any.
   */
  expectedAfter: z.object({
    firstOutGroup: z.string().min(1),
    withinMs: z.number().finite().positive(),
  }).strict().optional(),
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
 * A first-out group: the alarms and trips whose annunciators name it, of
 * which the first to come in is marked first out. Declared once, as operators
 * name what its members do ("Reactor trip") and as a display names a limit
 * acting through it or an actuation it lists ("RX TRIP", "SI"). The reactor
 * trip's group says so: a display's trip banner leads with its first-out,
 * and lists the Plant's other automatic actuations apart from it.
 */
export const processPlantIcFirstOutGroupSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  shortLabel: z.string().min(1),
  reactorTrip: z.boolean().default(false),
}).strict()
export type ProcessPlantIcFirstOutGroup = z.infer<typeof processPlantIcFirstOutGroupSchema>

/**
 * An operating mode of the Plant ("Power operation"), declared once and named
 * by its id on each rule that acts only in it. The Plant is in the first
 * declared mode whose condition holds, so declaration order resolves overlap;
 * a Plant whose modes cover every state is always in one. Its short label is
 * how a display names it where the label does not fit ("1": "Modes 1–2").
 */
export const processPlantIcOperatingModeSchema = z.object({
  id: idSchema,
  label: z.string().min(1),
  shortLabel: z.string().min(1).optional(),
  condition: processPlantIcConditionSchema,
}).strict()
export type ProcessPlantIcOperatingMode = z.infer<typeof processPlantIcOperatingModeSchema>

/**
 * What a branch of a critical safety function status tree compares: one
 * signal against a value in its native unit; the total of several (the feed
 * flow into every steam generator); one signal less another (a cold leg
 * against its steam generator's saturation temperature); or all or any of
 * these. A signal the Plant does not publish leaves the branch unknown: the
 * tree never stands in a value for it.
 */
export type ProcessPlantIcSafetyFunctionCondition =
  | {
      readonly type: 'comparison'
      readonly signal: ProcessPlantSignalReference
      readonly operator: ProcessPlantIcComparisonOperator
      readonly value: number | boolean
    }
  | {
      readonly type: 'total'
      readonly signals: ReadonlyArray<ProcessPlantSignalReference>
      readonly operator: ProcessPlantIcComparisonOperator
      readonly value: number
    }
  | {
      readonly type: 'difference'
      readonly signal: ProcessPlantSignalReference
      readonly minus: ProcessPlantSignalReference
      readonly operator: ProcessPlantIcComparisonOperator
      readonly value: number
    }
  | {
      readonly type: 'all'
      readonly conditions: ReadonlyArray<ProcessPlantIcSafetyFunctionCondition>
    }
  | {
      readonly type: 'any'
      readonly conditions: ReadonlyArray<ProcessPlantIcSafetyFunctionCondition>
    }

export const processPlantIcSafetyFunctionConditionSchema: z.ZodType<ProcessPlantIcSafetyFunctionCondition> = z.lazy(() => z.union([
  z.object({
    type: z.literal('comparison'),
    signal: processPlantSignalReferenceSchema,
    operator: processPlantIcComparisonOperatorSchema,
    value: z.union([z.number().finite(), z.boolean()]),
  }).strict(),
  z.object({
    type: z.literal('total'),
    signals: z.array(processPlantSignalReferenceSchema).min(2),
    operator: processPlantIcComparisonOperatorSchema,
    value: z.number().finite(),
  }).strict(),
  z.object({
    type: z.literal('difference'),
    signal: processPlantSignalReferenceSchema,
    minus: processPlantSignalReferenceSchema,
    operator: processPlantIcComparisonOperatorSchema,
    value: z.number().finite(),
  }).strict(),
  z.object({
    type: z.literal('all'),
    conditions: z.array(processPlantIcSafetyFunctionConditionSchema).min(1),
  }).strict(),
  z.object({
    type: z.literal('any'),
    conditions: z.array(processPlantIcSafetyFunctionConditionSchema).min(1),
  }).strict(),
]) as unknown as z.ZodType<ProcessPlantIcSafetyFunctionCondition>)

export const processPlantIcSafetyFunctionColourSchema = z.enum(['green', 'yellow', 'orange', 'red'])
export type ProcessPlantIcSafetyFunctionColour = z.infer<typeof processPlantIcSafetyFunctionColourSchema>

/**
 * A status tree: a question that branches on a condition, yes or no, each
 * branch to a further question or to the function's status: its colour, the
 * function restoration procedure that colour sends operators to, and what it
 * means. Each question cites the criterion it follows (`basis`).
 */
export type ProcessPlantIcStatusTreeNode =
  | {
      readonly question: string
      readonly basis: string
      readonly condition: ProcessPlantIcSafetyFunctionCondition
      readonly yes: ProcessPlantIcStatusTreeNode
      readonly no: ProcessPlantIcStatusTreeNode
    }
  | {
      readonly status: ProcessPlantIcSafetyFunctionColour
      readonly procedure?: string
      readonly meaning: string
    }

export const processPlantIcStatusTreeNodeSchema: z.ZodType<ProcessPlantIcStatusTreeNode> = z.lazy(() => z.union([
  z.object({
    question: z.string().min(1),
    basis: z.string().min(1),
    condition: processPlantIcSafetyFunctionConditionSchema,
    yes: processPlantIcStatusTreeNodeSchema,
    no: processPlantIcStatusTreeNodeSchema,
  }).strict(),
  z.object({
    status: processPlantIcSafetyFunctionColourSchema,
    procedure: z.string().min(1).optional(),
    meaning: z.string().min(1),
  }).strict(),
]) as unknown as z.ZodType<ProcessPlantIcStatusTreeNode>)

/**
 * A critical safety function the Plant's I&C judges by a status tree
 * ("Heat sink"), declared once, as operators name it and as a display's chip
 * does where room is short ("HEAT SINK"). A function judged only in some
 * states (subcriticality, once a reactor trip is demanded) says when, and
 * what it reads otherwise. Checks are further criteria the procedures judge
 * beside the tree's colour (natural circulation with no coolant pump
 * running), each where it applies; expectations are the trends the tree
 * treats as expected in a state, so they are not read as a challenge.
 */
export const processPlantIcSafetyFunctionSchema = z.object({
  id: idSchema,
  label: z.string().min(1),
  shortLabel: z.string().min(1),
  /** The status tree it follows, cited. */
  basis: z.string().min(1),
  monitored: z.object({
    when: processPlantIcSafetyFunctionConditionSchema,
    otherwise: z.string().min(1),
  }).strict().optional(),
  tree: processPlantIcStatusTreeNodeSchema,
  checks: z.array(z.object({
    label: z.string().min(1),
    basis: z.string().min(1),
    when: processPlantIcSafetyFunctionConditionSchema.optional(),
    condition: processPlantIcSafetyFunctionConditionSchema,
    /** What it means while the check is not met. */
    notMet: z.string().min(1),
  }).strict()).default([]),
  expectations: z.array(z.object({
    when: processPlantIcSafetyFunctionConditionSchema,
    text: z.string().min(1),
  }).strict()).default([]),
}).strict()
export type ProcessPlantIcSafetyFunction = z.infer<typeof processPlantIcSafetyFunctionSchema>

export const processPlantIcConfigSchema = z.object({
  operatingModes: z.array(processPlantIcOperatingModeSchema).default([]),
  annunciatorSystems: z.array(processPlantIcAnnunciatorSystemSchema).default([]),
  firstOutGroups: z.array(processPlantIcFirstOutGroupSchema).default([]),
  /** The critical safety functions, in the order displays show them. */
  safetyFunctions: z.array(processPlantIcSafetyFunctionSchema).default([]),
  rules: z.array(processPlantIcRuleSchema).default([]),
}).strict().superRefine((config, ctx) => {
  const functions = new Set<string>()
  for (const [index, safetyFunction] of config.safetyFunctions.entries()) {
    if (functions.has(safetyFunction.id)) ctx.addIssue({ code: 'custom', path: ['safetyFunctions', index, 'id'], message: `safety function ${safetyFunction.id} is declared twice` })
    functions.add(safetyFunction.id)
  }
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
  // A first-out group an annunciator names is declared once, so a display can name what its members do.
  const groups = new Set<string>()
  for (const [index, group] of config.firstOutGroups.entries()) {
    if (groups.has(group.id)) ctx.addIssue({ code: 'custom', path: ['firstOutGroups', index, 'id'], message: `first-out group ${group.id} is declared twice` })
    groups.add(group.id)
  }
  if (groups.size === 0) return
  for (const [ruleIndex, rule] of config.rules.entries()) {
    for (const [effectIndex, effect] of rule.effects.entries()) {
      if (effect.type === 'writeSignal') continue
      const after = effect.annunciator?.expectedAfter?.firstOutGroup
      if (after !== undefined && !groups.has(after)) ctx.addIssue({ code: 'custom', path: ['rules', ruleIndex, 'effects', effectIndex, 'annunciator', 'expectedAfter', 'firstOutGroup'], message: `${rule.id} is expected after first-out group ${after}, which is not declared; declared: ${[...groups].join(', ')}` })
      if (effect.annunciator?.firstOutGroup === undefined || groups.has(effect.annunciator.firstOutGroup)) continue
      ctx.addIssue({ code: 'custom', path: ['rules', ruleIndex, 'effects', effectIndex, 'annunciator', 'firstOutGroup'], message: `${rule.id} names first-out group ${effect.annunciator.firstOutGroup}, which is not declared; declared: ${[...groups].join(', ')}` })
    }
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
