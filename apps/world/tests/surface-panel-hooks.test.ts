import { describe, expect, test } from 'bun:test'
import type { Map as MapLibreMap } from 'maplibre-gl'
import { createActivePackViews } from '../src/core/packs/active-views.ts'
import { createWorldPackDescriptor, type PackSurfacePanelContribution, type PackUiContribution, type WorldPackView } from '../src/core/packs/protocol.ts'
import { assertCameraInteractionContract } from '../src/ui/map/map-camera.ts'
import { knownUiPackIds, loadUiPack } from '../src/ui/pack-loader.ts'
import { geoPointFromLonLat, type IsoTimestamp, type ObjectId, type OperationalObject, type PackId } from '../src/core/model/index.ts'
import { groundClicksWanted, mapClickOutcome, targetPreviewsWanted } from '../src/ui/map-target-routing.ts'
import { assertMapCover, assertPanelInteraction, cameraPaddingFor, mapCameraInteractionFor, noMapCover, openPanelDeclaring, railStartsCollapsed, startingControllerId, surfacePanelPackId } from '../src/ui/surface-panel-interaction.ts'

const panelOf = (id: string, hooks: Pick<PackSurfacePanelContribution, 'mapTargets' | 'keymap'> = {}): PackSurfacePanelContribution => ({
  id,
  label: id,
  defaultOpen: true,
  load: async () => { throw new Error('fixture panels are never loaded') },
  ...hooks,
})

const viewOf = (id: string, ui?: PackUiContribution): WorldPackView => ({
  descriptor: createWorldPackDescriptor({ id, version: '1.0.0', name: id, description: `Fixture ${id}`, contributions: ['presentation'] }),
  presentation: { categories: [], presentObject: () => { throw new Error('fixture Packs present no objects') } },
  ...(ui ? { ui } : {}),
})

const allOn = { doubleClickZoom: true, keyboard: true, boxZoom: true }

describe('World surface hooks among the built-in Packs', () => {
  test('no built-in Pack but Einsatz declares a map-target panel, a keymap, map gestures, a layout hint or opt-in targeting, and the others leave camera, rail and targeting as they were', async () => {
    expect(knownUiPackIds).toContain('einsatz')
    const views = await Promise.all(knownUiPackIds.map(loadUiPack))
    const declaring = views.filter(view => (view.ui?.surfacePanels ?? []).some(panel => panel.mapTargets !== undefined || panel.keymap !== undefined)
      || view.ui?.mapInteraction !== undefined || view.ui?.surfaceLayout !== undefined
      || view.targeting?.describeTarget !== undefined || view.targeting?.pointTargets !== undefined || view.targeting?.mutedOnMap !== undefined)
    expect(declaring.map(view => view.descriptor.id)).toEqual(['einsatz'])
    // Without Einsatz active, every other Pack's view set is as inert as before the hooks existed.
    const others = views.filter(view => view.descriptor.id !== 'einsatz')
    expect(others.length).toBeGreaterThan(0)
    const panels = others.flatMap(view => view.ui?.surfacePanels ?? [])
    expect(openPanelDeclaring(panels, () => true, 'mapTargets')).toBeNull()
    expect(openPanelDeclaring(panels, () => true, 'keymap')).toBeNull()
    expect(mapCameraInteractionFor(others)).toEqual(allOn)
    expect(railStartsCollapsed(others)).toBe(false)
    const active = createActivePackViews(others)
    expect(active.targeting?.describeTarget).toBeUndefined()
    expect(active.targeting?.pointTargets).toBeUndefined()
    expect(active.targeting?.mutedOnMap).toBeUndefined()
    expect(targetPreviewsWanted({ targeting: active.targeting, panel: null })).toBe(false)
    expect(groundClicksWanted({ targeting: active.targeting, panel: null })).toBe(false)
  })

  test('Ambulance still contributes its hold gesture, and a click while it is armed cancels it and is never open ground', async () => {
    expect((await loadUiPack('ambulance')).mapAssignment).toBeDefined()
    for (const handled of [false, true]) expect(mapClickOutcome({ suppressed: false, assignmentActive: true, handled })).toBe('assignment-cancel')
    expect(mapClickOutcome({ suppressed: true, assignmentActive: true, handled: true })).toBe('suppressed')
  })
})

