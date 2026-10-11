import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { osmOdbl, nveNlod20, repoOwned } from '../src/reference-data/licences.ts'
import { TileType } from 'pmtiles'
import { writePmtilesArchive } from '../src/map/pmtiles-writer.ts'
import { buildDataset, currentBuildId, promoteBuild, removeStaleBuilds } from '../src/reference-data/pipeline.ts'
import { manualSource } from '../src/reference-data/sources/manual.ts'
import { featureIndexSchema } from '../src/reference-data/tile-projection.ts'
import type { TippecanoeRunner } from '../src/reference-data/tippecanoe.ts'
import {
  asDatasetId,
  type DatasetConfig,
  type NormalizedFeature,
  type TilebuildConfig,
} from '../src/reference-data/types.ts'
import { createFetchCache } from '../src/reference-data/fetch-cache.ts'

const fixturePath = join(import.meta.dir, 'fixtures', 'reference-area.geojson')

// Area 1 is tiled as its polygon from z5 plus a z4 label point; area 2 stays out of the tiles.
const tilebuild: TilebuildConfig = {
  outputLayer: 'exclusion',
  globalMinZoom: 4,
  globalMaxZoom: 12,
  maximumTileBytes: 100_000,
  tileFeatures: (feature) => feature.id === 'area-2'
    ? { kind: 'excluded', reason: 'exclusion:retired' }
    : {
        kind: 'tiled',
        externalId: String(feature.id),
        features: [
          { geometry: { type: 'Point', coordinates: [10.05, 59.05] }, properties: { category: 'exclusion', name: String(feature.properties.name) }, minZoom: 4, maxZoom: 4 },
          { geometry: feature.geometry, properties: { category: 'exclusion' }, minZoom: 5 },
        ],
      },
}

const featureSchema = z.object({
  category: z.literal('exclusion'),
  name: z.string().min(1),
  floorM: z.number().nonnegative(),
  ceilingM: z.number().nonnegative(),
  source: z.string().min(1),
})

const validConfig: DatasetConfig = {
  id: asDatasetId('test-exclusion'),
  schemaVersion: 1,
  featureSchema,
  sources: [manualSource({ id: 'reference-area-fixture', path: fixturePath })],
  tilebuild,
  licences: [repoOwned],
  featureToCategory: (f: NormalizedFeature): string => String(f.properties.category),
}

const mkEnv = async () => {
  const root = await mkdtemp(join(tmpdir(), 'leitbild-refdata-'))
  return {
    referenceRoot: root,
    fetchCache: createFetchCache(join(root, 'sources')),
    skipTileBuild: true,
    now: () => new Date('2026-05-26T18:30:00Z'),
  }
}

