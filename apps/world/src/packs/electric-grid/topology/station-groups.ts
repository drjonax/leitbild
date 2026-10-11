import { haversineKm, pointInStationPolygon, type LonLat } from './geometry.ts'
import { compareText, stationToken } from './ids.ts'
import type { TopologyLedger } from './ledger.ts'
import type { TopologyOptions } from './options.ts'
import type { TopologyStationInput } from './input.ts'
import type { StationContainer, StationIndex } from './station-index.ts'

// A station: one or more station features unified only by site/substation relation membership or
// polygon containment. Name similarity never unifies stations (it is reported instead).
export type StationGroup = {
  readonly id: string                         // osm-<type>-<id> of the representative feature
  readonly representative: StationContainer
  readonly members: ReadonlyArray<StationContainer>
  readonly kind: 'substation' | 'plant'
  readonly label: string
  readonly location: LonLat
  readonly taggedVoltagesKv: ReadonlySet<number>
  readonly roles: ReadonlyArray<string>
}

export type StationGroups = {
  readonly groups: ReadonlyArray<StationGroup>
  readonly groupOf: (container: StationContainer) => StationGroup
  readonly groupById: ReadonlyMap<string, StationGroup>
  readonly groupByFeatureId: ReadonlyMap<string, StationGroup>
}

const createUnionFind = (size: number) => {
  const parent = Array.from({ length: size }, (_, index) => index)
  const find = (value: number): number => {
    let root = value
    while (parent[root] !== root) root = parent[root]!
    let cursor = value
    while (parent[cursor] !== root) {
      const next = parent[cursor]!
      parent[cursor] = root
      cursor = next
    }
    return root
  }
  const union = (left: number, right: number): void => {
    const a = find(left)
    const b = find(right)
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b)
  }
  return { find, union }
}

// B lies in A when B's anchor (centroid or node) is inside A's polygon and B is smaller.
const containedIn = (inner: StationContainer, outer: StationContainer): boolean =>
  inner.index !== outer.index &&
  outer.station.geometry.type !== 'Point' &&
  inner.areaKm2 < outer.areaKm2 &&
  pointInStationPolygon(inner.anchor, outer.station.geometry)

const compareRepresentative = (left: StationContainer, right: StationContainer): number =>
  (left.station.kind === 'substation' ? 0 : 1) - (right.station.kind === 'substation' ? 0 : 1) ||
  right.areaKm2 - left.areaKm2 ||
  compareText(left.station.featureId, right.station.featureId)

const normaliseVoltage = (equivalents: TopologyOptions['equivalentVoltagesKv']) => (kv: number): number =>
  equivalents.find(entry => entry.fromKv === kv)?.toKv ?? kv

