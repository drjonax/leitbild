// Audits a Grid Model v2 against the reviewed golden list and curations, prints the report, and exits
// non-zero unless every check passes. --model names a catalog model (composed when it is a Model
// Addition); --model-file reads a generated Grid Model v2 JSON file. The default is the catalog's
// Norway transmission model.
//
//   bun run scripts/electric-grid/audit-grid-model.ts [--model <ref> | --model-file <v2 .grid-model.json>] [--sidecar <grid-norway.features.geojson>]
//     [--ledger <v2 .ledger.json>: station members for footprints; required with --sidecar]
//     [--nve <Nettanlegg5 transmission layer .geojson>]... [--as-of YYYY-MM-DD] [--json <report.json>]
//     [--golden <file>] [--curations <file>] [--show <failures per check>]
//
// Exit codes: 0 pass, 1 fail or incomplete, 2 invalid invocation or input.
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { gridModelV2 } from '../../src/packs/electric-grid/definitions.ts'
import { electricGridDefinitionCatalog, norwayGridModelRef } from '../../src/packs/electric-grid/definition-refs.ts'
import { gridGoldenSchema } from '../../src/packs/electric-grid/schemas/grid-golden.ts'
import { gridCurationCollectionSchema } from '../../src/packs/electric-grid/schemas/grid-curation.ts'
import { nveLinesFromGeoJson, referenceGeometryFromSidecar } from '../../src/packs/electric-grid/audit/audit-inputs.ts'
import { auditGridTopology } from '../../src/packs/electric-grid/audit/grid-audit.ts'
import type { GridAuditReport } from '../../src/packs/electric-grid/audit/audit-report.ts'
import type { NveLine } from '../../src/packs/electric-grid/audit/nve-coverage.ts'
import { auditGraphFromGridModelV2, type StationTerminals } from '../../src/packs/electric-grid/audit/v2-adapter.ts'
import { validateGridModel } from '../../src/packs/electric-grid/schemas/grid-model.ts'

const modelsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/packs/electric-grid/models')

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(resolve(path), 'utf8')) as unknown

const usage = (message: string): never => {
  console.error(`audit-grid-model: ${message}`)
  process.exit(2)
}

const catalogModel = (modelRef: string) => {
  if (!electricGridDefinitionCatalog.models.some(model => model.id === modelRef)) {
    return usage(`unknown Grid Model ${modelRef}; known: ${electricGridDefinitionCatalog.models.map(model => model.id).join(', ')}`)
  }
  return gridModelV2(modelRef)
}

const printReport = (report: GridAuditReport, show: number, asOfSource: string): void => {
  console.log(`Grid audit ${report.modelId} (${report.modelKind}) against ${report.goldenId}, as of ${report.asOf} (${asOfSource})`)
  console.log(`  ${report.counts.buses} buses, ${report.counts.branches} branches, ${report.counts.hvdcLinks} HVDC links, ${report.counts.generators} generators, ${report.counts.loads} loads; NVE coverage oracle ${report.oracles.nveCoverage}`)
  for (const check of report.checks) {
    console.log(`\n[${check.status.toUpperCase()}] ${check.id}: ${check.summary}`)
    if (check.unmeasured !== undefined) console.log(`  unmeasured: ${check.unmeasured}`)
    for (const failure of check.failures.slice(0, show)) console.log(`  - ${failure.message}`)
    if (check.failures.length > show) console.log(`  … ${check.failures.length - show} more failures (write them with --json)`)
  }
  console.log(`\nVERDICT: ${report.verdict.toUpperCase()}`)
}

const ledgerStationsSchema = z.object({
  stationTerminals: z.record(z.string(), z.object({
    featureIds: z.array(z.string().min(1)),
    junctionPoints: z.array(z.tuple([z.number().finite(), z.number().finite()])),
  }).strict()),
})

// The build audits footprints of the stations the topology unified; the CLI reads them from the build ledger.
const stationTerminalsOf = async (ledger: string | undefined, withSidecar: boolean): Promise<StationTerminals> => {
  if (ledger === undefined) return withSidecar ? usage('--ledger is required with --sidecar (station footprints)') : {}
  return ledgerStationsSchema.parse(await readJson(ledger)).stationTerminals
}

const main = async (): Promise<void> => {
  const { values } = parseArgs({
    options: {
      model: { type: 'string' },
      'model-file': { type: 'string' },
      sidecar: { type: 'string' },
      ledger: { type: 'string' },
      nve: { type: 'string', multiple: true },
      'as-of': { type: 'string' },
      json: { type: 'string' },
      golden: { type: 'string', default: resolve(modelsDirectory, 'norway-grid-golden.json') },
      curations: { type: 'string', default: resolve(modelsDirectory, 'norway-grid-curations.geojson') },
      show: { type: 'string', default: '12' },
    },
    strict: true,
    allowPositionals: false,
  })
  const show = Number(values.show)
  if (!Number.isInteger(show) || show < 0) usage(`--show must be a non-negative integer, got ${values.show}`)
  const asOf = values['as-of'] ?? new Date().toISOString().slice(0, 10)
  const asOfSource = values['as-of'] === undefined ? 'system clock' : 'argument'
  const golden = gridGoldenSchema.parse(await readJson(values.golden))
  const curations = gridCurationCollectionSchema.parse(await readJson(values.curations))
  const reference = values.sidecar === undefined ? undefined : referenceGeometryFromSidecar(await readJson(values.sidecar))
  let nveLines: NveLine[] | undefined
  for (const path of values.nve ?? []) {
    const parsed = nveLinesFromGeoJson(await readJson(path))
    if (parsed.withoutVoltage > 0) console.log(`NVE input ${path}: ${parsed.withoutVoltage} features without a voltage are not compared`)
    nveLines = [...(nveLines ?? []), ...parsed.lines]
  }
  if (values.model !== undefined && values['model-file'] !== undefined) usage('give either --model or --model-file, not both')
  const modelFile = values['model-file']
  const model = modelFile === undefined ? catalogModel(values.model ?? norwayGridModelRef) : validateGridModel(await readJson(modelFile), modelFile)
  const graph = auditGraphFromGridModelV2(model, reference, await stationTerminalsOf(values.ledger, reference !== undefined))
  const report = auditGridTopology(graph, golden, { asOf, curations, ...(nveLines === undefined ? {} : { nveLines }) })
  printReport(report, show, asOfSource)
  if (values.json !== undefined) {
    await writeFile(resolve(values.json), `${JSON.stringify(report, null, 2)}\n`)
    console.log(`report written to ${resolve(values.json)}`)
  }
  process.exit(report.verdict === 'pass' ? 0 : 1)
}

await main()
