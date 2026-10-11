import { describe, expect, test } from 'bun:test'
import { commandsForProcessPlantAction, compileProcessPlant, createPwrReferencePlantDefinition, type CompiledProcessPlant } from '../src/packs/process-plant/index.ts'
import { equipmentKeyValues, leadValuesKey, overviewKeyValues, type PlantNow } from '../src/packs/process-plant/displays/overview-key-values.ts'
import { annunciatorSystems } from '../src/packs/process-plant/displays/annunciators.ts'
import { createProcessPlantProtectionRunner, createProcessPlantRuntime, processPlantIcConfigSchema, processPlantOperatingMode } from '../src/packs/process-plant/runtime/index.ts'
import type { SimulationRunId } from '../src/core/model/index.ts'
import { guardPlantTests, PLANT_HANG_GUARD_MS } from './plant-hang-guard.ts'

guardPlantTests()

describe('the values a unit overview leads with', () => {
  // The reference Plant after a fault, its protection evaluated each second as a Run does.
  const after = (plant: CompiledProcessPlant, fault: { readonly actionId: string; readonly parameters?: Record<string, unknown> } | null, seconds: number): PlantNow => {
    const run = createProcessPlantRuntime({ system: plant })
    const protection = createProcessPlantProtectionRunner({ system: plant, protection: plant.automation })
    const step = () => {
      run.tick(1_000)
      protection.evaluate({ runtime: run, elapsedMs: run.elapsedMs(), simulationRunId: 'run-key-values' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
    }
    step()
    for (const command of fault === null ? [] : commandsForProcessPlantAction({ actionId: fault.actionId, parameters: fault.parameters ?? {}, graph: plant.graph })) {
      run.writeCommand({ type: 'setVariable', path: command.path, value: command.value })
    }
    for (let second = 0; second < seconds; second += 1) step()
    return {
      mode: processPlantOperatingMode({ system: plant, runtime: run, modes: plant.automation.operatingModes })?.id ?? null,
      read: path => run.readVariable(path),
    }
  }

  test('at power: what protection trips on outside the loops, then the energy source and sink', () => {
    for (const loopCount of [4, 6]) {
      const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: `plant:key-values-${loopCount}`, loopCount }))
      const atPower = after(plant, null, 0)
      expect(atPower.mode).toBe('powerOperation')
      const paths = overviewKeyValues(plant, atPower)
      // The power the reactor protection trips on is the power range's, in percent of rated power. Containment
      // pressure, which safety injection guards, stands at atmospheric inside its declared normal range, so it yields
      // its place to the next value the I&C judges: the vessel's subcooling margin.
      expect(paths).toEqual([
        'core.powerRangePercent',
        'vessel.netInventoryFlowKgPerS',
        'pressurizer.pressureMPa',
        'vessel.subcoolingMarginC',
        'core.coreExitTemperatureC',
        'turbine.electricMw',
      ] as never)
      // Out of its normal range it takes its place back, before the values the I&C judges for their equipment.
      expect(overviewKeyValues(plant, { ...atPower, read: path => String(path) === 'containment.pressureMPa' ? 0.109 : atPower.read(path) }).slice(0, 4))
        .toEqual(['core.powerRangePercent', 'vessel.netInventoryFlowKgPerS', 'pressurizer.pressureMPa', 'containment.pressureMPa'] as never)
      // A steam generator's low-low level trips the auxiliary feed, but per-loop values stay on their loop.
      for (const path of paths) expect(plant.graph.components[plant.graph.componentIndexById.get(String(path).split('.')[0] as never)!]!.metadata?.loopId).toBeUndefined()
    }
  })

  test('after a trip: the heat path first, core cooling and heat sink, then inventory, not a power the unit no longer makes', () => {
    // Evaluation run 22: three minutes after SG B's feed valve ran back to 35 %, the unit had tripped on SG B
    // low-low level into Hot standby, and its overview still led with "0 MW" fission power and the generator.
    // Run 22 QA: after a trip it led with pressurizer and containment pressure, containment at normal, and had no
    // room for the subcooling margin.
    const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:key-values-trip', loopCount: 4 }))
    const tripped = after(plant, { actionId: 'steam-generator-b-feedwater-runback', parameters: { positionPercent: 35 } }, 180)
    expect(tripped.mode).toBe('hotStandby')
    // The reactor trips have done all they can (breakers open, rods in), so fission power no longer leads; the
    // generator's rules act only at power, and the turbine trips that act in every mode have tripped it, so no
    // energy sink is watched: the decay heat leaves through the steam generators. The column leads, as E-0 and
    // ES-0.1 check the critical safety functions, with the heat path: the margin of the coolant the core heats (the
    // vessel's subcooling margin), the core-exit temperature, and the auxiliary feed the actuations send into
    // the steam generators. Then safety injection's pressure, which it can still act on, and the key values of
    // equipment the I&C judges; containment pressure, at normal, yields its place.
    expect(overviewKeyValues(plant, tripped)).toEqual([
      'vessel.subcoolingMarginC',
      'core.coreExitTemperatureC',
      'auxFeedwaterHeader.outletFlowKgPerS',
      'pressurizer.pressureMPa',
      'pressurizer.levelPercent',
      'vessel.collapsedLiquidLevelPercent',
    ] as never)
    expect(tripped.read('auxFeedwaterHeader.outletFlowKgPerS' as never)).toBeGreaterThan(50)
  }, PLANT_HANG_GUARD_MS)

  test('after a trip the heat sink leads before the feed has started, and the injection safety injection delivers once it has', () => {
    const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:key-values-pumps', loopCount: 4 }))
    // Run 22 QA: a minute after every reactor coolant pump tripped, feedwater was isolated and no steam generator had
    // reached the low-low level that starts auxiliary feed; the overview showed no heat sink at all. The generators
    // now shrink to their low-low level some ten seconds after the trip; five seconds in, the feed has not started,
    // and the heat sink reads 0.
    const pumps = after(plant, { actionId: 'trip-reactor-coolant-pumps' }, 5)
    expect(pumps.mode).toBe('hotStandby')
    expect(overviewKeyValues(plant, pumps).slice(0, 3)).toEqual(['vessel.subcoolingMarginC', 'core.coreExitTemperatureC', 'auxFeedwaterHeader.outletFlowKgPerS'] as never)
    expect(pumps.read('auxFeedwaterHeader.outletFlowKgPerS' as never)).toBe(0)
    // Run 22 QA: three minutes after the PORV stuck at 35 %, safety injection had started; the subcooling margin,
    // the decisive value in a pressurizer steam-space leak, leads, and the injection follows the heat sink.
    const relief = after(plant, { actionId: 'pressurizer-relief-open', parameters: { positionPercent: 35 } }, 180)
    expect(overviewKeyValues(plant, relief)).toEqual([
      'vessel.subcoolingMarginC',
      'core.coreExitTemperatureC',
      'auxFeedwaterHeader.outletFlowKgPerS',
      'safetyInjectionHeader.outletFlowKgPerS',
      'pressurizer.pressureMPa',
      'pressurizer.levelPercent',
    ] as never)
    expect(relief.read('safetyInjectionHeader.outletFlowKgPerS' as never)).toBeGreaterThan(30)
  }, PLANT_HANG_GUARD_MS)
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

  test('at power the core leads with its power range, the subcooling margin, the RCS leak rate and its core-exit temperature, then its nuclear instruments while they measure', () => {
    // The subcooling margin and the RCS leak rate are bound to the reactor coolant system, as the core exit
    // thermocouples are: their alarms are the core's related alarms. The de-energized source range measures
    // nothing at power: in its place the detail says its high voltage is off, as a state (run 22 QA: the source
    // range's state was on neither core detail).
    // Tavg's deviation from Tref, which alarms in power operation, follows the power range. The permissives the
    // core derives (P-6, P-10) are never values of their own. The core's outlet is read once, by its core-exit
    // thermocouples (HMI review of run 23: the model's mixed outlet temperature beside them repeated it).
    expect(of(['core'])).toEqual(['core.powerRangePercent', 'core.averageTemperatureDeviationC', 'vessel.subcoolingMarginC', 'rcsInventoryBalance.leakRateKgPerS', 'core.coreExitTemperatureC', 'core.sourceRangeEnergized', 'core.intermediateRangeCurrentAmps', 'core.intermediateRangeStartupRateDpm'] as never)
    expect(runtime.readVariable('core.sourceRangeEnergized' as never)).toBe(false)
    // With its high voltage on, the source range counts something and ranks as an instrument, before the
    // intermediate range; its count rate then says the high voltage is on.
    const counting: PlantNow = { ...atPower, read: path => String(path) === 'core.sourceRangeEnergized' ? true : runtime.readVariable(path) }
    expect(of(['core'], counting).slice(4)).toEqual(['core.coreExitTemperatureC', 'core.sourceRangeCountRateCps', 'core.intermediateRangeCurrentAmps', 'core.intermediateRangeStartupRateDpm'] as never)
  })

  test('a signal only rules of other modes judge follows its key values and instruments', () => {
    // At power RCP A's run feedback and loop flow are both judged by reactor trips of power operation, the pump
    // breaker trip first; out of it only the run feedback's not-running alarm acts, and the loop flow follows.
    expect(of(['rcpA'])).toEqual(['rcpA.runningState', 'rcpA.loopFlowKgPerS'] as never)
    expect(of(['rcpA'], { ...atPower, mode: 'coldShutdown' })).toEqual(['rcpA.runningState', 'rcpA.loopFlowKgPerS'] as never)
    // Where no declared mode holds, a rule declared for modes acts in none.
    expect(of(['rcpA'], { ...atPower, mode: null })).toEqual(['rcpA.runningState', 'rcpA.loopFlowKgPerS'] as never)
    // The vessel's net inventory flow, judged only by the low primary flow trip of power operation, leads at power
    // and falls behind the six out of it.
    expect(of(['vessel'])[0]).toBe('vessel.netInventoryFlowKgPerS' as never)
    expect(of(['vessel'], { ...atPower, mode: 'coldShutdown' })).not.toContain('vessel.netInventoryFlowKgPerS' as never)
    expect(of(['vessel'], { ...atPower, mode: null })).not.toContain('vessel.netInventoryFlowKgPerS' as never)
  })

  test('parallel equipment is compared value by value', () => {
    // Each narrow-range level is followed by its wide-range level, the instrument that reads it over the wider span.
    expect(of(['sgA', 'sgB'])).toEqual(['sgA.levelPercent', 'sgB.levelPercent', 'sgA.wideRangeLevelPercent', 'sgB.wideRangeLevelPercent', 'sgA.secondaryRadiationMSvPerH', 'sgB.secondaryRadiationMSvPerH', 'sgA.pressureMPa', 'sgB.pressureMPa'] as never)
  })

  test('a steam generator leads with the auxiliary feed its low-low level sends into it, in every mode the actuation acts in', () => {
    // The low-low level actuation starts the pumps and opens this steam generator's valve: the line from that valve
    // into it is what the actuation delivers here. Run 22's SG B detail showed neither it nor the pumps. Its
    // high-high level isolates feedwater, shutting its feed regulating valve: the main feed line into it follows.
    expect(of(['sgB'])).toEqual(['sgB.levelPercent', 'sgB.wideRangeLevelPercent', 'sgB.secondaryRadiationMSvPerH', 'sgB.pressureMPa', 'sgB.feedwaterFlowKgPerS', 'aux-feedwater-valve-b-to-sg-b.flowKgPerS', 'feedwater-control-valve-b-to-sg-b.flowKgPerS'] as never)
    expect(of(['sgB'], { ...atPower, mode: 'hotStandby' })).toContain('aux-feedwater-valve-b-to-sg-b.flowKgPerS' as never)
  })

  test('a detail reflects the mode it was opened in: a trip changes the mode, and so what it leads with', () => {
    const now = (system: typeof plant, run: ReturnType<typeof createProcessPlantRuntime>): PlantNow => ({
      mode: processPlantOperatingMode({ system, runtime: run, modes: system.automation.operatingModes })?.id ?? null,
      read: path => run.readVariable(path),
    })
    expect(leadValuesKey(plant, now(plant, runtime))).toBe('powerOperation|core.sourceRangeCountRateCps')
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

describe('first-out groups are declared once', () => {
  const holds = { type: 'comparison', signal: { path: 'core.powerMw' }, operator: '>', value: 1 }
  const groups = [{ id: 'reactor-trip', label: 'Reactor trip', shortLabel: 'RX TRIP', reactorTrip: true }, { id: 'safety-injection', label: 'Safety injection', shortLabel: 'SI' }]
  const rule = (id: string, firstOutGroup?: string) => ({
    id,
    condition: holds,
    effects: [{ type: 'trip.enter', id: 'trip', title: id, message: id, annunciator: firstOutGroup === undefined ? {} : { firstOutGroup } }],
  })
  const issues = (config: unknown) => {
    const parsed = processPlantIcConfigSchema.safeParse(config)
    return parsed.success ? [] : parsed.error.issues.map(issue => issue.message)
  }

  test('so a display can name what a group does: every group an annunciator names is declared, each once', () => {
    expect(issues({ firstOutGroups: groups, rules: [rule('power-high-trip', 'reactor-trip'), rule('relief')] })).toEqual([])
    expect(issues({ firstOutGroups: groups, rules: [rule('power-high-trip', 'reactor-trp')] })).toEqual(['power-high-trip names first-out group reactor-trp, which is not declared; declared: reactor-trip, safety-injection'])
    expect(issues({ firstOutGroups: [...groups, { ...groups[0]!, label: 'Again' }], rules: [] })).toEqual(['first-out group reactor-trip is declared twice'])
    // A group is an actuation, not the reactor trip, unless it says so.
    expect(processPlantIcConfigSchema.parse({ firstOutGroups: groups }).firstOutGroups.map(group => group.reactorTrip)).toEqual([true, false])
  })

  test('the reference PWR declares every group its annunciators name, the reactor trip among them', () => {
    const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:first-out-groups', loopCount: 4 }))
    expect(processPlantIcConfigSchema.safeParse(plant.automation).success).toBe(true)
    expect(plant.automation.firstOutGroups.filter(group => group.reactorTrip).map(group => group.shortLabel)).toEqual(['RX TRIP'])
    expect(plant.automation.operatingModes.map(mode => mode.shortLabel)).toEqual(['1', '2', '3', '4', '5'])
  })
})
