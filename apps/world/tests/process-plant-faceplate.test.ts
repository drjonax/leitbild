import { describe, expect, test } from 'bun:test'
import {
  commandsForProcessPlantAction,
  compilePlantGraph,
  compileProcessPlant,
  createProcessPlantProtectionRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
  processPlantComponentRegistry,
  processPlantOperatingMode,
  type CompiledProcessPlant,
  type PlantGraphSpec,
  type VariablePath,
} from '../src/packs/process-plant/index.ts'
import { conditionBindings } from '../src/packs/process-plant/displays/actuations.ts'
import {
  faceplateEnds,
  faceplateLayout,
  faceplateLines,
  faceplateNow,
  groupStates,
  type Faceplate,
  type FaceplateLayout,
} from '../src/packs/process-plant/displays/faceplate.ts'
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
  const read = (path: VariablePath): unknown => run.runtime.readVariable(path)
  const snapshot = run.protection.snapshot()
  const active = new Map([...snapshot.alarms, ...snapshot.trips].filter(lifecycle => lifecycle.active).map(lifecycle => [lifecycle.ruleId, lifecycle.firstActiveElapsedMs ?? 0]))
  const firstOut = new Map(snapshot.trips.flatMap(lifecycle => lifecycle.firstOut && lifecycle.annunciator?.firstOutGroup !== undefined ? [[lifecycle.annunciator.firstOutGroup, lifecycle.ruleId] as const] : []))
  const live = { mode, read, active, firstOut, safetyFunctions: evaluateSafetyFunctions(system, run.runtime) }
  return faceplateEnds(system).map(end => {
    const layout = faceplateLayout(system, end, { mode, read }, path => run.nominal.readVariable(path))!
    return { layout, now: faceplateNow(system, layout, live), active }
  })
}

/** Every string in a value, with the named Plant's component ids replaced by opaque ones. */
const withOpaqueIds = <T,>(value: T): T => renamed(value)

/** What a faceplate shows: its layout and how it reads now. */
const shown = (faceplates: ReturnType<typeof faceplatesOf>) => faceplates.map(({ layout, now }) => ({ layout, now }))

const shownPaths = (layout: FaceplateLayout): ReadonlyArray<string> => layout.columns.flatMap(column => column.rows.flatMap(row =>
  row.kind === 'values' ? row.paths.map(String)
    : row.kind === 'flows' ? row.branches.map(branch => String(branch.path))
      : row.kind === 'loops' ? row.table.columns.flatMap(entry => entry.cells.flat().map(String))
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
    expect(faceplateLayout(plant, other, { mode: null, read: () => undefined }, () => undefined)).toBeNull()
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
      const layout = faceplateLayout(system, end, { mode: null, read: () => undefined }, () => undefined)!
      return layout.columns.flatMap(column => column.heads.flatMap((head): ReadonlyArray<VariablePath> => head.kind === 'group' ? groupStates(system, head.group) : []))
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
    for (const { layout } of faceplatesOf(plant, running(plant, 30))) {
      const paths = shownPaths(layout)
      expect(paths.length).toBe(new Set(paths).size)
    }
  }, 60_000)
})

describe('each faceplate column fits the room under the drawing', () => {
  // Rows that ask for attention: an active rule, a count of rules acting, a failing check, a value an active rule judges.
  const busy = (faceplate: Faceplate, active: ReadonlyMap<string, number>) => {
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
