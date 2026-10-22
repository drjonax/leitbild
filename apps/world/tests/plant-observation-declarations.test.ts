import { describe, expect, test } from 'bun:test'
import { recordingSeriesIdFor, type ObjectId } from '../src/core/model/index.ts'
import { observationDeclarationSchema, type ObservationDeclaration } from '../src/core/observation/capabilities.ts'
import { compileProcessPlant, createProcessPlantRuntime, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import type { CompiledProcessPlant } from '../src/packs/process-plant/plant-compiler.ts'
import { declarationRevision, plantDeclaration, type PlantRecording } from '../src/packs/process-plant/observation/declarations.ts'
import { answerProcessPlantObservationQuery, processPlantObservationCapabilityIds } from '../src/packs/process-plant/observation/query.ts'
import { recordedPlantVariables } from '../src/packs/process-plant/recording.ts'
import type { ProcessPlantRuntimeInstance } from '../src/packs/process-plant/runtime-instance.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// P2: what the four-loop reference Plant declares to World's observation
// layer (T12 plant; R23, R25, R26, R28, R29), and what it derives beside its
// signals (P2 D1): each operated item's state, each safety function's status.

const objectId = 'plant:halden-2' as ObjectId
const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: objectId, loopCount: 4 }))
const recordingOf = (of: CompiledProcessPlant): PlantRecording => ({
  seriesIds: new Set(recordedPlantVariables(of, 'operations').map(variable => recordingSeriesIdFor(of.id, variable.path))),
  intervalMs: 1_000,
})
const recording = recordingOf(plant)
const declaration = plantDeclaration(objectId, plant, recording)
const observable = (path: string) => declaration.observables.find(candidate => candidate.ref === `${objectId}#${path}`)!

