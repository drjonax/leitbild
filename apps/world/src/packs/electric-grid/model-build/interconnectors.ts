import type { GridOperatingPointV2 } from '../schemas/grid-operating-point.ts'
import type { GridExternalSystemV2, GridHvdcLinkV2, GridHvdcRampGroupV2 } from '../schemas/grid-model.ts'
import type { ExternalArea } from '../schemas/grid-ids.ts'
import { remainderAreaSchema, type GridInterconnectorTable } from '../schemas/grid-interconnector.ts'
import { compareText } from '../topology/ids.ts'
import type { TopologyInterconnectorTable } from '../topology/input.ts'
import type { TopologyBoundary, TopologyHvdcLink } from '../topology/result.ts'
import { v2OsmWayIds } from './network.ts'
import type { ModelSourceIds } from './sources.ts'

// The curated interconnector table → topology input, HVDC injection pairs and the external
// systems behind the boundary buses. Links not in service and the Russian border stay out (the
// golden list excludes Kirkenes – Boris Gleb; Grid Model v2 has no RU area).

export const topologyInterconnectors = (table: GridInterconnectorTable, sourceId: string): TopologyInterconnectorTable => ({
  sourceId,
  interconnectors: table.links.flatMap(link => {
    if (!link.inService || link.foreignArea === 'RU') return []
    return [{
      id: link.id,
      label: link.name,
      kind: link.kind,
      externalArea: link.foreignArea,
      voltageKv: link.kind === 'ac' ? link.nominalKv : link.dcKv,
      norwegianStationId: link.norwegianTerminal.osmId,
      osmWayIds: link.osmWayIds,
      sources: link.provenance.sources,
    }]
  }),
})

export const excludedInterconnectors = (table: GridInterconnectorTable): ReadonlyArray<{ readonly id: string; readonly reason: string }> =>
  table.links.flatMap(link => link.inService && link.foreignArea !== 'RU'
    ? []
    : [{ id: link.id, reason: link.statusNote ?? (link.inService ? `${link.foreignArea} is outside the model's external areas` : 'not in service') }])

export const buildHvdcLinks = (config: {
  readonly links: ReadonlyArray<TopologyHvdcLink>
  readonly table: GridInterconnectorTable
  readonly curationsOfLink: (link: TopologyHvdcLink) => ReadonlyArray<string>
  readonly sourceIds: ModelSourceIds
}): ReadonlyArray<GridHvdcLinkV2> => config.links.map((link): GridHvdcLinkV2 => {
  const entry = config.table.links.find(candidate => candidate.id === link.id)
  if (entry === undefined || entry.kind !== 'hvdc') throw new Error(`HVDC link ${link.id} is not an HVDC entry of the interconnector table`)
  const curations = config.curationsOfLink(link)
  return {
    id: link.id,
    label: link.label,
    fromBusId: link.fromBusId,
    toBusId: link.toBusId,
    ratingMw: entry.rating.mw,
    lossPercent: entry.lossPercentAtRated,
    rampMwPerMinute: entry.rampMwPerMinute,
    osmWayIds: v2OsmWayIds(link.osmWayIds),
    provenance: {
      sources: [config.sourceIds.osm, config.sourceIds.interconnectors, ...curations],
      method: 'curated',
      confidence: curations.length > 0 ? 'medium' : 'high',
      note: `${link.provenance.note ?? 'route mapped in OSM'}; rating ${entry.rating.mw} MW (${entry.rating.basis}), losses ${entry.lossPercentAtRated} % at rated transfer (${entry.lossBasis}), ramp ${entry.rampMwPerMinute} MW/min (${entry.rampBasis})`,
    },
  }
}).sort((left, right) => compareText(left.id, right.id))

/**
 * The table's shared HVDC ramp limits over the model's links. A group naming a link the model does
 * not carry (out of service) fails the build: the table must state the group of the links in service.
 */
export const buildHvdcRampGroups = (config: {
  readonly table: GridInterconnectorTable
  readonly links: ReadonlyArray<GridHvdcLinkV2>
  readonly sourceIds: ModelSourceIds
}): ReadonlyArray<GridHvdcRampGroupV2> => config.table.hvdcRampGroups.map((group): GridHvdcRampGroupV2 => {
  const missing = group.linkIds.filter(linkId => !config.links.some(link => link.id === linkId))
  if (missing.length > 0) throw new Error(`HVDC ramp group ${group.id} names ${missing.join(', ')}, which the model does not carry`)
  return {
    id: group.id,
    linkIds: [...group.linkIds].sort(compareText),
    rampMwPerMinute: group.rampMwPerMinute,
    provenance: { sources: [config.sourceIds.interconnectors], method: 'curated', confidence: 'high', note: group.basis },
  }
}).sort((left, right) => compareText(left.id, right.id))

