import { geoPointFromLonLat, type GeoJsonPoint } from '../../../core/model/index.ts'
import type { EinsatzConfig, UnitType } from '../config-schema.ts'
import { einsatzConfigSchema } from '../config-validation.ts'
import { advanceEngine, executeIntent } from '../engine/engine.ts'
import { commandsEveryUnit, type EngineActor, type Intent } from '../engine/intents.ts'
import { emptyEngineState, type EngineState, type Transition, type UnitRecord } from '../engine/model.ts'
import type { TrackRecord } from '../engine/combat-model.ts'
import { borderConfig, borderDefinitions, groupOf, isScout, isShooter, ports } from './border-harness.ts'

/**
 * Test-only helpers for engagement tests on the halden-border configuration:
 * unit types found by component and standing order, never by name, units
 * placed in metres from an origin in the group the Definition gives their
 * side and type, and steps of whole engagement cycles.
 * Production code never imports this file.
 */

export const config = borderConfig()
export const [blue, red] = (borderDefinitions.scripted.sides ?? []).map(side => side.id) as [string, string]
export const start = Date.parse(borderDefinitions.scripted.world.startsAt)
export const controller: EngineActor = { by: 'Controller', commandable: commandsEveryUnit }

const only = (what: string, predicate: (type: UnitType) => boolean, from: EinsatzConfig = config): string => {
  const found = from.unitTypes.filter(predicate)
  if (found.length !== 1) throw new Error(`Combat fixture needs exactly one ${what}; found ${found.length}`)
  return found[0]!.id
}
/** The side whose types report step losses as tasks: the one the civil roles serve. */
const reportsLosses = (type: UnitType): boolean => type.standingOrders?.onStepLost !== undefined

export const types = {
  /** Identifying sensor, signature, durability, no effector; reports step losses. */
  blueScout: only('reporting scout', type => isScout(type) && reportsLosses(type)),
  redScout: only('silent scout', type => isScout(type) && !reportsLosses(type)),
  /** Sensor, signature, effector and durability; the blue one reports step losses and returns fire, the red one fires freely. */
  blueGun: only('reporting shooter', type => isShooter(type) && reportsLosses(type)),
  redGun: only('silent shooter', type => isShooter(type) && !reportsLosses(type)),
  /** A sensor that reports contacts only. */
  watcher: only('contact-only sensor', type => type.components.sensor?.identifyM === 0),
}

const metresPerDegreeLat = 110_540
const metresPerDegreeLon = (lat: number): number => 111_320 * Math.cos(lat * Math.PI / 180)
const origin = [11.2, 59.0] as const

/** A point `north` and `east` metres from the origin; distances along one meridian are exact for the engine's metric. */
export const at = (north: number, east = 0): GeoJsonPoint =>
  geoPointFromLonLat(origin[0] + east / metresPerDegreeLon(origin[1] + north / metresPerDegreeLat), origin[1] + north / metresPerDegreeLat)

/** The group halden-border gives a side's units of a type; a side it does not declare has none. */
const groupFor = (side: string, type: string): string | undefined =>
  side === blue || side === red ? groupOf(borderDefinitions.scripted, side, type) : undefined

export const place = (id: string, type: string, side: string, point: GeoJsonPoint, group = groupFor(side, type)): Intent =>
  ({ kind: 'unit.create', id, type, side, at: point, label: id.toUpperCase(), ...(group === undefined ? {} : { group }) })

export const stateWith = async (intents: ReadonlyArray<Intent>, configuration: EinsatzConfig = config, sides: ReadonlyArray<string> = [blue, red]): Promise<EngineState> => {
  let state = emptyEngineState({ config: configuration, sides, timeMs: start })
  for (const intent of intents) state = await run(state, intent)
  return state
}

export const run = async (state: EngineState, intent: Intent, actor: EngineActor = controller): Promise<EngineState> => {
  const outcome = await executeIntent(state, intent, actor, ports)
  if (!outcome.ok) throw new Error(`Refused: ${outcome.reason}`)
  return outcome.state
}

export interface Stepped { readonly state: EngineState; readonly transitions: ReadonlyArray<Transition> }

/** Advances to a Run time in seconds after the start. */
export const advanceTo = async (state: EngineState, seconds: number): Promise<Stepped> => advanceEngine(state, start + seconds * 1_000, ports)

/** Advances cycle by cycle, calling `each` after every 2 s boundary. */
export const cycles = async (state: EngineState, untilSeconds: number, each: (stepped: Stepped, seconds: number) => void = () => undefined): Promise<Stepped> => {
  let current = state
  const transitions: Transition[] = []
  for (let seconds = Math.floor((current.timeMs - start) / 2_000) * 2 + 2; seconds <= untilSeconds; seconds += 2) {
    const stepped = await advanceTo(current, seconds)
    current = stepped.state
    transitions.push(...stepped.transitions)
    each(stepped, seconds)
  }
  return { state: current, transitions }
}

export const fireOn = (state: EngineState, unitId: string): number => state.combat.units.get(unitId)?.fireS ?? 0
export const unit = (state: EngineState, id: string): UnitRecord => {
  const found = state.units.get(id)
  if (found === undefined) throw new Error(`No unit ${id}`)
  return found
}
/** The track a side holds on a unit, if any. */
export const trackOf = (state: EngineState, side: string, subjectId: string): TrackRecord | undefined =>
  [...state.combat.tracks.values()].find(track => track.side === side && track.subjectId === subjectId)

/** A copy of the configuration with changed unit types, for a case the shipped numbers cannot isolate. */
export const withTypes = (change: (type: UnitType) => UnitType, hostility?: EinsatzConfig['hostility']): EinsatzConfig =>
  einsatzConfigSchema.parse({ ...config, unitTypes: config.unitTypes.map(change), ...(hostility === undefined ? {} : { hostility }) })
