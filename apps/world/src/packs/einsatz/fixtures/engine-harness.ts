import { geoPointFromLonLat, type GeoJsonPoint } from '../../../core/model/index.ts'
import { createDirectRoutingAdapter } from '../../../routing/direct-adapter.ts'
import type { TaskTemplate, UnitType } from '../config-schema.ts'
import { einsatzConfigSchema } from '../config-validation.ts'
import { taskIn, unitIn } from '../engine/draft.ts'
import { advanceEngine, executeIntent, type EnginePorts } from '../engine/engine.ts'
import { commandsEveryUnit, type EngineActor, type Intent, type IntentOf } from '../engine/intents.ts'
import { emptyEngineState, motionOf, type EngineState, type TaskRecord, type UnitRecord } from '../engine/model.ts'
import { refusalCode, type EinsatzRefusalCode } from '../refusal.ts'
import fixture from './engine.config.json'

/**
 * Test-only harness for the Einsatz engine tests: the neutral engine fixture
 * configuration, the direct router, and helpers that run intents and read
 * refusal codes. Types and templates are found by their components and
 * requirements, never by name. Production code never imports this file.
 */

export const start = Date.parse('2026-01-01T09:00:00Z')
export const config = einsatzConfigSchema.parse(fixture)
export const ports: EnginePorts = { routing: createDirectRoutingAdapter() }
export const controller: EngineActor = { by: 'Controller', commandable: commandsEveryUnit }

const only = <T extends { readonly id: string }>(entries: ReadonlyArray<T>, what: string): string => {
  if (entries.length !== 1) throw new Error(`Engine fixture needs exactly one ${what}; found ${entries.length}`)
  return entries[0]!.id
}
const typeWhere = (what: string, predicate: (type: UnitType) => boolean): string => only(config.unitTypes.filter(predicate), what)
const templateWhere = (what: string, predicate: (template: TaskTemplate) => boolean): string => only(config.taskTemplates.filter(predicate), what)
const whereOn = (template: TaskTemplate, property: string): boolean => template.requires.some(requirement => requirement.where.some(condition => condition.property === property))

export const types = {
  /** Road mobility, serves, carries one load, delivers and returns by standing order. */
  roadCarrier: typeWhere('road carrier', type => type.components.carry !== undefined && type.components.mobility?.mode === 'road'),
  /** Direct mobility, serves, carries two loads, no standing orders. */
  directCarrier: typeWhere('direct carrier', type => type.components.carry !== undefined && type.components.mobility?.mode === 'direct'),
  /** Serves the requirement with a payload condition. */
  payloadServer: typeWhere('payload server', type => type.properties.some(property => property.id === 'payloadKg')),
  /** Serves the requirement counted twice; carries nothing. */
  pairServer: typeWhere('pair server', type => config.taskTemplates.some(template => template.requires.some(requirement => requirement.count === 2 && type.components.service?.provides.includes(requirement.provides) === true))),
  publicSite: typeWhere('public site', type => type.public && type.components.receiving !== undefined),
  sidedSite: typeWhere('sided site', type => !type.public && type.components.receiving !== undefined),
  /** No components at all. */
  inert: typeWhere('inert type', type => Object.keys(type.components).length === 0),
}

export const templates = {
  /** Counted load only: no requirement, no floor. */
  load: templateWhere('load template', template => template.requires.length === 0 && template.priorityClass === undefined),
  /** A requirement with a `where` on the road carrier's property. */
  lift: templateWhere('lift template', template => whereOn(template, 'liftKg')),
  payload: templateWhere('payload template', template => whereOn(template, 'payloadKg')),
  pair: templateWhere('pair template', template => template.requires.some(requirement => requirement.count === 2)),
  /** Nothing to serve, ranked by its floor. */
  report: templateWhere('report template', template => template.requires.length === 0 && template.priorityClass !== undefined),
}

/** Load classes in priority order. */
export const [top, middle, low] = config.loadClasses.map(loadClass => loadClass.id) as [string, string, string]

/** A point east and north of the fixture origin, in degrees. */
export const at = (east: number, north = 0): GeoJsonPoint => geoPointFromLonLat(11 + east, 59 + north)

export const emptyState = (sides: ReadonlyArray<string> = []): EngineState => emptyEngineState({ config, sides, timeMs: start })

export const run = async (state: EngineState, intent: Intent, actor: EngineActor = controller): Promise<EngineState> => {
  const outcome = await executeIntent(state, intent, actor, ports)
  if (!outcome.ok) throw new Error(`Refused: ${outcome.reason}`)
  return outcome.state
}

export const runAll = async (state: EngineState, intents: ReadonlyArray<Intent>): Promise<EngineState> => {
  let current = state
  for (const intent of intents) current = await run(current, intent)
  return current
}

export const refusalOf = async (state: EngineState, intent: Intent, actor: EngineActor = controller): Promise<{ readonly code: EinsatzRefusalCode; readonly reason: string }> => {
  const outcome = await executeIntent(state, intent, actor, ports)
  if (outcome.ok) throw new Error(`Expected a refusal of ${intent.kind}`)
  return { code: refusalCode(outcome.reason), reason: outcome.reason }
}

export const advance = async (state: EngineState, toMs: number): Promise<EngineState> => (await advanceEngine(state, toMs, ports)).state

export const unitOf = (state: EngineState, id: string): UnitRecord => unitIn(state, id)
export const taskOf = (state: EngineState, id: string): TaskRecord => taskIn(state, id)
export const pointOf = (state: EngineState, id: string): GeoJsonPoint => motionOf(state, id).point

export const newUnit = (id: string, type: string, point: GeoJsonPoint, extra: Partial<IntentOf<'unit.create'>> = {}): Intent =>
  ({ kind: 'unit.create', id, type, at: point, label: id.toUpperCase(), ...extra })

export const newTask = (id: string, template: string, point: GeoJsonPoint, loads?: Readonly<Record<string, number>>, extra: Partial<IntentOf<'task.create'>> = {}): Intent =>
  ({ kind: 'task.create', id, template, at: point, label: id.toUpperCase(), ...(loads === undefined ? {} : { loads }), ...extra })

export const send = (units: ReadonlyArray<string>, to: IntentOf<'send'>['to'], divert?: IntentOf<'send'>['divert']): Intent =>
  ({ kind: 'send', units: [...units], to, ...(divert === undefined ? {} : { divert }) })

/** Run time a unit reaches the end of its current leg from now at full pace, on the Run's millisecond clock. */
export const arrivalAt = (state: EngineState, id: string): number => {
  const unit = unitOf(state, id)
  if (unit.leg === undefined) throw new Error(`${id} has no leg`)
  const startMs = unit.phase === 'mobilizing' ? unit.phaseDueMs! : state.timeMs
  const remainingMs = unit.leg.durationMs - motionOf(state, id).progressMs
  return remainingMs <= 0 ? startMs : startMs + Math.max(1, Math.ceil(remainingMs))
}
