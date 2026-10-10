import {
  gridReferenceSystemSchema,
  type GridReferenceCategory,
  type GridReferenceFeatureProperties,
  type GridReferenceLifecycle,
  type GridReferenceSystem,
} from '../schemas/grid-reference.ts'

// Interpretation of OSM power tagging (https://wiki.openstreetmap.org/wiki/Power_networks).

export type OsmTags = Readonly<Record<string, string>>

export interface OsmPowerKind {
  readonly category: GridReferenceCategory
  readonly lifecycle: GridReferenceLifecycle
}

export interface VoltageReading {
  readonly kv: ReadonlyArray<number>
  readonly belowThresholdV: ReadonlyArray<number>
  // Parts that are not a positive number of volts (`medium`, `66000?`); the raw tag stays in `tags`.
  readonly unparsed: ReadonlyArray<string>
}

// OSM `voltage` is tagged in volts (https://wiki.openstreetmap.org/wiki/Key:voltage).
const VOLTS_PER_KV = 1000
// Lowest grid level kept in the reference layer, kV: Norwegian regional grid (66 kV and up) and transmission grid.
export const TRANSMISSION_FLOOR_KV = 66
// Smallest plant or generator kept without a transmission voltage, MW.
export const GENERATION_FLOOR_MW = 10
// Railway traction frequency in Norway and Sweden, Hz (16 2/3 Hz, tagged as 16.7 or 16.67).
const TRACTION_FREQUENCY_HZ = 50 / 3
const TRACTION_FREQUENCY_TOLERANCE_HZ = 0.1
const AC_FREQUENCY_HZ = 50

const LIFECYCLE_STATES: ReadonlyArray<Exclude<GridReferenceLifecycle, 'operational'>> = [
  'construction',
  'proposed',
  'disused',
  'abandoned',
]
// `planned` is the older spelling of `proposed` in lifecycle tagging.
const LIFECYCLE_KEYS: ReadonlyArray<readonly [string, Exclude<GridReferenceLifecycle, 'operational'>]> = [
  ...LIFECYCLE_STATES.map(state => [state, state] as const),
  ['planned', 'proposed'],
]

// `line=busbar|bay` marks conductors inside a substation, on lines and (underground bays) on cables.
const isSubstationConductor = (tags: OsmTags): boolean => tags.line === 'busbar' || tags.line === 'bay'

const categoryForPowerValue = (value: string, tags: OsmTags): GridReferenceCategory | null => {
  if (value === 'line') return isSubstationConductor(tags) ? 'busbar' : 'line'
  if (value === 'cable') return isSubstationConductor(tags) ? 'busbar' : 'cable'
  if (value === 'busbar' || value === 'bay') return 'busbar'
  if (value === 'substation') return 'substation'
  if (value === 'transformer') return 'transformer'
  if (value === 'portal') return 'portal'
  if (value === 'terminal') return 'terminal'
  if (value === 'plant') return 'plant'
  if (value === 'generator') return 'generator'
  return null
}

const isTruthyLifecycleValue = (value: string | undefined): boolean =>
  value !== undefined && value !== 'no'

/** Lifecycle of an element whose primary tag is not itself a lifecycle form (`construction=yes`, `disused=yes`, …). */
export const lifecycleOfTagged = (tags: OsmTags): GridReferenceLifecycle => {
  for (const [key, state] of LIFECYCLE_KEYS) {
    if (isTruthyLifecycleValue(tags[key])) return state
  }
  return 'operational'
}

/** Power element kind, including lifecycle forms such as `power=construction` + `construction=line` and `disused:power=line`. */
export const powerKindOf = (tags: OsmTags): OsmPowerKind | null => {
  const power = tags.power
  if (power !== undefined) {
    const lifecycleKey = LIFECYCLE_KEYS.find(([key]) => key === power)
    if (lifecycleKey) {
      const target = tags[power]
      const category = target === undefined ? null : categoryForPowerValue(target, tags)
      return category ? { category, lifecycle: lifecycleKey[1] } : null
    }
    const category = categoryForPowerValue(power, tags)
    return category ? { category, lifecycle: lifecycleOfTagged(tags) } : null
  }
  for (const [key, state] of LIFECYCLE_KEYS) {
    const prefixed = tags[`${key}:power`]
    if (prefixed === undefined) continue
    const category = categoryForPowerValue(prefixed, tags)
    if (category) return { category, lifecycle: state }
  }
  return null
}

