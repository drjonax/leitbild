import type { ProcessPlantIcRule } from '../runtime/index.ts'
import { alarm, annunciator, comparison, reactorTripBreakerWrites, rule, trip, write } from './reference-ic-helpers.ts'

const containmentAlarm = annunciator({
  system: 'containment',
  equipmentId: 'containment',
  group: 'containment',
  priority: 'high',
  role: 'symptom',
})

export const containmentReferenceIcRules = (): ReadonlyArray<ProcessPlantIcRule> => [
  rule({
    id: 'containment-pressure-high',
    label: 'Containment pressure high',
    ruleClass: 'alarm',
    condition: comparison({ path: 'containment.pressureMPa' }, '>', 0.18),
    clearCondition: comparison({ path: 'containment.pressureMPa' }, '<', 0.16),
    clearDelayMs: 2_000,
    delayMs: 2_000,
    latch: false,
    resetWhenClear: true,
    effects: [alarm({
      id: 'pressure-high',
      title: 'Containment pressure high',
      message: 'Containment pressure is above the reference high-pressure threshold.',
      severity: 'warning',
      annunciator: containmentAlarm,
    })],
  }),
  rule({
    id: 'containment-radiation-high',
    label: 'Containment radiation high',
    ruleClass: 'alarm',
    condition: comparison({ path: 'containment.radiationSourceTermMSvPerH' }, '>', 0.5),
    delayMs: 2_000,
    effects: [alarm({
      id: 'radiation-high',
      title: 'Containment radiation high',
      message: 'Containment radiation source term is above the reference alarm threshold.',
      severity: 'critical',
      annunciator: annunciator({ ...containmentAlarm, priority: 'urgent', role: 'cause' }),
    })],
  }),
  rule({
    id: 'containment-pressure-high-reactor-trip',
    label: 'Containment pressure high reactor trip',
    ruleClass: 'protection',
    modes: ['powerOperation'],
    condition: comparison({ path: 'containment.pressureMPa' }, '>', 0.24),
    delayMs: 1_000,
    effects: [
      trip({
        id: 'containment-high-pressure-reactor-trip',
        title: 'Containment high-pressure reactor trip',
        message: 'Containment pressure is above the reference reactor-trip threshold.',
        annunciator: annunciator({ ...containmentAlarm, priority: 'urgent', role: 'automaticAction', firstOutGroup: 'containment-isolation' }),
      }),
      ...reactorTripBreakerWrites('containment-pressure-trip'),
      write('insert-control-rods-containment-pressure', { path: 'core.rodInsertionFraction' }, 1),
    ],
  }),
  rule({
    id: 'containment-sump-inventory-high',
    label: 'Containment sump inventory high',
    ruleClass: 'alarm',
    condition: comparison({ path: 'containment.sumpInventoryKg' }, '>', 20_000),
    clearCondition: comparison({ path: 'containment.sumpInventoryKg' }, '<', 18_000),
    clearDelayMs: 2_000,
    delayMs: 2_000,
    latch: false,
    resetWhenClear: true,
    effects: [alarm({
      id: 'sump-high',
      title: 'Containment sump inventory high',
      message: 'Containment sump inventory is above the reference high-inventory threshold.',
      severity: 'warning',
      annunciator: containmentAlarm,
    })],
  }),
]
