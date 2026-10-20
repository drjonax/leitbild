import { describe, expect, test } from 'bun:test'
import type { IsoTimestamp } from '../src/core/model/index.ts'
import { recordingSeriesIdFor } from '../src/core/model/index.ts'
import {
  answerProcessPlantQuery,
  compileProcessPlant,
  createProcessPlantProtectionRunner,
  createProcessPlantRampRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
} from '../src/packs/process-plant/index.ts'
import { createProcessPlantRuntimePerformance, type ProcessPlantRuntimeInstance } from '../src/packs/process-plant/runtime-instance.ts'
import { recordedPlantVariables } from '../src/packs/process-plant/recording.ts'
import { compileMimic, type MimicBudget } from '../src/packs/process-plant/displays/mimic/compile-mimic.ts'
import { MIMIC_MAX_WIDTH, type CompiledMimic } from '../src/packs/process-plant/displays/mimic/mimic-model.ts'
import { chatMimicProfile } from '../src/packs/process-plant/displays/mimic/profiles.ts'
import { indexSample } from '../src/packs/process-plant/displays/mimic/evaluate.ts'
import { itemRowTexts } from '../src/packs/process-plant/displays/mimic/rows.ts'
import type { MimicIntent } from '../src/packs/process-plant/displays/mimic/scope.ts'
import { plantCarriers, plantLoops } from '../src/packs/process-plant/equipment/circuits.ts'
import { carriersAt } from '../src/packs/process-plant/graph/index.ts'
import { guardPlantTests, PLANT_HANG_GUARD_MS } from './plant-hang-guard.ts'

guardPlantTests()

const plantWithLoops = (loopCount: number): ProcessPlantRuntimeInstance => {
  const compiled = compileProcessPlant(createPwrReferencePlantDefinition({ id: `plant:mimic-${loopCount}`, loopCount }))
  const runtime = createProcessPlantRuntime({ system: compiled })
  return {
    plant: compiled,
    runtime,
    ramps: createProcessPlantRampRunner({ runtime }),
    protection: createProcessPlantProtectionRunner({ system: compiled, protection: compiled.automation }),
    performance: createProcessPlantRuntimePerformance(),
  }
}

// The room a mimic-led display leaves beside alarms: 800 px wide, about 620 px tall.
const roomy: MimicBudget = { profile: chatMimicProfile, maxWidth: MIMIC_MAX_WIDTH, maxHeight: 624 }

const generated = (system: ProcessPlantRuntimeInstance, intent: MimicIntent, budget = roomy): CompiledMimic => {
  const result = compileMimic(system.plant, intent, budget)
  if (!result.ok) throw new Error(result.issues.map(issue => issue.message).join('; '))
  return result.mimic
}

// Situations no hand-drawn view ever covered: the drawing comes from the graph.
const situations: ReadonlyArray<[string, MimicIntent]> = [
  ['is the diesel feeding the AFW motor pump', { from: ['dieselGeneratorA'], to: ['auxFeedwaterPumpMotor'] }],
  ['what supplies safety bus A', { to: ['safetyBusA'] }],
  ['the SI lineup to loop C', { services: ['safetyInjection'], loops: ['C'] }],
  ['where letdown goes', { from: ['letdownValve'], services: ['letdown', 'charging'] }],
  ['the pressurizer relief path', { from: ['pressurizer'], to: ['PRT'] }],
  ['all four reactor coolant loops', { services: ['primaryCoolant'] }],
  ['main and auxiliary feed to SG B', { to: ['sgB'], services: ['feedwater', 'auxFeedwater'] }],
  ['auxiliary feedwater to every SG', { services: ['auxFeedwater'] }],
]

