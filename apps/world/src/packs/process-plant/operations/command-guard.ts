import type { ProcessSignalBinding, ProcessVariableValue, VariablePath } from '../graph/index.ts'
import type { CommandOrigin, PackCommandContext } from '../../../simulation/protocol.ts'
import {
  processPlantActionInvokeCommandKind,
  processPlantControlRampCommandKind,
  processPlantControlWriteCommandKind,
  processPlantIcLifecycleCommandKind,
} from '../command-kinds.ts'
import type { ProcessPlantControlWritePayload } from '../commands.ts'
import type { ProcessPlantUnitPackData } from '../model.ts'
import { validateProcessPlantControlWrite, type ProcessPlantControlWriteValidation } from '../control-write-validation.ts'
import { formatQuantity } from '../displays/display-text.ts'
import { actionOf, icRuleKind } from '../displays/ic-thresholds.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import { evaluateProcessPlantIcCondition, type ProcessPlantIcRule, type ProcessPlantIcSnapshot, type ProcessPlantProtectionRunner, type ProcessPlantRuntime } from '../runtime/index.ts'
import { resolveProcessPlantSignalBinding } from '../signals.ts'
import type { ControlRule } from './controls.ts'
import { actuationResets, resetClause } from './actuation-reset.ts'
import { demandSpanOf, demandStepOf, type DemandSpan } from './demand-span.ts'

// What a command's origin may write, beyond what the I&C validates for
// everyone (control-write-validation.ts):
// - On a Plant that does not opt into direct AI operation, an AI agent
//   proposes and a person approves: its direct writes, ramps, instructor
//   actions and alarm lifecycle changes are refused (plan-final QA-1). It
//   may read, validate and propose. While it drives an active procedure Run
//   on the Plant, it operates the Plant's controls as that procedure's
//   operator (writes, ramps, alarm lifecycle, actuation resets) until a
//   person takes the Run over; instructor actions, which set up the event a
//   procedure answers, stay a person's and the Scenario's.
// - A fault the scenario injects and a condition outside the Plant are the
//   instructor's: people inject them through instructor actions, the
//   Scenario timeline writes them directly, and neither a person's nor an AI
//   agent's control write or ramp reaches them (plan-final S1, QA-3: by the
//   caller's origin, so the shared validator, the probe's instructor actions
//   and scenario timelines are unaffected).
// - A protection actuation writes its effects once, on entering, and never
//   again while it stands: a person's or an agent's command against it (an
//   SI pump stopped after SI started it, an MSIV reopened that steam line
//   isolation shut) would defeat it without a word. Such a command is refused
//   while the actuation stands active or sealed in, naming it (QA-2); after a
//   reset it is the operators' again. Where it drove a demand a person sets
//   in its span (a modulating valve's position) fully open and its rule
//   declares a throttle floor, a setting between the floor and the open end
//   is a throttle under it (AFW flow controlled after AFW opened its
//   valves), recorded as such; below the floor, or with no floor declared,
//   anything but the end it drove is refused. Nothing rewrites the demand
//   after the actuation's edge, so a throttle holds until an actuation
//   enters again.

/** The commands an AI agent issues on a propose-only Plant only through a person's approval, or as the operator of a procedure it drives there. */
export const aiDirectCommandKinds: ReadonlySet<string> = new Set([
  processPlantControlWriteCommandKind,
  processPlantControlRampCommandKind,
  processPlantActionInvokeCommandKind,
  processPlantIcLifecycleCommandKind,
])

/** Whether the caller drives an active procedure Run on this Plant, as core stamps it. */
export const drivesProcedureOn = (context: PackCommandContext, plantId: string): boolean => context.procedureDriven?.has(plantId) === true

/** Why an AI agent may not issue this command on this Plant itself; null where it may, or the origin is no AI agent's. */
export const aiProposeOnlyRefusal = (kind: string, context: PackCommandContext, plantId: string, aiOperation: ProcessPlantUnitPackData['aiOperation']): string | null => {
  if (context.origin !== 'ai' || aiOperation === 'direct' || !aiDirectCommandKinds.has(kind)) return null
  if (!drivesProcedureOn(context, plantId)) {
    return 'An AI agent proposes operations on this Plant for a person to approve (world.process-plant.control.propose); it operates it directly only while it drives an active procedure Run on it'
  }
  return kind === processPlantActionInvokeCommandKind
    ? 'An instructor action is a person\'s or the Scenario\'s: driving a procedure Run lets an AI agent operate the Plant\'s controls, not set up the event the procedure answers'
    : null
}

