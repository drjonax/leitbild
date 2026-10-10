import type { ProcessPlantIcRule } from '../runtime/index.ts'
import { alarm, annunciator, comparison, rule } from './reference-ic-helpers.ts'
import type { ProcessPlantReferenceLoop } from './reference-loop.ts'

export const reactorCoolantPumpReferenceIcRules = (loop: ProcessPlantReferenceLoop): ReadonlyArray<ProcessPlantIcRule> => {
  const lower = loop.toLowerCase()
  const rcpAlarm = annunciator({
    system: 'reactorCoolantSystem',
    equipmentId: `rcp${loop}`,
    group: `reactor-coolant-pump-${lower}`,
    priority: 'high',
    role: 'symptom',
  })
  return [
    rule({
      id: `rcp-${lower}-trip`,
      label: `RCP ${loop} not running`,
      ruleClass: 'alarm',
      // The run feedback, so a pump that loses its power alarms though its run command stands.
      condition: comparison({ tagId: `RCP-${loop}-RUNNING` }, '==', false),
      clearCondition: comparison({ tagId: `RCP-${loop}-RUNNING` }, '==', true),
      clearDelayMs: 1_000,
      delayMs: 1_000,
      latch: false,
      resetWhenClear: true,
      effects: [alarm({
        id: 'not-running',
        title: `RCP ${loop} not running`,
        message: `Reactor coolant pump ${loop} is not running.`,
        severity: 'warning',
        annunciator: rcpAlarm,
      })],
    }),
    rule({
      id: `rcp-${lower}-loop-flow-low`,
      label: `RCP ${loop} loop flow low`,
      ruleClass: 'alarm',
      modes: ['powerOperation'],
      condition: comparison({ tagId: `RCP-${loop}-FLOW` }, '<', 2_500),
      clearCondition: comparison({ tagId: `RCP-${loop}-FLOW` }, '>', 2_800),
      clearDelayMs: 1_000,
      delayMs: 2_000,
      latch: false,
      resetWhenClear: true,
      effects: [alarm({
        id: 'loop-flow-low',
        title: `RCP ${loop} loop flow low`,
        message: `Reactor coolant pump ${loop} loop flow is below the reference low-flow threshold.`,
        severity: 'warning',
        annunciator: rcpAlarm,
      })],
    }),
  ]
}
