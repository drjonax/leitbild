import type { GridGeometryArtifact } from '../schemas/grid-geometry.ts'
import type { GridModelV2 } from '../schemas/grid-model.ts'
import type { TopologyBranch, TopologyHvdcLink } from '../topology/result.ts'
import { roundLonLat, simplifyPath, type LonLat } from './geo.ts'
import { corridorPath } from './paths.ts'
import type { SidecarFeatures } from './sidecar-features.ts'

// Map geometry for the live map (schemas/grid-geometry.ts): one path per branch and HVDC link,
// ordered from its from-bus to its to-bus and Douglas–Peucker simplified. Lines and cables follow
// their mapped ways; transformers, and the corridors whose ways do not chain (listed in the ledger
// summary as geometryUnresolved), draw from bus to bus. An interconnector ends where its own mapped
// route leaves the source extract: a boundary bus stands at the first of its interconnectors' ends,
// and framing the others to it would draw a straight line that no way follows.

export const geometrySimplificationMeters = 50

export type GridGeometry = GridGeometryArtifact

export interface GeometryOutcome {
  readonly geometry: GridGeometry
  /** Branch and link ids whose mapped ways do not chain from one end to the other. */
  readonly unresolved: ReadonlyArray<string>
}

export const buildGeometry = (config: {
  readonly model: GridModelV2
  readonly branches: ReadonlyArray<TopologyBranch>
  readonly hvdcLinks: ReadonlyArray<TopologyHvdcLink>
  readonly curatedPaths: ReadonlyMap<string, ReadonlyArray<LonLat>>
  readonly sidecar: SidecarFeatures
}): GeometryOutcome => {
  const busLocation = new Map(config.model.buses.map(bus => [bus.id, bus.location]))
  const topologyBranch = new Map(config.branches.map(branch => [branch.id, branch]))
  const topologyLink = new Map(config.hvdcLinks.map(link => [link.id, link]))
  const unresolved: string[] = []
  const path = (id: string, featureIds: ReadonlyArray<string>, from: LonLat, to: LonLat): ReadonlyArray<readonly [number, number]> | undefined => {
    const ways = featureIds.map(featureId => {
      const way = config.sidecar.way(featureId)
      if (way === undefined) throw new Error(`${id}: way ${featureId} is not a line or cable of the sidecar`)
      return way
    })
    const ordered = corridorPath(ways, from, to)
    if (ordered === undefined) {
      unresolved.push(id)
      return undefined
    }
    return simplifyPath(ordered, geometrySimplificationMeters).map(roundLonLat)
  }
  const busToBus = (fromBusId: string, toBusId: string) => [busLocation.get(fromBusId)!, busLocation.get(toBusId)!].map(roundLonLat)
  const branches = config.model.branches.map(branch => {
    if (branch.kind === 'transformer') return { id: branch.id, path: busToBus(branch.fromBusId, branch.toBusId) }
    const curated = config.curatedPaths.get(branch.id)
    if (curated !== undefined) return { id: branch.id, path: simplifyPath(curated, geometrySimplificationMeters).map(roundLonLat) }
    const source = topologyBranch.get(branch.id)
    if (source === undefined) throw new Error(`${branch.id} has neither topology ways nor a curated path`)
    const to = source.foreignEnd ?? busLocation.get(branch.toBusId)!
    return { id: branch.id, path: path(branch.id, source.sourceFeatureIds, busLocation.get(branch.fromBusId)!, to) ?? busToBus(branch.fromBusId, branch.toBusId) }
  })
  const hvdcLinks = config.model.hvdcLinks.flatMap(link => {
    const source = topologyLink.get(link.id)
    if (source === undefined) throw new Error(`${link.id} has no topology ways`)
    return [{ id: link.id, path: path(link.id, source.sourceFeatureIds, busLocation.get(link.fromBusId)!, source.foreignEnd) ?? busToBus(link.fromBusId, link.toBusId) }]
  })
  return {
    geometry: {
      schemaVersion: 1,
      modelId: config.model.id,
      sourceBuildId: config.model.sourceBuild.id,
      simplificationMeters: geometrySimplificationMeters,
      branches: branches.map(entry => ({ id: entry.id, path: entry.path.map(point => [point[0], point[1]] as [number, number]) })),
      hvdcLinks: hvdcLinks.map(entry => ({ id: entry.id, path: entry.path.map(point => [point[0], point[1]] as [number, number]) })),
    },
    unresolved,
  }
}
