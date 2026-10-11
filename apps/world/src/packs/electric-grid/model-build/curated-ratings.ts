import type { GridCurationCollection } from '../schemas/grid-curation.ts'
import type { GridInterconnectorTable } from '../schemas/grid-interconnector.ts'
import { compareText } from '../topology/ids.ts'
import type { TopologyBranch } from '../topology/result.ts'
import { curationSourceId } from './curations.ts'
import { ambientRatingRule, emergencyRule, overheadLineRatings, type LineRatings } from './electrical.ts'
import type { BuildLedger } from './ledger.ts'
import { v2OsmWayIds, type CuratedTransformerRating, type RatedLine } from './network.ts'

// set-line-rating and set-transformer-rating curations: ratings a published document gives in
// place of the rule-inferred ones. Each record must find exactly one branch.

const sortedFeatures = (curations: GridCurationCollection) => [...curations.features].sort((left, right) => compareText(left.id, right.id))

/** reservedIds: lines another source rates (interconnector ties); a curation on one fails. */
export const withCuratedLineRatings = (lines: ReadonlyArray<RatedLine>, curations: GridCurationCollection, reservedIds: ReadonlySet<string>, ledger: BuildLedger): ReadonlyArray<RatedLine> => {
  const replaced = new Map<string, RatedLine>()
  for (const feature of sortedFeatures(curations)) {
    const properties = feature.properties
    if (properties.kind !== 'set-line-rating') continue
    const id = curationSourceId(feature)
    const ways = v2OsmWayIds(properties.wayOsmIds)
    const matches = lines.filter(line => line.branch.nominalKv === properties.voltageKv && ways.every(way => line.branch.osmWayIds.includes(way)))
    if (matches.length !== 1) throw new Error(`${id}: ${matches.length} ${properties.voltageKv} kV lines carry ${properties.wayOsmIds.join(', ')}; the record must name exactly one`)
    const line = matches[0]!
    if (replaced.has(line.branch.id) || reservedIds.has(line.branch.id)) throw new Error(`${id}: ${line.branch.id} already has a curated or interconnector rating`)
    if (line.branch.kind !== 'ac_line') throw new Error(`${id}: ${line.branch.id} is a ${line.branch.kind}; set-line-rating rates overhead lines`)
    const ratings = overheadLineRatings(properties.designRatingMva)
    ledger.add({
      reason: 'curated-rating-set',
      elementIds: [line.branch.id, id],
      mw: ratings.referenceMw,
      detail: `${line.branch.label}: ${line.branch.ratingMw} → ${ratings.referenceMw} MW (${properties.designRatingMva} MVA at design air): ${properties.reason}`,
    })
    replaced.set(line.branch.id, {
      ratings,
      branch: {
        ...line.branch,
        ratingMw: ratings.referenceMw,
        emergencyRatingMw: Math.round(ratings.referenceMw * emergencyRule.factor),
        provenance: {
          ...line.branch.provenance,
          sources: [...line.branch.provenance.sources, id],
          method: 'curated',
          note: `${line.branch.provenance.note ?? ''}${line.branch.provenance.note === undefined ? '' : '; '}rating ${properties.designRatingMva} MVA at design air by ${id}`,
        },
      },
    })
  }
  return lines.map(line => replaced.get(line.branch.id) ?? line)
}

/**
 * AC ties to a neighbour (a line with a boundary end) take the rating the interconnector table
 * publishes for their link instead of the conductor rule's. A published-rating (an operator's
 * per-line capacity, stated at 0 °C where the System Operation Agreement gives a temperature
 * table) scales to the summer air like an overhead line; a corridor-share, a system limit of
 * the border, holds in every season. Every in-service AC link must find exactly one tie.
 */
