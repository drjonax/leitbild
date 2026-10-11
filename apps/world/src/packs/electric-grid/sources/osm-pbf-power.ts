import { stat } from 'node:fs/promises'
import {
  asIso8601,
  asSourceId,
  type DatasetSource,
  type GeoJsonPosition,
  type LocalSourceLoad,
  type NormalizedFeature,
  type SourceSnapshot,
} from '../../../reference-data/types.ts'
import type { GridReferenceCategory, GridReferenceFeatureProperties } from '../schemas/grid-reference.ts'
import {
  memberCentroidGeometry,
  multipolygonGeometry,
  pointGeometry,
  wayGeometry,
  type GeometryOutcome,
  type GeometrySuccess,
  type NodeCoordinates,
  type WayRefs,
} from './osm-power-geometry.ts'
import {
  readOsmPbf,
  readOsmPbfHeader,
  type OsmPbfHeader,
  type OsmRelationMember,
  type OsmTags,
} from './osm-pbf-reader.ts'
import {
  buildOsmPowerProperties,
  exclusionOf,
  isBranchCategory,
  isPowerCircuitRelation,
  lifecycleOfTagged,
  parseFrequency,
  parseVoltage,
  powerKindOf,
  type OsmPowerKind,
} from './osm-power-normalization.ts'

// OSM PBF power extraction: one normalised feature per OSM element, plus a ledger of what was not emitted.

export type OsmPbfPin =
  | { readonly kind: 'sha256'; readonly sha256: string }
  | { readonly kind: 'max-age'; readonly maxAgeDays: number; readonly now: () => Date }

export interface OsmPbfPowerSourceConfig {
  readonly id: string
  readonly path: string
  readonly pin: OsmPbfPin
}

export interface OsmPbfInspection {
  readonly path: string
  readonly sha256: string
  readonly byteLength: number
  readonly modifiedAtMs: number
  readonly header: OsmPbfHeader
  readonly replicationTimestamp: Date
}

export interface OsmPowerExtraction {
  readonly features: ReadonlyArray<NormalizedFeature>
  // Count of OSM power elements not emitted, or emitted with partial geometry, by reason code.
  readonly ledger: Readonly<Record<string, number>>
}

interface PowerNodeRecord {
  readonly id: number
  readonly position: GeoJsonPosition
  readonly tags: OsmTags
  readonly kind: OsmPowerKind
}

interface WayRecord {
  readonly id: number
  readonly refs: ReadonlyArray<number>
  readonly tags: OsmTags
  readonly kind: OsmPowerKind | null
}

interface RelationRecord {
  readonly id: number
  readonly members: ReadonlyArray<OsmRelationMember>
  readonly tags: OsmTags
  readonly kind: OsmPowerKind
}

interface Candidate {
  readonly feature: NormalizedFeature
  readonly properties: GridReferenceFeatureProperties
}

const SHA256_HEX = /^[0-9a-f]{64}$/
const MILLISECONDS_PER_DAY = 86_400_000
const AREA_CATEGORIES: ReadonlySet<GridReferenceCategory> = new Set(['substation', 'plant', 'generator'])
const RELATION_CATEGORIES: ReadonlySet<GridReferenceCategory> = new Set(['substation', 'plant', 'generator', 'transformer', 'circuit'])

const relationKindOf = (tags: OsmTags): OsmPowerKind | null =>
  isPowerCircuitRelation(tags) ? { category: 'circuit', lifecycle: lifecycleOfTagged(tags) } : powerKindOf(tags)

const sha256OfFile = async (path: string): Promise<string> => {
  const hasher = new Bun.CryptoHasher('sha256')
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk)
  return hasher.digest('hex')
}

/** Hashes the file and reads its OSMHeader; a PBF without a replication timestamp cannot be dated and is rejected. */
export const inspectOsmPbf = async (path: string): Promise<OsmPbfInspection> => {
  const before = await stat(path)
  const header = await readOsmPbfHeader(path)
  if (!header.replicationTimestamp) {
    throw new Error(`osm-pbf-power: ${path} has no osmosis_replication_timestamp in its OSMHeader`)
  }
  const sha256 = await sha256OfFile(path)
  const after = await stat(path)
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new Error(`osm-pbf-power: ${path} changed while it was being hashed`)
  }
  return {
    path,
    sha256,
    byteLength: after.size,
    modifiedAtMs: after.mtimeMs,
    header,
    replicationTimestamp: header.replicationTimestamp,
  }
}

