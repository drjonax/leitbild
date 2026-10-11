import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import {
  electricGridDefinitionCatalog,
  type GridDefinitionCatalog,
  type GridModelCatalogEntry,
} from '../src/packs/electric-grid/definition-refs.ts'
import { compileGridDefinition, createGridDefinitionCompiler, gridAutomationFileReader, gridModelFileReader } from '../src/packs/electric-grid/definitions.ts'

const worldRoot = resolve(import.meta.dir, '..')

/** Grid modules in Bun's registry after importing `entry` in a fresh process. */
const gridModulesLoadedBy = async (entry: string): Promise<ReadonlyArray<string>> => {
  const script = `await import(${JSON.stringify(entry)}); console.log(JSON.stringify(Object.keys(require.cache).filter(key => key.includes('/packs/electric-grid/'))))`
  const child = Bun.spawn([process.execPath, '-e', script], { cwd: worldRoot, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (exitCode !== 0) throw new Error(`importing ${entry} failed: ${stderr}`)
  return (JSON.parse(stdout.trim().split('\n').at(-1)!) as string[]).map(key => key.slice(key.indexOf('/packs/electric-grid/') + '/packs/electric-grid/'.length))
}

const fixtureFidelity = electricGridDefinitionCatalog.models[0]!.fidelity
const fixtureBase: GridModelCatalogEntry = {
  id: 'electric-grid.test.v2-fixture',
  title: 'Grid Model v2 test fixture',
  description: 'Hand-written miniature model exercising every Grid Model v2 asset kind and cross-field rule.',
  nominalFrequencyHz: 50,
  fidelity: fixtureFidelity,
  source: { kind: 'grid-model', file: '../grid-model-v2.fixture.json', geometryFile: 'none.geometry.json' },
  assetCounts: { bus: 7, branch: 5, generator: 3, load: 2, storage: 0, connectionPoint: 1 },
  connectionPoints: [{ id: 'test-plant-unit-1', label: 'Test plant unit 1 bay', busId: 'bus:curated-test-plant-switchyard@420', nominalKv: 420, maximumExportMw: 100, maximumImportMw: 1100 }],
}
const fixtureAddition = (overrides: Partial<GridModelCatalogEntry> & Pick<GridModelCatalogEntry, 'id'> & { readonly file: string; readonly baseModelRef?: string }): GridModelCatalogEntry => ({
  title: 'Fixture addition',
  description: 'One curated switchyard tied to Hasle 420 kV.',
  nominalFrequencyHz: fixtureBase.nominalFrequencyHz,
  fidelity: fixtureBase.fidelity,
  assetCounts: { ...fixtureBase.assetCounts, bus: fixtureBase.assetCounts.bus + 1, branch: fixtureBase.assetCounts.branch + 1, connectionPoint: 2 },
  connectionPoints: [...fixtureBase.connectionPoints, { id: 'fixture-unit-420kv', label: 'Fixture unit bay', busId: 'bus:curated-fixture-switchyard@420', nominalKv: 420, maximumExportMw: 50, maximumImportMw: 900 }],
  ...overrides,
  source: { kind: 'grid-model-addition', baseModelRef: overrides.baseModelRef ?? fixtureBase.id, file: overrides.file },
})
const fixtureModels = [
  fixtureBase,
  fixtureAddition({ id: 'electric-grid.test.fixture-addition', file: 'addition-valid.grid-model-addition.json' }),
  fixtureAddition({ id: 'electric-grid.test.broken-reference', file: 'addition-broken-reference.grid-model-addition.json' }),
  fixtureAddition({ id: 'electric-grid.test.broken-syntax', file: 'addition-broken-syntax.grid-model-addition.json' }),
  fixtureAddition({ id: 'electric-grid.test.chained', file: 'addition-valid.grid-model-addition.json', baseModelRef: 'electric-grid.test.fixture-addition' }),
  fixtureAddition({ id: 'electric-grid.test.fixture-addition-drift', file: 'addition-valid.grid-model-addition.json', title: 'Drifted title' }),
]
const fixturePeak = 'electric-grid.test.v2-fixture-peak'
const fixtureCatalog = (models: ReadonlyArray<GridModelCatalogEntry>): GridDefinitionCatalog => ({
  models,
  operatingPoints: [{ id: fixturePeak, title: 'Fixture peak', description: 'Fixture peak hour.', compatibleModelRefs: models.map(model => model.id), source: { kind: 'operating-point', file: 'v2-fixture-peak.operating-point.json' } }],
  automations: electricGridDefinitionCatalog.automations.map(automation => ({ ...automation, compatibleModelRefs: models.map(model => model.id) })),
})
const fixtureCompiler = () => {
  const reads: string[] = []
  const read = gridModelFileReader(new URL('./fixtures/electric-grid/', import.meta.url))
  const compiler = createGridDefinitionCompiler({ catalog: fixtureCatalog(fixtureModels), readModelFile: file => { reads.push(file); return read(file) }, readAutomationFile: gridAutomationFileReader })
  return { compiler, reads }
}
const definitionFor = (modelRef: string, operatingPointRef = fixturePeak) => ({
  id: 'grid:catalog-test',
  model: { ref: modelRef },
  operatingPoint: { ref: operatingPointRef },
  automation: { ref: 'electric-grid.frequency.nordic-2025' },
})

describe('Electric Grid definition catalog', () => {
  test('importing the World assembly loads no Grid model data and compiles no model', async () => {
    const loaded = await gridModulesLoadedBy('./src/app-assembly.ts')
    expect(loaded).toContain('definition-refs.ts')
    expect(loaded).toContain('pack.ts')
    expect(loaded.filter(module => module === 'definitions.ts' || module.startsWith('models/'))).toEqual([])
  })

  test('describes every built-in model with the metadata its loaded data has', () => {
    for (const entry of electricGridDefinitionCatalog.models) {
      const compiled = compileGridDefinition(definitionFor(entry.id, electricGridDefinitionCatalog.operatingPoints[0]!.id))
      expect(compiled.model.title).toBe(entry.title)
      expect(compiled.model.connectionPoints).toEqual([...entry.connectionPoints])
      expect(compiled.index.diagnostics.assetCount).toBe(entry.assetCounts.bus + entry.assetCounts.branch + entry.assetCounts.generator + entry.assetCounts.load + entry.assetCounts.storage)
    }
    const ids = [...electricGridDefinitionCatalog.models, ...electricGridDefinitionCatalog.operatingPoints, ...electricGridDefinitionCatalog.automations].map(entry => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('reads an addition on first use only, then serves it from the per-id cache', () => {
    const { compiler, reads } = fixtureCompiler()
    expect(reads).toEqual([])
    const first = compiler.compile(definitionFor('electric-grid.test.fixture-addition'))
    const second = compiler.compile({ ...definitionFor('electric-grid.test.fixture-addition'), id: 'grid:second' })
    expect(reads).toEqual(['addition-valid.grid-model-addition.json', '../grid-model-v2.fixture.json', 'v2-fixture-peak.operating-point.json'])
    expect(second.model).toBe(first.model)
    expect(first.model.connectionPoints.map(point => point.id)).toEqual(['test-plant-unit-1', 'fixture-unit-420kv'])
    expect(second.definitionDigest).toBe(first.definitionDigest)
  })

  test('fails the load, not the import, for a malformed addition, naming its file and JSON path', () => {
    const { compiler } = fixtureCompiler()
    expect(() => compiler.compile(definitionFor('electric-grid.test.broken-reference')))
      .toThrow(/addition-broken-reference\.grid-model-addition\.json: invalid Grid Model Addition v2\n {2}\$\.branches\[0\]\.toBusId: /)
    expect(() => compiler.compile(definitionFor('electric-grid.test.broken-syntax'))).toThrow(/addition-broken-syntax\.grid-model-addition\.json: invalid JSON/)
    expect(compiler.compile(definitionFor(fixtureBase.id)).model.id).toBe(fixtureBase.id)
  })

  test('validates per-asset Operating Point overrides and applies each to its asset only', () => {
    const { compiler } = fixtureCompiler()
    const definition = definitionFor('electric-grid.test.fixture-addition')
    const withOverrides = (overrides: object) => ({ ...definition, operatingPoint: { ...definition.operatingPoint, overrides } })
    const opened = compiler.compile(withOverrides({ branchStates: [{ assetId: 'branch:curated-fixture-hasle', state: 'open' }] }))
    expect(opened.operatingPoint.branchStates.filter(entry => entry.state === 'open' || entry.availability < 1)).toEqual([{ branchId: 'branch:curated-fixture-hasle', state: 'open', availability: 1 }])
    expect(() => compiler.compile(withOverrides({ branchStates: [{ assetId: 'branch:curated-fixture-missing', state: 'open' }] })))
      .toThrow('unknown branch branch:curated-fixture-missing')
    expect(compiler.compile(withOverrides({ branchStates: [], loadScale: 0.9 })).operatingPoint.loadScale).toBe(0.9)
    // A generator state override replaces the Operating Point's entry for that unit only.
    const offline = compiler.compile(withOverrides({ generatorStates: [{ assetId: 'generator:nve-hydro-123', state: 'offline', availableMw: 100 }] }))
    expect(offline.model.generators.find(generator => generator.id === 'generator:nve-hydro-123')).toMatchObject({ initialState: 'offline', availableMw: 100 })
    expect(offline.model.generators.filter(generator => generator.initialState === 'online')).toHaveLength(2)
    expect(offline.definitionDigest).not.toBe(compiler.compile(definition).definitionDigest)
  })

  test('keeps additions one level and the catalog in step with the data', () => {
    const { compiler } = fixtureCompiler()
    expect(() => compiler.compile(definitionFor('electric-grid.test.chained'))).toThrow('base electric-grid.test.fixture-addition is itself a Model Addition')
    expect(() => compiler.compile(definitionFor('electric-grid.test.fixture-addition-drift'))).toThrow('$.id electric-grid.test.fixture-addition must be the catalog id')
    const drifted = createGridDefinitionCompiler({
      catalog: fixtureCatalog([fixtureBase, fixtureAddition({ id: 'electric-grid.test.fixture-addition', file: 'addition-valid.grid-model-addition.json', title: 'Drifted title' })]),
      readModelFile: gridModelFileReader(new URL('./fixtures/electric-grid/', import.meta.url)),
      readAutomationFile: gridAutomationFileReader,
    })
    expect(() => drifted.compile(definitionFor('electric-grid.test.fixture-addition'))).toThrow('catalog title "Drifted title" does not describe the loaded model')
    expect(() => createGridDefinitionCompiler({ catalog: fixtureCatalog([fixtureBase, fixtureBase]), readModelFile: () => null, readAutomationFile: () => null })).toThrow('duplicate Grid Model in the Grid catalog')
    expect(() => compiler.compile(definitionFor('electric-grid.test.missing'))).toThrow('unknown Grid Model: electric-grid.test.missing')
  })
})
