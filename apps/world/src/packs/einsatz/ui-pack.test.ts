import { describe, expect, test } from 'bun:test'
import type { IsoTimestamp, OperationalObject } from '../../core/model/index.ts'
import { createActivePackViews } from '../../core/packs/active-views.ts'
import { assertContributionDescriptor } from '../../core/packs/assembly.ts'
import { scenarioDefinitionSchema } from '../../core/scenarios/definition.ts'
import { compileScenarioDefinition } from '../../core/scenarios/compiler.ts'
import { createDirectRoutingAdapter } from '../../routing/direct-adapter.ts'
import { mapCameraInteractionFor, openPanelDeclaring, railStartsCollapsed, surfacePanelPackId } from '../../ui/surface-panel-interaction.ts'
import { einsatzCommandIds } from './capabilities.ts'
import { civilConfig, civilKinds, civilWith, taskAt, unitAt } from './fixtures/board-harness.ts'
import { borderDefinitions } from './fixtures/border-harness.ts'
import { at, blue, config, cycles, place, red, stateWith, types } from './fixtures/combat-harness.ts'
import { definitionOf, lonLat, openRun, screenOf, taskItem, unitItem } from './fixtures/run-harness.ts'
import { trackDataSchema } from './engine/combat-model.ts'
import { engineObjects } from './engine/objects.ts'
import { low, templates, types as engineTypes } from './fixtures/engine-harness.ts'
import fixture from './fixtures/engine.config.json'
import { neutralLexicon } from './lexicon.ts'
import { einsatzPack } from './pack.ts'
import { einsatzBoardPanelId, einsatzPackView } from './ui-pack.ts'

const { categories, presentObject } = einsatzPackView.presentation
const civilKind = civilKinds(civilConfig)
const civilTypes = civilKind.types
const civilTemplates = civilKind.templates
const civilTop = civilKind.classes[0]!
const civilAt = (eastKm: number): [number, number] => [11.38 + eastKm / 57.12, 59.12]

/** Every object of an engagement in which one side holds a contact, identified tracks and a track on a unit it saw destroyed. */
const engagementObjects = async (): Promise<OperationalObject[]> => {
  const hold = (unitId: string) => ({ kind: 'set-roe' as const, unitId, roe: 'hold' as const })
  const free = (unitId: string) => ({ kind: 'set-roe' as const, unitId, roe: 'free' as const })
  const state = (await cycles(await stateWith([
    place('r1', types.redGun, red, at(0)),
    hold('r1'),
    place('s1', types.blueScout, blue, at(900)),
    place('r2', types.redGun, red, at(1_150)),
    place('w1', types.watcher, blue, at(0, -400)),
    place('b1', types.blueGun, blue, at(0, 1_800)),
    free('b1'),
    place('far', types.redGun, red, at(-1_800)),
    hold('far'),
  ]), 90)).state
  return engineObjects(state, () => ({ at: new Date(state.timeMs).toISOString() as IsoTimestamp, provenance: { source: 'simulator' } }))
}

const trackTier = (object: OperationalObject): string | undefined => {
  const parsed = trackDataSchema.safeParse(object.packData)
  return parsed.success ? parsed.data.tier : undefined
}

describe('Einsatz presentation', () => {
  test('presents every unit, task, track and track index of an engagement in exactly the category that matches it', async () => {
    const objects = await engagementObjects()
    const tiers = new Set(objects.map(trackTier))
    expect([...tiers].filter(tier => tier !== undefined).sort()).toEqual(['contact', 'destroyed', 'identified'])
    expect(objects.some(object => (object.packData as { readonly type?: unknown }).type === 'track-index')).toBe(true)
    for (const object of objects) {
      const presentation = presentObject(object, { objects })
      expect(categories.filter(category => category.matches(object)).map(category => category.id)).toEqual([presentation.categoryId])
    }
  })

  test('a contact shows a neutral icon and colour and nothing of its type or side; identified and destroyed tracks show what was seen', async () => {
    const objects = await engagementObjects()
    const tracks = objects.filter(object => trackTier(object) !== undefined)
    const contacts = tracks.filter(object => trackTier(object) === 'contact')
    expect(contacts.length).toBeGreaterThan(0)
    const typeWords = config.unitTypes.flatMap(type => [type.label, type.icon])
    const sideWords = (borderDefinitions.scripted.sides ?? []).flatMap(side => [side.id, side.label, side.colour])
    const contactLooks = new Set<string>()
    for (const contact of contacts) {
      const presentation = presentObject(contact, { objects })
      contactLooks.add(`${presentation.icon} ${presentation.color}`)
      expect(presentation.fields.map(field => field.key)).toEqual(['tier', 'fix'])
      const shown = JSON.stringify(presentation)
      for (const word of [...typeWords, ...sideWords]) expect(shown.includes(word)).toBe(false)
    }
    expect(contactLooks.size).toBe(1)
    for (const track of tracks.filter(object => trackTier(object) !== 'contact')) {
      const data = trackDataSchema.parse(track.packData)
      const presentation = presentObject(track, { objects })
      if (data.identity !== undefined) {
        expect(presentation.icon).toBe(data.identity.icon)
        expect(presentation.summary).toContain(data.identity.typeLabel)
        expect(contactLooks.has(`${presentation.icon} ${presentation.color}`)).toBe(false)
      }
      expect(presentation.muted).toBe(data.tier === 'destroyed')
    }
    for (const index of objects.filter(object => (object.packData as { readonly type?: unknown }).type === 'track-index')) {
      expect(presentObject(index, { objects }).mapIconVisible).toBe(false)
    }
  })
})

