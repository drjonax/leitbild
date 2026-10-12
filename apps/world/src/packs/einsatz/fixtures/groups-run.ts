import type { ScenarioRole, ScenarioSide } from '../../../core/model/index.ts'
import { low, templates, types } from './engine-harness.ts'
import fixture from './engine.config.json'
import { lonLat, taskItem, unitItem, type RoleRunDeclaration, type TaskItem, type UnitItem } from './run-harness.ts'

/**
 * Test-only: a sided role Run of the engine fixture configuration that
 * declares groups. North holds two carrier groups, a guard group and a desk
 * role commanding every North road carrier by authority; South holds one
 * carrier group. A public clinic receives load; North's tasks need carriage,
 * guarding, and nothing a unit serves. Production code never imports this
 * file.
 */

export const groupSides: ReadonlyArray<ScenarioSide> = [
  { id: 'north', label: 'North', colour: '#1565c0' },
  { id: 'south', label: 'South', colour: '#c62828' },
]

/** Declared roles: a controller, and one operator role commanding by authority beside the groups. */
export const groupDeclaredRoles: ReadonlyArray<ScenarioRole> = [
  { id: 'north-desk', label: 'North desk', class: 'operator', sees: ['north'] },
  { id: 'control', label: 'Control', class: 'controller', sees: 'all' },
]

export const groups = [
  { id: 'haul-a', label: 'Haulers A', category: 'Haulers', side: 'north' },
  { id: 'haul-b', label: 'Haulers B', category: 'Haulers', side: 'north' },
  { id: 'guards', label: 'Guards', category: 'Guards', side: 'north' },
  { id: 'raid', label: 'Raiders', category: 'Haulers', side: 'south' },
]

export const groupConfig = {
  ...fixture,
  hostility: { north: ['south'], south: ['north'] },
  authority: [{ roleId: 'north-desk', units: { types: [types.roadCarrier] }, taskTemplates: [templates.report] }],
  groups,
}

export const groupDeclaration: RoleRunDeclaration = { roles: groupDeclaredRoles, sides: groupSides, config: groupConfig }

export const placed = <T extends UnitItem | TaskItem>(item: T, fields: Record<string, unknown>): T => ({ ...item, ...fields })

/** Two North carrier groups, a North guard, a South carrier; a public clinic; tasks needing carriage, guarding and nothing. */
export const groupItems = [
  placed(unitItem('a1', types.roadCarrier, lonLat(0)), { side: 'north', group: 'haul-a' }),
  placed(unitItem('a2', types.directCarrier, lonLat(0.001)), { side: 'north', group: 'haul-a' }),
  placed(unitItem('b1', types.roadCarrier, lonLat(0.002)), { side: 'north', group: 'haul-b' }),
  placed(unitItem('g1', types.pairServer, lonLat(0.003)), { side: 'north', group: 'guards' }),
  placed(unitItem('r1', types.roadCarrier, lonLat(0.004)), { side: 'south', group: 'raid' }),
  unitItem('clinic', types.publicSite, lonLat(0.02)),
  placed(taskItem('load', templates.load, lonLat(0.01), { [low]: 1 }), { side: 'north' }),
  placed(taskItem('pair', templates.pair, lonLat(0.01)), { side: 'north' }),
  placed(taskItem('note', templates.report, lonLat(0.01)), { side: 'north' }),
]