export const assertOsmPbfPin = (inspection: OsmPbfInspection, pin: OsmPbfPin): void => {
  if (pin.kind === 'sha256') {
    if (inspection.sha256 !== pin.sha256) {
      throw new Error(`osm-pbf-power: ${inspection.path} has sha256 ${inspection.sha256}, pinned input expects ${pin.sha256}`)
    }
    return
  }
  const ageMs = pin.now().getTime() - inspection.replicationTimestamp.getTime()
  if (ageMs > pin.maxAgeDays * MILLISECONDS_PER_DAY) {
    const ageDays = (ageMs / MILLISECONDS_PER_DAY).toFixed(1)
    throw new Error(
      `osm-pbf-power: ${inspection.path} is ${ageDays} days old (replication timestamp ${inspection.replicationTimestamp.toISOString()}), exceeding the ${pin.maxAgeDays}-day maximum`,
    )
  }
}

export const validateOsmPbfPin = (pin: OsmPbfPin): OsmPbfPin => {
  if (pin.kind === 'sha256' && !SHA256_HEX.test(pin.sha256)) {
    throw new Error(`osm-pbf-power: pinned sha256 must be 64 lowercase hex characters, got "${pin.sha256}"`)
  }
  if (pin.kind === 'max-age' && !(Number.isFinite(pin.maxAgeDays) && pin.maxAgeDays > 0)) {
    throw new Error(`osm-pbf-power: max age must be a positive number of days, got ${pin.maxAgeDays}`)
  }
  return pin
}

export const snapshotOfInspection = (inspection: OsmPbfInspection): SourceSnapshot => ({
  origin: inspection.path,
  sha256: inspection.sha256,
  byteLength: inspection.byteLength,
  dataTimestamp: asIso8601(inspection.replicationTimestamp.toISOString()),
})

const readPowerElements = async (path: string): Promise<{
  readonly nodes: ReadonlyArray<PowerNodeRecord>
  readonly ways: ReadonlyArray<WayRecord>
  readonly relations: ReadonlyArray<RelationRecord>
  readonly coordinates: ReadonlyMap<number, GeoJsonPosition>
}> => {
  // Pass 1: tagged power nodes (with positions) and power relations.
  const nodes: PowerNodeRecord[] = []
  const relations: RelationRecord[] = []
  const memberWayIds = new Set<number>()
  const neededNodeIds = new Set<number>()
  await readOsmPbf(path, {
    node: (id, lon, lat, tags) => {
      const kind = powerKindOf(tags)
      if (kind) nodes.push({ id, position: [lon, lat], tags, kind })
    },
    relation: (id, members, tags) => {
      const kind = relationKindOf(tags)
      if (!kind) return
      relations.push({ id, members, tags, kind })
      for (const member of members) {
        if (member.type === 'way') memberWayIds.add(member.ref)
        else if (member.type === 'node') neededNodeIds.add(member.ref)
      }
    },
  })
  // Pass 2: power ways and every way a power relation references.
  const ways: WayRecord[] = []
  await readOsmPbf(path, {
    way: (id, refs, tags) => {
      const kind = powerKindOf(tags)
      if (!kind && !memberWayIds.has(id)) return
      ways.push({ id, refs, tags, kind })
      for (const ref of refs) neededNodeIds.add(ref)
    },
  })
  // Pass 3: positions of way nodes and relation node members.
  const coordinates = new Map<number, GeoJsonPosition>()
  for (const node of nodes) {
    coordinates.set(node.id, node.position)
    neededNodeIds.delete(node.id)
  }
  await readOsmPbf(path, {
    nodeLocation: (id, lon, lat) => {
      if (neededNodeIds.has(id)) coordinates.set(id, [lon, lat])
    },
  })
  return { nodes, ways, relations, coordinates }
}

const featureOf = (
  source: string,
  elementType: 'node' | 'way' | 'relation',
  id: number,
  geometry: GeometrySuccess,
  kind: OsmPowerKind,
  tags: OsmTags,
  members: ReadonlyArray<OsmRelationMember>,
): Candidate => {
  const properties = buildOsmPowerProperties({
    source,
    kind,
    externalId: `${elementType}/${id}`,
    tags,
    osmNodeIds: geometry.osmNodeIds,
    members: members.map(member => ({ id: `${member.type}/${member.ref}`, role: member.role })),
    geometrySource: geometry.geometrySource,
  })
  return {
    properties,
    feature: { type: 'Feature', id: `${source}:${elementType}:${id}`, geometry: geometry.geometry, properties },
  }
}

const createLedger = () => {
  const counts = new Map<string, number>()
  return {
    count: (reason: string): void => {
      counts.set(reason, (counts.get(reason) ?? 0) + 1)
    },
    toRecord: (): Readonly<Record<string, number>> =>
      Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right))),
  }
}

const isPortalCategory = (category: GridReferenceCategory): boolean =>
  category === 'portal' || category === 'terminal'

