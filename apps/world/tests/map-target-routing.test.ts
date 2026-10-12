import { describe, expect, test } from 'bun:test'
import { geoPointFromLonLat, type IsoTimestamp, type ObjectId, type OperationalObject, type PackId } from '../src/core/model/index.ts'
import { createActivePackViews } from '../src/core/packs/active-views.ts'
import { createWorldPackDescriptor, type PackMapTarget, type PackTargetContext, type PackTargetingContribution, type WorldPackView } from '../src/core/packs/protocol.ts'
import { defaultDroneVehicleModels, requireDroneVehicleModel } from '../src/packs/drone/model.ts'
import { navigateDroneCommandKind } from '../src/packs/drone/commands.ts'
import { createScenarioDroneObject } from '../src/packs/drone/native/object-state.ts'
import { dronePackView } from '../src/packs/drone/ui-pack.ts'
import { groundClicksWanted, mapClickOutcome, previewObjectTarget, routeGroundClick, routeObjectClick, targetPickingWanted, targetPreviewsWanted, type MapClickContext, type MapClickOutcome, type MapTargetPanel } from '../src/ui/map-target-routing.ts'

const at = '2026-10-12T08:00:00.000Z' as IsoTimestamp
const ground = geoPointFromLonLat(11.38, 59.12)

const objectOf = (id: string, packId: string, role: 'unit' | 'site' | 'other'): OperationalObject => ({
  id: id as ObjectId,
  kind: role === 'unit' ? 'mobile_entity' : 'facility',
  packId: packId as PackId,
  label: id.toUpperCase(),
  lifecycle: 'active',
  revision: 1,
  spatial: { frame: { kind: 'wgs84' }, position: { point: geoPointFromLonLat(11.37, 59.12), observedAt: at } },
  operational: { status: 'normal', mode: 'simulated' },
  alerts: [],
  provenance: { source: 'simulator' },
  timestamps: { createdAt: at, updatedAt: at },
  packData: { role },
})

const roleOf = (object: OperationalObject): string => (object.packData as { readonly role?: string } | undefined)?.role ?? 'none'

const viewOf = (id: string, targeting?: PackTargetingContribution): WorldPackView => ({
  descriptor: createWorldPackDescriptor({ id, version: '1.0.0', name: id, description: `Fixture ${id}`, contributions: ['presentation'] }),
  presentation: {
    categories: [{ id: `${id}-all`, label: id, emptyLabel: 'None', matches: object => object.packId === id }],
    presentObject: () => ({ categoryId: `${id}-all`, icon: 'square', color: '#334155', summary: '', fields: [] }),
  },
  ...(targeting ? { targeting } : {}),
})

const sendTargeting: PackTargetingContribution = {
  isController: object => roleOf(object) === 'unit',
  isTarget: (_controller, candidate) => roleOf(candidate) === 'site',
  buildSetTargetCommand: (controller, target) => ({ kind: 'fixture.send', targetObjectIds: [controller.id], payload: { to: target.id } }),
  buildCancelTargetCommand: controller => ({ kind: 'fixture.hold', targetObjectIds: [controller.id], payload: {} }),
}

const unit = objectOf('u1', 'fixture', 'unit')
const otherUnit = objectOf('u2', 'fixture', 'unit')
const site = objectOf('s1', 'fixture', 'site')
const other = objectOf('o1', 'fixture', 'other')
const objects = [unit, otherUnit, site, other]
const context: PackTargetContext = { objects }

const clickContext = (targeting: PackTargetingContribution, patch: Partial<MapClickContext> = {}): MapClickContext => ({
  controller: unit,
  targeting: createActivePackViews([viewOf('fixture', targeting)]).targeting,
  context,
  panel: null,
  ...patch,
})

