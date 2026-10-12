import { describe, expect, test } from 'bun:test'
import {
  commandsForProcessPlantAction,
  compilePlantGraph,
  compileProcessPlant,
  createProcessPlantProtectionRunner,
  createProcessPlantRampRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
  processPlantComponentRegistry,
  processPlantOperatingMode,
  type CompiledProcessPlant,
  type PlantGraphSpec,
  type VariablePath,
} from '../src/packs/process-plant/index.ts'
import { createProcessPlantRuntimePerformance } from '../src/packs/process-plant/runtime-instance.ts'
import { conditionBindings } from '../src/packs/process-plant/displays/actuations.ts'
import { compileDetailDisplay, composedPanelPens, type OverviewView } from '../src/packs/process-plant/displays/compose.ts'
import { PROCESS_DISPLAY_SAMPLE_MAX_PATHS } from '../src/packs/process-plant/displays/composition.ts'
import { equipmentKeyValues, plantNowOf } from '../src/packs/process-plant/displays/overview-key-values.ts'
import { compileFaceplate, faceplateEnds, groupStates } from '../src/packs/process-plant/displays/faceplate.ts'
import { faceplateLines, faceplateNow, type CompiledFaceplate, type Faceplate } from '../src/packs/process-plant/displays/faceplate-live.ts'
import { stateTexts } from '../src/packs/process-plant/displays/state-words.ts'
import { evaluateSafetyFunctions } from '../src/packs/process-plant/safety-functions.ts'

// A faceplate is derived from what the model and its I&C declare, never from
// what the reference PWR calls its equipment: the same Plant with every
// component id replaced by an opaque one lays out the same faceplates, row
// for row (the mimic-generality.test.ts pattern). Each column fits the room
// under a detail's drawing at every pinned state.

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:named', loopCount: 4 }))
const opaque = new Map(plant.sourceGraph.components.map((component, index) => [String(component.id), `u${index}`]))

// A component id appears as an id, an equipment id, or the owner of a variable path ("sgB.levelPercent").
const renamedString = (value: string): string => {
  const exact = opaque.get(value)
  if (exact !== undefined) return exact
  const dot = value.indexOf('.')
  const owner = dot > 0 ? opaque.get(value.slice(0, dot)) : undefined
  return owner === undefined ? value : `${owner}${value.slice(dot)}`
}
// Kinds, equipment classes and annunciator groups are vocabulary, not references.
const VOCABULARY = new Set(['kind', 'equipmentClass', 'group', 'system'])
const renamed = <T,>(value: T, key = ''): T => {
  if (typeof value === 'string') return (VOCABULARY.has(key) ? value : renamedString(value)) as T
  if (Array.isArray(value)) return value.map(item => renamed(item)) as T
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, renamed(item, field)])) as T
  return value
}

const anonymous: CompiledProcessPlant = {
  ...plant,
  graph: compilePlantGraph(renamed(plant.sourceGraph) as PlantGraphSpec, processPlantComponentRegistry),
  // Annunciator systems are vocabulary too; one shares its id with a component.
  automation: { ...renamed(plant.automation), annunciatorSystems: plant.automation.annunciatorSystems },
}

/** A Plant run from its operating point after a scenario action, with its protection, and a second one left at the operating point. */
const running = (system: CompiledProcessPlant, seconds: number, actionId: string | null = null) => {
  const runtime = createProcessPlantRuntime({ system })
  const nominal = createProcessPlantRuntime({ system })
  const protection = createProcessPlantProtectionRunner({ system, protection: system.automation })
  // The scenario action finds its equipment by declared role, on either Plant.
  const commands = actionId === null ? [] : commandsForProcessPlantAction({ actionId, parameters: {}, graph: system.graph })
  for (const command of commands) runtime.writeCommand({ type: 'setVariable', path: command.path, value: command.value })
  for (let second = 0; second < seconds; second += 1) {
    runtime.tick(1000)
    protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run' as never, sourceRuntimeId: 'test' })
  }
  return { runtime, nominal, protection }
}

