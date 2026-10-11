import { z } from 'zod'

// Stable Grid asset identity: ids derive from source identity only, never from names, and
// are never truncated. Shared by the Model, Model Addition and Operating Point schemas.

export const priceAreas = ['NO1', 'NO2', 'NO3', 'NO4', 'NO5'] as const
export const externalAreas = ['SE1', 'SE2', 'SE3', 'FI', 'DK1', 'NL', 'DE', 'GB'] as const
export const priceAreaSchema = z.enum(priceAreas)
export const externalAreaSchema = z.enum(externalAreas)
export type PriceArea = z.infer<typeof priceAreaSchema>
export type ExternalArea = z.infer<typeof externalAreaSchema>
/** External areas synchronous with the Nordic system; DK1, NL, DE and GB reach Norway only through HVDC. */
export const nordicSynchronousExternalAreas: ReadonlySet<string> = new Set(['SE1', 'SE2', 'SE3', 'FI'])

export const generatorKinds = ['hydro-reservoir', 'hydro-run-of-river', 'hydro-pumped', 'wind', 'solar', 'thermal', 'nuclear'] as const
/**
 * The consumption groups Elhub publishes per municipality (private = household + cabin,
 * industry = primary + secondary, business = tertiary). A municipality's demand of one group
 * splits over the substations it is attached to: `load:<municipalityNr>-<group>-<substation>`.
 */
export const municipalityLoadGroups = ['private', 'business', 'industry'] as const
export type MunicipalityLoadGroup = typeof municipalityLoadGroups[number]
export const siteLoadKinds = ['industry-site', 'petroleum-site', 'data-center'] as const

/**
 * The Elhub group whose metered demand a load is part of: Elhub meters a major site in its
 * municipality's industry group (model-build/loads.ts takes each site's demand out of that group).
 */
export const loadDemandGroups: Readonly<Record<MunicipalityLoadGroup | typeof siteLoadKinds[number], MunicipalityLoadGroup>> = {
  private: 'private',
  business: 'business',
  industry: 'industry',
  'industry-site': 'industry',
  'petroleum-site': 'industry',
  'data-center': 'industry',
}

const slug = '[a-z0-9]+(?:-[a-z0-9]+)*'
const kv = '[1-9]\\d*(?:\\.\\d+)?'
const osmElement = 'osm-(?:node|way|relation)-[1-9]\\d*'
const busToken = `(?:${osmElement}|junction-osm-node-[1-9]\\d*|curated-${slug})@${kv}`
const exact = (body: string): RegExp => new RegExp(`^${body}$`)

export const gridIdPatterns = {
  /** AC boundary buses carry their voltage (`bus:boundary-SE3@420`); HVDC boundaries do not (`bus:boundary-NL`). */
  bus: exact(`bus:(?:${busToken}|boundary-(?:${externalAreas.join('|')})(?:@${kv})?)`),
  branch: exact(`branch:(?:osm-[0-9a-f]{16,64}|transformer-${osmElement}-${kv}-${kv}|curated-${slug})`),
  hvdcLink: exact(`hvdc:${slug}`),
  hvdcRampGroup: exact(`ramp:${slug}`),
  externalSystem: exact(`external:(?:nordic-remainder|${externalAreas.join('|')})`),
  generator: exact(`generator:(?:nve-(?:hydro|wind)-[1-9]\\d*|${osmElement}|aggregate-${busToken}-(?:${generatorKinds.join('|')})|curated-${slug})`),
  load: exact(`load:(?:\\d{4}-(?:${municipalityLoadGroups.join('|')})-${osmElement}|site-${slug})`),
  /** `shunt:<bus id without "bus:">-<n>`. */
  shunt: exact(`shunt:${busToken}-[1-9]\\d*`),
  /** Connection point ids double as electrical port ids, so they stay within the core id grammar. */
  connectionPoint: exact(slug),
  /** Model, Model Addition and Operating Point references. */
  definitionRef: exact(`electric-grid(?:\\.${slug})+`),
  /** OSM element identity used for substations: `osm-way-60495669`. */
  substation: exact(osmElement),
  osmWay: /^[1-9]\d*$/,
} as const

/** Parses `branch:transformer-<substation>-<kVhi>-<kVlo>`. */
export const transformerIdParts = (id: string): { readonly substationId: string; readonly highKv: string; readonly lowKv: string } | undefined => {
  const match = new RegExp(`^branch:transformer-(${osmElement})-(${kv})-(${kv})$`).exec(id)
  return match ? { substationId: match[1]!, highKv: match[2]!, lowKv: match[3]! } : undefined
}

/** Parses `generator:aggregate-<bus id without "bus:">-<kind>`. */
export const aggregateGeneratorIdParts = (id: string): { readonly busId: string; readonly kind: string } | undefined => {
  const match = new RegExp(`^generator:aggregate-(${busToken})-(${generatorKinds.join('|')})$`).exec(id)
  return match ? { busId: `bus:${match[1]!}`, kind: match[2]! } : undefined
}

/** Parses `load:<municipalityNr>-<group>-<substation>`. */
export const municipalityLoadIdParts = (id: string): { readonly municipalityNr: string; readonly group: string; readonly substationId: string } | undefined => {
  const match = new RegExp(`^load:(\\d{4})-(${municipalityLoadGroups.join('|')})-(${osmElement})$`).exec(id)
  return match ? { municipalityNr: match[1]!, group: match[2]!, substationId: match[3]! } : undefined
}

export const isCuratedId = (id: string): boolean => /^[a-z]+:curated-/.test(id)

/** Parses `shunt:<bus id without "bus:">-<n>`. */
export const shuntIdParts = (id: string): { readonly busId: string; readonly index: number } | undefined => {
  const match = new RegExp(`^shunt:(${busToken})-([1-9]\\d*)$`).exec(id)
  return match ? { busId: `bus:${match[1]!}`, index: Number(match[2]!) } : undefined
}
