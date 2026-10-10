import { z } from 'zod'
import type { GridModelV2 } from '../schemas/grid-model.ts'
import type { TopologyBranch, TopologyHvdcLink } from '../topology/result.ts'
import { roundLonLat, simplifyPath, type LonLat } from './geo.ts'
import { corridorPath } from './paths.ts'
import type { SidecarFeatures } from './sidecar-features.ts'

// Line, cable and HVDC geometry for the live map (lane ML1): one ordered path per branch from its
// from-bus to its to-bus, Douglas–Peucker simplified. Transformers have no geometry.

export const geometrySimplificationMeters = 50

const pathSchema = z.array(z.tuple([z.number().finite(), z.number().finite()])).min(2)
export const gridGeometrySchema = z.object({
  schemaVersion: z.literal(1),
  modelId: z.string().min(1),
  sourceBuildId: z.string().min(1),
  simplificationMeters: z.literal(geometrySimplificationMeters),
  branches: z.array(z.object({ id: z.string().min(1), path: pathSchema }).strict()),
  hvdcLinks: z.array(z.object({ id: z.string().min(1), path: pathSchema }).strict()),
}).strict()
export type GridGeometry = z.infer<typeof gridGeometrySchema>

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
  const path = (id: string, featureIds: ReadonlyArray<string>, fromBusId: string, toBusId: string): ReadonlyArray<readonly [number, number]> | undefined => {
    const ways = featureIds.map(featureId => {
      const way = config.sidecar.way(featureId)
      if (way === undefined) throw new Error(`${id}: way ${featureId} is not a line or cable of the sidecar`)
      return way
    })
    const ordered = corridorPath(ways, busLocation.get(fromBusId)!, busLocation.get(toBusId)!)
    if (ordered === undefined) {
      unresolved.push(id)
      return undefined
    }
    return simplifyPath(ordered, geometrySimplificationMeters).map(roundLonLat)
  }
  const branches = config.model.branches.flatMap(branch => {
    if (branch.kind === 'transformer') return []
    const curated = config.curatedPaths.get(branch.id)
    if (curated !== undefined) return [{ id: branch.id, path: simplifyPath(curated, geometrySimplificationMeters).map(roundLonLat) }]
    const source = topologyBranch.get(branch.id)
    if (source === undefined) throw new Error(`${branch.id} has neither topology ways nor a curated path`)
    const result = path(branch.id, source.sourceFeatureIds, branch.fromBusId, branch.toBusId)
    return result === undefined ? [] : [{ id: branch.id, path: result }]
  })
  const hvdcLinks = config.model.hvdcLinks.flatMap(link => {
    const source = topologyLink.get(link.id)
    if (source === undefined) throw new Error(`${link.id} has no topology ways`)
    const result = path(link.id, source.sourceFeatureIds, link.fromBusId, link.toBusId)
    return result === undefined ? [] : [{ id: link.id, path: result }]
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
