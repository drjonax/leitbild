/**
 * T01 (plan v3.1 Appendix F): what today's display path offers a person and an
 * agent, read at the Capability boundary from deterministic Plant states, as
 * plain facts. The same facts are what the new display path must produce
 * (T39 action parity); a driver for it reads the same states into the same
 * shape, and display-characterization.test.ts compares both with the golden
 * record in tests/fixtures/display-characterization/old-path.json.
 *
 * Facts, per state:
 * - element actions: for the equipment three reference mimics draw, the
 *   controls.list derivation (option words, holds, throttles, withheld
 *   reasons) and the latched actuations' resets;
 * - chips: for a reference display's values, the chip an active limit draws
 *   (chipName of activeThreshold, as the faceplate, legend and readouts do);
 * - procedure tag displays: what a procedure tag opens (title, equipment,
 *   view kind, panel kinds).
 */
import type { IsoTimestamp } from '../../src/core/model/index.ts'
import {
  answerProcessPlantQuery,
  commandsForProcessPlantAction,
  compileProcessPlant,
  createProcessPlantProtectionRunner,
  createProcessPlantRampRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
  type CompiledProcessPlant,
} from '../../src/packs/process-plant/index.ts'
import { createProcessPlantRuntimePerformance, type ProcessPlantRuntimeInstance } from '../../src/packs/process-plant/runtime-instance.ts'
import { createPlantOperations } from '../../src/packs/process-plant/operations/plant-operations.ts'
import { composedPanelPens, type CompiledComposedDisplay } from '../../src/packs/process-plant/displays/compose.ts'
import { activeThreshold } from '../../src/packs/process-plant/displays/trend-reading.ts'
import { chipName } from '../../src/packs/process-plant/displays/display-text.ts'
import { sampledGates } from '../../src/ui/embed/composed-display/panel-presenters.ts'
import type { PackProcedureTagValidation } from '../../src/core/packs/protocol.ts'

export const PLANT_ID = 'plant:characterization'
const SIMULATION_TIME = '2026-10-20T10:00:00.000Z' as IsoTimestamp
const VIEW_SIZE = { width: 1280, height: 800 }

/** A Plant state the facts are read in: a fault (or none) played for a number of simulated seconds after a 5 s settle. */
export interface CharacterizationState {
  readonly id: string
  readonly action?: { readonly actionId: string; readonly parameters?: Record<string, unknown> }
  readonly seconds: number
}

export const STATES: ReadonlyArray<CharacterizationState> = [
  { id: 'steady', seconds: 10 },
  { id: 'loss-main-feedwater+120s', action: { actionId: 'loss-main-feedwater' }, seconds: 120 },
  { id: 'loss-offsite-power+60s', action: { actionId: 'loss-offsite-power' }, seconds: 60 },
  { id: 'porv-open-35+120s', action: { actionId: 'pressurizer-relief-open', parameters: { positionPercent: 35 } }, seconds: 120 },
]

/** Mimics an agent wrote in the evaluation runs, each drawing equipment people operate. */
export const REFERENCE_MIMICS: ReadonlyArray<Record<string, unknown>> = [
  { around: ['auxFeedwaterValveA'] },
  { from: ['pressurizer'], to: ['pressurizerReliefTank'], services: ['primaryRelief'] },
  { from: ['dieselGeneratorA'], to: ['auxFeedwaterPumpMotor'], services: ['electricalPower'] },
  { around: ['mainSteamIsolationValveA'] },
]

/** The values whose chips are read: levels, pressures, power, an electrical bus and AFW flow. */
export const CHIP_SIGNALS: ReadonlyArray<string> = ['SG-A-LVL-NR', 'SG-B-LVL-NR', 'SG-A-PRESS', 'PT-455', 'PZR-LVL', 'TAVG', 'NIS-PR-AVG', 'BUS-A-VOLTAGE', 'AFW-FLOW', 'SUB-MARGIN']

/** Tags procedures name: measured ones, a breaker, an absent one. */
export const PROCEDURE_TAGS: ReadonlyArray<string> = ['PT-455', 'NIS-PR-AVG', 'SG-B-LVL-NR', 'AFW-FLOW', 'MSIV-A-POS', 'TRIP-BKR-A', 'DG-A', 'SI-SIG']

