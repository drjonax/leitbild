import { describe, expect, test } from 'bun:test'
import type { SimulationRunId, IsoTimestamp } from '../src/core/model/index.ts'
import {
  componentVariablePath,
  assemblePwrReferencePlantGraph,
  compileProcessPlantExecutionPlan,
  compileResolvedProcessPlant,
  commandsForProcessPlantAction,
  component,
  connect,
  createBehaviorContext,
  createProcessPlantProtectionRunner,
  createProcessPlantRampRunner,
  createProcessPlantRuntime,
  plantGraph,
  pressurizedWaterReactorReferenceIc,
  processLinkVariableDescriptorSchema,
  processPlantActions,
  processPlantSolverPhases,
  processPlantComponentRegistry,
  processPlantServices,
  type ComponentId,
  type ConnectionId,
  type ConnectionService,
  type PlantGraphSpec,
  type VariablePath,
} from '../src/packs/process-plant/index.ts'
import {
  createProcessPlantMultiPlantTestbed,
  createProcessPlantScheduleRunner,
  createProcessPlantTestbed,
} from '../src/packs/process-plant/engineering/index.ts'
import { answerProcessPlantQuery } from '../src/packs/process-plant/query.ts'
import { componentBehaviorDefinitions, initialComponentValueFor } from '../src/packs/process-plant/runtime/component-behaviors.ts'
import { componentInitialValueDefinitions } from '../src/packs/process-plant/runtime/component-initial-values.ts'
import { componentInitialReconciliationDefinitions } from '../src/packs/process-plant/runtime/component-behaviors.ts'
import { processLinkBehaviorDefinitions } from '../src/packs/process-plant/runtime/links/process-link-behaviors.ts'
import { latentHeatSteamMjPerKg } from '../src/packs/process-plant/runtime/thermophysics.ts'
import { createProcessPlantVariableTable } from '../src/packs/process-plant/runtime/variable-table.ts'
import { componentFlowBalanceForService } from '../src/packs/process-plant/runtime/links/link-flow-helpers.ts'
import { createProcessPlantRuntimePerformance } from '../src/packs/process-plant/runtime-instance.ts'
import { compileProcessPlant } from '../src/packs/process-plant/plant-compiler.ts'
import { createPwrReferencePlantDefinition } from '../src/packs/process-plant/plant-definitions.ts'

const pressurizedWaterReactorPlantSpec = assemblePwrReferencePlantGraph({ loopCount: 4 })

const compileTestSystem = (definition: {
  readonly id: string
  readonly graph: PlantGraphSpec
  readonly parameters?: Readonly<Record<string, unknown>>
  readonly initialState?: Readonly<Record<string, unknown>>
}) => compileResolvedProcessPlant({
  id: definition.id,
  modelRef: 'test.model',
  operatingPointRef: 'test.operating-point',
  automationRef: 'test.automation',
  graph: definition.graph,
  ...(definition.parameters === undefined ? {} : { parameterOverrides: definition.parameters }),
  ...(definition.initialState === undefined ? {} : { valueOverrides: definition.initialState }),
  automationForGraph: () => ({ operatingModes: [], annunciatorSystems: [], rules: [] }),
})

const compiledSystem = () => compileTestSystem({
  id: 'plant',
  graph: pressurizedWaterReactorPlantSpec,
})

const compiledSystemWithParameters = (parameters: Record<string, Record<string, unknown>>) => compileTestSystem({
  id: 'plant',
  graph: pressurizedWaterReactorPlantSpec,
  parameters,
})

const compiledSystemWithStaticFeedwaterValves = () => compiledSystemWithParameters({
  feedwaterControlValveA: { initialPositionFraction: 1, controller: undefined },
  feedwaterControlValveB: { initialPositionFraction: 1, controller: undefined },
  feedwaterControlValveC: { initialPositionFraction: 1, controller: undefined },
  feedwaterControlValveD: { initialPositionFraction: 1, controller: undefined },
})

const compiledSystemWithInitialState = (initialState: Record<string, unknown>) => compileTestSystem({
  id: 'plant',
  graph: pressurizedWaterReactorPlantSpec,
  initialState,
})

const compiledSystemWithConnectionPhysical = (
  connectionId: string,
  physical: Record<string, unknown>,
) => compileTestSystem({
  id: 'plant',
  graph: {
    ...pressurizedWaterReactorPlantSpec,
    connections: pressurizedWaterReactorPlantSpec.connections.map(connection => connection.id === connectionId
      ? { ...connection, physical: { ...connection.physical, ...physical } }
      : connection),
  },
})

const valueOf = (path: string): VariablePath => path as VariablePath

const activeLifecycleIds = (snapshot: {
  readonly alarms: ReadonlyArray<{ readonly id: string; readonly active: boolean }>
  readonly trips: ReadonlyArray<{ readonly id: string; readonly active: boolean }>
}) => ({
  alarms: snapshot.alarms.filter(lifecycle => lifecycle.active).map(lifecycle => lifecycle.id).sort(),
  trips: snapshot.trips.filter(lifecycle => lifecycle.active).map(lifecycle => lifecycle.id).sort(),
})

const runWithReferenceProtection = (input: {
  readonly runtime: ReturnType<typeof createProcessPlantRuntime>
  readonly system: ReturnType<typeof compiledSystem>
  readonly durationMs: number
  readonly stepMs?: number
  readonly schedule?: ReturnType<typeof createProcessPlantScheduleRunner>
}) => {
  const stepMs = input.stepMs ?? 1_000
  const protection = createProcessPlantProtectionRunner({
    system: input.system,
    protection: pressurizedWaterReactorReferenceIc,
  })
  let elapsedMs = 0
  while (elapsedMs < input.durationMs) {
    const nextElapsedMs = Math.min(input.durationMs, elapsedMs + stepMs)
    input.schedule?.applyDueActions(input.runtime, nextElapsedMs)
    input.runtime.tick(nextElapsedMs - elapsedMs)
    protection.evaluate({
      runtime: input.runtime,
      elapsedMs: input.runtime.elapsedMs(),
      simulationRunId: 'run-runtime-protection-test' as SimulationRunId,
      sourceRuntimeId: 'process-plant.local',
    })
    elapsedMs = nextElapsedMs
  }
  return protection.snapshot()
}

const displayAlarmIdsFor = (input: {
  readonly system: ReturnType<typeof compiledSystem>
  readonly runtime: ReturnType<typeof createProcessPlantRuntime>
  readonly protection: ReturnType<typeof createProcessPlantProtectionRunner>
}): ReadonlyArray<string> => {
  const plants = new Map([[
    input.system.id,
    {
      plant: input.system,
      runtime: input.runtime,
      ramps: createProcessPlantRampRunner({ runtime: input.runtime }),
      protection: input.protection,
      performance: createProcessPlantRuntimePerformance(),
    },
  ]])
  // What a live display shows: the active alarms and trips one sample reads.
  const response = answerProcessPlantQuery({
    request: {
      capabilityId: 'world.process-plant.display.sample',
      input: { plantId: input.system.id, paths: ['core.powerMw'], alarms: true },
    },
    plants,
    objects: new Map(),
    simulationTime: '2026-01-01T10:00:00.000Z' as IsoTimestamp,
    recordedSeriesIds: new Set(),
  }) as { readonly alarms: ReadonlyArray<{ readonly id: string }> }
  return response.alarms.map(alarm => alarm.id).sort()
}

const fluidVariable = (input: {
  readonly path: string
  readonly label?: string
  readonly discipline: 'hydraulic' | 'thermal' | 'control' | 'radiological'
  readonly quantity: 'flowRate' | 'temperature' | 'pressure' | 'pressureDelta' | 'ratio' | 'radiationDoseRate'
  readonly unit: 'kg/s' | 'degC' | 'MPa' | 'fraction' | 'mSv/h'
  readonly initialValue: number
  readonly writable?: boolean
}) => processLinkVariableDescriptorSchema.parse({
  path: input.path,
  label: input.label ?? input.path,
  kind: input.writable === true ? 'control' : 'derived',
  discipline: input.discipline,
  writable: input.writable ?? false,
  publish: 'telemetry',
  quantity: input.quantity,
  unit: input.unit,
  initialValue: input.initialValue,
})

const liquidVariables = (temperatureC: number, pressureMPa = 1) => [
  fluidVariable({ path: 'flowKgPerS', discipline: 'hydraulic', quantity: 'flowRate', unit: 'kg/s', initialValue: 0 }),
  fluidVariable({ path: 'temperatureC', discipline: 'thermal', quantity: 'temperature', unit: 'degC', initialValue: temperatureC }),
  fluidVariable({ path: 'pressureMPa', discipline: 'hydraulic', quantity: 'pressure', unit: 'MPa', initialValue: pressureMPa }),
]