/** The Nordic remainder's inertia and load in one of the table's synchronous cases, as an Operating Point state. */
export const nordicRemainderState = (config: {
  readonly table: GridInterconnectorTable
  readonly sourceIds: ModelSourceIds
  readonly synchronousCase: 'winterPeak' | 'summerLow'
}): NonNullable<GridOperatingPointV2['externalSystemStates']>[number] => {
  const nordic = config.table.externalSystems.find(system => system.area === 'nordic-remainder')
  if (nordic === undefined || nordic.cases === null) throw new Error('the interconnector table has no synchronous Nordic remainder')
  const values = nordic.cases[config.synchronousCase]
  return {
    assetId: 'external:nordic-remainder',
    inertiaGws: values.inertiaGws,
    loadMw: values.loadMw,
    provenance: { sources: [config.sourceIds.interconnectors], method: 'curated', confidence: nordic.provenance.confidence, note: `${config.synchronousCase} case: ${values.derivation}` },
  }
}

/** One synchronous Nordic remainder behind the AC boundaries, one external system per HVDC-only area. */
type NordicBoundaryArea = 'SE1' | 'SE2' | 'SE3' | 'FI'
const nordicBoundaryAreas: ReadonlyArray<NordicBoundaryArea> = ['FI', 'SE1', 'SE2', 'SE3']

/**
 * The share of the Nordic remainder's exchange entering Norway at each foreign area's boundary
 * buses (the table's boundaryParticipation method): every remainder area's mean share of the
 * remainder's kinetic energy over the published map hours passes towards Norway along its route,
 * split at each area between its Norwegian borders and its onward border by mean capacity.
 */
export const nordicAreaParticipation = (table: GridInterconnectorTable): ReadonlyArray<{ readonly area: NordicBoundaryArea; readonly share: number }> => {
  const nordic = table.externalSystems.find(system => system.area === 'nordic-remainder')
  const participation = nordic?.boundaryParticipation
  if (participation === undefined || participation === null) throw new Error('the interconnector table has no boundary participation for the Nordic remainder')
  const meanCapacity = (forwardMw: number, backwardMw: number): number => (forwardMw + backwardMw) / 2
  const norwegianCapacityMw = (border: string): number => {
    const entry = table.borderCapacities.find(candidate => candidate.border === border)
    if (entry === undefined) throw new Error(`boundary participation: no border capacity for ${border}`)
    return meanCapacity(entry.exportMw, entry.importMw)
  }
  const remainderCapacityMw = (border: string): number => {
    const entry = participation.remainderBorders.find(candidate => candidate.border === border)
    if (entry === undefined) throw new Error(`boundary participation: no remainder border ${border}`)
    return meanCapacity(entry.forwardMw, entry.backwardMw)
  }
  // Each hour's area shares normalised to the remainder, then averaged over the hours.
  const areas = remainderAreaSchema.options
  const weight = new Map(areas.map(area => [area, 0]))
  for (const hour of participation.kineticEnergyHours) {
    const total = areas.reduce((sum, area) => sum + hour.areaPercent[area], 0)
    for (const area of areas) weight.set(area, weight.get(area)! + hour.areaPercent[area] / total / participation.kineticEnergyHours.length)
  }
  const routeOf = new Map(participation.routes.map(route => [route.area, route]))
  if (routeOf.size !== areas.length) throw new Error('boundary participation needs one route per remainder area')
  // Areas in route order: every area after all areas that pass on to it (the routes form a tree towards Norway).
  const inflows = new Map(areas.map(area => [area, participation.routes.filter(route => route.onward?.area === area).length]))
  const pending = new Map(areas.map(area => [area, weight.get(area)!]))
  const shares = new Map<NordicBoundaryArea, number>()
  const ready = areas.filter(area => inflows.get(area) === 0)
  let processed = 0
  while (ready.length > 0) {
    const area = ready.shift()!
    processed += 1
    const route = routeOf.get(area)!
    const totalShare = pending.get(area)!
    if (route.onward === null && route.norwegianBorders.length === 0) throw new Error(`boundary participation: ${area} has no way to Norway`)
    const borderCapacities = route.norwegianBorders.map(norwegianCapacityMw)
    // Without a Norwegian border everything passes on, whatever the onward capacity.
    let onwardCapacityMw = Number.POSITIVE_INFINITY
    if (route.onward === null) onwardCapacityMw = 0
    else if (route.norwegianBorders.length > 0) {
      if (route.onward.border === null) throw new Error(`boundary participation: ${area} needs its onward border capacity beside Norwegian borders`)
      onwardCapacityMw = remainderCapacityMw(route.onward.border)
    }
    const outletMw = borderCapacities.reduce((sum, capacity) => sum + capacity, 0) + (Number.isFinite(onwardCapacityMw) ? onwardCapacityMw : 0)
    route.norwegianBorders.forEach((border, index) => {
      const foreign = border.slice(border.indexOf('-') + 1) as NordicBoundaryArea
      shares.set(foreign, (shares.get(foreign) ?? 0) + totalShare * borderCapacities[index]! / outletMw)
    })
    if (route.onward !== null) {
      const passed = Number.isFinite(onwardCapacityMw) ? totalShare * onwardCapacityMw / outletMw : totalShare
      const next = route.onward.area
      pending.set(next, pending.get(next)! + passed)
      inflows.set(next, inflows.get(next)! - 1)
      if (inflows.get(next) === 0) ready.push(next)
    }
  }
  if (processed !== areas.length) throw new Error('boundary participation routes contain a cycle')
  return nordicBoundaryAreas.map(area => {
    const share = shares.get(area)
    if (share === undefined) throw new Error(`boundary participation reaches no Norwegian border of ${area}`)
    return { area, share }
  })
}

