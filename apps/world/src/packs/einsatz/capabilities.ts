import { z } from 'zod'
import { commandResultSchema, idSchema, objectIdSchema, type ObjectId } from '../../core/model/index.ts'
import { defineSimulationCommandCapability, defineSimulationQueryCapability } from '../../simulation/capabilities.ts'
import type { SimulationCapability } from '../../simulation/protocol.ts'
import { configIdSchema, einsatzConfigShapeSchema } from './config-schema.ts'
import { divertsNameSendUnits, divertsNameSendUnitsIssue, intentFields } from './engine/intents.ts'

/**
 * The Einsatz Capabilities. Commands are validated against the current state
 * when they commit, never against a token: a refusal reads `<code>:
 * <message>` in the configuration's own words. Every command is schedulable
 * from the Scenario timeline; creating units and tasks and adjusting
 * property values are controller-only.
 */

export const einsatzCommandIds = {
  send: 'world.einsatz.unit.send',
  recall: 'world.einsatz.unit.recall',
  hold: 'world.einsatz.unit.hold',
  unitCreate: 'world.einsatz.unit.create',
  unitAdjust: 'world.einsatz.unit.adjust',
  taskCreate: 'world.einsatz.task.create',
  taskClose: 'world.einsatz.task.close',
  siteSet: 'world.einsatz.site.set',
  setRoe: 'world.einsatz.unit.set-roe',
  engage: 'world.einsatz.unit.engage',
} as const
export const einsatzQueryIds = {
  recommend: 'world.einsatz.recommend',
  configuration: 'world.einsatz.configuration',
} as const

export const commandInputSchemas = {
  [einsatzCommandIds.send]: z.object(intentFields.send).strict().refine(divertsNameSendUnits, divertsNameSendUnitsIssue),
  [einsatzCommandIds.recall]: z.object(intentFields.recall).strict(),
  [einsatzCommandIds.hold]: z.object(intentFields.hold).strict(),
  [einsatzCommandIds.unitCreate]: z.object({ ...intentFields.unitCreate, label: intentFields.unitCreate.label.optional() }).strict(),
  [einsatzCommandIds.unitAdjust]: z.object(intentFields.unitAdjust).strict(),
  [einsatzCommandIds.taskCreate]: z.object(intentFields.taskCreate).strict(),
  [einsatzCommandIds.taskClose]: z.object(intentFields.taskClose).strict(),
  [einsatzCommandIds.siteSet]: z.object(intentFields.siteSet).strict(),
  [einsatzCommandIds.setRoe]: z.object(intentFields.setRoe).strict(),
  [einsatzCommandIds.engage]: z.object(intentFields.engage).strict(),
}
export type EinsatzCommandId = keyof typeof commandInputSchemas
export type CommandInput<K extends EinsatzCommandId> = z.output<typeof commandInputSchemas[K]>

export const isEinsatzCommand = (kind: string): kind is EinsatzCommandId => Object.hasOwn(commandInputSchemas, kind)

export const recommendInputSchema = z.object({ taskId: idSchema }).strict()

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

export const configurationOutputSchema = z.object({ revision: z.number().int().nonnegative(), config: einsatzConfigShapeSchema }).strict()

const objectIds = (...ids: ReadonlyArray<string>): ReadonlyArray<ObjectId> => ids.map(id => objectIdSchema.parse(id))

const command = <K extends EinsatzCommandId>(config: {
  readonly id: K
  readonly title: string
  readonly description: string
  readonly idempotent: boolean
  readonly targets: (input: CommandInput<K>) => ReadonlyArray<ObjectId>
}): SimulationCapability => defineSimulationCommandCapability({
  id: config.id,
  title: config.title,
  description: config.description,
  input: commandInputSchemas[config.id],
  output: commandResultSchema,
  idempotent: config.idempotent,
  schedulable: true,
  buildCommand: raw => {
    const payload = commandInputSchemas[config.id].parse(raw) as CommandInput<K>
    return { targetObjectIds: config.targets(payload), payload }
  },
})