const relationGeometry = (
  relation: RelationRecord,
  wayRefs: WayRefs,
  coordinates: NodeCoordinates,
  ledger: ReturnType<typeof createLedger>,
): GeometryOutcome => {
  if (relation.tags.type !== 'multipolygon') return memberCentroidGeometry(relation.members, wayRefs, coordinates)
  const outcome = multipolygonGeometry(relation.members, wayRefs, coordinates)
  if (outcome.ok && outcome.openSegmentCount > 0) ledger.count(`partial:${relation.kind.category}:multipolygon-open-segments`)
  return outcome
}

/** Extracts and normalises the power network of an OSM PBF file. */
export const extractOsmPower = async (path: string, source: string): Promise<OsmPowerExtraction> => {
  const elements = await readPowerElements(path)
  const wayRefs = new Map(elements.ways.map(way => [way.id, way.refs]))
  const ledger = createLedger()
  const candidates: Candidate[] = []
  const exclude = (category: GridReferenceCategory, reason: string): void => ledger.count(`excluded:${category}:${reason}`)

  for (const node of elements.nodes) {
    candidates.push(featureOf(source, 'node', node.id, pointGeometry(node.id, node.position), node.kind, node.tags, []))
  }
  for (const way of elements.ways) {
    if (!way.kind) continue
    const geometry = wayGeometry(way.refs, elements.coordinates, AREA_CATEGORIES.has(way.kind.category))
    if (!geometry.ok) {
      exclude(way.kind.category, geometry.failure)
      continue
    }
    candidates.push(featureOf(source, 'way', way.id, geometry, way.kind, way.tags, []))
  }
  for (const relation of elements.relations) {
    if (!RELATION_CATEGORIES.has(relation.kind.category)) {
      exclude(relation.kind.category, 'unsupported-relation-category')
      continue
    }
    const geometry = relationGeometry(relation, wayRefs, elements.coordinates, ledger)
    if (!geometry.ok) {
      exclude(relation.kind.category, geometry.failure)
      continue
    }
    candidates.push(featureOf(source, 'relation', relation.id, geometry, relation.kind, relation.tags, relation.members))
  }

  // Portals and terminals below the voltage floor are kept when an included branch ends or passes on them.
  const decisions = candidates.map(candidate => ({ candidate, exclusion: exclusionOf(candidate.properties) }))
  const branchNodeIds = new Set<string>()
  for (const { candidate, exclusion } of decisions) {
    if (exclusion !== null || !isBranchCategory(candidate.properties.category)) continue
    for (const nodeId of candidate.properties.osmNodeIds ?? []) branchNodeIds.add(nodeId)
  }
  const features: NormalizedFeature[] = []
  for (const { candidate, exclusion } of decisions) {
    const usedByBranch = isPortalCategory(candidate.properties.category) &&
      (candidate.properties.osmNodeIds ?? []).some(nodeId => branchNodeIds.has(nodeId))
    if (exclusion !== null && !usedByBranch) {
      exclude(candidate.properties.category, exclusion)
      continue
    }
    features.push(candidate.feature)
    const { category, tags } = candidate.properties
    if (parseVoltage(tags.voltage).unparsed.length > 0) ledger.count(`note:${category}:unparsed-voltage-part`)
    if (parseFrequency(tags.frequency).unparsed.length > 0) ledger.count(`note:${category}:unparsed-frequency-part`)
  }
  return { features, ledger: ledger.toRecord() }
}

/** Verifies the pin, extracts, and fails if the file changed between hashing and extraction. */
export const extractPinnedOsmPower = async (
  path: string,
  pin: OsmPbfPin,
  source: string,
): Promise<{ readonly inspection: OsmPbfInspection; readonly extraction: OsmPowerExtraction }> => {
  const inspection = await inspectOsmPbf(path)
  assertOsmPbfPin(inspection, validateOsmPbfPin(pin))
  const extraction = await extractOsmPower(path, source)
  const after = await stat(path)
  if (after.size !== inspection.byteLength || after.mtimeMs !== inspection.modifiedAtMs) {
    throw new Error(`osm-pbf-power: ${path} changed during extraction`)
  }
  return { inspection, extraction }
}

export const osmPbfPowerSource = (config: OsmPbfPowerSourceConfig): DatasetSource => {
  const pin = validateOsmPbfPin(config.pin)
  return {
    kind: 'local',
    id: asSourceId(config.id),
    load: async (): Promise<LocalSourceLoad> => {
      const { inspection, extraction } = await extractPinnedOsmPower(config.path, pin, config.id)
      return { features: extraction.features, snapshot: snapshotOfInspection(inspection) }
    },
  }
}