describe('generated equipment mimics', () => {
  const system = plantWithLoops(4)

  for (const [question, intent] of situations) {
    test(`draws ${question} from the Plant graph, within the box, verified`, () => {
      const mimic = generated(system, intent)
      expect(mimic.width).toBeLessThanOrEqual(roomy.maxWidth)
      expect(mimic.height).toBeLessThanOrEqual(roomy.maxHeight)
      expect(mimic.items.length).toBeGreaterThan(1)
      // Every drawn pipe is orthogonal.
      for (const pipe of mimic.pipes) {
        pipe.points.slice(1).forEach(([x, y], at) => {
          const [px, py] = pipe.points[at]!
          expect(px === x || py === y).toBe(true)
        })
      }
    })
  }

  test('never draws a command, a fault knob or a diagnostic as equipment state', () => {
    const graph = system.plant.graph
    for (const [, intent] of situations) {
      for (const item of generated(system, intent).items) {
        const state = item.binding.state
        for (const path of [state?.state?.path, state?.throughput?.path].filter(path => path !== undefined)) {
          const binding = graph.signalBindingByPath.get(path!)!
          expect(!binding.writable || binding.actuation === 'boundary').toBe(true)
        }
        if (state?.command !== undefined) expect(graph.signalBindingByPath.get(state.command)!.actuation).toBe('command')
      }
    }
  })

  test('the PORV the model bundles in the pressurizer is drawn on the relief line with the opening it relieves through', () => {
    const mimic = generated(system, { from: ['pressurizer'], to: ['PRT'] })
    expect(mimic.items.map(item => item.binding.label).sort()).toEqual(['PORV', 'PORV block', 'PRT', 'PZR', 'Relief header', 'Safety valves'])
    const porv = mimic.items.find(item => item.binding.label === 'PORV')!
    expect(porv.presentation).toEqual({ element: 'device', icon: 'valve-digital', aspect: 'position' })
    expect(porv.rows.map(row => row.kind)).toEqual(['position', 'mismatch'])
    // Its block valve is drawn in series on the same line, between it and the pressurizer, and the code
    // safety valves on their own line; both lines join the relief header to the tank.
    const block = mimic.items.find(item => item.binding.label === 'PORV block')!
    expect(block.presentation).toEqual({ element: 'device', icon: 'valve-digital', aspect: 'position' })
    const safeties = mimic.items.find(item => item.binding.label === 'Safety valves')!
    expect(safeties.presentation).toEqual({ element: 'device', icon: 'valve-digital', aspect: 'position' })
    expect(safeties.rows.map(row => row.kind)).toEqual(['position'])
    expect(mimic.summary.unmeasuredStates).toEqual([])
  })

  test('a lone pipe into a hub names where it enters, and the hub then writes no value of its own', () => {
    // Safety injection to loop C reaches the core at cold leg C only; the header's stub names the other legs.
    const drawn = (intent: MimicIntent) => generated(system, intent)
    const core = (mimic: CompiledMimic) => mimic.items.find(item => item.components.includes('core'))!
    const si = drawn({ services: ['safetyInjection'], loops: ['C'] })
    // Run 22 read "Core 323 °C" where the route enters cold leg C; earlier "Core · cold leg C" beside 339 °C read
    // as the cold leg's temperature. The core is the route's destination: its port named, no value beside it.
    expect(core(si).binding.label).toBe('Core · cold leg C')
    expect(core(si).rows.filter(row => row.kind === 'value')).toEqual([])
    expect(core(drawn({ services: ['primaryInjection'], loops: ['A'] })).binding.label).toBe('Core · cold leg A')
    // Several legs reached: the equipment on them tells them apart, the core keeps its label and its values, and
    // headers never list their branches.
    for (const intent of [{ services: ['primaryCoolant'], loops: ['A'] }, { services: ['primaryCoolant'] }]) {
      expect(core(drawn(intent)).binding.label).toBe('Core')
      expect(core(drawn(intent)).rows.some(row => row.kind === 'value')).toBe(true)
    }
  })

  test('the same intent on the same model draws the same mimic', () => {
    const intent = { to: ['safetyBusA'] }
    expect(generated(system, intent).hash).toBe(generated(system, intent).hash)
    expect(JSON.stringify(generated(system, intent))).toBe(JSON.stringify(generated(system, intent)))
  })

  test('a scope too large to read at a glance is refused with narrower intents that fit', () => {
    const result = compileMimic(system.plant, { services: ['primaryInjection'] }, { profile: chatMimicProfile, maxWidth: 600, maxHeight: 400 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues[0]!.message).toMatch(/it fits with "loops":\["A"/)
    // Around an item, the first narrower drawing offered stays centred on it: fewer links out.
    const around = compileMimic(system.plant, { around: ['containment'] }, { profile: chatMimicProfile, maxWidth: MIMIC_MAX_WIDTH, maxHeight: 628 })
    if (around.ok) throw new Error('expected a refusal')
    expect(around.issues[0]!.message).toMatch(/it fits with "reach":1/)
    expect(compileMimic(system.plant, { around: ['containment'], reach: 1 }, { profile: chatMimicProfile, maxWidth: MIMIC_MAX_WIDTH, maxHeight: 628 }).ok).toBe(true)
  })

  test('around a safety bus, loads that carry nothing further are named on a stub so the drawing stays legible', () => {
    // Evaluation run 24: the sequenced loads made this drawing ten shared symbols, and it was refused twice.
    const mimic = generated(system, { around: ['safetyBusA'], services: ['electricalPower'], reach: 1 })
    // The supply stays drawn: the bus, its diesel and breakers; the pumps and loads it feeds are named where the drawing stops.
    expect(mimic.items.map(item => item.binding.label)).toEqual(expect.arrayContaining(['Bus A', 'EDG A', 'EDG BKR A', 'Offsite BKR A']))
    expect(mimic.stubs.some(stub => /^to .*CCW A/.test(stub.text))).toBe(true)
  })

  test('names that do not resolve come back with suggestions', () => {
    const result = compileMimic(system.plant, { to: ['steam gen B'], services: ['feedwater'] }, roomy)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues[0]!.didYouMean![0]).toStartWith('sgB (Steam Generator B, SG B)')
  })

  test('a drawing too large says how far off its closest layout is', () => {
    const result = compileMimic(system.plant, { services: ['auxFeedwater', 'feedwater'] }, roomy)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues[0]!.message.match(/the drawing needs/g)).toHaveLength(1)
  })
})

