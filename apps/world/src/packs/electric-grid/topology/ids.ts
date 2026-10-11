import { createHash } from 'node:crypto'
import type { TopologyKeyMode } from './input.ts'

// Id grammar of Grid Model v2 (plan, "Target architecture"): ids derive from source identity only.

export const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

export const formatKv = (kv: number): string => {
  if (!Number.isFinite(kv) || kv <= 0) throw new Error(`topology ids: invalid voltage ${kv}`)
  return String(kv)
}

const osmFeatureIdPattern = /^(node|way|relation)\/(\d+)$/

// 'way/60495669' → 'osm-way-60495669'
export const stationToken = (featureId: string): string => {
  const match = osmFeatureIdPattern.exec(featureId)
  if (!match) throw new Error(`topology ids: station feature id is not an OSM id: ${featureId}`)
  return `osm-${match[1]}-${match[2]}`
}

export const stationBusId = (stationId: string, kv: number): string => `bus:${stationId}@${formatKv(kv)}`

const coordinateKeyPattern = /^(-?\d+\.\d+),(-?\d+\.\d+)$/
const nodeKeyPattern = /^\d+$/

export const junctionToken = (keyMode: TopologyKeyMode, vertexKey: string): string => {
  if (keyMode === 'osm-node') {
    if (!nodeKeyPattern.test(vertexKey)) throw new Error(`topology ids: OSM node key is not numeric: ${vertexKey}`)
    return `osm-node-${vertexKey}`
  }
  const match = coordinateKeyPattern.exec(vertexKey)
  if (!match) throw new Error(`topology ids: coordinate key is malformed: ${vertexKey}`)
  return `coordinate-${match[1]}_${match[2]}`
}

export const junctionBusId = (keyMode: TopologyKeyMode, vertexKey: string, kv: number): string =>
  `bus:junction-${junctionToken(keyMode, vertexKey)}@${formatKv(kv)}`

export const acBoundaryBusId = (area: string, kv: number): string => `bus:boundary-${area}@${formatKv(kv)}`
export const hvdcBoundaryBusId = (area: string): string => `bus:boundary-${area}`

// 16 hex digits (64 bits) of SHA-256; collisions are detected by the compiler and fail the build.
const shortHash = (material: string): string => createHash('sha256').update(material).digest('hex').slice(0, 16)

export const corridorBranchId = (
  kv: number,
  osmWayIds: ReadonlyArray<string>,
  endBusIds: readonly [string, string],
): string => {
  const ways = [...new Set(osmWayIds)].sort(compareText)
  const ends = [...endBusIds].sort(compareText)
  return `branch:osm-${shortHash(`${formatKv(kv)}|${ways.join(',')}|${ends.join(',')}`)}`
}

export const transformerBranchId = (stationId: string, highKv: number, lowKv: number): string =>
  `branch:transformer-${stationId}-${formatKv(highKv)}-${formatKv(lowKv)}`
