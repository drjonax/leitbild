import { describe, expect, test } from 'bun:test'
import { compileProcessPlant, createPwrReferencePlantDefinition } from '../src/packs/process-plant/index.ts'
import { equipmentKeyValues, leadValuesKey, overviewKeyValues, type PlantNow } from '../src/packs/process-plant/displays/overview-key-values.ts'
import { annunciatorSystems } from '../src/packs/process-plant/displays/annunciators.ts'
import { createProcessPlantProtectionRunner, createProcessPlantRuntime, processPlantIcConfigSchema, processPlantOperatingMode } from '../src/packs/process-plant/runtime/index.ts'
import type { SimulationRunId } from '../src/core/model/index.ts'

describe('the values a unit overview leads with', () => {
  test('come from what protection trips on outside the loops, then the energy source and sink', () => {
    for (const loopCount of [4, 6]) {
      const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: `plant:key-values-${loopCount}`, loopCount }))
      const paths = overviewKeyValues(plant)
      expect(paths).toEqual([
        'core.powerMw',
        'vessel.netInventoryFlowKgPerS',
        'pressurizer.pressureMPa',
        'containment.pressureMPa',
        'core.coolantOutletTemperatureC',
        'turbine.electricMw',
      ] as never)
      // A steam generator's low-low level trips the auxiliary feed, but per-loop values stay on their loop.
      for (const path of paths) expect(plant.graph.components[plant.graph.componentIndexById.get(String(path).split('.')[0] as never)!]!.metadata?.loopId).toBeUndefined()
    }
  })
})

