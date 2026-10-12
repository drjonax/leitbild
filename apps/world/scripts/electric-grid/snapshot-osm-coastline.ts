#!/usr/bin/env bun
// Writes the OSM coastline snapshot the Norway model build reads (--coastline): the
// natural=coastline ways of a pinned PBF, simplified, as one JSON file. Refuses to overwrite.
//
//   bun run scripts/electric-grid/snapshot-osm-coastline.ts --pbf <norway.osm.pbf> --sha256 <hex> \
//     --out <Leitbild-grid-data/snapshots/osm-coastline/YYYYMMDD/coastline.json>
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { coastlineSnapshotSchema, type CoastlineSnapshot } from '../../src/packs/electric-grid/model-build/inputs.ts'
import { roundLonLat, simplifyPath } from '../../src/packs/electric-grid/model-build/geo.ts'
import { extractOsmCoastline, osmCoastlineSourceId } from '../../src/packs/electric-grid/sources/osm-pbf-coastline.ts'
import { assertOsmPbfPin, inspectOsmPbf } from '../../src/packs/electric-grid/sources/osm-pbf-power.ts'

// Douglas–Peucker tolerance, m: well below the 1 km of open water the attachment rule tests for.
const simplifyToleranceM = 50

const main = async (): Promise<void> => {
  const { values } = parseArgs({ options: { pbf: { type: 'string' }, sha256: { type: 'string' }, out: { type: 'string' } }, strict: true })
  if (values.pbf === undefined || values.sha256 === undefined || values.out === undefined) {
    throw new Error('usage: snapshot-osm-coastline.ts --pbf <file.osm.pbf> --sha256 <hex> --out <coastline.json>')
  }
  const out = resolve(values.out)
  const exists = await stat(out).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false
    throw error
  })
  if (exists) throw new Error(`${out} already exists; snapshots are immutable`)
  const inspection = await inspectOsmPbf(resolve(values.pbf))
  assertOsmPbfPin(inspection, { kind: 'sha256', sha256: values.sha256.toLowerCase() })
  const coastline = await extractOsmCoastline(inspection.path)
  const lines = coastline.lines.map(line => simplifyPath(line, simplifyToleranceM).map(roundLonLat))
  const snapshot: CoastlineSnapshot = coastlineSnapshotSchema.parse({
    kind: 'osm-coastline',
    source: {
      id: osmCoastlineSourceId,
      snapshot: { sha256: inspection.sha256, dataTimestamp: inspection.replicationTimestamp.toISOString() },
      licence: { id: 'osm-odbl-1.0' },
    },
    simplifyToleranceM,
    lines,
  })
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, `${JSON.stringify(snapshot)}\n`)
  console.log(`${osmCoastlineSourceId}: ${coastline.wayCount} ways, ${coastline.nodeCount} nodes → ${lines.reduce((sum, line) => sum + line.length, 0)} vertices at ${simplifyToleranceM} m → ${out}`)
}

await main()
