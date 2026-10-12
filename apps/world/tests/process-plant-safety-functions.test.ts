import { describe, expect, test } from 'bun:test'
import { answerProcessPlantQuery, commandsForProcessPlantAction, compileProcessPlant, createProcessPlantRampRunner, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { createProcessPlantProtectionRunner, createProcessPlantRuntime, processPlantIcConfigSchema, type ProcessPlantRuntime } from '../src/packs/process-plant/runtime/index.ts'
import { assertProcessPlantIcSafetyFunctionsValid } from '../src/packs/process-plant/runtime/ic/control-protection-validation.ts'
import { createProcessPlantRuntimePerformance, type ProcessPlantRuntimeInstance } from '../src/packs/process-plant/runtime-instance.ts'
import { evaluateSafetyFunction, evaluateSafetyFunctions, safetyFunctionSignals, type SafetyFunctionEvaluation } from '../src/packs/process-plant/safety-functions.ts'
import { processPlantCapabilities } from '../src/packs/process-plant/capabilities.ts'
import type { SimulationRunId } from '../src/core/model/index.ts'
import { guardPlantTests, PLANT_HANG_GUARD_MS } from './plant-hang-guard.ts'

guardPlantTests()

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:safety-functions', loopCount: 4 }))

// The four-loop reference Plant after a fault, its protection evaluated each second as a Run does.
const after = (fault: { readonly actionId: string; readonly parameters?: Record<string, unknown> } | null, seconds: number): ProcessPlantRuntime => {
  const runtime = createProcessPlantRuntime({ system: plant })
  const protection = createProcessPlantProtectionRunner({ system: plant, protection: plant.automation })
  for (const command of fault === null ? [] : commandsForProcessPlantAction({ actionId: fault.actionId, parameters: fault.parameters ?? {}, graph: plant.graph })) {
    runtime.writeCommand({ type: 'setVariable', path: command.path, value: command.value })
  }
  for (let second = 0; second < seconds; second += 1) {
    runtime.tick(1_000)
    protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-safety-functions' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
  }
  return runtime
}

const judged = (runtime: ProcessPlantRuntime): ReadonlyMap<string, SafetyFunctionEvaluation> =>
  new Map(evaluateSafetyFunctions(plant, runtime).map(evaluation => [evaluation.id, evaluation]))

/** A runtime that reads as the given one but for the values named, as a failed or forced reading would. */
const reading = (runtime: ProcessPlantRuntime, forced: Readonly<Record<string, number | boolean>>): ProcessPlantRuntime => ({
  ...runtime,
  readVariableSnapshot: path => {
    const snapshot = runtime.readVariableSnapshot(path)
    return String(path) in forced ? { ...snapshot, value: forced[String(path)]! } : snapshot
  },
})

describe('critical safety function status trees', () => {
  test('the reference I&C declares six trees once, in priority order, as reference-model criteria', () => {
    expect(plant.automation.safetyFunctions.map(safetyFunction => safetyFunction.id)).toEqual(['subcriticality', 'core-cooling', 'heat-sink', 'rcs-integrity', 'containment', 'rcs-inventory'])
    expect(plant.automation.safetyFunctions.every(safetyFunction => safetyFunction.basis.includes('reference-model criteria'))).toBe(true)
    const declared = plant.automation.safetyFunctions[0]!
    expect(() => processPlantIcConfigSchema.parse({ ...plant.automation, safetyFunctions: [declared, declared] })).toThrow('safety function subcriticality is declared twice')
    // What the trees and checks judge, which a display short of room keeps before what only an alarm judges; not
    // what only says when a tree is judged (the trip breakers), nor what no tree reads (the relief tank).
    const judgedSignals = safetyFunctionSignals(plant)
    for (const path of ['vessel.subcoolingMarginC', 'core.coreExitTemperatureC', 'pressurizer.levelPercent', 'sgA.feedwaterFlowKgPerS', 'containment.pressureMPa']) expect(judgedSignals.has(path as never), path).toBe(true)
    for (const path of ['reactorTripBreakerA.closedState', 'pressurizerReliefTank.levelPercent', 'pressurizerReliefTank.pressureMPa']) expect(judgedSignals.has(path as never), path).toBe(false)
    // A tree judges the Plant by its instruments: one on a value only the simulator solves is refused.
    const onDeficit = { ...declared, id: 'core-heat', tree: { question: 'Heat removed', basis: 'test', condition: { type: 'comparison' as const, signal: { path: 'core.coreHeatRemovalDeficitMw' }, operator: '<' as const, value: 1 }, yes: { status: 'green' as const, meaning: 'ok' }, no: { status: 'red' as const, meaning: 'not' } } }
    expect(() => assertProcessPlantIcSafetyFunctionsValid(plant.graph, [onDeficit as never])).toThrow('process plant I&C safety function core-heat reads simulator-only signal core.coreHeatRemovalDeficitMw, which no plant instrument measures')
  })

  test('at full power every tree reads green but subcriticality, which is judged once a trip is demanded', () => {
    const statuses = judged(after(null, 2))
    expect([...statuses.values()].map(evaluation => [evaluation.id, evaluation.status])).toEqual([
      ['subcriticality', 'not-monitored'], ['core-cooling', 'green'], ['heat-sink', 'green'], ['rcs-integrity', 'green'], ['containment', 'green'], ['rcs-inventory', 'green'],
    ])
    expect(statuses.get('subcriticality')!.meaning).toContain('critical by design')
    // Every step cites its criterion and reads what it compared, with the threshold.
    expect(statuses.get('core-cooling')!.path).toMatchObject([
      { answer: 'yes', basis: expect.stringContaining('ERG F-0.2'), comparisons: [{ reads: [{ signal: 'CET-AVG', unit: 'degC' }], operator: '<', threshold: 649, answer: 'yes' }] },
      { answer: 'yes', comparisons: [{ reads: [{ signal: 'SUB-MARGIN' }], operator: '>', threshold: 0 }] },
    ])
    expect(statuses.get('rcs-inventory')!.checks).toMatchObject([{ met: 'yes', comparisons: [{ reads: [{ signal: 'CHG-FLOW-SP' }], threshold: 10 }] }])
  })

  test('after a loss of main feedwater the heat sink is yellow, not red: total feed is above the minimum while shrink takes level off span', () => {
    // Run 23: the answer watched narrow-range levels below range and invited FR-H.1; the tree reads total feed first.
    const statuses = judged(after({ actionId: 'loss-main-feedwater' }, 120))
    const heatSink = statuses.get('heat-sink')!
    expect(heatSink).toMatchObject({ status: 'yellow', procedure: 'FR-H.5' })
    expect(heatSink.path.map(step => step.answer)).toEqual(['no', 'yes', 'yes', 'yes', 'yes', 'no'])
    const feed = heatSink.path[1]!.comparisons[0]!
    expect(feed).toMatchObject({ combines: 'total', operator: '>=', threshold: 27.8, answer: 'yes' })
    expect(feed.reads).toHaveLength(4)
    expect(feed.measured).toBeGreaterThan(100)
    expect(heatSink.expected[0]).toContain('shrink')
    expect(statuses.get('subcriticality')).toMatchObject({ status: 'green' })
    expect(statuses.get('rcs-inventory')!.checks).toEqual([])
  }, PLANT_HANG_GUARD_MS)

  test('with every coolant pump stopped core cooling is green on CET and subcooling, with the natural-circulation checks and the CET rise expected', () => {
    // Run 23: the answer escalated on a core-exit temperature rising as natural circulation formed.
    const coreCooling = judged(after({ actionId: 'trip-reactor-coolant-pumps' }, 60)).get('core-cooling')!
    expect(coreCooling.status).toBe('green')
    // A minute in, subcooling and the cold legs are where natural circulation wants them, while the steam generators'
    // pressures, the hot legs and the core exit still rise as it forms.
    expect(coreCooling.checks.map(check => [check.basis.slice(0, 5), check.met])).toEqual([['ES-0.', 'yes'], ['ES-0.', 'yes'], ['ES-0.', 'no'], ['ES-0.', 'no'], ['ES-0.', 'no']])
    expect(coreCooling.checks[1]!.comparisons).toHaveLength(4)
    expect(coreCooling.checks[1]!.comparisons.every(comparison => comparison.combines === 'difference')).toBe(true)
    expect(coreCooling.checks.slice(2).map(check => check.comparisons.map(comparison => comparison.reads[0]!.signal))).toEqual([
      ['SG-A-TSAT-RATE', 'SG-B-TSAT-RATE', 'SG-C-TSAT-RATE', 'SG-D-TSAT-RATE'],
      ['TE-411-HOT-RATE', 'TE-421-HOT-RATE', 'TE-431-HOT-RATE', 'TE-441-HOT-RATE'],
      ['CET-AVG-RATE'],
    ])
    // Twenty minutes on, natural circulation carries the heat: the core exit and the hot legs are steady or falling.
    const settled = judged(after({ actionId: 'trip-reactor-coolant-pumps' }, 1_200)).get('core-cooling')!
    expect(settled.checks.slice(3).map(check => check.met)).toEqual(['yes', 'yes'])
    expect(coreCooling.expected[0]).toContain('rises 10–20 °C above the cold legs')
  }, PLANT_HANG_GUARD_MS)

  test('a tube leak at power keeps inventory green while the check says charging is at its maximum: the trip and SI decision', () => {
    const inventory = judged(after({ actionId: 'steam-generator-tube-leak-a', parameters: { leakPercent: 1.2 } }, 160)).get('rcs-inventory')!
    expect(inventory.status).toBe('green')
    expect(inventory.checks).toMatchObject([{ met: 'no', notMet: expect.stringContaining('trip the reactor and actuate SI') }])
  }, PLANT_HANG_GUARD_MS)

  test('after a trip subcriticality is judged every second of the first 30 minutes, through the source range\'s return', () => {
    const runtime = createProcessPlantRuntime({ system: plant })
    const protection = createProcessPlantProtectionRunner({ system: plant, protection: plant.automation })
    const step = (): void => {
      runtime.tick(1_000)
      protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-safety-functions' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
    }
    for (let second = 0; second < 10; second += 1) step()
    runtime.writeCommand({ type: 'setVariable', path: 'manualReactorTrip.pushbutton' as never, value: true })
    const subcriticality = plant.automation.safetyFunctions.find(safetyFunction => safetyFunction.id === 'subcriticality')!
    const statuses = new Map<string, number>()
    let highVoltageBackAt: number | null = null
    // The press is acted on at the end of the first second; the trip breakers' commands drop, and the tree is in
    // service, from the second after.
    step()
    for (let second = 2; second <= 1_800; second += 1) {
      step()
      const status = evaluateSafetyFunction({ system: plant, runtime, safetyFunction: subcriticality }).status
      statuses.set(status, (statuses.get(status) ?? 0) + 1)
      if (highVoltageBackAt === null && runtime.readVariable('core.sourceRangeEnergized' as never) === true) highVoltageBackAt = second
    }
    // The source range comes back some 14 minutes in, and its startup rate keeps the tree answerable from there.
    expect(highVoltageBackAt).toBeGreaterThan(10 * 60)
    expect(statuses.get('unknown')).toBeUndefined()
    expect(statuses.get('not-monitored')).toBeUndefined()
    // Red only for the second or two the power range takes to fall below 5 %, then green.
    expect([...statuses.keys()].sort()).toEqual(['green', 'red'])
    expect(statuses.get('red')!).toBeLessThanOrEqual(10)
  }, PLANT_HANG_GUARD_MS)

  test('a reactor that does not trip on demand reads subcriticality red; an unpublished signal leaves its branch unknown', () => {
    const runtime = after(null, 2)
    // An ATWS: the trip breakers' close commands dropped, the breakers still closed, power range at 100 %.
    const atws = judged(reading(runtime, { 'reactorTripBreakerA.closed': false })).get('subcriticality')!
    expect(atws).toMatchObject({ status: 'red', procedure: 'FR-S.1' })
    // Tripped with the source range energized, the tree judges the source range's startup rate.
    const tripped = { 'reactorTripBreakerA.closed': false, 'core.powerRangePercent': 0, 'core.intermediateRangeStartupRateDpm': -0.1, 'core.sourceRangeEnergized': true }
    const falling = judged(reading(runtime, { ...tripped, 'core.sourceRangeStartupRateDpm': -0.3 })).get('subcriticality')!
    expect(falling).toMatchObject({ status: 'green', missingSignals: [] })
    expect(falling.path.at(-1)).toMatchObject({ answer: 'yes', comparisons: [{ reads: [{ signal: 'NIS-SR-SUR', value: -0.3 }] }] })
    expect(judged(reading(runtime, { ...tripped, 'core.sourceRangeStartupRateDpm': 0.2 })).get('subcriticality')).toMatchObject({ status: 'yellow', procedure: 'FR-S.2' })
    // A tree on a signal the Plant does not publish stands no value in for it.
    const subcriticalityTree = plant.automation.safetyFunctions[0]!
    const onAbsent = { ...subcriticalityTree, tree: { question: 'Absent', basis: 'test', condition: { type: 'comparison' as const, signal: { tagId: 'NIS-ABSENT' }, operator: '<=' as const, value: 0 }, yes: { status: 'green' as const, meaning: 'ok' }, no: { status: 'yellow' as const, meaning: 'not' } } }
    const subcriticality = evaluateSafetyFunction({ system: plant, runtime: reading(runtime, tripped), safetyFunction: onAbsent as never })
    expect(subcriticality).toMatchObject({ status: 'unknown', missingSignals: ['NIS-ABSENT'] })
    expect(subcriticality.meaning).toContain('NIS-ABSENT is not published')
    expect(subcriticality.path.at(-1)).toMatchObject({ answer: 'unknown', comparisons: [{ answer: 'unknown', reads: [] }] })
    // A reading that fails is unknown too, never a value stood in for it.
    const failed = { ...runtime, readVariableSnapshot: (path: Parameters<ProcessPlantRuntime['readVariableSnapshot']>[0]) => {
      if (String(path) === 'core.coreExitTemperatureC') throw new Error('Acquisition failed')
      return runtime.readVariableSnapshot(path)
    } }
    expect(judged(failed).get('core-cooling')).toMatchObject({ status: 'unknown', meaning: expect.stringContaining('Acquisition failed') })
  })

  test('the assessments capability returns every function with its path, labelled reference-model criteria, and refuses an undeclared one', () => {
    const instance: ProcessPlantRuntimeInstance = { plant, runtime: after(null, 2), ramps: createProcessPlantRampRunner({ runtime: createProcessPlantRuntime({ system: plant }) }), performance: createProcessPlantRuntimePerformance() }
    const capability = processPlantCapabilities.find(item => item.id === 'world.process-plant.assessments.evaluate')!
    const answer = (input: Record<string, unknown>) => answerProcessPlantQuery({ request: { capabilityId: capability.id, input: capability.input.parse(input) }, plants: new Map([[plant.id, instance]]), objects: new Map() })
    const result = capability.output.parse(answer({ plantId: plant.id })) as { assessments: ReadonlyArray<Record<string, unknown>> }
    expect(result.assessments.map(row => row.status)).toEqual(['not-monitored', 'green', 'green', 'green', 'green', 'green'])
    expect(result.assessments[2]).toMatchObject({ id: 'heat-sink', title: 'Heat sink', qualification: 'reference-model-criteria', automaticCsfQualified: false, instrumentationValidity: 'not-established', modelDigest: plant.modelDigest })
    expect(capability.description).toContain('not qualified plant procedures')
    expect(capability.description.length).toBeLessThanOrEqual(2_048)
    expect((capability.output.parse(answer({ plantId: plant.id, assessmentIds: ['heat-sink'] })) as { assessments: unknown[] }).assessments).toHaveLength(1)
    expect(() => answer({ plantId: plant.id, assessmentIds: ['heat-sinks'] })).toThrow('declares subcriticality, core-cooling, heat-sink')
  })
})