describe('plant observation declarations (P2)', () => {
  test('T12: every published or recorded signal is declared and parses against core\'s quantity list and unit codes', () => {
    expect(observationDeclarationSchema.parse(declaration)).toEqual(declaration)
    // 1,021 signals (none a fault the scenario injects), 81 items' states, 8 rod banks' travel, 6 safety functions and the operating mode.
    expect(declaration.observables).toHaveLength(1117)
    expect(plantDeclaration(objectId, plant, null).observables).toHaveLength(796)
    expect(declaration.revision).toBe(`${plant.modelDigest}:1000ms:721`)
  })

  test('T12: labels are the unit\'s own, unique within it, and unique per Run once World qualifies them (R25)', () => {
    const labels = declaration.observables.map(entry => entry.label)
    expect(new Set(labels).size).toBe(labels.length)
    expect(labels.filter(label => label.includes('Halden'))).toEqual([])
    const units = ['Halden Unit 1', 'Halden Unit 2', 'Halden Unit 3', 'Halden Unit 4']
    const qualified = units.flatMap(unit => labels.map(label => `${unit} · ${label}`))
    expect(new Set(qualified).size).toBe(4 * labels.length)
    expect([observable('pressurizer.pressureMPa').label, observable('rcpA.speedFraction').label, observable('pressurizer-relief-to-tank.flowKgPerS').label])
      .toEqual(['Pressurizer pressure', 'Speed · RCP A', 'Pressurizer relief flow · PZR → Relief header'])
  })

  test('R37: the standard operator name joins the label of the very signal it names, and the diesel-backed buses are the emergency buses', () => {
    expect(['core.coreExitTemperatureC', 'core.powerRangePercent', 'vessel.meanPrimaryCoolantTemperatureC', 'deltaTChannelA.averageTemperatureC', 'rcs-hot-leg-a.temperatureC', 'rcs-cold-leg-a.temperatureC'].map(path => observable(path).label)).toEqual([
      'Core-exit temperature (CET) · Core',
      'Power-range neutron flux (reactor power) · Core',
      'Mean primary coolant temperature (Tavg) · RV',
      'Loop average temperature (Tavg) · dT channel A',
      'RCS hot leg A temperature (Thot) · Core → SG A',
      'RCS cold leg A temperature (Tcold) · SG A → RCP A',
    ])
    expect(declaration.observables.filter(entry => /\((CET|Tavg|Thot|Tcold|reactor power)\)/.test(entry.label))).toHaveLength(15)
    // Pressurizer pressure keeps its own name: the model reads each loop's hot- and cold-leg pressures too, so "RCS pressure" would mislead.
    expect(observable('pressurizer.pressureMPa').label).toBe('Pressurizer pressure')
    expect(declaration.elements.filter(element => element.label.includes('emergency bus')).map(element => element.id)).toEqual(['safetyBusA', 'safetyBusB'])
  })

  test('T12: each Plant quantity maps to a physical kind by what the variable measures (R26, R28)', () => {
    const kind = (path: string) => [observable(path).quantity, observable(path).unit]
    expect({
      level: kind('sgA.levelPercent'),
      position: kind('mainSteamIsolationValveA.positionFraction'),
      fissionPower: kind('core.powerMw'),
      electricOutput: kind('turbine.electricMw'),
      pumpDemand: kind('rcpA.demandMw'),
      fluxPercent: kind('core.powerRangePercent'),
      startupRate: kind('core.intermediateRangeStartupRateDpm'),
      pressure: kind('pressurizer.pressureMPa'),
      state: kind('loadSequencerA.step'),
    }).toEqual({
      level: ['level', '%'],
      position: ['fraction', '1'],
      fissionPower: ['thermal-power', 'MW'],
      electricOutput: ['electric-power', 'MW'],
      pumpDemand: ['electric-power', 'MW'],
      fluxPercent: ['thermal-fraction', '%'],
      startupRate: ['log-rate', 'DPM'],
      pressure: ['pressure', 'MPa'],
      state: ['count', '1'],
    })
    const kinds = new Set(declaration.observables.map(entry => entry.quantity))
    expect(kinds.size).toBeGreaterThanOrEqual(15)
  })

  test('refs are <object>#<variable path>, the I&C tag beside them, the element their owning equipment or line (R23)', () => {
    expect(observable('pressurizer.pressureMPa')).toMatchObject({ ref: 'plant:halden-2#pressurizer.pressureMPa', tag: 'PT-455', element: 'pressurizer', basis: 'instrument' })
    expect(observable('sgA.levelPercent')).toMatchObject({ tag: 'SG-A-LVL-NR', element: 'sgA' })
    expect(observable('mainSteamIsolationValveA.positionFraction')).toMatchObject({ tag: 'MSIV-A', basis: 'command' })
    expect(observable('core.powerRangePercent').element).toBe('core')
    expect(observable('pressurizer-relief-to-tank.flowKgPerS')).toMatchObject({ element: 'pressurizer-relief-to-tank' })
    expect(observable('pressurizer-relief-to-tank.flowKgPerS').tag).toBeUndefined()
    const elements = new Set(declaration.elements.map(element => element.id))
    // A safety function and the operating mode are the unit's, measured on no equipment.
    expect(declaration.observables.filter(entry => entry.element === undefined).map(entry => entry.ref)).toEqual([...plant.automation.safetyFunctions.map(entry => `${objectId}#csf.${entry.id}`), `${objectId}#mode`])
    expect(declaration.observables.filter(entry => entry.element !== undefined && !elements.has(entry.element)).map(entry => entry.ref)).toEqual([])
  })

  test('D1: each item that runs, is live, or opens and shuts declares its state as an enum in the words its controls use', () => {
    const states = declaration.observables.filter(entry => entry.ref.endsWith('.state'))
    expect(states).toHaveLength(81)
    expect(states.every(entry => entry.valueType === 'enum' && entry.quantity === 'state' && entry.series === null && entry.thresholds.length === 0)).toBe(true)
    const words = (path: string) => [observable(path).label, observable(path).element, observable(path).states!.map(state => `${state.value}=${state.label}`).join(' ')]
    const items = ['rcpA', 'offsiteBreakerA', 'mainSteamIsolationValveA', 'pressurizer.reliefValve', 'turbine', 'safetyBusA', 'pressurizer.safetyValves', 'safetyAccumulatorA.dischargeIsolationValve']
    expect(items.map(item => words(`${item}.state`))).toEqual([
      ['State · RCP A', 'rcpA', 'on=RUN off=STOP'],
      ['State · Offsite BKR A', 'offsiteBreakerA', 'on=CLOSED off=OPEN'],
      ['State · MSIV A', 'mainSteamIsolationValveA', 'on=OPEN off=SHUT between=part open'],
      ['State · PORV', 'pressurizer.reliefValve', 'on=OPEN off=SHUT between=part open'],
      // Offered only its trip, the turbine says its own state, in its declared words; a bus is live or dead; a code safety valve no one operates opens and shuts.
      ['State · Turbine', 'turbine', 'on=ON LINE off=OFF LINE'],
      ['State · Bus A', 'safetyBusA', 'on=LIVE off=DEAD'],
      ['State · Safety valves', 'pressurizer.safetyValves', 'on=OPEN off=SHUT between=part open'],
      // Its position the model does not solve: it is declared, and reads "position not measured".
      ['State · ACC A discharge isolation valve', 'safetyAccumulatorA.dischargeIsolationValve', 'on=OPEN off=SHUT'],
    ])
    // Q8: the states a running or conducting binding reads as on: on, and a valve part open, which passes flow.
    const active = (path: string) => observable(path).states!.filter(state => state.active === true).map(state => state.value)
    expect([active('rcpA.state'), active('offsiteBreakerA.state'), active('dieselGeneratorA.state'), active('mainSteamIsolationValveA.state'), active('pressurizer.reliefValve.state')]).toEqual([['on'], ['on'], ['on'], ['on', 'between'], ['on', 'between']])
    expect(states.every(entry => entry.states!.every(state => (state.value === 'off') !== (state.active === true)))).toBe(true)
  })

  test('P9: the operating mode is the unit\'s state, an enum of its declared modes and the word for none holding', () => {
    expect(observable('mode')).toEqual({
      ref: `${objectId}#mode`, label: 'Operating mode', quantity: 'state', unit: '', valueType: 'enum', thresholds: [], series: null,
      states: [...plant.automation.operatingModes.map(mode => ({ value: mode.id, label: mode.label })), { value: 'none', label: 'No declared mode holds' }],
    })
    expect(observable('mode').states!.map(state => state.label)).toEqual(['Power operation', 'Startup', 'Hot standby', 'Hot shutdown', 'Cold shutdown', 'No declared mode holds'])
  })

  test('D1: each critical safety function declares its status as an enum, the unit\'s, named as crews call it', () => {
    expect(observable('csf.heat-sink')).toEqual({
      ref: `${objectId}#csf.heat-sink`, label: 'Heat sink (CSF)', shortLabel: 'HEAT SINK', quantity: 'state', unit: '', valueType: 'enum', thresholds: [], series: null,
      states: ['green=GREEN', 'yellow=YELLOW', 'orange=ORANGE', 'red=RED', 'unknown=UNKNOWN', 'not-monitored=NOT JUDGED'].map(entry => ({ value: entry.split('=')[0]!, label: entry.split('=')[1]! })),
    })
  })

  test('limits are projected from the I&C rules: a moved limit moves, a removed rule is gone (mutation)', () => {
    const limit = (of: ObservationDeclaration) => of.observables.find(entry => entry.tag === 'PT-455')!.thresholds.find(threshold => threshold.id === 'pzr-pressure-low')
    expect(limit(declaration)).toEqual({ id: 'pzr-pressure-low', direction: 'low', value: 14.8, order: 1, effect: 'alarm', priority: 'warning', consequence: 'ALM' })
    const withRules = (rules: CompiledProcessPlant['automation']['rules']): CompiledProcessPlant => ({ ...plant, automation: { ...plant.automation, rules } })
    const moved = withRules(plant.automation.rules.map(rule => rule.id === 'pzr-pressure-low' && rule.condition.type === 'comparison' ? { ...rule, condition: { ...rule.condition, value: 14.5 } } : rule))
    expect(limit(plantDeclaration(objectId, moved, recording))?.value).toBe(14.5)
    const removed = withRules(plant.automation.rules.filter(rule => rule.id !== 'pzr-pressure-low'))
    expect(limit(plantDeclaration(objectId, removed, recording))).toBeUndefined()
  })

  test('series come from the Run\'s recording, else null', () => {
    expect(observable('pressurizer.pressureMPa').series).toEqual({ seriesId: recordingSeriesIdFor(objectId, 'pressurizer.pressureMPa'), intervalMs: 1_000 })
    expect(declaration.observables.filter(entry => entry.series !== null)).toHaveLength(721)
    expect(plantDeclaration(objectId, plant, null).observables.every(entry => entry.series === null)).toBe(true)
  })

  test('a load sequencer step is an enum whose states name what each step loads, with no ordered limits (R29)', () => {
    const step = observable('loadSequencerA.step')
    expect(step).toMatchObject({ valueType: 'enum', thresholds: [] })
    expect(step.states!.map(state => state.label)).toEqual([
      'step 0', 'step 1',
      'step 2 · Diesel generator A load sequencer auxiliary feedwater step',
      'step 3 · Diesel generator A load sequencer component cooling water pump step',
      'step 4 · Diesel generator A load sequencer service water pump step',
      'step 5 · Diesel generator A load sequencer containment fan coolers step',
      'step 6 · Diesel generator A load sequencer pressurizer backup heater step',
    ])
    expect(observable('loadSequencerB.step').states!.length).toBeGreaterThan(2)
  })

  test('the Capability answers a known revision unchanged and narrows to named elements', () => {
    const plants = new Map([[objectId, { plant, runtime: createProcessPlantRuntime({ system: plant }) } as unknown as ProcessPlantRuntimeInstance]])
    const ask = (input: unknown) => answerProcessPlantObservationQuery({ request: { capabilityId: processPlantObservationCapabilityIds.declarations, input }, plants, recording }) as { declarations: ReadonlyArray<any> }
    // Its revision names the mode's lead lists (Q22): at its initial state the unit is in power operation.
    const revision = declarationRevision(plant, recording, 'powerOperation')
    expect(ask({ objectIds: [objectId], known: { [objectId]: revision } }).declarations).toEqual([{ objectId, revision, unchanged: true }])
    const narrowed = ask({ objectIds: [objectId], elementIds: ['pressurizer'] }).declarations[0]
    expect(narrowed.elements.map((element: { id: string }) => element.id)).toEqual(['pressurizer'])
    expect(narrowed.observables.every((entry: { element: string }) => entry.element === 'pressurizer')).toBe(true)
    // The relief and block valves the pressurizer bundles are elements of their own: their state, position, demand and flow are theirs.
    expect(narrowed.observables.filter((entry: { ref: string }) => entry.ref.endsWith('.state'))).toEqual([])
    const relief = ask({ objectIds: [objectId], elementIds: ['pressurizer.reliefValve'] }).declarations[0]
    expect(relief.elements).toEqual([{ id: 'pressurizer.reliefValve', class: 'reliefValve', label: 'PORV', shortLabel: 'PORV', parent: 'pressurizer' }])
    expect(relief.observables.map((entry: { ref: string }) => entry.ref.slice(objectId.length + 1)).sort()).toEqual(RELIEF_VALVE_PATHS)
    expect(() => ask({ objectIds: ['plant:nowhere'] })).toThrow('No Process Plant plant:nowhere in this Run')
  })
})

/** What the PORV declares as an element of its own: its state, its position and demand, its flow and whether it flows; never its injected failure. */
const RELIEF_VALVE_PATHS: ReadonlyArray<string> = [
  'pressurizer.reliefFlowKgPerS',
  'pressurizer.reliefValve.state',
  'pressurizer.reliefValveEffectivePositionFraction',
  'pressurizer.reliefValveFlowing',
  'pressurizer.reliefValvePositionFraction',
]
