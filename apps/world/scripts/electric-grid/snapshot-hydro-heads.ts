#!/usr/bin/env bun
import { parseArgs } from 'node:util'
import { fetchNveHydroHeads, nveHydroHeadsSourceId } from '../../src/packs/electric-grid/sources/nve-hydro-heads.ts'
import { defaultFetchContext } from '../../src/packs/electric-grid/sources/registry-fetch.ts'
import { compactDate, createWriter } from './snapshot-registries.ts'

// Fetches NVE's hydropower plants in operation and writes the raw response to
// <data-dir>/downloads/nve-hydro-heads/<YYYYMMDD>/ and each plant's gross head to
// <data-dir>/snapshots/nve-hydro-heads/<YYYYMMDD>/hydro-heads.json. Refuses to overwrite.
//
//   bun run scripts/electric-grid/snapshot-hydro-heads.ts --data-dir <Leitbild-grid-data>

const main = async (): Promise<void> => {
  const { values } = parseArgs({ options: { 'data-dir': { type: 'string' } }, strict: true })
  const dataDir = values['data-dir']
  if (dataDir === undefined) throw new Error('usage: snapshot-hydro-heads.ts --data-dir <Leitbild-grid-data directory>')
  const context = defaultFetchContext()
  const write = createWriter(dataDir, compactDate(context.now()))
  const fetched = await fetchNveHydroHeads(context)
  const sources = await write.raw('nve-hydro-heads', [{ name: 'hydro-plants-in-operation.json', document: fetched.document }])
  const file = await write.json('nve-hydro-heads', 'hydro-heads.json', {
    sources: sources.map(({ file: _file, ...snapshot }) => snapshot),
    sourceId: nveHydroHeadsSourceId,
    plants: fetched.heads,
  })
  console.log(`${nveHydroHeadsSourceId}: ${fetched.heads.length} plants with a gross head → ${file}`)
}

if (import.meta.main) await main()
