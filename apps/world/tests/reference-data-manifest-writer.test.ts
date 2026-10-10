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
  type NormalizedFeature,
  type TilebuildConfig,
} from '../src/reference-data/types.ts'

const tilebuild: TilebuildConfig = {
  outputLayer: 'exclusion',
  globalMinZoom: 4,
  globalMaxZoom: 12,
  categories: [{ category: 'exclusion', minZoom: 5, maxZoom: 12 }],
}

const config: DatasetConfig = {
  id: asDatasetId('test-dataset'),
  schemaVersion: 1,
  featureSchema: z.object({ category: z.string() }),
  sources: [manualSource({ id: 'fixture', path: '/dev/null' })],
  tilebuild,
  licences: [repoOwned, osmOdbl],
  featureToCategory: (f: NormalizedFeature): string => String(f.properties.category ?? 'unknown'),
}

const sourceSnapshots = [{
  origin: '/dev/null',
  sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  byteLength: 0,
  dataTimestamp: null,
}]

const sampleFeature: NormalizedFeature = {
  type: 'Feature',
  geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
  properties: { category: 'exclusion' },
}

describe('composeDatasetManifest', () => {
  test('composes valid manifest with category counts and licences', () => {
    const manifest = composeDatasetManifest({
      config,
      features: [sampleFeature, sampleFeature, sampleFeature],
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
      features: [sampleFeature],
      sourceSnapshots,
      builtAt: asIso8601('2026-05-26T18:30:00Z'),
      buildId: asBuildId('20260526-1830'),
      pmtilesRelativePath: 'x.pmtiles',
      sidecarRelativePath: 'x.features.geojson',
    })
    expect(() => datasetManifestSchema.parse(manifest)).not.toThrow()
  })
})

describe('composeDatasetManifest source snapshots', () => {
  test('records one snapshot per source and rejects a mismatched count', () => {
    const input = {
      config,
      features: [sampleFeature],
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
      features: [sampleFeature],
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
