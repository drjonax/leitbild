import type { EinsatzConfig, LoadClass, TaskTemplate, UnitType } from '../config-schema.ts'
import { commandedTypes, commandsUnit, inPicture, ordersOnMap, queuesTask, type PictureTypes, type PictureViewer } from '../picture.ts'
import type { BoardRecords, BoardTask, BoardUnit } from './records.ts'
import type { Arrangement } from './types.ts'

/**
 * The Einsatz rules the Board applies to the records it shows: a task's need
 * for the viewer's units and how a unit stands for dispatch, restated over
 * the configuration because the engine cannot run in the browser;
 * `rules.test.ts` holds them equal to the engine's on real Runs. Who sees,
 * commands and queues what comes from the shared picture rules
 * (`picture.ts`). Coverage itself is never re-derived: the Board reads the
 * coverage the engine wrote into each task.
 */

/** Phases of a unit committed to a task that has not arrived yet: it may still be diverted. */
const divertable: ReadonlyArray<BoardUnit['phase']> = ['mobilizing', 'en-route']
const committedPhases: ReadonlyArray<BoardUnit['phase']> = ['mobilizing', 'en-route', 'on-task']

const total = (counts: Readonly<Record<string, number>>): number => Object.values(counts).reduce((sum, count) => sum + count, 0)

export const hasLoad = (unit: BoardUnit): boolean => total(unit.load) > 0
/** Free: no task and no load, not destroyed, in any phase. */
export const isFree = (unit: BoardUnit): boolean => unit.taskId === undefined && !hasLoad(unit) && unit.integrity !== 'destroyed'

/** What the viewer's units can serve on a task: the services they provide and the load classes they carry. */
export interface RoleView {
  readonly provides: ReadonlySet<string>
  readonly carries: ReadonlySet<string>
}

export interface BoardRules {
  readonly config: EinsatzConfig
  readonly viewer: PictureViewer
  readonly typeOf: (unit: BoardUnit) => UnitType
  readonly templateOf: (task: BoardTask) => TaskTemplate
  readonly loadClass: (classId: string) => LoadClass
  /** Lower is more urgent: the class's index in declared priority order. */
  readonly classRank: (classId: string) => number
  readonly inPicture: (record: BoardUnit | BoardTask) => boolean
  readonly commands: (unit: BoardUnit) => boolean
  /** A commanded unit that can move: one the map selects and the Board orders by map clicks (`ordersOnMap`). */
  readonly ordersOnMap: (unit: BoardUnit) => boolean
  readonly queues: (task: BoardTask) => boolean
  readonly roleView: (records: BoardRecords, task: BoardTask) => RoleView
  readonly isReport: (task: BoardTask) => boolean
  /** The viewer's need on the task, the sort key of an unserved row; undefined when the task is served for the viewer. */
  readonly needFor: (task: BoardTask, view: RoleView) => string | undefined
  /**
   * How a commanded unit stands for dispatch: what a recommendation depends on
   * besides positions. A divertable unit's class names its task's rank, on
   * which its divert protection depends.
   */
  readonly dispatchClass: (records: BoardRecords, unit: BoardUnit) => string
  readonly arrangement: Arrangement
}

const lookup = <T extends { readonly id: string }>(entries: ReadonlyArray<T>, what: string) => {
  const byId = new Map(entries.map(entry => [entry.id, entry]))
  return (id: string): T => {
    const found = byId.get(id)
    if (found === undefined) throw new Error(`${what} ${id} is not declared`)
    return found
  }
}