/** `route=power` relations describe circuits (https://wiki.openstreetmap.org/wiki/Tag:route=power). */
export const isPowerCircuitRelation = (tags: OsmTags): boolean =>
  tags.type === 'route' && tags.route === 'power'

const tagParts = (value: string | undefined): ReadonlyArray<string> =>
  value === undefined ? [] : value.split(';').map(part => part.trim()).filter(part => part.length > 0)

const PLAIN_NUMBER = /^\d+(?:\.\d+)?$/

export const parseVoltage = (value: string | undefined): VoltageReading => {
  const kv = new Set<number>()
  const belowThresholdV = new Set<number>()
  const unparsed: string[] = []
  // Comma is a frequent mistyped separator for voltage lists; voltages are integers in volts.
  for (const part of tagParts(value?.replaceAll(',', ';'))) {
    const volts = PLAIN_NUMBER.test(part) ? Number(part) : 0
    if (volts <= 0) unparsed.push(part)
    else if (volts < VOLTS_PER_KV) belowThresholdV.add(volts)
    else kv.add(volts / VOLTS_PER_KV)
  }
  return {
    kv: [...kv].sort((left, right) => right - left),
    belowThresholdV: [...belowThresholdV].sort((left, right) => right - left),
    unparsed,
  }
}

export const parseFrequency = (value: string | undefined): { readonly hz: ReadonlyArray<number>; readonly unparsed: ReadonlyArray<string> } => {
  const hz: number[] = []
  const unparsed: string[] = []
  for (const part of tagParts(value)) {
    const normalised = part.replace(',', '.')
    if (!PLAIN_NUMBER.test(normalised)) unparsed.push(part)
    else if (!hz.includes(Number(normalised))) hz.push(Number(normalised))
  }
  return { hz, unparsed }
}

const systemForFrequency = (hz: number): GridReferenceSystem => {
  if (hz === 0) return 'hvdc'
  if (hz === AC_FREQUENCY_HZ) return 'ac50'
  if (Math.abs(hz - TRACTION_FREQUENCY_HZ) <= TRACTION_FREQUENCY_TOLERANCE_HZ) return 'traction'
  return 'other'
}

export const systemsFor = (
  frequencyHz: ReadonlyArray<number>,
  frequencyTagged: boolean,
): Pick<GridReferenceFeatureProperties, 'systems' | 'systemProvenance'> => {
  if (!frequencyTagged || frequencyHz.length === 0) return { systems: ['ac50'], systemProvenance: 'inferred' }
  const tagged = new Set(frequencyHz.map(systemForFrequency))
  return { systems: gridReferenceSystemSchema.options.filter(system => tagged.has(system)), systemProvenance: 'observed' }
}

const POWER_UNIT_TO_MW: Readonly<Record<string, number>> = { gw: 1000, mw: 1, kw: 1e-3, w: 1e-6 }
const OUTPUT_VALUE = /^(\d+(?:[.,]\d+)?)\s*(gw|mw|kw|w)$/i

/** Parses `plant:output:electricity` / `generator:output:electricity`; values without a unit or `yes` are unknown. */
export const parseOutputMw = (value: string | undefined): number | null => {
  if (value === undefined) return null
  const match = value.trim().match(OUTPUT_VALUE)
  if (!match) return null
  const magnitude = Number(match[1]!.replace(',', '.'))
  return magnitude * POWER_UNIT_TO_MW[match[2]!.toLowerCase()]!
}

const outputKeyFor = (category: GridReferenceCategory): string | null => {
  if (category === 'plant') return 'plant:output:electricity'
  if (category === 'generator') return 'generator:output:electricity'
  return null
}

const sourceKeyFor = (category: GridReferenceCategory): string | null => {
  if (category === 'plant') return 'plant:source'
  if (category === 'generator') return 'generator:source'
  return null
}

