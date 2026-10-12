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
  type ProcessPlantRuntime,
  type VariablePath,
} from '../src/packs/process-plant/index.ts'
import { faceplateEnds, faceplateLayout, faceplateNow, type FaceplateLayout } from '../src/packs/process-plant/displays/faceplate.ts'
import { evaluateSafetyFunctions } from '../src/packs/process-plant/safety-functions.ts'

// A faceplate is derived from what the model and its I&C declare, never from
// what the reference PWR calls its equipment: the same Plant with every
// component id replaced by an opaque one lays out the same faceplates, row
// for row (the mimic-generality.test.ts pattern).

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

/** A Plant run for a while at its operating point, with its protection, and a second one left at the operating point. */
const running = (system: CompiledProcessPlant, seconds: number, commands: ReadonlyArray<{ readonly path: VariablePath; readonly value: unknown }> = []) => {
  const runtime = createProcessPlantRuntime({ system })
  const nominal = createProcessPlantRuntime({ system })
  const protection = createProcessPlantProtectionRunner({ system, protection: system.automation })
  const step = () => {
    runtime.tick(1000)
    protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run' as never, sourceRuntimeId: 'test' })
  }
  for (const command of commands) runtime.writeCommand({ type: 'setVariable', path: command.path, value: command.value as never })
  for (let second = 0; second < seconds; second += 1) step()
  return { runtime, nominal, protection }
}

const reading = (runtime: ProcessPlantRuntime) => (path: VariablePath): unknown => runtime.readVariable(path)

const faceplatesOf = (system: CompiledProcessPlant, run: ReturnType<typeof running>) => {
  const mode = processPlantOperatingMode({ system, runtime: run.runtime, modes: system.automation.operatingModes })?.id ?? null
  const read = reading(run.runtime)
  const snapshot = run.protection.snapshot()
  const active = new Map([...snapshot.alarms, ...snapshot.trips].filter(lifecycle => lifecycle.active).map(lifecycle => [lifecycle.ruleId, lifecycle.firstActiveElapsedMs ?? 0]))
  const firstOut = new Map(snapshot.trips.flatMap(lifecycle => lifecycle.firstOut && lifecycle.annunciator?.firstOutGroup !== undefined ? [[lifecycle.annunciator.firstOutGroup, lifecycle.ruleId] as const] : []))
  const live = { mode, read, active, firstOut, safetyFunctions: evaluateSafetyFunctions(system, run.runtime) }
  return faceplateEnds(system).map(end => {
    const layout = faceplateLayout(system, end, { mode, read }, reading(run.nominal))!
    return { layout, now: faceplateNow(system, layout, live) }
  })
}

/** Every string in a value, with the named Plant's component ids replaced by opaque ones. */
const withOpaqueIds = <T,>(value: T): T => renamed(value)

describe('a faceplate depends on the model and its I&C, not on equipment ids', () => {
  test('only the energy ends get one, sources first', () => {
    expect(faceplateEnds(plant).map(index => plant.graph.components[index]!.semantics.energy.map(role => role.role))).toEqual([['source'], ['sink']])
    const other = plant.graph.components.findIndex(component => component.semantics.energy.every(role => role.role === 'transfer'))
    expect(faceplateLayout(plant, other, { mode: null, read: () => undefined }, () => undefined)).toBeNull()
  })

  test('the opaque Plant lays out the same faceplates at its operating point', () => {
    const named = faceplatesOf(plant, running(plant, 30))
    const unnamed = faceplatesOf(anonymous, running(anonymous, 30))
    expect(unnamed).toEqual(withOpaqueIds(named))
  }, 60_000)

  test('the opaque Plant reads the same faceplates after a turbine trip from power', () => {
    // The scenario action finds the turbine by its declared role, on either Plant.
    const trip = (system: CompiledProcessPlant) => commandsForProcessPlantAction({ actionId: 'turbine-trip', parameters: {}, graph: system.graph })
    const named = faceplatesOf(plant, running(plant, 90, trip(plant)))
    const unnamed = faceplatesOf(anonymous, running(anonymous, 90, trip(anonymous)))
    expect(named.flatMap(faceplate => faceplate.now.columns.flatMap(column => column.rows)).some(row => row.kind === 'rule' && row.firstOut)).toBe(true)
    expect(unnamed).toEqual(withOpaqueIds(named))
  }, 60_000)

  test('no signal appears twice on a faceplate', () => {
    for (const { layout } of faceplatesOf(plant, running(plant, 30))) {
      const shown = shownPaths(layout)
      expect(shown.length).toBe(new Set(shown).size)
    }
  }, 60_000)
})

const shownPaths = (layout: FaceplateLayout): ReadonlyArray<string> => [
  ...layout.columns.flatMap(column => column.rows.flatMap(row => row.kind === 'value' ? [String(row.path)] : row.kind === 'flows' ? row.branches.map(branch => String(branch.path)) : [])),
  ...(layout.loops?.columns.flatMap(column => column.paths.flatMap(path => path === null ? [] : [String(path)])) ?? []),
]
