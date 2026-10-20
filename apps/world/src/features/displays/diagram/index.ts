// The diagram engine's entry point. Density limits are checked first, from
// the graph alone. Then the profile's fit ladder runs from richest to leanest
// (which text the stacks keep, and where they go: right of symbols, lane stub
// labels below, below the symbols of lanes, below every symbol). Each rung is
// laid out in both orientations and in each arrangement the graph allows
// (hubs on either side of the lanes, reaching their items near or from the
// outer channel, and a hub of one lane its return runs late; cycles whose
// return runs through shared symbols folded or not). None of this depends on
// the room a drawing is shown in: a graph's candidate drawings are laid out
// once, rung by rung as a room first needs them, and every room is answered
// from them. For a room, the first rung with a candidate that verifies,
// keeps within the crossing limits and fits wins; within it, fewer
// crossings, then the earlier arrangement (the plain one first), then the
// better fit. The crossing limits are absolute and relative to the crossings
// the graph's structure forces (bound.ts). Without one, the result says why:
// density (crossings, when every attempt crosses too often, verified or
// not), the smallest size per orientation, or the verifier's findings.
// Nothing is truncated silently.
import { runAttempt, prepare, type AttemptGeometry, type Prepared } from './attempt.ts'
import { breakCycles, foldReturns, type Fold } from './cycles.ts'
import { findCrossings, drawingSegments, gapsByEdge } from './crossings.ts'
import type { DiagramGraph, DiagramLayoutResult, DiagramProfile, DiagramRoom, DiagramViolation, RoutedEdge } from './diagram.ts'
import { ORIENTATIONS, type Orientation } from './geometry.ts'
import { geometryHash } from './hash.ts'
import { forcedCrossings } from './bound.ts'
import { assignLayers, layerNodes, plainLayering, type LayeringOptions } from './layering.ts'
import { buildModel, validateProfile, validateRoom, type Model } from './model.ts'
import { orderLayers, type HubSide } from './ordering.ts'
import { keptLines } from './shapes.ts'
import { analyseStructure } from './structure.ts'
import { verifyLayout } from './verify.ts'

export * from './diagram.ts'

type Reason = Extract<DiagramLayoutResult, { ok: false }>['reasons'][number]

const densityReasons = (model: Model, profile: DiagramProfile): Reason[] => {
  const symbol = (role: string): boolean => role === 'device' || role === 'hub'
  const symbols = model.nodes.filter(node => symbol(node.role))
  const perLane = model.lanes.map((_, lane) => symbols.filter(node => node.lane === lane).length)
  const counts: Array<[keyof DiagramProfile['limits'], number]> = [
    ['symbols', symbols.length],
    ['symbolsPerLane', Math.max(0, ...perLane)],
    ['sharedSymbols', symbols.filter(node => node.lane === null).length],
    ['lanes', model.lanes.length],
  ]
  return counts.filter(([limit, count]) => count > profile.limits[limit]).map(([limit, count]) => ({ kind: 'density', limit, count, max: profile.limits[limit] }))
}

/** How far over the crossing limit an arrangement's first drawings may be and still be drawn at the leaner rungs. */
const ARRANGEMENT_SLACK = 2

interface Arrangement {
  readonly reversed: ReadonlyArray<boolean>
  readonly layering: LayeringOptions
  readonly hubSide: HubSide
  /** Order refined by swaps that cross less, stubs beside their symbols, strands before the axis where ordered there. */
  readonly refine: boolean
}

/**
 * The arrangements a graph allows, the plain one first: hubs beside lane 0
 * reaching each item through the channel before it, no fold, no refinement.
 * Then refined ones: with hubs, beside lane 0 or after the last lane, reaching
 * near or from the outer channel, and a hub that serves one lane with return
 * runs also late (beside more lanes, a run straight to the hub crosses the
 * lanes between it and its own); with a return leg through shared symbols,
 * each also folded, and folded beside its turn where that cuts the leg
 * elsewhere.
 */
