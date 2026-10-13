import type { GridGeometryArtifact, GridGeometrySource } from '../schemas/grid-geometry.ts'
import type { GridModelV2 } from '../schemas/grid-model.ts'
import { compareText } from '../topology/ids.ts'
import type { TopologyBoundary, TopologyBranch, TopologyHvdcLink } from '../topology/result.ts'
import { roundLonLat, simplifyPath, type LonLat } from './geo.ts'
import type { ContinuedRoute } from './interconnector-continuations.ts'
import { corridorPath } from './paths.ts'
import type { SidecarFeatures } from './sidecar-features.ts'

// Map geometry for the live map (schemas/grid-geometry.ts): one path per branch and HVDC link,
// ordered from its from-bus to its to-bus and Douglas–Peucker simplified. Lines and cables follow
// their mapped ways; transformers, and the corridors whose ways do not chain (listed in the ledger
// summary as geometryUnresolved), draw from bus to bus. An interconnector follows its own mapped
// route to where it leaves the source extract, then on along its continuation abroad
// (interconnector-continuations.ts) to the station it reaches; a boundary bus is drawn at the
// station of the first of its interconnectors. Never framed to the boundary bus: that would draw a
// straight line that no way follows.

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
  readonly boundaries: ReadonlyArray<TopologyBoundary>
  readonly curatedPaths: ReadonlyMap<string, ReadonlyArray<LonLat>>
  readonly sidecar: SidecarFeatures
  /** Each interconnector's route beyond the extract, by interconnector id. */
  readonly continuations: ReadonlyMap<string, ContinuedRoute>
  /** The systems whose interconnectors are continued; the others end where the extract does. */
  readonly continuedSystems: ReadonlySet<'hvdc' | 'ac'>
  /** The sources of the continuations: data the map draws beyond the model's own. */
  readonly sources: ReadonlyArray<GridGeometrySource>
}): GeometryOutcome => {
  const busLocation = new Map(config.model.buses.map(bus => [bus.id, bus.location]))
  const topologyBranch = new Map(config.branches.map(branch => [branch.id, branch]))
  const topologyLink = new Map(config.hvdcLinks.map(link => [link.id, link]))
  const unresolved: string[] = []
  const path = (id: string, featureIds: ReadonlyArray<string>, from: LonLat, to: LonLat, beyond: ReadonlyArray<LonLat>): ReadonlyArray<readonly [number, number]> | undefined => {
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
    // The continuation starts at the free end, which closes the ordered path.
    return simplifyPath([...ordered, ...beyond.slice(1)], geometrySimplificationMeters).map(roundLonLat)
  }
  const continuation = (interconnectorId: string, system: 'hvdc' | 'ac'): ReadonlyArray<LonLat> => {
    if (!config.continuedSystems.has(system)) return []
    const route = config.continuations.get(interconnectorId)
    if (route === undefined) throw new Error(`${interconnectorId} has no continuation beyond the extract`)
    return route.path
  }
  const busToBus = (fromBusId: string, toBusId: string) => [busLocation.get(fromBusId)!, busLocation.get(toBusId)!].map(roundLonLat)
  const branches = config.model.branches.map(branch => {
    if (branch.kind === 'transformer') return { id: branch.id, path: busToBus(branch.fromBusId, branch.toBusId) }
    const curated = config.curatedPaths.get(branch.id)
    if (curated !== undefined) return { id: branch.id, path: simplifyPath(curated, geometrySimplificationMeters).map(roundLonLat) }
    const source = topologyBranch.get(branch.id)
    if (source === undefined) throw new Error(`${branch.id} has neither topology ways nor a curated path`)
    const from = busLocation.get(branch.fromBusId)!
    const drawn = source.foreignEnd === null || source.interconnectorId === null
      ? path(branch.id, source.sourceFeatureIds, from, busLocation.get(branch.toBusId)!, [])
      : path(branch.id, source.sourceFeatureIds, from, source.foreignEnd.location, continuation(source.interconnectorId, 'ac'))
    return { id: branch.id, path: drawn ?? busToBus(branch.fromBusId, branch.toBusId) }
  })
  const hvdcLinks = config.model.hvdcLinks.flatMap(link => {
    const source = topologyLink.get(link.id)
    if (source === undefined) throw new Error(`${link.id} has no topology ways`)
    return [{ id: link.id, path: path(link.id, source.sourceFeatureIds, busLocation.get(link.fromBusId)!, source.foreignEnd.location, continuation(link.id, 'hvdc')) ?? busToBus(link.fromBusId, link.toBusId) }]
  })
  // A boundary bus of a continued system is drawn at the station the first of its interconnectors reaches.
  const boundaryBuses = [...config.boundaries]
    .filter(boundary => config.continuedSystems.has(boundary.kind))
    .sort((left, right) => compareText(left.busId, right.busId))
    .map(boundary => {
      const first = [...boundary.interconnectorIds].sort(compareText)[0]
      const route = first === undefined ? undefined : config.continuations.get(first)
      if (route === undefined) throw new Error(`boundary bus ${boundary.busId} has no interconnector continued to a station`)
      return { id: boundary.busId, location: roundLonLat(route.station.location) as [number, number], station: { osmId: route.station.osmId, name: route.station.name } }
    })
  return {
    geometry: {
      schemaVersion: 1,
      modelId: config.model.id,
      sourceBuildId: config.model.sourceBuild.id,
      simplificationMeters: geometrySimplificationMeters,
      routes: 'mapped',
      sources: [...config.sources],
      branches: branches.map(entry => ({ id: entry.id, path: entry.path.map(point => [point[0], point[1]] as [number, number]) })),
      hvdcLinks: hvdcLinks.map(entry => ({ id: entry.id, path: entry.path.map(point => [point[0], point[1]] as [number, number]) })),
      boundaryBuses,
    },
    unresolved,
  }
}
