import { describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/index.ts'
import {
  compilePlantGraph,
  compileProcessPlant,
  createProcessPlantProtectionRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
  processPlantComponentRegistry,
  processPlantOperatingMode,
  type CompiledProcessPlant,
  type PlantGraphSpec,
  type ProcessSignalBinding,
  type ProcessVariableValue,
  type VariablePath,
} from '../src/packs/process-plant/index.ts'
import { resolveProcessPlantSignalBinding } from '../src/packs/process-plant/signals.ts'
import {
  declaredController,
  derivePlantControls,
  type ControlDeclarations,
  type ItemControls,
  type OfferedControl,
} from '../src/packs/process-plant/operations/controls.ts'
import { optionStanding, ruleStatesFrom } from '../src/packs/process-plant/operations/control-standing.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// Controls are derived from what the model declares, never from what the
// reference PWR calls its equipment. The tests mark the SI block's pushbutton
// momentary in the Plant's presentation, as the model lane declares it, and
// stand in the "not offered" statements the model does not declare yet: an
// RCP is not started from the display.

/** The Plant with the input a tag names marked momentary in its equipment's presentation, or unmarked. */
const withMomentary = (system: CompiledProcessPlant, tagId: string, marked: boolean): CompiledProcessPlant => {
  const binding = resolveProcessPlantSignalBinding(system.graph, { tagId: tagId as never })
  if (binding.owner.type !== 'component') throw new Error(`${tagId} is not a component variable`)
  const owner = system.graph.components[binding.owner.componentIndex]!
  const local = String(binding.path).slice(String(owner.id).length + 1)
  const sourceGraph: PlantGraphSpec = {
    ...system.sourceGraph,
    components: system.sourceGraph.components.map(component => {
      if (component.id !== owner.id) return component
      const { momentary: declared, ...presentation } = component.metadata?.presentation ?? {}
      const momentary = (declared ?? []).filter(path => path !== local).concat(marked ? [local] : [])
      return { ...component, metadata: { ...component.metadata, presentation: { ...presentation, ...(momentary.length === 0 ? {} : { momentary }) } } }
    }),
  }
  return { ...system, sourceGraph, graph: compilePlantGraph(sourceGraph, processPlantComponentRegistry) }
}

const plant = withMomentary(compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:controls', loopCount: 4 })), 'SI-BLOCK', true)
const tag = (tagId: string): ProcessSignalBinding => resolveProcessPlantSignalBinding(plant.graph, { tagId: tagId as never })

const rcpStart = (binding: ProcessSignalBinding, value: ProcessVariableValue): string | undefined =>
  binding.tagId !== undefined && /^RCP-[A-Z]-RUN$/.test(binding.tagId) && value === true ? 'RCP start needs seal injection and oil lift, which are not modelled' : undefined

const declarations: ControlDeclarations = { notOffered: rcpStart }

const controls = derivePlantControls(plant, declarations)
const itemOf = (system: CompiledProcessPlant, result: ReturnType<typeof derivePlantControls>, componentIndex: number, device?: string): ItemControls =>
  result.items.find(entry => entry.item.component === componentIndex && (device === undefined ? entry.item.kind === 'component' : entry.item.kind === 'device' && entry.item.device === device))!
const ownerIndex = (binding: ProcessSignalBinding): number => {
  if (binding.owner.type !== 'component') throw new Error(`${binding.path} is not a component variable`)
  return binding.owner.componentIndex
}
const offeredFor = (binding: ProcessSignalBinding): ReadonlyArray<OfferedControl> =>
  controls.items.flatMap(entry => entry.offered.filter(control => control.path === binding.path))
const withheldFor = (binding: ProcessSignalBinding) =>
  controls.items.flatMap(entry => entry.withheld.filter(control => control.path === binding.path))

describe('controls an operator is offered', () => {
  test('an isolating valve bundled in its host is a two-state control that opens and shuts it', () => {
    const blockValve = tag('MOV-8000A')
    const [control] = offeredFor(blockValve)
    expect(control).toBeDefined()
    expect(control!.form).toBe('twoState')
    expect(control!.options.map(option => [option.word, option.value, option.state])).toEqual([['OPEN', 1, 'OPEN'], ['SHUT', 0, 'SHUT']])
    expect(control!.target.startsWith('MOV-8000A ')).toBe(true)
    // Its state is the position the motor drove it to, not its demand.
    expect(control!.state).not.toBe(blockValve.path)
  })

  test('a pump starts and stops; a breaker closes and opens', () => {
    expect(offeredFor(tag('SI-PUMP-A'))[0]!.options.map(option => [option.word, option.value, option.state])).toEqual([['START', true, 'RUN'], ['STOP', false, 'STOP']])
    expect(offeredFor(tag('BRK-EDG-A-CLOSED'))[0]!.options.map(option => [option.word, option.value, option.state])).toEqual([['CLOSE', true, 'CLOSED'], ['OPEN', false, 'OPEN']])
  })

  test('an option the model declares not offered is withheld with why, and the others stay', () => {
    const [control] = offeredFor(tag('RCP-A-RUN'))
    expect(control!.options.map(option => option.word)).toEqual(['STOP'])
    expect(control!.withheldOptions).toEqual([{ word: 'START', value: true, reason: 'RCP start needs seal injection and oil lift, which are not modelled' }])
  })

  test('a control every option of which is declared not offered is withheld, saying why', () => {
    const result = derivePlantControls(plant, { ...declarations, notOffered: binding => binding.tagId === 'MOV-8000A' ? 'Not operated in this exercise' : undefined })
    const binding = tag('MOV-8000A')
    expect(result.items.flatMap(entry => entry.offered).some(control => control.path === binding.path)).toBe(false)
    expect(result.items.flatMap(entry => entry.withheld).find(control => control.path === binding.path)?.reason).toEqual({ kind: 'declared', text: 'Not operated in this exercise' })
  })

  test('the pushbutton of undrawn logic sits on the energy end its rules command, and nowhere else', () => {
    const block = tag('SI-BLOCK')
    const hosts = controls.items.filter(entry => entry.offered.some(control => control.path === block.path))
    // The SI signal its block gates inserts the core's rods: the core is the end it commands.
    expect(hosts.map(entry => plant.graph.components[entry.item.component]!.semantics.energy.map(role => role.role))).toEqual([['source']])
    const [pushbutton] = hosts[0]!.offered.filter(control => control.path === block.path)
    expect(pushbutton!.form).toBe('pushbutton')
    expect(pushbutton!.options.map(option => option.value)).toEqual([true])
    expect(pushbutton!.from).toBe(String(plant.graph.components[ownerIndex(block)]!.id))
    expect(controls.unplaced).toEqual([])
  })

  test('without its momentary mark the logic input is offered nowhere', () => {
    const result = derivePlantControls(withMomentary(plant, 'SI-BLOCK', false), declarations)
    expect(result.items.flatMap(entry => entry.offered).some(control => control.path === tag('SI-BLOCK').path)).toBe(false)
  })
})

describe('what is withheld, and why', () => {
  test('faults and conditions outside the Plant are the instructor\'s: no operator control writes one', () => {
    const offered = controls.items.flatMap(entry => entry.offered)
    for (const control of offered) expect(plant.graph.signalBindingByPath.get(control.path)!.actuation).toBe('command')
    const instructor = controls.items.flatMap(entry => entry.withheld).filter(control => control.reason.kind === 'instructor')
    expect(instructor.length).toBeGreaterThan(0)
    for (const control of instructor) expect(['faultInjection', 'boundary']).toContain(plant.graph.signalBindingByPath.get(control.path)!.actuation!)
  })

  test('a demand its controller writes every step reads AUTO with what it holds, and is never offered', () => {
    const controlled = plant.graph.components.filter(component => declaredController(component) !== null)
    expect(controlled.length).toBeGreaterThan(0)
    for (const component of controlled) {
      const entry = itemOf(plant, controls, component.index)
      expect(entry.offered.filter(control => control.aspect !== undefined)).toEqual([])
      const command = component.semantics.aspects.find(aspect => aspect.command !== undefined)!.command!
      const reason = entry.withheld.find(control => control.path === command)!.reason
      const controller = declaredController(component)!
      expect(reason).toMatchObject({ kind: 'automatic', measured: controller.measured, setpoint: controller.setpoint })
      expect(reason.text.startsWith('AUTO · ')).toBe(true)
    }
    const feedValve = withheldFor(tag('MFW-A-CV'))[0]!.reason
    expect(feedValve.text).toBe(`AUTO · ${plant.graph.signalBindingByPath.get(declaredController(plant.graph.components[ownerIndex(tag('MFW-A-CV'))]!)!.measured)!.tagId} held to 55 %`)
  })

  test('rods, pump speeds, turbine load and set points are demands, not operated from the display', () => {
    for (const tagId of ['ROD-POS-AVG', 'RCP-A-SPD', 'TURB-LOAD', 'PZR-HTR', 'PZR-SPRAY']) {
      expect(offeredFor(tag(tagId))).toEqual([])
      expect(withheldFor(tag(tagId)).map(control => control.reason.kind)).toEqual(['demand'])
    }
  })

  test('an isolation input is the I&C\'s, and an input with no operator words is not a control', () => {
    const feedValve = plant.graph.components[ownerIndex(tag('MFW-A-CV'))]!
    const isolation = feedValve.semantics.aspects[0]!.isolation!
    expect(itemOf(plant, controls, feedValve.index).withheld.find(control => control.path === isolation)!.reason.kind).toBe('isolationInput')
    const breaker = plant.graph.components[ownerIndex(tag('BRK-EDG-A-CLOSED'))]!
    const unworded = itemOf(plant, controls, breaker.index).withheld.filter(control => control.reason.kind === 'unworded')
    expect(unworded.length).toBe(1)
    expect(plant.graph.signalBindingByPath.get(unworded[0]!.path)!.quantity).toBe('boolean')
  })
})

describe('consequences and opposing automation, from the I&C config', () => {
  test('stopping a reactor coolant pump sets going the trip that reads its run state; starting it does not', () => {
    const [control] = derivePlantControls(plant, { ...declarations, notOffered: () => undefined }).items.flatMap(entry => entry.offered).filter(candidate => candidate.path === tag('RCP-A-RUN').path)
    const [start, stop] = control!.options
    expect(stop!.consequences.map(rule => rule.action)).toContain('RX TRIP')
    expect(start!.consequences).toEqual([])
  })

  test('the SI signal writes an SI pump running: it opposes STOP, not START', () => {
    const [control] = offeredFor(tag('SI-PUMP-A'))
    const [start, stop] = control!.options
    expect(stop!.opposing.length).toBeGreaterThan(0)
    expect(stop!.opposing.every(rule => rule.value === true && rule.via === 'command')).toBe(true)
    expect(start!.opposing).toEqual([])
  })

  test('at power, stopping an RCP arms its trip; after a safety injection a pump stop is held by the sealed-in SI signal', () => {
    const runtime = createProcessPlantRuntime({ system: plant })
    const protection = createProcessPlantProtectionRunner({ system: plant, protection: plant.automation })
    const step = () => {
      runtime.tick(1_000)
      protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-controls' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
    }
    const context = () => ({
      read: (path: VariablePath) => runtime.readVariable(path),
      mode: processPlantOperatingMode({ system: plant, runtime, modes: plant.automation.operatingModes })?.id ?? null,
      rules: ruleStatesFrom(protection.snapshot()),
    })
    for (let second = 0; second < 5; second += 1) step()
    const unrestricted = derivePlantControls(plant, { ...declarations, notOffered: () => undefined })
    const rcp = unrestricted.items.flatMap(entry => entry.offered).find(candidate => candidate.path === tag('RCP-A-RUN').path)!
    const rcpStop = optionStanding(plant, rcp, rcp.options[1]!, context())
    expect(rcpStop.consequences.map(rule => [rule.action, rule.state])).toContainEqual(['RX TRIP', 'armed'])
    const siPump = unrestricted.items.flatMap(entry => entry.offered).find(candidate => candidate.path === tag('SI-PUMP-A').path)!
    expect(optionStanding(plant, siPump, siPump.options[1]!, context()).heldBy).toBeUndefined()
    // Pressurizer pressure below the SI set point: the SI signal starts the pumps once and seals in.
    const pressure = tag('PT-455')
    runtime.writeCommand({ type: 'setVariable', path: tag('PZR-HTR').path, value: 0 })
    let elapsed = 0
    while (!protection.snapshot().rules.find(rule => rule.ruleId === 'safety-injection-low-pzr-pressure')!.latched && elapsed < 600) {
      runtime.writeCommand({ type: 'setVariable', path: tag('PORV-456A').path, value: 1 })
      step()
      elapsed += 1
    }
    expect(Number(runtime.readVariable(pressure.path))).toBeLessThan(12.7)
    const held = optionStanding(plant, siPump, siPump.options[1]!, context())
    expect(held.heldBy?.ruleId.startsWith('safety-injection')).toBe(true)
    expect(held.opposing.find(rule => rule.ruleId === held.heldBy!.ruleId)).toMatchObject({ state: 'acted' })
  })
})

// The same Plant with every component id replaced by an opaque one offers
// and withholds the same controls, word for word.
const opaque = new Map(plant.sourceGraph.components.map((component, index) => [String(component.id), `u${index}`]))
const renamedString = (value: string): string => {
  const exact = opaque.get(value)
  if (exact !== undefined) return exact
  const dot = value.indexOf('.')
  const owner = dot > 0 ? opaque.get(value.slice(0, dot)) : undefined
  return owner === undefined ? value : `${owner}${value.slice(dot)}`
}
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
  automation: renamed(plant.automation),
}

describe('controls depend on the Plant graph, not on equipment ids', () => {
  test('the renamed Plant has no reference PWR id left', () => {
    expect(anonymous.graph.components.every(component => /^u\d+$/.test(String(component.id)))).toBe(true)
  })

  test('derives the same controls under opaque ids', () => {
    const unnamed = derivePlantControls(anonymous, declarations)
    expect(unnamed.items.length).toBe(controls.items.length)
    expect(unnamed.items.flatMap(entry => entry.offered).length).toBeGreaterThan(30)
    expect(unnamed).toEqual(renamed(controls))
  })
})
