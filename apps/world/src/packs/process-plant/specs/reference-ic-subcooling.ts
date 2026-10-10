import type { ProcessPlantIcRule } from '../runtime/index.ts'
import { alarm, annunciator, comparison, rule } from './reference-ic-helpers.ts'

// RCS subcooling margin (SUB-MARGIN, saturation temperature at pressurizer
// pressure minus mean coolant temperature) at the reference procedures'
// values: 30 °F (16.7 °C) is their minimum margin and RCP trip criterion
// (E-1, ES-0.1, FR-P.1), and zero margin is a saturated RCS (FR-C.1, FR-C.3).
// Each clears 5 °F (2.8 °C) above where it acts, so a margin hovering at a
// limit does not chatter.

const fahrenheitDifferenceInC = (degF: number): number => Math.round((degF / 1.8) * 10) / 10

const minimumMarginC = fahrenheitDifferenceInC(30)
const clearBandC = fahrenheitDifferenceInC(5)

const rcsAlarm = annunciator({
  system: 'reactorCoolantSystem',
  equipmentId: 'vessel',
  group: 'rcs-subcooling',
  priority: 'high',
  role: 'symptom',
})

export const subcoolingReferenceIcRules = (): ReadonlyArray<ProcessPlantIcRule> => [
  rule({
    id: 'rcs-subcooling-margin-low',
    label: 'RCS subcooling margin low',
    ruleClass: 'alarm',
    condition: comparison({ tagId: 'SUB-MARGIN' }, '<', minimumMarginC),
    clearCondition: comparison({ tagId: 'SUB-MARGIN' }, '>', minimumMarginC + clearBandC),
    delayMs: 2_000,
    clearDelayMs: 5_000,
    latch: false,
    resetWhenClear: true,
    effects: [alarm({
      id: 'subcooling-margin-low',
      title: 'RCS subcooling margin low',
      message: `RCS subcooling margin is below ${minimumMarginC} °C (30 °F), the reference procedures' minimum margin and RCP trip criterion.`,
      severity: 'warning',
      annunciator: rcsAlarm,
    })],
  }),
  rule({
    id: 'rcs-subcooling-lost',
    label: 'RCS subcooling lost',
    ruleClass: 'alarm',
    condition: comparison({ tagId: 'SUB-MARGIN' }, '<=', 0),
    clearCondition: comparison({ tagId: 'SUB-MARGIN' }, '>', clearBandC),
    delayMs: 2_000,
    clearDelayMs: 5_000,
    latch: false,
    resetWhenClear: true,
    effects: [alarm({
      id: 'subcooling-lost',
      title: 'RCS subcooling lost',
      message: 'RCS subcooling margin is zero or below: the reactor coolant is at saturation.',
      severity: 'critical',
      annunciator: annunciator({ ...rcsAlarm, priority: 'urgent' }),
    })],
  }),
]
