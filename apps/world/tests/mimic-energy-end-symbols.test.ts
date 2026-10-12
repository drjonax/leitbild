import { describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/index.ts'
import {
  aspect,
  commandsForProcessPlantAction,
  compilePlantGraph,
  compileProcessPlant,
  createProcessPlantProtectionRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
  processPlantComponentRegistry,
  type CompiledProcessPlant,
  type ComponentDefinition,
  type ComponentKind,
  type ComponentSemantics,
  type PlantGraphSpec,
} from '../src/packs/process-plant/index.ts'
import { overviewDrawingRoom } from '../src/packs/process-plant/displays/compose.ts'
import { compileMimic, compileMimicScope, type MimicBudget } from '../src/packs/process-plant/displays/mimic/compile-mimic.ts'
import { indexSample } from '../src/packs/process-plant/displays/mimic/evaluate.ts'
import type { CompiledMimic, MimicDrawnItem } from '../src/packs/process-plant/displays/mimic/mimic-model.ts'
import { principalCircuits } from '../src/packs/process-plant/displays/mimic/principal.ts'
import { chatMimicProfile, overviewMimicProfile } from '../src/packs/process-plant/displays/mimic/profiles.ts'
import { drawnLook, itemTreatment, rowText, shutdownDemanded } from '../src/packs/process-plant/displays/mimic/rows.ts'
import { formatQuantity } from '../src/packs/process-plant/displays/display-text.ts'
import { overviewKeyValues } from '../src/packs/process-plant/displays/overview-key-values.ts'
import { processPlantSignalQuality } from '../src/packs/process-plant/signals.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// The energy ends on the unit overview: the core drawn as the vessel its
// coolant fills, with its rods' state, and the turbine-generator with its
// breaker's words and its output. The model lane's display declarations are
// applied here as it is to make them (the core's level read through its
// vessel port, the generator running on its output breaker, ON LINE and
// OFF LINE, GEN-MW over 0-1300 MW, the turbine stop valve an isolating valve
// named "Turbine stop valves"); everything drawn follows from them.

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:energy-ends', loopCount: 4 }))

const declaring = (): ReadonlyMap<ComponentKind, ComponentDefinition> => {
  const registry = new Map(processPlantComponentRegistry)
  const extend = (kind: string, change: (own: ComponentSemantics) => Partial<ComponentSemantics>) => {
    const base = registry.get(kind as ComponentKind)!
    registry.set(kind as ComponentKind, { ...base, semantics: parameters => { const own = base.semantics(parameters); return { ...own, ...change(own) } } })
  }
  extend('reactorCore', own => ({ aspects: [...own.aspects, aspect('level', { variable: 'collapsedLiquidLevelPercent', reading: 'value', via: 'vesselThermal' })] }))
  extend('turbineLoadSink', own => ({ aspects: own.aspects.map(entry => entry.aspect === 'running' ? aspect('running', { variable: 'outputBreakerClosed', reading: 'true' }) : entry) }))
  return registry
}
const declaredSpec = (spec: PlantGraphSpec): PlantGraphSpec => ({
  ...spec,
  components: spec.components.map(entry => {
    if (String(entry.id) === 'turbineStopValve') {
      return { ...entry, parameters: { ...(entry.parameters as object), valveMode: 'isolation' }, metadata: { ...entry.metadata, presentation: { ...entry.metadata?.presentation, shortLabel: 'Turbine stop valves' } } }
    }
    if (String(entry.id) !== 'turbine') return entry
    const variables = entry.variables.map(variable => variable.path === 'electricMw' ? { ...variable, limits: { instrumentSpan: { min: 0, max: 1300 } } } : variable)
    return { ...entry, variables, metadata: { ...entry.metadata, presentation: { ...entry.metadata?.presentation, states: { outputBreakerClosed: { on: 'ON LINE', off: 'OFF LINE' } } } } }
  }),
})
const declared: CompiledProcessPlant = { ...plant, graph: compilePlantGraph(declaredSpec(plant.sourceGraph), declaring()) }

// The Full-HD process display window beside its column of lead values and alarms (as mimic-overview-layout.test.ts).
const atPower = createProcessPlantRuntime({ system: plant })
const room = overviewDrawingRoom({ width: 1896, height: 972 }, 'column', {
  readouts: overviewKeyValues(declared, { mode: 'powerOperation', read: path => atPower.readVariable(path) }).length,
  annunciators: 9,
  tileWidth: 134,
})!
const overviewOf = (shown: CompiledProcessPlant): CompiledMimic => {
  const principal = principalCircuits(shown.graph)
  if (!principal.ok) throw new Error(principal.reason)
  const result = compileMimicScope(shown, principal.scope, { profile: overviewMimicProfile, ...room })
  if (!result.ok) throw new Error(result.issues.map(issue => issue.message).join('; '))
  return result.mimic
}
const overview = overviewOf(declared)
const itemOf = (mimic: CompiledMimic, label: string): MimicDrawnItem => mimic.items.find(item => item.binding.label === label)!

// The Plant run on its own runtime and protection, as a Run does.
const started = () => {
  const runtime = createProcessPlantRuntime({ system: plant })
  const protection = createProcessPlantProtectionRunner({ system: plant, protection: plant.automation })
  const run = (seconds: number): void => {
    for (let second = 0; second < seconds; second++) {
      runtime.tick(1_000)
      protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-energy-ends' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
    }
  }
  const act = (actionId: string): void => {
    for (const command of commandsForProcessPlantAction({ actionId, parameters: {}, graph: plant.graph })) runtime.writeCommand({ type: 'setVariable', path: command.path, value: command.value })
  }
  // What the overview's symbols say now, as the embed writes them.
  const shown = (label: string) => {
    const item = itemOf(overview, label)
    const index = indexSample(overview.paths.map(path => {
      const variable = runtime.readVariableSnapshot(path)
      return { path, value: variable.value, quality: processPlantSignalQuality(variable).status }
    }))
    const look = drawnLook(item.binding, item.rows, index)
    return {
      fill: look.state.kind === 'level' ? Math.round(look.state.percent) : null,
      texts: item.rows.map(row => rowText(row, look, index, formatQuantity)).filter(text => text !== ''),
      treatment: itemTreatment(look, false, shutdownDemanded(item.rows, index)),
    }
  }
  return { run, act, shown }
}

describe('the energy ends on the unit overview', () => {
  test('the Full-HD overview keeps its column beside the drawing with the core\'s and the generator\'s rows', () => {
    expect(overview.width).toBeLessThanOrEqual(room.maxWidth)
    expect(overview.height).toBeLessThanOrEqual(room.maxHeight)
    // Without the declarations it fits too: the core's rods rows come from what its kind already declares.
    const plain = overviewOf(plant)
    expect(plain.width).toBeLessThanOrEqual(room.maxWidth)
    expect(itemOf(plain, 'Core').rows.filter(row => row.kind === 'shutdown')).toHaveLength(2)
  })

  test('the core is filled by the level its vessel computes once its kind reads it there, and static before', () => {
    expect(itemOf(overview, 'Core').binding.state?.state?.path).toBe('vessel.collapsedLiquidLevelPercent' as never)
    expect(itemOf(overviewOf(plant), 'Core').binding.state).toBeNull()
  })

  test('the hub\'s tag stands on its body, centred over it, with its rows above', () => {
    const core = itemOf(overview, 'Core')
    expect(core.text?.side).toBe('top')
    expect(core.text!.y + core.text!.height).toBe(core.box.y)
    expect(core.text!.x + core.text!.width / 2).toBe(core.box.x + core.box.width / 2)
  })

  test('pinned states: power, a turbine trip from full power, every RCP tripped and the grid lost', () => {
    const power = started()
    power.run(60)
    expect(power.shown('Core')).toEqual({ fill: 100, texts: ['325 °C'], treatment: 'normal' })
    expect(power.shown('Turbine')).toEqual({ fill: null, texts: ['ON LINE', '1162 MW'], treatment: 'normal' })
    expect(power.shown('Turbine stop valves').texts).toEqual(['OPEN'])

    // The turbine trips at full power and trips the reactor (P-9): for the 2 s the rods take to fall the core says
    // they are off bottom with the trip commanded, outlined as not following it; then that they are on bottom.
    const trip = started()
    trip.run(60)
    trip.act('turbine-trip')
    trip.run(2)
    expect(trip.shown('Core')).toEqual({ fill: 100, texts: ['323 °C', 'Rods off bottom', 'CMD trip'], treatment: 'abnormal' })
    trip.run(148)
    expect(trip.shown('Core')).toEqual({ fill: 100, texts: ['292 °C', 'Rods on bottom'], treatment: 'normal' })
    // Off its breaker the generator reads OFF LINE; at the bottom of its declared span its output reads "<0 MW".
    expect(trip.shown('Turbine').texts).toEqual(['OFF LINE', '<0 MW'])
    expect(trip.shown('Turbine stop valves').texts).toEqual(['SHUT'])

    const pumps = started()
    pumps.run(60)
    pumps.act('trip-reactor-coolant-pumps')
    pumps.run(150)
    expect(pumps.shown('Core').texts).toEqual(['302 °C', 'Rods on bottom'])

    const grid = started()
    grid.run(60)
    grid.act('loss-offsite-power')
    grid.run(150)
    expect(grid.shown('Core').texts).toEqual(['302 °C', 'Rods on bottom'])
    expect(grid.shown('Turbine').texts).toEqual(['OFF LINE', '<0 MW'])
  })

  test('a diesel writes its kW, sized for the 8000 kW its instrument declares', () => {
    const budget: MimicBudget = { profile: chatMimicProfile, maxWidth: 800, maxHeight: 624 }
    const result = compileMimic(declared, { from: ['dieselGeneratorA'], to: ['auxFeedwaterPumpMotor'] }, budget)
    if (!result.ok) throw new Error(result.issues.map(issue => issue.message).join('; '))
    const diesel = result.mimic.items.find(item => item.components.includes('dieselGeneratorA'))!
    expect(diesel.rows.map(row => row.kind === 'value' ? [row.path, row.digits] : row.kind)).toEqual(['state', ['dieselGeneratorA.outputKw', 4]])
  })
})
