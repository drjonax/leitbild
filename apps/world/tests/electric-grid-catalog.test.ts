import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import {
  electricGridDefinitionCatalog,
  type GridDefinitionCatalog,
  type GridModelCatalogEntry,
} from '../src/packs/electric-grid/definition-refs.ts'
import { compileGridDefinition, createGridDefinitionCompiler, gridModelFileReader } from '../src/packs/electric-grid/definitions.ts'

const worldRoot = resolve(import.meta.dir, '..')

/** Grid modules in Bun's registry after importing `entry` in a fresh process. */
const gridModulesLoadedBy = async (entry: string): Promise<ReadonlyArray<string>> => {
  const script = `await import(${JSON.stringify(entry)}); console.log(JSON.stringify(Object.keys(require.cache).filter(key => key.includes('/packs/electric-grid/'))))`
  const child = Bun.spawn([process.execPath, '-e', script], { cwd: worldRoot, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (exitCode !== 0) throw new Error(`importing ${entry} failed: ${stderr}`)
  return (JSON.parse(stdout.trim().split('\n').at(-1)!) as string[]).map(key => key.slice(key.indexOf('/packs/electric-grid/') + '/packs/electric-grid/'.length))
}

const norway = electricGridDefinitionCatalog.models.find(model => model.source.kind === 'norway-source-data-v1')!
const fixtureAddition = (overrides: Partial<GridModelCatalogEntry> & Pick<GridModelCatalogEntry, 'id'> & { readonly file: string; readonly baseModelRef?: string }): GridModelCatalogEntry => ({
  title: 'Fixture addition',
  description: 'One curated switchyard tied to Hasle 420 kV.',
  nominalFrequencyHz: norway.nominalFrequencyHz,
  fidelity: norway.fidelity,
  assetCounts: { ...norway.assetCounts, bus: norway.assetCounts.bus + 1, branch: norway.assetCounts.branch + 1, connectionPoint: 1 },
  connectionPoints: [{ id: 'fixture-unit-420kv', label: 'Fixture unit bay', busId: 'bus:fixture-switchyard-420', nominalKv: 420, maximumExportMw: 50, maximumImportMw: 900 }],
  ...overrides,
  source: { kind: 'addition-v1', baseModelRef: overrides.baseModelRef ?? norway.id, file: overrides.file },
})
const fixtureModels = [
  norway,
  fixtureAddition({ id: 'electric-grid.test.fixture-addition', file: 'addition-valid.grid-model.json' }),
  fixtureAddition({ id: 'electric-grid.test.broken-reference', file: 'addition-broken-reference.grid-model.json' }),
  fixtureAddition({ id: 'electric-grid.test.broken-syntax', file: 'addition-broken-syntax.grid-model.json' }),
  fixtureAddition({ id: 'electric-grid.test.chained', file: 'addition-valid.grid-model.json', baseModelRef: 'electric-grid.test.fixture-addition' }),
  fixtureAddition({ id: 'electric-grid.test.fixture-addition-drift', file: 'addition-valid.grid-model.json', title: 'Drifted title' }),
]
const fixtureCatalog = (models: ReadonlyArray<GridModelCatalogEntry>): GridDefinitionCatalog => ({
  models,
  operatingPoints: electricGridDefinitionCatalog.operatingPoints.map(point => ({ ...point, compatibleModelRefs: models.map(model => model.id) })),
  automations: electricGridDefinitionCatalog.automations.map(automation => ({ ...automation, compatibleModelRefs: models.map(model => model.id) })),
})
const fixtureCompiler = () => {
  const reads: string[] = []
  const read = gridModelFileReader(new URL('./fixtures/electric-grid/', import.meta.url))
  const compiler = createGridDefinitionCompiler({ catalog: fixtureCatalog(fixtureModels), readModelFile: file => { reads.push(file); return read(file) } })
  return { compiler, reads }
}
const definitionFor = (modelRef: string) => ({
  id: 'grid:catalog-test',
  model: { ref: modelRef },
  operatingPoint: { ref: 'electric-grid.norway.normal' },
  automation: { ref: 'electric-grid.norway.standard' },
})

describe('Electric Grid definition catalog', () => {
  test('importing the World assembly loads no Grid model data and compiles no model', async () => {
    const loaded = await gridModulesLoadedBy('./src/app-assembly.ts')
    expect(loaded).toContain('definition-refs.ts')
    expect(loaded).toContain('pack.ts')
    expect(loaded.filter(module => module === 'definitions.ts' || module === 'model-additions.ts' || module.startsWith('models/'))).toEqual([])
  })

  test('describes every built-in model with the metadata its loaded data has', () => {
    for (const entry of electricGridDefinitionCatalog.models) {
      const compiled = compileGridDefinition(definitionFor(entry.id))
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
    expect(reads).toEqual(['addition-valid.grid-model.json'])
    expect(second.model).toBe(first.model)
    expect(first.model.connectionPoints.map(point => point.id)).toEqual(['fixture-unit-420kv'])
    expect(second.definitionDigest).toBe(first.definitionDigest)
  })

  test('fails the load, not the import, for a malformed addition, naming its file and JSON path', () => {
    const { compiler } = fixtureCompiler()
    expect(() => compiler.compile(definitionFor('electric-grid.test.broken-reference')))
      .toThrow(/addition-broken-reference\.grid-model\.json: invalid Grid Model Addition\n {2}\$\.branches\[0\]\.toBusId: unknown bus NO-RENAMED-BUS-420/)
    expect(() => compiler.compile(definitionFor('electric-grid.test.broken-syntax'))).toThrow(/addition-broken-syntax\.grid-model\.json: invalid JSON/)
    expect(compiler.compile(definitionFor('electric-grid.norway.transmission')).model.id).toBe('electric-grid.norway.transmission')
  })

  test('keeps additions one level and the catalog in step with the data', () => {
    const { compiler } = fixtureCompiler()
    expect(() => compiler.compile(definitionFor('electric-grid.test.chained'))).toThrow('base electric-grid.test.fixture-addition is itself a Model Addition')
    expect(() => compiler.compile(definitionFor('electric-grid.test.fixture-addition-drift'))).toThrow('$.id electric-grid.test.fixture-addition must be the catalog id')
    const drifted = createGridDefinitionCompiler({
      catalog: fixtureCatalog([norway, fixtureAddition({ id: 'electric-grid.test.fixture-addition', file: 'addition-valid.grid-model.json', title: 'Drifted title' })]),
      readModelFile: gridModelFileReader(new URL('./fixtures/electric-grid/', import.meta.url)),
    })
    expect(() => drifted.compile(definitionFor('electric-grid.test.fixture-addition'))).toThrow('catalog title "Drifted title" does not describe the loaded model')
    expect(() => createGridDefinitionCompiler({ catalog: fixtureCatalog([norway, norway]), readModelFile: () => null })).toThrow('duplicate Grid Model in the Grid catalog')
    expect(() => compiler.compile(definitionFor('electric-grid.test.missing'))).toThrow('unknown Grid Model: electric-grid.test.missing')
  })
})