const faceplatesOf = (system: CompiledProcessPlant, run: ReturnType<typeof running>) => {
  const mode = processPlantOperatingMode({ system, runtime: run.runtime, modes: system.automation.operatingModes })?.id ?? null
  const read = (path: string): unknown => run.runtime.readVariable(path as VariablePath)
  const snapshot = run.protection.snapshot()
  // As a display's sample carries them: the annunciated alarms and trips, and each safety function's status.
  const alarms = [...snapshot.alarms, ...snapshot.trips].filter(lifecycle => !lifecycle.shelved && !lifecycle.suppressed && !lifecycle.outOfService && (lifecycle.active || lifecycle.phase === 'clearedUnacknowledged'))
  const live = { mode, read, alarms, functions: evaluateSafetyFunctions(system, run.runtime) }
  return faceplateEnds(system).map(end => {
    const { faceplate } = compileFaceplate(system, end, { mode, read: path => read(path) }, path => run.nominal.readVariable(path))!
    return { faceplate, now: faceplateNow(faceplate, live), active: new Set(alarms.filter(alarm => alarm.active).map(alarm => alarm.ruleId)) }
  })
}

/** Every string in a value, with the named Plant's component ids replaced by opaque ones. */
const withOpaqueIds = <T,>(value: T): T => renamed(value)

/** What a faceplate shows: its layout and how it reads now. */
const shown = (faceplates: ReturnType<typeof faceplatesOf>) => faceplates.map(({ faceplate, now }) => ({ faceplate, now }))

const shownPaths = (faceplate: CompiledFaceplate): ReadonlyArray<string> => faceplate.columns.flatMap(column => column.rows.flatMap(row =>
  row.kind === 'values' ? row.paths
    : row.kind === 'flows' ? row.branches.map(branch => branch.path)
      : row.kind === 'loops' ? row.columns.flatMap(entry => entry.cells.flat())
        : []))

// The pinned states the C1 displays are reviewed at (plan-v3 §5).
const pinned = [
  { name: 'at power', seconds: 30, actionId: null },
  { name: 'turbine trip +2:30', seconds: 150, actionId: 'turbine-trip' },
  { name: 'turbine trip +15:00', seconds: 900, actionId: 'turbine-trip' },
  { name: 'no RCP +10:00', seconds: 600, actionId: 'trip-reactor-coolant-pumps' },
  { name: 'loss of offsite power +2:30', seconds: 150, actionId: 'loss-offsite-power' },
] as const

/** Lines under a column's head at 28 px in the ~450 px under a detail's drawing at Full HD (HF-02). */
const COLUMN_LINES = 15

