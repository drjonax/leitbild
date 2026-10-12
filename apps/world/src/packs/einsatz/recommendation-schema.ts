import { z } from 'zod'
import { idSchema } from '../../core/model/index.ts'
import { configIdSchema } from './config-schema.ts'

/**
 * The `world.einsatz.recommend` answer's wire schema. It imports nothing from
 * the engine or the Capability module, so the Board validates each answer it
 * receives in the browser with the very schema the Capability declares.
 */

const seconds = z.number().finite().nonnegative()
const metres = z.number().finite().nonnegative()
/**
 * Time to arrive, turnout included. `routed` comes from the road router;
 * `straight-line` from a direct unit or a Run on the direct router. Where a
 * send of the unit would be refused for its route (the router fails or finds
 * no route, or a point lies more than 1 km from a road) the ETA is
 * unavailable: the reason reads `<code>: <message>` with that refusal's code,
 * and only the straight distance is shown.
 */
export const etaSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('routed'), seconds, distanceM: metres }).strict(),
  z.object({ kind: z.literal('straight-line'), seconds, distanceM: metres }).strict(),
  z.object({ kind: z.literal('unavailable'), reason: z.string().min(1), straightDistanceM: metres }).strict(),
])
const classRefSchema = z.object({ id: configIdSchema, code: z.string().min(1) }).strict()
const candidateSchema = z.object({
  unitId: idSchema,
  label: z.string().min(1),
  eta: etaSchema,
  /** Present on a divert: the task the unit leaves and that task's rank. */
  divertFrom: z.object({ taskId: idSchema, label: z.string().min(1), rank: classRefSchema }).strict().optional(),
  /**
   * Present when the unit holds steps in its job chain: how many. A unit on a
   * move or an engagement, or one paused with steps, is free to send, but a
   * send replaces its active step and keeps the rest (do now), while a queue
   * adds the task behind them (add to end); the caller asks which.
   */
  steps: z.number().int().positive().optional(),
}).strict()

export const recommendationSchema = z.object({
  taskId: idSchema,
  rank: classRefSchema,
  /** The most urgent thing still uncovered for the caller's units; null when the task is served for them. */
  need: classRefSchema.nullable(),
  proposal: z.object({
    units: z.array(candidateSchema),
    /** Whether the proposal, with the units already assigned, serves the task for the caller's units. */
    covers: z.boolean(),
    /** What the task still needs after the proposal, in configuration words. */
    remainder: z.array(z.string().min(1)),
  }).strict(),
  /** Single units to send instead: free units first, then divert candidates, each by fit then ETA. */
  alternatives: z.array(candidateSchema),
  /** Units that provide what the task needs but cannot count towards it, with the reasons in property and lexicon words. */
  ineligible: z.array(z.object({ unitId: idSchema, label: z.string().min(1), reasons: z.array(z.string().min(1)).min(1) }).strict()),
  /** Units that could serve but are busy and may not be diverted. */
  committed: z.array(z.object({ unitId: idSchema, label: z.string().min(1), reason: z.string().min(1) }).strict()),
  /**
   * Units in the caller's picture that hold this task as a queued step of
   * their job chain, nearest first: it is their next job once the
   * `stepsAhead` steps before it are done. A queued step counts towards
   * nothing, so these units never cover the task until it is active; the
   * Board shows them as "next".
   */
  next: z.array(z.object({ unitId: idSchema, label: z.string().min(1), stepId: idSchema, stepsAhead: z.number().int().nonnegative() }).strict()),
  /**
   * What the task would still need from the caller's units, in configuration
   * words, were the units under `next` whose next job it is (queued behind at
   * most the step they are carrying out) on their way beside those assigned
   * now: empty when they would serve it. A call they serve is covered next;
   * one they serve only in part still needs the rest.
   */
  nextRemainder: z.array(z.string().min(1)),
  /**
   * False when no unit of the task's side, commanded by the caller or not and
   * busy or not, could ever serve what the task still needs after the
   * proposal: no unit provides a short requirement and meets its conditions,
   * or none carries an uncovered load class. It judges the whole task, not
   * only the caller's part of it, which `remainder` names.
   */
  servable: z.boolean(),
}).strict()
export type Recommendation = z.output<typeof recommendationSchema>
export type Eta = z.output<typeof etaSchema>
