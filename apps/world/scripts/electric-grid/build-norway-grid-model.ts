// Builds the Norway Grid Model v2 and its companions from explicit inputs, audits it, and writes
// the generated files. Building twice from the same inputs writes byte-identical files.
//
//   bun run scripts/electric-grid/build-norway-grid-model.ts \
//     --sidecar <builds/osm-YYYYMMDD/grid-norway.features.geojson> --sidecar-sha256 <hex> \
//     --snapshots <Leitbild-grid-data/snapshots> --snapshot-date YYYYMMDD \
//     --curations <norway-grid-curations.geojson> --interconnectors <norway-interconnectors.json> \
//     --major-sites <norway-major-sites.json> --reference-dispatch <norway-reference-dispatch.json>
//     --population <snapshots/ssb-population-grid/YYYYMMDD/population-cells.json> \
//     --hydro-heads <snapshots/nve-hydro-heads/YYYYMMDD/hydro-heads.json> \
//     --coastline <coastline.json from snapshot-osm-coastline.ts, of the sidecar's PBF> \
//     --continuations <norway-interconnector-continuations.json from snapshot-interconnector-continuations.ts> [--out <directory>]
//
// The sidecar manifest is read from beside the sidecar. Exit codes: 0 built and audit passed,
// 1 built but the audit did not pass, 2 invalid invocation or input.
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { auditGridTopology } from '../../src/packs/electric-grid/audit/grid-audit.ts'
import { referenceGeometryFromSidecar } from '../../src/packs/electric-grid/audit/audit-inputs.ts'
import { auditGraphFromGridModelV2 } from '../../src/packs/electric-grid/audit/v2-adapter.ts'
import {
  biddingZoneSnapshotSchema,
  buildFileSchemas,
  coastlineSnapshotSchema,
  hydroSnapshotSchema,
  municipalitySnapshotSchema,
  hydroHeadsSnapshotSchema,
  populationSnapshotSchema,
  referenceHoursSnapshotSchema,
  sidecarManifestSchema,
  weekProfileSnapshotSchema,
  windSnapshotSchema,
  type BuildFile,
  type NorwayModelBuildInputs,
} from '../../src/packs/electric-grid/model-build/inputs.ts'
import { jsonLines } from '../../src/packs/electric-grid/model-build/json-lines.ts'
import { buildNorwayGridModel } from '../../src/packs/electric-grid/model-build/norway-model.ts'
import { gridGoldenSchema } from '../../src/packs/electric-grid/schemas/grid-golden.ts'
import type { z } from 'zod'

const modelsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/packs/electric-grid/models')

