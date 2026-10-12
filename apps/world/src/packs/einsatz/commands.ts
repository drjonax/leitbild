import { z } from 'zod'
import { commandInputSchemas, einsatzCommandIds, type CommandInput, type EinsatzCommandId } from './capabilities.ts'
import { notInPicture, refused, type Refused } from './engine/intent-support.ts'
import type { EngineActor, Intent } from './engine/intents.ts'
import type { EngineState } from './engine/model.ts'
import { actorFor, controllerOnly, inPicture, unitAuthority, type EinsatzViewer } from './viewer.ts'

/**
 * A command as the engine runs it: the intent and the actor. Who may ask is
 * checked here, through the viewer; whether the state allows it is checked by
 * the engine when the intent commits.
 */

export interface CommandContext {
  readonly state: EngineState
  readonly viewer: EinsatzViewer
  /** Attribution written to `lastAction.by`. */
  readonly by: string
  /** An id no object of the Run holds, for the record a create adds. */
  readonly newId: (kind: 'unit' | 'task') => string
}

export type PreparedCommand = { readonly ok: true; readonly intent: Intent; readonly actor: EngineActor } | Refused

const firstRefusal = (...checks: ReadonlyArray<Refused | undefined>): Refused | undefined => checks.find(check => check !== undefined)

/** Refused unless the viewer commands the unit; an id the state does not hold is left to the engine, which refuses it without echoing it. */
const commanded = (context: CommandContext, unitId: string): Refused | undefined => {
  const unit = context.state.units.get(unitId)
  return unit === undefined ? undefined : unitAuthority(context.state.catalog, context.viewer, unit)
}

/**
 * Refused unless the record is in the viewer's picture. A task need not be in
 * the viewer's queue: the queue lists a role's work, it does not gate who may
 * send to or close a task it sees.
 */
const seen = (context: CommandContext, id: string): Refused | undefined => {
  const record = context.state.units.get(id) ?? context.state.tasks.get(id)
  return record === undefined || inPicture(context.state.catalog, context.viewer, record) ? undefined : notInPicture()
}

/**
 * A label for a unit created without one: the type's label and the next
 * number no unit of the Run carries. An undeclared type keeps its id; the
 * engine refuses it.
 */
const unitLabel = (state: EngineState, typeId: string): string => {
  const type = state.catalog.types.get(typeId)
  if (type === undefined) return typeId
  const labels = new Set([...state.units.values()].map(unit => unit.label))
  let number = [...state.units.values()].filter(unit => unit.unitType === typeId).length + 1
  while (labels.has(`${type.label} ${number}`)) number += 1
  return `${type.label} ${number}`
}

const intentFor = (context: CommandContext, kind: EinsatzCommandId, payload: unknown): { readonly ok: true; readonly intent: Intent } | Refused => {
  const parse = <K extends EinsatzCommandId>(id: K): CommandInput<K> => commandInputSchemas[id].parse(payload) as CommandInput<K>
  const ok = (intent: Intent, ...checks: ReadonlyArray<Refused | undefined>) => firstRefusal(...checks) ?? { ok: true as const, intent }
  switch (kind) {
    case einsatzCommandIds.send: {
      const input = parse(einsatzCommandIds.send)
      const to = input.to
      const target = 'taskId' in to ? seen(context, to.taskId) : 'siteId' in to ? seen(context, to.siteId) : undefined
      return ok({ kind: 'send', ...input },
        ...input.units.map(unitId => commanded(context, unitId)),
        target,
        ...(input.divert ?? []).map(entry => seen(context, entry.fromTaskId)))
    }
    case einsatzCommandIds.recall: {
      const input = parse(einsatzCommandIds.recall)
      return ok({ kind: 'recall', ...input }, commanded(context, input.unitId), input.fromTaskId === undefined ? undefined : seen(context, input.fromTaskId))
    }
    case einsatzCommandIds.hold: {
      const input = parse(einsatzCommandIds.hold)
      return ok({ kind: 'hold', ...input }, commanded(context, input.unitId))
    }
    case einsatzCommandIds.unitCreate: {
      const input = parse(einsatzCommandIds.unitCreate)
      const only = controllerOnly(context.viewer, 'Creating a unit')
      if (only) return only
      return ok({ kind: 'unit.create', ...input, id: context.newId('unit'), label: input.label ?? unitLabel(context.state, input.type) })
    }
    case einsatzCommandIds.unitAdjust: {
      const input = parse(einsatzCommandIds.unitAdjust)
      return ok({ kind: 'unit.adjust', ...input }, controllerOnly(context.viewer, 'Adjusting a unit'), commanded(context, input.unitId))
    }
    case einsatzCommandIds.taskCreate: {
      const input = parse(einsatzCommandIds.taskCreate)
      const only = controllerOnly(context.viewer, 'Creating a task')
      if (only) return only
      return ok({ kind: 'task.create', ...input, id: context.newId('task') })
    }
    case einsatzCommandIds.taskClose: {
      const input = parse(einsatzCommandIds.taskClose)
      return ok({ kind: 'task.close', ...input }, seen(context, input.taskId))
    }
    case einsatzCommandIds.siteSet: {
      const input = parse(einsatzCommandIds.siteSet)
      return ok({ kind: 'site.set', ...input }, commanded(context, input.siteId))
    }
  }
}

/** A payload that does not parse is the caller's mistake, refused `invalid_input` with the schema's own words. */
const inputIssues = (error: z.ZodError): Refused =>
  refused('invalid_input', error.issues.map(issue => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; '))

/** Parses a command's payload, checks the viewer may ask for it, and names the intent and actor the engine runs. */
export const prepareCommand = (context: CommandContext, kind: EinsatzCommandId, payload: unknown): PreparedCommand => {
  const parsed = commandInputSchemas[kind].safeParse(payload)
  if (!parsed.success) return inputIssues(parsed.error)
  const prepared = intentFor(context, kind, parsed.data)
  if (!prepared.ok) return prepared
  return { ok: true, intent: prepared.intent, actor: actorFor(context.state.catalog, context.viewer, context.by) }
}
