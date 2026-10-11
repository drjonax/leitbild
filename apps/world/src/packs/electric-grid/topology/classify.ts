import { compareText } from './ids.ts'
import type {
  TopologyBusbarInput,
  TopologyInput,
  TopologyInputFeature,
  TopologyLevelInput,
  TopologyLineInput,
  TopologyRouteInput,
  TopologyStationInput,
  TopologyTransformerInput,
} from './input.ts'
import type { TopologyLedger } from './ledger.ts'
import type { TopologyOptions } from './options.ts'

export type ClassifiedInput = {
  readonly acLines: ReadonlyArray<TopologyLineInput>          // operational lines with ≥1 50 Hz level
  readonly hvdcLines: ReadonlyArray<TopologyLineInput>        // operational lines with ≥1 HVDC level
  readonly busbars: ReadonlyArray<TopologyBusbarInput>
  readonly stations: ReadonlyArray<TopologyStationInput>
  readonly transformers: ReadonlyArray<TopologyTransformerInput>
  readonly routes: ReadonlyArray<TopologyRouteInput>
  readonly normaliseKv: (kv: number) => number
  // Known 50 Hz voltages of all operational ways at each vertex, including ways below the floor.
  readonly knownVoltagesAtKey: ReadonlyMap<string, ReadonlySet<number>>
}

const wayIdPattern = /^way\/\d+$/
const osmIdPattern = /^(node|way|relation)\/\d+$/
/** A transformer unit an add-transformer-units curation gives (model-build/curations.ts). */
const curatedUnitPattern = /^curation:[a-z0-9]+(?:-[a-z0-9]+)*\/unit-[1-9][0-9]*$/

const fail = (featureId: string, problem: string): never => {
  throw new Error(`topology input: ${featureId} ${problem}`)
}

const validateFeature = (feature: TopologyInputFeature): void => {
  if (feature.kind === 'line' || feature.kind === 'cable' || feature.kind === 'busbar') {
    if (feature.coordinates.length < 2) fail(feature.featureId, 'has fewer than two vertices')
    if (feature.vertexKeys.length !== feature.coordinates.length) fail(feature.featureId, 'has vertex keys not aligned with its coordinates')
    if (feature.osmWayIds.length === 0 || !feature.osmWayIds.every(id => wayIdPattern.test(id))) fail(feature.featureId, 'needs OSM way ids way/<id>')
  }
  if (feature.kind === 'line' || feature.kind === 'cable') {
    const last = feature.coordinates.length - 1
    const indices = new Set(feature.terminalVertexIndices)
    if (!indices.has(0) || !indices.has(last)) fail(feature.featureId, 'must list both way ends as terminal vertices')
    for (const index of indices) if (!Number.isInteger(index) || index < 0 || index > last) fail(feature.featureId, `has terminal vertex index ${index} out of range`)
    if (feature.levels.length === 0) fail(feature.featureId, 'has no levels (a voltage-less way carries one level with voltageKv null)')
  }
  if ((feature.kind === 'substation' || feature.kind === 'plant') && !osmIdPattern.test(feature.featureId)) {
    fail(feature.featureId, 'is not an OSM element id')
  }
  if (feature.kind === 'transformer' && !osmIdPattern.test(feature.featureId) && !curatedUnitPattern.test(feature.featureId)) {
    fail(feature.featureId, 'is neither an OSM element id nor a curated transformer unit')
  }
}

const mergeLevels = (levels: ReadonlyArray<TopologyLevelInput>): ReadonlyArray<TopologyLevelInput> => {
  const merged = new Map<string, TopologyLevelInput>()
  for (const level of levels) {
    const key = `${level.voltageKv}|${level.system}`
    const existing = merged.get(key)
    merged.set(key, existing
      ? existing.circuits !== null && level.circuits !== null
        ? { ...level, circuits: existing.circuits + level.circuits, circuitsSource: 'voltage-list' }
        : { ...level, circuits: null, circuitsSource: null }
      : level)
  }
  return [...merged.values()]
}

