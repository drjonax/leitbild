import { mkdir, readFile, rename, symlink, rm, writeFile, lstat, readdir, readlink } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { assertKnownLicence } from './licences.ts'
import { composeDatasetManifest, writeAuditReport, writeDatasetManifest, type AuditReport } from './manifest-writer.ts'
import { parseManualSource } from './sources/manual.ts'
import { buildTiles, type TippecanoeRunner } from './tippecanoe.ts'
import {
  asBuildId,
  asIso8601,
  type BuildId,
  type DatasetConfig,
  type DatasetSource,
  type FeatureCollection,
  type FetchCache,
  type LocalSourceLoad,
  type NormalizedFeature,
  type RawBytes,
  type SourceSnapshot,
} from './types.ts'

// buildDataset:
//   loadSources -> validate -> audit -> write sidecar GeoJSON -> build tiles -> write manifest -> write audit report
// promoteBuild:
//   atomic symlink swap releases/<id>/current -> builds/<id>/<buildId>

export interface BuildEnvironment {
  readonly referenceRoot: string
  readonly fetchCache: FetchCache
  readonly tippecanoeBinary?: string
  readonly tippecanoeRunner?: TippecanoeRunner
  readonly skipTileBuild?: boolean
  readonly now?: () => Date
}

export interface BuildOutcome {
  readonly buildId: BuildId
  readonly buildDir: string
  readonly featureCount: number
}

const generateBuildId = (now: Date): BuildId => {
  const stamp = now.toISOString().replace(/[-:.]/g, '').replace('T', '-').slice(0, 15)
  return asBuildId(stamp)
}

const snapshotOfBytes = (origin: string, bytes: RawBytes): SourceSnapshot => ({
  origin,
  sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex'),
  byteLength: bytes.byteLength,
  dataTimestamp: null,
})

const loadSource = async (source: DatasetSource, fetchCache: FetchCache): Promise<LocalSourceLoad> => {
  if (source.kind === 'manual') {
    const bytes = await readFile(source.path)
    return { features: parseManualSource(bytes.toString('utf8')), snapshot: snapshotOfBytes(source.path, bytes) }
  }
  if (source.kind === 'local') {
    return source.load(fetchCache)
  }
  const raw = await source.fetch(fetchCache)
  return { features: await source.parse(raw), snapshot: snapshotOfBytes(String(source.id), raw) }
}

const validateFeatures = <P>(
  features: ReadonlyArray<NormalizedFeature>,
  config: DatasetConfig<P>,
): { readonly errors: string[]; readonly accepted: NormalizedFeature[] } => {
  const errors: string[] = []
  const accepted: NormalizedFeature[] = []
  const maxReport = 20
  for (let i = 0; i < features.length; i++) {
    const feature = features[i]!
    const parsed = config.featureSchema.safeParse(feature.properties)
    if (!parsed.success) {
      if (errors.length < maxReport) {
        const id = feature.id ?? `<index ${i}>`
        errors.push(`feature ${id}: ${parsed.error.message}`)
      }
      continue
    }
    accepted.push(feature)
  }
  return { errors, accepted }
}