describe('buildDataset', () => {
  test('happy path: writes sidecar, manifest, audit report', async () => {
    const env = await mkEnv()
    const outcome = await buildDataset(validConfig, env)
    expect(outcome.featureCount).toBe(2)
    const sidecar = JSON.parse(await readFile(join(outcome.buildDir, 'test-exclusion.features.geojson'), 'utf8'))
    expect(sidecar.type).toBe('FeatureCollection')
    expect(sidecar.features.length).toBe(2)
    const manifest = JSON.parse(await readFile(join(outcome.buildDir, 'test-exclusion.manifest.json'), 'utf8'))
    expect(manifest.datasetId).toBe('test-exclusion')
    expect(manifest.categories).toEqual([{ category: 'exclusion', minZoom: 4, maxZoom: 12, featureCount: 1 }])
    expect(manifest.tileExclusions).toEqual({ 'exclusion:retired': 1 })
    expect(manifest.tiles).toBeNull()
    expect(manifest.licences[0].id).toBe('repo-owned')
    const audit = JSON.parse(await readFile(join(outcome.buildDir, 'audit-report.json'), 'utf8'))
    expect(audit.status).toBe('ok')
    expect(audit.errors).toEqual([])
  })

  test('writes the tile projection as tippecanoe input with one numeric fid per tiled feature, and its index', async () => {
    const env = await mkEnv()
    const outcome = await buildDataset(validConfig, env)
    const tileInput = JSON.parse(await readFile(join(outcome.buildDir, 'test-exclusion.tiles.geojson'), 'utf8'))
    expect(tileInput.type).toBe('FeatureCollection')
    expect(tileInput.features).toEqual([
      {
        type: 'Feature',
        tippecanoe: { minzoom: 4, maxzoom: 4 },
        geometry: { type: 'Point', coordinates: [10.05, 59.05] },
        properties: { category: 'exclusion', name: 'Test area 1', fid: 1 },
      },
      {
        type: 'Feature',
        tippecanoe: { minzoom: 5, maxzoom: 12 },
        geometry: { type: 'Polygon', coordinates: [[[10, 59], [10.1, 59], [10.1, 59.1], [10, 59.1], [10, 59]]] },
        properties: { category: 'exclusion', fid: 1 },
      },
    ])
    const index = featureIndexSchema.parse(JSON.parse(await readFile(join(outcome.buildDir, 'test-exclusion.feature-index.json'), 'utf8')))
    expect(index).toEqual({ datasetId: 'test-exclusion', buildId: String(outcome.buildId), externalIdByFid: { 1: 'area-1' } })
    const sidecar = JSON.parse(await readFile(join(outcome.buildDir, 'test-exclusion.features.geojson'), 'utf8'))
    expect(sidecar.features.map((feature: { id: string }) => feature.id)).toEqual(['area-1', 'area-2'])
  })

  test('builds tiles from the tile input and records the archive header in the manifest', async () => {
    const env = await mkEnv()
    const calls: Array<{ readonly cmd: string; readonly args: ReadonlyArray<string> }> = []
    const runner: TippecanoeRunner = async (cmd, args) => {
      calls.push({ cmd, args })
      const output = args[args.indexOf('-o') + 1]!
      await Bun.write(output, writePmtilesArchive({
        tiles: [{ z: 4, x: 8, y: 4, data: new Uint8Array([1]) }, { z: 12, x: 2162, y: 1189, data: new Uint8Array([2]) }],
        tileType: TileType.Mvt,
        bounds: { minLon: 10, minLat: 59, maxLon: 10.1, maxLat: 59.1 },
        center: { lon: 10.05, lat: 59.05, zoom: 8 },
      }))
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const outcome = await buildDataset(validConfig, { ...env, skipTileBuild: false, tippecanoeRunner: runner })
    expect(calls).toHaveLength(1)
    const args = calls[0]!.args
    expect(args[args.length - 1]).toBe(join(outcome.buildDir, 'test-exclusion.tiles.geojson'))
    const value = (flag: string) => args[args.indexOf(flag) + 1]
    expect(value('--maximum-zoom')).toBe('12')
    expect(value('--maximum-tile-bytes')).toBe('100000')
    for (const flag of ['--use-attribute-for-id=fid', '--simplify-only-low-zooms', '--drop-rate=1', '--minimum-detail=12']) expect(args).toContain(flag)
    for (const flag of args) expect(flag).not.toMatch(/as-needed|no-feature-limit|no-tile-size-limit/)
    const manifest = JSON.parse(await readFile(join(outcome.buildDir, 'test-exclusion.manifest.json'), 'utf8'))
    expect(manifest.tiles).toEqual({ minZoom: 4, maxZoom: 12, bounds: [10, 59, 10.1, 59.1] })
  })

  test('a failing tippecanoe run fails the build with its message', async () => {
    const env = await mkEnv()
    const runner: TippecanoeRunner = async () => ({ exitCode: 106, stdout: '', stderr: 'tile 4/8/4 size is 120000 with detail 12, >100000' })
    await expect(buildDataset(validConfig, { ...env, skipTileBuild: false, tippecanoeRunner: runner }))
      .rejects.toThrow('tippecanoe failed (exit 106): tile 4/8/4 size is 120000')
  })

  test('audit hook throwing fails the build and writes failure report', async () => {
    const env = await mkEnv()
    const config: DatasetConfig = {
      ...validConfig,
      audit: () => { throw new Error('intentional audit failure') },
    }
    await expect(buildDataset(config, env)).rejects.toThrow(/audit failed/)
  })

  test('feature-schema rejection accumulates errors and fails', async () => {
    const env = await mkEnv()
    const strictSchema = z.object({
      category: z.literal('nope'),
      name: z.string(),
      floorM: z.number(),
      ceilingM: z.number(),
      source: z.string(),
    })
    const config: DatasetConfig = { ...validConfig, featureSchema: strictSchema }
    await expect(buildDataset(config, env)).rejects.toThrow(/audit failed/)
  })

  test('unknown licence is rejected at build time', async () => {
    const env = await mkEnv()
    const config: DatasetConfig = {
      ...validConfig,
      licences: [{
        id: 'made-up-licence-id' as never,
        name: 'Fake',
        url: '',
        attribution: 'fake',
        commercialUseAllowed: true,
        redistributionAllowed: true,
        shareAlike: false,
      } as never],
    }
    await expect(buildDataset(config, env)).rejects.toThrow(/unknown licence id/)
  })

  test('multiple licences are all recorded', async () => {
    const env = await mkEnv()
    const config: DatasetConfig = { ...validConfig, licences: [osmOdbl, nveNlod20] }
    const outcome = await buildDataset(config, env)
    const manifest = JSON.parse(await readFile(join(outcome.buildDir, 'test-exclusion.manifest.json'), 'utf8'))
    expect(manifest.licences.map((l: { id: string }) => l.id).sort()).toEqual(['nve-nlod-2.0', 'osm-odbl-1.0'])
  })
})

describe('promoteBuild', () => {
  test('creates the current symlink pointing at the build', async () => {
    const env = await mkEnv()
    const outcome = await buildDataset(validConfig, env)
    await promoteBuild(env.referenceRoot, validConfig.id, outcome.buildId)
    const current = await currentBuildId(env.referenceRoot, validConfig.id)
    expect(current).toBe(outcome.buildId)
  })

  test('replaces the symlink on subsequent promote', async () => {
    const env = await mkEnv()
    const first = await buildDataset(validConfig, env)
    await promoteBuild(env.referenceRoot, validConfig.id, first.buildId)
    const second = await buildDataset(
      validConfig,
      { ...env, now: () => new Date('2026-05-26T19:00:00Z') },
    )
    await promoteBuild(env.referenceRoot, validConfig.id, second.buildId)
    const current = await currentBuildId(env.referenceRoot, validConfig.id)
    expect(current).toBe(second.buildId)
    expect(current).not.toBe(first.buildId)
  })

  test('rejects promote of a non-existent build', async () => {
    const env = await mkEnv()
    await expect(
      promoteBuild(env.referenceRoot, validConfig.id, 'does-not-exist' as never),
    ).rejects.toThrow(/build directory does not exist/)
  })

  test('promoted build directory contains the expected artifacts', async () => {
    const env = await mkEnv()
    const outcome = await buildDataset(validConfig, env)
    await promoteBuild(env.referenceRoot, validConfig.id, outcome.buildId)
    const currentPath = join(env.referenceRoot, 'releases', String(validConfig.id), 'current')
    const sidecarStat = await stat(join(currentPath, 'test-exclusion.features.geojson'))
    expect(sidecarStat.isFile()).toBe(true)
  })
})

describe('removeStaleBuilds', () => {
  test('keeps the current build plus the requested newest builds', async () => {
    const env = await mkEnv()
    const builds = ['build-01', 'build-02', 'build-03', 'build-04', 'build-05']
    for (const id of builds) {
      await mkdir(join(env.referenceRoot, 'builds', String(validConfig.id), id), { recursive: true })
    }
    await promoteBuild(env.referenceRoot, validConfig.id, 'build-02' as never)

    const removed = await removeStaleBuilds(env.referenceRoot, validConfig.id, 2)

    expect(removed.map(String)).toEqual(['build-01', 'build-03'])
    expect((await stat(join(env.referenceRoot, 'builds', String(validConfig.id), 'build-02'))).isDirectory()).toBe(true)
    expect((await stat(join(env.referenceRoot, 'builds', String(validConfig.id), 'build-04'))).isDirectory()).toBe(true)
    expect((await stat(join(env.referenceRoot, 'builds', String(validConfig.id), 'build-05'))).isDirectory()).toBe(true)
    await expect(stat(join(env.referenceRoot, 'builds', String(validConfig.id), 'build-01'))).rejects.toThrow()
  })

  test('rejects an unsafe retention count', async () => {
    const env = await mkEnv()
    await expect(removeStaleBuilds(env.referenceRoot, validConfig.id, 0)).rejects.toThrow('positive integer')
  })
})
