import type { ProcessSignalBinding, ProcessVariableValue, VariablePath } from '../graph/index.ts'
import type { CommandOrigin } from '../../../simulation/protocol.ts'
import type { ProcessPlantControlWritePayload } from '../commands.ts'
import { validateProcessPlantControlWrite, type ProcessPlantControlWriteValidation } from '../control-write-validation.ts'
import { actionOf, icRuleKind } from '../displays/ic-thresholds.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import type { ProcessPlantIcSnapshot, ProcessPlantProtectionRunner, ProcessPlantRuntime } from '../runtime/index.ts'
import { resolveProcessPlantSignalBinding } from '../signals.ts'

// What a command's origin may write, beyond what the I&C validates for
// everyone (control-write-validation.ts):
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
//   reset it is the operators' again.

/** Why this origin may not write the variable directly; null where it may. A command with no origin (no Run issued it) is no instructor's. */
export const instructorOnlyRefusal = (binding: ProcessSignalBinding, origin: CommandOrigin | undefined): string | null => {
  if (binding.actuation === 'command' || origin === 'system') return null
  const what = binding.actuation === 'faultInjection' ? 'a fault the scenario injects' : 'a condition outside the Plant'
  return `${binding.tagId ?? binding.path} is ${what}: only instructor actions and the Scenario set it`
}

// Whether a write demands its equipment on (started, opened, closed in): true, or above zero.
const demandsOn = (value: ProcessVariableValue): boolean => value === true || (typeof value === 'number' && value > 0)

/**
 * Why a write is refused because a protection actuation that stands active
 * or sealed in wrote the opposite to the same equipment: to its command, or
 * to the isolation input that shuts it whatever its command demands; null
 * where none stands against it.
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
  const states = new Map(snapshot.rules.map(state => [state.ruleId, state]))
  for (const rule of plant.automation.rules) {
    if (!rule.enabled || rule.ruleClass !== 'protection' || icRuleKind(rule) !== 'trip') continue
    const state = states.get(rule.id)
    if (state === undefined || !(state.active || (rule.latch && state.latched))) continue
    const holds = rule.effects.some(effect => {
      if (effect.type !== 'writeSignal') return false
      const path = resolveProcessPlantSignalBinding(graph, effect.signal).path
      return (path === write.path && effect.value !== write.value)
        || (isolation !== undefined && path === isolation && effect.value === true && demandsOn(write.value))
    })
    if (!holds) continue
    const binding = graph.signalBindingByPath.get(write.path)!
    return `${rule.label ?? rule.id} (${actionOf(plant, rule)}) stands ${state.active ? 'active' : 'sealed in'} and holds ${binding.tagId ?? binding.path}: a command against it is refused until it is reset`
  }
  return null
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