export const classifyInput = (input: TopologyInput, options: TopologyOptions, ledger: TopologyLedger): ClassifiedInput => {
  const equivalents = new Map(options.equivalentVoltagesKv.map(entry => [entry.fromKv, entry.toKv]))
  const normaliseKv = (kv: number): number => equivalents.get(kv) ?? kv
  const features = [...input.features].sort((left, right) => compareText(left.featureId, right.featureId))
  for (let index = 1; index < features.length; index += 1) {
    if (features[index]!.featureId === features[index - 1]!.featureId) throw new Error(`topology input: duplicate feature id ${features[index]!.featureId}`)
  }
  const acLines: TopologyLineInput[] = []
  const hvdcLines: TopologyLineInput[] = []
  const busbars: TopologyBusbarInput[] = []
  const stations: TopologyStationInput[] = []
  const transformers: TopologyTransformerInput[] = []
  const routes: TopologyRouteInput[] = []
  const knownVoltagesAtKey = new Map<string, Set<number>>()

  const classifyLine = (feature: TopologyLineInput): void => {
    const normalised = mergeLevels(feature.levels.map(level => level.voltageKv === null ? level : { ...level, voltageKv: normaliseKv(level.voltageKv) }))
    const renamed = feature.levels.filter(level => level.voltageKv !== null && normaliseKv(level.voltageKv) !== level.voltageKv)
    if (renamed.length > 0) {
      ledger.add({
        reason: 'voltage-normalised',
        elementIds: [feature.featureId, ...feature.osmWayIds],
        voltageKv: normaliseKv(renamed[0]!.voltageKv!),
        detail: `tagged ${renamed.map(level => level.voltageKv).join(', ')} kV read as the equivalent Nordic level`,
      })
    }
    const traction = normalised.filter(level => level.system === 'traction')
    if (traction.length > 0) {
      ledger.add({
        reason: 'traction-system',
        elementIds: [feature.featureId, ...feature.osmWayIds],
        detail: `railway traction circuit(s) ${traction.map(level => level.voltageKv ?? 'unknown').join(', ')} kV (16.7 Hz) excluded`,
      })
    }
    const below = normalised.filter(level => level.system === 'ac50' && level.voltageKv !== null && level.voltageKv < options.minimumKv)
    if (below.length > 0) {
      ledger.add({
        reason: 'below-minimum-voltage',
        elementIds: [feature.featureId, ...feature.osmWayIds],
        voltageKv: Math.max(...below.map(level => level.voltageKv!)),
        detail: `${below.map(level => level.voltageKv).join(', ')} kV below the ${options.minimumKv} kV model floor`,
      })
    }
    const line: TopologyLineInput = { ...feature, levels: normalised }
    const known = normalised.flatMap(level => level.system === 'ac50' && level.voltageKv !== null ? [level.voltageKv] : [])
    if (known.length > 0) {
      for (const key of line.vertexKeys) {
        const set = knownVoltagesAtKey.get(key)
        if (set) for (const kv of known) set.add(kv)
        else knownVoltagesAtKey.set(key, new Set(known))
      }
    }
    if (normalised.some(level => level.system === 'ac50' && (level.voltageKv === null || level.voltageKv >= options.minimumKv))) acLines.push(line)
    if (normalised.some(level => level.system === 'hvdc')) hvdcLines.push(line)
  }

  for (const feature of features) {
    validateFeature(feature)
    if (feature.lifecycle !== 'operational') {
      ledger.add({
        reason: 'not-operational',
        elementIds: [feature.featureId, ...('osmWayIds' in feature ? feature.osmWayIds : [])],
        detail: `${feature.kind} is ${feature.lifecycle}`,
      })
      continue
    }
    switch (feature.kind) {
      case 'busbar':
        busbars.push(feature)
        break
      case 'substation':
      case 'plant':
        stations.push({ ...feature, voltagesKv: [...new Set(feature.voltagesKv.map(normaliseKv))] })
        break
      case 'transformer':
        transformers.push(feature)
        break
      case 'route':
        routes.push({ ...feature, voltagesKv: feature.voltagesKv.map(normaliseKv) })
        break
      case 'line':
      case 'cable':
        classifyLine(feature)
        break
    }
  }
  return { acLines, hvdcLines, busbars, stations, transformers, routes, normaliseKv, knownVoltagesAtKey }
}