describe('the values equipment opened from the overview leads with', () => {
  const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:equipment-values', loopCount: 4 }))
  // The reference Plant at power: in power operation, its source range de-energized above P-6.
  const runtime = createProcessPlantRuntime({ system: plant })
  runtime.tick(1_000)
  const atPower: PlantNow = { mode: 'powerOperation', read: path => runtime.readVariable(path) }
  const of = (ids: ReadonlyArray<string>, now: PlantNow = atPower) => equipmentKeyValues(plant, ids.map(id => plant.graph.componentIndexById.get(id as never)!), now)

  test('are its signals the I&C rules judge, then its key values and instruments; never a demand', () => {
    // A pump's run command and a valve's position demand are writable: the drawing shows them, the values do not.
    // A valve's values lead with its position feedback instead.
    expect(of(['feedwaterControlValveA'])).toEqual(['feedwaterControlValveA.effectivePositionFraction'] as never)
    expect(of(['rcpA'])).not.toContain('rcpA.running' as never)
  })

  test('at power the core leads with its power, the subcooling margin and its outlet temperature, and the de-energized source range last', () => {
    // The subcooling margin is bound to the reactor coolant system, as the core's outlet temperature is: its alarms are the core's related alarms.
    expect(of(['core'])).toEqual(['core.powerMw', 'vessel.subcoolingMarginC', 'core.coolantOutletTemperatureC', 'core.intermediateRangeCurrentAmps', 'core.sourceRangeEnergized', 'core.sourceRangeCountRateCps'] as never)
    // With its high voltage on, the source range counts something and ranks as an instrument.
    const counting: PlantNow = { ...atPower, read: path => String(path) === 'core.sourceRangeEnergized' ? true : runtime.readVariable(path) }
    expect(of(['core'], counting).slice(3)).toEqual(['core.sourceRangeEnergized', 'core.sourceRangeCountRateCps', 'core.intermediateRangeCurrentAmps'] as never)
  })

  test('a signal only rules of other modes judge follows its key values and instruments', () => {
    // RCP A's low loop flow alarm acts in power operation only.
    expect(of(['rcpA'])).toEqual(['rcpA.loopFlowKgPerS', 'rcpA.runningState'] as never)
    expect(of(['rcpA'], { ...atPower, mode: 'coldShutdown' })).toEqual(['rcpA.runningState', 'rcpA.loopFlowKgPerS'] as never)
    // Where no declared mode holds, a rule declared for modes acts in none.
    expect(of(['rcpA'], { ...atPower, mode: null })).toEqual(['rcpA.runningState', 'rcpA.loopFlowKgPerS'] as never)
  })

  test('parallel equipment is compared value by value', () => {
    expect(of(['sgA', 'sgB'])).toEqual(['sgA.levelPercent', 'sgB.levelPercent', 'sgA.secondaryRadiationMSvPerH', 'sgB.secondaryRadiationMSvPerH', 'sgA.pressureMPa', 'sgB.pressureMPa'] as never)
  })

  test('a detail reflects the mode it was opened in: a trip changes the mode, and so what it leads with', () => {
    const now = (system: typeof plant, run: ReturnType<typeof createProcessPlantRuntime>): PlantNow => ({
      mode: processPlantOperatingMode({ system, runtime: run, modes: system.automation.operatingModes })?.id ?? null,
      read: path => run.readVariable(path),
    })
    expect(leadValuesKey(plant, now(plant, runtime))).toBe('powerOperation|core.sourceRangeCountRateCps,core.sourceRangeEnergized')
    const tripped = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:equipment-values-trip', valueOverrides: { 'pressurizer.pressureMPa': 10 } }))
    const run = createProcessPlantRuntime({ system: tripped })
    const protection = createProcessPlantProtectionRunner({ system: tripped, protection: tripped.automation })
    for (let second = 0; second < 10; second += 1) {
      run.tick(1_000)
      protection.evaluate({ runtime: run, elapsedMs: run.elapsedMs(), simulationRunId: 'run-key-values' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
    }
    expect(leadValuesKey(tripped, now(tripped, run))).toStartWith('hotStandby|')
  })
})

describe('the annunciator systems an overview summarises its alarms by', () => {
  const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:annunciators', loopCount: 4 }))

  test('are the systems the I&C config declares, in its order, each with the rules that name it', () => {
    const result = annunciatorSystems(plant, 134)
    if (!result.ok) throw new Error(result.issues.join('; '))
    const systems = result.systems
    expect(systems.map(system => system.name)).toEqual(['Reactor protection', 'Reactor coolant system', 'Steam generators', 'Safety injection', 'Containment', 'Electrical', 'Feedwater', 'Balance of plant', 'Main steam'])
    // A name too wide for a tile at its least width shows by its declared short label, never cut.
    expect(systems.map(system => system.label)).toEqual(['Reactor protection', 'RCS', 'Steam generators', 'Safety injection', 'Containment', 'Electrical', 'Feedwater', 'Balance of plant', 'Main steam'])
    // Every alarm and trip of the reference Plant is annunciated on exactly one system.
    const annunciated = systems.flatMap(system => system.ruleIds)
    expect(new Set(annunciated).size).toBe(annunciated.length)
    expect(annunciated.length).toBe(plant.automation.rules.filter(rule => rule.enabled && rule.effects.some(effect => effect.type === 'alarm.enter' || effect.type === 'trip.enter')).length)
  })

  test('a declared name that fits no tile, with no short label that does, is refused', () => {
    const long = { ...plant, automation: { ...plant.automation, annunciatorSystems: [{ id: 'turbineGeneratorAndAuxiliaries', label: 'Turbine generator and auxiliaries' }] } }
    expect(annunciatorSystems(long, 134)).toEqual({ ok: false, issues: ['annunciator system turbineGeneratorAndAuxiliaries: neither "Turbine generator and auxiliaries" nor its short label (none declared) fits a tile 118 px wide; declare a short label that does'] })
  })
})

describe('a tile never looks quiet while one of its alarms is active', () => {
  const rule = (id: string, systems: ReadonlyArray<string | undefined>) => ({
    id,
    condition: { type: 'comparison', signal: { path: 'core.powerMw' }, operator: '>', value: 1 },
    effects: systems.map((system, at) => ({ type: 'alarm.enter', id: `a${at}`, title: id, message: id, ...(system === undefined ? {} : { annunciator: { system } }) })),
  })
  const declared = [{ id: 'reactor', label: 'Reactor' }, { id: 'turbine', label: 'Turbine' }]
  const issues = (config: unknown) => {
    const parsed = processPlantIcConfigSchema.safeParse(config)
    return parsed.success ? [] : parsed.error.issues.map(issue => issue.message)
  }

  test('so once a Plant declares annunciator systems, every alarm names one it declares, and a rule names only one', () => {
    expect(issues({ annunciatorSystems: declared, rules: [rule('power-high', ['reactor'])] })).toEqual([])
    expect(issues({ annunciatorSystems: declared, rules: [rule('power-high', [undefined])] })).toEqual(['power-high alarm a0 names no annunciator system; this Plant annunciates every alarm on one of reactor, turbine'])
    expect(issues({ annunciatorSystems: declared, rules: [rule('power-high', ['reactr'])] })).toEqual(['power-high names annunciator system reactr, which is not declared; declared: reactor, turbine'])
    expect(issues({ annunciatorSystems: declared, rules: [rule('power-high', ['reactor', 'turbine'])] })).toEqual(['power-high annunciates on reactor and turbine; a rule annunciates on one system'])
    expect(issues({ annunciatorSystems: [...declared, { id: 'reactor', label: 'Again' }], rules: [] })).toEqual(['annunciator system reactor is declared twice'])
    // A Plant that annunciates nothing has no tiles.
    expect(issues({ rules: [rule('power-high', [undefined])] })).toEqual([])
  })
})

describe('operating modes are declared once', () => {
  const holds = { type: 'comparison', signal: { path: 'core.powerMw' }, operator: '>', value: 1 }
  const modes = [{ id: 'powerOperation', label: 'Power operation', condition: holds }, { id: 'shutdown', label: 'Shutdown', condition: holds }]
  const rule = (id: string, ruleModes?: ReadonlyArray<string>) => ({ id, condition: holds, ...(ruleModes === undefined ? {} : { modes: ruleModes }) })
  const issues = (config: unknown) => {
    const parsed = processPlantIcConfigSchema.safeParse(config)
    return parsed.success ? [] : parsed.error.issues.map(issue => issue.message)
  }

  test('and a rule acts only in modes the Plant declares, each named once', () => {
    expect(issues({ operatingModes: modes, rules: [rule('power-high', ['powerOperation']), rule('always')] })).toEqual([])
    expect(issues({ operatingModes: modes, rules: [rule('power-high', ['powerOperatoin'])] })).toEqual(['power-high acts in operating mode powerOperatoin, which is not declared; declared: powerOperation, shutdown'])
    expect(issues({ operatingModes: modes, rules: [rule('power-high', ['shutdown', 'shutdown'])] })).toEqual(['power-high names operating mode shutdown twice'])
    expect(issues({ operatingModes: [...modes, { ...modes[0]!, label: 'Again' }], rules: [] })).toEqual(['operating mode powerOperation is declared twice'])
    expect(issues({ rules: [rule('power-high', ['powerOperation'])] })).toEqual(['power-high acts in operating mode powerOperation, which is not declared; declared: none'])
  })
})