describe('surface panel hooks', () => {
  test('a panel connects exactly the handlers it declares', () => {
    const onMapTarget = () => undefined
    const onKey = () => true
    expect(() => assertPanelInteraction(panelOf('board', { mapTargets: true, keymap: true }), { onMapTarget, onKey })).not.toThrow()
    expect(() => assertPanelInteraction(panelOf('plain'), {})).not.toThrow()
    expect(() => assertPanelInteraction(panelOf('board', { mapTargets: true }), {})).toThrow('declares map targets but connects no onMapTarget')
    expect(() => assertPanelInteraction(panelOf('plain'), { onMapTarget })).toThrow('connects onMapTarget without declaring map targets')
    expect(() => assertPanelInteraction(panelOf('board', { keymap: true }), {})).toThrow('declares a keymap but connects no onKey')
    expect(() => assertPanelInteraction(panelOf('plain'), { onKey })).toThrow('connects onKey without declaring a keymap')
  })

  test('a panel may connect a map-target preview only beside its map targets', () => {
    const onMapTarget = () => undefined
    const previewMapTarget = () => null
    expect(() => assertPanelInteraction(panelOf('board', { mapTargets: true }), { onMapTarget, previewMapTarget })).not.toThrow()
    expect(() => assertPanelInteraction(panelOf('board', { mapTargets: true }), { onMapTarget })).not.toThrow()
    expect(() => assertPanelInteraction(panelOf('plain'), { previewMapTarget })).toThrow('connects previewMapTarget without declaring map targets')
    expect(() => assertPanelInteraction(panelOf('keys', { keymap: true }), { onKey: () => true, previewMapTarget })).toThrow('connects previewMapTarget without declaring map targets')
  })

  test('a panel belongs to the Pack that contributes it', () => {
    const board = panelOf('first.board', { mapTargets: true })
    const packs = [viewOf('first', { surfacePanels: [board] }), viewOf('second', { surfacePanels: [panelOf('second.records')] })]
    expect(surfacePanelPackId(packs, board)).toBe('first')
    expect(() => surfacePanelPackId(packs, panelOf('stray'))).toThrow('Surface panel stray belongs to no active Pack')
  })

  test('the surface selects the first controller at join and after a role switch only while no open panel takes map targets', () => {
    const at = '2026-10-12T08:00:00.000Z' as IsoTimestamp
    const objectOf = (id: string, unit: boolean): OperationalObject => ({
      id: id as ObjectId,
      kind: 'mobile_entity',
      packId: 'first' as PackId,
      label: id,
      lifecycle: 'active',
      revision: 1,
      spatial: { frame: { kind: 'wgs84' }, position: { point: geoPointFromLonLat(11.3, 59.1), observedAt: at } },
      operational: { status: 'normal', mode: 'simulated' },
      alerts: [],
      provenance: { source: 'simulator' },
      timestamps: { createdAt: at, updatedAt: at },
      packData: { unit },
    })
    const objects = [objectOf('task', false), objectOf('unit-1', true), objectOf('unit-2', true)]
    const targeting = {
      isController: (object: OperationalObject) => (object.packData as { readonly unit: boolean }).unit,
      isTarget: () => false,
      buildSetTargetCommand: () => { throw new Error('never sent') },
      buildCancelTargetCommand: () => { throw new Error('never sent') },
    }
    const board = panelOf('first.board', { mapTargets: true })
    const records = panelOf('first.records')
    const views = (panels: ReadonlyArray<PackSurfacePanelContribution>) => createActivePackViews([{ ...viewOf('first', { surfacePanels: panels }), targeting }])
    expect(startingControllerId(objects, views([records]), { objects }, () => true)).toBe('unit-1' as ObjectId)
    expect(startingControllerId(objects, views([records, board]), { objects }, () => true)).toBeNull()
    expect(startingControllerId(objects, views([records, board]), { objects }, panel => panel.id !== board.id)).toBe('unit-1' as ObjectId)
    expect(startingControllerId([objects[0]!], views([records]), { objects }, () => true)).toBeNull()
  })

  test('only an open declaring panel takes map targets or keys', () => {
    const panels = [panelOf('records'), panelOf('board', { mapTargets: true, keymap: true })]
    expect(openPanelDeclaring(panels, () => true, 'mapTargets')?.id).toBe('board')
    expect(openPanelDeclaring(panels, () => true, 'keymap')?.id).toBe('board')
    expect(openPanelDeclaring(panels, panel => panel.id !== 'board', 'keymap')).toBeNull()
  })

  test('active Packs admit one map-target panel and one keymap panel', () => {
    expect(() => createActivePackViews([
      viewOf('first', { surfacePanels: [panelOf('first.board', { keymap: true })] }),
      viewOf('second', { surfacePanels: [panelOf('second.board', { keymap: true })] }),
    ])).toThrow('active Packs declare keymap on more than one surface panel: first.board, second.board')
    expect(() => createActivePackViews([
      viewOf('first', { surfacePanels: [panelOf('first.board', { mapTargets: true })] }),
      viewOf('second', { surfacePanels: [panelOf('second.board', { mapTargets: true })] }),
    ])).toThrow('active Packs declare mapTargets on more than one surface panel')
  })

  test('map gestures go off only where a Pack switches them off, and the rail starts collapsed only on a hint', () => {
    const keyboardPack = viewOf('keys', { surfacePanels: [], mapInteraction: { keyboard: false, doubleClickZoom: false } })
    const boxPack = viewOf('box', { surfacePanels: [], mapInteraction: { boxZoom: false }, surfaceLayout: { railCollapsed: true } })
    expect(mapCameraInteractionFor([viewOf('plain')])).toEqual(allOn)
    expect(mapCameraInteractionFor([viewOf('plain'), keyboardPack])).toEqual({ doubleClickZoom: false, keyboard: false, boxZoom: true })
    expect(mapCameraInteractionFor([keyboardPack, boxPack])).toEqual({ doubleClickZoom: false, keyboard: false, boxZoom: false })
    expect(railStartsCollapsed([keyboardPack])).toBe(false)
    expect(railStartsCollapsed([keyboardPack, boxPack])).toBe(true)
  })
})