let compiled: CompiledProcessPlant | undefined
const plantModel = (): CompiledProcessPlant => compiled ??= compileProcessPlant(createPwrReferencePlantDefinition({ id: PLANT_ID, loopCount: 4 }))

/** A fresh 4-loop reference Plant played into the state, deterministically (1 s steps, protection evaluated each step). */
export const plantIn = (state: CharacterizationState): ProcessPlantRuntimeInstance => {
  const plant = plantModel()
  const runtime = createProcessPlantRuntime({ system: plant })
  const protection = createProcessPlantProtectionRunner({ system: plant, protection: plant.automation })
  const step = () => {
    runtime.tick(1_000)
    protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-characterization' as never, sourceRuntimeId: 'process-plant.local' })
  }
  for (let second = 0; second < 5; second += 1) step()
  if (state.action !== undefined) {
    for (const command of commandsForProcessPlantAction({ actionId: state.action.actionId, parameters: state.action.parameters ?? {}, graph: plant.graph })) {
      runtime.writeCommand({ type: 'setVariable', path: command.path, value: command.value })
    }
  }
  for (let second = 0; second < state.seconds; second += 1) step()
  return { plant, runtime, ramps: createProcessPlantRampRunner({ runtime }), protection, operations: createPlantOperations(), performance: createProcessPlantRuntimePerformance() }
}

const askOf = (instance: ProcessPlantRuntimeInstance) => <T,>(capabilityId: string, input: unknown): T => answerProcessPlantQuery({
  request: { capabilityId, input },
  plants: new Map([[PLANT_ID, instance]]),
  objects: new Map(),
  simulationTime: SIMULATION_TIME,
  recordedSeriesIds: new Set(),
}) as T

const composition = (title: string, panels: ReadonlyArray<Record<string, unknown>>, subjects: ReadonlyArray<string>) => ({
  plantId: PLANT_ID, title, question: 'What does the characterization display show?', need: 'Pin what today\'s display path offers.', subjects, panels,
})

export interface ElementActionFacts {
  readonly mimic: Record<string, unknown>
  readonly drawn: ReadonlyArray<string>
  readonly items: ReadonlyArray<unknown>
  readonly refused?: string
}

/** For each reference mimic: what it draws, and what controls.list offers on those items. */
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

const elementActions = (ask: ReturnType<typeof askOf>): ReadonlyArray<ElementActionFacts> => REFERENCE_MIMICS.map(mimic => {
  const subjects = [...((mimic.around ?? mimic.from ?? []) as ReadonlyArray<string>)]
  let composed: { readonly equipment: ReadonlyArray<{ readonly id: string; readonly state?: string }> }
  try {
    composed = ask('world.process-plant.display.compose', composition('Characterization mimic', [{ kind: 'mimic', ...mimic }], subjects))
  } catch (error) {
    return { mimic, drawn: [], items: [], refused: messageOf(error) }
  }
  const drawn = composed.equipment.map(entry => entry.id)
  try {
    const listed = ask<{ readonly items: ReadonlyArray<any> }>('world.process-plant.controls.list', { plantId: PLANT_ID, items: drawn })
    return {
      mimic,
      drawn: composed.equipment.map(entry => `${entry.id}:${entry.state ?? '-'}`),
      items: listed.items.map(item => ({
        id: item.id,
        offered: (item.offered as ReadonlyArray<any>).map(listedControl => ({
          tagId: listedControl.control?.tagId ?? null,
          form: listedControl.control?.form ?? null,
          now: listedControl.now ?? null,
          throttledUnder: (listedControl.throttledUnder ?? []).map((rule: { label: string }) => rule.label),
          options: ((listedControl.control?.options ?? []) as ReadonlyArray<any>).map((option, index) => ({
            word: option.word,
            consequences: (option.consequences ?? []).map((rule: { label: string }) => rule.label),
            heldBy: listedControl.standing?.[index]?.heldBy?.label ?? null,
          })),
        })),
        withheld: item.withheld ?? [],
      })),
    }
  } catch (error) {
    return { mimic, drawn, items: [], refused: messageOf(error) }
  }
})

/** The latched actuations and whether their reset is offered, as controls.list states them. */
const resets = (ask: ReturnType<typeof askOf>): ReadonlyArray<unknown> =>
  ask<{ readonly resets: ReadonlyArray<any> }>('world.process-plant.controls.list', { plantId: PLANT_ID }).resets
    .map(reset => ({ ruleId: reset.ruleId, label: reset.label, offered: reset.offered, ...(reset.reason === undefined ? {} : { reason: reset.reason }) }))

