import { z } from 'zod'
import { commandResultSchema, idSchema, objectIdSchema, type ObjectId } from '../../core/model/index.ts'
import { defineSimulationCommandCapability, defineSimulationQueryCapability } from '../../simulation/capabilities.ts'
import type { SimulationCapability } from '../../simulation/protocol.ts'
import { einsatzConfigShapeSchema } from './config-schema.ts'
import { divertsNameSendUnits, divertsNameSendUnitsIssue, intentFields } from './engine/intents.ts'
import { recommendationSchema } from './recommendation-schema.ts'

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