const arrangements = (model: Model): ReadonlyArray<Arrangement> => {
  const reversed = breakCycles(model)
  const plain = plainLayering(model)
  const layered = layerNodes(model, reversed)
  const fold = foldReturns(model, reversed, layered)
  const beside = foldReturns(model, reversed, layered, 'beside')
  // Beside its turn only where that draws the cycle shorter than folding it at its turn (or than not folding it).
  const length = (entry: Fold | null): number => Math.max(0, ...layerNodes(model, entry?.reversed ?? reversed, false, entry?.flat))
  const folds = [fold, beside !== null && length(beside) < length(fold) ? beside : null].filter((entry): entry is Fold => entry !== null)
  const hubs = model.nodes.some(node => node.role === 'hub') && model.lanes.length > 0
  const returns = model.lanes.length === 1 && model.edges.some(edge => reversed[edge.index] && model.nodes[edge.to]!.role === 'hub')
  const placements: ReadonlyArray<{ readonly hubSide: HubSide; readonly hubReach: LayeringOptions['hubReach'] }> = hubs
    ? [
      { hubSide: 'low', hubReach: 'near' }, { hubSide: 'low', hubReach: 'outer' }, { hubSide: 'high', hubReach: 'near' }, { hubSide: 'high', hubReach: 'outer' },
      ...(returns ? [{ hubSide: 'low', hubReach: 'late' }, { hubSide: 'high', hubReach: 'late' }] as const : []),
    ]
    : [{ hubSide: 'low', hubReach: 'near' }]
  return [
    { reversed, layering: plain, hubSide: 'low', refine: false },
    ...placements.map(({ hubSide, hubReach }) => ({ reversed, layering: { ...plain, hubReach }, hubSide, refine: true })),
    ...folds.flatMap(fold => placements.map(({ hubSide, hubReach }) => ({ reversed: fold.reversed, layering: { flipped: fold.flipped, folded: fold.folded, flat: fold.flat, hubReach }, hubSide, refine: true }))),
  ]
}

/** A drawing that verifies within the crossing limits: what a room may be answered with. */
interface Candidate {
  /** Index of the arrangement it was drawn in. */
  readonly arrangement: number
  readonly geometry: AttemptGeometry
  readonly edges: ReadonlyArray<RoutedEdge>
  readonly crossings: number
  /** Its geometry hash, computed when first drawn. */
  readonly hash: () => string
}

/**
 * A graph's drawings under a profile, independent of any room: the
 * candidates of each rung of the fit ladder, laid out when a room first
 * needs that rung, and what a refusal reports.
 */
export interface DiagramCandidates {
  /** The drawing for a room, exactly as the fit ladder chooses it there; or why none fits. */
  readonly layout: (room: DiagramRoom) => DiagramLayoutResult
  /**
   * The least height of a drawing no wider than `maxWidth`: the least room
   * height a drawing fits at that width. Null where no drawing is that narrow.
   */
  readonly leastHeight: (maxWidth: number) => number | null
}