/** Why this origin may not write the variable directly; null where it may. A command with no origin (no Run issued it) is no instructor's. */
export const instructorOnlyRefusal = (binding: ProcessSignalBinding, origin: CommandOrigin | undefined): string | null => {
  if (binding.actuation === 'command' || origin === 'system') return null
  const what = binding.actuation === 'faultInjection' ? 'a fault the scenario injects' : 'a condition outside the Plant'
  return `${binding.tagId ?? binding.path} is ${what}: only instructor actions and the Scenario set it`
}

// Whether a write demands its equipment on (started, opened, closed in): true, or above zero.
const demandsOn = (value: ProcessVariableValue): boolean => value === true || (typeof value === 'number' && value > 0)

/**
 * How a write stands against what a standing actuation wrote to the same
 * command: null where it does not work against it; 'opposes' for any other
 * value; but where the actuation drove a demand a person sets in its span to
 * its open end and declares a throttle floor, a setting from the floor up is
 * a throttle (null) and one below it is 'belowFloor'.
 */
export const againstActuation = (
  span: DemandSpan | null,
  floor: ProcessPlantIcRule['throttleFloor'],
  actuated: ProcessVariableValue,
  written: ProcessVariableValue,
): 'opposes' | 'belowFloor' | null => {
  if (written === actuated) return null
  if (span === null || floor === undefined || actuated !== span.max || typeof written !== 'number' || written <= span.min) return 'opposes'
  return written < floor.value ? 'belowFloor' : null
}

// The protection actuations that stand active or sealed in, in declaration order, with whether each is active.
const standingActuations = (plant: CompiledProcessPlant, snapshot: ProcessPlantIcSnapshot): ReadonlyArray<{ readonly rule: ProcessPlantIcRule; readonly active: boolean }> => {
  const states = new Map(snapshot.rules.map(state => [state.ruleId, state]))
  return plant.automation.rules.flatMap(rule => {
    if (!rule.enabled || rule.ruleClass !== 'protection' || icRuleKind(rule) !== 'trip') return []
    const state = states.get(rule.id)
    return state === undefined || !(state.active || (rule.latch && state.latched)) ? [] : [{ rule, active: state.active }]
  })
}

// The values a rule writes to a path.
const writtenTo = (plant: CompiledProcessPlant, rule: ProcessPlantIcRule, path: VariablePath): ReadonlyArray<ProcessVariableValue> =>
  rule.effects.flatMap(effect => effect.type === 'writeSignal' && resolveProcessPlantSignalBinding(plant.graph, effect.signal).path === path ? [effect.value] : [])

/**
 * Why a write is refused because a protection actuation that stands active
 * or sealed in wrote the opposite to the same equipment: to its command
 * (againstActuation), or to the isolation input that shuts it whatever its
 * command demands; null where none stands against it.
 */
export const protectionHoldRefusal = (
  plant: CompiledProcessPlant,
  snapshot: ProcessPlantIcSnapshot,
  write: { readonly path: VariablePath; readonly value: ProcessVariableValue },
): string | null => protectionHold(plant, snapshot, write)?.text ?? null

/** The actuation that holds a write, and the sentence that refuses it (protectionHoldRefusal). */
export const protectionHold = (
  plant: CompiledProcessPlant,
  snapshot: ProcessPlantIcSnapshot,
  write: { readonly path: VariablePath; readonly value: ProcessVariableValue },
): { readonly ruleId: string; readonly text: string } | null => {
  const graph = plant.graph
  const isolation = graph.components
    .flatMap(component => [...component.semantics.aspects, ...component.semantics.embedded.flatMap(device => device.aspects)])
    .find(aspect => aspect.command === write.path)?.isolation
  const span = demandSpanOf(graph, write.path)
  const binding = graph.signalBindingByPath.get(write.path)!
  for (const { rule, active } of standingActuations(plant, snapshot)) {
    const judged = writtenTo(plant, rule, write.path).map(value => againstActuation(span, rule.throttleFloor, value, write.value))
    const stands = `${rule.label ?? rule.id} (${actionOf(plant, rule)}) stands ${active ? 'active' : 'sealed in'}`
    if (judged.includes('opposes') || (isolation !== undefined && writtenTo(plant, rule, isolation).some(value => value === true) && demandsOn(write.value))) {
      return { ruleId: rule.id, text: `${stands} and holds ${binding.tagId ?? binding.path}: a command against it is refused until it is reset` }
    }
    if (judged.includes('belowFloor')) {
      return { ruleId: rule.id, text: `${stands}: ${binding.tagId ?? binding.path} is throttled no lower than ${formatQuantity(rule.throttleFloor!.value, binding.unit, demandStepOf(span!))} under it, which ${rule.throttleFloor!.basis}` }
    }
  }
  return null
}

