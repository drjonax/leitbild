import { createHash } from 'node:crypto'
import type { GridSourceInput } from '../schemas/grid-model.ts'
import type { BuildFile, NorwayModelBuildInputs, SnapshotSource } from './inputs.ts'

// The model's recorded inputs (sourceBuild.inputs) and the source ids provenance cites. Every
// curation record is its own input, `curation:<id>`, so the audit can tell which assets a record
// changed.

export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

// Licence ids of src/reference-data/licences.ts.
const registryLicence = { 'nlod-2.0': 'nve-nlod-2.0', 'cc-by-4.0': 'cc-by-4.0' } as const

export interface ModelSourceIds {
  readonly osm: string
  readonly hydro: string
  readonly wind: string
  readonly biddingZones: string
  readonly municipalities: string
  readonly elhub: string
  readonly interconnectors: string
  readonly majorSites: string
  readonly referenceDispatch: string
  readonly population: string
  readonly hydroHeads: string
  readonly coastline: string
  /** Curation feature id (slug) → `curation:<slug>`. */
  readonly curation: (slug: string) => string
}

export interface ModelSources {
  readonly ids: ModelSourceIds
  readonly inputs: ReadonlyArray<GridSourceInput>
}

const latestRetrieval = (sources: ReadonlyArray<SnapshotSource>): string =>
  sources.map(source => source.retrievedAt).sort().at(-1)!

const singleLicence = (label: string, sources: ReadonlyArray<SnapshotSource>): string => {
  const licences = [...new Set(sources.map(source => source.licence))]
  if (licences.length !== 1) throw new Error(`${label}: expected one licence across its sources, got ${licences.join(', ')}`)
  return registryLicence[licences[0]!]
}

const snapshotInput = (sourceId: string, file: BuildFile<{ readonly sources: ReadonlyArray<SnapshotSource> }>): GridSourceInput => ({
  sourceId,
  snapshotAt: latestRetrieval(file.data.sources),
  sha256: file.sha256,
  licence: singleLicence(sourceId, file.data.sources),
})

export const modelSources = (inputs: NorwayModelBuildInputs): ModelSources => {
  const date = inputs.snapshotDate
  const manifest = inputs.sidecarManifest
  if (manifest.sidecar.sha256 !== inputs.sidecar.sha256) {
    throw new Error(`sidecar SHA-256 ${inputs.sidecar.sha256} does not match its manifest (${manifest.sidecar.sha256})`)
  }
  const coastline = inputs.coastline.data.source
  if (coastline.snapshot.sha256 !== manifest.source.snapshot.sha256) {
    throw new Error(`the coastline comes from PBF ${coastline.snapshot.sha256}, the sidecar from ${manifest.source.snapshot.sha256}; both must come from one OSM snapshot`)
  }
  const ids: ModelSourceIds = {
    osm: `${manifest.source.id.toLowerCase()}@${manifest.source.snapshot.dataTimestamp.slice(0, 10)}`,
    hydro: `nve:hydro-plants@${date}`,
    wind: `nve:wind-farms@${date}`,
    biddingZones: `nve:bidding-zones@${date}`,
    municipalities: `kartverket:municipalities@${date}`,
    elhub: `elhub:reference-hours@${date}`,
    interconnectors: `curated:norway-interconnectors@${inputs.interconnectors.data.curatedAt}`,
    majorSites: `curated:norway-major-sites@${inputs.majorSites.data.curatedAt}`,
    referenceDispatch: `curated:norway-reference-dispatch@${inputs.referenceDispatch.data.curatedAt}`,
    population: `ssb:population-1km-${inputs.population.data.year}@${latestRetrieval(inputs.population.data.sources).slice(0, 10)}`,
    hydroHeads: `nve:hydro-heads@${latestRetrieval(inputs.hydroHeads.data.sources).slice(0, 10)}`,
    coastline: `${coastline.id.toLowerCase()}@${coastline.snapshot.dataTimestamp.slice(0, 10)}`,
    curation: slug => `curation:${slug}`,
  }
  const curated = (sourceId: string, file: BuildFile<{ readonly curatedAt: string }>): GridSourceInput => ({
    sourceId, snapshotAt: `${file.data.curatedAt}T00:00:00Z`, sha256: file.sha256, licence: 'osm-odbl-1.0',
  })
  const curationInputs = inputs.curations.data.features.map((feature): GridSourceInput => ({
    sourceId: ids.curation(feature.id),
    snapshotAt: `${feature.properties.reviewedAt}T00:00:00Z`,
    sha256: sha256Hex(JSON.stringify(feature)),
    licence: feature.properties.licence,
  }))
  return {
    ids,
    inputs: [
      { sourceId: ids.osm, snapshotAt: manifest.source.snapshot.dataTimestamp, sha256: inputs.sidecar.sha256, licence: manifest.source.licence.id },
      snapshotInput(ids.hydro, inputs.hydro),
      snapshotInput(ids.wind, inputs.wind),
      snapshotInput(ids.biddingZones, inputs.biddingZones),
      snapshotInput(ids.municipalities, inputs.municipalities),
      snapshotInput(ids.elhub, inputs.referenceHours),
      snapshotInput(ids.population, inputs.population),
      snapshotInput(ids.hydroHeads, inputs.hydroHeads),
      { sourceId: ids.coastline, snapshotAt: coastline.snapshot.dataTimestamp, sha256: inputs.coastline.sha256, licence: coastline.licence.id },
      curated(ids.interconnectors, inputs.interconnectors),
      curated(ids.majorSites, inputs.majorSites),
      // Transcribed measurements: the table's own data licence, not OSM's.
      { sourceId: ids.referenceDispatch, snapshotAt: `${inputs.referenceDispatch.data.curatedAt}T00:00:00Z`, sha256: inputs.referenceDispatch.sha256, licence: inputs.referenceDispatch.data.sources[0]!.licence },
      ...curationInputs,
    ],
  }
}

/** Deterministic build id: a digest of every input hash and of the build's rule tables. */
export const sourceBuildId = (inputs: ReadonlyArray<GridSourceInput>, rulesDigest: string): string => {
  const material = [...inputs.map(input => `${input.sourceId}=${input.sha256}`).sort(), `rules=${rulesDigest}`].join('\n')
  return `norway-${sha256Hex(material).slice(0, 20)}`
}