describe('camera padding from surface panels', () => {
  test('each edge is padded by the farthest any open panel reaches over it, and nothing without a panel', () => {
    expect(cameraPaddingFor([])).toEqual(noMapCover)
    expect(cameraPaddingFor([{ top: 0, right: 300, bottom: 10, left: 0 }, { top: 40, right: 120, bottom: 0, left: 0 }])).toEqual({ top: 40, right: 300, bottom: 10, left: 0 })
  })

  test('a panel\'s report that is no length is refused, naming the panel and the edge', () => {
    const cover = { top: 0, right: 492, bottom: 0, left: 0 }
    expect(assertMapCover('first.board', cover)).toBe(cover)
    expect(() => assertMapCover('first.board', { top: 0, right: -1, bottom: Number.NaN, left: 0 })).toThrow('Surface panel first.board reported a map cover that is no length: right -1, bottom NaN')
  })
})

describe('map camera contract', () => {
  const fakeMap = () => {
    const handler = (enabled: boolean) => {
      let on = enabled
      return { enable: () => { on = true }, disable: () => { on = false }, isEnabled: () => on }
    }
    return {
      cooperativeGestures: handler(true),
      dragPan: handler(false),
      scrollZoom: handler(true),
      boxZoom: handler(true),
      doubleClickZoom: handler(true),
      touchZoomRotate: handler(true),
      keyboard: handler(true),
    }
  }
  const states = (map: ReturnType<typeof fakeMap>) => Object.fromEntries(Object.entries(map).map(([name, handler]) => [name, handler.isEnabled()]))

  test('keeps every gesture on unless the Packs switch it off, and turns it back on when they no longer do', () => {
    const map = fakeMap()
    assertCameraInteractionContract(map as unknown as MapLibreMap, allOn)
    expect(states(map)).toEqual({ cooperativeGestures: false, dragPan: true, scrollZoom: true, boxZoom: true, doubleClickZoom: true, touchZoomRotate: true, keyboard: true })
    assertCameraInteractionContract(map as unknown as MapLibreMap, { doubleClickZoom: false, keyboard: false, boxZoom: false })
    expect(states(map)).toEqual({ cooperativeGestures: false, dragPan: true, scrollZoom: true, boxZoom: false, doubleClickZoom: false, touchZoomRotate: true, keyboard: false })
    assertCameraInteractionContract(map as unknown as MapLibreMap, allOn)
    expect(states(map)).toEqual({ cooperativeGestures: false, dragPan: true, scrollZoom: true, boxZoom: true, doubleClickZoom: true, touchZoomRotate: true, keyboard: true })
  })

  test('fails visibly when a gesture will not follow the contract', () => {
    const map = { ...fakeMap(), keyboard: { enable: () => undefined, disable: () => undefined, isEnabled: () => false } }
    expect(() => assertCameraInteractionContract(map as unknown as MapLibreMap, allOn)).toThrow('Map camera interactions do not match the contract: keyboard off')
  })
})
