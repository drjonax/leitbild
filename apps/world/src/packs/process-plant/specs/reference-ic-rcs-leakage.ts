import type { ProcessPlantIcRule } from '../runtime/index.ts'
import { alarm, annunciator, comparison, rule } from './reference-ic-helpers.ts'

// RCS leakage from the RCS water inventory balance (RCS-LEAK-RATE): it alarms
// above 1 gpm (0.063 kg/s), the standard technical specifications' limit on
// unidentified leakage (NUREG-1431 LCO 3.4.13), and clears below half of it.
export const rcsLeakRateAlarmKgPerS = 0.063

export const rcsLeakageReferenceIcRules = (): ReadonlyArray<ProcessPlantIcRule> => [
  rule({
    id: 'rcs-leak-rate-high',
    label: 'RCS leak rate high',
    ruleClass: 'alarm',
    condition: comparison({ tagId: 'RCS-LEAK-RATE' }, '>', rcsLeakRateAlarmKgPerS),
    clearCondition: comparison({ tagId: 'RCS-LEAK-RATE' }, '<', rcsLeakRateAlarmKgPerS / 2),
    delayMs: 10_000,
    clearDelayMs: 10_000,
    latch: false,
    resetWhenClear: true,
    effects: [alarm({
      id: 'leak-rate-high',
      title: 'RCS leak rate high',
      message: 'The RCS water inventory balance shows more than 1 gpm (0.063 kg/s) leaving the reactor coolant system by an unmeasured path.',
      severity: 'warning',
      annunciator: annunciator({ system: 'reactorCoolantSystem', equipmentId: 'vessel', group: 'rcs-leakage', priority: 'high', role: 'symptom' }),
    })],
  }),
]