describe('a faceplate depends on the model and its I&C, not on equipment ids', () => {
  test('only the energy ends get one, sources first', () => {
    expect(faceplateEnds(plant).map(index => plant.graph.components[index]!.semantics.energy.map(role => role.role))).toEqual([['source'], ['sink']])
    const other = plant.graph.components.findIndex(component => component.semantics.energy.every(role => role.role === 'transfer'))
    expect(compileFaceplate(plant, other, { mode: null, read: () => undefined }, () => undefined)).toBeNull()
  })

  test('where the steam goes: every outlet of the circuit feeding the turbine, read wherever the model publishes its flow', () => {
    // The steam generators' relief valves publish no flow in the reference model: they are named, not read. A Plant
    // that publishes their lines' flows reads each by its branch's first equipment in the same row, after the dumps a
    // controller positions and before the safety valve, as the circuit leads to them; nothing names them.
    const outletsOf = (system: CompiledProcessPlant) => {
      const end = faceplateEnds(system).find(index => system.graph.components[index]!.semantics.energy.some(role => role.role === 'sink'))!
      const { faceplate } = compileFaceplate(system, end, { mode: null, read: () => undefined }, () => undefined)!
      return faceplate.columns.flatMap(column => column.rows).find(row => row.kind === 'flows')
    }
    expect(outletsOf(plant)).toMatchObject({ from: 'Main steam', branches: [{ destination: 'Turbine bypass' }, { destination: 'MSSV' }], unmeasured: ['ARV A/B/C/D'] })
    const reliefLines = plant.graph.links.filter(link => plant.graph.components[link.toComponentIndex]!.metadata?.equipmentClass === 'steam-generator-relief-valve')
      .map(link => String(link.variables.find(variable => String(variable.path).endsWith('.flowKgPerS'))!.path))
    expect(reliefLines).toHaveLength(4)
    const published: CompiledProcessPlant = { ...plant, graph: compilePlantGraph({ ...plant.sourceGraph, publishedVariables: [...plant.sourceGraph.publishedVariables, ...reliefLines] } as PlantGraphSpec, processPlantComponentRegistry) }
    const outlets = outletsOf(published)
    expect(outlets?.kind === 'flows' ? outlets.branches.map(branch => branch.destination) : []).toEqual(['Turbine bypass', 'ARV A', 'ARV B', 'ARV C', 'ARV D', 'MSSV'])
    expect(outlets).not.toHaveProperty('unmeasured')
  })

  test('the opaque Plant lays out the same faceplates at its operating point', () => {
    expect(shown(faceplatesOf(anonymous, running(anonymous, 30)))).toEqual(withOpaqueIds(shown(faceplatesOf(plant, running(plant, 30)))))
  }, 60_000)

  test('the opaque Plant reads the same faceplates after a turbine trip from power', () => {
    const named = shown(faceplatesOf(plant, running(plant, 90, 'turbine-trip')))
    expect(named.flatMap(faceplate => faceplate.now.columns.flatMap(column => column.rows)).some(row => row.kind === 'rule' && row.firstOut)).toBe(true)
    expect(shown(faceplatesOf(anonymous, running(anonymous, 90, 'turbine-trip')))).toEqual(withOpaqueIds(named))
  }, 60_000)

  test('a protection column\'s states are exactly what every rule of its group commands: the trip breakers, the turbine stop valve', () => {
    const statesOf = (system: CompiledProcessPlant) => faceplateEnds(system).map(end => {
      const { faceplate } = compileFaceplate(system, end, { mode: null, read: () => undefined }, () => undefined)!
      return faceplate.columns.flatMap(column => column.heads.flatMap((head): ReadonlyArray<VariablePath> => head.kind === 'group' ? groupStates(system, head.group) : []))
    })
    const tags = statesOf(plant).map(paths => paths.map(path => String(plant.graph.signalBindingByPath.get(path)!.tagId)))
    expect(tags).toEqual([['TRIP-BKR-A-POS', 'TRIP-BKR-B-POS'], ['TURB-STOP-POS']])
    expect(statesOf(anonymous)).toEqual(withOpaqueIds(statesOf(plant)))
    // Each is the state of a position its equipment declares, so it reads in that position's words.
    for (const path of statesOf(plant).flat()) {
      const binding = plant.graph.signalBindingByPath.get(path)!
      const owner = plant.graph.components[binding.owner.type === 'component' ? binding.owner.componentIndex : -1]!
      expect(owner.semantics.aspects.some(aspect => aspect.aspect === 'position' && aspect.state?.path === path)).toBe(true)
    }
    const breaker = plant.graph.signalBindingByTagId.get('TRIP-BKR-A-POS' as never)!
    expect(stateTexts(plant.graph, breaker)).toEqual({ on: 'RTB A CLOSED', off: 'RTB A OPEN' })
  })

  test('no signal appears twice on a faceplate', () => {
    for (const { faceplate } of faceplatesOf(plant, running(plant, 30))) {
      const paths = shownPaths(faceplate)
      expect(paths.length).toBe(new Set(paths).size)
    }
  }, 60_000)
})

