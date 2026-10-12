import { z } from 'zod'
import { geoJsonPointSchema, idSchema, type GeoJsonPoint } from '../../core/model/index.ts'

/**
 * Job chains: every unit holds an ordered list of steps in its `packData`
 * (`orders`). The first step is the one the unit carries out (`active`); the
 * steps behind it wait (`queued`). A step that is done or skipped leaves the
 * list: its end shows in the unit's `lastAction`, and a skipped step an
 * actor gave also in a `step_skipped` alert. The head is `queued` only while
 * the unit is paused (`unit.hold`) or waits for a route; the unit then
 * starts it by itself.
 *
 * What a step does follows from its target: a task gives `serve`, a site
 * `deliver` while the unit carries load and a go-to (`move`) otherwise, open
 * ground `move`, and a track `engage` (armed units only). Step ids are
 * stable and unique per unit: `step-<n>`, numbered by the unit's
 * `stepSerial`.
 *
 * This module imports nothing from the engine, so the Board and the map
 * presentation read steps in the browser with the very schema the engine
 * writes.
 */

export const stepKinds = ['serve', 'deliver', 'move', 'engage'] as const
export type StepKind = typeof stepKinds[number]
export const stepStates = ['active', 'queued'] as const
export type StepState = typeof stepStates[number]

/** The most steps an actor's queue or send leaves a unit holding; a step beyond it is refused `chain_full`. */
export const maxSteps = 20

/**
 * The most steps a unit holds: one more than an actor may give it. A loaded
 * unit delivers before any other step, so when its chain says nothing about
 * where, its deliver standing order puts one delivery in front of the
 * chain, which may already be full.
 */
export const maxHeldSteps = maxSteps + 1

/** The longest `by` an order records: role labels held at once, an actor id or a standing order. */
export const orderByMaxLength = 1_000

const pointSchema: z.ZodType<GeoJsonPoint> = geoJsonPointSchema

/** Where a step leads: a task, a site (a unit that does not move; a delivery needs one that receives load), a point on open ground or one of the unit's own side's tracks. */
export const stepTargetSchema = z.union([
  z.object({ taskId: idSchema }).strict(),
  z.object({ siteId: idSchema }).strict(),
  z.object({ point: pointSchema }).strict(),
  z.object({ trackId: idSchema }).strict(),
])
export type StepTarget = z.output<typeof stepTargetSchema>

/** The verb a target gives: a site is a delivery while the unit carries load, otherwise a go-to. */
export const stepKindFor = (target: StepTarget, loaded: boolean): StepKind =>
  'taskId' in target ? 'serve' : 'siteId' in target ? (loaded ? 'deliver' : 'move') : 'point' in target ? 'move' : 'engage'

const kindFits = (kind: StepKind, target: StepTarget): boolean => {
  switch (kind) {
    case 'serve': return 'taskId' in target
    case 'deliver': return 'siteId' in target
    case 'move': return 'point' in target || 'siteId' in target
    case 'engage': return 'trackId' in target
  }
}

export const stepSchema = z.object({
  id: idSchema,
  kind: z.enum(stepKinds),
  target: stepTargetSchema,
  state: z.enum(stepStates),
  /** Who gave the step, as `lastAction.by` names it: role labels, an actor id, or `standing-order:<id>` for one a standing order added. */
  by: z.string().trim().min(1).max(orderByMaxLength),
}).strict().refine(step => kindFits(step.kind, step.target), 'A serve step leads to a task, a deliver step to a site, a move to a point or a site, an engage step to a track')
export type Step = z.output<typeof stepSchema>

/** A unit's chain: distinct step ids, and only the first step may be active. */
export const ordersSchema = z.array(stepSchema).max(maxHeldSteps)
  .refine(steps => new Set(steps.map(step => step.id)).size === steps.length, 'Each step id is used once')
  .refine(steps => steps.every((step, index) => index === 0 || step.state === 'queued'), 'Only the first step may be active')

/** The id of a unit's `serial`-th step. */
export const stepIdOf = (serial: number): string => `step-${serial}`

/** The id a target names: a task, site or track id; a point names none. */
export const stepTargetId = (target: StepTarget): string | undefined =>
  'taskId' in target ? target.taskId : 'siteId' in target ? target.siteId : 'trackId' in target ? target.trackId : undefined