// Bends of a drawn pipe: where its polyline turns.
const bendsOf = (points: ReadonlyArray<readonly [number, number]>): number =>
  points.slice(1, -1).filter((b, i) => {
    const [a, c] = [points[i]!, points[i + 2]!]
    return !((a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1]))
  }).length

describe('alarm badges in a chat column', () => {
  const system = plantWithLoops(4)

  test('reserve room for the whole badge and its count where the drawing still fits, else only what each badge watches', () => {
    // Safety bus A's supply has room: the grid's badge names its action ("V LO-LO · ALM"), never "V LO-LO" alone (HMI review of run 23).
    const places = (mimic: CompiledMimic) => mimic.items.filter(item => item.flapLines.length > 0 || item.rows.some(row => row.kind === 'alarm')).map(item => item.binding.label)
    const bus = generated(system, { to: ['safetyBusA'] })
    expect(places(bus)).toContain('Grid')
    // All four primary loops have none to spare: they are drawn as before, each badge reserving only what it watches,
    // the core's rows of its flux in the range that reads it and whether its rods are on bottom (and a trip it does
    // not follow) above its tag.
    const loops = generated(system, { services: ['primaryCoolant'] })
    expect(places(loops)).toEqual([])
    expect([loops.width, loops.height]).toEqual([747, 538])
  })
})