describe('Einsatz UI declarations', () => {
  test('the Board is the Pack\'s one surface panel: open by default, taking map targets and keys, under an id whose first segment is the Pack\'s', () => {
    const panels = einsatzPackView.ui.surfacePanels
    expect(panels.map(panel => ({ id: panel.id, label: panel.label, defaultOpen: panel.defaultOpen, mapTargets: panel.mapTargets, keymap: panel.keymap })))
      .toEqual([{ id: einsatzBoardPanelId, label: neutralLexicon.workList, defaultOpen: true, mapTargets: true, keymap: true }])
    expect(einsatzBoardPanelId.split('.')[0]).toBe(einsatzPackView.descriptor.id)
    const active = createActivePackViews([einsatzPackView])
    expect(openPanelDeclaring(active.surfacePanels, () => true, 'mapTargets')?.id).toBe(einsatzBoardPanelId)
    expect(openPanelDeclaring(active.surfacePanels, () => true, 'keymap')?.id).toBe(einsatzBoardPanelId)
    expect(surfacePanelPackId(active.packs, panels[0]!)).toBe(einsatzPackView.descriptor.id)
  })

  test('the Board\'s Pack is found through a copy of its panel, as the route\'s deep state hands it over a different proxy per path', () => {
    const active = createActivePackViews([einsatzPackView])
    const proxied = new Proxy(active.surfacePanels[0]!, {})
    expect(proxied).not.toBe(einsatzPackView.ui.surfacePanels[0])
    expect(surfacePanelPackId(active.packs, proxied)).toBe(einsatzPackView.descriptor.id)
    expect(surfacePanelPackId(active.packs, { ...einsatzPackView.ui.surfacePanels[0]! })).toBe(einsatzPackView.descriptor.id)
    expect(() => surfacePanelPackId(active.packs, { ...einsatzPackView.ui.surfacePanels[0]!, id: 'other.board' })).toThrow('Surface panel other.board belongs to no active Pack')
  })

  test('the Pack switches off the map gestures its keys and clicks would collide with, and starts the surface with the rail collapsed', () => {
    expect(mapCameraInteractionFor([einsatzPackView])).toEqual({ doubleClickZoom: false, keyboard: false, boxZoom: false })
    expect(railStartsCollapsed([einsatzPackView])).toBe(true)
  })

  test('the descriptor declares every contribution the Pack makes, targeting included, so registering it is not refused', () => {
    expect(einsatzPackView.descriptor.contributions.map(contribution => contribution.kind).sort()).toEqual(['presentation', 'runtime', 'scenario', 'targeting'])
    expect(() => assertContributionDescriptor(einsatzPack)).not.toThrow()
  })

  test('no Einsatz category takes a rail section: the Board is the only unit and task list', async () => {
    expect(categories.map(category => category.rail)).toEqual(categories.map(() => false))
    const definition = scenarioDefinitionSchema.parse(civilWith([unitAt('u1', 'U1', civilTypes.carrier, civilAt(0)), taskAt('t1', 'T1', civilTemplates.load, civilAt(1), { [civilTop]: 1 })]))
    const compiled = await compileScenarioDefinition(definition, [einsatzPack], { routing: createDirectRoutingAdapter() })
    expect(compiled.view.rail.sections).toEqual([])
    // A Starting View may still name one.
    const named = await compileScenarioDefinition({ ...definition, view: { ...definition.view, rail: { sections: [{ categoryId: categories[0]!.id, visible: true, collapsed: false, visibleFields: [] }] } } }, [einsatzPack], { routing: createDirectRoutingAdapter() })
    expect(named.view.rail.sections.map(section => section.categoryId)).toEqual([categories[0]!.id])
  })

  test('the generic map path never sends an Einsatz order: the Board takes them all', async () => {
    const objects = await engagementObjects()
    const unitObject = objects.find(object => (object.packData as { readonly type?: unknown }).type === 'unit')!
    const { targeting } = einsatzPackView
    expect(targeting.isTarget()).toBe(false)
    expect(() => targeting.buildSetTargetCommand(unitObject)).toThrow('Einsatz map orders go through the Board')
    expect(() => targeting.buildCancelTargetCommand(unitObject)).toThrow('Einsatz map orders go through the Board')
    // Without a connected Board, no unit is a map controller.
    expect(objects.filter(object => targeting.isController(object, { objects }))).toEqual([])
  })

  test('units are labelled with callsign, phase code and damage and toned free, committed or out of action; sites, tasks and tracks carry their labels; every object draws its catalogue icon', async () => {
    const run = await openRun({ definition: civilWith([unitAt('u1', 'U1', civilTypes.carrier, civilAt(0)), unitAt('h1', 'H1', civilTypes.site, civilAt(2)), taskAt('t1', 'T1', civilTemplates.load, civilAt(1), { [civilTop]: 1 })]) })
    try {
      const present = (id: string) => {
        const objects = run.run.snapshot().objects
        return presentObject(objects.find(object => object.id === id)!, { objects })
      }
      expect(present('u1')).toMatchObject({ mapLabel: 'U1 · AV', status: { tone: 'ready' }, icon: civilConfig.unitTypes.find(type => type.id === civilTypes.carrier)!.icon })
      expect(present('h1')).toMatchObject({ mapLabel: 'H1', icon: civilConfig.unitTypes.find(type => type.id === civilTypes.site)!.icon })
      expect(present('h1').status).toBeUndefined()
      expect(present('t1')).toMatchObject({ mapLabel: 'T1', icon: civilConfig.taskTemplates.find(template => template.id === civilTemplates.load)!.icon })
      const sent = await run.invoke(einsatzCommandIds.send, { units: ['u1'], to: { taskId: 't1' } })
      expect(sent.ok).toBe(true)
      expect(present('u1')).toMatchObject({ mapLabel: expect.stringMatching(/^U1 · (MOB|ER)$/), status: { tone: 'working' } })
      const closed = await run.invoke(einsatzCommandIds.siteSet, { siteId: 'h1', accepting: false })
      expect(closed.ok).toBe(true)
      expect(present('h1').mapLabel).toBe('H1 · closed')
    } finally {
      await run.close()
    }

    const objects = await engagementObjects()
    const currentTime = new Date(Math.max(...objects.map(object => Date.parse(object.timestamps.updatedAt)))).toISOString() as IsoTimestamp
    for (const object of objects) {
      const data = object.packData as { readonly type: string; readonly integrity?: string }
      const presentation = presentObject(object, { objects, currentTime })
      if (data.type === 'unit') expect(presentation.mapLabel).toMatch(new RegExp(`^${object.label} · [A-Z]+( · DMG)?$`))
      if (data.type === 'unit' && data.integrity === 'damaged') expect(presentation.mapLabel).toEndWith(' · DMG')
      if (data.type === 'unit' && data.integrity === 'destroyed') expect(presentation.status?.tone).toBe('error')
      if (data.type === 'track') {
        expect(presentation.mapLabel).toMatch(new RegExp(`^${object.label} · \\d+:\\d\\d$`))
        expect(presentObject(object, { objects }).mapLabel).toBe(object.label)
      }
    }
  })

  test('a unit of a group whose role the screen does not see is not drawn, nor is its planned path; without a See choice, and for other objects, nothing changes', async () => {
    const declared = {
      roles: [{ id: 'control', label: 'Control', class: 'controller' as const }],
      config: { ...fixture, groups: [{ id: 'near', label: 'Near', category: 'Crews' }, { id: 'far', label: 'Far', category: 'Crews' }] },
    }
    const run = await openRun({
      definition: definitionOf([
        { ...unitItem('n1', engineTypes.roadCarrier, lonLat(0)), group: 'near' },
        { ...unitItem('f1', engineTypes.roadCarrier, lonLat(0.001)), group: 'far' },
        unitItem('clinic', engineTypes.publicSite, lonLat(0.002)),
        taskItem('t1', templates.load, lonLat(0.003), { [low]: 1 }),
      ], undefined, declared),
      paused: true,
    })
    try {
      const seen = (seenRoleIds?: ReadonlyArray<string>) => seenRoleIds === undefined ? {} : { seenRoleIds }
      const drawn = (seenRoleIds?: ReadonlyArray<string>) =>
        ['n1', 'f1', 'clinic', 't1'].filter(id => presentObject(run.object(id)!, { objects: [run.object(id)!], ...seen(seenRoleIds) }).mapIconVisible !== false)
      expect(drawn()).toEqual(['n1', 'f1', 'clinic', 't1'])
      expect(drawn(['control', 'group:near', 'group:far'])).toEqual(['n1', 'f1', 'clinic', 't1'])
      expect(drawn(['control', 'group:near'])).toEqual(['n1', 'clinic', 't1'])
      expect(drawn([])).toEqual(['clinic', 't1'])

      const control = screenOf(declared, 'control')
      expect((await run.invoke(einsatzCommandIds.send, { units: ['n1'], to: { point: { type: 'Point', coordinates: lonLat(0.004) } } }, control)).ok).toBe(true)
      expect((await run.invoke(einsatzCommandIds.queue, { unitId: 'n1', to: { taskId: 't1' } }, control)).ok).toBe(true)
      const paths = (seenRoleIds?: ReadonlyArray<string>) =>
        einsatzPackView.presentation.mapFeatures({ objects: run.run.snapshot().objects, ...seen(seenRoleIds) }).map(feature => feature.id)
      expect(paths()).toEqual([expect.stringMatching(/^einsatz-plan:n1:step-/)])
      expect(paths(['control', 'group:near'])).toEqual(paths())
      expect(paths(['control', 'group:far'])).toEqual([])
    } finally {
      await run.close()
    }
  })
})
