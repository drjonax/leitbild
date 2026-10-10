import type { ProcessPlantIcRule } from '../runtime/index.ts'
import type { ProcessPlantReferenceLoop } from './reference-loop.ts'
import { alarm, all, annunciator, comparison, reactorTripBreakerWrites, rule, trip, vote, write } from './reference-ic-helpers.ts'

const reactorAlarm = annunciator({
  system: 'reactorProtection',
  equipmentId: 'core',
  group: 'reactor-protection',
  priority: 'urgent',
  role: 'symptom',
})

const reactorAction = annunciator({
  system: 'reactorProtection',
  equipmentId: 'core',
  group: 'reactor-protection',
  firstOutGroup: 'reactor-trip',
  priority: 'urgent',
  role: 'automaticAction',
})

const lowRcpFlowVoteThresholdFor = (loops: ReadonlyArray<ProcessPlantReferenceLoop>): number =>
  Math.max(1, Math.ceil(loops.length * 0.75))

const lowRcpFlowTripThresholdKgPerS = 3_000

// P-9: above half of the reference core's 3,400 MW rated power the steam
// dumps cannot take the whole load a turbine trip rejects, so the turbine
// trip trips the reactor. Below it the reactor rides the trip out.
const p9PowerMw = 1_700

export const reactorReferenceIcRules = (
  loops: ReadonlyArray<ProcessPlantReferenceLoop>,
): ReadonlyArray<ProcessPlantIcRule> => [
  rule({
    id: 'reactor-power-high',
    label: 'Reactor power high',
    ruleClass: 'alarm',
    condition: comparison({ path: 'core.powerMw' }, '>', 3_600),
    clearCondition: comparison({ path: 'core.powerMw' }, '<', 3_500),
    clearDelayMs: 1_000,
    delayMs: 1_000,
    effects: [alarm({
      id: 'power-high',
      title: 'Reactor power high',
      message: 'Core fission power is above the reference high-power threshold.',
      severity: 'critical',
      annunciator: reactorAlarm,
    })],
  }),
  rule({
    id: 'reactor-high-power-trip',
    label: 'Reactor high-power trip',
    ruleClass: 'protection',
    condition: comparison({ path: 'core.powerMw' }, '>', 3_750),
    delayMs: 1_000,
    effects: [
      trip({
        id: 'high-power-trip',
        title: 'Reactor high-power trip',
        message: 'Core fission power is above the reference trip threshold.',
        annunciator: reactorAction,
      }),
      ...reactorTripBreakerWrites('high-power-trip'),
      write('insert-control-rods', { path: 'core.rodInsertionFraction' }, 1),
    ],
  }),
  rule({
    id: 'reactor-low-primary-flow-trip',
    label: 'Reactor low primary flow trip',
    ruleClass: 'protection',
    modes: ['powerOperation'],
    condition: comparison({ path: 'vessel.netInventoryFlowKgPerS' }, '<', -250),
    delayMs: 2_000,
    effects: [
      trip({
        id: 'low-flow-trip',
        title: 'Reactor low-flow trip',
        message: 'Primary inventory loss exceeds the reference low-flow trip threshold.',
        annunciator: reactorAction,
      }),
      ...reactorTripBreakerWrites('low-flow-trip'),
      write('insert-control-rods-low-flow', { path: 'core.rodInsertionFraction' }, 1),
    ],
  }),
  rule({
    id: 'reactor-turbine-trip',
    label: 'Reactor trip on turbine trip',
    ruleClass: 'protection',
    // In power operation, so the turbine trip a reactor trip itself causes does not trip it again.
    modes: ['powerOperation'],
    // The stop valve closed and power above P-9, as the RPS logic ANDs them.
    condition: all([
      comparison({ tagId: 'TURB-STOP-POS' }, '<', 0.05),
      comparison({ path: 'core.powerMw' }, '>', p9PowerMw),
    ]),
    effects: [
      trip({
        id: 'turbine-trip-reactor-trip',
        title: 'Reactor trip on turbine trip',
        message: `The turbine stop valve closed with reactor power above P-9 (${p9PowerMw} MW, half of rated).`,
        annunciator: reactorAction,
      }),
      ...reactorTripBreakerWrites('turbine-trip'),
      write('insert-control-rods-turbine-trip', { path: 'core.rodInsertionFraction' }, 1),
    ],
  }),
  rule({
    id: 'reactor-low-rcp-flow-trip',
    label: 'Reactor low reactor coolant pump flow trip',
    ruleClass: 'protection',
    modes: ['powerOperation'],
    condition: vote(lowRcpFlowVoteThresholdFor(loops), loops.map(loop => comparison({ path: `rcp${loop}.loopFlowKgPerS` }, '<', lowRcpFlowTripThresholdKgPerS))),
    delayMs: 2_000,
    effects: [
      trip({
        id: 'low-rcp-flow-trip',
        title: 'Reactor low RCP flow trip',
        message: `${lowRcpFlowVoteThresholdFor(loops)} or more reactor coolant pump loops are below ${lowRcpFlowTripThresholdKgPerS} kg/s.`,
        annunciator: reactorAction,
      }),
      ...reactorTripBreakerWrites('low-rcp-flow-trip'),
      write('insert-control-rods-low-rcp-flow', { path: 'core.rodInsertionFraction' }, 1),
    ],
  }),
]
