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

export const thresholdSchema = z.object({
  id: z.string().min(1).max(128),
  direction: z.enum(['low', 'high']),
  value: z.number().finite(),
  order: z.number().int().min(1).max(4),
  effect: z.enum(['alarm', 'trip', 'control', 'rating', 'target']),
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
  states: z.array(z.object({ value: z.string().min(1), label: z.string().min(1) }).strict()).optional(),
  thresholds: z.array(thresholdSchema).max(12).default([]),
  basis: z.enum(['instrument', 'model', 'command', 'planned']).optional(),
  meaningfulWhile: z.string().max(80).optional(),
  /** Null: observable but not recorded, so no trend is promised. */
  series: z.object({ seriesId: z.string().min(1), intervalMs: z.number().int().positive() }).strict().nullable(),
  /** The Pack's tag, so `objectId#tag` resolves. */
  tag: z.string().min(1).max(64).optional(),
  /** The declared element it is measured on (topology bindings, element classes, alert subjects). */
  element: z.string().min(1).max(200).optional(),
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
  /** Read only, never journalled. */
  timeToAct: z.object({ threshold: z.string().min(1), seconds: z.number().nonnegative() }).strict().optional(),
  why: z.string().max(300).optional(),
}).strict()

export type Observable = z.output<typeof observableSchema>
export type Observation = z.output<typeof observationSchema>