describe('map clicks without a map-target panel', () => {
  test('select controllers and send the Pack command to targets, as the generic surface always did', () => {
    const click = clickContext(sendTargeting)
    expect(routeObjectClick(otherUnit, click)).toEqual({ kind: 'select', objectId: otherUnit.id, note: 'Selected U2; click a valid target' })
    expect(routeObjectClick(site, click)).toEqual({ kind: 'send', command: { kind: 'fixture.send', targetObjectIds: [unit.id], payload: { to: site.id } }, subject: 'Sending U1 to S1' })
    expect(routeObjectClick(other, click)).toEqual({ kind: 'none' })
    expect(routeObjectClick(site, { ...click, controller: null })).toEqual({ kind: 'none' })
  })

  test('ignore open ground and show no preview unless a Pack opts in', () => {
    const click = clickContext(sendTargeting)
    expect(groundClicksWanted(click)).toBe(false)
    // Nor do they pick targets exactly: the map picks glyphs and the top object, as it always has.
    expect(targetPickingWanted(click)).toBe(false)
    expect(routeGroundClick(ground, click)).toEqual({ kind: 'none' })
    expect(previewObjectTarget(site, click)).toBeNull()
  })

  test('word the send and show a refusal through an opted-in target description', () => {
    const describing: PackTargetingContribution = {
      ...sendTargeting,
      describeTarget: (controller, target) => target.kind === 'object' && target.objectId === site.id
        ? { text: `Send ${controller.label} → S1 · 4:20`, refused: false }
        : { text: `${controller.label} cannot go there`, refused: true },
    }
    const click = clickContext(describing)
    expect(routeObjectClick(site, click)).toMatchObject({ kind: 'send', subject: 'Send U1 → S1 · 4:20' })
    expect(routeObjectClick(other, click)).toEqual({ kind: 'note', text: 'U1 cannot go there' })
    expect(previewObjectTarget(site, click)).toEqual({ text: 'Send U1 → S1 · 4:20', refused: false })
    expect(previewObjectTarget(otherUnit, click)).toBeNull()
    expect(previewObjectTarget(unit, click)).toBeNull()
    expect(previewObjectTarget(site, { ...click, controller: null })).toBeNull()
  })

  test('send a point target only for a Pack that takes points', () => {
    const pointing: PackTargetingContribution = {
      ...sendTargeting,
      pointTargets: {
        isTarget: controller => controller.id === unit.id,
        buildSetTargetCommand: (controller, point) => ({ kind: 'fixture.move', targetObjectIds: [controller.id], payload: { point } }),
      },
    }
    const click = clickContext(pointing)
    expect(groundClicksWanted(click)).toBe(true)
    expect(routeGroundClick(ground, click)).toEqual({ kind: 'send', command: { kind: 'fixture.move', targetObjectIds: [unit.id], payload: { point: ground } }, subject: 'Sending U1 to the map point' })
    expect(routeGroundClick(ground, { ...click, controller: otherUnit })).toEqual({ kind: 'none' })
    expect(routeGroundClick(ground, { ...click, controller: null })).toEqual({ kind: 'none' })
  })

  test('hand the screen role view to every targeting decision', () => {
    const seen: Array<PackTargetContext['viewer']> = []
    const roleTargeting: PackTargetingContribution = { ...sendTargeting, isController: (object, given) => { seen.push(given.viewer); return roleOf(object) === 'unit' && given.viewer?.roleIds.includes('ops') === true } }
    const viewer = { roleIds: ['ops'], class: 'operator' as const, sees: 'all' as const }
    expect(routeObjectClick(otherUnit, clickContext(roleTargeting, { context: { objects, viewer } })).kind).toBe('select')
    expect(routeObjectClick(otherUnit, clickContext(roleTargeting, { controller: null, context: { objects, viewer: { ...viewer, roleIds: ['watch'] } } })).kind).toBe('none')
    expect(seen.every(given => given !== undefined)).toBe(true)
  })
})

