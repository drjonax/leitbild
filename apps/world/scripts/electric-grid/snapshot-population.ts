#!/usr/bin/env bun
import { parseArgs } from 'node:util'
import { fetchSsbPopulationGrid, ssbPopulationGridSourceId } from '../../src/packs/electric-grid/sources/ssb-population-grid.ts'
import { defaultFetchContext } from '../../src/packs/electric-grid/sources/registry-fetch.ts'
import { compactDate, createWriter } from './snapshot-registries.ts'

// Fetches one year of SSB's 1 km population grid and writes the raw pages to
// <data-dir>/downloads/ssb-population-grid/<YYYYMMDD>/ and the validated squares to
// <data-dir>/snapshots/ssb-population-grid/<YYYYMMDD>/population-cells.json. Refuses to overwrite.
//
//   bun run scripts/electric-grid/snapshot-population.ts --data-dir <Leitbild-grid-data> --year 2024

const main = async (): Promise<void> => {
  const { values } = parseArgs({ options: { 'data-dir': { type: 'string' }, year: { type: 'string' } }, strict: true })
  const dataDir = values['data-dir']
  const year = Number(values.year)
  if (dataDir === undefined || !Number.isInteger(year)) throw new Error('usage: snapshot-population.ts --data-dir <Leitbild-grid-data directory> --year <YYYY>')
  const context = defaultFetchContext()
  const date = compactDate(context.now())
  const write = createWriter(dataDir, date)
  const grid = await fetchSsbPopulationGrid(context, year)
  const sources = await write.raw('ssb-population-grid', grid.documents.map((document, index) => ({ name: `page-${String(index).padStart(3, '0')}.geojson`, document })))
  const file = await write.json('ssb-population-grid', 'population-cells.json', {
    sources: sources.map(({ file: _file, ...snapshot }) => snapshot),
    sourceId: ssbPopulationGridSourceId,
    year,
    cells: grid.cells,
  })
  console.log(`${ssbPopulationGridSourceId} ${year}: ${grid.cells.length} squares, ${grid.cells.reduce((sum, cell) => sum + cell.population, 0)} residents → ${file}`)
}

if (import.meta.main) await main()