const usage = (message: string): never => {
  console.error(`build-norway-grid-model: ${message}`)
  process.exit(2)
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

const readBytes = async (path: string): Promise<Uint8Array> => {
  try {
    return new Uint8Array(await readFile(path))
  } catch (error) {
    return usage(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const readValidated = async <Schema extends z.ZodType>(path: string, schema: Schema): Promise<BuildFile<z.infer<Schema>>> => {
  const bytes = await readBytes(path)
  const parsed = schema.safeParse(JSON.parse(new TextDecoder().decode(bytes)) as unknown)
  if (!parsed.success) return usage(`${path}: ${parsed.error.issues.slice(0, 5).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
  return { sha256: sha256(bytes), data: parsed.data }
}

const main = async (): Promise<void> => {
  const { values } = parseArgs({
    options: {
      sidecar: { type: 'string' },
      'sidecar-sha256': { type: 'string' },
      snapshots: { type: 'string' },
      'snapshot-date': { type: 'string' },
      curations: { type: 'string' },
      interconnectors: { type: 'string' },
      'major-sites': { type: 'string' },
      'reference-dispatch': { type: 'string' },
      population: { type: 'string' },
      'hydro-heads': { type: 'string' },
      coastline: { type: 'string' },
      continuations: { type: 'string' },
      golden: { type: 'string', default: join(modelsDirectory, 'norway-grid-golden.json') },
      out: { type: 'string', default: modelsDirectory },
    },
    strict: true,
    allowPositionals: false,
  })
  const required = (name: keyof typeof values): string => values[name] ?? usage(`--${name} is required`)
  const sidecarPath = resolve(required('sidecar'))
  const expectedSha = required('sidecar-sha256')
  const snapshotDate = required('snapshot-date')
  if (!/^\d{8}$/.test(snapshotDate)) usage(`--snapshot-date must be YYYYMMDD, got ${snapshotDate}`)
  const snapshots = resolve(required('snapshots'))
  const snapshot = (source: string, file: string): string => join(snapshots, source, snapshotDate, file)
  const started = performance.now()

  const sidecarBytes = await readBytes(sidecarPath)
  const sidecarSha = sha256(sidecarBytes)
  if (sidecarSha !== expectedSha) usage(`${sidecarPath} has SHA-256 ${sidecarSha}, expected ${expectedSha}`)
  const manifestPath = join(dirname(sidecarPath), 'grid-norway.sidecar-manifest.json')
  const manifest = sidecarManifestSchema.parse(JSON.parse(new TextDecoder().decode(await readBytes(manifestPath))) as unknown)
  if (manifest.sidecar.path !== basename(sidecarPath)) usage(`${manifestPath} describes ${manifest.sidecar.path}, not ${basename(sidecarPath)}`)
  const sidecarJson = JSON.parse(new TextDecoder().decode(sidecarBytes)) as unknown

  const inputs: NorwayModelBuildInputs = {
    sidecar: { sha256: sidecarSha, data: sidecarJson },
    sidecarManifest: manifest,
    snapshotDate: `${snapshotDate.slice(0, 4)}-${snapshotDate.slice(4, 6)}-${snapshotDate.slice(6, 8)}`,
    hydro: await readValidated(snapshot('nve-generation', 'hydro-plants.json'), hydroSnapshotSchema),
    wind: await readValidated(snapshot('nve-generation', 'wind-farms.json'), windSnapshotSchema),
    biddingZones: await readValidated(snapshot('nve-nettomraader', 'bidding-zones.json'), biddingZoneSnapshotSchema),
    municipalities: await readValidated(snapshot('kartverket-kommuneinfo', 'municipalities.json'), municipalitySnapshotSchema),
    referenceHours: await readValidated(snapshot('elhub', 'reference-hours.json'), referenceHoursSnapshotSchema),
    winterWeek: await readValidated(snapshot('elhub', 'profile-winter-week.json'), weekProfileSnapshotSchema),
    summerWeek: await readValidated(snapshot('elhub', 'profile-summer-week.json'), weekProfileSnapshotSchema),
    curations: await readValidated(resolve(required('curations')), buildFileSchemas.curations),
    interconnectors: await readValidated(resolve(required('interconnectors')), buildFileSchemas.interconnectors),
    majorSites: await readValidated(resolve(required('major-sites')), buildFileSchemas.majorSites),
    referenceDispatch: await readValidated(resolve(required('reference-dispatch')), buildFileSchemas.referenceDispatch),
    population: await readValidated(resolve(required('population')), populationSnapshotSchema),
    hydroHeads: await readValidated(resolve(required('hydro-heads')), hydroHeadsSnapshotSchema),
    coastline: await readValidated(resolve(required('coastline')), coastlineSnapshotSchema),
    continuations: await readValidated(resolve(required('continuations')), buildFileSchemas.continuations),
  }
  const read = performance.now()
  const built = buildNorwayGridModel(inputs)
  const compiled = performance.now()

  const golden = gridGoldenSchema.parse(JSON.parse(await readFile(resolve(values.golden), 'utf8')) as unknown)
  const report = auditGridTopology(auditGraphFromGridModelV2(built.model, referenceGeometryFromSidecar(sidecarJson), built.ledger.stationTerminals), golden, {
    asOf: inputs.snapshotDate,
    curations: inputs.curations.data,
  })
  const audited = performance.now()

  const out = resolve(values.out)
  const files: ReadonlyArray<readonly [string, string]> = [
    ['norway-transmission.grid-model.json', jsonLines(built.model, 1)],
    ['norway-transmission.ledger.json', jsonLines(built.ledger, 1)],
    ['norway-transmission.audit.json', `${JSON.stringify(report, null, 1)}\n`],
    ['norway-transmission.geometry.json', jsonLines(built.geometry, 1)],
    ['norway-load-profiles.json', `${JSON.stringify(built.profiles)}\n`],
    ['norway-winter-weekday-peak.operating-point.json', jsonLines(built.operatingPoints.winter, 1)],
    ['norway-summer-night-low.operating-point.json', jsonLines(built.operatingPoints.summer, 1)],
    ['halden-four-unit.grid-model-addition.json', jsonLines(built.haldenAddition, 1)],
    ['halden-four-unit.geometry.json', jsonLines(built.haldenGeometry, 1)],
  ]
  for (const [name, text] of files) await writeFile(join(out, name), text)
  const written = performance.now()

  const model = built.model
  console.log(`built ${model.id} ${model.sourceBuild.id}: ${model.buses.length} buses, ${model.branches.length} branches, ${model.hvdcLinks.length} HVDC links, ${model.externalSystems.length} external systems, ${model.generators.length} generators, ${model.loads.length} loads, ${model.shunts.length} shunts`)
  console.log(`time: read ${((read - started) / 1000).toFixed(2)} s, build ${((compiled - read) / 1000).toFixed(2)} s, audit ${((audited - compiled) / 1000).toFixed(2)} s, write ${((written - audited) / 1000).toFixed(2)} s`)
  for (const [name, text] of files) console.log(`  ${name}: ${(Buffer.byteLength(text) / 1024).toFixed(1)} KiB`)
  for (const route of built.continuations) console.log(`continued ${route.interconnectorId}: ${route.osmWayIds.length} ways abroad to ${route.station.name ?? route.station.osmId} (${route.station.osmId})${route.station.namedInTable ? '' : ', not the station the interconnector table names'}`)
  for (const route of built.haldenRoutes) console.log(`designed route ${route.id}: ${route.corridorKm} km along ${route.corridorIds.length} corridors, ${route.spurKm} km of spur`)
  for (const check of report.checks) console.log(`[${check.status.toUpperCase()}] ${check.id}: ${check.summary}`)
  console.log(`audit verdict: ${report.verdict.toUpperCase()}`)
  process.exit(report.verdict === 'pass' ? 0 : 1)
}

await main()