export const createBoardRules = (config: EinsatzConfig, viewer: PictureViewer): BoardRules => {
  const type = lookup(config.unitTypes, 'Unit type')
  const template = lookup(config.taskTemplates, 'Task template')
  const loadClass = lookup(config.loadClasses, 'Load class')
  const classOrder = new Map(config.loadClasses.map((entry, index) => [entry.id, index]))
  const typeOf = (unit: BoardUnit): UnitType => type(unit.unitType)
  const templateOf = (task: BoardTask): TaskTemplate => template(task.template)
  const types: PictureTypes = { authority: config.authority, unitType: type }
  const commands = (unit: BoardUnit): boolean => commandsUnit(types, viewer, unit)

  const isReport = (task: BoardTask): boolean => templateOf(task).requires.length === 0 && total(task.loads) === 0 && total(task.pickedUp) === 0

  const commanded = commandedTypes(types, viewer, config.unitTypes)
  const queuesAny = viewer.class === 'controller'
    ? config.taskTemplates.length > 0
    : viewer.roles.some(role => role.class === 'operator' && config.authority.some(entry => entry.roleId === role.id && entry.taskTemplates.length > 0))
  const senses = commanded.some(entry => entry.components.sensor !== undefined || entry.components.effector !== undefined)

  return {
    config,
    viewer,
    typeOf,
    templateOf,
    loadClass,
    classRank: classId => {
      const rank = classOrder.get(classId)
      if (rank === undefined) throw new Error(`Load class ${classId} is not declared`)
      return rank
    },
    inPicture: record => inPicture(types, viewer, record),
    commands,
    ordersOnMap: unit => ordersOnMap(types, viewer, unit),
    queues: task => queuesTask(types, viewer, task),
    roleView: (records, task) => {
      const serving = [...records.units.values()]
        .filter(unit => commands(unit) && unit.side === task.side && unit.integrity !== 'destroyed')
        .map(typeOf)
      return {
        provides: new Set(serving.flatMap(entry => entry.components.service?.provides ?? [])),
        carries: new Set(serving.flatMap(entry => entry.components.carry?.classes ?? [])),
      }
    },
    isReport,
    needFor: (task, view) => {
      if (task.closedAtMs !== undefined) return undefined
      const uncovered = task.coverage.loads.find(entry => entry.covered < entry.waiting && view.carries.has(entry.classId))
      if (uncovered !== undefined) return uncovered.classId
      const short = task.coverage.requirements.some(entry => view.provides.has(entry.provides) && entry.enRoute + entry.onTask + entry.completed < entry.count)
      return short || isReport(task) ? task.rank : undefined
    },
    dispatchClass: (records, unit) => {
      if (unit.integrity === 'destroyed') return 'destroyed'
      if (hasLoad(unit)) return 'loaded'
      if (unit.taskId === undefined) return 'free'
      if (!divertable.includes(unit.phase)) return `busy:${unit.taskId}`
      const task = records.tasks.get(unit.taskId)
      if (task === undefined) throw new Error(`${unit.id} is committed to ${unit.taskId}, which is not in the picture`)
      return `divertable:${task.id}:${task.rank}`
    },
    arrangement: {
      lead: queuesAny || !senses ? 'work-list' : 'map',
      workList: queuesAny,
      unitBoard: commanded.some(entry => entry.components.mobility !== undefined),
    },
  }
}

/** Units committed to a task and counted towards it, ordered by id. */
export const assignedUnits = (records: BoardRecords, task: BoardTask): BoardUnit[] =>
  [...records.units.values()]
    .filter(unit => unit.taskId === task.id && committedPhases.includes(unit.phase) && unit.integrity !== 'destroyed' && unit.side === task.side)
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/**
 * The load a unit's release returns to its task: its share of the waiting
 * load as the engine allocates it over the assigned carriers (most urgent
 * class first; carriers of fewer classes, then lower ids, take load first).
 */
export const loadShareOf = (rules: BoardRules, records: BoardRecords, task: BoardTask, unitId: string): Readonly<Record<string, number>> => {
  const carriers = assignedUnits(records, task)
    .map(unit => ({ unit, carry: rules.typeOf(unit).components.carry }))
    .filter((entry): entry is { unit: BoardUnit; carry: NonNullable<UnitType['components']['carry']> } => entry.carry !== undefined)
    .sort((a, b) => a.carry.classes.length - b.carry.classes.length || (a.unit.id < b.unit.id ? -1 : a.unit.id > b.unit.id ? 1 : 0))
  const room = new Map(carriers.map(({ unit, carry }) => [unit.id, Math.max(0, carry.capacity - total(unit.load))]))
  const share: Record<string, number> = {}
  for (const { id: classId } of rules.config.loadClasses) {
    let waiting = task.loads[classId] ?? 0
    for (const { unit, carry } of carriers) {
      if (!carry.classes.includes(classId)) continue
      const taken = Math.min(room.get(unit.id)!, waiting)
      if (taken <= 0) continue
      room.set(unit.id, room.get(unit.id)! - taken)
      waiting -= taken
      if (unit.id === unitId) share[classId] = taken
    }
  }
  return share
}
