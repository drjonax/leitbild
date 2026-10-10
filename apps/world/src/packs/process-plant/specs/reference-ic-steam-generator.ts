import type { ProcessPlantIcRule } from '../runtime/index.ts'
import { alarm, all, annunciator, any, comparison, rule, trip, write } from './reference-ic-helpers.ts'
import type { ProcessPlantReferenceLoop } from './reference-loop.ts'

// Narrow-range level limits above the 55 % program: a high alarm, and P-14
// high-high, which isolates main feedwater by tripping its pumps and trips the
// turbine (and so, above P-9, the reactor) before water reaches the steam lines.
const levelHighPercent = 75
const levelHighHighPercent = 82

export const steamGeneratorReferenceIcRules = (loop: ProcessPlantReferenceLoop): ReadonlyArray<ProcessPlantIcRule> => {
  const lower = loop.toLowerCase()
  const sg = `sg${loop}`
  const sgAlarm = annunciator({
    system: 'steamGenerators',
    equipmentId: sg,
    group: `steam-generator-${lower}`,
    priority: 'high',
    role: 'symptom',
  })
  const sgAction = annunciator({
    system: 'steamGenerators',
    equipmentId: sg,
    group: `steam-generator-${lower}`,
    priority: 'urgent',
    role: 'automaticAction',
  })
  return [
    rule({
      id: `sg-${lower}-tube-leak-indication`,
      label: `Steam generator ${loop} tube leak indication`,
      ruleClass: 'alarm',
      condition: comparison({ tagId: `SG-${loop}-TUBE-LEAK` }, '>', 0.002),
      effects: [alarm({
        id: 'tube-leak',
        title: `Steam generator ${loop} tube leak indicated`,
        message: `Steam generator ${loop} tube leak fraction is above the reference indication threshold.`,
        severity: 'warning',
        annunciator: sgAlarm,
      })],
    }),
    rule({
      id: `sg-${lower}-secondary-radiation-high`,
      label: `Steam generator ${loop} secondary radiation high`,
      ruleClass: 'alarm',
      condition: comparison({ tagId: `SG-${loop}-N16` }, '>', 0.5),
      delayMs: 1_000,
      effects: [alarm({
        id: 'secondary-radiation-high',
        title: `Steam generator ${loop} secondary radiation high`,
        message: `Steam generator ${loop} secondary radiation is above the reference alarm threshold.`,
        severity: 'critical',
        annunciator: annunciator({ ...sgAlarm, priority: 'urgent', role: 'cause' }),
      })],
    }),
    rule({
      id: `sg-${lower}-level-low`,
      label: `Steam generator ${loop} narrow-range level low`,
      ruleClass: 'alarm',
      condition: comparison({ tagId: `SG-${loop}-LVL-NR` }, '<', 30),
      clearCondition: comparison({ tagId: `SG-${loop}-LVL-NR` }, '>', 35),
      clearDelayMs: 1_000,
      delayMs: 1_000,
      latch: false,
      resetWhenClear: true,
      effects: [alarm({
        id: 'level-low',
        title: `Steam generator ${loop} level low`,
        message: `Steam generator ${loop} narrow-range level is below the reference low-level threshold.`,
        severity: 'warning',
        annunciator: sgAlarm,
      })],
    }),
    rule({
      id: `sg-${lower}-level-low-low-afw-actuation`,
      label: `Steam generator ${loop} low-low level auxiliary feedwater actuation`,
      ruleClass: 'protection',
      condition: comparison({ tagId: `SG-${loop}-LVL-NR` }, '<', 20),
      delayMs: 1_000,
      effects: [
        trip({
          id: 'afw-actuation',
          title: `Steam generator ${loop} low-low level`,
          message: `Steam generator ${loop} low-low level actuates the reference auxiliary feedwater response.`,
          annunciator: sgAction,
        }),
        write('start-motor-afw', { path: 'auxFeedwaterPumpMotor.running' }, true),
        write('start-turbine-afw', { path: 'auxFeedwaterPumpTurbine.running' }, true),
        write(`open-afw-valve-${lower}`, { path: `auxFeedwaterValve${loop}.positionFraction` }, 1),
      ],
    }),
    rule({
      id: `sg-${lower}-level-high`,
      label: `Steam generator ${loop} narrow-range level high`,
      ruleClass: 'alarm',
      condition: comparison({ tagId: `SG-${loop}-LVL-NR` }, '>', levelHighPercent),
      clearCondition: comparison({ tagId: `SG-${loop}-LVL-NR` }, '<', levelHighPercent - 3),
      clearDelayMs: 1_000,
      delayMs: 1_000,
      latch: false,
      resetWhenClear: true,
      effects: [alarm({
        id: 'level-high',
        title: `Steam generator ${loop} level high`,
        message: `Steam generator ${loop} narrow-range level is above the reference high-level threshold.`,
        severity: 'warning',
        annunciator: sgAlarm,
      })],
    }),
    rule({
      id: `sg-${lower}-level-high-high-feedwater-isolation`,
      label: `Steam generator ${loop} high-high level feedwater isolation and turbine trip`,
      ruleClass: 'protection',
      condition: comparison({ tagId: `SG-${loop}-LVL-NR` }, '>', levelHighHighPercent),
      delayMs: 1_000,
      effects: [
        trip({
          id: 'feedwater-isolation',
          title: `Steam generator ${loop} high-high level`,
          message: `Steam generator ${loop} high-high level (P-14) trips the main feedwater pumps and the turbine.`,
          annunciator: sgAction,
        }),
        write('trip-main-feedwater-pump-a', { tagId: 'MFW-PUMP-A-RUN' }, false),
        write('trip-main-feedwater-pump-b', { tagId: 'MFW-PUMP-B-RUN' }, false),
        write('close-turbine-stop-valve', { tagId: 'TURB-STOP' }, 0),
        write('reject-turbine-load', { tagId: 'TURB-LOAD' }, 0),
      ],
    }),
    rule({
      id: `sg-${lower}-pressure-high`,
      label: `Steam generator ${loop} pressure high`,
      ruleClass: 'alarm',
      condition: comparison({ tagId: `SG-${loop}-PRESS` }, '>', 9.3),
      clearCondition: comparison({ tagId: `SG-${loop}-PRESS` }, '<', 9.1),
      clearDelayMs: 1_000,
      delayMs: 1_000,
      latch: false,
      resetWhenClear: true,
      effects: [alarm({
        id: 'pressure-high',
        title: `Steam generator ${loop} pressure high`,
        message: `Steam generator ${loop} pressure is above the reference high-pressure threshold.`,
        severity: 'warning',
        annunciator: sgAlarm,
      })],
    }),
    rule({
      id: `sg-${lower}-feedwater-low`,
      label: `Steam generator ${loop} feedwater flow low`,
      ruleClass: 'alarm',
      condition: all([
        comparison({ path: `${sg}.levelPercent` }, '<', 40),
        comparison({ path: `${sg}.feedwaterFlowKgPerS` }, '<', 150),
      ]),
      clearCondition: any([
        comparison({ path: `${sg}.levelPercent` }, '>', 45),
        comparison({ path: `${sg}.feedwaterFlowKgPerS` }, '>', 180),
      ]),
      clearDelayMs: 2_000,
      delayMs: 3_000,
      latch: false,
      resetWhenClear: true,
      effects: [alarm({
        id: 'feedwater-low',
        title: `Steam generator ${loop} feedwater low`,
        message: `Steam generator ${loop} feedwater flow is low while level is below the reference operating band.`,
        severity: 'warning',
        annunciator: sgAlarm,
      })],
    }),
    rule({
      id: `sg-${lower}-feedwater-flow-low`,
      label: `Steam generator ${loop} feedwater flow low`,
      ruleClass: 'alarm',
      modes: ['powerOperation'],
      condition: comparison({ path: `${sg}.feedwaterFlowKgPerS` }, '<', 150),
      clearCondition: comparison({ path: `${sg}.feedwaterFlowKgPerS` }, '>', 180),
      clearDelayMs: 2_000,
      delayMs: 3_000,
      latch: false,
      resetWhenClear: true,
      effects: [alarm({
        id: 'feedwater-flow-low',
        title: `Steam generator ${loop} feedwater flow low`,
        message: `Steam generator ${loop} feedwater flow is below the reference low-flow threshold.`,
        severity: 'warning',
        annunciator: sgAlarm,
      })],
    }),
  ]
}
