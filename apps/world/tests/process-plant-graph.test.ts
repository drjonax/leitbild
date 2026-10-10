import { describe, expect, test } from 'bun:test'
import { objectIdSchema, type PackId } from '../src/core/model/index.ts'
import type { PackRuntimeQuery } from '../src/simulation/protocol.ts'
import {
  answerProcessPlantQuery,
  assemblePwrReferencePlantGraph,
  assertPrimaryLoopTopologyValid,
  collectProcessPlantCatalog,
  compileProcessPlant,
  compileProcessPlants,
  compileResolvedProcessPlant,
  createProcessPlantRampRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
  processPlantCatalog,
  processPlantDefinitionCatalog,
  processPlantPwrReferenceAutomationRef,
  processPlantPwrReferenceModelRef,
  processPlantUnitPackDataSchema,
  variablePathSchema,
  type PlantGraphSpec,
} from '../src/packs/process-plant/index.ts'
import { scenarios } from './fixtures/scenarios.ts'
import { createProcessPlantRuntimePerformance, type ProcessPlantRuntimeInstance } from '../src/packs/process-plant/runtime-instance.ts'
import { processPlantCapabilities } from '../src/packs/process-plant/capabilities.ts'
import { capabilityJsonSchema } from '../src/simulation/capabilities.ts'


describe('process plant model composition', () => {
  test('the deployed PWR checkpoint identity changes only by decision', () => {
    const system = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:checkpoint', loopCount: 4 }))
    // Even descriptive graph edits affect the full-graph checkpoint digest, so
    // any change here must be an owner's decision. Frozen at 827c5690 through
    // the Agent upgrade; changed on 2026-10-10 when the owner chose to delete
    // the spec's hand-picked display profiles, accepting that PWR Runs
    // checkpointed before then cannot be restored and must be restarted.
    // Changed again on 2026-10-10, approved by the owner, when the model was
    // made to report equipment state truthfully; PWR Runs checkpointed before
    // then must be restarted.
    expect(system.modelDigest).toBe('7ea5b4b52e74b1652b3cadd87a5f97745d4462a2c21f2050f2b57cf9317819fd')
    const running = createProcessPlantRuntime({ system })
    running.tick(1_300)
    const persisted = JSON.parse(JSON.stringify(running.checkpoint()))
    const restored = createProcessPlantRuntime({ system, restoredCheckpoint: persisted })
    // JSON persistence normalizes signed zero; compare the persisted representation.
    expect(JSON.stringify(restored.snapshot())).toBe(JSON.stringify(running.snapshot()))
    restored.tick(700)
    running.tick(700)
    expect(JSON.stringify(restored.checkpoint())).toBe(JSON.stringify(running.checkpoint()))
  })

  test('publishes branded signal references as their truthful JSON wire types', () => {
    const capability = processPlantCapabilities.find(candidate => candidate.id === 'world.process-plant.signals.read')!
    const schema = capabilityJsonSchema(capability.input) as {
      properties: { signals: { items: { properties: Record<string, Record<string, unknown>> } } }
    }
    expect(schema.properties.signals.items.properties.path).toMatchObject({ type: 'string', minLength: 3 })
    expect(schema.properties.signals.items.properties.tagId).toMatchObject({ type: 'string', minLength: 1 })
  })

  test('builds and validates every supported PWR loop count from one model source', () => {
    for (let loopCount = 2; loopCount <= 6; loopCount += 1) {
      const system = compileProcessPlant(createPwrReferencePlantDefinition({
        id: `plant:${loopCount}`,
        loopCount,
      }))
      expect(system.modelRef).toBe(processPlantPwrReferenceModelRef)
      expect(system.automationRef).toBe(processPlantPwrReferenceAutomationRef)
      expect(system.graph.components.filter(component => component.kind === 'steamGenerator')).toHaveLength(loopCount)
      expect(system.graph.components.filter(component => component.metadata?.equipmentClass === 'reactor-coolant-pump')).toHaveLength(loopCount)
      expect(system.graph.components.filter(component => component.metadata?.loopId !== undefined)
        .every(component => typeof component.metadata?.ordinal === 'number')).toBe(true)
    }
  })

  test('applies sparse operating-point overrides without changing the shared model', () => {
    const baseline = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:baseline' }))
    const tailored = compileProcessPlant(createPwrReferencePlantDefinition({
      id: 'plant:tailored',
      parameterOverrides: { core: { ratedPowerMw: 2_200 } },
      valueOverrides: { 'pressurizer.pressureMPa': 14.9 },
    }))

    expect(baseline.graph.components.find(component => component.id === 'core')?.parameters).not.toMatchObject({ ratedPowerMw: 2_200 })
    expect(tailored.graph.components.find(component => component.id === 'core')?.parameters).toMatchObject({ ratedPowerMw: 2_200 })
    expect(tailored.initialState).toContainEqual({ path: variablePathSchema.parse('pressurizer.pressureMPa'), value: 14.9 })
  })

  test('rejects unknown components and invalid initial values at compile time', () => {
    expect(() => compileProcessPlant(createPwrReferencePlantDefinition({
      id: 'plant:bad-component',
      parameterOverrides: { missingComponent: {} },
    }))).toThrow('unknown component')
    expect(() => compileProcessPlant(createPwrReferencePlantDefinition({
      id: 'plant:bad-value',
      valueOverrides: { 'core.rodInsertionFraction': 2 },
    }))).toThrow('must be between 0 and 1')
  })

  test('keeps raw graph compilation internal to model definitions', () => {
    const invalid = structuredClone(assemblePwrReferencePlantGraph({ loopCount: 4 })) as PlantGraphSpec
    invalid.connections = invalid.connections.filter(connection => connection.id !== 'rcs-hot-leg-a')
    invalid.publishedVariables = invalid.publishedVariables.filter(path => !String(path).startsWith('rcs-hot-leg-a.'))

    expect(() => compileResolvedProcessPlant({
      id: 'plant:invalid-model',
      modelRef: 'test.invalid-model',
      operatingPointRef: 'test.operating-point',
      automationRef: 'test.automation',
      graph: invalid,
      automationForGraph: () => ({ operatingModes: [], annunciatorSystems: [], rules: [] }),
      validateGraph: assertPrimaryLoopTopologyValid,
    })).toThrow('primary loop A must have exactly one core hotLegA primaryCoolant outlet')
  })

  test('rejects duplicate Plant identities', () => {
    const definition = createPwrReferencePlantDefinition({ id: 'plant:duplicate' })
    expect(() => compileProcessPlants([definition, definition])).toThrow('duplicate process plant id')
  })
})

