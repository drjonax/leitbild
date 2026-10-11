import type { ProcessPlantIcRule } from '../runtime/index.ts'
import { alarm, annunciator, comparison, rule, trip, write } from './reference-ic-helpers.ts'
import type { ProcessPlantReferenceLoop } from './reference-loop.ts'

// Containment pressure ladder, absolute, at the gauge set points of the
// standard technical specifications (NUREG-1431 Table 3.3.2-1, bracketed
// allowable values): about atmospheric, 0.101 MPa, in operation; the
// high-pressure alarm at 0.110 MPa (1.2 psig), clear of normal and below
// every actuation; Hi-1 at 0.128 MPa (3.86 psig) actuates safety injection,
// which trips the reactor (reference-ic-safety-injection.ts); Hi-2 at
// 0.147 MPa (6.61 psig) isolates the main steam lines; Hi-3 at 0.186 MPa
// (12.31 psig) starts containment spray. Each actuation seals in: what it
// starts runs and what it shuts stays shut until operators act.
const highPressureAlarmMPa = 0.110
export const containmentPressureHigh1MPa = 0.128
const containmentPressureHigh2MPa = 0.147
const containmentPressureHigh3MPa = 0.186

const containmentAlarm = annunciator({
  system: 'containment',
  equipmentId: 'containment',
  group: 'containment',
  priority: 'high',
  role: 'symptom',
})

export const containmentReferenceIcRules = (loops: ReadonlyArray<ProcessPlantReferenceLoop>): ReadonlyArray<ProcessPlantIcRule> => [
  rule({
    id: 'containment-pressure-high',
    label: 'Containment pressure high',
    ruleClass: 'alarm',
    condition: comparison({ tagId: 'CTMT-PR' }, '>', highPressureAlarmMPa),
    clearCondition: comparison({ tagId: 'CTMT-PR' }, '<', 0.107),
    clearDelayMs: 2_000,
    // No longer than the actuations above it wait, so a fast rise never shows them first.
    delayMs: 1_000,
    latch: false,
    resetWhenClear: true,
    effects: [alarm({
      id: 'pressure-high',
      title: 'Containment pressure high',
      message: `Containment pressure is above ${highPressureAlarmMPa} MPa (1.2 psig), below the ${containmentPressureHigh1MPa} MPa Hi-1 safety injection set point.`,
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
    id: 'containment-pressure-high-2-steam-line-isolation',
    label: 'Steam line isolation on containment pressure Hi-2',
    ruleClass: 'protection',
    // The standard technical specifications' modes 1 to 3, where the steam lines are open.
    modes: ['powerOperation', 'startup', 'hotStandby'],
    condition: comparison({ tagId: 'CTMT-PR' }, '>', containmentPressureHigh2MPa),
    delayMs: 1_000,
    effects: [
      trip({
        id: 'steam-line-isolation',
        title: 'Steam line isolation on containment pressure Hi-2',
        message: `Containment pressure is above Hi-2, ${containmentPressureHigh2MPa} MPa (6.61 psig): every main steam isolation valve shuts.`,
        actuates: ['steamLineIsolation'],
        annunciator: annunciator({ system: 'mainSteam', equipmentId: 'mainSteamHeader', group: 'main-steam', priority: 'urgent', role: 'automaticAction' }),
      }),
      ...loops.map(loop => write(`shut-main-steam-isolation-valve-${loop.toLowerCase()}`, { tagId: `MSIV-${loop}` }, 0)),
    ],
  }),
  rule({
    id: 'containment-pressure-high-3-spray',
    label: 'Containment spray on containment pressure Hi-3',
    ruleClass: 'protection',
    modes: ['powerOperation', 'startup', 'hotStandby', 'hotShutdown'],
    condition: comparison({ tagId: 'CTMT-PR' }, '>', containmentPressureHigh3MPa),
    delayMs: 1_000,
    effects: [
      trip({
        id: 'containment-spray',
        title: 'Containment spray on containment pressure Hi-3',
        message: `Containment pressure is above Hi-3, ${containmentPressureHigh3MPa} MPa (12.31 psig): both containment spray pumps start.`,
        actuates: ['containmentSpray'],
        annunciator: annunciator({ ...containmentAlarm, equipmentId: 'containmentSprayHeader', group: 'containment-spray', priority: 'urgent', role: 'automaticAction' }),
      }),
      write('start-containment-spray-pump-a', { tagId: 'CSPRAY-A' }, true),
      write('start-containment-spray-pump-b', { tagId: 'CSPRAY-B' }, true),
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
