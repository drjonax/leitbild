import type { GridOperatingPointV2 } from '../schemas/grid-operating-point.ts'
import type { GridExternalSystemV2, GridHvdcLinkV2 } from '../schemas/grid-model.ts'
import type { ExternalArea } from '../schemas/grid-ids.ts'
import type { GridInterconnectorTable } from '../schemas/grid-interconnector.ts'
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
      provenance: {
        sources: [config.sourceIds.interconnectors],
        method: 'curated',
        confidence: nordic.provenance.confidence,
        note: `${config.synchronousCase} case: ${values.derivation}`,
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
