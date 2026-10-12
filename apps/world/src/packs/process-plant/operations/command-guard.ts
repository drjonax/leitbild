import type { ProcessSignalBinding, ProcessVariableValue, VariablePath } from '../graph/index.ts'
import type { CommandOrigin } from '../../../simulation/protocol.ts'
import {
  processPlantActionInvokeCommandKind,
  processPlantControlRampCommandKind,
  processPlantControlWriteCommandKind,
  processPlantIcLifecycleCommandKind,
} from '../command-kinds.ts'
import type { ProcessPlantControlWritePayload } from '../commands.ts'
import type { ProcessPlantUnitPackData } from '../model.ts'
import { validateProcessPlantControlWrite, type ProcessPlantControlWriteValidation } from '../control-write-validation.ts'
import { actionOf, icRuleKind } from '../displays/ic-thresholds.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import type { ProcessPlantIcRule, ProcessPlantIcSnapshot, ProcessPlantProtectionRunner, ProcessPlantRuntime } from '../runtime/index.ts'
import { resolveProcessPlantSignalBinding } from '../signals.ts'
import type { ControlRule } from './controls.ts'
import { demandSpanOf, type DemandSpan } from './demand-span.ts'

// What a command's origin may write, beyond what the I&C validates for
// everyone (control-write-validation.ts):
// - On a Plant that does not opt into direct AI operation, an AI agent
//   proposes and a person approves: its direct writes, ramps, instructor
//   actions and alarm lifecycle changes are refused (plan-final QA-1). It
//   may read, validate and propose.
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
//   in its span (a modulating valve's position) to one end, only the other
//   end works against it: a setting between is a throttle under it (AFW
//   flow controlled after AFW opened its valves), recorded as such. Nothing
//   rewrites the demand after the actuation's edge, so the throttle holds
//   until an actuation enters again.

/** The commands an AI agent issues on a propose-only Plant only through a person's approval. */
export const aiDirectCommandKinds: ReadonlySet<string> = new Set([
  processPlantControlWriteCommandKind,
  processPlantControlRampCommandKind,
  processPlantActionInvokeCommandKind,
  processPlantIcLifecycleCommandKind,
])

/** Why an AI agent may not issue this command on this Plant itself; null where it may, or the origin is no AI agent's. */
export const aiProposeOnlyRefusal = (kind: string, origin: CommandOrigin | undefined, aiOperation: ProcessPlantUnitPackData['aiOperation']): string | null =>
  origin === 'ai' && aiOperation !== 'direct' && aiDirectCommandKinds.has(kind)
    ? 'An AI agent proposes operations on this Plant for a person to approve (world.process-plant.control.propose); it does not operate it directly'
    : null

/** Why this origin may not write the variable directly; null where it may. A command with no origin (no Run issued it) is no instructor's. */
export const instructorOnlyRefusal = (binding: ProcessSignalBinding, origin: CommandOrigin | undefined): string | null => {
  if (binding.actuation === 'command' || origin === 'system') return null
  const what = binding.actuation === 'faultInjection' ? 'a fault the scenario injects' : 'a condition outside the Plant'
  return `${binding.tagId ?? binding.path} is ${what}: only instructor actions and the Scenario set it`
}

// Whether a write demands its equipment on (started, opened, closed in): true, or above zero.
const demandsOn = (value: ProcessVariableValue): boolean => value === true || (typeof value === 'number' && value > 0)

/**
 * Whether a write works against what a standing actuation wrote to the same
 * command: any other value; but where the actuation drove a demand a person
 * sets in its span to one end, only the other end. A two-state command, or a
 * demand the actuation set between its ends, keeps the first rule.
 */
export const opposesActuation = (span: DemandSpan | null, actuated: ProcessVariableValue, written: ProcessVariableValue): boolean => {
  if (span === null || (actuated !== span.min && actuated !== span.max)) return written !== actuated
  return written === (actuated === span.min ? span.max : span.min)
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
 * (opposesActuation), or to the isolation input that shuts it whatever its
 * command demands; null where none stands against it.
 */
export const protectionHoldRefusal = (
  plant: CompiledProcessPlant,
  snapshot: ProcessPlantIcSnapshot,
  write: { readonly path: VariablePath; readonly value: ProcessVariableValue },
): string | null => {
  const graph = plant.graph
  const isolation = graph.components
    .flatMap(component => [...component.semantics.aspects, ...component.semantics.embedded.flatMap(device => device.aspects)])
    .find(aspect => aspect.command === write.path)?.isolation
  const span = demandSpanOf(graph, write.path)
  for (const { rule, active } of standingActuations(plant, snapshot)) {
    const holds = writtenTo(plant, rule, write.path).some(value => opposesActuation(span, value, write.value))
      || (isolation !== undefined && writtenTo(plant, rule, isolation).some(value => value === true) && demandsOn(write.value))
    if (!holds) continue
    const binding = graph.signalBindingByPath.get(write.path)!
    return `${rule.label ?? rule.id} (${actionOf(plant, rule)}) stands ${active ? 'active' : 'sealed in'} and holds ${binding.tagId ?? binding.path}: a command against it is refused until it is reset`
  }
  return null
}

/**
 * The standing actuations a write throttles: those that drove its demand to
 * an end of its span, while it sets a value strictly between the ends
 * (opposesActuation lets it through); none for any other write. The
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
  const refusal = instructorOnlyRefusal(binding, config.origin)
    ?? (config.origin === 'system' || config.protection === undefined ? null
      : protectionHoldRefusal(config.system, config.protection.snapshot(), { path: validation.targetPath, value: config.payload.value }))
  if (refusal === null) return validation
  return { accepted: false, reason: refusal, signal: validation.signal, targetPath: validation.targetPath, currentValue: validation.currentValue }
}
