import { describe, expect, test } from 'bun:test'
import {
  compilePlantGraph,
  compileProcessPlant,
  createPwrReferencePlantDefinition,
  processPlantComponentRegistry,
  type CompiledProcessPlant,
  type PlantGraphSpec,
} from '../src/packs/process-plant/index.ts'
import { overviewDrawingRoom } from '../src/packs/process-plant/displays/compose.ts'
import { compileMimicScope, planMimicDiagram, type MimicBudget } from '../src/packs/process-plant/displays/mimic/compile-mimic.ts'
import { indexSample } from '../src/packs/process-plant/displays/mimic/evaluate.ts'
import { layoutDiagram, verifyDiagram } from '../src/packs/process-plant/displays/mimic/layout/index.ts'
import type { CompiledMimic } from '../src/packs/process-plant/displays/mimic/mimic-model.ts'
import { principalCircuits } from '../src/packs/process-plant/displays/mimic/principal.ts'
import { overviewMimicProfile } from '../src/packs/process-plant/displays/mimic/profiles.ts'
import { overviewKeyValues } from '../src/packs/process-plant/displays/overview-key-values.ts'
import { drawnLook, rowText } from '../src/packs/process-plant/displays/mimic/rows.ts'
import { openBridgeDevice } from '../src/packs/process-plant/displays/mimic/text-metrics.ts'

// The unit overview: the principal circuits the energy rule finds, drawn by
// the overview profile at 1:1 with OpenBridge's regular text. The drawing is
// judged by what the engine guarantees (verified, crossings within the
// structure's bound plus two, deterministic, id-free) and by the overview's
// own rules (markers, grouped parallel equipment, text never below 12/14 px).

const plants = new Map([2, 4, 6].map(loops => [loops, compileProcessPlant(createPwrReferencePlantDefinition({ id: `plant:overview-${loops}`, loopCount: loops }))]))
const plantOf = (loops: number): CompiledProcessPlant => plants.get(loops)!

/**
 * The room each Plant's overview is drawn in here: for two and four loops what
 * a Full HD window leaves the drawing beside the column of lead values and
 * alarms (compose.ts); for six what the engine reaches today at full text
 * (see the fit ladder test for less).
 */
// The process display window as measured on production in a Full HD browser.
const fullHdColumn = overviewDrawingRoom({ width: 1896, height: 972 }, 'column', { readouts: overviewKeyValues(plantOf(4)).length, annunciators: 9, tileWidth: 134 })!
const ROOM: Readonly<Record<number, Omit<MimicBudget, 'profile'>>> = { 2: fullHdColumn, 4: fullHdColumn, 6: { maxWidth: 2160, maxHeight: 1080 } }
const budgetFor = (loops: number): MimicBudget => ({ profile: overviewMimicProfile, ...ROOM[loops]! })

const scopeOf = (plant: CompiledProcessPlant) => {
  const principal = principalCircuits(plant.graph)
  if (!principal.ok) throw new Error(principal.reason)
  return principal.scope
}
const overview = (plant: CompiledProcessPlant, budget: MimicBudget): CompiledMimic => {
  const result = compileMimicScope(plant, scopeOf(plant), budget)
  if (!result.ok) throw new Error(result.issues.map(issue => issue.message).join('; '))
  return result.mimic
}

// Opaque ids, as in mimic-generality.test.ts: every component id replaced, vocabulary kept.
const VOCABULARY = new Set(['kind', 'equipmentClass', 'group', 'system'])
const renamedPlant = (plant: CompiledProcessPlant): CompiledProcessPlant => {
  const opaque = new Map(plant.sourceGraph.components.map((component, index) => [String(component.id), `u${index}`]))
  const renamedString = (value: string): string => {
    const exact = opaque.get(value)
    if (exact !== undefined) return exact
    const dot = value.indexOf('.')
    const owner = dot > 0 ? opaque.get(value.slice(0, dot)) : undefined
    return owner === undefined ? value : `${owner}${value.slice(dot)}`
  }
  const renamed = <T,>(value: T, key = ''): T => {
    if (typeof value === 'string') return (VOCABULARY.has(key) ? value : renamedString(value)) as T
    if (Array.isArray(value)) return value.map(item => renamed(item)) as T
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, renamed(item, field)])) as T
    return value
  }
  return { ...plant, graph: compilePlantGraph(renamed(plant.sourceGraph) as PlantGraphSpec, processPlantComponentRegistry), automation: renamed(plant.automation) }
}