/** The chip each reference value draws now: null where no limit in force is active. */
const chips = (ask: ReturnType<typeof askOf>): Record<string, string | null> => {
  // A readouts panel shows at most 6 values: the reference values go on displays of 5.
  const groups = [CHIP_SIGNALS.slice(0, 5), CHIP_SIGNALS.slice(5)]
  const pens = groups.flatMap(group => {
    const panel = { kind: 'readouts', signals: group.map((ref, index) => ({ ref, role: index === 0 ? 'primary' : 'context' })) }
    const composed = ask<{ readonly view: { readonly state: string } }>('world.process-plant.display.compose', composition('Characterization values', [panel], [group[0]!]))
    const view = ask<{ readonly display: CompiledComposedDisplay }>('world.process-plant.display.view', { plantId: PLANT_ID, state: composed.view.state, size: VIEW_SIZE })
    return view.display.panels.flatMap(composedPanelPens)
  })
  const sample = ask<{ readonly values: ReadonlyArray<{ path: string; value: unknown }>; readonly alarms?: ReadonlyArray<{ ruleId: string; active: boolean }>; readonly mode?: never }>(
    'world.process-plant.display.sample', { plantId: PLANT_ID, paths: [...new Set(pens.map(pen => String(pen.path)))], alarms: true })
  const activeRuleIds = new Set((sample.alarms ?? []).filter(alarm => alarm.active).map(alarm => alarm.ruleId))
  const gates = sampledGates(sample as never)
  return Object.fromEntries(CHIP_SIGNALS.map(ref => {
    const pen = pens.find(entry => entry.ref === ref || entry.tagId === ref)
    if (pen === undefined) return [ref, 'NOT SHOWN']
    const threshold = activeThreshold(pen.thresholds, activeRuleIds, sample.mode, gates)
    return [ref, threshold === null ? null : chipName(threshold)]
  }))
}

/** What each procedure tag opens: a title, the equipment drawn, the view's kind and panels; null where the tag opens nothing. */
const tagDisplays = (ask: ReturnType<typeof askOf>): Record<string, unknown> => {
  const validated = ask<{ readonly tags: ReadonlyArray<PackProcedureTagValidation> }>('world.process-plant.procedure-tags.validate', { plantId: PLANT_ID, tags: PROCEDURE_TAGS.map(id => ({ id })) })
  return Object.fromEntries(validated.tags.map(tag => {
    // Today's tag display, as the Plant named it until the swap: the detail around the equipment the tag is measured on.
    if (tag.measuredOn === undefined) return [tag.id, { status: tag.status, opens: null }]
    const label = typeof tag.signal?.label === 'string' ? tag.signal.label : null
    const state = JSON.stringify({ detail: { plantId: PLANT_ID, components: [tag.measuredOn] } })
    const query = { capabilityId: 'world.process-plant.display.view', input: { plantId: PLANT_ID, state, size: VIEW_SIZE } }
    const facts = { status: tag.status, title: label === null ? tag.id : `${tag.id}: ${label}`, state: JSON.parse(state) }
    try {
      const view = ask<{ readonly kind: string; readonly display: { readonly panels: ReadonlyArray<{ readonly kind: string }> } }>(query.capabilityId, query.input)
      return [tag.id, { ...facts, kind: view.kind, panels: view.display.panels.map(panel => panel.kind) }]
    } catch (error) {
      return [tag.id, { ...facts, refused: messageOf(error) }]
    }
  }))
}

export interface StateFacts {
  readonly elementActions: ReadonlyArray<ElementActionFacts>
  readonly resets: ReadonlyArray<unknown>
  readonly chips: Record<string, string | null>
  readonly tagDisplays?: Record<string, unknown>
}

/** Every fact the old path gives in one state; tag displays only in the steady state (they open equipment, not a state). */
export const observeOldPath = (state: CharacterizationState): StateFacts => {
  const ask = askOf(plantIn(state))
  return {
    elementActions: elementActions(ask),
    resets: resets(ask),
    chips: chips(ask),
    ...(state.id === 'steady' ? { tagDisplays: tagDisplays(ask) } : {}),
  }
}
