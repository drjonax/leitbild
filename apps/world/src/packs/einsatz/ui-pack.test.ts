import { describe, expect, test } from 'bun:test'
import type { IsoTimestamp, OperationalObject } from '../../core/model/index.ts'
import { borderDefinitions } from './fixtures/border-harness.ts'
import { at, blue, config, cycles, place, red, stateWith, types } from './fixtures/combat-harness.ts'
import { trackDataSchema } from './engine/combat-model.ts'
import { engineObjects } from './engine/objects.ts'
import { einsatzPackView } from './ui-pack.ts'

const { categories, presentObject } = einsatzPackView.presentation

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
      const presentation = presentObject(object)
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
      const presentation = presentObject(contact)
      contactLooks.add(`${presentation.icon} ${presentation.color}`)
      expect(presentation.fields.map(field => field.key)).toEqual(['tier', 'fix'])
      const shown = JSON.stringify(presentation)
      for (const word of [...typeWords, ...sideWords]) expect(shown.includes(word)).toBe(false)
    }
    expect(contactLooks.size).toBe(1)
    for (const track of tracks.filter(object => trackTier(object) !== 'contact')) {
      const data = trackDataSchema.parse(track.packData)
      const presentation = presentObject(track)
      if (data.identity !== undefined) {
        expect(presentation.icon).toBe(data.identity.icon)
        expect(presentation.summary).toContain(data.identity.typeLabel)
        expect(contactLooks.has(`${presentation.icon} ${presentation.color}`)).toBe(false)
      }
      expect(presentation.muted).toBe(data.tier === 'destroyed')
    }
    for (const index of objects.filter(object => (object.packData as { readonly type?: unknown }).type === 'track-index')) {
      expect(presentObject(index).mapIconVisible).toBe(false)
    }
  })
})