export const groupStations = (
  index: StationIndex,
  siteRelations: ReadonlyArray<TopologyStationInput>,
  options: TopologyOptions,
  ledger: TopologyLedger,
): StationGroups => {
  const containers = index.containers
  const unionFind = createUnionFind(containers.length)
  const byFeatureId = new Map(containers.map(container => [container.station.featureId, container]))
  const normalise = normaliseVoltage(options.equivalentVoltagesKv)

  for (const container of containers) {
    for (const memberId of container.station.memberFeatureIds) {
      const member = byFeatureId.get(memberId)
      if (member) unionFind.union(container.index, member.index)
    }
  }
  for (const relation of siteRelations) {
    const members = relation.memberFeatureIds.flatMap(memberId => byFeatureId.get(memberId) ?? [])
    for (const member of members.slice(1)) unionFind.union(members[0]!.index, member.index)
  }
  const plantContents = new Map<number, StationContainer[]>()
  for (const inner of containers) {
    for (const outer of index.containing(inner.anchor)) {
      if (!containedIn(inner, outer)) continue
      if (outer.station.kind === 'plant' && inner.station.kind === 'substation') {
        const list = plantContents.get(outer.index)
        if (list) list.push(inner)
        else plantContents.set(outer.index, [inner])
      } else {
        unionFind.union(inner.index, outer.index)
      }
    }
  }
  // A plant joins the station it contains; a plant site holding several stations stays apart.
  for (const [plantIndex, inner] of plantContents) {
    const roots = [...new Set(inner.map(container => unionFind.find(container.index)))]
    if (roots.length === 1) {
      unionFind.union(plantIndex, roots[0]!)
      continue
    }
    const plant = containers[plantIndex]!
    ledger.add({
      reason: 'plant-contains-multiple-stations',
      elementIds: [plant.station.featureId, ...inner.map(container => container.station.featureId)],
      location: plant.anchor,
      detail: `plant polygon contains ${roots.length} separate stations; the plant is kept as its own terminal`,
    })
  }

  const membersByRoot = new Map<number, StationContainer[]>()
  for (const container of containers) {
    const root = unionFind.find(container.index)
    const list = membersByRoot.get(root)
    if (list) list.push(container)
    else membersByRoot.set(root, [container])
  }
  const groupByRoot = new Map<number, StationGroup>()
  for (const [root, members] of membersByRoot) {
    const sorted = [...members].sort(compareRepresentative)
    const representative = sorted[0]!
    const named = sorted.find(member => member.station.name !== null)
    groupByRoot.set(root, {
      id: stationToken(representative.station.featureId),
      representative,
      members: [...members].sort((left, right) => compareText(left.station.featureId, right.station.featureId)),
      kind: representative.station.kind,
      label: named?.station.name ?? `Unnamed ${representative.station.kind} ${representative.station.featureId}`,
      location: representative.anchor,
      taggedVoltagesKv: new Set(members.flatMap(member => member.station.voltagesKv.map(normalise))),
      roles: [...new Set(members.flatMap(member => member.station.role ? [member.station.role] : []))].sort(compareText),
    })
  }
  const groups = [...groupByRoot.values()].sort((left, right) => compareText(left.id, right.id))
  const groupOf = (container: StationContainer): StationGroup => groupByRoot.get(unionFind.find(container.index))!
  return {
    groups,
    groupOf,
    groupById: new Map(groups.map(group => [group.id, group])),
    groupByFeatureId: new Map(containers.map(container => [container.station.featureId, groupOf(container)])),
  }
}

const genericStationWords = /\b(trafostasjon|transformatorstasjon|transformator stasjon|koblingsstasjon|koblingspunkt|kraftstasjon|kraftverk|stasjon|transformatorstation|ställverk|station|substation)\b/g

const baseName = (name: string): string =>
  name.toLowerCase().replace(/\(.*?\)/g, ' ').replace(genericStationWords, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

// Report (never merge) distinct stations that share a base name and lie close together.
export const reportSameNameStations = (
  groups: ReadonlyArray<StationGroup>,
  usedGroupIds: ReadonlySet<string>,
  options: TopologyOptions,
  ledger: TopologyLedger,
): void => {
  const byName = new Map<string, StationGroup[]>()
  for (const group of groups) {
    if (!usedGroupIds.has(group.id) || !group.representative.station.name) continue
    const key = baseName(group.label)
    if (!key) continue
    const list = byName.get(key)
    if (list) list.push(group)
    else byName.set(key, [group])
  }
  for (const [name, list] of byName) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i]!
        const b = list[j]!
        const distanceKm = haversineKm(a.location, b.location)
        if (distanceKm > options.sameNameReportKm) continue
        ledger.add({
          reason: 'same-name-nearby-stations',
          elementIds: [a.representative.station.featureId, b.representative.station.featureId],
          location: a.location,
          stationId: a.id,
          distanceM: distanceKm * 1000,
          detail: `stations ${a.id} and ${b.id} share the base name "${name}"; not unified (no site relation or containment)`,
        })
      }
    }
  }
}
