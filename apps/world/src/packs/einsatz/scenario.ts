import { z } from 'zod'
import { geoPointFromLonLat, idSchema, type IsoTimestamp, type OperationalObject, type ScenarioSide } from '../../core/model/index.ts'
import type { PackScenarioSupport } from '../../core/packs/protocol.ts'
import { configIdSchema } from './config-schema.ts'
import { einsatzConfigSchema } from './config-validation.ts'
import { commitIntent } from './engine/engine.ts'
import { commandsEveryUnit, type EngineActor, type Intent } from './engine/intents.ts'
import { propertyValueSchema } from './engine/model.ts'
import { audienceOf, readEngineState, transitionObject, type ObjectStamp } from './engine/objects.ts'
import { einsatzAdapterId, einsatzPackId } from './ids.ts'

/**
 * The Einsatz scenario codec. A Pack Selection holds the configuration and
 * two item types: a unit of a declared type (a receiving type makes it a
 * site) and a task from a declared template. Items expand in order through
 * the same engine intents a command or cue runs, so an item is refused for
 * exactly the reasons `unit.create` or `task.create` would be. An item names
 * its side exactly when the Scenario declares sides.
 */

const lonLatSchema = z.tuple([z.number().finite().min(-180).max(180), z.number().finite().min(-90).max(90)])
const itemBase = { pack: z.literal(einsatzPackId), id: idSchema, label: z.string().trim().min(1).max(120), side: configIdSchema.optional(), position: lonLatSchema }

export const unitItemSchema = z.object({
  ...itemBase,
  type: z.literal('unit'),
  unitType: configIdSchema,
  base: lonLatSchema.optional(),
  properties: z.record(configIdSchema, propertyValueSchema).optional(),
}).strict()
export const taskItemSchema = z.object({
  ...itemBase,
  type: z.literal('task'),
  template: configIdSchema,
  loads: z.record(configIdSchema, z.number().int().min(1).max(1_000)).optional(),
}).strict()
const itemSchema = z.discriminatedUnion('type', [unitItemSchema, taskItemSchema])
type Item = z.output<typeof itemSchema>

/** Initial objects are authored, not ordered by anyone in the Run. */
const authored: EngineActor = { by: 'scenario', commandable: commandsEveryUnit }

const intentOf = (item: Item): Intent => {
  const common = { id: item.id, label: item.label, at: geoPointFromLonLat(...item.position), ...(item.side === undefined ? {} : { side: item.side }) }
  return item.type === 'unit'
    ? { kind: 'unit.create', ...common, type: item.unitType, ...(item.base === undefined ? {} : { base: geoPointFromLonLat(...item.base) }), ...(item.properties === undefined ? {} : { properties: item.properties }) }
    : { kind: 'task.create', ...common, template: item.template, ...(item.loads === undefined ? {} : { loads: item.loads }) }
}

/** The engine state of the objects authored so far, at the Scenario's start, on the sides it declares. */
const authoredState = (config: unknown, objects: ReadonlyArray<OperationalObject>, at: IsoTimestamp, sides: ReadonlyArray<ScenarioSide>) =>
  readEngineState({ config: einsatzConfigSchema.parse(config), sides: sides.map(side => side.id), objects, runtime: { timeMs: Date.parse(at), units: {}, combat: { units: {}, tracks: {} } } })

export const einsatzScenarioSupport: PackScenarioSupport = {
  itemSchemas: { unit: unitItemSchema, task: taskItemSchema },
  expandItem: (raw, context) => {
    const item = itemSchema.parse(raw)
    const state = authoredState(context.packConfigs[einsatzPackId], context.objects, context.at, context.sides)
    const outcome = commitIntent(state, intentOf(item), authored, [])
    if (!outcome.ok) throw new Error(`Einsatz item ${item.id}: ${outcome.reason}`)
    const transition = outcome.transitions.filter(entry => entry.record.id === item.id).at(-1)
    if (transition === undefined) throw new Error(`Einsatz item ${item.id} produced no object`)
    if (transition.kind !== 'unit' && transition.kind !== 'task') throw new Error(`Einsatz item ${item.id} produced a ${transition.kind}, not a unit or a task`)
    const audience = audienceOf(outcome.state, transition.record)
    const stamp: ObjectStamp = { at: context.at, provenance: { source: 'simulator', adapterId: einsatzAdapterId, externalId: item.id }, ...(audience === undefined ? {} : { audience }) }
    return { objects: [transitionObject(outcome.state, transition, stamp)] }
  },
  validateInitialObjects: (objects, config, at, sides) => { authoredState(config, objects, at, sides) },
}