describe('each faceplate column fits the room under the drawing', () => {
  // Rows that ask for attention: an active rule, a count of rules acting, a failing check, a value an active rule judges.
  const busy = (faceplate: Faceplate, active: ReadonlySet<string>) => {
    const judgedNow = new Set(plant.automation.rules.filter(rule => active.has(rule.id)).flatMap(rule => conditionBindings(plant, rule.condition).map(binding => String(binding.path))))
    return faceplate.columns.map(column => column.rows.filter(row => row.kind === 'rule' || row.kind === 'acting' || row.kind === 'check'
      || (row.kind === 'values' && row.paths.some(path => judgedNow.has(String(path))))).length)
  }
  for (const state of pinned) {
    test(`${state.name}: at most ${COLUMN_LINES} lines per column${state.actionId === null ? ', at most 2 asking for attention' : ''}`, () => {
      for (const { now, active } of faceplatesOf(plant, running(plant, state.seconds, state.actionId))) {
        for (const column of now.columns) expect(faceplateLines(column)).toBeLessThanOrEqual(COLUMN_LINES)
        if (state.actionId === null) for (const count of busy(now, active)) expect(count).toBeLessThanOrEqual(2)
      }
    }, 120_000)
  }
})

describe('an energy end\'s detail draws its faceplate under the drawing', () => {
  // A process display window as measured on production in a Full HD browser (process-plant-overview.test.ts).
  const fullHd: OverviewView = { width: 1896, height: 972 }
  const system = {
    plant,
    runtime: createProcessPlantRuntime({ system: plant }),
    ramps: createProcessPlantRampRunner({ runtime: createProcessPlantRuntime({ system: plant }) }),
    protection: createProcessPlantProtectionRunner({ system: plant, protection: plant.automation }),
    performance: createProcessPlantRuntimePerformance(),
  }
  const detail = (index: number, view: OverviewView) => {
    const result = compileDetailDisplay(system, new Set(), [String(plant.graph.components[index]!.id)], view)
    if (!result.ok) throw new Error(result.issues.map(issue => issue.message).join('; '))
    return result.display
  }

  test('at Full HD: the drawing, the faceplate with every lead value, and the alarms alone beside them, within the window and what a display samples', () => {
    for (const end of faceplateEnds(plant)) {
      const display = detail(end, fullHd)
      expect(display.panels.map(panel => panel.kind)).toEqual(['mimic', 'faceplate', 'alarms'])
      expect(display.height).toBeLessThanOrEqual(fullHd.height)
      const faceplate = display.panels.find(panel => panel.kind === 'faceplate')!
      if (faceplate.kind !== 'faceplate') throw new Error('expected the faceplate')
      const shown = new Set(composedPanelPens(faceplate).map(pen => String(pen.path)))
      for (const path of equipmentKeyValues(plant, [end], plantNowOf(system))) expect(shown.has(String(path))).toBe(true)
      const mimic = display.panels.find(panel => panel.kind === 'mimic')!
      if (mimic.kind !== 'mimic') throw new Error('expected the mimic')
      expect(new Set([...mimic.mimic.paths.map(String), ...faceplate.faceplate.paths, ...shown]).size).toBeLessThanOrEqual(PROCESS_DISPLAY_SAMPLE_MAX_PATHS)
    }
  }, 60_000)

  test('a window too narrow for its columns keeps the lead values beside the drawing, and other equipment never gets one', () => {
    const narrow: OverviewView = { width: 700, height: 900 }
    for (const end of faceplateEnds(plant)) expect(detail(end, narrow).panels.map(panel => panel.kind)).toEqual(['readouts', 'mimic', 'alarms'])
    const transfer = plant.graph.components.findIndex(component => component.semantics.energy.some(role => role.role === 'transfer'))
    expect(detail(transfer, fullHd).panels.some(panel => panel.kind === 'faceplate')).toBe(false)
  }, 60_000)
})
