import type { GeoJsonGeometry, GeoJsonPosition, NormalizedFeature } from '../../reference-data/types.ts'
import { gridReferenceFeatureSchema, type GridReferenceFeatureProperties } from './schemas/grid-reference.ts'

export interface GridReferenceNode {
  readonly id: string
  readonly externalId: string
  readonly category: 'substation' | 'transformer' | 'plant' | 'generator'
  readonly label: string
  readonly lon: number
  readonly lat: number
  readonly voltageKv: ReadonlyArray<number>
  readonly source: string
  readonly confidence: GridReferenceFeatureProperties['confidence']
}

export interface GridReferenceBranch {
  readonly id: string
  readonly externalId: string
  readonly category: 'line' | 'cable' | 'transformer'
  readonly label: string
  readonly fromNodeId: string | null
  readonly toNodeId: string | null
  readonly endpointDistanceKm: readonly [number | null, number | null]
  readonly lengthKm: number
  readonly voltageKv: ReadonlyArray<number>
  readonly source: string
  readonly confidence: GridReferenceFeatureProperties['confidence']
}

export interface GridReferenceGraphAudit {
  readonly nodeCount: number
  readonly branchCount: number
  readonly unresolvedBranchEndpointCount: number
  readonly lowConfidenceFeatureCount: number
  readonly voltageMissingCount: number
  readonly warnings: ReadonlyArray<string>
}

export interface GridReferenceGraph {
  readonly nodes: ReadonlyArray<GridReferenceNode>
  readonly branches: ReadonlyArray<GridReferenceBranch>
  readonly audit: GridReferenceGraphAudit
}

const sanitizeId = (prefix: string, externalId: string): string =>
  `${prefix}:${externalId.replace(/[^a-zA-Z0-9:_-]+/g, '-')}`

const positionOf = (geometry: GeoJsonGeometry): readonly [number, number] | null => {
  if (geometry.type === 'Point') return [geometry.coordinates[0], geometry.coordinates[1]]
  if (geometry.type === 'Polygon') {
    const ring = geometry.coordinates[0] ?? []
    const unique = ring.length > 1 ? ring.slice(0, -1) : ring
    if (unique.length === 0) return null
    const sum = unique.reduce((acc, coordinate) => ({
      lon: acc.lon + coordinate[0],
      lat: acc.lat + coordinate[1],
    }), { lon: 0, lat: 0 })
    return [sum.lon / unique.length, sum.lat / unique.length]
  }
  if (geometry.type === 'LineString' && geometry.coordinates.length > 0) {
    const first = geometry.coordinates[0]!
    return [first[0], first[1]]
  }
  if (geometry.type === 'MultiPolygon') {
    const first = geometry.coordinates[0]?.[0]?.[0]
    return first ? [first[0], first[1]] : null
  }
  return null
}

const lineCoordinates = (geometry: GeoJsonGeometry): ReadonlyArray<GeoJsonPosition> =>
  geometry.type === 'LineString' ? geometry.coordinates : []

const haversineKm = (a: readonly [number, number], b: readonly [number, number]): number => {
  const radiusKm = 6371
  const toRad = (value: number): number => value * Math.PI / 180
  const dLat = toRad(b[1] - a[1])
  const dLon = toRad(b[0] - a[0])
  const lat1 = toRad(a[1])
  const lat2 = toRad(b[1])
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * radiusKm * Math.asin(Math.min(1, Math.sqrt(h)))
}

const lineLengthKm = (coordinates: ReadonlyArray<GeoJsonPosition>): number => {
  let length = 0
  for (let index = 1; index < coordinates.length; index += 1) {
    const prev = coordinates[index - 1]!
    const next = coordinates[index]!
    length += haversineKm([prev[0], prev[1]], [next[0], next[1]])
  }
  return length
}

const voltageCompatible = (
  branchVoltageKv: ReadonlyArray<number>,
  nodeVoltageKv: ReadonlyArray<number>,
): boolean => {
  if (branchVoltageKv.length === 0 || nodeVoltageKv.length === 0) return true
  return branchVoltageKv.some(branchVoltage =>
    nodeVoltageKv.some(nodeVoltage => Math.abs(nodeVoltage - branchVoltage) < 0.5))
}