export const withInterconnectorRatings = (
  lines: ReadonlyArray<RatedLine>,
  table: GridInterconnectorTable,
  boundaryBusIds: ReadonlySet<string>,
  sourceId: string,
  ledger: BuildLedger,
): { readonly lines: ReadonlyArray<RatedLine>; readonly ratedIds: ReadonlySet<string> } => {
  const replaced = new Map<string, RatedLine>()
  for (const link of [...table.links].sort((left, right) => compareText(left.id, right.id))) {
    if (link.kind !== 'ac' || !link.inService) continue
    const ways = v2OsmWayIds(link.osmWayIds)
    const ties = lines.filter(line => (boundaryBusIds.has(line.branch.fromBusId) || boundaryBusIds.has(line.branch.toBusId))
      && line.branch.osmWayIds.some(way => ways.includes(way)))
    if (ties.length !== 1) throw new Error(`interconnector ${link.id}: ${ties.length} tie lines carry its ways ${link.osmWayIds.join(', ')}; expected one`)
    const tie = ties[0]!
    if (replaced.has(tie.branch.id)) throw new Error(`interconnector ${link.id}: ${tie.branch.id} already rated by another link`)
    const mw = link.rating.mw
    const ratings: LineRatings = link.rating.basis === 'published-rating'
      ? { referenceMw: mw, designMw: Math.round(mw / ambientRatingRule.referenceFactor), summerMw: Math.round(mw * ambientRatingRule.summerFactor / ambientRatingRule.referenceFactor) }
      : { referenceMw: mw, designMw: mw, summerMw: mw }
    ledger.add({
      reason: 'curated-rating-set',
      elementIds: [tie.branch.id, link.id],
      mw,
      detail: `${tie.branch.label}: ${tie.branch.ratingMw} → ${mw} MW, the ${link.rating.basis} of ${link.name} in the interconnector table`,
    })
    replaced.set(tie.branch.id, {
      ratings,
      branch: {
        ...tie.branch,
        ratingMw: ratings.referenceMw,
        emergencyRatingMw: Math.round(ratings.referenceMw * emergencyRule.factor),
        provenance: {
          ...tie.branch.provenance,
          sources: [...tie.branch.provenance.sources, sourceId],
          method: 'curated',
          note: `${tie.branch.provenance.note ?? ''}${tie.branch.provenance.note === undefined ? '' : '; '}rating ${mw} MW: the ${link.rating.basis} of ${link.id} (${link.rating.note})`,
        },
      },
    })
  }
  return { lines: lines.map(line => replaced.get(line.branch.id) ?? line), ratedIds: new Set(replaced.keys()) }
}

export interface CuratedTransformerRatings {
  readonly of: (branch: TopologyBranch) => CuratedTransformerRating | undefined
  /** Fails on a record that rated no transformer. */
  readonly assertAllApplied: () => void
}

export const curatedTransformerRatings = (curations: GridCurationCollection, stationOfFeature: (featureId: string) => string | undefined): CuratedTransformerRatings => {
  const byKey = new Map<string, CuratedTransformerRating>()
  for (const feature of sortedFeatures(curations)) {
    const properties = feature.properties
    if (properties.kind !== 'set-transformer-rating') continue
    const id = curationSourceId(feature)
    const stationId = stationOfFeature(properties.substationOsmId)
    if (stationId === undefined) throw new Error(`${id}: ${properties.substationOsmId} is not a station of the topology`)
    const key = `bus:${stationId}@${properties.highKv}|bus:${stationId}@${properties.lowKv}`
    if (byKey.has(key)) throw new Error(`${id}: ${properties.substationOsmId} ${properties.highKv}/${properties.lowKv} kV already has a curated rating`)
    byKey.set(key, { curationId: id, ratingMva: properties.ratingMva, reason: properties.reason })
  }
  const applied = new Set<string>()
  return {
    of: branch => {
      const key = `${branch.fromBusId}|${branch.toBusId}`
      const rating = byKey.get(key)
      if (rating !== undefined) applied.add(key)
      return rating
    },
    assertAllApplied: () => {
      const unused = [...byKey].filter(([key]) => !applied.has(key)).map(([, rating]) => rating.curationId)
      if (unused.length > 0) throw new Error(`${unused.join(', ')}: no transformer of the model between the named levels`)
    },
  }
}