describe('process plant discovery', () => {
  test('describes configuration and live-data reads in searchable domain language', () => {
    const descriptions = new Map(processPlantCapabilities.map(capability => [capability.id, capability.description]))
    expect(descriptions.get('world.process-plant.catalog.list')).toContain('configuration, not a list of live Plant instances')
    expect(descriptions.get('world.process-plant.actions.search')).toContain('exact actionId values')
    expect(descriptions.get('world.process-plant.plants.list')).toContain('exact plantId values')
    expect(descriptions.get('world.process-plant.variables.read')).toContain('do not guess paths')
    expect(descriptions.get('world.process-plant.artifact.read')).toContain('complete authored Plant configuration')
    expect(descriptions.get('world.process-plant.components.search')).toContain('compact summaries')
    expect(descriptions.get('world.process-plant.variables.search')).toContain('current Plant variables')
    expect(descriptions.get('world.process-plant.signals.read')).toContain('live values')
    expect(descriptions.get('world.process-plant.transient.diagnostics')).toContain('diagnostics')
    const action = processPlantCapabilities.find(capability => capability.id === 'world.process-plant.action.invoke')
    expect(action?.searchTerms?.join(' ')).toContain('reactor coolant pump')
  })

  test('makes an unknown Plant identity a discoverable caller error', () => {
    try {
      answerProcessPlantQuery({
        request: { capabilityId: 'world.process-plant.alarms.summary', input: { plantId: 'unit2' } },
        plants: new Map(),
        objects: new Map(),
      })
      throw new Error('expected the query to reject an unknown Plant')
    } catch (error) {
      expect(error).toMatchObject({ code: 'capability_target_not_found' })
      expect((error as Error).message).toContain('world.process-plant.plants.list')
    }
  })

  test('lists the exact display profiles available on every live Plant', () => {
    const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:profiles' }))
    const plantId = objectIdSchema.parse(plant.id)
    const runtime = createProcessPlantRuntime({ system: plant })
    const response = answerProcessPlantQuery({
      request: { capabilityId: 'world.process-plant.plants.list', input: {} },
      plants: new Map([[plant.id, {
        plant,
        runtime,
        ramps: createProcessPlantRampRunner({ runtime }),
        performance: createProcessPlantRuntimePerformance(),
      }]]),
      objects: new Map([[plantId, { id: plantId, label: 'Profile Plant' }]]),
    }) as { plants: Array<Record<string, unknown>> }
    expect(response.plants[0]).toMatchObject({ id: plant.id, label: 'Profile Plant', modelRef: plant.modelRef, modelDigest: plant.modelDigest })
    // Displays are generated from the model; a Plant lists no hand-picked display profiles,
    // and says which services and loops a display can name.
    expect(response.plants[0]).not.toHaveProperty('displayProfiles')
    expect(response.plants[0]!.loops).toEqual(['A', 'B', 'C', 'D'])
    expect(response.plants[0]!.services).toEqual(expect.arrayContaining(['primaryCoolant', 'feedwater', 'electricalPower']))
    const capability = processPlantCapabilities.find(candidate => candidate.id === 'world.process-plant.plants.list')
    expect(capability).toBeDefined()
    expect(capability!.output.parse(response)).toEqual(response)
  })

  test('capability descriptions name no equipment, tag or service of a particular Plant', () => {
    const graph = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:descriptions', loopCount: 6 })).graph
    const names = new Set([
      ...graph.components.map(component => String(component.id)),
      ...graph.signalBindings.flatMap(binding => (binding.tagId === undefined ? [] : [String(binding.tagId)])),
      ...graph.links.flatMap(link => (link.service === undefined ? [] : [String(link.service)])),
    ].filter(name => name.length > 3))
    for (const capability of processPlantCapabilities) {
      const words = new Set(capability.description.split(/[^A-Za-z0-9-]+/))
      expect([...names].filter(name => words.has(name)), capability.id).toEqual([])
    }
  })

  test('makes unknown variable identities discoverable caller errors', () => {
    const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:missing-targets' }))
    const runtime = createProcessPlantRuntime({ system: plant })
    const plants = new Map([[plant.id, {
      plant,
      runtime,
      ramps: createProcessPlantRampRunner({ runtime }),
      performance: createProcessPlantRuntimePerformance(),
    }]])
    for (const request of [
      { capabilityId: 'world.process-plant.variables.read', input: { plantId: plant.id, paths: ['missing.value'] } },
    ]) {
      try {
        answerProcessPlantQuery({ request, plants, objects: new Map() })
        throw new Error('expected the query to reject an unknown identity')
      } catch (error) {
        expect(error).toMatchObject({ code: 'capability_target_not_found' })
        expect((error as Error).message).toContain('Discover exact')
      }
    }
  })

  test('discovers compact component configuration and expands parameters only on request', () => {
    const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:component-discovery' }))
    const plants = new Map([[plant.id, { plant } as ProcessPlantRuntimeInstance]])
    const compact = answerProcessPlantQuery({
      request: { capabilityId: 'world.process-plant.components.search', input: { plantId: plant.id, query: 'core' } },
      plants,
      objects: new Map(),
    }) as { components: ReadonlyArray<Record<string, unknown>>; totalComponents: number; matchedComponents: number }
    expect(compact.totalComponents).toBeGreaterThan(0)
    expect(compact.matchedComponents).toBeGreaterThan(0)
    expect(compact.components[0]).not.toHaveProperty('parameters')

    const expanded = answerProcessPlantQuery({
      request: { capabilityId: 'world.process-plant.components.search', input: { plantId: plant.id, componentIds: ['core'], includeParameters: true } },
      plants,
      objects: new Map(),
    }) as { components: ReadonlyArray<Record<string, unknown>> }
    expect(expanded.components).toHaveLength(1)
    expect(expanded.components[0]).toHaveProperty('parameters')
  })

  test('exposes only selectable product concepts', () => {
    const catalog = processPlantDefinitionCatalog()
    expect(catalog.models.map(entry => entry.id)).toEqual([processPlantPwrReferenceModelRef])
    expect(catalog.operatingPoints).toHaveLength(1)
    expect(catalog.automations.map(entry => entry.id)).toEqual([processPlantPwrReferenceAutomationRef])
    expect([...processPlantCatalog.credibilityEvidenceById.keys()]).toHaveLength(1)
  })

  test('answers catalog discovery without exposing implementation source files', () => {
    const request: PackRuntimeQuery = {
      capabilityId: 'world.process-plant.catalog.list',
      input: {},
    }
    const response = answerProcessPlantQuery({ request, plants: new Map(), objects: new Map() })
    expect(response).toMatchObject({
      models: [{ id: processPlantPwrReferenceModelRef }],
    })
    // Displays are generated from each Plant's model, never listed in a catalogue.
    expect(response).not.toHaveProperty('displays')
    expect(JSON.stringify(response)).not.toContain('sourcePath')
  })

  test('links Plant specification components to their behavior and calculation source', () => {
    const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:source-inspection' }))
    const request: PackRuntimeQuery = {
      capabilityId: 'world.process-plant.artifact.read',
      input: { plantId: plant.id, artifact: 'authored-spec', mode: 'full' },
    }
    const plants = new Map([[plant.id, { plant } as ProcessPlantRuntimeInstance]])
    const response = answerProcessPlantQuery({ request, plants, objects: new Map() })

    const result = response as {
      readonly components: ReadonlyArray<{
        readonly id: string
        readonly sourcePath: string | null
        readonly sourceLinks: ReadonlyArray<{
          readonly symbol: string
          readonly targetPath: string
          readonly targetLineIndex: number | null
        }>
      }>
      readonly sourceFiles: ReadonlyArray<{ readonly path: string; readonly content: string }>
    }
    const core = result.components.find(component => component.id === 'core')
    expect(core?.sourcePath).toBe('src/packs/process-plant/runtime/behaviors/reactor-behaviors.ts')
    const kineticsLink = core?.sourceLinks.find(link => link.symbol === 'reactorKineticsPowerStep')
    expect(kineticsLink).toMatchObject({
      targetPath: 'src/packs/process-plant/runtime/physics.ts',
    })
    expect(kineticsLink?.targetLineIndex).toBeGreaterThanOrEqual(0)
    expect(result.sourceFiles.find(file => file.path === core?.sourcePath)?.content)
      .toContain('reactorKineticsPowerStep')
    expect(result.sourceFiles.find(file => file.path === kineticsLink?.targetPath)?.content)
      .toContain('export const reactorKineticsPowerStep')
    expect(new Set(result.sourceFiles.map(file => file.path)).size).toBe(result.sourceFiles.length)
  })

  test('validates procedure tags in one tolerant query', () => {
    const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:procedure-tags' }))
    const request: PackRuntimeQuery = {
      capabilityId: 'world.process-plant.procedure-tags.validate',
      input: {
        plantId: plant.id,
        tags: [
          {
            id: 'PT-455',
            simPath: 'rcs.pressurizer.pressure_wr',
            units: 'psig',
            equipment: 'pressurizer',
          },
          {
            id: 'NIS-PR-AVG',
            simPath: 'nis.power_range.avg',
            units: 'percent',
            equipment: 'nuclear-instrumentation',
          },
          {
            id: 'SI-SIG',
            simPath: 'ess.si.actuation_signal',
            units: 'bool',
            equipment: 'si-system',
          },
        ],
      },
    }
    const plants = new Map([[plant.id, { plant } as ProcessPlantRuntimeInstance]])
    const response = answerProcessPlantQuery({ request, plants, objects: new Map() })

    expect(response).toMatchObject({
      plantId: plant.id,
      tags: [
        {
          id: 'PT-455',
          status: 'resolved-with-warnings',
          warnings: [
            'sim-path rcs.pressurizer.pressure_wr does not match process path pressurizer.pressureMPa',
            expect.stringContaining('Conversion from MPa to psig is unavailable'),
          ],
        },
        { id: 'NIS-PR-AVG', status: 'resolved-with-warnings', warnings: [expect.stringContaining('Conversion from MW to percent is unavailable'), expect.stringContaining('no equipment identity')] },
        { id: 'SI-SIG', status: 'missing', warnings: [] },
      ],
    })
  })

  test('paginates variable and signal discovery without losing Plant identity', () => {
    const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:paged-discovery' }))
    const runtime = createProcessPlantRuntime({ system: plant })
    const plants = new Map([[plant.id, {
      plant,
      runtime,
      ramps: createProcessPlantRampRunner({ runtime }),
      performance: createProcessPlantRuntimePerformance(),
    }]])

    const variables = answerProcessPlantQuery({
      request: { capabilityId: 'world.process-plant.variables.search', input: { plantId: plant.id, offset: 1, limit: 2 } },
      plants,
      objects: new Map(),
    }) as { total: number; offset: number; returned: number; hasMore: boolean; variables: ReadonlyArray<{ plantId: string; variable: unknown }> }
    expect(variables).toMatchObject({ offset: 1, returned: 2, hasMore: true })
    expect(variables.total).toBeGreaterThan(3)
    expect(variables.variables).toHaveLength(2)
    expect(variables.variables.every(entry => entry.plantId === plant.id)).toBe(true)

    const signals = answerProcessPlantQuery({
      request: { capabilityId: 'world.process-plant.signals.search', input: { plantId: plant.id, offset: 0, limit: 2 } },
      plants,
      objects: new Map(),
    }) as { total: number; returned: number; hasMore: boolean; signals: ReadonlyArray<{ plantId: string; signal: unknown }> }
    expect(signals).toMatchObject({ returned: 2, hasMore: true })
    expect(signals.total).toBeGreaterThan(2)
    expect(signals.signals.every(entry => entry.plantId === plant.id)).toBe(true)

    const rcpSignals = answerProcessPlantQuery({
      request: { capabilityId: 'world.process-plant.signals.search', input: { plantId: plant.id, text: 'RCP running', limit: 10 } },
      plants,
      objects: new Map(),
    }) as { signals: ReadonlyArray<{ signal: { path: string } }> }
    expect(rcpSignals.signals.map(entry => entry.signal.path)).toEqual(expect.arrayContaining([
      'rcpA.running',
      'rcpB.running',
      'rcpC.running',
    ]))
  })

  test('rejects duplicate credibility evidence contributions', () => {
    const existing = [...processPlantCatalog.credibilityEvidenceById.values()][0]
    if (existing === undefined) throw new Error('credibility evidence is required')
    expect(() => collectProcessPlantCatalog([
      { id: 'one', credibilityEvidence: [existing] },
      { id: 'two', credibilityEvidence: [existing] },
    ])).toThrow('duplicate credibility evidence id')
  })
})

describe('built-in process plant scenarios', () => {
  test('compile Plants directly from Scenario Items with no Pack configuration shadow', () => {
    const builtIns = scenarios.filter(scenario => scenario.packs.includes('process-plant' as PackId))
    expect(builtIns.map(scenario => scenario.id).sort()).toEqual([
      'halden-power-complex',
      'test-plant',
    ])

    for (const scenario of builtIns) {
      expect(scenario.packConfigs['process-plant']).toEqual({})
      const plants = scenario.initialObjects.filter(object => object.packId === 'process-plant')
      expect(plants.length).toBeGreaterThan(0)
      for (const plant of plants) {
        const data = processPlantUnitPackDataSchema.parse(plant.packData)
        expect(data.type).toBe('process-plant')
        expect(data.model.ref).toBe(processPlantPwrReferenceModelRef)
        expect(data.automation.ref).toBe(processPlantPwrReferenceAutomationRef)
        expect('plantId' in data).toBe(false)
      }
    }
  })
})
