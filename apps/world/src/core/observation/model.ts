/**
 * World-internal observation contract (plan v3.1 Appendix A). Packs declare
 * observables and read values through the exact Capabilities in
 * capabilities.ts; the apps/world/AGENTS.md rule says why it is not a
 * universal Pack runtime.
 */
import { z } from 'zod'
import { observableRefSchema, prioritySchema } from '../model/alerts.ts'

/** Every timestamp names its clock; the two never share an axis. */
export const clockSchema = z.enum(['simulation', 'wall'])
export const stampSchema = z.object({ at: z.string().datetime({ offset: true }), clock: clockSchema }).strict()

/**
 * Fixed core quantity kinds, each with its allowed unit codes: short ASCII
 * codes, never display symbols (World renders `degC` as °C); '' is a state or
 * boolean without a unit. Plant `power` and grid `active-power` both are
 * `electric-power` here; a signed delta keeps its quantity (a flow change is
 * a flow). A Pack adds a quantity or code through the core lane.
 */
export const quantityUnits = {
  level: ['%', '1'],
  loading: ['%', '1'],
  'electric-power': ['MW', 'kW'],
  'reactive-power': ['Mvar'],
  'thermal-power': ['MW', 'kW'],
  'thermal-fraction': ['%', '1'],
  pressure: ['MPa', 'Pa'],
  'pressure-difference': ['MPa', 'Pa'],
  temperature: ['degC'],
  'temperature-difference': ['degC'],
  'temperature-rate': ['degC/s'],
  frequency: ['Hz'],
  flow: ['kg/s'],
  voltage: ['kV', 'V', 'pu'],
  current: ['A'],
  speed: ['m/s'],
  'rotational-speed': ['rpm'],
  'direction-from': ['deg'],
  angle: ['deg'],
  length: ['m'],
  mass: ['kg'],
  volume: ['m3'],
  energy: ['MJ'],
  'specific-energy': ['kJ/kg'],
  concentration: ['ppm'],
  reactivity: ['pcm'],
  'count-rate': ['cps'],
  'log-rate': ['DPM'],
  'dose-rate': ['mSv/h'],
  'precipitation-rate': ['mm/h'],
  fraction: ['1', '%'],
  count: ['1'],
  duration: ['s'],
  state: [''],
} as const satisfies Readonly<Record<string, ReadonlyArray<string>>>
export type Quantity = keyof typeof quantityUnits
export const quantitySchema = z.enum(Object.keys(quantityUnits) as [Quantity, ...Quantity[]])
type UnitCode = (typeof quantityUnits)[Quantity][number]

/**
 * How every display and card writes a number, so a live readout shows exactly
 * the digits its card cites: decimals by unit code (the table T10 passed
 * with), else three significant digits; symbols for the codes that have one.
 */
export const unitDecimals: Readonly<Partial<Record<UnitCode, number>>> = {
  MPa: 2, Pa: 0, '%': 1, degC: 1, 'kg/s': 0, MW: 0, kW: 0, Mvar: 0, Hz: 2, kV: 1, V: 0, A: 0, 'm/s': 1, 'mm/h': 1, m: 0, rpm: 0, ppm: 0, 'mSv/h': 3, cps: 0, '1': 2, deg: 0, s: 0,
}
export const decimalsFor = (unit: string, value: number): number =>
  unitDecimals[unit as UnitCode] ?? (value === 0 ? 2 : Math.max(0, Math.min(6, 2 - Math.floor(Math.log10(Math.abs(value))))))
