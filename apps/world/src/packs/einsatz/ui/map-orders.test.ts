import { describe, expect, test } from 'bun:test'
import { scenarioRoleSchema, viewerForRoleSet, type OperationalObject, type RunRoles } from '../../../core/model/index.ts'
import { createActivePackViews } from '../../../core/packs/active-views.ts'
import { createBoardRules } from '../board/rules.ts'
import { readBoardRecords } from '../board/records.ts'
import { einsatzConfigSchema } from '../config-validation.ts'
import { civilConfig, civilKinds, civilWith, taskAt, unitAt } from '../fixtures/board-harness.ts'
import civilRoles from '../fixtures/halden-civil-roles.scenario.json'
import { openRun } from '../fixtures/run-harness.ts'
import { einsatzPackView } from '../ui-pack.ts'
import { boardMapOrders, createMapOrders } from './map-orders.ts'
import { pictureViewerOf, screenViewerFor } from './screen-viewer.ts'

/**
 * Which Einsatz units the map selects for orders: `ordersOnMap` for the
 * screen's role view, over the configuration the Board connected. No unit is
 * a controller before the Board connects or after it releases; a task, a
 * receiving site or another Pack's object never is.
 */

const kinds = civilKinds(civilConfig)
const { carrier, pairServer, site } = kinds.types
const [top] = kinds.classes as [string]
const at = (eastKm: number): [number, number] => [11.38 + eastKm / 57.12, 59.12]
const declaration: RunRoles = { roles: civilRoles.roles.map(role => scenarioRoleSchema.parse(role)), presets: [] }
const roleConfig = einsatzConfigSchema.parse(civilRoles.packs[0]!.config)
/** The operator role whose authority selects a type, found by authority, never by name. */
const roleCommanding = (unitType: string): string => {
  const tags = roleConfig.unitTypes.find(type => type.id === unitType)!.tags
  const entry = roleConfig.authority.find(candidate => 'all' in candidate.units || ('types' in candidate.units ? candidate.units.types.includes(unitType) : candidate.units.tags.some(tag => tags.includes(tag))))
  if (entry === undefined) throw new Error(`No role commands ${unitType}`)
  return entry.roleId
}

const sceneObjects = async (): Promise<ReadonlyArray<OperationalObject>> => {
  const run = await openRun({ definition: civilWith([unitAt('u1', 'U1', carrier, at(0)), unitAt('p1', 'P1', pairServer, at(1)), unitAt('h1', 'H1', site, at(2)), taskAt('t1', 'T1', kinds.templates.load, at(3), { [top]: 1 })]) })
  try { return run.run.snapshot().objects } finally { await run.close() }
}
const byId = (objects: ReadonlyArray<OperationalObject>, id: string): OperationalObject => objects.find(object => object.id === id)!

describe('Einsatz map controllers', () => {
  test('before the Board connects and after it releases no unit is a controller; while connected, only units that can move are, never a site or a task', async () => {
    const objects = await sceneObjects()
    const orders = createMapOrders()
    const controllers = () => objects.filter(object => orders.isController(object, { objects })).map(object => String(object.id))
    expect(controllers()).toEqual([])
    const release = orders.connect({ config: civilConfig, roles: [] })
    expect(controllers().sort()).toEqual(['p1', 'u1'])
    release()
    expect(controllers()).toEqual([])
  })

  test('the Pack view\'s targeting is the Board\'s map orders, and agrees with the Board\'s own rules for each role set', async () => {
    const objects = await sceneObjects()
    const targeting = createActivePackViews([einsatzPackView]).targeting!
    expect(einsatzPackView.targeting.isController).toBe(boardMapOrders.isController)
    const release = boardMapOrders.connect({ config: roleConfig, roles: declaration.roles })
    try {
      const roleSets = [[roleCommanding(carrier)], [roleCommanding(pairServer)], [roleCommanding(carrier), roleCommanding(pairServer)], [declaration.roles.find(role => role.class === 'controller')!.id]]
      for (const roleIds of roleSets) {
        const viewer = viewerForRoleSet(declaration, roleIds)
        const rules = createBoardRules(roleConfig, screenViewerFor({ declaration, roleIds }))
        const records = readBoardRecords(objects)
        for (const id of ['u1', 'p1', 'h1', 't1']) {
          const record = records.units.get(id)
          expect(targeting.isController(byId(objects, id), { objects, viewer })).toBe(record !== undefined && rules.ordersOnMap(record))
        }
      }
      expect(targeting.isController(byId(objects, 'u1'), { objects, viewer: viewerForRoleSet(declaration, [roleCommanding(carrier)]) })).toBe(true)
      expect(targeting.isController(byId(objects, 'p1'), { objects, viewer: viewerForRoleSet(declaration, [roleCommanding(carrier)]) })).toBe(false)
      // The generic map path never sends an Einsatz order.
      expect(targeting.isTarget(byId(objects, 'u1'), byId(objects, 't1'), { objects })).toBe(false)
    } finally {
      release()
    }
  })

  test('a role the Run does not declare and a unit record that does not read are errors, never answered as no controller', async () => {
    const objects = await sceneObjects()
    const orders = createMapOrders()
    orders.connect({ config: roleConfig, roles: declaration.roles })
    expect(() => orders.isController(byId(objects, 'u1'), { objects, viewer: { roleIds: ['nobody'], class: 'operator', sees: 'all' } })).toThrow('The screen holds role nobody, which the Run does not declare')
    const broken = { ...byId(objects, 'u1'), packData: { type: 'unit' } }
    expect(() => orders.isController(broken, { objects })).toThrow()
    expect(orders.isController({ ...byId(objects, 'u1'), packId: 'weather' as OperationalObject['packId'] }, { objects })).toBe(false)
  })

  test('the screen viewer is open mode without roles, and the held roles as declared with core\'s class and sight otherwise', () => {
    expect(screenViewerFor(null)).toEqual({ class: 'controller', sees: 'all', roles: [] })
    const operator = roleCommanding(carrier)
    expect(screenViewerFor({ declaration, roleIds: [operator] })).toEqual({ class: 'operator', sees: 'all', roles: declaration.roles.filter(role => role.id === operator) })
    expect(pictureViewerOf(declaration.roles, undefined)).toEqual({ class: 'controller', sees: 'all', roles: [] })
  })
})