const writeSidecar = async (path: string, features: ReadonlyArray<NormalizedFeature>): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  const collection: FeatureCollection = { type: 'FeatureCollection', features }
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`
  await writeFile(tmp, JSON.stringify(collection))
  await rename(tmp, path)
}

const categoryCountsOf = <P>(
  features: ReadonlyArray<NormalizedFeature>,
  config: DatasetConfig<P>,
): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const feature of features) {
    const category = config.featureToCategory(feature)
    counts[category] = (counts[category] ?? 0) + 1
  }
  return counts
}

export const buildDataset = async <P>(
  config: DatasetConfig<P>,
  env: BuildEnvironment,
): Promise<BuildOutcome> => {
  for (const licence of config.licences) assertKnownLicence(licence)
  const now = (env.now ?? (() => new Date()))()
  const buildId = generateBuildId(now)
  const buildDir = join(env.referenceRoot, 'builds', String(config.id), String(buildId))
  await mkdir(buildDir, { recursive: true })

  const sourceLoads = await Promise.all(config.sources.map(s => loadSource(s, env.fetchCache)))
  const allFeatures: NormalizedFeature[] = []
  for (const load of sourceLoads) for (const feature of load.features) allFeatures.push(feature)

  const { errors, accepted } = validateFeatures(allFeatures, config)
  const auditErrors: string[] = [...errors]
  let auditStatus: AuditReport['status'] = errors.length === 0 ? 'ok' : 'failed'
  if (config.audit && errors.length === 0) {
    try {
      config.audit(accepted)
    } catch (err) {
      auditStatus = 'failed'
      auditErrors.push(err instanceof Error ? err.message : String(err))
    }
  }

  const sidecarFileName = `${String(config.id)}.features.geojson`
  const pmtilesFileName = `${String(config.id)}.pmtiles`
  const manifestFileName = `${String(config.id)}.manifest.json`
  const auditFileName = 'audit-report.json'
  const sidecarPath = join(buildDir, sidecarFileName)
  const pmtilesPath = join(buildDir, pmtilesFileName)
  const manifestPath = join(buildDir, manifestFileName)
  const auditPath = join(buildDir, auditFileName)

  const auditReport: AuditReport = {
    datasetId: config.id,
    buildId,
    status: auditStatus,
    featureCount: accepted.length,
    categoryCounts: categoryCountsOf(accepted, config),
    errors: auditErrors,
    warnings: [],
  }
  await writeAuditReport(auditPath, auditReport)

  if (auditStatus === 'failed') {
    throw new Error(`buildDataset(${String(config.id)}): audit failed — ${auditErrors.slice(0, 3).join('; ')}`)
  }

  await writeSidecar(sidecarPath, accepted)

  if (!env.skipTileBuild) {
    await buildTiles({
      inputGeoJsonPath: sidecarPath,
      outputPmtilesPath: pmtilesPath,
      config: config.tilebuild,
      ...(env.tippecanoeBinary !== undefined ? { binary: env.tippecanoeBinary } : {}),
      ...(env.tippecanoeRunner !== undefined ? { runner: env.tippecanoeRunner } : {}),
    })
  }

  const manifest = composeDatasetManifest({
    config,
    features: accepted,
    sourceSnapshots: sourceLoads.map(load => load.snapshot),
    builtAt: asIso8601(now.toISOString()),
    buildId,
    pmtilesRelativePath: pmtilesFileName,
    sidecarRelativePath: sidecarFileName,
  })
  await writeDatasetManifest(manifestPath, manifest)

  return { buildId, buildDir, featureCount: accepted.length }
}

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

export const promoteBuild = async (
  referenceRoot: string,
  datasetId: DatasetConfig['id'],
  buildId: BuildId,
): Promise<void> => {
  const buildDir = join(referenceRoot, 'builds', String(datasetId), String(buildId))
  if (!(await pathExists(buildDir))) {
    throw new Error(`promoteBuild: build directory does not exist: ${buildDir}`)
  }
  const releaseDir = join(referenceRoot, 'releases', String(datasetId))
  await mkdir(releaseDir, { recursive: true })
  const currentSymlink = join(releaseDir, 'current')
  const target = relative(releaseDir, buildDir)
  // Stage a temp symlink, then rename over the existing one (POSIX atomic rename for symlinks).
  const tmp = join(releaseDir, `.current.tmp.${process.pid}.${Date.now()}`)
  await symlink(target, tmp)
  if (await pathExists(currentSymlink)) {
    await rename(tmp, currentSymlink)
  } else {
    await rename(tmp, currentSymlink)
  }
}

export const listBuildIds = async (referenceRoot: string, datasetId: DatasetConfig['id']): Promise<ReadonlyArray<BuildId>> => {
  const buildsDir = join(referenceRoot, 'builds', String(datasetId))
  try {
    const entries = await readdir(buildsDir)
    return entries.map(asBuildId).sort()
  } catch {
    return []
  }
}

export const currentBuildId = async (referenceRoot: string, datasetId: DatasetConfig['id']): Promise<BuildId | null> => {
  const currentSymlink = join(referenceRoot, 'releases', String(datasetId), 'current')
  try {
    const target = await readlink(currentSymlink)
    const parts = target.split('/').filter(Boolean)
    const last = parts[parts.length - 1]
    return last ? asBuildId(last) : null
  } catch {
    return null
  }
}

export const removeStaleBuilds = async (
  referenceRoot: string,
  datasetId: DatasetConfig['id'],
  retain: number,
): Promise<ReadonlyArray<BuildId>> => {
  if (!Number.isInteger(retain) || retain < 1) throw new Error('retain must be a positive integer')
  const all = await listBuildIds(referenceRoot, datasetId)
  const current = await currentBuildId(referenceRoot, datasetId)
  const keep = new Set<string>(all.slice(-retain).map(String))
  if (current) keep.add(String(current))
  const removed: BuildId[] = []
  for (const id of all) {
    if (keep.has(String(id))) continue
    const dir = join(referenceRoot, 'builds', String(datasetId), String(id))
    await rm(dir, { recursive: true, force: true })
    removed.push(id)
  }
  return removed
}