// The same Plant with its components and pipes listed in another order.
const reordered = (plant: CompiledProcessPlant, seed: number): CompiledProcessPlant => {
  let state = seed
  const next = (): number => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
  const shuffled = <T,>(values: ReadonlyArray<T>): T[] => {
    const copy = [...values]
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1))
      ;[copy[i], copy[j]] = [copy[j]!, copy[i]!]
    }
    return copy
  }
  const spec = plant.sourceGraph
  return { ...plant, graph: compilePlantGraph({ ...spec, components: shuffled(spec.components), connections: shuffled(spec.connections) } as PlantGraphSpec, processPlantComponentRegistry) }
}

// A valve put into a pipe of the Plant, between the pipe's ends, without the Plant's own instrument tags.
const withValveIn = (plant: CompiledProcessPlant, connectionId: string, valveFrom: string): CompiledProcessPlant => {
  const spec = plant.sourceGraph
  const template = spec.components.find(component => String(component.id) === valveFrom)!
  const valve = {
    ...template,
    id: 'addedIsolationValve',
    label: 'Added isolation valve',
    metadata: { presentation: { shortLabel: 'Added valve' } },
    variables: (template.variables ?? []).map(({ tagId: _tag, equipmentId: _equipment, externalRefs: _external, ...variable }) => variable),
  }
  const split = spec.connections.find(connection => String(connection.id) === connectionId)!
  const untagged = (split.variables ?? []).map(({ tagId: _tag, equipmentId: _equipment, externalRefs: _external, ...variable }) => variable)
  const connections = spec.connections.flatMap(connection => String(connection.id) !== connectionId ? [connection] : [
    { ...split, id: `${connectionId}-in`, to: 'addedIsolationValve.inlet', variables: untagged },
    { ...split, id: `${connectionId}-out`, from: 'addedIsolationValve.outlet', variables: untagged },
  ])
  return { ...plant, graph: compilePlantGraph({ ...spec, components: [...spec.components, valve], connections } as PlantGraphSpec, processPlantComponentRegistry) }
}