/**
 * Where standing actuations drove a demand to an end: the rules, and how far
 * a person may throttle it under them all (the highest floor they declare),
 * or null where one of them declares none or drove it shut (only its end is
 * accepted). Null where none stands on it.
 */
export const actuationHold = (
  plant: CompiledProcessPlant,
  snapshot: ProcessPlantIcSnapshot,
  path: VariablePath,
): { readonly rules: ReadonlyArray<ControlRule>; readonly floor: { readonly value: number; readonly basis: string } | null } | null => {
  const span = demandSpanOf(plant.graph, path)
  if (span === null) return null
  const holding = standingActuations(plant, snapshot).filter(({ rule }) => writtenTo(plant, rule, path).some(value => value === span.min || value === span.max))
  if (holding.length === 0) return null
  const floors = holding.map(({ rule }) => writtenTo(plant, rule, path).every(value => value === span.max) ? rule.throttleFloor : undefined)
  const declared = floors.filter((floor): floor is NonNullable<typeof floor> => floor !== undefined)
  const floor = declared.length < floors.length ? null : declared.reduce((highest, candidate) => candidate.value > highest.value ? candidate : highest)
  return {
    rules: holding.map(({ rule }) => ({ ruleId: rule.id, label: rule.label ?? rule.id, action: actionOf(plant, rule) })),
    floor: floor === null ? null : { value: floor.value, basis: floor.basis },
  }
}

/**
 * The standing actuations a write throttles: those that drove its demand to
 * an end of its span, while it sets a value strictly between the ends
 * (againstActuation lets it through from their floor up); none for any
 * other write. The
 * operations log records an accepted write with them, and controls.list
 * names them while the demand stands between.
 */
export const throttledUnder = (
  plant: CompiledProcessPlant,
  snapshot: ProcessPlantIcSnapshot,
  write: { readonly path: VariablePath; readonly value: ProcessVariableValue },
): ReadonlyArray<ControlRule> => {
  const span = demandSpanOf(plant.graph, write.path)
  if (span === null || typeof write.value !== 'number' || write.value <= span.min || write.value >= span.max) return []
  return standingActuations(plant, snapshot)
    .filter(({ rule }) => writtenTo(plant, rule, write.path).some(value => value === span.min || value === span.max))
    .map(({ rule }) => ({ ruleId: rule.id, label: rule.label ?? rule.id, action: actionOf(plant, rule) }))
}

/**
 * A person's, an AI agent's or the Run's control write as the Plant accepts
 * it: the I&C's own validation, then what the origin may write, then the
 * protection actuations standing against it. The Run itself is held by
 * neither guard. control.validate judges a write as a person's or an agent's.
 */
export const validateOperatorWrite = (config: {
  readonly system: CompiledProcessPlant
  readonly runtime: ProcessPlantRuntime
  readonly protection?: ProcessPlantProtectionRunner
  readonly payload: ProcessPlantControlWritePayload
  readonly origin: CommandOrigin | undefined
}): ProcessPlantControlWriteValidation => {
  const validation = validateProcessPlantControlWrite(config)
  if (!validation.accepted) return validation
  const binding = config.system.graph.signalBindingByPath.get(validation.targetPath)!
  const holding = (): string | null => {
    if (config.origin === 'system' || config.protection === undefined) return null
    const snapshot = config.protection.snapshot()
    const hold = protectionHold(config.system, snapshot, { path: validation.targetPath, value: config.payload.value })
    if (hold === null) return null
    // The hold sentence says whether the actuation may be reset now, and why not.
    const resets = actuationResets(config.system, snapshot, {
      holds: condition => evaluateProcessPlantIcCondition({ system: config.system, runtime: config.runtime, condition }).matches,
      elapsedMs: config.runtime.elapsedMs(),
    })
    return `${hold.text}${resetClause(resets.find(reset => reset.ruleId === hold.ruleId))}`
  }
  const refusal = instructorOnlyRefusal(binding, config.origin) ?? holding()
  if (refusal === null) return validation
  return { accepted: false, reason: refusal, signal: validation.signal, targetPath: validation.targetPath, currentValue: validation.currentValue }
}
