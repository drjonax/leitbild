#!/usr/bin/env bun
// Builds the normalised grid-norway sidecar GeoJSON from a pinned OSM PBF, without building tiles.
// Usage: bun run scripts/electric-grid/build-osm-power-sidecar.ts --pbf <file.osm.pbf> --sha256 <hex> --out <new dir>
// Writes <out>/grid-norway.features.geojson and <out>/grid-norway.sidecar-manifest.json; refuses to overwrite.
import { mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { gridNorwayDatasetId, gridNorwayOsmSourceId } from '../../src/packs/electric-grid/datasets/grid-norway.ts'
import {
  gridReferenceCategorySchema,
  gridReferenceFeatureSchema,
  gridReferenceSidecarManifestSchema,
  type GridReferenceCategory,
  type GridReferenceSidecarManifest,
} from '../../src/packs/electric-grid/schemas/grid-reference.ts'
import { extractPinnedOsmPower, snapshotOfInspection } from '../../src/packs/electric-grid/sources/osm-pbf-power.ts'
import { osmOdbl } from '../../src/reference-data/licences.ts'
import type { FeatureCollection } from '../../src/reference-data/types.ts'

interface Args {
  readonly pbf: string
  readonly sha256: string
  readonly out: string
}

const parseArgs = (argv: ReadonlyArray<string>): Args => {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]!
    const value = argv[index + 1]
    if (!['--pbf', '--sha256', '--out'].includes(flag) || value === undefined) {
      throw new Error(`usage: --pbf <file.osm.pbf> --sha256 <hex> --out <new dir> (unexpected "${flag}")`)
    }
    values.set(flag, value)
  }
  const required = (flag: string): string => {
    const value = values.get(flag)
    if (value === undefined) throw new Error(`${flag} is required`)
    return value
  }
  return { pbf: resolve(required('--pbf')), sha256: required('--sha256').toLowerCase(), out: resolve(required('--out')) }
}

const gitOutput = (args: ReadonlyArray<string>): string => {
  const result = Bun.spawnSync(['git', ...args], { cwd: import.meta.dir, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString().trim()}`)
  return result.stdout.toString().trim()
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

const writeAtomically = async (path: string, contents: string): Promise<void> => {
  const temporary = `${path}.tmp.${process.pid}`
  await writeFile(temporary, contents)
  await rename(temporary, path)
}

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2))
  const sidecarName = `${String(gridNorwayDatasetId)}.features.geojson`
  const manifestName = `${String(gridNorwayDatasetId)}.sidecar-manifest.json`
  const sidecarPath = join(args.out, sidecarName)
  const manifestPath = join(args.out, manifestName)
  for (const path of [sidecarPath, manifestPath]) {
    if (await exists(path)) throw new Error(`${path} already exists; sidecar builds are immutable`)
  }

  const { inspection, extraction } = await extractPinnedOsmPower(
    args.pbf,
    { kind: 'sha256', sha256: args.sha256 },
    gridNorwayOsmSourceId,
  )

  const featureCounts = Object.fromEntries(gridReferenceCategorySchema.options.map(category => [category, 0])) as Record<GridReferenceCategory, number>
  for (const feature of extraction.features) {
    const parsed = gridReferenceFeatureSchema.safeParse(feature.properties)
    if (!parsed.success) throw new Error(`feature ${feature.id ?? '<no id>'} fails the grid reference schema: ${parsed.error.message}`)
    featureCounts[parsed.data.category] += 1
  }

  const collection: FeatureCollection = { type: 'FeatureCollection', features: extraction.features }
  const sidecarText = JSON.stringify(collection)
  const sidecarBytes = new TextEncoder().encode(sidecarText)
  const repositoryRoot = gitOutput(['rev-parse', '--show-toplevel'])
  const snapshot = snapshotOfInspection(inspection)
  const manifest: GridReferenceSidecarManifest = gridReferenceSidecarManifestSchema.parse({
    kind: 'grid-norway-osm-sidecar',
    builtAt: new Date().toISOString(),
    generator: {
      script: relative(repositoryRoot, import.meta.path),
      commit: gitOutput(['rev-parse', 'HEAD']),
      workingTreeClean: gitOutput(['status', '--porcelain']) === '',
    },
    source: {
      id: gridNorwayOsmSourceId,
      snapshot,
      osmHeader: {
        writingProgram: inspection.header.writingProgram,
        source: inspection.header.source,
        replicationSequenceNumber: inspection.header.replicationSequenceNumber,
        replicationBaseUrl: inspection.header.replicationBaseUrl,
      },
      licence: { id: String(osmOdbl.id), attribution: osmOdbl.attribution, url: osmOdbl.url },
    },
    sidecar: {
      path: sidecarName,
      sha256: new Bun.CryptoHasher('sha256').update(sidecarBytes).digest('hex'),
      byteLength: sidecarBytes.byteLength,
      featureCount: extraction.features.length,
    },
    featureCounts,
    ledger: extraction.ledger,
  })

  await mkdir(args.out, { recursive: true })
  await writeAtomically(sidecarPath, sidecarText)
  await writeAtomically(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`wrote ${extraction.features.length} features to ${sidecarPath}`)
  console.log(JSON.stringify({ featureCounts, ledger: extraction.ledger }, null, 2))
}

await main()