const unitSymbols: Readonly<Partial<Record<UnitCode, string>>> = { degC: '°C', 'degC/s': '°C/s', deg: '°', m3: 'm³', '1': '' }
/** A unit code as a reader sees it: degC reads °C; a dimensionless 1 and a state's '' read nothing; any other unit is its own symbol. */
export const unitSymbol = (unit: string): string => unitSymbols[unit as UnitCode] ?? unit
/** A number at its decimals, never "-0.0". */
export const numberText = (value: number, unit: string): string => {
  const text = value.toFixed(decimalsFor(unit, value))
  return /^-0(?:\.0+)?$/.test(text) ? text.slice(1) : text
}
/** Seconds as a countdown reads them (45 s, 4 min, 2 h), and metres as a distance (850 m, 12.3 km): the number and the unit it is shown in. */
export const durationParts = (seconds: number): { readonly value: number; readonly unit: 's' | 'min' | 'h' } =>
  seconds < 90 ? { value: Math.round(seconds), unit: 's' } : seconds < 5_400 ? { value: Math.round(seconds / 60), unit: 'min' } : { value: Math.round(seconds / 3_600), unit: 'h' }
export const distanceParts = (metres: number): { readonly value: number; readonly unit: 'm' | 'km' } =>
  metres >= 1_000 ? { value: Number(numberText(metres / 1_000, 'km')), unit: 'km' } : { value: Number(numberText(metres, 'm')), unit: 'm' }

export const thresholdSchema = z.object({
  id: z.string().min(1).max(128),
  direction: z.enum(['low', 'high']),
  value: z.number().finite(),
  order: z.number().int().min(1).max(4),
  effect: z.enum(['alarm', 'trip', 'control', 'rating', 'target', 'advisory']),
  /** Styles the limit tick only; a value's colour comes from its observation. */
  priority: prioritySchema.exclude(['none']),
  consequence: z.string().max(80).optional(),
  when: z.string().max(80).optional(),
}).strict()

export const observableSchema = z.object({
  ref: observableRefSchema,
  label: z.string().min(1).max(80),
  shortLabel: z.string().min(1).max(24).optional(),
  quantity: quantitySchema,
  unit: z.string().max(16),
  valueType: z.enum(['number', 'boolean', 'enum', 'text', 'duration', 'instant']),
  /** `active` marks the state(s) a `running` or `conducting` binding reads as on, running or closed; a boolean observable is on when true. */
  states: z.array(z.object({ value: z.string().min(1), label: z.string().min(1), active: z.literal(true).optional() }).strict()).optional(),
  thresholds: z.array(thresholdSchema).max(12).default([]),
  basis: z.enum(['instrument', 'model', 'command', 'planned']).optional(),
  meaningfulWhile: z.string().max(80).optional(),
  /** Null: observable but not recorded, so no trend is promised. */
  series: z.object({ seriesId: z.string().min(1), intervalMs: z.number().int().positive() }).strict().nullable(),
  /** The Pack's tag, so `objectId#tag` resolves. */
  tag: z.string().min(1).max(64).optional(),
  /** The declared element it is measured on (topology bindings, element classes, alert subjects). */
  element: z.string().min(1).max(200).optional(),
  /** The Pack's declared lead rank, 1 first; an observation's mode-aware `rank` goes before it. */
  lead: z.number().int().positive().optional(),
}).strict().refine(observable => (quantityUnits[observable.quantity] as ReadonlyArray<string>).includes(observable.unit), {
  path: ['unit'], message: 'the unit is not a code listed for this quantity',
})

export const observationSchema = stampSchema.extend({
  ref: observableRefSchema,
  value: z.union([z.number().finite(), z.boolean(), z.string(), z.null()]),
  quality: z.enum(['good', 'uncertain', 'bad', 'stale', 'not-applicable']),
  /** Pack-evaluated, mode- and demand-aware: the value's colour. */
  priority: prioritySchema,
  /** Mode-aware lead order. */
  rank: z.number().int().optional(),
  expected: z.object({ after: z.string().min(1) }).strict().optional(),
  since: stampSchema.optional(),
  /** The id of the declared threshold of this observable the value is past: the one whose alarm colours it, or would if not expected after. */
  past: z.string().min(1).max(128).optional(),
  /** Read only, never journalled. */
  timeToAct: z.object({ threshold: z.string().min(1), seconds: z.number().nonnegative() }).strict().optional(),
  why: z.string().max(300).optional(),
}).strict()

export type Observable = z.output<typeof observableSchema>
export type Observation = z.output<typeof observationSchema>