const positiveIntegerTag = (value: string | undefined): number | null => {
  const first = tagParts(value)[0]
  if (first === undefined || !/^\d+$/.test(first)) return null
  const parsed = Number(first)
  return parsed > 0 ? parsed : null
}

export interface OsmPowerPropertiesInput {
  readonly source: string
  readonly kind: OsmPowerKind
  readonly externalId: string
  readonly tags: OsmTags
  readonly osmNodeIds: ReadonlyArray<string> | null
  readonly members: GridReferenceFeatureProperties['members']
  readonly geometrySource: GridReferenceFeatureProperties['geometrySource']
}

export const buildOsmPowerProperties = (input: OsmPowerPropertiesInput): GridReferenceFeatureProperties => {
  const { category, lifecycle } = input.kind
  const voltage = parseVoltage(input.tags.voltage)
  const frequencyHz = parseFrequency(input.tags.frequency).hz
  const outputKey = outputKeyFor(category)
  const sourceKey = sourceKeyFor(category)
  const outputMw = outputKey ? parseOutputMw(input.tags[outputKey]) : null
  const observed = voltage.kv.length > 0 || outputMw !== null
  return {
    source: input.source,
    category,
    externalId: input.externalId,
    osmNodeIds: input.osmNodeIds === null ? null : [...input.osmNodeIds],
    members: [...input.members],
    name: input.tags.name ?? null,
    ref: input.tags.ref ?? null,
    operator: input.tags.operator ?? null,
    voltageKv: [...voltage.kv],
    maxVoltageKv: voltage.kv[0] ?? null,
    voltageBelowThresholdV: [...voltage.belowThresholdV],
    frequencyHz: [...frequencyHz],
    ...systemsFor(frequencyHz, input.tags.frequency !== undefined),
    lifecycle,
    circuits: positiveIntegerTag(input.tags.circuits),
    cables: positiveIntegerTag(input.tags.cables),
    power: input.tags.power ?? null,
    plantSource: sourceKey ? input.tags[sourceKey] ?? null : null,
    outputMw,
    geometrySource: input.geometrySource,
    propertyProvenance: observed ? 'observed' : 'unknown',
    confidence: observed ? 'high' : 'low',
    tags: { ...input.tags },
  }
}

export type OsmPowerExclusion =
  | 'below-voltage-floor'
  | 'no-voltage'
  | 'no-voltage-minor-distribution'
  | 'below-generation-floor'
  | 'not-on-included-branch'

const reachesTransmissionFloor = (properties: GridReferenceFeatureProperties): boolean =>
  properties.maxVoltageKv !== null && properties.maxVoltageKv >= TRANSMISSION_FLOOR_KV

const reachesGenerationFloor = (properties: GridReferenceFeatureProperties): boolean =>
  properties.outputMw !== null && properties.outputMw >= GENERATION_FLOOR_MW

const hasNoVoltage = (properties: GridReferenceFeatureProperties): boolean =>
  properties.voltageKv.length === 0 && properties.voltageBelowThresholdV.length === 0

/**
 * Inclusion rule per category. Branch-like features and substations without any voltage are kept for topology
 * inference (except `substation=minor_distribution` kiosks, which never terminate a regional or transmission line);
 * portals and terminals are decided separately by whether an included branch uses them.
 */
export const exclusionOf = (properties: GridReferenceFeatureProperties): OsmPowerExclusion | null => {
  if (reachesTransmissionFloor(properties)) return null
  switch (properties.category) {
    case 'line':
    case 'cable':
    case 'busbar':
    case 'circuit':
      return hasNoVoltage(properties) ? null : 'below-voltage-floor'
    case 'substation':
      if (!hasNoVoltage(properties)) return 'below-voltage-floor'
      return properties.tags.substation === 'minor_distribution' ? 'no-voltage-minor-distribution' : null
    case 'transformer':
      return hasNoVoltage(properties) ? 'no-voltage' : 'below-voltage-floor'
    case 'plant':
    case 'generator':
      return reachesGenerationFloor(properties) ? null : 'below-generation-floor'
    case 'portal':
    case 'terminal':
      return 'not-on-included-branch'
  }
}

export const isBranchCategory = (category: GridReferenceCategory): boolean =>
  category === 'line' || category === 'cable' || category === 'busbar'