describe('every intent over the reference Plant draws or is refused with a reason', () => {
  const system = plantWithLoops(4)
  const graph = system.plant.graph
  // One-ended intents from and to every component per service it carries (and all of them together),
  // every service alone and per loop, and every pair of services.
  const carriers = plantCarriers(graph)
  const sweep: MimicIntent[] = [
    ...graph.components.flatMap(component => (['in', 'out'] as const).flatMap(side => {
      const end = side === 'in' ? 'to' : 'from'
      const carried = carriersAt(graph, component.index, side).filter(carrier => carriers.includes(carrier))
      return [...carried.map(service => ({ [end]: [String(component.id)], services: [service] })), ...(carried.length > 1 ? [{ [end]: [String(component.id)], services: carried }] : [])]
    })),
    ...carriers.flatMap(service => [{ services: [service] }, ...plantLoops(graph).map(loop => ({ services: [service], loops: [loop] }))]),
    ...carriers.flatMap((a, index) => carriers.slice(index + 1).map(b => ({ services: [a, b] }))),
  ]

  test('no intent throws, and no drawing fails its own verification', () => {
    expect(sweep.length).toBeGreaterThan(350)
    const failures = sweep.flatMap(intent => {
      try {
        const result = compileMimic(system.plant, intent, roomy)
        if (result.ok) {
          const bent = result.mimic.pipes.filter(pipe => bendsOf(pipe.points) > 3)
          return bent.length === 0 ? [] : [`${JSON.stringify(intent)}: ${bent.map(pipe => pipe.id).join(', ')} bend more than three times`]
        }
        return result.issues.some(issue => /could not be verified/.test(issue.message)) ? [`${JSON.stringify(intent)}: ${result.issues[0]!.message}`] : []
      } catch (error) {
        return [`${JSON.stringify(intent)} threw ${(error as Error).message}`]
      }
    })
    expect(failures).toEqual([])
  }, PLANT_HANG_GUARD_MS) // A watchdog for the whole sweep, not the property it measures.

  test('is the diesel feeding the motor-driven AFW pump: the pump with its suction and its supply', () => {
    const mimic = generated(system, { to: ['auxFeedwaterPumpMotor'], services: ['auxFeedwater', 'electricalPower'] })
    expect(mimic.items.map(item => item.binding.label)).toEqual(expect.arrayContaining(['MD AFW A', 'CST', 'Bus A', 'EDG A', 'EDG BKR A']))
    for (const pipe of mimic.pipes) expect(bendsOf(pipe.points)).toBeLessThanOrEqual(3)
    for (const to of ['mainFeedwaterPumpA', 'safetyInjectionPumpA']) {
      const services = to === 'mainFeedwaterPumpA' ? ['electricalPower', 'feedwater'] : ['electricalPower', 'safetyInjection']
      expect(compileMimic(system.plant, { to: [to], services }, roomy).ok).toBe(true)
    }
  })

  test('a line-up draws what else feeds the port it ends at once through, where that stays legible', () => {
    // Evaluation run 23: the safety injection line-up to loop C drew no accumulator, though accumulator C injects
    // into cold leg C beside the SI header. The reactor coolant pump that also enters it is part of the loop through
    // the core, not a supply.
    const si = generated(system, { services: ['safetyInjection'], loops: ['C'] })
    const labels = si.items.map(item => item.binding.label)
    expect(labels).toEqual(expect.arrayContaining(['RWST', 'HHSI A', 'HHSI B', 'SI header', 'ACC C', 'ACC C discharge isolation valve', 'ACC C check valve']))
    expect(labels).not.toContain('RCP C')
    expect(si.summary.carriers).toEqual(['primaryInjection', 'safetyInjection'])
    // The auxiliary feed beside the main feed into all four steam generators draws legibly neither drawn nor
    // stopped at their inlets: the drawing is as asked.
    const feed = generated(system, { services: ['feedwater'] })
    expect(feed.summary.carriers).toEqual(['feedwater'])
    expect(feed.items.map(item => item.binding.label)).not.toContain('AFW valve A')
  })

  test('a system whose lines skip a layer draws them with one jog: charging', () => {
    for (const intent of [{ services: ['charging'] }, { to: ['core'], services: ['charging'] }]) {
      const mimic = generated(system, intent)
      for (const pipe of mimic.pipes) expect(bendsOf(pipe.points)).toBeLessThanOrEqual(2)
    }
  })

  test('one loop returns to the vessel it leaves, drawn beside it', () => {
    const mimic = generated(system, { services: ['primaryCoolant'], loops: ['A'] })
    expect(mimic.items.map(item => item.binding.label)).toEqual(expect.arrayContaining(['Core', 'SG A', 'RCP A']))
    expect(generated(system, { from: ['sgA'], services: ['primaryCoolant'] }, { profile: chatMimicProfile, maxWidth: 800, maxHeight: 812 }).items.length).toBeGreaterThan(3)
  })

  test('charging joins a cold leg at the reactor in one place, as the cold leg does', () => {
    const mimic = generated(system, { services: ['charging', 'primaryCoolant'], loops: ['A'] })
    const end = (linkId: string) => mimic.pipes.find(pipe => pipe.linkId === linkId)!.points.at(-1)
    expect(end('charging-pump-to-cold-leg-a')).toEqual(end('rcp-a-to-core'))
    // All four loops at once cross too often to read, and say so instead of failing.
    const all = compileMimic(system.plant, { services: ['charging', 'primaryCoolant'] }, roomy)
    expect(all.ok).toBe(false)
    if (!all.ok) expect(all.issues[0]!.message).toMatch(/crossing pipes|symbols|the drawing needs/)
  })

  test('a service with nothing in the loops named is refused with what to name instead', () => {
    const result = compileMimic(system.plant, { services: ['charging'], loops: ['D'] }, roomy)
    expect(result).toEqual({ ok: false, issues: [{ field: 'loops', message: 'charging has no equipment in loop D and no route into or out of it; it reaches loops A, B: name those, or drop "loops"' }] })
  })
})

