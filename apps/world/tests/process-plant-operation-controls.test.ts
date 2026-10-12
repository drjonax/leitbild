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
  type ProcessGraphPresentation,
  type ProcessSignalBinding,
  type VariablePath,
} from '../src/packs/process-plant/index.ts'
import { resolveProcessPlantSignalBinding } from '../src/packs/process-plant/signals.ts'
import {
  declaredController,
  derivePlantControls,
  offeredOption,
  type ItemControls,
  type OfferedControl,
} from '../src/packs/process-plant/operations/controls.ts'
import { optionStanding, ruleStatesFrom } from '../src/packs/process-plant/operations/control-standing.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// Controls are derived from what the model declares, never from what the
// reference PWR calls its equipment: aspects and their commands, momentary
// pushbuttons and "not offered" statements in the equipment's presentation,
// declared controllers, and the I&C config.

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:controls', loopCount: 4 }))
const tag = (tagId: string): ProcessSignalBinding => resolveProcessPlantSignalBinding(plant.graph, { tagId: tagId as never })
const ownerIndex = (binding: ProcessSignalBinding): number => {
  if (binding.owner.type !== 'component') throw new Error(`${binding.path} is not a component variable`)
  return binding.owner.componentIndex
}

/** The Plant with the presentation of the equipment owning a tag changed. */
const withPresentation = (system: CompiledProcessPlant, tagId: string, change: (presentation: ProcessGraphPresentation, local: string) => ProcessGraphPresentation): CompiledProcessPlant => {
  const binding = resolveProcessPlantSignalBinding(system.graph, { tagId: tagId as never })
  const owner = system.graph.components[ownerIndex(binding)]!
  const local = String(binding.path).slice(String(owner.id).length + 1)
  const sourceGraph: PlantGraphSpec = {
    ...system.sourceGraph,
    components: system.sourceGraph.components.map(component => component.id !== owner.id ? component
      : { ...component, metadata: { ...component.metadata, presentation: change(component.metadata?.presentation ?? {}, local) } }),
  }
  return { ...system, sourceGraph, graph: compilePlantGraph(sourceGraph, processPlantComponentRegistry) }
}

const controls = derivePlantControls(plant)
const itemOf = (result: ReturnType<typeof derivePlantControls>, componentIndex: number): ItemControls =>
  result.items.find(entry => entry.item.component === componentIndex && entry.item.kind === 'component')!
const offeredFor = (binding: ProcessSignalBinding): ReadonlyArray<OfferedControl> =>
  controls.items.flatMap(entry => entry.offered.filter(control => control.path === binding.path))
const withheldFor = (binding: ProcessSignalBinding) =>
  controls.items.flatMap(entry => entry.withheld.filter(control => control.path === binding.path))
const option = (control: OfferedControl, word: string) => control.options.find(candidate => candidate.word === word)!

describe('controls an operator is offered', () => {
  test('an isolating valve bundled in its host is a two-state control that opens and shuts it', () => {
    const blockValve = tag('MOV-8000A')
    const [control] = offeredFor(blockValve)
    expect(control!.form).toBe('twoState')
    expect(control!.options.map(entry => [entry.word, entry.value, entry.state])).toEqual([['OPEN', 1, 'OPEN'], ['SHUT', 0, 'SHUT']])
    expect(control!.target.startsWith('MOV-8000A ')).toBe(true)
    // Its state is the position the motor drove it to, not its demand.
    expect(control!.state).not.toBe(blockValve.path)
  })

  test('a pump starts and stops; a breaker closes and opens', () => {
    expect(offeredFor(tag('SI-PUMP-A'))[0]!.options.map(entry => [entry.word, entry.value, entry.state])).toEqual([['START', true, 'RUN'], ['STOP', false, 'STOP']])
    expect(offeredFor(tag('BRK-EDG-A-CLOSED'))[0]!.options.map(entry => [entry.word, entry.value, entry.state])).toEqual([['CLOSE', true, 'CLOSED'], ['OPEN', false, 'OPEN']])
  })

  test('an option the presentation declares not offered is withheld with why, and the others stay', () => {
    const [control] = offeredFor(tag('RCP-A-RUN'))
    expect(control!.options.map(entry => entry.word)).toEqual(['STOP'])
    expect(control!.withheldOptions).toEqual([{ word: 'START', value: true, reason: 'An RCP start needs seal injection and oil lift, which the model does not have: not started from the display' }])
    expect(offeredOption(plant, controls, { path: tag('RCP-A-RUN').path, value: true })).toEqual({ ok: false, reason: control!.withheldOptions[0]!.reason })
  })

  test('a command declared not offered at every value is withheld, saying why', () => {
    for (const tagId of ['TRIP-BKR-A', 'TRIP-BKR-B']) {
      expect(offeredFor(tag(tagId))).toEqual([])
      expect(withheldFor(tag(tagId)).map(control => control.reason)).toEqual([{ kind: 'declared', text: 'Reactor trip breakers open on the manual reactor trip and close only in a startup after the trip is reset: not operated from the display' }])
    }
    const safetyValve = plant.graph.components.find(component => component.metadata?.presentation?.notOffered?.positionFraction !== undefined)!
    expect(itemOf(controls, safetyValve.index).offered).toEqual([])
  })

  test('pushbuttons of undrawn logic sit on the energy end their rules command, and nowhere else', () => {
    for (const [tagId, role] of [['SI-BLOCK', 'source'], ['RX-TRIP-MAN', 'source'], ['SI-MAN', 'source'], ['TURB-TRIP-MAN', 'sink']] as const) {
      const input = tag(tagId)
      const hosts = controls.items.filter(entry => entry.offered.some(control => control.path === input.path))
      expect(hosts.map(entry => plant.graph.components[entry.item.component]!.semantics.energy.map(energy => energy.role))).toEqual([[role]])
      const [pushbutton] = hosts[0]!.offered.filter(control => control.path === input.path)
      expect(pushbutton!.form).toBe('pushbutton')
      expect(pushbutton!.options.map(entry => entry.value)).toEqual([true])
      expect(pushbutton!.from).toBe(String(plant.graph.components[ownerIndex(input)]!.id))
    }
    // Pressing the manual reactor trip sets the reactor trip going.
    expect(offeredFor(tag('RX-TRIP-MAN'))[0]!.options[0]!.consequences.map(rule => rule.action)).toEqual(['RX TRIP'])
    expect(controls.unplaced).toEqual([])
  })

  test('the compiler takes a not-offered statement only on the equipment\'s own commands, at values they take', () => {
    expect(() => withPresentation(plant, 'PT-455', (presentation, local) => ({ ...presentation, notOffered: { [local]: { text: 'A reading' } } })))
      .toThrow('which is not one of its commands')
    expect(() => withPresentation(plant, 'SI-PUMP-A', (presentation, local) => ({ ...presentation, notOffered: { [local]: { text: 'Not here', values: [1] } } })))
      .toThrow('which it does not take')
  })

  test('without its momentary mark a logic input is offered nowhere', () => {
    const unmarked = withPresentation(plant, 'SI-BLOCK', ({ momentary: _momentary, ...presentation }) => presentation)
    expect(derivePlantControls(unmarked).items.flatMap(entry => entry.offered).some(control => control.path === tag('SI-BLOCK').path)).toBe(false)
  })
})