export const buildExternalSystems = (config: {
  readonly boundaries: ReadonlyArray<TopologyBoundary>
  readonly table: GridInterconnectorTable
  readonly sourceIds: ModelSourceIds
  /** The table's synchronous case the model describes (winter peak reference hour). */
  readonly synchronousCase: 'winterPeak' | 'summerLow'
}): ReadonlyArray<GridExternalSystemV2> => {
  const systems: GridExternalSystemV2[] = []
  const acBuses = config.boundaries.filter(boundary => boundary.kind === 'ac').map(boundary => boundary.busId).sort(compareText)
  if (acBuses.length > 0) {
    const nordic = config.table.externalSystems.find(system => system.area === 'nordic-remainder')
    if (nordic === undefined || nordic.cases === null || nordic.loadDampingPercentPerHz === null) throw new Error('the interconnector table has no synchronous Nordic remainder')
    const values = nordic.cases[config.synchronousCase]
    const boundaryAreas = new Set(config.boundaries.filter(boundary => boundary.kind === 'ac').map(boundary => boundary.externalArea))
    const areaParticipation = nordicAreaParticipation(config.table)
    for (const area of boundaryAreas) {
      if (!areaParticipation.some(entry => entry.area === area)) throw new Error(`boundary participation has no share for ${area}`)
    }
    const participationNote = areaParticipation.map(entry => `${entry.area} ${(entry.share * 100).toFixed(1)} %`).join(', ')
    systems.push({
      id: 'external:nordic-remainder',
      label: nordic.label,
      area: 'nordic-remainder',
      synchronous: true,
      boundaryBusIds: acBuses,
      inertiaGws: values.inertiaGws,
      loadMw: values.loadMw,
      fcrNMwPerHz: values.fcrNMwPerHz,
      fcrDUpMw: values.fcrDUpMw,
      fcrDDownMw: values.fcrDDownMw,
      afrrUpMw: values.afrrUpMw,
      afrrDownMw: values.afrrDownMw,
      areaParticipation: areaParticipation.filter(entry => boundaryAreas.has(entry.area)).map(entry => ({ area: entry.area, share: entry.share })),
      provenance: {
        sources: [config.sourceIds.interconnectors],
        method: 'curated',
        confidence: nordic.provenance.confidence,
        note: `${config.synchronousCase} case: ${values.derivation} Exchange entering Norway by area (boundary participation): ${participationNote}.`,
      },
    })
  }
  const hvdcAreas = [...new Set(config.boundaries.filter(boundary => boundary.kind === 'hvdc').map(boundary => boundary.externalArea))].sort(compareText)
  for (const area of hvdcAreas) {
    const entry = config.table.externalSystems.find(system => system.area === area)
    if (entry === undefined || entry.synchronous) throw new Error(`the interconnector table has no HVDC-only external system for ${area}`)
    systems.push({
      id: `external:${area as ExternalArea}`,
      label: entry.label,
      area: area as ExternalArea,
      synchronous: false,
      boundaryBusIds: config.boundaries.filter(boundary => boundary.externalArea === area).map(boundary => boundary.busId).sort(compareText),
      provenance: { sources: [config.sourceIds.interconnectors], method: 'curated', confidence: entry.provenance.confidence, note: entry.provenance.note },
    })
  }
  return systems
}