describe('map clicks with a map-target panel', () => {
  const received: Array<{ readonly controllerId: ObjectId; readonly target: PackMapTarget }> = []
  const panel: MapTargetPanel = { label: 'Board', packId: 'fixture', onMapTarget: (controllerId, target) => { received.push({ controllerId, target }) }, previewMapTarget: null }
  const describingPoints: PackTargetingContribution = {
    ...sendTargeting,
    describeTarget: () => ({ text: 'refused', refused: true }),
    pointTargets: { isTarget: () => true, buildSetTargetCommand: controller => ({ kind: 'fixture.move', targetObjectIds: [controller.id], payload: {} }) },
  }

  test('every target click for the panel Pack\'s controllers goes to the panel and the surface never sends', () => {
    for (const targeting of [sendTargeting, describingPoints]) {
      for (const controller of [unit, otherUnit, null]) {
        const click = clickContext(targeting, { controller, panel })
        for (const object of objects) expect(routeObjectClick(object, click).kind).not.toBe('send')
        expect(routeGroundClick(ground, click).kind).not.toBe('send')
      }
    }
  })

  test('targets carry the selected controller and the clicked object or point', () => {
    const click = clickContext(sendTargeting, { panel })
    expect(groundClicksWanted(click)).toBe(true)
    // The map picks targets exactly for the panel, with or without a controller selected.
    expect([targetPickingWanted(click), targetPickingWanted(clickContext(sendTargeting, { panel, controller: null }))]).toEqual([true, true])
    expect(routeObjectClick(site, click)).toEqual({ kind: 'panel', controllerId: unit.id, target: { kind: 'object', objectId: site.id } })
    expect(routeObjectClick(other, click)).toEqual({ kind: 'panel', controllerId: unit.id, target: { kind: 'object', objectId: other.id } })
    expect(routeGroundClick(ground, click)).toEqual({ kind: 'panel', controllerId: unit.id, target: { kind: 'point', point: ground } })
  })

  test('a controller click selects it quietly, and with no controller a click shares the object selection', () => {
    const click = clickContext(sendTargeting, { panel })
    expect(routeObjectClick(otherUnit, click)).toEqual({ kind: 'select', objectId: otherUnit.id, note: null })
    // A second click on the selected controller is the panel's to read; without a panel it selects it again.
    expect(routeObjectClick(unit, click)).toEqual({ kind: 'panel', controllerId: unit.id, target: { kind: 'object', objectId: unit.id } })
    expect(routeObjectClick(unit, clickContext(sendTargeting))).toEqual({ kind: 'select', objectId: unit.id, note: 'Selected U1; click a valid target' })
    expect(routeObjectClick(site, { ...click, controller: null })).toEqual({ kind: 'select', objectId: site.id, note: null })
    expect(routeGroundClick(ground, { ...click, controller: null })).toEqual({ kind: 'none' })
  })

  test('says so while the panel has not connected, instead of sending on its behalf', () => {
    const click = clickContext(sendTargeting, { panel: { label: 'Board', packId: 'fixture', onMapTarget: null, previewMapTarget: null } })
    expect(routeObjectClick(site, click)).toEqual({ kind: 'note', text: 'Board is still loading; map orders wait for it' })
    expect(routeGroundClick(ground, click)).toEqual({ kind: 'note', text: 'Board is still loading; map orders wait for it' })
  })

  test('a controller of another Pack keeps its own generic targeting and never reaches the panel', () => {
    const foreignUnit = objectOf('f1', 'foreign', 'unit')
    const foreignTargeting: PackTargetingContribution = {
      ...sendTargeting,
      describeTarget: (controller, target) => ({ text: `${controller.label} flies to ${target.kind === 'object' ? target.objectId : 'a point'}`, refused: false }),
    }
    const views = createActivePackViews([viewOf('fixture', sendTargeting), viewOf('foreign', foreignTargeting)])
    const panelPreviews: ObjectId[] = []
    const previewingPanel: MapTargetPanel = { ...panel, previewMapTarget: controllerId => { panelPreviews.push(controllerId); return { text: 'from the Board', refused: false } } }
    const click: MapClickContext = { controller: foreignUnit, targeting: views.targeting, context: { objects: [...objects, foreignUnit] }, panel: previewingPanel }
    const before = received.length
    expect(routeObjectClick(foreignUnit, { ...click, controller: null })).toEqual({ kind: 'select', objectId: foreignUnit.id, note: 'Selected F1; click a valid target' })
    expect(routeObjectClick(site, click)).toEqual({ kind: 'send', command: { kind: 'fixture.send', targetObjectIds: [foreignUnit.id], payload: { to: site.id } }, subject: 'F1 flies to s1' })
    expect(routeObjectClick(other, click)).toEqual({ kind: 'none' })
    expect(routeGroundClick(ground, click)).toEqual({ kind: 'none' })
    expect(previewObjectTarget(site, click)).toEqual({ text: 'F1 flies to s1', refused: false })
    expect(received.length).toBe(before)
    expect(panelPreviews).toEqual([])
    expect(routeObjectClick(site, { ...click, controller: unit })).toEqual({ kind: 'panel', controllerId: unit.id, target: { kind: 'object', objectId: site.id } })
  })
})

describe('objects the screen may not order', () => {
  test('a Pack that mutes objects answers for its own objects only; without one the targeting mutes nothing', () => {
    const muting: PackTargetingContribution = { ...sendTargeting, mutedOnMap: object => roleOf(object) === 'unit' && object.id !== unit.id }
    const foreignUnit = objectOf('f1', 'foreign', 'unit')
    const views = createActivePackViews([viewOf('fixture', muting), viewOf('foreign', sendTargeting)])
    const all = [...objects, foreignUnit]
    expect(all.filter(object => views.targeting?.mutedOnMap?.(object, { objects: all }) === true).map(object => object.id)).toEqual([otherUnit.id])
    expect(createActivePackViews([viewOf('fixture', sendTargeting)]).targeting?.mutedOnMap).toBeUndefined()
  })
})