describe('mimic panels in composed displays', () => {
  const system = plantWithLoops(4)
  const plants = new Map([[system.plant.id, system]])
  const recordedSeriesIds = new Set(recordedPlantVariables(system.plant, 'operations').map(variable => recordingSeriesIdFor(system.plant.id, variable.path)))
  const ask = (capabilityId: string, input: unknown) => answerProcessPlantQuery({
    request: { capabilityId, input },
    plants,
    objects: new Map(),
    simulationTime: '2026-10-09T10:00:00.000Z' as IsoTimestamp,
    recordedSeriesIds,
    // The Plant has not run, so its Run has recorded nothing yet.
    recordedHistory: { read: () => [] },
  })
  const display = (panels: ReadonlyArray<unknown>) => ({
    plantId: system.plant.id,
    title: 'Safety bus A supply',
    question: 'What supplies safety bus A now?',
    need: 'Decide whether to start the diesel',
    subjects: ['safetyBusA'],
    panels,
  })

  test('compose a mimic alone and say what it draws and where it stops', () => {
    const result = ask('world.process-plant.display.compose', display([{ kind: 'mimic', to: ['safetyBusA'] }])) as { shows: ReadonlyArray<string>; view: { height: number } }
    expect(result.shows[0]).toStartWith('Live equipment mimic generated from the Plant model (electricalPower)')
    expect(result.shows[0]).toContain('Bus A (safetyBusA)')
    expect(result.shows[1]).toStartWith('The drawing stops at:')
    expect(result.view.height).toBeLessThanOrEqual(900)
  })

  test('a mimic leads its display: with a trend and alarms the display may take up to 900 px', () => {
    const trend = { kind: 'trend', horizon: '10m', signals: [{ ref: 'SG-B-LVL-NR', role: 'primary' }] }
    const result = ask('world.process-plant.display.compose', display([{ kind: 'mimic', to: ['safetyBusA'] }, trend, { kind: 'alarms', scope: 'related' }])) as { view: { height: number } }
    expect(result.view.height).toBeGreaterThan(660)
    expect(result.view.height).toBeLessThanOrEqual(900)
  })

  test('a drawing that fits only with the room of another panel says which panel to drop', () => {
    const trend = { kind: 'trend', horizon: '10m', signals: [{ ref: 'SG-B-LVL-NR', role: 'primary' }, { ref: 'SG-A-LVL-NR', role: 'context' }, { ref: 'SG-C-LVL-NR', role: 'context' }, { ref: 'SG-D-LVL-NR', role: 'context' }] }
    expect(() => ask('world.process-plant.display.compose', { ...display([{ kind: 'mimic', to: ['sgB'], services: ['feedwater', 'auxFeedwater'] }, trend, { kind: 'alarms', scope: 'related' }]), subjects: ['sgB'] }))
      .toThrow('or it fits as asked without panels.1 (trend), or without panels.2 (alarms)')
  })

  test('a stored display re-opens with its drawing, and relates its alarms to the drawn equipment', () => {
    const composed = ask('world.process-plant.display.compose', { ...display([{ kind: 'mimic', from: ['pressurizer'], to: ['PRT'] }, { kind: 'alarms', scope: 'related' }]), subjects: ['pressurizer'] }) as { view: { state: string }; equipment: ReadonlyArray<{ id: string; label: string; state: string }> }
    expect(composed.equipment.map(item => item.label)).toEqual(['PZR', 'PRT', 'Relief header', 'PORV block', 'PORV', 'Safety valves'])
    expect(composed.equipment.find(item => item.label === 'PORV')!.state).toBe('closed')
    expect(composed.equipment.find(item => item.label === 'PORV block')!.state).toBe('open')
    const result = ask('world.process-plant.display.view', { plantId: system.plant.id, state: composed.view.state }) as {
      drawingChanged: boolean
      display: { panels: ReadonlyArray<{ kind: string; ruleIds?: ReadonlyArray<string> }> }
    }
    expect(result.drawingChanged).toBe(false)
    expect(result.display.panels[1]!.ruleIds).toEqual(expect.arrayContaining(['pzr-porv-flow', 'pzr-pressure-low']))
  })

  test('sample every live value a mimic draws in one call', () => {
    const mimic = generated(system, { to: ['safetyBusA'] })
    const sample = answerProcessPlantQuery({
      request: { capabilityId: 'world.process-plant.display.sample', input: { plantId: system.plant.id, paths: mimic.paths } },
      plants,
      objects: new Map(),
      simulationTime: '2026-10-09T10:00:00.000Z' as IsoTimestamp,
      recordedSeriesIds: new Set(),
    }) as { values: ReadonlyArray<unknown> }
    expect(sample.values).toHaveLength(mimic.paths.length)
  })
})
