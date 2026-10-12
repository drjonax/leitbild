import { z } from 'zod'
import { commandResultSchema, idSchema, objectIdSchema, type ObjectId } from '../../core/model/index.ts'
import { defineSimulationCommandCapability, defineSimulationQueryCapability } from '../../simulation/capabilities.ts'
import type { SimulationCapability } from '../../simulation/protocol.ts'
import { configurationOutputSchema } from './config-schema.ts'
import { divertsNameSendUnits, divertsNameSendUnitsIssue, intentFields } from './engine/intents.ts'
import { recommendationSchema } from './recommendation-schema.ts'

/**
 * The Einsatz Capabilities. Commands are validated against the current state
 * when they commit, never against a token: a refusal reads `<code>:
 * <message>` in the configuration's own words. Every command is schedulable
 * from the Scenario timeline; creating units and tasks and adjusting
 * property values are controller-only.
 *
 * Every unit carries out a job chain (`orders`, see `steps.ts`): send does
 * it now, queue adds it at the end, step.remove takes one step out, hold
 * pauses the chain and resume continues it, clear empties it and recall
 * empties it and brings the unit home. A command result carries no data, so
 * a send or queue names the step it created in the unit's
 * `lastAction.stepId`, which is how a caller undoes it.
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
  queue: 'world.einsatz.unit.queue',
  stepRemove: 'world.einsatz.unit.step.remove',
  resume: 'world.einsatz.unit.resume',
  clear: 'world.einsatz.unit.clear',
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
  [einsatzCommandIds.queue]: z.object(intentFields.queue).strict(),
  [einsatzCommandIds.stepRemove]: z.object(intentFields.stepRemove).strict(),
  [einsatzCommandIds.resume]: z.object(intentFields.resume).strict(),
  [einsatzCommandIds.clear]: z.object(intentFields.clear).strict(),
}
export type EinsatzCommandId = keyof typeof commandInputSchemas
export type CommandInput<K extends EinsatzCommandId> = z.output<typeof commandInputSchemas[K]>

export const isEinsatzCommand = (kind: string): kind is EinsatzCommandId => Object.hasOwn(commandInputSchemas, kind)

export const recommendInputSchema = z.object({ taskId: idSchema }).strict()

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
    description: 'Do it now: send one or more units, all or nothing, to a task (travel, work on task, deliver load, return), a site, any unit that does not move (deliver while carrying load where it receives load, else go there), a point (a move) or one of their own side\'s tracks (engage, armed units only). The target becomes each unit\'s active step; the steps it has queued stay behind it, except any for the task it now serves. Units not named in divert must be free; a divert names the task each unit leaves and removes only that step, and to another task it is allowed only before arrival and only from work of strictly lower priority than what the target still needs. A divert to a site, point or track releases the unit and moves it. Sending a unit to the task it already serves succeeds and changes nothing. A paused unit, or one waiting for a route, keeps its first step queued, so a send adds a step: one that would leave more than 20 is refused chain_full. Each unit\'s new step id is in its lastAction.stepId. Refusals read <code>: <message>.',
    idempotent: false,
    targets: input => objectIds(...input.units),
  }),
  command({
    id: einsatzCommandIds.queue,
    title: 'Queue a step',
    description: 'Add to the end of a unit\'s job chain: a task (serve), a site, any unit that does not move (deliver while it will carry load where it receives load, else go there), a point (move) or one of its own side\'s tracks (engage, armed units only). A unit holding no step and not paused starts it at once, exactly as a send. A queued step counts towards no task until it is active. A task the chain already holds is taken again only as a further trip for load still waiting there (else requirement_covered). It is judged as the unit will stand when it comes up: a step a loaded unit cannot take before delivering is refused unit_loaded unless its deliver order delivers first; a chain holding 20 steps is refused chain_full (only a loaded unit\'s deliver order may put a 21st, its delivery, in front). The new step id is in the unit\'s lastAction.stepId.',
    idempotent: false,
    targets: input => objectIds(input.unitId),
  }),
  command({
    id: einsatzCommandIds.stepRemove,
    title: 'Remove a step',
    description: 'Remove one step from a unit\'s job chain. A queued step leaves; the active step is released as a recall releases it (load not yet picked up returns to its task) and the unit stops where it is and starts its next step, or, with none left, its return order applies. A unit keeps a step that delivers the load it carries, or will carry by then unless its deliver order delivers it anyway (unit_loaded). An unknown step id is refused step_not_found. Undo a send or queue by removing the step it created with undo: true: only the step the unit\'s last order created (else step_not_undoable), and an active one is released quietly, with no work-returned alert on its task; the order records cause "undo".',
    idempotent: false,
    targets: input => objectIds(input.unitId),
  }),
  command({
    id: einsatzCommandIds.recall,
    title: 'Recall unit',
    description: 'Clear a unit\'s job chain, releasing it from its task, if any, and return it to base. Load not yet picked up returns to the task with its original age. A unit carrying load must deliver first. fromTaskId, when given, must still be the unit\'s task.',
    idempotent: false,
    targets: input => objectIds(input.unitId),
  }),
  command({
    id: einsatzCommandIds.hold,
    title: 'Hold unit',
    description: 'Pause a unit\'s job chain where it is. A unit under way or turning out stops and holds: its active step goes back to the queue, releasing its task, so it counts towards nothing while paused. A unit returning home stops and stands available there. A standing unit keeps its phase; work on task, a handover or an engagement under way goes on in place. A unit that cannot move pauses the engage steps it holds. No further step starts and no deliver or return order runs until resume or a new send.',
    idempotent: true,
    targets: input => objectIds(input.unitId),
  }),
  command({
    id: einsatzCommandIds.resume,
    title: 'Resume unit',
    description: 'Resume a paused unit\'s job chain from the phase it was paused in: its next step starts at once, or, holding none, its deliver and return orders apply as they would have, so a unit parked at a point stays there. A unit that is not paused is left as it is.',
    idempotent: true,
    targets: input => objectIds(input.unitId),
  }),
  command({
    id: einsatzCommandIds.clear,
    title: 'Clear a job chain',
    description: 'Remove every step of a unit\'s job chain, releasing the active one as a recall does. The unit stops where it is and its return order applies. A paused unit holding no step is only resumed, in the phase it idles in. A unit carrying load must deliver first.',
    idempotent: true,
    targets: input => objectIds(input.unitId),
  }),
  command({
    id: einsatzCommandIds.unitCreate,
    title: 'Create unit',
    description: 'Controller only. Add a unit of a declared type at a point, with an optional base, label and property values; unnamed properties take the type\'s defaults. The runtime gives the id. A side is required exactly when the Run declares sides, and a group of that side once the configuration declares groups, unless the type is public.',
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
    description: 'For a task: the smallest set of free units covering what it needs, by fit then ETA; when free units cannot cover it, completed with units still on their way to strictly lower-priority work (diverts), else the best partial set with the remainder named. Also single-unit alternatives (free first, then diverts), ineligible units with the reasons, busy units, and the units that hold the task queued in their job chain (next), which count towards nothing until it is active. A proposed or alternative unit that holds steps says how many (steps): a send replaces its active step, a queue adds behind them. ETAs include turnout and say whether they are routed or straight-line. Where the router fails or finds no route, or a point lies more than 1 km from a road, the ETA is unavailable with the refusal a send would get (routing_unavailable, no_road_near_point) and the straight distance; the recommendation is still given.',
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