describe('what is withheld, and why', () => {
  test('a fault the scenario injects and a condition outside the Plant are listed nowhere (I-1)', () => {
    const listed = [...controls.items.flatMap(entry => entry.offered), ...controls.items.flatMap(entry => entry.withheld)]
    for (const control of listed) expect(plant.graph.signalBindingByPath.get(control.path)!.actuation).toBe('command')
    const fault = plant.graph.signalBindings.find(binding => binding.actuation === 'faultInjection')!
    expect(offeredOption(plant, controls, { path: fault.path, value: true })).toEqual({ ok: false, reason: `${fault.tagId ?? fault.path} is a fault the scenario injects: only instructor actions and the Scenario set it` })
  })

  test('a demand its controller writes every step reads AUTO with what it holds, and is never offered', () => {
    const controlled = plant.graph.components.filter(component => declaredController(component) !== null)
    expect(controlled.length).toBeGreaterThan(0)
    for (const component of controlled) {
      const entry = itemOf(controls, component.index)
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
    expect(itemOf(controls, feedValve.index).withheld.find(control => control.path === isolation)!.reason.kind).toBe('isolationInput')
    const breaker = plant.graph.components[ownerIndex(tag('BRK-EDG-A-CLOSED'))]!
    const unworded = itemOf(controls, breaker.index).withheld.filter(control => control.reason.kind === 'unworded')
    expect(unworded.length).toBe(1)
    expect(plant.graph.signalBindingByPath.get(unworded[0]!.path)!.quantity).toBe('boolean')
  })
})

describe('consequences and opposing automation, from the I&C config', () => {
  test('stopping a reactor coolant pump sets going the trip that reads its run state', () => {
    expect(option(offeredFor(tag('RCP-A-RUN'))[0]!, 'STOP').consequences.map(rule => rule.action)).toContain('RX TRIP')
  })

  test('the SI signal writes an SI pump running: it opposes STOP, not START', () => {
    const [control] = offeredFor(tag('SI-PUMP-A'))
    expect(option(control!, 'STOP').opposing.length).toBeGreaterThan(0)
    expect(option(control!, 'STOP').opposing.every(rule => rule.value === true && rule.via === 'command')).toBe(true)
    expect(option(control!, 'START').opposing).toEqual([])
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
    const rcp = offeredFor(tag('RCP-A-RUN'))[0]!
    expect(optionStanding(plant, rcp, option(rcp, 'STOP'), context()).consequences.map(rule => [rule.action, rule.state])).toContainEqual(['RX TRIP', 'armed'])
    const siPump = offeredFor(tag('SI-PUMP-A'))[0]!
    expect(optionStanding(plant, siPump, option(siPump, 'STOP'), context()).heldBy).toBeUndefined()
    // Pressurizer pressure below the SI set point: the SI signal starts the pumps once and seals in.
    runtime.writeCommand({ type: 'setVariable', path: tag('PZR-HTR').path, value: 0 })
    let elapsed = 0
    while (!protection.snapshot().rules.find(rule => rule.ruleId === 'safety-injection-low-pzr-pressure')!.latched && elapsed < 600) {
      runtime.writeCommand({ type: 'setVariable', path: tag('PORV-456A').path, value: 1 })
      step()
      elapsed += 1
    }
    expect(Number(runtime.readVariable(tag('PT-455').path))).toBeLessThan(12.7)
    const held = optionStanding(plant, siPump, option(siPump, 'STOP'), context())
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
    const unnamed = derivePlantControls(anonymous)
    expect(unnamed.items.length).toBe(controls.items.length)
    expect(unnamed.items.flatMap(entry => entry.offered).length).toBeGreaterThan(30)
    expect(unnamed).toEqual(renamed(controls))
  })
})