export const diagramCandidates = (graph: DiagramGraph, profile: DiagramProfile): DiagramCandidates => {
  validateProfile(profile)
  const model = buildModel(graph)
  const density = densityReasons(model, profile)
  if (density.length > 0) {
    const refusal: DiagramLayoutResult = { ok: false, reasons: density }
    const layout = (room: DiagramRoom): DiagramLayoutResult => {
      validateRoom(room)
      return refusal
    }
    return { layout, leastHeight: () => null }
  }

  const forced = forcedCrossings(model)
  const allowed = Math.min(profile.limits.crossings, forced + profile.limits.crossingsOverBound)
  const crossingLimit = allowed === profile.limits.crossings ? 'crossings' as const : 'crossingsOverBound' as const
  const structure = analyseStructure(model)
  const optional = model.nodes.some(node => keptLines(node, 'required') < node.lines.length)
  const rungs = profile.fit
    .filter(rung => (optional || rung.detail === 'full') && (model.lanes.length > 0 || rung.text !== 'lanesBelow'))
    .map(rung => ({ detail: rung.detail, policy: rung.text }))

  let prepared: ReadonlyArray<Prepared> | null = null
  // Arrangements far over the crossing limit in the first rung are not drawn again (the plain one always is).
  let drawn: ReadonlyArray<number> = []
  /** Per rung laid out: its candidates, in the order the rung's attempts were drawn. */
  const laidOut: Array<ReadonlyArray<Candidate>> = []
  /** Every candidate kept so far, for dropping later ones no room can choose. */
  const kept: Candidate[] = []
  /** Verified within the limits, by orientation: the sizes a refusal reports. */
  const sizes: Array<{ readonly orientation: Orientation; readonly width: number; readonly height: number }> = []
  let verifiedWithin = false
  let fewestVerified = Infinity
  let fewestAny = Infinity
  let fewestViolations: ReadonlyArray<DiagramViolation> | null = null

  const judge = (arrangement: number, geometry: AttemptGeometry) => {
    const bare: RoutedEdge[] = model.edges.map((edge, e) => ({ id: edge.id, points: geometry.paths[e]!, gaps: [] }))
    const crossings = findCrossings(drawingSegments(model, structure.net, geometry.nodes, bare))
    const gaps = gapsByEdge(model.edges.length, crossings, bare)
    const edges = bare.map((edge, e) => ({ ...edge, gaps: gaps[e]! }))
    return { arrangement, geometry, edges, crossings: crossings.length }
  }
  const verify = (judged: ReturnType<typeof judge>): ReadonlyArray<DiagramViolation> =>
    verifyLayout({ model, net: structure.net, profile, width: judged.geometry.width, height: judged.geometry.height, nodes: judged.geometry.nodes, edges: judged.edges })
  const dominates = (a: Candidate, b: Candidate): boolean => a.geometry.width <= b.geometry.width && a.geometry.height <= b.geometry.height

  const layOut = (rung: number): void => {
    prepared ??= arrangements(model).map(({ reversed, layering, hubSide, refine }) => {
      const layered = assignLayers(model, structure, reversed, layering)
      return prepare(model, structure, layered, orderLayers(model, layered, hubSide, refine ? { net: structure.net } : null), layering.flipped, refine)
    })
    if (rung === 0) drawn = prepared.map((_, index) => index)
    const { detail, policy } = rungs[rung]!
    const round = drawn.flatMap(index => ORIENTATIONS.map(orientation => judge(index, runAttempt(prepared![index]!, profile, orientation, detail, policy))))
    if (rung === 0) drawn = drawn.filter(index => index === 0 || Math.min(...round.filter(judged => judged.arrangement === index).map(judged => judged.crossings)) <= allowed + ARRANGEMENT_SLACK)
    // Every drawing within the limits is verified. One over them matters only to a refusal, and only while no
    // drawing within them has verified: then the fewest crossings verified, or the fewest findings, say why.
    const checked = round.map(judged => ({ judged, violations: judged.crossings <= allowed ? verify(judged) : null }))
    verifiedWithin ||= checked.some(entry => entry.violations?.length === 0)
    for (const entry of checked) {
      fewestAny = Math.min(fewestAny, entry.judged.crossings)
      const violations = entry.violations ?? (verifiedWithin ? null : verify(entry.judged))
      if (violations === null) continue
      if (violations.length === 0) fewestVerified = Math.min(fewestVerified, entry.judged.crossings)
      // The first, in the order the attempts were drawn, with the fewest findings.
      if (fewestViolations === null || violations.length < fewestViolations.length) fewestViolations = violations
    }
    const verified = checked.filter(entry => entry.violations?.length === 0).map(entry => entry.judged)
    for (const judged of verified) sizes.push({ orientation: judged.geometry.orientation, width: judged.geometry.width, height: judged.geometry.height })
    // A candidate no room can choose is dropped: one that a candidate of an earlier rung, or of an earlier
    // crossing count or arrangement in this rung, fits wherever it fits.
    const earlier = (a: Candidate, b: Candidate): boolean => (a.crossings - b.crossings || a.arrangement - b.arrangement) < 0
    const candidates: Candidate[] = verified.map(judged => {
      let hash: string | null = null
      return { ...judged, hash: () => (hash ??= geometryHash(model, judged.geometry.width, judged.geometry.height, judged.geometry.nodes, judged.edges, judged.geometry.zones)) }
    })
    const chosen = candidates.filter(candidate => !kept.some(other => dominates(other, candidate)) && !candidates.some(other => earlier(other, candidate) && dominates(other, candidate)))
    kept.push(...chosen)
    laidOut.push(chosen)
    // Every rung is laid out: what they were laid out from is no longer needed.
    if (laidOut.length === rungs.length) prepared = null
  }

  const fits = (candidate: Candidate, room: DiagramRoom): boolean => candidate.geometry.width <= room.maxWidth && candidate.geometry.height <= room.maxHeight
  const overflow = (size: { readonly width: number; readonly height: number }, room: DiagramRoom): number => Math.max(size.width / room.maxWidth, size.height / room.maxHeight)
  const layOutAll = (): void => {
    while (laidOut.length < rungs.length) layOut(laidOut.length)
  }

  const layout = (room: DiagramRoom): DiagramLayoutResult => {
    validateRoom(room)
    for (let rung = 0; rung < rungs.length; rung += 1) {
      if (laidOut.length <= rung) layOut(rung)
      const best = laidOut[rung]!
        .filter(candidate => fits(candidate, room))
        .sort((a, b) => (a.crossings - b.crossings) || (a.arrangement - b.arrangement) || (overflow(a.geometry, room) - overflow(b.geometry, room)))[0]
      if (best === undefined) continue
      const { geometry, edges } = best
      return {
        ok: true,
        width: geometry.width,
        height: geometry.height,
        nodes: geometry.nodes,
        edges,
        zones: geometry.zones,
        hash: best.hash(),
        crossings: best.crossings,
        forcedCrossings: forced,
      }
    }

    // Too many crossings in every attempt, verified or not, is the reason to
    // give: no drawing of this graph would be accepted whatever else is wrong.
    const fewestCrossings = Number.isFinite(fewestVerified) ? fewestVerified : fewestAny
    if (fewestCrossings > allowed) {
      return { ok: false, reasons: [{ kind: 'density', limit: crossingLimit, count: fewestCrossings, max: allowed }] }
    }
    if (!Number.isFinite(fewestVerified)) return { ok: false, reasons: [{ kind: 'unverifiable', violations: fewestViolations ?? [] }] }
    // Per orientation, the drawing that comes closest to the box.
    const reasons: Reason[] = ORIENTATIONS.flatMap(orientation => {
      const smallest = sizes
        .filter(size => size.orientation === orientation)
        .sort((a, b) => (overflow(a, room) - overflow(b, room)) || (a.width * a.height - b.width * b.height))[0]
      return smallest === undefined ? [] : [{ kind: 'size' as const, width: smallest.width, height: smallest.height }]
    })
    return { ok: false, reasons }
  }

  const leastHeight = (maxWidth: number): number | null => {
    layOutAll()
    const heights = kept.filter(candidate => candidate.geometry.width <= maxWidth).map(candidate => candidate.geometry.height)
    return heights.length === 0 ? null : Math.min(...heights)
  }

  return { layout, leastHeight }
}

/** One graph drawn for one room: `diagramCandidates` asked once. */
export const layoutDiagram = (graph: DiagramGraph, profile: DiagramProfile, room: DiagramRoom): DiagramLayoutResult =>
  diagramCandidates(graph, profile).layout(room)

/** Runs the verifier on a result of `layoutDiagram` for the same graph and profile. */
export const verifyDiagram = (graph: DiagramGraph, profile: DiagramProfile, result: Extract<DiagramLayoutResult, { ok: true }>): DiagramViolation[] => {
  const model = buildModel(graph)
  const byId = <T extends { readonly id: string }>(list: ReadonlyArray<T>): Map<string, T> => new Map(list.map(entry => [entry.id, entry]))
  const nodes = byId(result.nodes)
  const edges = byId(result.edges)
  return verifyLayout({
    model,
    net: analyseStructure(model).net,
    profile,
    width: result.width,
    height: result.height,
    nodes: model.nodes.map(node => nodes.get(node.id)!),
    edges: model.edges.map(edge => edges.get(edge.id)!),
  })
}