export const einsatzCapabilities: ReadonlyArray<SimulationCapability> = [
  command({
    id: einsatzCommandIds.send,
    title: 'Send units',
    description: 'Send one or more units, all or nothing, to a task (travel, work on task, deliver load, return), a receiving site or a point (a move). Units not named in divert must be free; a divert names the task each unit leaves, and to another task it is allowed only before arrival and only from work of strictly lower priority than what the target still needs. A divert to a site or point releases the unit and moves it. Sending a unit to the task it already serves succeeds and changes nothing. Refusals read <code>: <message>.',
    idempotent: false,
    targets: input => objectIds(...input.units),
  }),
  command({
    id: einsatzCommandIds.recall,
    title: 'Recall unit',
    description: 'Release a unit from its task, if any, and return it to base. Load not yet picked up returns to the task with its original age. A unit carrying load must deliver first. fromTaskId, when given, must still be the unit\'s task.',
    idempotent: false,
    targets: input => objectIds(input.unitId),
  }),
  command({
    id: einsatzCommandIds.hold,
    title: 'Hold unit',
    description: 'Halt a free unit where it is. A unit committed to a task is recalled or moved instead.',
    idempotent: true,
    targets: input => objectIds(input.unitId),
  }),
  command({
    id: einsatzCommandIds.unitCreate,
    title: 'Create unit',
    description: 'Controller only. Add a unit of a declared type at a point, with an optional base, label and property values; unnamed properties take the type\'s defaults. The runtime gives the id. A side is required exactly when the Run declares sides.',
    idempotent: false,
    targets: () => [],
  }),
  command({
    id: einsatzCommandIds.unitAdjust,
    title: 'Adjust unit properties',
    description: 'Controller only. Set property values of a unit, validated against its type, with a recorded reason. A committed unit may not drop below a condition of its task\'s requirement.',
    idempotent: true,
    targets: input => objectIds(input.unitId),
  }),
  command({
    id: einsatzCommandIds.taskCreate,
    title: 'Create task',
    description: 'Controller only. Add a task from a declared template at a point, with counted load per load class. A template without a priority floor needs load. The runtime gives the id.',
    idempotent: false,
    targets: () => [],
  }),
  command({
    id: einsatzCommandIds.taskClose,
    title: 'Close task',
    description: 'Close a task, such as a report that needs no unit. Load not yet picked up is dropped; units still committed to it stop and are free.',
    idempotent: false,
    targets: input => objectIds(input.taskId),
  }),
  command({
    id: einsatzCommandIds.siteSet,
    title: 'Open or close a site',
    description: 'Set whether a receiving site accepts arrivals. When it stops accepting, units under a deliver standing order heading or queued there deliver elsewhere at once; handovers under way finish.',
    idempotent: true,
    targets: input => objectIds(input.siteId),
  }),
  command({
    id: einsatzCommandIds.setRoe,
    title: 'Set rules of engagement',
    description: 'Set a unit\'s rules of engagement from the next 2 s engagement step on: hold (never fire), return-fire (fire only on tracks whose unit fired in the last 60 s) or free (fire on any eligible track). Only a unit with an effector has rules of engagement.',
    idempotent: true,
    targets: input => objectIds(input.unitId),
  }),
  command({
    id: einsatzCommandIds.engage,
    title: 'Engage a track',
    description: 'Name one of the unit\'s own side\'s tracks as its priority target: an identified track of a hostile side whose type the unit\'s effector targets. The unit fires on it whenever the fire gate passes (a fire-control fix, in range, and the rules of engagement allow); otherwise it keeps its current or nearest eligible target. A track of another side is refused cross_side_reference; a contact, a destroyed track or one the unit cannot engage is refused track_not_engageable.',
    idempotent: true,
    targets: input => objectIds(input.unitId),
  }),
  defineSimulationQueryCapability({
    id: einsatzQueryIds.recommend,
    title: 'Recommend units for a task',
    description: 'For a task: the smallest set of free units covering what it needs, by fit then ETA; when free units cannot cover it, completed with units still on their way to strictly lower-priority work (diverts), else the best partial set with the remainder named. Also single-unit alternatives (free first, then diverts), ineligible units with the reasons, and busy units. ETAs include turnout and say whether they are routed or straight-line. Where the router fails or finds no route, or a point lies more than 1 km from a road, the ETA is unavailable with the refusal a send would get (routing_unavailable, no_road_near_point) and the straight distance; the recommendation is still given.',
    input: recommendInputSchema,
    output: recommendationSchema,
    inspectObjectIds: raw => objectIds(recommendInputSchema.parse(raw).taskId),
  }),
  defineSimulationQueryCapability({
    id: einsatzQueryIds.configuration,
    title: 'Read the Einsatz configuration',
    description: 'The whole configuration in force (unit types, properties, task templates, load classes, wording, authority) and its revision. Authoring material: no instances or positions.',
    input: z.object({}).strict(),
    output: configurationOutputSchema,
  }),
]
