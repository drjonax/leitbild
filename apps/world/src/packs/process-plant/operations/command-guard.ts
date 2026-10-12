import type { ProcessSignalBinding } from '../graph/index.ts'
import type { CommandOrigin } from '../../../simulation/protocol.ts'

// What a command's origin may write, beyond what the I&C validates for
// everyone (control-write-validation.ts). A fault the scenario injects and a
// condition outside the Plant are the instructor's: people inject them
// through instructor actions, the Scenario timeline writes them directly, and
// neither a person's nor an AI agent's control write or ramp reaches them
// (plan-final S1, QA-3: by the caller's origin, so the shared validator, the
// probe's instructor actions and scenario timelines are unaffected).

/** Why this origin may not write the variable directly; null where it may. A command with no origin (no Run issued it) is no instructor's. */
export const instructorOnlyRefusal = (binding: ProcessSignalBinding, origin: CommandOrigin | undefined): string | null => {
  if (binding.actuation === 'command' || origin === 'system') return null
  const what = binding.actuation === 'faultInjection' ? 'a fault the scenario injects' : 'a condition outside the Plant'
  return `${binding.tagId ?? binding.path} is ${what}: only instructor actions and the Scenario set it`
}