const nearestNode = (
  nodes: ReadonlyArray<GridReferenceNode>,
  coordinate: readonly [number, number],
  branchVoltageKv: ReadonlyArray<number>,
  maxDistanceKm: number,
): { readonly nodeId: string | null; readonly distanceKm: number | null } => {
  let best: { readonly nodeId: string; readonly distanceKm: number } | null = null
  for (const node of nodes) {
    if (!voltageCompatible(branchVoltageKv, node.voltageKv)) continue
    const distanceKm = haversineKm(coordinate, [node.lon, node.lat])
    if (distanceKm > maxDistanceKm) continue
    if (!best || distanceKm < best.distanceKm) best = { nodeId: node.id, distanceKm }
  }
  return best ? { nodeId: best.nodeId, distanceKm: best.distanceKm } : { nodeId: null, distanceKm: null }
}

const parseFeatures = (
  features: ReadonlyArray<NormalizedFeature>,
): ReadonlyArray<{
  readonly feature: NormalizedFeature
  readonly properties: GridReferenceFeatureProperties
}> =>
  features.flatMap(feature => {
    const parsed = gridReferenceFeatureSchema.safeParse(feature.properties)
    return parsed.success ? [{ feature, properties: parsed.data }] : []
  })

const nodeFromFeature = (
  feature: NormalizedFeature,
  properties: GridReferenceFeatureProperties,
): GridReferenceNode | null => {
  if (properties.category !== 'substation' && properties.category !== 'transformer' && properties.category !== 'plant' && properties.category !== 'generator') return null
  const position = positionOf(feature.geometry)
  if (!position) return null
  return {
    id: sanitizeId('grid-node', properties.externalId),
    externalId: properties.externalId,
    category: properties.category,
    label: properties.name ?? properties.externalId,
    lon: position[0],
    lat: position[1],
    voltageKv: properties.voltageKv,
    source: properties.source,
    confidence: properties.confidence,
  }
}

export const compileGridReferenceGraph = (
  features: ReadonlyArray<NormalizedFeature>,
  options?: {
    readonly maxEndpointDistanceKm?: number
  },
): GridReferenceGraph => {
  const parsed = parseFeatures(features)
  const nodes = parsed.flatMap(item => {
    const node = nodeFromFeature(item.feature, item.properties)
    return node ? [node] : []
  })
  const maxEndpointDistanceKm = options?.maxEndpointDistanceKm ?? 8
  const branches = parsed.flatMap(item => {
    if (item.properties.category !== 'line' && item.properties.category !== 'cable' && item.properties.category !== 'transformer') return []
    const coordinates = lineCoordinates(item.feature.geometry)
    if (coordinates.length < 2) return []
    const first = coordinates[0]!
    const last = coordinates[coordinates.length - 1]!
    const from = nearestNode(nodes, [first[0], first[1]], item.properties.voltageKv, maxEndpointDistanceKm)
    const to = nearestNode(nodes, [last[0], last[1]], item.properties.voltageKv, maxEndpointDistanceKm)
    return [{
      id: sanitizeId('grid-branch', item.properties.externalId),
      externalId: item.properties.externalId,
      category: item.properties.category,
      label: item.properties.name ?? item.properties.externalId,
      fromNodeId: from.nodeId,
      toNodeId: to.nodeId,
      endpointDistanceKm: [from.distanceKm, to.distanceKm] as const,
      lengthKm: lineLengthKm(coordinates),
      voltageKv: item.properties.voltageKv,
      source: item.properties.source,
      confidence: item.properties.confidence,
    }]
  })
  const unresolvedBranchEndpointCount = branches.reduce((count, branch) =>
    count + (branch.fromNodeId === null ? 1 : 0) + (branch.toNodeId === null ? 1 : 0), 0)
  const lowConfidenceFeatureCount = parsed.filter(item => item.properties.confidence === 'low').length
  const voltageMissingCount = parsed.filter(item => item.properties.voltageKv.length === 0).length
  const warnings = [
    ...(unresolvedBranchEndpointCount > 0 ? [`${unresolvedBranchEndpointCount} branch endpoint(s) could not be snapped to a compatible node`] : []),
    ...(voltageMissingCount > 0 ? [`${voltageMissingCount} feature(s) have no voltage tag and will need inferred/defaulted electrical properties`] : []),
    ...(lowConfidenceFeatureCount > 0 ? [`${lowConfidenceFeatureCount} feature(s) are low confidence`] : []),
  ]
  return {
    nodes,
    branches,
    audit: {
      nodeCount: nodes.length,
      branchCount: branches.length,
      unresolvedBranchEndpointCount,
      lowConfidenceFeatureCount,
      voltageMissingCount,
      warnings,
    },
  }
}