describe('process plant runtime', () => {
  test('initializes a headless runtime from scenario-owned graph data', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })
    const snapshot = runtime.snapshot()
    const diagnostics = runtime.pwrTransientDiagnostics()

    expect(snapshot.elapsedMs).toBe(0)
    expect(diagnostics).toMatchObject({
      schemaVersion: 1,
      active: true,
      componentCounts: {
        steamGenerators: 4,
        accumulators: 4,
        safetyBuses: 2,
        diesels: 2,
      },
    })
    expect(diagnostics.primary.inventoryKg).toBeGreaterThan(0)
    expect(diagnostics.primary.inventoryFraction).toBeCloseTo(1, 6)
    expect(diagnostics.primary.reactorCoolantFlowKgPerS).toBeGreaterThan(0)
    expect(diagnostics.primary.runningReactorCoolantPumpCount).toBe(4)
    expect(diagnostics.primary.minReactorCoolantPumpSpeedFraction).toBeCloseTo(1, 6)
    expect(diagnostics.secondary.liquidInventoryKg).toBeGreaterThan(0)
    expect(diagnostics.secondary.feedwaterTankInventoryKg).toBeGreaterThan(0)
    expect(diagnostics.secondary.feedwaterTankAvailableFlowKgPerS).toBeGreaterThan(0)
    expect(diagnostics.secondary.auxFeedwaterTankInventoryKg).toBeGreaterThan(0)
    expect(diagnostics.core.totalThermalPowerMw).toBeGreaterThan(0)
    expect(diagnostics.core.heatRemovalDeficitMw).toBeGreaterThanOrEqual(0)
    expect(diagnostics.balanceOfPlant.turbineElectricMw).toBeGreaterThan(0)
    expect(diagnostics.balanceOfPlant.condenserHeatRejectedMw).toBeGreaterThanOrEqual(0)
    expect(diagnostics.electrical.busCount).toBeGreaterThanOrEqual(2)
    expect(diagnostics.electrical.minSafetyBusVoltageFraction).toBeGreaterThanOrEqual(0)
    expect(diagnostics.electrical.unservedLoadCount).toBeGreaterThanOrEqual(0)
    expect(snapshot.variables.find(variable => variable.path === valueOf('core.powerMw'))).toMatchObject({
      value: 2890,
      quantity: 'power',
      unit: 'MW',
      published: true,
    })
    const level = snapshot.variables.find(variable => variable.path === valueOf('sgA.levelPercent'))
    expect(level).toMatchObject({
      quantity: 'ratio',
      unit: 'percent',
    })
    expect(Number(level?.value)).toBeCloseTo(55, 6)
    expect(Number(level?.canonicalValue)).toBeCloseTo(0.55, 6)
    const collapsed = Number(snapshot.variables.find(variable => variable.path === valueOf('sgA.collapsedLevelPercent'))?.value)
    const swell = Number(snapshot.variables.find(variable => variable.path === valueOf('sgA.swellLevelPercent'))?.value)
    expect(collapsed + swell).toBeCloseTo(55, 6)
    expect(Number(snapshot.variables.find(variable => variable.path === valueOf('sgA.voidFraction'))?.value)).toBeGreaterThan(0)
    expect(Number(snapshot.variables.find(variable => variable.path === valueOf('sgA.steamMassKg'))?.value)).toBeCloseTo(15_500, 6)
    expect(Number(snapshot.variables.find(variable => variable.path === valueOf('pressurizer.levelPercent'))?.value)).toBeCloseTo(55, 6)
    expect(Number(snapshot.variables.find(variable => variable.path === valueOf('pressurizer.steamMassKg'))?.value)).toBeCloseTo(1_800, 6)
  })

  // Long deterministic trajectories test correctness, not a five-second CPU budget.
  // Keep every simulated step and assertion; allow shared-runner scheduling overhead.
  test('keeps the reference plant normal under reference I&C during a no-fault run', () => {
    // The deployed Plant: the template at its full-power operating point. The
    // template alone heats its coolant to a mean 342 °C at 16.1 MPa, about
    // 5 °C below saturation, which the subcooling alarm rightly reports.
    const system = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant' }))
    const runtime = createProcessPlantRuntime({ system })
    const protection = createProcessPlantProtectionRunner({
      system,
      protection: pressurizedWaterReactorReferenceIc,
    })

    for (let elapsedMs = 1_000; elapsedMs <= 600_000; elapsedMs += 1_000) {
      runtime.tick(1_000)
      protection.evaluate({
        runtime,
        elapsedMs: runtime.elapsedMs(),
        simulationRunId: 'run-runtime-protection-test' as SimulationRunId,
        sourceRuntimeId: 'process-plant.local',
      })
      expect(activeLifecycleIds(protection.snapshot())).toEqual({
        alarms: [],
        trips: [],
      })
    }

    expect(activeLifecycleIds(protection.snapshot())).toEqual({
      alarms: [],
      trips: [],
    })
    expect(Number(runtime.readVariable(valueOf('sgA.levelPercent')))).toBeGreaterThan(50)
    expect(Number(runtime.readVariable(valueOf('sgA.levelPercent')))).toBeLessThan(60)
    expect(Number(runtime.readVariable(valueOf('feedwaterControlValveA.positionFraction')))).toBeLessThan(1)
  }, 20_000)

  test('reference protection trips reactor on pressurizer pressure and containment pressure extremes', () => {
    for (const [initialState, expectedTrip] of [
      [{ 'pressurizer.pressureMPa': 10 }, 'trip:pzr-pressure-low-reactor-trip:low-pzr-pressure-reactor-trip'],
      [{ 'pressurizer.pressureMPa': 18 }, 'trip:pzr-pressure-high-reactor-trip:high-pzr-pressure-reactor-trip'],
    ] as const) {
      const system = compiledSystemWithInitialState(initialState)
      const runtime = createProcessPlantRuntime({ system })
      const snapshot = runWithReferenceProtection({ system, runtime, durationMs: 3_000 })
      expect(activeLifecycleIds(snapshot).trips).toContain(expectedTrip)
      expect(Number(runtime.readVariable(valueOf('core.rodInsertionFraction')))).toBe(1)
      expect(runtime.readVariable(valueOf('reactorTripBreakerA.closed'))).toBe(false)
      expect(runtime.readVariable(valueOf('reactorTripBreakerB.closed'))).toBe(false)
    }
  })

  test('electrical degraded voltage is reported by reference I&C', () => {
    const system = compiledSystemWithInitialState({ 'offsiteGrid.voltageFraction': 0.85 })
    const runtime = createProcessPlantRuntime({ system })
    const snapshot = runWithReferenceProtection({ system, runtime, durationMs: 5_000 })

    expect(Number(runtime.readVariable(valueOf('offsiteGrid.voltageFraction')))).toBeCloseTo(0.85, 6)
    expect(activeLifecycleIds(snapshot).alarms).toContain('alarm:offsite-grid-degraded-voltage:offsite-grid-degraded-voltage')
  })

  describe('demo action catalog produces reference I&C lifecycle indications', () => {
    const expectedLifecycleIds = new Map<string, ReadonlyArray<string>>([
      ['steam-generator-tube-leak-a', [
        'alarm:sg-a-tube-leak-indication:tube-leak',
        'alarm:sg-a-secondary-radiation-high:secondary-radiation-high',
      ]],
      ['trip-reactor-coolant-pumps', [
        'alarm:rcp-a-trip:not-running',
        'alarm:rcp-b-trip:not-running',
        'alarm:rcp-c-trip:not-running',
        'alarm:rcp-d-trip:not-running',
        'trip:reactor-low-rcp-flow-trip:low-rcp-flow-trip',
      ]],
      ['loss-main-feedwater', [
        'alarm:main-feedwater-pump-trip:main-feedwater-pump-unavailable',
      ]],
      ['steam-generator-b-feedwater-runback', [
        'alarm:sg-b-feedwater-flow-low:feedwater-flow-low',
      ]],
      ['pressurizer-relief-open', [
        'alarm:pzr-relief-flow-high:relief-flow-high',
      ]],
      // Above P-9 a turbine trip trips the reactor; the generator's output and load alarms apply only while it is on line.
      ['turbine-trip', [
        'trip:reactor-turbine-trip:turbine-trip-reactor-trip',
      ]],
      ['loss-offsite-power', [
        'alarm:loss-of-offsite-power:loss-of-offsite-power',
      ]],
    ])

    for (const action of processPlantActions) {
      test(action.id, () => {
        const expected = expectedLifecycleIds.get(action.id)
        if (expected === undefined) throw new Error(`missing lifecycle expectation for demo action ${action.id}`)
        const system = compiledSystem()
        const runtime = createProcessPlantRuntime({ system })
        const commands = commandsForProcessPlantAction({ actionId: action.id, parameters: {}, graph: system.graph })
        for (const command of commands) {
          runtime.writeCommand({
            type: 'setVariable',
            path: command.path,
            value: command.value,
          })
        }
        const snapshot = runWithReferenceProtection({ system, runtime, durationMs: 90_000 })
        const active = activeLifecycleIds(snapshot)
        const activeIds = [...active.alarms, ...active.trips]
        expect(activeIds, action.id).toEqual(expect.arrayContaining(expected))
      })
    }
  })

  describe('demo action catalog reaches the overview alarm panel snapshot', () => {
    const expectedLifecycleIds = new Map<string, ReadonlyArray<string>>([
      ['steam-generator-tube-leak-a', [
        'alarm:sg-a-tube-leak-indication:tube-leak',
        'alarm:sg-a-secondary-radiation-high:secondary-radiation-high',
      ]],
      ['trip-reactor-coolant-pumps', [
        'alarm:rcp-a-trip:not-running',
        'alarm:rcp-b-trip:not-running',
        'alarm:rcp-c-trip:not-running',
        'alarm:rcp-d-trip:not-running',
        'trip:reactor-low-rcp-flow-trip:low-rcp-flow-trip',
      ]],
      ['loss-main-feedwater', [
        'alarm:main-feedwater-pump-trip:main-feedwater-pump-unavailable',
      ]],
      ['steam-generator-b-feedwater-runback', [
        'alarm:sg-b-feedwater-flow-low:feedwater-flow-low',
      ]],
      ['pressurizer-relief-open', [
        'alarm:pzr-relief-flow-high:relief-flow-high',
      ]],
      // Above P-9 a turbine trip trips the reactor; the generator's output and load alarms apply only while it is on line.
      ['turbine-trip', [
        'trip:reactor-turbine-trip:turbine-trip-reactor-trip',
      ]],
      ['loss-offsite-power', [
        'alarm:loss-of-offsite-power:loss-of-offsite-power',
      ]],
    ])

    for (const action of processPlantActions) {
      test(action.id, () => {
        const expected = expectedLifecycleIds.get(action.id)
        if (expected === undefined) throw new Error(`missing display alarm expectation for demo action ${action.id}`)
        const system = compiledSystem()
        const runtime = createProcessPlantRuntime({ system })
        const protection = createProcessPlantProtectionRunner({
          system,
          protection: pressurizedWaterReactorReferenceIc,
        })
        const commands = commandsForProcessPlantAction({ actionId: action.id, parameters: {}, graph: system.graph })
        for (const command of commands) {
          runtime.writeCommand({
            type: 'setVariable',
            path: command.path,
            value: command.value,
          })
        }
        for (let elapsedMs = 0; elapsedMs < 90_000; elapsedMs += 1_000) {
          runtime.tick(1_000)
          protection.evaluate({
            runtime,
            elapsedMs: runtime.elapsedMs(),
            simulationRunId: 'run-runtime-display-alarm-test' as SimulationRunId,
            sourceRuntimeId: 'process-plant.local',
          })
        }

        expect(displayAlarmIdsFor({ system, runtime, protection }), action.id)
          .toEqual(expect.arrayContaining(expected))
      })
    }
  })

  test('explicit electrical links make train loss disable train-powered pumps', () => {
    const system = compiledSystemWithInitialState({ 'offsiteBreakerA.closed': false })
    const runtime = createProcessPlantRuntime({ system })
    runtime.tick(2_000)

    expect(runtime.readVariable(valueOf('safetyBusA.energized'))).toBe(false)
    expect(Number(runtime.readVariable(valueOf('rcpA.developedHeadPa')))).toBe(0)
    expect(Number(runtime.readVariable(valueOf('rcpC.developedHeadPa')))).toBe(0)
    expect(Number(runtime.readVariable(valueOf('chargingPump.flowKgPerS')))).toBeLessThan(90)
    expect(Number(runtime.readVariable(valueOf('rcpB.developedHeadPa')))).toBeGreaterThan(0)
  })

  test('CVCS charging carries tank solute into primary coolant and contributes boron feedback', () => {
    const system = compiledSystemWithParameters({
      volumeControlTank: {
        initialSoluteConcentrationPpm: 2500,
        makeupFlowKgPerS: 20,
        makeupSoluteConcentrationPpm: 2500,
      },
    })
    const runtime = createProcessPlantRuntime({ system })
    for (let elapsedMs = 0; elapsedMs < 120_000; elapsedMs += 1_000) runtime.tick(1_000)

    expect(Number(runtime.readVariable(valueOf('vessel.boronConcentrationPpm')))).toBeGreaterThan(1_200)
    expect(Number(runtime.readVariable(valueOf('core.boronFeedbackPcm')))).toBeLessThan(0)
  })

  test('lets the Halden demo feedwater and RCP fault path reach real protection trips', () => {
    const system = compiledSystem()
    const runtime = createProcessPlantRuntime({ system })
    const schedule = createProcessPlantScheduleRunner({
      system,
      schedule: {
        actions: [
          { id: 'mfw-a-trip', atMs: 120_000, type: 'tripComponent', componentId: 'mainFeedwaterPumpA' as ComponentId },
          { id: 'mfw-b-trip', atMs: 180_000, type: 'tripComponent', componentId: 'mainFeedwaterPumpB' as ComponentId },
          { id: 'rcp-a-trip', atMs: 300_000, type: 'tripComponent', componentId: 'rcpA' as ComponentId },
          { id: 'rcp-b-trip', atMs: 330_000, type: 'tripComponent', componentId: 'rcpB' as ComponentId },
          { id: 'rcp-c-trip', atMs: 360_000, type: 'tripComponent', componentId: 'rcpC' as ComponentId },
          { id: 'rcp-d-trip', atMs: 390_000, type: 'tripComponent', componentId: 'rcpD' as ComponentId },
        ],
      },
    })

    const snapshot = runWithReferenceProtection({
      system,
      runtime,
      schedule,
      durationMs: 450_000,
    })
    const active = activeLifecycleIds(snapshot)

    expect(active.alarms.length).toBeGreaterThan(0)
    expect(active.trips).toContain('trip:reactor-low-rcp-flow-trip:low-rcp-flow-trip')
  }, 20_000) // 450 s correctness trajectory, same watchdog as the normal-hold case.

  test('scheduled typed PWR fault actions compile to validated runtime writes', () => {
    const system = compiledSystem()
    const runtime = createProcessPlantRuntime({ system })
    const schedule = createProcessPlantScheduleRunner({
      system,
      schedule: {
        actions: [
          { id: 'loop', atMs: 1_000, type: 'lossOfOffsitePower' },
          { id: 'rcp-a', atMs: 2_000, type: 'reactorCoolantPumpTrip', componentId: 'rcpA' as ComponentId },
          { id: 'hot-leg-leak', atMs: 3_000, type: 'primaryBoundaryLeak', connectionId: 'rcs-hot-leg-a' as ConnectionId, areaFraction: 0.2 },
          { id: 'sgtr-a', atMs: 4_000, type: 'steamGeneratorTubeLeak', componentId: 'sgA' as ComponentId, leakFraction: 0.15 },
        ],
      },
    })

    for (let elapsedMs = 1_000; elapsedMs <= 5_000; elapsedMs += 1_000) {
      schedule.applyDueActions(runtime, elapsedMs)
      runtime.tick(1_000)
    }

    expect(runtime.readVariable(valueOf('offsiteBreakerA.closed'))).toBe(false)
    expect(runtime.readVariable(valueOf('offsiteBreakerB.closed'))).toBe(false)
    expect(runtime.readVariable(valueOf('rcpA.running'))).toBe(false)
    expect(runtime.readVariable(valueOf('rcs-hot-leg-a.leak.areaFraction'))).toBe(0.2)
    expect(runtime.readVariable(valueOf('sgA.tubeLeakFraction'))).toBe(0.15)
    expect(Number(runtime.readVariable(valueOf('vessel.primaryLeakFlowKgPerS')))).toBeGreaterThan(0)
    expect(Number(runtime.readVariable(valueOf('vessel.tubeLeakFlowKgPerS')))).toBeGreaterThan(0)
  })

  test('runs the declared solver phases and publishes telemetry', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })
    const tick = runtime.tick(1_000)

    expect(tick.simulatedMs).toBe(1_000)
    expect(tick.phases).toEqual(processPlantSolverPhases)
    expect(tick.phases).toEqual([
      'applyCommands',
      'updateControlLogic',
      'solveFluidFlowComponents',
      'solveFluidFlowLinks',
      'solveThermalTransfer',
      'solveElectrical',
      'updateComponentState',
      'updateProcessLinkState',
    ])
    const publishedPaths = runtime.snapshot().variables
      .filter(variable => variable.published)
      .map(variable => String(variable.path))
    expect(publishedPaths).toEqual(expect.arrayContaining([
      'core.powerMw',
      'core.fissionPowerMw',
      'core.totalThermalPowerMw',
      'core.reactivityPcm',
      'core.promptReactivityPcm',
      'core.temperatureFeedbackPcm',
      'core.effectiveReactivityPcm',
      'core.fuelTemperatureC',
      'core.fuelLowerTemperatureC',
      'core.fuelMidTemperatureC',
      'core.fuelUpperTemperatureC',
      'core.fuelStoredEnergyMj',
      'core.coreCoolingAvailabilityFraction',
      'core.coreHeatRemovalDeficitMw',
      'core.fuelHeatupRateCPerS',
      'core.decayHeatMw',
      'core.coolantInletTemperatureC',
      'core.coolantOutletTemperatureC',
      'core.heatToCoolantMw',
      'vessel.primaryCoolantInventoryKg',
      'vessel.primaryCoolantInventoryDeviationKg',
      'vessel.meanPrimaryCoolantTemperatureC',
      'vessel.compressibilityPressureBiasMPa',
      'vessel.thermalExpansionPressureBiasMPa',
      'vessel.primaryPressureBiasMPa',
      'vessel.chargingFlowKgPerS',
      'vessel.letdownFlowKgPerS',
      'vessel.reliefOutflowKgPerS',
      'vessel.primaryLeakFlowKgPerS',
      'vessel.tubeLeakFlowKgPerS',
      'vessel.netInventoryFlowKgPerS',
      'vessel.primaryInventoryBalanceResidualKg',
      'pressurizer.pressureMPa',
      'pressurizer.levelPercent',
      'pressurizer.steamVolumeM3',
      'pressurizer.steamPressureMPa',
      'pressurizer.pressureTargetMPa',
      'pressurizer.waterInventoryBalanceResidualKg',
      'pressurizer.steamMassBalanceResidualKg',
      'pressurizer.reliefFlowKgPerS',
      'feedwaterTank.inventoryKg',
      'feedwaterTank.levelPercent',
      'feedwaterTank.availableOutletFlowKgPerS',
      'auxFeedwaterTank.inventoryKg',
      'auxFeedwaterTank.levelPercent',
      'sgA.levelPercent',
      'sgA.pressureMPa',
      'sgA.heatTransferMw',
      'sgA.primaryInletTemperatureC',
      'sgA.primaryOutletTemperatureC',
      'sgA.tubeMetalTemperatureC',
      'sgA.secondaryTemperatureC',
      'sgA.steamFlowKgPerS',
      'sgA.boilingRateKgPerS',
      'sgA.feedwaterFlowKgPerS',
      'sgA.steamOutflowKgPerS',
      'sgA.steamQualityFraction',
      'sgA.secondaryInventoryKg',
      'sgA.collapsedLevelPercent',
      'sgA.voidFraction',
      'sgA.swellLevelPercent',
      'sgA.tubeCoverageFraction',
      'sgA.tubeUncoveredFraction',
      'sgA.availableHeatTransferFraction',
      'sgA.steamMassKg',
      'sgA.pressureTargetMPa',
      'sgA.steamMassPressureBiasMPa',
      'sgA.temperaturePressureBiasMPa',
      'sgA.inventoryPressureBiasMPa',
      'sgA.secondaryInventoryBalanceResidualKg',
      'sgA.steamMassBalanceResidualKg',
      'sgA.boilingEnergyResidualMw',
      'sgA.tubeLeakFraction',
      'sgA.primaryToSecondaryLeakKgPerS',
      'sgA.secondaryRadiationMSvPerH',
      'sgB.steamFlowKgPerS',
      'sgC.steamFlowKgPerS',
      'sgD.steamFlowKgPerS',
      'rcpA.running',
      'rcpA.developedHeadPa',
      'rcpA.loopFlowTargetKgPerS',
      'rcpA.loopFlowKgPerS',
      'rcpB.running',
      'rcpB.loopFlowKgPerS',
      'rcpC.running',
      'rcpC.loopFlowKgPerS',
      'rcpD.running',
      'rcpD.loopFlowKgPerS',
      'mainFeedwaterPumpA.running',
      'mainFeedwaterPumpB.running',
      'turbine.electricMw',
      'turbine.steamFlowKgPerS',
      'turbine.steamDemandKgPerS',
      'turbine.steamAvailabilityFraction',
      'turbine.exhaustTemperatureC',
      'condenser.steamFlowKgPerS',
      'condenser.condensateProductionKgPerS',
      'condenser.heatRejectedMw',
      'condenser.condensateInventoryKg',
      'condenser.condensateLevelPercent',
      'condenser.availableCondensateOutletFlowKgPerS',
      'condenser.condensateTemperatureC',
      'condenser.backPressurePa',
      'rcs-hot-leg-a.flowKgPerS',
      'rcs-hot-leg-a.temperatureC',
      'rcs-hot-leg-a.pressureMPa',
      'rcs-hot-leg-a.pressureDropMPa',
      'rcs-hot-leg-a.leak.areaFraction',
      'rcs-hot-leg-a.leakFlowKgPerS',
      'rcs-cold-leg-a.flowKgPerS',
      'rcs-cold-leg-a.temperatureC',
      'rcs-cold-leg-a.pressureMPa',
      'rcs-cold-leg-a.pressureDropMPa',
      'rcs-cold-leg-a.leak.areaFraction',
      'rcs-cold-leg-a.leakFlowKgPerS',
      'feedwater-control-valve-a-to-sg-a.flowKgPerS',
      'sg-a-steam-to-msiv-a.flowKgPerS',
      'sg-a-steam-to-msiv-a.pressureMPa',
      'sg-a-steam-to-msiv-a.radiationMSvPerH',
      'mainSteamIsolationValveA.positionFraction',
      'mainSteamIsolationValveA.effectivePositionFraction',
      'mainSteamHeader.flowBalanceResidualKgPerS',
      'sg-a-steam-to-msiv-a.leak.areaFraction',
      'turbine-exhaust-to-condenser.flowKgPerS',
      'turbine-exhaust-to-condenser.temperatureC',
    ]))
    expect(publishedPaths.length).toBeGreaterThan(80)
  })

  test('rejects writes to non-writable variables', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })

    expect(() => runtime.writeCommand({
      type: 'setVariable',
      path: valueOf('core.powerMw'),
      value: 100,
    })).toThrow('not writable')
  })

  test('applies operator commands through the fixed-step update loop', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })

    runtime.writeCommand({
      type: 'setVariable',
      path: valueOf('rcpA.running'),
      value: false,
    })
    runtime.tick(100)

    expect(runtime.readVariable(valueOf('rcpA.running'))).toBe(false)
    expect(runtime.readVariable(valueOf('rcpA.flowKgPerS'))).toBe(0)
    expect(Number(runtime.readVariable(valueOf('rcpA.loopFlowKgPerS')))).toBeGreaterThan(0)
  })

  test('evolves plant variables without coupling behavior to the caller tick size', () => {
    const oneBigTick = createProcessPlantRuntime({ system: compiledSystem() })
    const repeatedTicks = createProcessPlantRuntime({ system: compiledSystem() })

    oneBigTick.writeCommand({ type: 'setVariable', path: valueOf('core.rodInsertionFraction'), value: 0.6 })
    repeatedTicks.writeCommand({ type: 'setVariable', path: valueOf('core.rodInsertionFraction'), value: 0.6 })
    oneBigTick.tick(1_000)
    for (let index = 0; index < 10; index += 1) repeatedTicks.tick(100)

    expect(oneBigTick.readVariable(valueOf('core.powerMw'))).toBeCloseTo(Number(repeatedTicks.readVariable(valueOf('core.powerMw'))), 6)
    expect(Number(oneBigTick.readVariable(valueOf('core.powerMw')))).toBeLessThan(2890)
  })

  test('testbed runs the compiled Plant and returns a runtime snapshot', () => {
    const testbed = createProcessPlantTestbed(compiledSystem())
    const snapshot = testbed.runFor(500)

    expect(snapshot.elapsedMs).toBe(500)
    expect(snapshot.variables.length).toBeGreaterThan(0)
  })

  test('multi-Plant testbed runs independent Plants with isolated scheduled faults and telemetry', () => {
    const multiPlant = createProcessPlantMultiPlantTestbed([
      {
        plant: compileTestSystem({
          id: 'unit-1',
          graph: pressurizedWaterReactorPlantSpec,
        }),
        telemetry: {
          sampleIntervalMs: 1_000,
          variables: [valueOf('rcpA.running'), valueOf('turbine.electricMw')],
        },
        schedule: { actions: [] },
      },
      {
        plant: compileTestSystem({
          id: 'unit-2',
          graph: pressurizedWaterReactorPlantSpec,
        }),
        telemetry: {
          sampleIntervalMs: 1_000,
          variables: [valueOf('rcpA.running'), valueOf('turbine.electricMw')],
        },
        schedule: {
          actions: [{
            id: 'unit-2-rcp-a-trip',
            atMs: 2_000,
            type: 'tripComponent',
            componentId: 'rcpA' as never,
          }],
        },
      },
    ])

    const snapshots = multiPlant.runFor(5_000, 1_000)
    const bySystem = new Map(snapshots.map(snapshot => [snapshot.plantId, snapshot]))
    const unit1 = bySystem.get('unit-1')
    const unit2 = bySystem.get('unit-2')
    if (!unit1 || !unit2) throw new Error('expected both process plant unit snapshots')
    expect(unit1.runtime.variables.find(variable => variable.path === valueOf('rcpA.running'))?.value).toBe(true)
    expect(unit2.runtime.variables.find(variable => variable.path === valueOf('rcpA.running'))?.value).toBe(false)
    expect(unit1.telemetry?.find(series => series.path === valueOf('turbine.electricMw'))?.plantId).toBe('unit-1')
    expect(unit1.telemetry?.find(series => series.path === valueOf('turbine.electricMw'))?.points.length).toBe(6)
    expect(unit1.telemetry?.find(series => series.path === valueOf('turbine.electricMw'))?.points.at(-1)).toMatchObject({
      quantity: 'power',
      unit: 'MW',
      source: 'runtime',
    })
    expect(unit2.telemetry?.find(series => series.path === valueOf('rcpA.running'))?.points.at(-1)?.value).toBe(false)
  })

  test('per-Plant initial state is applied without mutating the shared Plant Model', () => {
    const unitA = compileTestSystem({
      id: 'unit-a',
      graph: pressurizedWaterReactorPlantSpec,
      initialState: {
        'core.rodInsertionFraction': 0.75,
        'sgA.secondaryInventoryKg': 48_000,
      },
    })
    const unitB = compileTestSystem({
      id: 'unit-b',
      graph: pressurizedWaterReactorPlantSpec,
    })
    const runtimeA = createProcessPlantRuntime({ system: unitA })
    const runtimeB = createProcessPlantRuntime({ system: unitB })

    expect(runtimeA.readVariable(valueOf('core.rodInsertionFraction'))).toBe(0.75)
    expect(runtimeA.readVariable(valueOf('sgA.secondaryInventoryKg'))).toBe(48_000)
    expect(runtimeB.readVariable(valueOf('core.rodInsertionFraction'))).not.toBe(0.75)
    expect(runtimeB.readVariable(valueOf('sgA.secondaryInventoryKg'))).not.toBe(48_000)
  })

  test('per-Plant restore preserves each Plant independently', () => {
    const unitA = compiledSystem()
    const unitB = compileTestSystem({
      id: 'plant-b',
      graph: pressurizedWaterReactorPlantSpec,
    })
    const runtimeA = createProcessPlantRuntime({ system: unitA })
    const runtimeB = createProcessPlantRuntime({ system: unitB })
    runtimeA.writeCommand({ type: 'setVariable', path: valueOf('rcpA.running'), value: false })
    runtimeA.tick(1_000)
    runtimeB.tick(1_000)

    const restoredA = createProcessPlantRuntime({ system: unitA, restoredCheckpoint: runtimeA.checkpoint() })
    const restoredB = createProcessPlantRuntime({ system: unitB, restoredCheckpoint: runtimeB.checkpoint() })

    expect(restoredA.readVariable(valueOf('rcpA.running'))).toBe(false)
    expect(restoredB.readVariable(valueOf('rcpA.running'))).toBe(true)
    expect(restoredA.snapshot().elapsedMs).toBe(restoredB.snapshot().elapsedMs)
  })

  test('initial-state reconciliation makes dependent pump and link values consistent before first tick', () => {
    const runtime = createProcessPlantRuntime({
      system: compiledSystemWithInitialState({
        'mainFeedwaterPumpA.running': false,
        'mainFeedwaterPumpB.running': false,
        'rcpA.running': false,
      }),
    })

    expect(Number(runtime.readVariable(valueOf('mainFeedwaterPumpA.flowKgPerS')))).toBeCloseTo(0, 6)
    expect(Number(runtime.readVariable(valueOf('mainFeedwaterPumpB.flowKgPerS')))).toBeCloseTo(0, 6)
    expect(Number(runtime.readVariable(valueOf('main-feedwater-pump-a-to-header.flowKgPerS')))).toBeCloseTo(0, 6)
    expect(Number(runtime.readVariable(valueOf('feedwater-control-valve-a-to-sg-a.flowKgPerS')))).toBeCloseTo(0, 6)
    expect(Number(runtime.readVariable(valueOf('rcpA.flowKgPerS')))).toBeCloseTo(0, 6)
    expect(Number(runtime.readVariable(valueOf('rcpA.developedHeadPa')))).toBeCloseTo(0, 6)
    expect(Number(runtime.readVariable(valueOf('rcpA.loopFlowKgPerS')))).toBeCloseTo(260, 6)
    expect(Number(runtime.readVariable(valueOf('rcs-hot-leg-a.flowKgPerS')))).toBeCloseTo(260, 6)
  })

  test('feedwater tank and condenser mass balances are internally consistent across fixed steps', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })
    const dtSeconds = 0.1

    for (let index = 0; index < 20; index += 1) runtime.tick(100)
    for (let index = 0; index < 80; index += 1) {
      const feedwaterBefore = Number(runtime.readVariable(valueOf('feedwaterTank.inventoryKg')))
      const condenserBefore = Number(runtime.readVariable(valueOf('condenser.condensateInventoryKg')))
      runtime.tick(100)

      const feedwaterAfter = Number(runtime.readVariable(valueOf('feedwaterTank.inventoryKg')))
      const feedwaterInflow =
        Number(runtime.readVariable(valueOf('condensate-pump-a-to-feedwater-tank.flowKgPerS')))
        + Number(runtime.readVariable(valueOf('condensate-pump-b-to-feedwater-tank.flowKgPerS')))
        + Number(runtime.readVariable(valueOf('feedwaterTank.makeupFlowKgPerS')))
      const feedwaterOutflow =
        Number(runtime.readVariable(valueOf('feedwater-tank-to-main-feedwater-pump-a.flowKgPerS')))
        + Number(runtime.readVariable(valueOf('feedwater-tank-to-main-feedwater-pump-b.flowKgPerS')))
      expect(feedwaterAfter - feedwaterBefore).toBeCloseTo((feedwaterInflow - feedwaterOutflow) * dtSeconds, 6)

      const condenserAfter = Number(runtime.readVariable(valueOf('condenser.condensateInventoryKg')))
      const condenserInflow = Number(runtime.readVariable(valueOf('condenser.condensateProductionKgPerS')))
      const condenserOutflow =
        Number(runtime.readVariable(valueOf('condenser-to-condensate-pump-a.flowKgPerS')))
        + Number(runtime.readVariable(valueOf('condenser-to-condensate-pump-b.flowKgPerS')))
      expect(condenserAfter - condenserBefore).toBeCloseTo((condenserInflow - condenserOutflow) * dtSeconds, 6)
    }
  })

  test('steam generator secondary inventory follows feedwater, tube leak, and steam outlet balance direction', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })

    for (let index = 0; index < 30; index += 1) runtime.tick(100)
    const inventoryBefore = Number(runtime.readVariable(valueOf('sgA.secondaryInventoryKg')))
    runtime.writeCommand({ type: 'setVariable', path: valueOf('mainFeedwaterPumpA.running'), value: false })
    runtime.writeCommand({ type: 'setVariable', path: valueOf('mainFeedwaterPumpB.running'), value: false })
    for (let index = 0; index < 120; index += 1) runtime.tick(100)

    const feedwaterFlow = Number(runtime.readVariable(valueOf('sgA.feedwaterFlowKgPerS')))
    const leakFlow = Number(runtime.readVariable(valueOf('sgA.primaryToSecondaryLeakKgPerS')))
    const boilingRate = Number(runtime.readVariable(valueOf('sgA.boilingRateKgPerS')))
    expect(feedwaterFlow + leakFlow).toBeLessThan(boilingRate)
    expect(Number(runtime.readVariable(valueOf('sgA.secondaryInventoryKg')))).toBeLessThan(inventoryBefore)
  })

  test('steam generator secondary inventory is mass-conservative across fixed steps', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })
    const dtSeconds = 0.1

    for (let index = 0; index < 40; index += 1) runtime.tick(100)
    runtime.writeCommand({ type: 'setVariable', path: valueOf('sgA.tubeLeakFraction'), value: 0.15 })
    for (let index = 0; index < 80; index += 1) {
      const inventoryBefore = Number(runtime.readVariable(valueOf('sgA.secondaryInventoryKg')))
      runtime.tick(100)
      const inventoryAfter = Number(runtime.readVariable(valueOf('sgA.secondaryInventoryKg')))
      const feedwaterFlow = Number(runtime.readVariable(valueOf('sgA.feedwaterFlowKgPerS')))
      const tubeLeakFlow = Number(runtime.readVariable(valueOf('sgA.primaryToSecondaryLeakKgPerS')))
      const boilingRate = Number(runtime.readVariable(valueOf('sgA.boilingRateKgPerS')))

      expect(inventoryAfter - inventoryBefore).toBeCloseTo((feedwaterFlow + tubeLeakFlow - boilingRate) * dtSeconds, 6)
      expect(Number(runtime.readVariable(valueOf('sgA.secondaryInventoryBalanceResidualKg')))).toBeCloseTo(0, 6)
    }
  })

  test('steam generator steam-space mass is conservative across fixed steps', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })
    const dtSeconds = 0.1

    for (let index = 0; index < 80; index += 1) runtime.tick(100)
    runtime.writeCommand({ type: 'setVariable', path: valueOf('turbine.loadFraction'), value: 0.35 })
    for (let index = 0; index < 80; index += 1) {
      const steamMassBefore = Number(runtime.readVariable(valueOf('sgA.steamMassKg')))
      runtime.tick(100)
      const steamMassAfter = Number(runtime.readVariable(valueOf('sgA.steamMassKg')))
      const boilingRate = Number(runtime.readVariable(valueOf('sgA.boilingRateKgPerS')))
      const steamOutflow = Number(runtime.readVariable(valueOf('sg-a-steam-to-msiv-a.flowKgPerS')))

      expect(steamMassAfter - steamMassBefore).toBeCloseTo((boilingRate - steamOutflow) * dtSeconds, 6)
      expect(Number(runtime.readVariable(valueOf('sgA.steamOutflowKgPerS')))).toBeCloseTo(steamOutflow, 6)
      expect(Number(runtime.readVariable(valueOf('sgA.steamMassBalanceResidualKg')))).toBeCloseTo(0, 6)
    }
  })

  test('steam generator boiling rate remains energy-consistent with heat transfer', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })

    for (let index = 0; index < 50; index += 1) runtime.tick(100)

    const heatTransferMw = Number(runtime.readVariable(valueOf('sgA.heatTransferMw')))
    const boilingRateKgPerS = Number(runtime.readVariable(valueOf('sgA.boilingRateKgPerS')))
    expect(boilingRateKgPerS * latentHeatSteamMjPerKg).toBeCloseTo(heatTransferMw, 6)
    expect(Number(runtime.readVariable(valueOf('sgA.boilingEnergyResidualMw')))).toBeCloseTo(0, 6)
  })

  test('runtime checkpoints carry model identity and reject mismatched restores', () => {
    const system = compiledSystem()
    const runtime = createProcessPlantRuntime({ system })
    runtime.tick(1_000)
    const snapshot = runtime.snapshot()
    const checkpoint = runtime.checkpoint()

    expect(snapshot.graphSpecId).toBe(String(system.graph.specId))
    expect(snapshot.variablePaths).toEqual(system.graph.variables.map(variable => variable.path))
    expect(() => createProcessPlantRuntime({
      system,
      restoredCheckpoint: {
        ...checkpoint,
        modelDigest: '0'.repeat(64),
      },
    })).toThrow('does not match Plant model')
    expect(() => createProcessPlantRuntime({
      system,
      restoredCheckpoint: {
        ...checkpoint,
        values: checkpoint.values.slice(1),
      },
    })).toThrow('value count')
  })

  test('process link sensors and component valves behave as readable control displays', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })

    runtime.tick(1_000)
    const openFlow = Number(runtime.readVariable(valueOf('sg-a-steam-to-msiv-a.flowKgPerS')))
    expect(openFlow).toBeGreaterThan(0)

    runtime.writeCommand({
      type: 'setVariable',
      path: valueOf('mainSteamIsolationValveA.positionFraction'),
      value: 0.5,
    })
    runtime.writeCommand({
      type: 'setVariable',
      path: valueOf('sg-a-steam-to-msiv-a.leak.areaFraction'),
      value: 0.1,
    })
    runtime.tick(100)

    expect(Number(runtime.readVariable(valueOf('sg-a-steam-to-msiv-a.flowKgPerS')))).toBeLessThan(openFlow)
    expect(Number(runtime.readVariable(valueOf('mainSteamIsolationValveA.inletFlowKgPerS')))).toBeGreaterThan(0)
    expect(Number(runtime.readVariable(valueOf('mainSteamIsolationValveA.flowBalanceResidualKgPerS')))).toBeCloseTo(0, 6)
    expect(Number(runtime.readVariable(valueOf('sg-a-steam-to-msiv-a.radiationMSvPerH')))).toBeGreaterThan(0.02)
    expect(() => runtime.writeCommand({
      type: 'setVariable',
      path: valueOf('sg-a-steam-to-msiv-a.pressureMPa'),
      value: 1,
    })).toThrow('not writable')
  })

  test('process link physical capacity limits fluid flow without adding hidden components', () => {
    const runtime = createProcessPlantRuntime({
      system: compiledSystemWithConnectionPhysical('feedwater-control-valve-a-to-sg-a', { nominalFlowKgPerS: 25 }),
    })

    for (let index = 0; index < 40; index += 1) runtime.tick(100)

    expect(Number(runtime.readVariable(valueOf('feedwater-control-valve-a-to-sg-a.flowKgPerS'))))
      .toBeLessThanOrEqual(25)
  })

  test('heat exchanger conservatively transfers heat between two fluid sides', () => {
    const graph = plantGraph({
      id: 'process-plant.heat-exchanger-acceptance.v1',
      title: 'Heat Exchanger Acceptance',
      fixedStepMs: 100,
      components: [
        component('hotTank', 'processTank', 'Hot Tank', {
          nominalInventoryKg: 100_000,
          initialInventoryFraction: 0.9,
          initialTemperatureC: 180,
          makeupFlowKgPerS: 0,
          maxOutletFlowKgPerS: 80,
        }),
        component('coldTank', 'processTank', 'Cold Tank', {
          nominalInventoryKg: 100_000,
          initialInventoryFraction: 0.9,
          initialTemperatureC: 30,
          makeupFlowKgPerS: 0,
          maxOutletFlowKgPerS: 80,
        }),
        component('hx', 'heatExchanger', 'Component Cooling Heat Exchanger', {
          uaMwPerC: 0.8,
          hotSideDesignFlowKgPerS: 80,
          coldSideDesignFlowKgPerS: 80,
          effectivenessLimit: 0.85,
          thermalMassMJPerC: 0,
          initialHotTemperatureC: 180,
          initialColdTemperatureC: 30,
        }),
        component('hotReturn', 'processHeader', 'Hot Return Header', {}),
        component('coldReturn', 'processHeader', 'Cold Return Header', {}),
      ],
      connections: [
        connect('hot-tank-to-hx', 'hotTank.outlet', 'hx.hotIn', { connectionKind: 'fluidFlow', service: 'hotLoop', nominalFluid: 'water', designPhase: 'liquid', solverModel: 'incompressibleLiquid', variables: liquidVariables(180, 1) }),
        connect('hx-to-hot-return', 'hx.hotOut', 'hotReturn.inletA', { connectionKind: 'fluidFlow', service: 'hotLoop', nominalFluid: 'water', designPhase: 'liquid', solverModel: 'incompressibleLiquid', variables: liquidVariables(180, 1) }),
        connect('cold-tank-to-hx', 'coldTank.outlet', 'hx.coldIn', { connectionKind: 'fluidFlow', service: 'coldLoop', nominalFluid: 'water', designPhase: 'liquid', solverModel: 'incompressibleLiquid', variables: liquidVariables(30, 1) }),
        connect('hx-to-cold-return', 'hx.coldOut', 'coldReturn.inletA', { connectionKind: 'fluidFlow', service: 'coldLoop', nominalFluid: 'water', designPhase: 'liquid', solverModel: 'incompressibleLiquid', variables: liquidVariables(30, 1) }),
      ],
    })
    const runtime = createProcessPlantRuntime({ system: compileTestSystem({ id: 'hx', graph }) })

    for (let index = 0; index < 20; index += 1) runtime.tick(100)

    expect(Number(runtime.readVariable(valueOf('hx.hotOutletTemperatureC')))).toBeLessThan(Number(runtime.readVariable(valueOf('hx.hotInletTemperatureC'))))
    expect(Number(runtime.readVariable(valueOf('hx.coldOutletTemperatureC')))).toBeGreaterThan(Number(runtime.readVariable(valueOf('hx.coldInletTemperatureC'))))
    expect(Number(runtime.readVariable(valueOf('hx.heatTransferMw')))).toBeGreaterThan(0)
    expect(Number(runtime.readVariable(valueOf('hx.heatTransferCapacityMw')))).toBeGreaterThanOrEqual(Number(runtime.readVariable(valueOf('hx.heatTransferMw'))))
    expect(Number(runtime.readVariable(valueOf('hx.coolingAvailabilityFraction')))).toBeCloseTo(1, 1)
    expect(Math.abs(Number(runtime.readVariable(valueOf('hx.heatBalanceResidualMw'))))).toBeLessThan(1)
  })

  test('accumulator injects into containment and containment accumulates released mass', () => {
    const graph = plantGraph({
      id: 'process-plant.accumulator-containment-acceptance.v1',
      title: 'Accumulator And Containment Acceptance',
      fixedStepMs: 100,
      components: [
        component('acc', 'accumulator', 'Safety Injection Accumulator', {
          totalVolumeM3: 60,
          initialLiquidInventoryKg: 35_000,
          initialGasPressureMPa: 4.5,
          injectionSetpointMPa: 2.5,
          outletCvKgPerSPerSqrtMPa: 40,
          minimumUsableInventoryKg: 1_000,
          initialTemperatureC: 35,
        }),
        component('containment', 'containmentVolume', 'Containment', {
          freeVolumeM3: 60_000,
          initialPressureMPa: 0.101325,
          initialTemperatureC: 35,
          initialHumidityFraction: 0.45,
          heatLossMwPerC: 0.02,
        }),
      ],
      connections: [
        connect('acc-to-containment', 'acc.outlet', 'containment.massEnergyIn', {
          connectionKind: 'fluidFlow',
          service: 'safetyInjection',
          nominalFluid: 'water',
          designPhase: 'liquid',
          solverModel: 'incompressibleLiquid',
          variables: liquidVariables(35, 0.101325),
        }),
      ],
    })
    const runtime = createProcessPlantRuntime({ system: compileTestSystem({ id: 'acc-containment', graph }) })
    const initialInventory = Number(runtime.readVariable(valueOf('acc.liquidInventoryKg')))
    const initialSump = Number(runtime.readVariable(valueOf('containment.sumpInventoryKg')))

    for (let index = 0; index < 30; index += 1) runtime.tick(100)

    expect(Number(runtime.readVariable(valueOf('acc.outletFlowKgPerS')))).toBeGreaterThan(0)
    expect(Number(runtime.readVariable(valueOf('acc.liquidInventoryKg')))).toBeLessThan(initialInventory)
    expect(Number(runtime.readVariable(valueOf('containment.sumpInventoryKg')))).toBeGreaterThan(initialSump)
    expect(Number(runtime.readVariable(valueOf('containment.incomingMassKgPerS')))).toBeGreaterThan(0)
  })

  test('couples reactor heat, primary flow, steam generation, turbine load, and condenser sink', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })

    runtime.tick(1_000)

    expect(Number(runtime.readVariable(valueOf('core.coolantOutletTemperatureC'))))
      .toBeGreaterThan(Number(runtime.readVariable(valueOf('core.coolantInletTemperatureC'))))
    expect(Number(runtime.readVariable(valueOf('sgA.primaryOutletTemperatureC'))))
      .toBeLessThan(Number(runtime.readVariable(valueOf('sgA.primaryInletTemperatureC'))))
    expect(Number(runtime.readVariable(valueOf('sgA.tubeMetalTemperatureC'))))
      .toBeGreaterThan(Number(runtime.readVariable(valueOf('sgA.secondaryTemperatureC'))))
    expect(Number(runtime.readVariable(valueOf('sgA.heatTransferMw')))).toBeGreaterThan(0)
    expect(Number(runtime.readVariable(valueOf('sgA.steamFlowKgPerS')))).toBeGreaterThan(0)
    expect(Number(runtime.readVariable(valueOf('sgA.boilingRateKgPerS')))).toBeGreaterThan(0)
    expect(Number(runtime.readVariable(valueOf('sgA.feedwaterFlowKgPerS')))).toBeGreaterThan(0)
    expect(Number(runtime.readVariable(valueOf('sgA.steamQualityFraction')))).toBeGreaterThan(0.75)
    expect(Number(runtime.readVariable(valueOf('turbine.electricMw')))).toBeGreaterThan(0)
    expect(Number(runtime.readVariable(valueOf('condenser.steamFlowKgPerS')))).toBeGreaterThan(0)
    expect(Number(runtime.readVariable(valueOf('condenser.heatRejectedMw')))).toBeGreaterThan(0)
  })

  test('reactor trip leaves decay heat while fission power falls', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })

    for (let index = 0; index < 50; index += 1) runtime.tick(100)
    const initialFissionPower = Number(runtime.readVariable(valueOf('core.powerMw')))
    runtime.writeCommand({ type: 'setVariable', path: valueOf('core.rodInsertionFraction'), value: 1 })
    for (let index = 0; index < 150; index += 1) runtime.tick(100)

    const trippedFissionPower = Number(runtime.readVariable(valueOf('core.powerMw')))
    const decayHeat = Number(runtime.readVariable(valueOf('core.decayHeatMw')))
    const heatToCoolant = Number(runtime.readVariable(valueOf('core.heatToCoolantMw')))
    expect(trippedFissionPower).toBeLessThan(initialFissionPower * 0.1)
    expect(decayHeat).toBeGreaterThan(0)
    expect(decayHeat).toBeGreaterThan(trippedFissionPower)
    expect(heatToCoolant).toBeGreaterThan(trippedFissionPower)
  })

  test('reactor coolant pump trip drives real RPS, turbine trip, and feedwater isolation response', () => {
    const system = compiledSystem()
    const runtime = createProcessPlantRuntime({ system })
    const protection = createProcessPlantProtectionRunner({
      system,
      protection: pressurizedWaterReactorReferenceIc,
    })

    for (let index = 0; index < 50; index += 1) runtime.tick(100)
    const initialLevel = Number(runtime.readVariable(valueOf('sgA.levelPercent')))
    for (const loop of ['A', 'B', 'C', 'D'] as const) {
      runtime.writeCommand({ type: 'setVariable', path: valueOf(`rcp${loop}.running`), value: false })
    }

    let maxLevel = initialLevel
    let levelWhenMainFeedwaterIsolated: number | null = null
    for (let elapsedMs = 1_000; elapsedMs <= 180_000; elapsedMs += 1_000) {
      runtime.tick(1_000)
      protection.evaluate({
        runtime,
        elapsedMs: runtime.elapsedMs(),
        simulationRunId: 'run-runtime-rps-test' as SimulationRunId,
        sourceRuntimeId: 'process-plant.local',
      })
      const currentLevel = Number(runtime.readVariable(valueOf('sgA.levelPercent')))
      maxLevel = Math.max(maxLevel, currentLevel)
      if (runtime.readVariable(valueOf('mainFeedwaterPumpA.running')) === false && levelWhenMainFeedwaterIsolated === null) {
        levelWhenMainFeedwaterIsolated = currentLevel
      }
    }

    const active = activeLifecycleIds(protection.snapshot())
    expect(active.trips).toContain('trip:reactor-low-rcp-flow-trip:low-rcp-flow-trip')
    expect(active.alarms).toEqual(expect.arrayContaining([
      'alarm:main-feedwater-pump-trip:main-feedwater-pump-unavailable',
      'alarm:rcp-a-trip:not-running',
      'alarm:rcp-b-trip:not-running',
      'alarm:rcp-c-trip:not-running',
      'alarm:rcp-d-trip:not-running',
    ]))
    // The trip ends power operation: the generator's output and load alarms no longer apply.
    expect(active.alarms).not.toContain('alarm:turbine-load-low:load-low')
    expect(active.alarms).not.toContain('alarm:generator-output-low:generator-output-low')

    expect(runtime.readVariable(valueOf('reactorTripBreakerA.closed'))).toBe(false)
    expect(runtime.readVariable(valueOf('reactorTripBreakerB.closed'))).toBe(false)
    expect(Number(runtime.readVariable(valueOf('core.rodInsertionFraction')))).toBe(1)
    expect(Number(runtime.readVariable(valueOf('turbineStopValve.positionFraction')))).toBeCloseTo(0, 6)
    expect(Number(runtime.readVariable(valueOf('turbineStopValve.effectivePositionFraction')))).toBeCloseTo(0, 6)
    expect(Number(runtime.readVariable(valueOf('turbine.loadFraction')))).toBeCloseTo(0, 6)
    expect(runtime.readVariable(valueOf('mainFeedwaterPumpA.running'))).toBe(false)
    expect(runtime.readVariable(valueOf('mainFeedwaterPumpB.running'))).toBe(false)
    expect(Number(runtime.readVariable(valueOf('core.powerMw')))).toBeLessThan(100)
    expect(Number(runtime.readVariable(valueOf('core.decayHeatMw')))).toBeGreaterThan(Number(runtime.readVariable(valueOf('core.powerMw'))))

    const bypassValvePosition = Number(runtime.readVariable(valueOf('turbineBypassValve.effectivePositionFraction')))
    const bypassFlow = Number(runtime.readVariable(valueOf('turbine-bypass-valve-to-condenser.flowKgPerS')))
    expect(Number(runtime.readVariable(valueOf('main-steam-header-to-turbine-bypass-valve.pressureMPa')))).toBeLessThan(8.2)
    expect(bypassValvePosition).toBeCloseTo(0, 6)
    expect(bypassFlow).toBeCloseTo(0, 6)

    const finalLevel = Number(runtime.readVariable(valueOf('sgA.levelPercent')))
    expect(maxLevel).toBeGreaterThan(initialLevel)
    expect(maxLevel).toBeLessThan(75)
    expect(levelWhenMainFeedwaterIsolated).not.toBeNull()
    expect(levelWhenMainFeedwaterIsolated ?? 0).toBeGreaterThan(finalLevel)
    expect(finalLevel).toBeGreaterThan(40)
  })

  test('turbine bypass remains closed in normal operation and opens to the condenser after turbine trip pressure rise', () => {
    const runtime = createProcessPlantRuntime({ system: compileProcessPlant(createPwrReferencePlantDefinition({ id: 'bypass' })) })

    for (let index = 0; index < 50; index += 1) runtime.tick(100)
    expect(Number(runtime.readVariable(valueOf('turbine-bypass-valve-to-condenser.flowKgPerS')))).toBeCloseTo(0, 6)

    runtime.writeCommand({ type: 'setVariable', path: valueOf('turbineStopValve.positionFraction'), value: 0 })
    runtime.writeCommand({ type: 'setVariable', path: valueOf('turbine.loadFraction'), value: 0 })
    let maxBypassFlow = 0
    let maxBypassPressure = 0
    let maxBypassOpening = 0
    const initialSteamFlow = Number(runtime.readVariable(valueOf('turbine.steamFlowKgPerS')))
    for (let index = 0; index < 900; index += 1) {
      runtime.tick(100)
      maxBypassFlow = Math.max(maxBypassFlow, Number(runtime.readVariable(valueOf('turbine-bypass-valve-to-condenser.flowKgPerS'))))
      maxBypassPressure = Math.max(maxBypassPressure, Number(runtime.readVariable(valueOf('main-steam-header-to-turbine-bypass-valve.pressureMPa'))))
      maxBypassOpening = Math.max(maxBypassOpening, Number(runtime.readVariable(valueOf('turbineBypassValve.effectivePositionFraction'))))
    }

    expect(maxBypassPressure).toBeGreaterThan(8.2)
    // Opening is pressure-driven, not a fixed percentage; require useful release.
    expect(maxBypassOpening).toBeGreaterThan(0)
    expect(maxBypassFlow).toBeGreaterThan(initialSteamFlow * 0.03)
    expect(Number(runtime.readVariable(valueOf('condenser.steamFlowKgPerS')))).toBeGreaterThan(initialSteamFlow * 0.03)
  })

  test('reactor temperature feedback suppresses fission power when fuel starts hot', () => {
    const baseline = createProcessPlantRuntime({ system: compiledSystem() })
    const hotFuel = createProcessPlantRuntime({
      system: compiledSystemWithInitialState({
        'core.fuelTemperatureC': 540,
        'core.fuelLowerTemperatureC': 520,
        'core.fuelMidTemperatureC': 550,
        'core.fuelUpperTemperatureC': 540,
      }),
    })

    for (let index = 0; index < 30; index += 1) {
      baseline.tick(100)
      hotFuel.tick(100)
    }

    expect(Number(hotFuel.readVariable(valueOf('core.powerMw'))))
      .toBeLessThan(Number(baseline.readVariable(valueOf('core.powerMw'))))
    expect(Number(hotFuel.readVariable(valueOf('core.temperatureFeedbackPcm')))).toBeLessThan(0)
    expect(Number(hotFuel.readVariable(valueOf('core.effectiveReactivityPcm'))))
      .toBeLessThan(Number(hotFuel.readVariable(valueOf('core.promptReactivityPcm'))))
  })

  test('reactor core initializes near critical and separates fission, decay, thermal power, and axial fuel heat', () => {
    const runtime = createProcessPlantRuntime({ system: compileProcessPlant(createPwrReferencePlantDefinition({ id: 'critical' })) })
    const initialPower = Number(runtime.readVariable(valueOf('core.powerMw')))

    for (let index = 0; index < 10; index += 1) runtime.tick(100)

    expect(Number(runtime.readVariable(valueOf('core.promptReactivityPcm')))).toBeCloseTo(0, 6)
    expect(Math.abs(Number(runtime.readVariable(valueOf('core.effectiveReactivityPcm'))))).toBeLessThan(35)
    expect(Number(runtime.readVariable(valueOf('core.fissionPowerMw')))).toBeCloseTo(Number(runtime.readVariable(valueOf('core.powerMw'))), 6)
    expect(Number(runtime.readVariable(valueOf('core.totalThermalPowerMw'))))
      .toBeCloseTo(Number(runtime.readVariable(valueOf('core.fissionPowerMw'))) + Number(runtime.readVariable(valueOf('core.decayHeatMw'))), 6)
    expect(Number(runtime.readVariable(valueOf('core.fuelStoredEnergyMj')))).toBeGreaterThan(0)
    expect(Number(runtime.readVariable(valueOf('core.fuelMidTemperatureC'))))
      .toBeGreaterThan(Number(runtime.readVariable(valueOf('core.fuelLowerTemperatureC'))))
    expect(Number(runtime.readVariable(valueOf('core.powerMw')))).toBeGreaterThan(initialPower * 0.9)
    expect(Number(runtime.readVariable(valueOf('core.powerMw')))).toBeLessThan(initialPower * 1.05)
  })

  test('positive rod reactivity is rate-limited and opposed by fuel and coolant temperature feedback', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })
    const baseline = createProcessPlantRuntime({ system: compiledSystem() })

    for (let index = 0; index < 100; index += 1) {
      runtime.tick(100)
      baseline.tick(100)
    }
    runtime.writeCommand({ type: 'setVariable', path: valueOf('core.rodInsertionFraction'), value: 0.08 })
    for (let index = 0; index < 240; index += 1) {
      runtime.tick(100)
      baseline.tick(100)
    }

    expect(Number(runtime.readVariable(valueOf('core.promptReactivityPcm')))).toBeGreaterThan(0)
    expect(Number(runtime.readVariable(valueOf('core.temperatureFeedbackPcm')))).toBeLessThan(0)
    expect(Number(runtime.readVariable(valueOf('core.effectiveReactivityPcm'))))
      .toBeLessThan(Number(runtime.readVariable(valueOf('core.promptReactivityPcm'))))
    expect(Number(runtime.readVariable(valueOf('core.powerMw'))))
      .toBeGreaterThan(Number(baseline.readVariable(valueOf('core.powerMw'))))
    expect(Number(runtime.readVariable(valueOf('core.powerMw')))).toBeLessThan(3400 * 1.2)
  })

  test('pressurizer heaters and relief valve change pressure through component behavior', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })
    const baseline = createProcessPlantRuntime({ system: compiledSystem() })

    for (let index = 0; index < 20; index += 1) {
      runtime.tick(100)
      baseline.tick(100)
    }
    runtime.writeCommand({ type: 'setVariable', path: valueOf('pressurizer.heaterPowerMw'), value: 20 })
    for (let index = 0; index < 320; index += 1) {
      runtime.tick(100)
      baseline.tick(100)
    }
    const heatedPressure = Number(runtime.readVariable(valueOf('pressurizer.pressureMPa')))
    expect(heatedPressure).toBeGreaterThan(Number(baseline.readVariable(valueOf('pressurizer.pressureMPa'))))

    runtime.writeCommand({ type: 'setVariable', path: valueOf('pressurizer.heaterPowerMw'), value: 0 })
    runtime.writeCommand({ type: 'setVariable', path: valueOf('pressurizer.reliefValvePositionFraction'), value: 1 })
    for (let index = 0; index < 120; index += 1) runtime.tick(100)

    expect(Number(runtime.readVariable(valueOf('pressurizer.reliefFlowKgPerS')))).toBeGreaterThan(0)
    expect(Number(runtime.readVariable(valueOf('pressurizer.pressureMPa')))).toBeLessThan(heatedPressure)
    expect(Number(runtime.readVariable(valueOf('pressurizer-relief-to-tank.flowKgPerS')))).toBeGreaterThan(0)
  })

  test('pressurizer steam mass follows conservative generation, spray, and relief balance', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })
    const dtSeconds = 0.1

    runtime.writeCommand({ type: 'setVariable', path: valueOf('pressurizer.heaterPowerMw'), value: 15 })
    runtime.writeCommand({ type: 'setVariable', path: valueOf('pressurizer.sprayFlowKgPerS'), value: 80 })
    for (let index = 0; index < 20; index += 1) runtime.tick(100)

    const steamMassBefore = Number(runtime.readVariable(valueOf('pressurizer.steamMassKg')))
    runtime.tick(100)
    const steamMassAfter = Number(runtime.readVariable(valueOf('pressurizer.steamMassKg')))
    const netSteamMassFlow = Number(runtime.readVariable(valueOf('pressurizer.steamMassFlowKgPerS')))

    expect(steamMassAfter - steamMassBefore).toBeCloseTo(netSteamMassFlow * dtSeconds, 6)
    expect(Number(runtime.readVariable(valueOf('pressurizer.steamMassBalanceResidualKg')))).toBeCloseTo(0, 6)

    runtime.writeCommand({ type: 'setVariable', path: valueOf('pressurizer.reliefValvePositionFraction'), value: 1 })
    for (let index = 0; index < 20; index += 1) runtime.tick(100)
    expect(Number(runtime.readVariable(valueOf('pressurizer.steamMassFlowKgPerS')))).toBeLessThan(0)
  })

  test('pressurizer pressure target follows steam-space state and primary inventory bias', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })

    for (let index = 0; index < 40; index += 1) runtime.tick(100)
    const initialSteamVolume = Number(runtime.readVariable(valueOf('pressurizer.steamVolumeM3')))
    const initialPressureTarget = Number(runtime.readVariable(valueOf('pressurizer.pressureTargetMPa')))
    runtime.writeCommand({ type: 'setVariable', path: valueOf('pressurizer.sprayFlowKgPerS'), value: 160 })
    for (let index = 0; index < 160; index += 1) runtime.tick(100)

    const steamPressure = Number(runtime.readVariable(valueOf('pressurizer.steamPressureMPa')))
    const target = Number(runtime.readVariable(valueOf('pressurizer.pressureTargetMPa')))
    const vesselBias = Number(runtime.readVariable(valueOf('vessel.primaryPressureBiasMPa')))
    expect(Number(runtime.readVariable(valueOf('pressurizer.steamVolumeM3')))).toBeLessThan(initialSteamVolume)
    expect(target).toBeCloseTo(steamPressure + vesselBias, 2)
    expect(target).toBeLessThan(initialPressureTarget)
    expect(Number(runtime.readVariable(valueOf('pressurizer.waterInventoryBalanceResidualKg')))).toBeCloseTo(0, 6)
  })

  test('primary coolant inventory feeds the canonical pressurizer pressure response', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })

    for (let index = 0; index < 20; index += 1) runtime.tick(100)
    const initialInventory = Number(runtime.readVariable(valueOf('vessel.primaryCoolantInventoryKg')))
    const initialPressure = Number(runtime.readVariable(valueOf('pressurizer.pressureMPa')))
    runtime.writeCommand({ type: 'setVariable', path: valueOf('pressurizer.reliefValvePositionFraction'), value: 1 })
    for (let index = 0; index < 300; index += 1) runtime.tick(100)

    expect(Number(runtime.readVariable(valueOf('pressurizer.reliefFlowKgPerS')))).toBeGreaterThan(0)
    expect(Number(runtime.readVariable(valueOf('vessel.primaryCoolantInventoryKg')))).toBeLessThan(initialInventory)
    expect(Number(runtime.readVariable(valueOf('vessel.primaryCoolantInventoryDeviationKg')))).toBeLessThan(0)
    expect(Number(runtime.readVariable(valueOf('vessel.compressibilityPressureBiasMPa')))).toBeLessThan(0)
    expect(Number(runtime.readVariable(valueOf('vessel.reliefOutflowKgPerS')))).toBeGreaterThan(0)
    expect(Number(runtime.readVariable(valueOf('vessel.safetyInjectionFlowKgPerS')))).toBeGreaterThanOrEqual(0)
    expect(Number(runtime.readVariable(valueOf('pressurizer.pressureMPa')))).toBeLessThan(initialPressure)
    const hotLegPressureDrop = Number(runtime.readVariable(valueOf('rcs-hot-leg-a.pressureDropMPa')))
    expect(hotLegPressureDrop).toBeGreaterThan(0)
    expect(Number(runtime.readVariable(valueOf('rcs-hot-leg-a.pressureMPa'))))
      .toBeCloseTo(Number(runtime.readVariable(valueOf('pressurizer.pressureMPa'))) - hotLegPressureDrop, 6)
  })

  test('reactor vessel pressure bias separates compressibility from thermal expansion effects', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })
    const hotPrimary = createProcessPlantRuntime({
      system: compiledSystemWithInitialState({
        'core.coolantInletTemperatureC': 312,
        'core.coolantOutletTemperatureC': 336,
      }),
    })

    for (let index = 0; index < 40; index += 1) {
      runtime.tick(100)
      hotPrimary.tick(100)
    }

    expect(Number(hotPrimary.readVariable(valueOf('vessel.meanPrimaryCoolantTemperatureC'))))
      .toBeGreaterThan(Number(runtime.readVariable(valueOf('vessel.meanPrimaryCoolantTemperatureC'))))
    expect(Number(hotPrimary.readVariable(valueOf('vessel.thermalExpansionPressureBiasMPa'))))
      .toBeGreaterThan(Number(runtime.readVariable(valueOf('vessel.thermalExpansionPressureBiasMPa'))))

    const beforeLeakCompressibilityBias = Number(runtime.readVariable(valueOf('vessel.compressibilityPressureBiasMPa')))
    runtime.writeCommand({ type: 'setVariable', path: valueOf('rcs-cold-leg-a.leak.areaFraction'), value: 0.2 })
    for (let index = 0; index < 240; index += 1) runtime.tick(100)

    expect(Number(runtime.readVariable(valueOf('vessel.compressibilityPressureBiasMPa'))))
      .toBeLessThan(beforeLeakCompressibilityBias)
    expect(Number(runtime.readVariable(valueOf('vessel.primaryPressureBiasMPa'))))
      .toBeCloseTo(
        Number(runtime.readVariable(valueOf('vessel.compressibilityPressureBiasMPa')))
        + Number(runtime.readVariable(valueOf('vessel.thermalExpansionPressureBiasMPa'))),
        6,
      )
  })

  test('primary coolant link pressure drop and leaks are link-local hydraulic effects', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })
    const baseline = createProcessPlantRuntime({ system: compiledSystem() })

    for (let index = 0; index < 40; index += 1) {
      runtime.tick(100)
      baseline.tick(100)
    }

    const initialInventory = Number(runtime.readVariable(valueOf('vessel.primaryCoolantInventoryKg')))
    const initialHotLegFlow = Number(runtime.readVariable(valueOf('rcs-hot-leg-a.flowKgPerS')))
    runtime.writeCommand({ type: 'setVariable', path: valueOf('rcs-hot-leg-a.leak.areaFraction'), value: 0.15 })
    for (let index = 0; index < 240; index += 1) {
      runtime.tick(100)
      baseline.tick(100)
    }

    expect(Number(runtime.readVariable(valueOf('rcs-hot-leg-a.leakFlowKgPerS')))).toBeGreaterThan(0)
    expect(Number(runtime.readVariable(valueOf('vessel.primaryCoolantInventoryKg')))).toBeLessThan(initialInventory)
    expect(Number(runtime.readVariable(valueOf('vessel.primaryPressureBiasMPa')))).toBeLessThan(0)
    expect(Number(runtime.readVariable(valueOf('vessel.primaryLeakFlowKgPerS'))))
      .toBeCloseTo(Number(runtime.readVariable(valueOf('rcs-hot-leg-a.leakFlowKgPerS'))), 6)
    expect(Number(runtime.readVariable(valueOf('vessel.netInventoryFlowKgPerS')))).toBeLessThan(0)
    expect(Number(runtime.readVariable(valueOf('pressurizer.pressureMPa'))))
      .toBeLessThan(Number(baseline.readVariable(valueOf('pressurizer.pressureMPa'))))
    expect(Number(runtime.readVariable(valueOf('rcs-hot-leg-a.flowKgPerS')))).toBeLessThan(initialHotLegFlow)
  })

  test('primary boundary leak releases to containment and starts accumulator injection after depressurization', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })

    for (let index = 0; index < 40; index += 1) runtime.tick(100)

    const baselineDiagnostics = runtime.pwrTransientDiagnostics()
    const initialPrimaryInventory = Number(runtime.readVariable(valueOf('vessel.primaryCoolantInventoryKg')))
    const initialContainmentPressure = Number(runtime.readVariable(valueOf('containment.pressureMPa')))
    const initialContainmentSump = Number(runtime.readVariable(valueOf('containment.sumpInventoryKg')))
    const initialAccumulatorInventory = Number(runtime.readVariable(valueOf('safetyAccumulatorA.liquidInventoryKg')))

    runtime.writeCommand({ type: 'setVariable', path: valueOf('rcs-hot-leg-a.leak.areaFraction'), value: 0.65 })
    let observedAccumulatorInjection = false
    let observedVesselInjection = false
    for (let index = 0; index < 1_800; index += 1) {
      runtime.tick(100)
      observedAccumulatorInjection = observedAccumulatorInjection || Number(runtime.readVariable(valueOf('safetyAccumulatorA.outletFlowKgPerS'))) > 0
      observedVesselInjection = observedVesselInjection || Number(runtime.readVariable(valueOf('vessel.safetyInjectionFlowKgPerS'))) > 0
    }

    const transientDiagnostics = runtime.pwrTransientDiagnostics()
    expect(Number(runtime.readVariable(valueOf('vessel.primaryLeakFlowKgPerS')))).toBeGreaterThan(0)
    expect(transientDiagnostics.primary.leakFlowKgPerS).toBeGreaterThan(0)
    expect(transientDiagnostics.primary.inventoryKg).toBeLessThan(baselineDiagnostics.primary.inventoryKg ?? Number.POSITIVE_INFINITY)
    expect(transientDiagnostics.containment.incomingMassKgPerS).toBeGreaterThan(0)
    expect(transientDiagnostics.containment.sumpInventoryKg).toBeGreaterThan(baselineDiagnostics.containment.sumpInventoryKg ?? 0)
    expect(transientDiagnostics.containment.pressureMPa).toBeGreaterThan(baselineDiagnostics.containment.pressureMPa ?? 0)
    expect(transientDiagnostics.safetySystems.accumulatorInventoryKg).toBeLessThan(baselineDiagnostics.safetySystems.accumulatorInventoryKg)
    expect(Number(runtime.readVariable(valueOf('vessel-release-to-containment.flowKgPerS'))))
      .toBeCloseTo(Number(runtime.readVariable(valueOf('vessel.primaryLeakFlowKgPerS'))), 6)
    expect(Number(runtime.readVariable(valueOf('containment.incomingMassKgPerS')))).toBeGreaterThan(0)
    expect(Number(runtime.readVariable(valueOf('containment.sumpInventoryKg')))).toBeGreaterThan(initialContainmentSump)
    expect(Number(runtime.readVariable(valueOf('containment.pressureMPa')))).toBeGreaterThan(initialContainmentPressure)
    expect(Number(runtime.readVariable(valueOf('containment.radiationSourceTermMSvPerH')))).toBeGreaterThan(0.02)
    expect(observedAccumulatorInjection).toBe(true)
    expect(Number(runtime.readVariable(valueOf('safetyAccumulatorA.liquidInventoryKg')))).toBeLessThan(initialAccumulatorInventory)
    expect(observedVesselInjection).toBe(true)
    expect(Number(runtime.readVariable(valueOf('vessel.primaryCoolantInventoryKg')))).toBeLessThan(initialPrimaryInventory)
  }, 20_000)

  test('steam generator tube leak transfers primary coolant to secondary inventory and radiation', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })
    const baseline = createProcessPlantRuntime({ system: compiledSystem() })

    for (let index = 0; index < 40; index += 1) {
      runtime.tick(100)
      baseline.tick(100)
    }
    const initialPrimaryInventory = Number(runtime.readVariable(valueOf('vessel.primaryCoolantInventoryKg')))
    const initialSecondaryInventory = Number(runtime.readVariable(valueOf('sgA.secondaryInventoryKg')))
    runtime.writeCommand({ type: 'setVariable', path: valueOf('sgA.tubeLeakFraction'), value: 0.25 })
    for (let index = 0; index < 600; index += 1) {
      runtime.tick(100)
      baseline.tick(100)
    }

    expect(Number(runtime.readVariable(valueOf('sgA.primaryToSecondaryLeakKgPerS')))).toBeGreaterThan(0)
    expect(Number(runtime.readVariable(valueOf('vessel.tubeLeakFlowKgPerS'))))
      .toBeCloseTo(Number(runtime.readVariable(valueOf('sgA.primaryToSecondaryLeakKgPerS'))), 6)
    expect(Number(runtime.readVariable(valueOf('vessel.primaryCoolantInventoryKg')))).toBeLessThan(initialPrimaryInventory)
    expect(Number(runtime.readVariable(valueOf('sgA.secondaryInventoryKg')))).toBeGreaterThan(initialSecondaryInventory)
    expect(Number(runtime.readVariable(valueOf('pressurizer.pressureMPa'))))
      .toBeLessThan(Number(baseline.readVariable(valueOf('pressurizer.pressureMPa'))))
    expect(Number(runtime.readVariable(valueOf('sgA.secondaryRadiationMSvPerH')))).toBeGreaterThan(1)
    expect(Number(runtime.readVariable(valueOf('sg-a-steam-to-msiv-a.radiationMSvPerH')))).toBeGreaterThan(1)
    expect(Number(runtime.readVariable(valueOf('sgB.secondaryRadiationMSvPerH')))).toBeCloseTo(0.02, 6)
  }, 20_000)

  test('loss of feedwater trends steam generator inventory downward', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })

    runtime.tick(1_000)
    const beforeCollapsedLevel = Number(runtime.readVariable(valueOf('sgA.collapsedLevelPercent')))
    const initialFeedwaterFlow = Number(runtime.readVariable(valueOf('sgA.feedwaterFlowKgPerS')))
    runtime.writeCommand({ type: 'setVariable', path: valueOf('mainFeedwaterPumpA.running'), value: false })
    runtime.writeCommand({ type: 'setVariable', path: valueOf('mainFeedwaterPumpB.running'), value: false })
    runtime.tick(100)
    expect(Number(runtime.readVariable(valueOf('mainFeedwaterPumpA.flowKgPerS')))).toBeGreaterThan(0)
    for (let index = 0; index < 120; index += 1) runtime.tick(100)

    expect(Number(runtime.readVariable(valueOf('sgA.collapsedLevelPercent')))).toBeLessThan(beforeCollapsedLevel)
    expect(Number(runtime.readVariable(valueOf('sgA.secondaryInventoryKg')))).toBeLessThan(56_000 * beforeCollapsedLevel / 100)
    expect(Number(runtime.readVariable(valueOf('sgA.feedwaterFlowKgPerS')))).toBeLessThan(initialFeedwaterFlow)
    expect(Number(runtime.readVariable(valueOf('sgA.levelPercent'))))
      .toBeGreaterThan(Number(runtime.readVariable(valueOf('sgA.collapsedLevelPercent'))))
    expect(Number(runtime.readVariable(valueOf('sgA.voidFraction')))).toBeGreaterThan(0)

    const diagnostics = runtime.pwrTransientDiagnostics()
    expect(diagnostics.secondary.feedwaterFlowKgPerS).toBeLessThan(initialFeedwaterFlow * 4)
    expect(diagnostics.secondary.feedwaterTankInventoryKg).toBeGreaterThan(0)
    expect(diagnostics.balanceOfPlant.turbineSteamFlowKgPerS).toBeGreaterThanOrEqual(0)
  })

  test('low steam generator level uncovers tube bundle and degrades heat transfer', () => {
    const baseline = createProcessPlantRuntime({ system: compiledSystem() })
    const uncovered = createProcessPlantRuntime({
      system: compiledSystemWithInitialState({
        'sgA.levelPercent': 15,
        'sgA.collapsedLevelPercent': 15,
        'sgA.secondaryInventoryKg': 8_400,
      }),
    })

    baseline.tick(1_000)
    uncovered.tick(1_000)

    expect(Number(uncovered.readVariable(valueOf('sgA.tubeCoverageFraction')))).toBeLessThan(1)
    expect(Number(uncovered.readVariable(valueOf('sgA.tubeUncoveredFraction')))).toBeGreaterThan(0)
    expect(Number(uncovered.readVariable(valueOf('sgA.availableHeatTransferFraction')))).toBeLessThan(1)
    expect(Number(uncovered.readVariable(valueOf('sgA.heatTransferMw'))))
      .toBeLessThan(Number(baseline.readVariable(valueOf('sgA.heatTransferMw'))))

    const diagnostics = uncovered.pwrTransientDiagnostics()
    expect(diagnostics.secondary.minTubeCoverageFraction).toBeLessThan(1)
    expect(diagnostics.secondary.maxTubeUncoveredFraction).toBeGreaterThan(0)
    expect(diagnostics.secondary.tubeBundleUncoveredSteamGeneratorCount).toBeGreaterThan(0)
  })

  test('feedwater and condensate inventories constrain secondary-side flow sources', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })

    for (let index = 0; index < 20; index += 1) runtime.tick(100)
    const initialFeedwaterInventory = Number(runtime.readVariable(valueOf('feedwaterTank.inventoryKg')))
    const initialCondenserInventory = Number(runtime.readVariable(valueOf('condenser.condensateInventoryKg')))

    runtime.writeCommand({ type: 'setVariable', path: valueOf('feedwaterTank.makeupFlowKgPerS'), value: 0 })
    runtime.writeCommand({ type: 'setVariable', path: valueOf('condensatePumpA.running'), value: false })
    runtime.writeCommand({ type: 'setVariable', path: valueOf('condensatePumpB.running'), value: false })
    for (let index = 0; index < 300; index += 1) runtime.tick(100)

    expect(Number(runtime.readVariable(valueOf('feedwaterTank.inventoryKg')))).toBeLessThan(initialFeedwaterInventory)
    expect(Number(runtime.readVariable(valueOf('feedwaterTank.levelPercent')))).toBeLessThan(82)
    expect(Number(runtime.readVariable(valueOf('condenser.condensateProductionKgPerS')))).toBeGreaterThan(0)
    expect(Number(runtime.readVariable(valueOf('condenser.condensateInventoryKg')))).toBeGreaterThan(initialCondenserInventory)
  })

  test('feedwater headers distribute available flow through open downstream valves', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystemWithStaticFeedwaterValves() })

    for (let index = 0; index < 40; index += 1) runtime.tick(100)
    runtime.writeCommand({ type: 'setVariable', path: valueOf('feedwaterControlValveB.positionFraction'), value: 0 })
    runtime.writeCommand({ type: 'setVariable', path: valueOf('feedwaterControlValveC.positionFraction'), value: 0 })
    runtime.writeCommand({ type: 'setVariable', path: valueOf('feedwaterControlValveD.positionFraction'), value: 0 })
    for (let index = 0; index < 20; index += 1) runtime.tick(100)

    const pumpDischargeFlow =
      Number(runtime.readVariable(valueOf('main-feedwater-pump-a-to-header.flowKgPerS')))
      + Number(runtime.readVariable(valueOf('main-feedwater-pump-b-to-header.flowKgPerS')))
    const openHeaderBranchFlow = Number(runtime.readVariable(valueOf('feedwater-header-to-control-valve-a.flowKgPerS')))
    const openValveFlow = Number(runtime.readVariable(valueOf('feedwater-control-valve-a-to-sg-a.flowKgPerS')))

    expect(Number(runtime.readVariable(valueOf('feedwater-header-to-control-valve-b.flowKgPerS')))).toBeCloseTo(0, 6)
    expect(Number(runtime.readVariable(valueOf('feedwater-header-to-control-valve-c.flowKgPerS')))).toBeCloseTo(0, 6)
    expect(Number(runtime.readVariable(valueOf('feedwater-header-to-control-valve-d.flowKgPerS')))).toBeCloseTo(0, 6)
    expect(openHeaderBranchFlow).toBeCloseTo(pumpDischargeFlow, 6)
    expect(openValveFlow).toBeCloseTo(openHeaderBranchFlow, 6)
    expect(Number(runtime.readVariable(valueOf('feedwaterHeader.flowBalanceResidualKgPerS')))).toBeCloseTo(0, 6)
    expect(Number(runtime.readVariable(valueOf('feedwaterControlValveA.flowBalanceResidualKgPerS')))).toBeCloseTo(0, 6)
    expect(Number(runtime.readVariable(valueOf('sgA.feedwaterFlowKgPerS')))).toBeCloseTo(openValveFlow, 6)
    expect(Number(runtime.readVariable(valueOf('sgB.feedwaterFlowKgPerS')))).toBeCloseTo(0, 6)
  })

  test('feedwater source flow follows reachable downstream demand', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystemWithStaticFeedwaterValves() })

    for (let index = 0; index < 40; index += 1) runtime.tick(100)
    runtime.writeCommand({ type: 'setVariable', path: valueOf('feedwaterControlValveA.positionFraction'), value: 0 })
    runtime.writeCommand({ type: 'setVariable', path: valueOf('feedwaterControlValveB.positionFraction'), value: 0 })
    runtime.writeCommand({ type: 'setVariable', path: valueOf('feedwaterControlValveC.positionFraction'), value: 0 })
    runtime.writeCommand({ type: 'setVariable', path: valueOf('feedwaterControlValveD.positionFraction'), value: 0 })
    for (let index = 0; index < 30; index += 1) runtime.tick(100)

    expect(Number(runtime.readVariable(valueOf('feedwater-tank-to-main-feedwater-pump-a.flowKgPerS')))).toBeCloseTo(0, 6)
    expect(Number(runtime.readVariable(valueOf('feedwater-tank-to-main-feedwater-pump-b.flowKgPerS')))).toBeCloseTo(0, 6)
    expect(Number(runtime.readVariable(valueOf('main-feedwater-pump-a-to-header.flowKgPerS')))).toBeCloseTo(0, 6)
    expect(Number(runtime.readVariable(valueOf('main-feedwater-pump-b-to-header.flowKgPerS')))).toBeCloseTo(0, 6)
    expect(Number(runtime.readVariable(valueOf('feedwaterHeader.flowBalanceResidualKgPerS')))).toBeCloseTo(0, 6)
  })

  test('feedwater and auxiliary feedwater header branch flows conserve incoming service flow', () => {
    const system = compiledSystemWithStaticFeedwaterValves()
    const runtime = createProcessPlantRuntime({ system })

    for (let index = 0; index < 40; index += 1) runtime.tick(100)

    const table = createProcessPlantVariableTable(system, initialComponentValueFor, runtime.checkpoint().values)
    const componentIndex = (componentId: string): number => {
      const index = system.graph.componentIndexById.get(componentId as never)
      if (index === undefined) throw new Error(`missing process plant component in test graph: ${componentId}`)
      return index
    }
    const feedwaterHeaderBalance = componentFlowBalanceForService(
      system,
      componentIndex('feedwaterHeader'),
      'feedwater' as ConnectionService,
      table,
    )
    const auxFeedwaterHeaderBalance = componentFlowBalanceForService(
      system,
      componentIndex('auxFeedwaterHeader'),
      'auxFeedwater' as ConnectionService,
      table,
    )

    expect(feedwaterHeaderBalance.outflowKgPerS).toBeGreaterThan(0)
    expect(feedwaterHeaderBalance.residualKgPerS).toBeCloseTo(0, 6)
    expect(auxFeedwaterHeaderBalance.residualKgPerS).toBeCloseTo(0, 6)
  })

  test('main feedwater pumps cannot deliver flow after the feedwater tank is depleted', () => {
    const runtime = createProcessPlantRuntime({
      system: compiledSystemWithInitialState({
        'feedwaterTank.inventoryKg': 0,
        'feedwaterTank.levelPercent': 0,
        'feedwaterTank.makeupFlowKgPerS': 0,
        'feedwaterTank.availableOutletFlowKgPerS': 0,
        'turbine.loadFraction': 0,
        'condenser.condensateInventoryKg': 0,
        'condenser.condensateLevelPercent': 0,
        'condenser.availableCondensateOutletFlowKgPerS': 0,
        'condensatePumpA.running': false,
        'condensatePumpB.running': false,
      }),
    })

    for (let index = 0; index < 20; index += 1) runtime.tick(100)

    expect(Number(runtime.readVariable(valueOf('feedwaterTank.inventoryKg')))).toBeCloseTo(0, 6)
    expect(Number(runtime.readVariable(valueOf('feedwater-tank-to-main-feedwater-pump-a.flowKgPerS')))).toBeCloseTo(0, 6)
    expect(Number(runtime.readVariable(valueOf('main-feedwater-pump-a-to-header.flowKgPerS')))).toBeCloseTo(0, 6)
    expect(Number(runtime.readVariable(valueOf('feedwater-control-valve-a-to-sg-a.flowKgPerS')))).toBeCloseTo(0, 6)
    expect(Number(runtime.readVariable(valueOf('sgA.feedwaterFlowKgPerS')))).toBeCloseTo(0, 6)
  })

  test('condensate pumps cannot deliver flow after the condenser hotwell is depleted', () => {
    const runtime = createProcessPlantRuntime({
      system: compiledSystemWithInitialState({
        'turbine.loadFraction': 0,
        'mainSteamIsolationValveA.positionFraction': 0,
        'mainSteamIsolationValveB.positionFraction': 0,
        'mainSteamIsolationValveC.positionFraction': 0,
        'mainSteamIsolationValveD.positionFraction': 0,
        'condenser.condensateInventoryKg': 0,
        'condenser.condensateLevelPercent': 0,
        'condenser.availableCondensateOutletFlowKgPerS': 0,
      }),
    })

    for (let index = 0; index < 20; index += 1) runtime.tick(100)

    expect(Number(runtime.readVariable(valueOf('condenser.condensateInventoryKg')))).toBeLessThan(0.05)
    expect(Number(runtime.readVariable(valueOf('condenser-to-condensate-pump-a.flowKgPerS')))).toBeCloseTo(0, 6)
    expect(Number(runtime.readVariable(valueOf('condensate-pump-a-to-feedwater-tank.flowKgPerS')))).toBeCloseTo(0, 6)
  })

  test('auxiliary feedwater tank depletes when auxiliary pumps feed steam generators', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })

    for (let index = 0; index < 20; index += 1) runtime.tick(100)
    const initialAuxInventory = Number(runtime.readVariable(valueOf('auxFeedwaterTank.inventoryKg')))
    runtime.writeCommand({ type: 'setVariable', path: valueOf('mainFeedwaterPumpA.running'), value: false })
    runtime.writeCommand({ type: 'setVariable', path: valueOf('mainFeedwaterPumpB.running'), value: false })
    runtime.writeCommand({ type: 'setVariable', path: valueOf('auxFeedwaterPumpMotor.running'), value: true })
    runtime.writeCommand({ type: 'setVariable', path: valueOf('auxFeedwaterPumpTurbine.running'), value: true })
    runtime.writeCommand({ type: 'setVariable', path: valueOf('auxFeedwaterValveA.positionFraction'), value: 1 })
    for (let index = 0; index < 240; index += 1) runtime.tick(100)

    expect(Number(runtime.readVariable(valueOf('auxFeedwaterPumpMotor.flowKgPerS')))).toBeGreaterThan(0)
    expect(Number(runtime.readVariable(valueOf('auxFeedwaterTank.inventoryKg')))).toBeLessThan(initialAuxInventory)
    expect(Number(runtime.readVariable(valueOf('aux-feedwater-valve-a-to-sg-a.flowKgPerS')))).toBeGreaterThan(0)
  })

  test('auxiliary feedwater demand is scoped to open downstream branches', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })

    for (let index = 0; index < 20; index += 1) runtime.tick(100)
    runtime.writeCommand({ type: 'setVariable', path: valueOf('auxFeedwaterPumpMotor.running'), value: true })
    runtime.writeCommand({ type: 'setVariable', path: valueOf('auxFeedwaterPumpTurbine.running'), value: true })
    runtime.writeCommand({ type: 'setVariable', path: valueOf('auxFeedwaterValveA.positionFraction'), value: 1 })
    runtime.writeCommand({ type: 'setVariable', path: valueOf('auxFeedwaterValveB.positionFraction'), value: 0 })
    runtime.writeCommand({ type: 'setVariable', path: valueOf('auxFeedwaterValveC.positionFraction'), value: 0 })
    runtime.writeCommand({ type: 'setVariable', path: valueOf('auxFeedwaterValveD.positionFraction'), value: 0 })
    for (let index = 0; index < 80; index += 1) runtime.tick(100)

    const openBranchFlow = Number(runtime.readVariable(valueOf('aux-feedwater-header-to-valve-a.flowKgPerS')))
    expect(openBranchFlow).toBeGreaterThan(0)
    expect(Number(runtime.readVariable(valueOf('aux-feedwater-valve-a-to-sg-a.flowKgPerS')))).toBeCloseTo(openBranchFlow, 6)
    expect(Number(runtime.readVariable(valueOf('aux-feedwater-header-to-valve-b.flowKgPerS')))).toBeCloseTo(0, 6)
    expect(Number(runtime.readVariable(valueOf('auxFeedwaterHeader.flowBalanceResidualKgPerS')))).toBeCloseTo(0, 6)

    runtime.writeCommand({ type: 'setVariable', path: valueOf('auxFeedwaterValveA.positionFraction'), value: 0 })
    for (let index = 0; index < 40; index += 1) runtime.tick(100)

    expect(Number(runtime.readVariable(valueOf('motor-afw-pump-to-header.flowKgPerS')))).toBeCloseTo(0, 6)
    expect(Number(runtime.readVariable(valueOf('turbine-afw-pump-to-header.flowKgPerS')))).toBeCloseTo(0, 6)
    expect(Number(runtime.readVariable(valueOf('auxFeedwaterHeader.flowBalanceResidualKgPerS')))).toBeCloseTo(0, 6)
  })

  test('reactor coolant pump trip coasts down primary loop flow and heat transfer', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })

    for (let index = 0; index < 50; index += 1) runtime.tick(100)
    const flowingHeatTransfer = Number(runtime.readVariable(valueOf('sgA.heatTransferMw')))
    const initialFlow = Number(runtime.readVariable(valueOf('rcs-hot-leg-a.flowKgPerS')))
    const initialSteamFlow = Number(runtime.readVariable(valueOf('sg-a-steam-to-msiv-a.flowKgPerS')))
    const initialCoolingAvailability = Number(runtime.readVariable(valueOf('core.coreCoolingAvailabilityFraction')))
    runtime.writeCommand({ type: 'setVariable', path: valueOf('rcpA.running'), value: false })
    for (let index = 0; index < 20; index += 1) runtime.tick(100)

    const coastdownFlow = Number(runtime.readVariable(valueOf('rcs-hot-leg-a.flowKgPerS')))
    expect(coastdownFlow).toBeGreaterThan(0)
    expect(coastdownFlow).toBeLessThan(initialFlow)
    for (let index = 0; index < 400; index += 1) runtime.tick(100)
    const coastedNaturalCirculationFlow = Number(runtime.readVariable(valueOf('rcs-hot-leg-a.flowKgPerS')))
    const naturalCirculationTarget = Number(runtime.readVariable(valueOf('rcpA.loopFlowTargetKgPerS')))
    expect(naturalCirculationTarget).toBeCloseTo(260, 6)
    expect(coastedNaturalCirculationFlow).toBeGreaterThan(naturalCirculationTarget)
    expect(coastedNaturalCirculationFlow).toBeLessThan(initialFlow * 0.2)
    expect(coastedNaturalCirculationFlow).toBeLessThan(1_000)
    expect(Number(runtime.readVariable(valueOf('sgA.heatTransferMw')))).toBeLessThan(flowingHeatTransfer)
    expect(Number(runtime.readVariable(valueOf('core.coreCoolingAvailabilityFraction')))).toBeLessThan(initialCoolingAvailability)
    expect(Number(runtime.readVariable(valueOf('core.coreHeatRemovalDeficitMw')))).toBeGreaterThan(0)
    const diagnostics = runtime.pwrTransientDiagnostics()
    expect(diagnostics.core.coolingAvailabilityFraction).toBeLessThan(initialCoolingAvailability)
    expect(diagnostics.primary.runningReactorCoolantPumpCount).toBe(3)
    expect(diagnostics.primary.reactorCoolantFlowKgPerS).toBeLessThan(initialFlow * 4)
    expect(diagnostics.primary.minReactorCoolantPumpSpeedFraction).toBeGreaterThanOrEqual(0)
    expect(Number(runtime.readVariable(valueOf('sg-a-steam-to-msiv-a.flowKgPerS')))).toBeLessThan(initialSteamFlow * 0.75)
  })

  test('primary loop inertia is scoped to the tripped reactor coolant pump loop', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })

    for (let index = 0; index < 50; index += 1) runtime.tick(100)
    const initialA = Number(runtime.readVariable(valueOf('rcs-hot-leg-a.flowKgPerS')))
    const initialB = Number(runtime.readVariable(valueOf('rcs-hot-leg-b.flowKgPerS')))
    runtime.writeCommand({ type: 'setVariable', path: valueOf('rcpA.running'), value: false })
    for (let index = 0; index < 40; index += 1) runtime.tick(100)

    expect(Number(runtime.readVariable(valueOf('rcs-hot-leg-a.flowKgPerS')))).toBeLessThan(initialA)
    expect(Number(runtime.readVariable(valueOf('rcs-hot-leg-b.flowKgPerS')))).toBeGreaterThan(initialB * 0.95)
    expect(Number(runtime.readVariable(valueOf('rcpA.loopFlowKgPerS')))).toBeLessThan(Number(runtime.readVariable(valueOf('rcpB.loopFlowKgPerS'))))
  })

  test('reactor coolant pump speed changes developed head and loop flow target', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })

    for (let index = 0; index < 50; index += 1) runtime.tick(100)
    const initialHead = Number(runtime.readVariable(valueOf('rcpA.developedHeadPa')))
    const initialTarget = Number(runtime.readVariable(valueOf('rcpA.loopFlowTargetKgPerS')))
    const initialFlow = Number(runtime.readVariable(valueOf('rcs-hot-leg-a.flowKgPerS')))
    runtime.writeCommand({ type: 'setVariable', path: valueOf('rcpA.speedFraction'), value: 0.6 })
    for (let index = 0; index < 160; index += 1) runtime.tick(100)

    expect(Number(runtime.readVariable(valueOf('rcpA.developedHeadPa')))).toBeLessThan(initialHead * 0.5)
    expect(Number(runtime.readVariable(valueOf('rcpA.loopFlowTargetKgPerS')))).toBeLessThan(initialTarget * 0.7)
    expect(Number(runtime.readVariable(valueOf('rcs-hot-leg-a.flowKgPerS')))).toBeLessThan(initialFlow * 0.85)
    expect(Number(runtime.readVariable(valueOf('rcs-hot-leg-a.flowKgPerS')))).toBeGreaterThan(0)
  })

  test('primary loop link resistance contributes to reactor coolant pump flow target', () => {
    const baseline = createProcessPlantRuntime({ system: compiledSystem() })
    const restricted = createProcessPlantRuntime({
      system: compiledSystemWithConnectionPhysical('rcs-hot-leg-a', { nominalResistance: 0.4 }),
    })

    for (let index = 0; index < 160; index += 1) {
      baseline.tick(100)
      restricted.tick(100)
    }

    expect(Number(restricted.readVariable(valueOf('rcpA.loopFlowTargetKgPerS'))))
      .toBeLessThan(Number(baseline.readVariable(valueOf('rcpA.loopFlowTargetKgPerS'))))
    expect(Number(restricted.readVariable(valueOf('rcs-hot-leg-a.flowKgPerS'))))
      .toBeLessThan(Number(baseline.readVariable(valueOf('rcs-hot-leg-a.flowKgPerS'))))
    const baselineLoopB = Number(baseline.readVariable(valueOf('rcs-hot-leg-b.flowKgPerS')))
    const restrictedLoopB = Number(restricted.readVariable(valueOf('rcs-hot-leg-b.flowKgPerS')))
    expect(Math.abs(restrictedLoopB - baselineLoopB)).toBeLessThan(baselineLoopB * 0.02)
  })

  test('primary and secondary network flows remain coherent across pump and header links', () => {
    const system = compiledSystemWithStaticFeedwaterValves()
    const runtime = createProcessPlantRuntime({ system })

    for (let index = 0; index < 40; index += 1) runtime.tick(100)

    const initialHotLegFlow = Number(runtime.readVariable(valueOf('rcs-hot-leg-a.flowKgPerS')))
    const initialHotLegPressureDrop = Number(runtime.readVariable(valueOf('rcs-hot-leg-a.pressureDropMPa')))
    expect(Number(runtime.readVariable(valueOf('rcs-cold-leg-a.flowKgPerS')))).toBeCloseTo(initialHotLegFlow, 6)
    expect(Number(runtime.readVariable(valueOf('rcp-a-to-core.flowKgPerS')))).toBeCloseTo(initialHotLegFlow, 6)
    expect(Number(runtime.readVariable(valueOf('rcs-cold-leg-a.flowKgPerS')))).toBeCloseTo(initialHotLegFlow, 6)

    runtime.writeCommand({ type: 'setVariable', path: valueOf('rcpA.speedFraction'), value: 0.5 })
    for (let index = 0; index < 80; index += 1) runtime.tick(100)

    const reducedHotLegFlow = Number(runtime.readVariable(valueOf('rcs-hot-leg-a.flowKgPerS')))
    expect(reducedHotLegFlow).toBeLessThan(initialHotLegFlow)
    expect(Number(runtime.readVariable(valueOf('rcs-cold-leg-a.flowKgPerS')))).toBeCloseTo(reducedHotLegFlow, 6)
    expect(Number(runtime.readVariable(valueOf('rcp-a-to-core.flowKgPerS')))).toBeCloseTo(reducedHotLegFlow, 6)
    expect(Number(runtime.readVariable(valueOf('rcs-hot-leg-a.pressureDropMPa')))).toBeLessThan(initialHotLegPressureDrop)

    const table = createProcessPlantVariableTable(system, initialComponentValueFor, runtime.checkpoint().values)
    const componentIndex = (componentId: string): number => {
      const index = system.graph.componentIndexById.get(componentId as never)
      if (index === undefined) throw new Error(`missing process plant component in test graph: ${componentId}`)
      return index
    }
    const feedwaterHeaderBalance = componentFlowBalanceForService(
      system,
      componentIndex('feedwaterHeader'),
      'feedwater' as ConnectionService,
      table,
    )
    const mainSteamHeaderBalance = componentFlowBalanceForService(
      system,
      componentIndex('mainSteamHeader'),
      'mainSteam' as ConnectionService,
      table,
    )

    expect(feedwaterHeaderBalance.residualKgPerS).toBeCloseTo(0, 6)
    expect(mainSteamHeaderBalance.residualKgPerS).toBeCloseTo(0, 6)
  })

  test('main steam demand follows available topology instead of a global source split', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })

    for (let index = 0; index < 40; index += 1) runtime.tick(100)
    const initialOpenBranchFlow = Number(runtime.readVariable(valueOf('sg-a-steam-to-msiv-a.flowKgPerS')))
    runtime.writeCommand({ type: 'setVariable', path: valueOf('mainSteamIsolationValveB.positionFraction'), value: 0 })
    runtime.writeCommand({ type: 'setVariable', path: valueOf('mainSteamIsolationValveC.positionFraction'), value: 0 })
    runtime.writeCommand({ type: 'setVariable', path: valueOf('mainSteamIsolationValveD.positionFraction'), value: 0 })
    for (let index = 0; index < 20; index += 1) runtime.tick(100)

    expect(Number(runtime.readVariable(valueOf('sg-b-steam-to-msiv-b.flowKgPerS')))).toBeCloseTo(0, 6)
    expect(Number(runtime.readVariable(valueOf('sg-c-steam-to-msiv-c.flowKgPerS')))).toBeCloseTo(0, 6)
    expect(Number(runtime.readVariable(valueOf('sg-d-steam-to-msiv-d.flowKgPerS')))).toBeCloseTo(0, 6)
    expect(Number(runtime.readVariable(valueOf('sg-a-steam-to-msiv-a.flowKgPerS')))).toBeGreaterThan(initialOpenBranchFlow)
    expect(Number(runtime.readVariable(valueOf('main-steam-header-to-turbine-stop-valve.flowKgPerS'))))
      .toBeCloseTo(Number(runtime.readVariable(valueOf('sg-a-steam-to-msiv-a.flowKgPerS'))), 6)
  })

  test('main steam header pressure ignores isolated steam generator branches with no flow', () => {
    const runtime = createProcessPlantRuntime({
      system: compiledSystemWithInitialState({
        'sgA.pressureMPa': 9,
        'sgB.pressureMPa': 6,
        'sgC.pressureMPa': 6,
        'sgD.pressureMPa': 6,
      }),
    })

    runtime.writeCommand({ type: 'setVariable', path: valueOf('mainSteamIsolationValveA.positionFraction'), value: 0 })
    for (let index = 0; index < 20; index += 1) runtime.tick(100)

    expect(Number(runtime.readVariable(valueOf('sg-a-steam-to-msiv-a.flowKgPerS')))).toBeCloseTo(0, 6)
    expect(Number(runtime.readVariable(valueOf('sg-a-steam-to-msiv-a.pressureMPa')))).toBeGreaterThan(8)
    expect(Number(runtime.readVariable(valueOf('main-steam-header-to-turbine-stop-valve.pressureMPa')))).toBeLessThan(7.2)
  })

  test('main steam safety valve releases steam to containment when the turbine path is isolated', () => {
    const runtime = createProcessPlantRuntime({
      system: compiledSystemWithInitialState({
        'sgA.pressureMPa': 10,
        'sgB.pressureMPa': 10,
        'sgC.pressureMPa': 10,
        'sgD.pressureMPa': 10,
      }),
    })

    const initialContainmentPressure = Number(runtime.readVariable(valueOf('containment.pressureMPa')))
    const initialContainmentMass = Number(runtime.readVariable(valueOf('containment.sumpInventoryKg')))
    runtime.writeCommand({ type: 'setVariable', path: valueOf('turbineStopValve.positionFraction'), value: 0 })
    let maxSafetyPosition = 0
    let maxHeaderFlow = 0
    let maxContainmentFlow = 0
    let maxContainmentIncomingMass = 0
    for (let index = 0; index < 900; index += 1) {
      runtime.tick(100)
      maxSafetyPosition = Math.max(maxSafetyPosition, Number(runtime.readVariable(valueOf('mainSteamSafetyValve.effectivePositionFraction'))))
      maxHeaderFlow = Math.max(maxHeaderFlow, Number(runtime.readVariable(valueOf('main-steam-header-to-safety-valve.flowKgPerS'))))
      maxContainmentFlow = Math.max(maxContainmentFlow, Number(runtime.readVariable(valueOf('main-steam-safety-valve-to-containment.flowKgPerS'))))
      maxContainmentIncomingMass = Math.max(maxContainmentIncomingMass, Number(runtime.readVariable(valueOf('containment.incomingMassKgPerS'))))
    }

    expect(maxSafetyPosition).toBeGreaterThan(0.9)
    expect(maxHeaderFlow).toBeGreaterThan(100)
    expect(maxContainmentFlow).toBeGreaterThan(100)
    expect(maxContainmentIncomingMass).toBeGreaterThan(100)
    expect(Number(runtime.readVariable(valueOf('containment.pressureMPa')))).toBeGreaterThan(initialContainmentPressure)
    expect(Number(runtime.readVariable(valueOf('containment.sumpInventoryKg')))).toBeGreaterThan(initialContainmentMass)
  })

  test('runtime restore preserves primary loop inertia state per unit', () => {
    const system = compiledSystem()
    const runtime = createProcessPlantRuntime({ system })
    for (let index = 0; index < 50; index += 1) runtime.tick(100)
    runtime.writeCommand({ type: 'setVariable', path: valueOf('rcpA.running'), value: false })
    for (let index = 0; index < 30; index += 1) runtime.tick(100)
    const beforeRestore = Number(runtime.readVariable(valueOf('rcpA.loopFlowKgPerS')))
    const restored = createProcessPlantRuntime({ system, restoredCheckpoint: runtime.checkpoint() })

    expect(Number(restored.readVariable(valueOf('rcpA.loopFlowKgPerS')))).toBeCloseTo(beforeRestore, 6)
    restored.tick(100)
    expect(Number(restored.readVariable(valueOf('rcpA.loopFlowKgPerS')))).toBeLessThan(beforeRestore)
  })

  test('turbine load demand changes steam use and electrical output', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })

    for (let index = 0; index < 50; index += 1) runtime.tick(100)
    const loadedOutput = Number(runtime.readVariable(valueOf('turbine.electricMw')))
    const loadedSteamDemand = Number(runtime.readVariable(valueOf('turbine.steamDemandKgPerS')))
    const loadedHeatRejected = Number(runtime.readVariable(valueOf('condenser.heatRejectedMw')))
    runtime.writeCommand({ type: 'setVariable', path: valueOf('turbine.loadFraction'), value: 0.4 })
    for (let index = 0; index < 50; index += 1) runtime.tick(100)

    expect(Number(runtime.readVariable(valueOf('turbine.electricMw')))).toBeLessThan(loadedOutput)
    expect(Number(runtime.readVariable(valueOf('turbine.steamDemandKgPerS')))).toBeLessThan(loadedSteamDemand)
    expect(Number(runtime.readVariable(valueOf('turbine.steamAvailabilityFraction')))).toBeGreaterThanOrEqual(0)
    expect(Number(runtime.readVariable(valueOf('turbine.steamAvailabilityFraction')))).toBeLessThanOrEqual(1)
    expect(Number(runtime.readVariable(valueOf('turbine.exhaustTemperatureC')))).toBeGreaterThan(100)
    expect(Number(runtime.readVariable(valueOf('condenser.heatRejectedMw')))).toBeLessThan(loadedHeatRejected)
  })

  test('turbine demand responds to condenser backpressure', () => {
    const baseline = createProcessPlantRuntime({ system: compiledSystem() })
    const hotCondenser = createProcessPlantRuntime({
      system: compiledSystemWithParameters({
        ultimateHeatSink: { initialTemperatureC: 95 },
        condenser: { coolingWaterTemperatureC: 95 },
      }),
    })

    for (let index = 0; index < 240; index += 1) {
      baseline.tick(100)
      hotCondenser.tick(100)
    }

    expect(Number(hotCondenser.readVariable(valueOf('condenser.backPressurePa'))))
      .toBeGreaterThan(Number(baseline.readVariable(valueOf('condenser.backPressurePa'))))
    expect(Number(hotCondenser.readVariable(valueOf('turbine.steamDemandKgPerS'))))
      .toBeLessThan(Number(baseline.readVariable(valueOf('turbine.steamDemandKgPerS'))))
    expect(Number(hotCondenser.readVariable(valueOf('turbine.electricMw'))))
      .toBeLessThan(Number(baseline.readVariable(valueOf('turbine.electricMw'))))
  })

  test('condenser backpressure responds to cooling-water pump loss through the graph path', () => {
    const runtime = createProcessPlantRuntime({ system: compileProcessPlant(createPwrReferencePlantDefinition({ id: 'cooling-loss' })) })

    for (let index = 0; index < 80; index += 1) runtime.tick(100)
    const initialBackPressure = Number(runtime.readVariable(valueOf('condenser.backPressurePa')))
    const initialElectric = Number(runtime.readVariable(valueOf('turbine.electricMw')))
    const initialCoolingFlow = Number(runtime.readVariable(valueOf('condenser.coolingWaterFlowKgPerS')))
    runtime.writeCommand({ type: 'setVariable', path: valueOf('circulatingWaterPump.running'), value: false })
    for (let index = 0; index < 400; index += 1) runtime.tick(100)

    expect(Number(runtime.readVariable(valueOf('condenser.coolingWaterFlowKgPerS')))).toBeLessThan(initialCoolingFlow * 0.02)
    expect(Number(runtime.readVariable(valueOf('condenser.coolingWaterAvailabilityFraction')))).toBeLessThan(0.2)
    expect(Number(runtime.readVariable(valueOf('condenser.backPressurePa')))).toBeGreaterThan(initialBackPressure + 10_000)
    expect(Number(runtime.readVariable(valueOf('turbine.electricMw')))).toBeLessThan(initialElectric)
  })

  test('steam generator secondary pressure responds to steam mass imbalance', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })
    const baseline = createProcessPlantRuntime({ system: compiledSystem() })

    for (let index = 0; index < 80; index += 1) {
      runtime.tick(100)
      baseline.tick(100)
    }
    const initialSteamMass = Number(runtime.readVariable(valueOf('sgA.steamMassKg')))
    runtime.writeCommand({ type: 'setVariable', path: valueOf('turbine.loadFraction'), value: 0.35 })
    for (let index = 0; index < 160; index += 1) {
      runtime.tick(100)
      baseline.tick(100)
    }

    expect(Number(runtime.readVariable(valueOf('sgA.steamMassKg')))).toBeGreaterThan(initialSteamMass)
    expect(Number(runtime.readVariable(valueOf('sgA.pressureMPa'))))
      .toBeGreaterThan(Number(baseline.readVariable(valueOf('sgA.pressureMPa'))))
    expect(Number(runtime.readVariable(valueOf('sg-a-steam-to-msiv-a.pressureMPa'))))
      .toBeCloseTo(Number(runtime.readVariable(valueOf('sgA.pressureMPa'))), 6)
  })

  test('behavior contexts reject writes outside declared outputs', () => {
    const system = compiledSystem()
    const table = createProcessPlantVariableTable(system, initialComponentValueFor)
    const component = system.graph.components.find(candidate => candidate.id === 'core')
    if (!component) throw new Error('expected core component')
    const context = createBehaviorContext({
      behaviorId: 'test-behavior',
      phase: 'updateControlLogic',
      dtSeconds: 0.1,
      table,
      writablePaths: new Set([componentVariablePath(component, 'reactivityPcm')]),
    })

    expect(() => context.write(componentVariablePath(component, 'powerMw'), 10)).toThrow('cannot write undeclared variable')
  })

  test('behavior definitions declare read and write displays for auditability', () => {
    const behaviorIds = new Set<string>()
    for (const behavior of [...componentInitialReconciliationDefinitions, ...componentBehaviorDefinitions, ...processLinkBehaviorDefinitions]) {
      expect(behavior.reads.length).toBeGreaterThan(0)
      expect(behavior.writes.length).toBeGreaterThan(0)
      expect(behaviorIds.has(behavior.id)).toBe(false)
      behaviorIds.add(behavior.id)
    }
  })

  test('reference graph component kinds all have runtime behavior coverage', () => {
    const system = compiledSystem()
    const behaviorKinds = new Set(componentBehaviorDefinitions.map(behavior => behavior.componentKind))
    const initialReconciliationKinds = new Set(componentInitialReconciliationDefinitions.map(behavior => behavior.componentKind))

    for (const component of system.graph.components) {
      const kind = String(component.kind)
      expect(processPlantComponentRegistry.has(component.kind)).toBe(true)
      expect(
        behaviorKinds.has(kind) || initialReconciliationKinds.has(kind),
      ).toBe(true)
    }
  })

  test('reference graph component kinds all have exactly one runtime initializer', () => {
    const system = compiledSystem()
    const initializerKinds = new Map<string, number>()
    for (const definition of componentInitialValueDefinitions) {
      initializerKinds.set(definition.componentKind, (initializerKinds.get(definition.componentKind) ?? 0) + 1)
    }

    for (const component of system.graph.components) {
      expect(initializerKinds.get(String(component.kind))).toBe(1)
    }
  })

  test('reference graph fluid services are named in the runtime service vocabulary', () => {
    const system = compiledSystem()
    const knownServices = new Set(Object.values(processPlantServices))
    for (const link of system.graph.links) {
      if (link.kind !== 'fluidFlow' || link.service === undefined) continue
      expect(knownServices.has(link.service)).toBe(true)
    }
  })

  test('compiled execution plan validates behavior write declarations before runtime ticks', () => {
    const plan = compileProcessPlantExecutionPlan(compiledSystem())

    expect(plan.invocationCount).toBeGreaterThan(0)
  })

  test('behavior contexts reject non-finite numeric writes before they corrupt runtime state', () => {
    const system = compiledSystem()
    const table = createProcessPlantVariableTable(system, initialComponentValueFor)
    const component = system.graph.components.find(candidate => candidate.id === 'core')
    if (!component) throw new Error('expected core component')
    const context = createBehaviorContext({
      behaviorId: 'test-behavior',
      phase: 'updateControlLogic',
      dtSeconds: 0.1,
      table,
      writablePaths: new Set([componentVariablePath(component, 'reactivityPcm')]),
    })

    expect(() => context.write(componentVariablePath(component, 'reactivityPcm'), Number.NaN)).toThrow('non-finite value')
  })

  test('runtime rejects physically invalid writable process values before they enter the solver', () => {
    const runtime = createProcessPlantRuntime({ system: compiledSystem() })

    expect(() => runtime.writeCommand({
      type: 'setVariable',
      path: valueOf('mainSteamIsolationValveA.positionFraction'),
      value: 1.2,
    })).toThrow('fraction value must be between 0 and 1')
    expect(() => runtime.writeCommand({
      type: 'setVariable',
      path: valueOf('mainFeedwaterPumpA.speedFraction'),
      value: -1,
    })).toThrow('fraction value must be between 0 and 1')
  })

  test('CVCS concentration is carried through process links into reactor vessel inventory', () => {
    const system = compiledSystemWithParameters({
      volumeControlTank: { initialSoluteConcentrationPpm: 2_400 },
      chargingPump: { initialSpeedFraction: 1 },
    })
    const runtime = createProcessPlantRuntime({ system })
    const initialVesselConcentration = runtime.readVariable(valueOf('vessel.boronConcentrationPpm'))

    runtime.tick(60_000)

    expect(runtime.readVariable(valueOf('volumeControlTank.soluteConcentrationPpm'))).toBe(2_400)
    const chargingConcentration = runtime.readVariable(valueOf('charging-pump-to-cold-leg-a.soluteConcentrationPpm'))
    const vesselConcentration = runtime.readVariable(valueOf('vessel.boronConcentrationPpm'))
    if (typeof chargingConcentration !== 'number' || typeof vesselConcentration !== 'number' || typeof initialVesselConcentration !== 'number') {
      throw new Error('expected numeric CVCS concentration variables')
    }
    expect(chargingConcentration).toBeGreaterThan(2_000)
    expect(vesselConcentration).toBeGreaterThan(initialVesselConcentration)
  })

  test('electrical bus, breaker, diesel, and load components propagate energized state', () => {
    const graph = plantGraph({
      id: 'process-plant.electrical-acceptance.v1',
      title: 'Electrical Acceptance',
      fixedStepMs: 1_000,
      components: [
        component('grid', 'electricalGridSource', 'Grid', { nominalPowerMw: 20, initialAvailable: true }),
        component('gridBreaker', 'electricalBreaker', 'Grid Breaker', { nominalPowerMw: 20, initialClosed: true }),
        component('bus', 'electricalBus', 'Bus', { nominalPowerMw: 20 }),
        component('load', 'electricalLoad', 'Load', { nominalLoadMw: 4 }),
        component('diesel', 'dieselGenerator', 'Diesel', { nominalPowerMw: 8, startDelayS: 2, initialAvailable: true }),
        component('dieselBreaker', 'electricalBreaker', 'Diesel Breaker', { nominalPowerMw: 8, initialClosed: true }),
      ],
      connections: [
        connect('grid-to-breaker', 'grid.outlet', 'gridBreaker.inlet', { connectionKind: 'electricalPower' }),
        connect('breaker-to-bus', 'gridBreaker.outlet', 'bus.inlet', { connectionKind: 'electricalPower' }),
        connect('bus-to-load', 'bus.outlet', 'load.power', { connectionKind: 'electricalPower' }),
        connect('diesel-to-breaker', 'diesel.outlet', 'dieselBreaker.inlet', { connectionKind: 'electricalPower' }),
        connect('diesel-breaker-to-bus', 'dieselBreaker.outlet', 'bus.inlet', { connectionKind: 'electricalPower' }),
      ],
    })
    const runtime = createProcessPlantRuntime({
      system: compileTestSystem({ id: 'electrical', graph }),
    })

    runtime.tick(1_000)
    expect(runtime.readVariable(valueOf('bus.energized'))).toBe(true)
    expect(runtime.readVariable(valueOf('load.energized'))).toBe(true)

    runtime.writeCommand({ type: 'setVariable', path: valueOf('grid.available'), value: false })
    runtime.tick(1_000)
    expect(runtime.readVariable(valueOf('bus.energized'))).toBe(false)
    expect(runtime.readVariable(valueOf('load.energized'))).toBe(false)

    runtime.writeCommand({ type: 'setVariable', path: valueOf('diesel.startCommand'), value: true })
    runtime.tick(1_000)
    expect(runtime.readVariable(valueOf('diesel.running'))).toBe(false)
    runtime.tick(1_000)
    runtime.tick(1_000)
    expect(runtime.readVariable(valueOf('diesel.running'))).toBe(true)
    expect(runtime.readVariable(valueOf('bus.energized'))).toBe(true)
  })

  test('reference I&C starts emergency diesels after safety bus loss', () => {
    const system = compiledSystem()
    const runtime = createProcessPlantRuntime({ system })
    runtime.writeCommand({ type: 'setVariable', path: valueOf('offsiteBreakerA.closed'), value: false })
    runtime.writeCommand({ type: 'setVariable', path: valueOf('offsiteBreakerB.closed'), value: false })

    runWithReferenceProtection({
      system,
      runtime,
      durationMs: 15_000,
    })

    const diagnostics = runtime.pwrTransientDiagnostics()
    expect(runtime.readVariable(valueOf('dieselGeneratorA.startCommand'))).toBe(true)
    expect(runtime.readVariable(valueOf('dieselGeneratorB.startCommand'))).toBe(true)
    expect(runtime.readVariable(valueOf('dieselGeneratorA.running'))).toBe(true)
    expect(runtime.readVariable(valueOf('dieselGeneratorB.running'))).toBe(true)
    expect(diagnostics.safetySystems.deenergizedSafetyBusCount).toBe(0)
    expect(diagnostics.safetySystems.runningDieselCount).toBe(2)
    expect(diagnostics.electrical.deenergizedBusCount).toBe(0)
    expect(diagnostics.electrical.minSafetyBusVoltageFraction).toBeGreaterThan(0)
    expect(diagnostics.electrical.totalDemandLoadMw).toBeGreaterThan(0)
    expect(diagnostics.electrical.unservedLoadCount).toBe(0)
  })
})
