import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractOsmCoastline } from '../src/packs/electric-grid/sources/osm-pbf-coastline.ts'
import { writeOsmPbfFixture } from './helpers/osm-pbf-fixture.ts'

// The coastline the load attachment measures open water against: natural=coastline ways of the
// pinned PBF with their node locations, in way-id order.

let directory = ''

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'leitbild-osm-coastline-'))
})

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('OSM coastline extraction', () => {
  test('keeps the natural=coastline ways with their vertices in way order', async () => {
    const path = join(directory, 'coast.osm.pbf')
    await writeOsmPbfFixture(path, {
      replicationTimestamp: new Date('2026-10-08T20:21:06Z'),
      nodes: [
        { id: 1, lon: 10, lat: 60 },
        { id: 2, lon: 10.01, lat: 60 },
        { id: 3, lon: 10.02, lat: 60.01 },
        { id: 4, lon: 11, lat: 61 },
        { id: 5, lon: 11.01, lat: 61 },
      ],
      ways: [
        { id: 30, refs: [4, 5], tags: { natural: 'water' } },
        { id: 20, refs: [3, 2, 1], tags: { natural: 'coastline' } },
        { id: 10, refs: [1, 2], tags: { natural: 'coastline' } },
      ],
    })
    const coastline = await extractOsmCoastline(path)
    expect({ wayCount: coastline.wayCount, nodeCount: coastline.nodeCount }).toEqual({ wayCount: 2, nodeCount: 3 })
    expect(coastline.lines).toEqual([[[10, 60], [10.01, 60]], [[10.02, 60.01], [10.01, 60], [10, 60]]])
  })

  test('fails when a coastline way references a node the file does not contain', async () => {
    const path = join(directory, 'incomplete.osm.pbf')
    await writeOsmPbfFixture(path, {
      replicationTimestamp: new Date('2026-10-08T20:21:06Z'),
      nodes: [{ id: 1, lon: 10, lat: 60 }],
      ways: [{ id: 10, refs: [1, 2], tags: { natural: 'coastline' } }],
    })
    await expect(extractOsmCoastline(path)).rejects.toThrow('coastline way 10 references node 2')
  })
})