describe('map target previews', () => {
  const describing: PackTargetingContribution = { ...sendTargeting, describeTarget: () => ({ text: 'Send U1 → S1', refused: false }) }
  const asked: Array<{ readonly controllerId: ObjectId; readonly target: PackMapTarget }> = []
  const previewingPanel: MapTargetPanel = {
    label: 'Board',
    packId: 'fixture',
    onMapTarget: () => undefined,
    previewMapTarget: (controllerId, target) => {
      asked.push({ controllerId, target })
      return target.kind === 'object' && target.objectId === site.id ? { text: 'Dispatch U1 → S1 · 4:20', refused: false } : { text: 'U1 cannot serve O1', refused: true }
    },
  }

  test('a panel that connects a preview answers it for its own controllers instead of describeTarget', () => {
    const click = clickContext(describing, { panel: previewingPanel })
    expect(targetPreviewsWanted(click)).toBe(true)
    expect(previewObjectTarget(site, click)).toEqual({ text: 'Dispatch U1 → S1 · 4:20', refused: false })
    expect(previewObjectTarget(other, click)).toEqual({ text: 'U1 cannot serve O1', refused: true })
    expect(asked).toEqual([{ controllerId: unit.id, target: { kind: 'object', objectId: site.id } }, { controllerId: unit.id, target: { kind: 'object', objectId: other.id } }])
    expect(previewObjectTarget(otherUnit, click)).toBeNull()
    expect(previewObjectTarget(unit, click)).toBeNull()
    expect(previewObjectTarget(site, { ...click, controller: null })).toBeNull()
    expect(asked.length).toBe(2)
  })

  test('without a panel preview the Pack\'s describeTarget answers, and with neither no preview is wanted', () => {
    const silentPanel: MapTargetPanel = { ...previewingPanel, previewMapTarget: null }
    expect(targetPreviewsWanted(clickContext(describing, { panel: silentPanel }))).toBe(true)
    expect(previewObjectTarget(site, clickContext(describing, { panel: silentPanel }))).toEqual({ text: 'Send U1 → S1', refused: false })
    expect(previewObjectTarget(site, clickContext(describing))).toEqual({ text: 'Send U1 → S1', refused: false })
    expect(targetPreviewsWanted(clickContext(sendTargeting, { panel: silentPanel }))).toBe(false)
    expect(targetPreviewsWanted(clickContext(sendTargeting))).toBe(false)
    expect(previewObjectTarget(site, clickContext(sendTargeting, { panel: silentPanel }))).toBeNull()
  })
})

describe('one map click, once every layer has seen it', () => {
  test('a suppressed click is consumed, an armed assignment is cancelled, and only an unhandled click is open ground', () => {
    const outcomes: Record<string, MapClickOutcome> = {}
    for (const suppressed of [false, true]) {
      for (const assignmentActive of [false, true]) {
        for (const handled of [false, true]) outcomes[`${suppressed}/${assignmentActive}/${handled}`] = mapClickOutcome({ suppressed, assignmentActive, handled })
      }
    }
    expect(outcomes).toEqual({
      'false/false/false': 'ground',
      'false/false/true': 'handled',
      'false/true/false': 'assignment-cancel',
      'false/true/true': 'assignment-cancel',
      'true/false/false': 'suppressed',
      'true/false/true': 'suppressed',
      'true/true/false': 'suppressed',
      'true/true/true': 'suppressed',
    })
  })
})

describe('Drone targeting is unchanged', () => {
  test('a drone is selected and sent to a clicked object; ground clicks stay unreported', () => {
    const drone = createScenarioDroneObject({
      id: 'drone:a' as ObjectId,
      label: 'Drone A',
      model: requireDroneVehicleModel('native-survey-quad', defaultDroneVehicleModels),
      point: geoPointFromLonLat(10.75, 59.91),
      altitudeM: 40,
      headingDeg: 0,
      at,
    })
    const target = objectOf('t1', 'fixture', 'other')
    const views = createActivePackViews([dronePackView, viewOf('fixture')])
    const droneContext: PackTargetContext = { objects: [drone, target] }
    const click: MapClickContext = { controller: null, targeting: views.targeting, context: droneContext, panel: null }
    expect(routeObjectClick(drone, click)).toEqual({ kind: 'select', objectId: drone.id, note: 'Selected Drone A; click a valid target' })
    const sent = routeObjectClick(target, { ...click, controller: drone })
    expect(sent).toEqual({ kind: 'send', command: dronePackView.targeting.buildSetTargetCommand(drone, target), subject: 'Sending Drone A to T1' })
    expect(sent.kind === 'send' ? sent.command.kind : null).toBe(navigateDroneCommandKind)
    expect([groundClicksWanted(click), targetPickingWanted(click)]).toEqual([false, false])
    expect(routeGroundClick(ground, { ...click, controller: drone })).toEqual({ kind: 'none' })
    expect(views.targeting?.describeTarget).toBeUndefined()
    expect(views.targeting?.pointTargets).toBeUndefined()
  })
})
