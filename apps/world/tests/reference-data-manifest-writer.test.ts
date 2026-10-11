import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { osmOdbl, repoOwned } from '../src/reference-data/licences.ts'
import { composeDatasetManifest, datasetManifestSchema, writeAuditReport, writeDatasetManifest } from '../src/reference-data/manifest-writer.ts'
import { manualSource } from '../src/reference-data/sources/manual.ts'
import {
  asBuildId,
  asDatasetId,
  asIso8601,
  type DatasetConfig,
  type TilebuildConfig,
} from '../src/reference-data/types.ts'

const tilebuild: TilebuildConfig = {
  outputLayer: 'exclusion',
  globalMinZoom: 4,
  globalMaxZoom: 12,
  maximumTileBytes: 100_000,
  tileFeatures: feature => ({ kind: 'tiled', externalId: String(feature.id), features: [{ geometry: feature.geometry, properties: { category: 'exclusion' }, minZoom: 5 }] }),
}

const config: DatasetConfig = {
  id: asDatasetId('test-dataset'),
  schemaVersion: 1,
  featureSchema: z.object({ category: z.string() }),
  sources: [manualSource({ id: 'fixture', path: '/dev/null' })],
  tilebuild,
  licences: [repoOwned, osmOdbl],
  featureToCategory: (f): string => String(f.properties.category),
}

const sourceSnapshots = [{
  origin: '/dev/null',
  sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  byteLength: 0,
  dataTimestamp: null,
}]

const tileInputs = {
  tileCategories: [{ category: 'exclusion', minZoom: 5, maxZoom: 12, featureCount: 3 }],
  tileExclusions: {},
  tiles: null,
  tileInputRelativePath: 'test-dataset.tiles.geojson',
  featureIndexRelativePath: 'test-dataset.feature-index.json',
}

describe('composeDatasetManifest', () => {
  test('composes valid manifest with category counts and licences', () => {
    const manifest = composeDatasetManifest({
      config,
      ...tileInputs,
      sourceSnapshots,
      builtAt: asIso8601('2026-05-26T18:30:00Z'),
      buildId: asBuildId('20260526-1830'),
      pmtilesRelativePath: 'test-dataset.pmtiles',
      sidecarRelativePath: 'test-dataset.features.geojson',
    })
    expect(manifest.datasetId).toBe('test-dataset')
    expect(manifest.categories?.[0]?.featureCount).toBe(3)
    expect(manifest.licences.map(l => l.id).sort()).toEqual(['osm-odbl-1.0', 'repo-owned'])
    expect(manifest.sources?.[0]?.id).toBe('fixture')
  })

  test('schema parses round-trip', () => {
    const manifest = composeDatasetManifest({
      config,
      ...tileInputs,
      sourceSnapshots,
      builtAt: asIso8601('2026-05-26T18:30:00Z'),
      buildId: asBuildId('20260526-1830'),
      pmtilesRelativePath: 'x.pmtiles',
      sidecarRelativePath: 'x.features.geojson',
    })
    expect(() => datasetManifestSchema.parse(manifest)).not.toThrow()
  })
})

describe('composeDatasetManifest tile projection', () => {
  const input = {
    config,
    sourceSnapshots,
    builtAt: asIso8601('2026-05-26T18:30:00Z'),
    buildId: asBuildId('20260526-1830'),
    pmtilesRelativePath: 'x.pmtiles',
    sidecarRelativePath: 'x.features.geojson',
  }

  test('records the tile input, feature index, exclusions and the archive header', () => {
    const manifest = composeDatasetManifest({
      ...input,
      ...tileInputs,
      tileExclusions: { 'portal:topology-helper': 4 },
      tiles: { minZoom: 4, maxZoom: 12, bounds: [4.5, 57.9, 31.1, 71.2] },
    })
    expect(manifest.artifact).toEqual({
      pmtilesPath: 'x.pmtiles',
      sidecarGeoJsonPath: 'x.features.geojson',
      outputLayer: 'exclusion',
      tileInputGeoJsonPath: 'test-dataset.tiles.geojson',
      featureIndexPath: 'test-dataset.feature-index.json',
    })
    expect(manifest.categories).toEqual([{ category: 'exclusion', minZoom: 5, maxZoom: 12, featureCount: 3 }])
    expect(manifest.tileExclusions).toEqual({ 'portal:topology-helper': 4 })
    expect(manifest.tiles).toEqual({ minZoom: 4, maxZoom: 12, bounds: [4.5, 57.9, 31.1, 71.2] })
  })

  test('a build without tiles records no archive header, and impossible bounds are rejected', () => {
    expect(composeDatasetManifest({ ...input, ...tileInputs }).tiles).toBeNull()
    expect(() => composeDatasetManifest({ ...input, ...tileInputs, tiles: { minZoom: 4, maxZoom: 12, bounds: [4.5, 57.9, 31.1, 91] } })).toThrow()
  })
})

describe('composeDatasetManifest source snapshots', () => {
  test('records one snapshot per source and rejects a mismatched count', () => {
    const input = {
      config,
      ...tileInputs,
      builtAt: asIso8601('2026-05-26T18:30:00Z'),
      buildId: asBuildId('20260526-1830'),
      pmtilesRelativePath: 'x.pmtiles',
      sidecarRelativePath: 'x.features.geojson',
    }
    expect(composeDatasetManifest({ ...input, sourceSnapshots }).sources[0]?.snapshot).toEqual(sourceSnapshots[0])
    expect(() => composeDatasetManifest({ ...input, sourceSnapshots: [] })).toThrow('0 source snapshot(s) for 1 source(s)')
  })
})

describe('writeDatasetManifest', () => {
  test('writes JSON to disk and round-trips', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'leitbild-manifest-'))
    const manifest = composeDatasetManifest({
      config,
      ...tileInputs,
      sourceSnapshots,
      builtAt: asIso8601('2026-05-26T18:30:00Z'),
      buildId: asBuildId('20260526-1830'),
      pmtilesRelativePath: 'x.pmtiles',
      sidecarRelativePath: 'x.features.geojson',
    })
    const path = join(dir, 'manifest.json')
    await writeDatasetManifest(path, manifest)
    const read = JSON.parse(await readFile(path, 'utf8'))
    expect(read.datasetId).toBe('test-dataset')
  })
})

describe('writeAuditReport', () => {
  test('writes audit report JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'leitbild-audit-'))
    const path = join(dir, 'audit.json')
    await writeAuditReport(path, {
      datasetId: asDatasetId('test-dataset'),
      buildId: asBuildId('20260526-1830'),
      status: 'ok',
      featureCount: 5,
      categoryCounts: { exclusion: 5 },
      errors: [],
      warnings: ['minor warning'],
    })
    const read = JSON.parse(await readFile(path, 'utf8'))
    expect(read.status).toBe('ok')
    expect(read.featureCount).toBe(5)
    expect(read.warnings).toEqual(['minor warning'])
  })
})
