#!/usr/bin/env bun
// Snapshots the interconnectors' routes beyond the Norway extract from the public Overpass API: the
// OSM power lines and cables connected to each interconnector's free way end, and the substations
// along them (model-build/interconnector-continuations.ts). One targeted query, a few hundred KB.
//
//   bun run scripts/electric-grid/snapshot-interconnector-continuations.ts \
//     --sidecar <builds/osm-YYYYMMDD/grid-norway.features.geojson> --sidecar-sha256 <hex> \
//     --curations <norway-grid-curations.geojson> --interconnectors <norway-interconnectors.json> \
//     --systems hvdc --out <src/packs/electric-grid/models/norway-interconnector-continuations.json>
//
// The free ends come from the same topology the model build compiles, so the build accepts the
// snapshot only while they match. Refuses to overwrite a file whose seeds are the same; ODbL data.
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { buildFileSchemas, sidecarManifestSchema } from '../../src/packs/electric-grid/model-build/inputs.ts'
import {
  continuationQuery,
  continuationSnapshotSchema,
  continuationSourceId,
  continueInterconnectors,
  overpassEndpoint,
  type ContinuationSnapshot,
} from '../../src/packs/electric-grid/model-build/interconnector-continuations.ts'
import { jsonLines } from '../../src/packs/electric-grid/model-build/json-lines.ts'
import { norwayContinuationSeeds } from '../../src/packs/electric-grid/model-build/norway-model.ts'
import { readSidecarFeatures } from '../../src/packs/electric-grid/model-build/sidecar-features.ts'

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

const main = async (): Promise<void> => {
  const { values } = parseArgs({
    options: {
      sidecar: { type: 'string' },
      'sidecar-sha256': { type: 'string' },
      curations: { type: 'string' },
      interconnectors: { type: 'string' },
      systems: { type: 'string' },
      out: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  })
  const required = (name: keyof typeof values): string => {
    const value = values[name]
    if (value === undefined) throw new Error(`--${name} is required`)
    return value
  }
  const sidecarPath = resolve(required('sidecar'))
  const sidecarBytes = new Uint8Array(await readFile(sidecarPath))
  if (sha256(sidecarBytes) !== required('sidecar-sha256')) throw new Error(`${sidecarPath} has SHA-256 ${sha256(sidecarBytes)}, expected ${required('sidecar-sha256')}`)
  const manifest = sidecarManifestSchema.parse(JSON.parse(await readFile(join(dirname(sidecarPath), 'grid-norway.sidecar-manifest.json'), 'utf8')) as unknown)
  if (manifest.sidecar.path !== basename(sidecarPath)) throw new Error(`the manifest beside ${sidecarPath} describes ${manifest.sidecar.path}`)
  const sidecarJson = JSON.parse(new TextDecoder().decode(sidecarBytes)) as unknown
  const readTable = async <T>(path: string, parse: (value: unknown) => T) => {
    const bytes = new Uint8Array(await readFile(resolve(path)))
    return { sha256: sha256(bytes), data: parse(JSON.parse(new TextDecoder().decode(bytes)) as unknown) }
  }
  const inputs = {
    sidecar: { sha256: sha256(sidecarBytes), data: sidecarJson },
    curations: await readTable(required('curations'), value => buildFileSchemas.curations.parse(value)),
    interconnectors: await readTable(required('interconnectors'), value => buildFileSchemas.interconnectors.parse(value)),
  }
  const osmSourceId = `${manifest.source.id.toLowerCase()}@${manifest.source.snapshot.dataTimestamp.slice(0, 10)}`
  const systems = [...new Set(required('systems').split(','))].map(system => {
    if (system !== 'hvdc' && system !== 'ac') throw new Error(`--systems takes hvdc and/or ac, not ${system}`)
    return system
  }).sort()
  const seeds = norwayContinuationSeeds(inputs, osmSourceId).filter(seed => systems.includes(seed.system))
  const query = continuationQuery(seeds)
  console.log(`querying ${overpassEndpoint} for ${seeds.length} free ends:\n${query}`)
  const retrievedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const response = await fetch(overpassEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Leitbild grid model build (interconnector continuations)' },
    body: new URLSearchParams({ data: query }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`Overpass answered ${response.status}: ${text.slice(0, 500)}`)
  const answer = JSON.parse(text) as { readonly osm3s?: { readonly timestamp_osm_base?: string; readonly copyright?: string }; readonly elements?: unknown; readonly remark?: string }
  if (answer.remark !== undefined) throw new Error(`Overpass remark: ${answer.remark}`)
  const snapshot: ContinuationSnapshot = continuationSnapshotSchema.parse({
    kind: 'osm-overpass-interconnector-continuations',
    source: {
      id: continuationSourceId,
      endpoint: overpassEndpoint,
      query,
      snapshotAt: answer.osm3s?.timestamp_osm_base,
      retrievedAt,
      licence: { id: 'osm-odbl-1.0', attribution: answer.osm3s?.copyright ?? '© OpenStreetMap contributors · ODbL 1.0' },
    },
    systems,
    seeds,
    elements: answer.elements,
  })
  // Every free end must reach a station before the snapshot is kept.
  const routes = continueInterconnectors({ snapshot, extractWayIds: readSidecarFeatures(sidecarJson).lineWayIds })
  for (const route of routes) console.log(`${route.interconnectorId}: ${route.osmWayIds.length} ways to ${route.station.name ?? route.station.osmId} (${route.station.osmId})${route.station.namedInTable ? '' : ' — not the station the table names'}`)
  const out = resolve(required('out'))
  const text2 = jsonLines(snapshot, 2)
  await writeFile(out, text2)
  console.log(`wrote ${out}: ${(Buffer.byteLength(text2) / 1024).toFixed(1)} KiB, ${snapshot.elements.length} elements, OSM data time ${snapshot.source.snapshotAt}, Overpass answer ${(text.length / 1024).toFixed(1)} KiB`)
}

await main()
