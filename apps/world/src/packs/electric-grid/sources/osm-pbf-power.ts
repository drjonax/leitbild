import { access, mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  asSourceId,
  type DatasetSource,
  type GeoJsonPosition,
  type NormalizedFeature,
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
import { readOsmPbf, type OsmRelationMember, type OsmTags } from './osm-pbf-reader.ts'
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

export interface OsmPbfPowerSourceConfig {
  readonly id?: string
  readonly path: string
  readonly downloadUrl?: string
  readonly userAgent?: string
  readonly fetchFn?: typeof fetch
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

const DEFAULT_USER_AGENT = 'Leitbild/0.1 (https://leitbild.leitbild.app)'
const AREA_CATEGORIES: ReadonlySet<GridReferenceCategory> = new Set(['substation', 'plant', 'generator'])
const RELATION_CATEGORIES: ReadonlySet<GridReferenceCategory> = new Set(['substation', 'plant', 'generator', 'transformer', 'circuit'])

const relationKindOf = (tags: OsmTags): OsmPowerKind | null =>
  isPowerCircuitRelation(tags) ? { category: 'circuit', lifecycle: lifecycleOfTagged(tags) } : powerKindOf(tags)

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

const hasFile = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const ensureLocalPbf = async (config: OsmPbfPowerSourceConfig): Promise<void> => {
  if (await hasFile(config.path)) return
  if (!config.downloadUrl) {
    throw new Error(`osm-pbf-power: source file does not exist and no downloadUrl was configured: ${config.path}`)
  }
  await mkdir(dirname(config.path), { recursive: true })
  const fetchFn = config.fetchFn ?? fetch
  const response = await fetchFn(config.downloadUrl, {
    headers: { 'user-agent': config.userAgent ?? DEFAULT_USER_AGENT },
  })
  if (!response.ok || !response.body) {
    throw new Error(`osm-pbf-power: failed to download ${config.downloadUrl}: HTTP ${response.status}`)
  }
  const tmpPath = `${config.path}.download`
  await Bun.write(Bun.file(tmpPath), response)
  await rename(tmpPath, config.path)
}

export const osmPbfPowerSource = (config: OsmPbfPowerSourceConfig): DatasetSource => {
  const id = config.id ?? 'osm:pbf-power:NO'
  return {
    kind: 'local',
    id: asSourceId(id),
    load: async (): Promise<ReadonlyArray<NormalizedFeature>> => {
      await ensureLocalPbf(config)
      return (await extractOsmPower(config.path, id)).features
    },
  }
}