const geometry = (mimic: CompiledMimic) => ({
  size: [mimic.width, mimic.height],
  items: mimic.items.map(item => [item.binding.label, item.presentation, item.box, item.text, item.rows.map(row => row.kind), item.marker]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  pipes: mimic.pipes.map(pipe => [pipe.carrier, pipe.points, pipe.gaps]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  stubs: mimic.stubs.map(stub => [stub.text, stub.end]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
})

describe('the unit overview of the principal circuits', () => {
  for (const loops of [2, 4, 6]) {
    test(`${loops} loops: drawn, verified, within the room, crossings at most two over what the structure forces`, () => {
      const plant = plantOf(loops)
      const budget = budgetFor(loops)
      const mimic = overview(plant, budget)
      expect(mimic.width).toBeLessThanOrEqual(budget.maxWidth)
      expect(mimic.height).toBeLessThanOrEqual(budget.maxHeight)
      // The core reaches every loop by two paths around a ladder of the two headers and the loops,
      // and the feed train closes that ladder outside the loops: 2n − 3 crossings are forced (one for two loops).
      expect(mimic.crossings.forced).toBe(2 * loops - 3)
      expect(mimic.crossings.count).toBeLessThanOrEqual(mimic.crossings.forced + overviewMimicProfile.layout.limits.crossingsOverBound)
      expect(mimic.pipes.reduce((sum, pipe) => sum + pipe.gaps.length, 0)).toBe(mimic.crossings.count)

      // The engine's own verifier, run again on the diagram the overview was drawn from.
      const planned = planMimicDiagram(plant, scopeOf(plant), overviewMimicProfile)
      if (!planned.ok) throw new Error('not planned')
      const profile = { ...overviewMimicProfile.layout, ...budget }
      const layout = layoutDiagram(planned.graph, profile)
      if (!layout.ok) throw new Error(JSON.stringify(layout.reasons))
      expect(verifyDiagram(planned.graph, profile, layout)).toEqual([])
      expect(`${mimic.hash}`.endsWith(layout.hash)).toBe(true)
    })
  }

  test('every crossing is a gap in open pipe: never inside a symbol, a text stack, a stub label or a reserved alarm frame', () => {
    for (const loops of [4, 6]) {
      const mimic = overview(plantOf(loops), budgetFor(loops))
      const boxes = [
        ...mimic.items.filter(item => item.presentation.element !== 'bar').flatMap(item => [item.box, ...(item.text === null ? [] : [item.text]), ...(item.frame === null ? [] : [item.frame])]),
        ...mimic.stubs.flatMap(stub => (stub.textBox === null ? [] : [stub.textBox])),
      ]
      for (const pipe of mimic.pipes) {
        for (const [x, y] of pipe.gaps) {
          const inside = boxes.filter(box => x > box.x && x < box.x + box.width && y > box.y && y < box.y + box.height)
          expect(inside).toEqual([])
        }
      }
    }
  })

  test('text is legible at 1:1: regular readout rows, tags at 12 px, values at 16 px, never scaled down', () => {
    expect(overviewMimicProfile.readoutSize).toBe('regular')
    expect(overviewMimicProfile.minScale).toBe(1)
    for (const loops of [4, 6]) {
      const mimic = overview(plantOf(loops), budgetFor(loops))
      expect(mimic.readoutSize).toBe('regular')
      expect(mimic.minScale).toBe(1)
      const planned = planMimicDiagram(plantOf(loops), scopeOf(plantOf(loops)), overviewMimicProfile)
      if (!planned.ok) throw new Error('not planned')
      // Tag lines are 16 px tall (12 px type); every row is a regular 20 px row (16 px type), never the small 16/18 px rows.
      for (const node of planned.graph.nodes) {
        for (const line of node.text.lines) expect([openBridgeDevice.tagLine, openBridgeDevice.row] as ReadonlyArray<number>).toContain(line.height)
      }
    }
  })

  test('the same Plant draws the same overview, whatever its ids and whatever order it lists its parts in', () => {
    for (const loops of [4, 6]) {
      const plant = plantOf(loops)
      const reference = overview(plant, budgetFor(loops))
      expect(JSON.stringify(overview(plant, budgetFor(loops)))).toBe(JSON.stringify(reference))
      const opaque = overview(renamedPlant(plant), budgetFor(loops))
      expect(geometry(opaque)).toEqual(geometry(reference))
      expect(opaque.hash).toBe(reference.hash)
      for (const seed of [7, 19]) expect(overview(reordered(plant, seed), budgetFor(loops)).hash).toBe(reference.hash)
    }
  })

  test('a valve added off the circuits moves nothing: neither on a line the drawing does not touch, nor one step beyond where it stops', () => {
    const plant = plantOf(4)
    const reference = overview(plant, budgetFor(4))
    // On the auxiliary feed header's branch to loop A, upstream of the AFW valve the drawing names as where it stops.
    const beyondStop = withValveIn(plant, 'aux-feedwater-header-to-valve-a', 'auxFeedwaterValveA')
    expect(beyondStop.graph.components.some(component => String(component.id) === 'addedIsolationValve')).toBe(true)
    expect(overview(beyondStop, budgetFor(4)).hash).toBe(reference.hash)
    // Between the auxiliary feed pump and its header, which no principal equipment touches.
    const elsewhere = withValveIn(plant, 'motor-afw-pump-to-header', 'auxFeedwaterValveA')
    expect(overview(elsewhere, budgetFor(4)).hash).toBe(reference.hash)
  })

  test('valves on the circuits are markers, and say something only when abnormal or between shut and open', () => {
    const mimic = overview(plantOf(4), budgetFor(4))
    const valves = mimic.items.filter(item => item.presentation.element === 'device' && item.presentation.icon.startsWith('valve'))
    expect(valves.length).toBeGreaterThanOrEqual(10)
    for (const valve of valves) {
      expect(valve.marker).toBe(true)
      // A commanded valve: what it does, then CMD over the command where it disagrees; no tag.
      expect(valve.rows.map(row => row.kind === 'marker' ? row.part : row.kind)).toEqual(['word', 'command', 'value'])
      expect(valve.text?.height).toBe(3 * openBridgeDevice.row)
    }
    const fcv = valves.find(item => item.binding.label === 'FCV A')!
    const state = fcv.binding.state!
    const at = (position: number, command: number) => indexSample([{ path: state.state!.path, value: position, quality: 'good' }, { path: state.command!, value: command, quality: 'good' }])
    const texts = (index: ReturnType<typeof indexSample>) => fcv.rows.map(row => rowText(row, drawnLook(fcv.binding, fcv.rows, index), index, String))
    expect(texts(at(1, 1))).toEqual(['', '', ''])
    expect(texts(at(0, 0))).toEqual(['', '', ''])
    expect(texts(at(0.4, 0.4))).toEqual(['40 %', '', ''])
    // A command it does not follow never takes the place of what it does: a runback reads 35 %, then CMD 100 %.
    expect(texts(at(1, 0))).toEqual(['OPEN', 'CMD', 'SHUT'])
    expect(texts(at(0.35, 1))).toEqual(['35 %', 'CMD', '100 %'])
    expect(texts(indexSample([]))).toEqual(['POS ?', '', ''])
  })

  test('stubs name alike far ends once with a count, and a lone far end in full', () => {
    for (const loops of [4, 6]) {
      const texts = overview(plantOf(loops), budgetFor(loops)).stubs.map(stub => stub.text)
      expect(texts).toContain(`from ACC ×${loops}, CHG ×2, RHR iso, SI header`)
      expect(texts).toContain('from AFW valve A')
      expect(texts.every(text => !/ and \d+ more$/.test(text))).toBe(true)
    }
  })

  test('parallel equipment with the same neighbours is one symbol that counts its running members', () => {
    const mimic = overview(plantOf(4), budgetFor(4))
    const groups = mimic.items.filter(item => item.rows.some(row => row.kind === 'count'))
    expect(groups.map(item => item.binding.label).sort()).toEqual(['Cond pump A/B', 'MFW A/B'])
    expect(mimic.summary.equipment.map(item => item.label)).toEqual(expect.arrayContaining(['MFW A', 'MFW B', 'Cond pump A', 'Cond pump B']))
    const pumps = groups.find(item => item.binding.label === 'MFW A/B')!
    const count = pumps.rows.find(row => row.kind === 'count')!
    if (count.kind !== 'count') throw new Error('no count')
    const [first, second] = count.members.map(member => member.state!.state!.path)
    const sample = (a: boolean, b: boolean) => indexSample([{ path: first!, value: a, quality: 'good' }, { path: second!, value: b, quality: 'good' }])
    expect(rowText(count, drawnLook(pumps.binding, pumps.rows, sample(true, true)), sample(true, true), String)).toBe('2/2 RUN')
    expect(rowText(count, drawnLook(pumps.binding, pumps.rows, sample(true, false)), sample(true, false), String)).toBe('1/2 RUN')
    expect(drawnLook(pumps.binding, pumps.rows, sample(true, false)).state.kind).toBe('running')
    expect(drawnLook(pumps.binding, pumps.rows, sample(false, false)).state.kind).toBe('stopped')
    expect(drawnLook(pumps.binding, pumps.rows, indexSample([])).state.kind).toBe('unknown')
    // Every member's state is sampled; the pipe the group draws for both suctions carries both flows.
    for (const path of [first!, second!]) expect(mimic.paths).toContain(path)
    const suction = mimic.pipes.filter(pipe => pipe.state.kind === 'fluid' && pipe.state.parallel.length > 0)
    expect(suction.length).toBeGreaterThanOrEqual(2)
  })

  test('less room drops optional rows before anything else, and never shrinks text; too little is refused with the size it needs', () => {
    const plant = plantOf(4)
    const roomy = overview(plant, budgetFor(4))
    const values = (mimic: CompiledMimic) => mimic.items.reduce((sum, item) => sum + item.rows.filter(row => row.kind === 'value').length, 0)
    const tighter = compileMimicScope(plant, scopeOf(plant), { profile: overviewMimicProfile, maxWidth: roomy.width - 24, maxHeight: roomy.height + 200 })
    if (tighter.ok) {
      expect(tighter.mimic.readoutSize).toBe('regular')
      expect(tighter.mimic.width).toBeLessThan(roomy.width)
      expect(values(tighter.mimic)).toBeLessThanOrEqual(values(roomy))
    }
    const small = compileMimicScope(plant, scopeOf(plant), { profile: overviewMimicProfile, maxWidth: 1152, maxHeight: 696 })
    expect(small.ok).toBe(false)
    if (!small.ok) expect(small.issues[0]!.message).toMatch(/^the drawing needs \d+ × \d+ px, and this display leaves 1152 × 696$/)
  })

  // The reference design is the 4-loop Plant (owner, 2026-10-10). Its own
  // cost is the fastest of 12 compiles: the slowest measured the shared
  // machine's load (586 ms with seven agents' test suites running), not the code.
  test('compiles the 4-loop overview within 500 ms', () => {
    const timings: number[] = []
    for (let run = 0; run < 12; run++) {
      const start = performance.now()
      overview(plantOf(4), budgetFor(4))
      timings.push(performance.now() - start)
    }
    expect(Math.min(...timings)).toBeLessThan(500)
  }, 30_000) // A watchdog for the whole sweep, not the property it measures.
})
