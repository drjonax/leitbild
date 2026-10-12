import { describe, expect, test } from 'bun:test'
import { routeDistanceMeters, type IsoTimestamp, type OperationalObject } from '../../../core/model/index.ts'
import { borderDefinitions, roleCommanding, sensingCommandOf } from '../fixtures/border-harness.ts'
import { at, blue, config, cycles, place, red, stateWith, types } from '../fixtures/combat-harness.ts'
import { unitTypeOf, type EngineState } from '../engine/model.ts'
import { engineObjects } from '../engine/objects.ts'
import { openModeViewer, type PictureViewer } from '../picture.ts'
import { roeWords, wordFor } from '../lexicon.ts'
import { contactIcon, contactsView, noFixText, type SideLabel } from './contacts.ts'
import { createBoardController } from './controller.ts'
import { readBoardRecords } from './records.ts'
import { createBoardRules } from './rules.ts'
import { clockText } from './text.ts'
import type { ContactRow, ContactsView } from './types.ts'
import { boardHeightFor, boardSections, listRowsTemplate } from '../ui/board-layout.ts'

/**
 * The Contacts list on an engagement: every track in the screen's picture,
 * in two groups. The Board knows a track only as its side does; its
 * "engageable" group is held here to the engine's truth: the unit each track
 * follows, its type's tags and where it was last seen.
 */

const hold = (unitId: string) => ({ kind: 'set-roe' as const, unitId, roe: 'hold' as const })
const free = (unitId: string) => ({ kind: 'set-roe' as const, unitId, roe: 'free' as const })

/**
 * Blue's scout at the origin and its gun 600 m south, weapons free, against
 * three red guns holding fire due north: one in the gun's range, one the
 * scout keeps in view just beyond it, and one too far to identify, which
 * the scout loses once it halts. After 90 s of engagement steps.
 */
const engagement = async (): Promise<{ readonly state: EngineState; readonly objects: ReadonlyArray<OperationalObject>; readonly nowMs: number }> => {
  const state = (await cycles(await stateWith([
    place('s1', types.blueScout, blue, at(0)),
    place('b1', types.blueGun, blue, at(-600)),
    free('b1'),
    place('near', types.redGun, red, at(1_200)),
    hold('near'),
    place('mid', types.redGun, red, at(1_450)),
    hold('mid'),
    place('far', types.redGun, red, at(2_600)),
    hold('far'),
  ]), 90)).state
  const objects = engineObjects(state, () => ({ at: new Date(state.timeMs).toISOString() as IsoTimestamp, provenance: { source: 'simulator' } }))
  return { state, objects, nowMs: state.timeMs }
}

/** The track a side holds on a unit. */
const trackOn = (state: EngineState, side: string, subjectId: string): string => {
  const track = [...state.combat.tracks.values()].find(entry => entry.side === side && entry.subjectId === subjectId)
  if (track === undefined) throw new Error(`${side} holds no track on ${subjectId}`)
  return track.id
}

const blueCommander = (): PictureViewer => sensingCommandOf(borderDefinitions.scripted, blue)
const declaredSides: ReadonlyArray<SideLabel> = borderDefinitions.scripted.sides ?? []
/** The Controller as the Run declares it: the truth role. */
const controllerViewer = (): PictureViewer => {
  const role = borderDefinitions.scripted.roles?.find(entry => entry.class === 'controller')
  if (role === undefined) throw new Error('halden-border declares no Controller role')
  return { class: 'controller', sees: 'all', roles: [role] }
}

/** What the engine knows that the Board does not: whether one of the viewer's armed units could fire on the track now, its rules of engagement aside. */
const engageableInTruth = (state: EngineState, viewer: PictureViewer, trackId: string): boolean => {
  const track = state.combat.tracks.get(trackId)!
  if (track.tier !== 'identified' || !track.fix || track.identity === undefined) return false
  const rules = createBoardRules(config, viewer, () => [])
  const subjectTags = unitTypeOf(state.catalog, state.units.get(track.subjectId)!).tags
  const seenAt = state.combat.sightings.get(track.id)!.point
  const records = readBoardRecords(engineObjects(state, () => ({ at: new Date(state.timeMs).toISOString() as IsoTimestamp, provenance: { source: 'simulator' } })))
  return [...records.units.values()].some(unit => {
    const effector = unitTypeOf(state.catalog, state.units.get(unit.id)!).components.effector
    return rules.commands(unit) && unit.side === track.side && unit.integrity !== 'destroyed' && effector !== undefined && unit.point !== undefined
      && (config.hostility[unit.side!] ?? []).includes(track.identity!.side)
      && subjectTags.some(tag => effector.targets.includes(tag))
      && routeDistanceMeters(unit.point, seenAt) <= effector.rangeM
  })
}

const rowsOf = (view: ContactsView): ReadonlyArray<ContactRow> => view.sides.flatMap(side => [...side.engageable.rows, ...side.other.rows])
/** The one unlabelled side of a screen that holds one side's tracks. */
const onlySide = (view: ContactsView) => {
  expect(view.sides.map(side => side.label)).toEqual([null])
  return view.sides[0]!
}
const blueRecords = (objects: ReadonlyArray<OperationalObject>) => {
  const all = readBoardRecords(objects)
  return { ...all, tracks: new Map([...all.tracks].filter(([, track]) => Array.isArray(track.audience) && track.audience.includes(blue))) }
}
const metres = (text: string | null): number => {
  if (text === null) return Number.POSITIVE_INFINITY
  const [value, unit] = text.split(' ') as [string, string]
  return Number(value) * (unit === 'km' ? 1_000 : 1)
}

describe('Board Contacts', () => {
  test('groups each of the side\'s tracks as the engine\'s truth would: engageable only when identified, fixed, hostile, a type an own armed unit targets and in its range', async () => {
    const { state, objects, nowMs } = await engagement()
    const viewer = blueCommander()
    const rules = createBoardRules(config, viewer, () => [])
    const records = blueRecords(objects)
    const view = contactsView(rules, records, nowMs, declaredSides)
    const { engageable, other } = onlySide(view)
    const tiers = new Set([...records.tracks.values()].map(track => track.tier))
    // The gun's target in range is engageable; the one beyond its range and the lost contact are not, nearest first.
    expect(engageable.rows.map(row => row.id)).toEqual([trackOn(state, blue, 'near')])
    expect(other.rows.map(row => row.id)).toEqual([trackOn(state, blue, 'mid'), trackOn(state, blue, 'far')])
    expect(tiers).toEqual(new Set(['identified', 'contact']))
    for (const row of engageable.rows) expect(engageableInTruth(state, viewer, row.id)).toBe(true)
    for (const row of other.rows) expect(engageableInTruth(state, viewer, row.id)).toBe(false)
    expect(rowsOf(view).map(row => row.id).sort()).toEqual([...records.tracks.keys()].sort())
    // The groups and what an empty one says are the configuration's words.
    expect([engageable.heading, other.heading, engageable.empty, other.empty]).toEqual([wordFor(config.lexicon, 'engageable'), wordFor(config.lexicon, 'otherTracks'), null, null])
    const nothingInReach = contactsView(rules, { ...records, tracks: new Map([...records.tracks].filter(([id]) => id !== trackOn(state, blue, 'near'))) }, nowMs, declaredSides)
    expect(onlySide(nothingInReach).engageable).toEqual({ heading: wordFor(config.lexicon, 'engageable'), rows: [], empty: wordFor(config.lexicon, 'noTracks') })
  })

  test('a row shows only what the side knows: a contact has no type and a neutral icon, a missing fix says so, and "engaged by" counts the own units that fired on it', async () => {
    const { objects, nowMs } = await engagement()
    const records = blueRecords(objects)
    const view = contactsView(createBoardRules(config, blueCommander(), () => []), records, nowMs, declaredSides)
    for (const row of rowsOf(view)) {
      const track = records.tracks.get(row.id)!
      expect(row.label).toBe(track.label)
      expect(row.typeLabel).toBe(track.identity?.typeLabel ?? null)
      expect(row.icon).toBe(track.identity?.icon ?? contactIcon)
      expect(row.fixText).toBe(track.tier !== 'destroyed' && !track.fix ? noFixText : null)
      expect(row.ageText).toMatch(/^\d+:\d\d$/)
      const firing = [...records.units.values()].filter(unit => unit.target === row.id).length
      expect(row.engagedText).toBe(firing === 0 ? null : `engaged by ${firing}`)
    }
    expect(rowsOf(view).some(row => row.engagedText !== null)).toBe(true)
    for (const group of [onlySide(view).engageable, onlySide(view).other]) {
      const distances = group.rows.map(row => metres(row.distanceText))
      expect(distances).toEqual([...distances].sort((a, b) => a - b))
    }
    expect(view.heading).toBe(config.lexicon.tracks!)
  })

  test('through the controller, a side\'s screen lists only its own side\'s tracks; a role without sensing or firing units gets no Contacts list', async () => {
    const { objects, nowMs } = await engagement()
    const screen = (viewer: PictureViewer) => {
      const board = createBoardController({ config, viewer, declaredRoles: [], sides: declaredSides })
      board.dispatch({ kind: 'snapshot', objects, currentTime: new Date(nowMs).toISOString() as IsoTimestamp, wallMs: 0 })
      return board.view()
    }
    const blueTracks = objects.filter(object => (object.packData as { readonly type?: unknown }).type === 'track' && Array.isArray(object.audience) && object.audience.includes(blue)).map(object => String(object.id))
    const blueView = screen(blueCommander()).contacts!
    expect(rowsOf(blueView).map(row => row.id).sort()).toEqual([...blueTracks].sort())
    const redView = screen(roleCommanding(borderDefinitions.scripted, red, types.redGun)).contacts!
    expect(rowsOf(redView).some(row => blueTracks.includes(row.id))).toBe(false)
    const truth = screen(openModeViewer).contacts!
    expect(rowsOf(truth).length).toBeGreaterThanOrEqual(rowsOf(blueView).length + rowsOf(redView).length)
    expect([blueView.sides.length, redView.sides.length]).toEqual([1, 1])
    const medicalType = config.unitTypes.find(type => type.components.carry !== undefined && type.components.sensor === undefined && type.components.effector === undefined)!
    expect(screen(roleCommanding(borderDefinitions.scripted, blue, medicalType.id)).contacts).toBeNull()
  })

  test('on a screen led by Calls, Contacts folds to one line until a track first becomes engageable, then stays open when nothing is engageable again, so the lists keep their heights', async () => {
    const { objects, nowMs } = await engagement()
    const quiet = objects.filter(object => (object.packData as { readonly type?: unknown }).type !== 'track')
    const board = createBoardController({ config, viewer: openModeViewer, declaredRoles: [], sides: declaredSides })
    const snapshot = (shown: ReadonlyArray<OperationalObject>, wallMs: number) => {
      board.dispatch({ kind: 'snapshot', objects: shown, currentTime: new Date(nowMs).toISOString() as IsoTimestamp, wallMs })
      const view = board.view()
      const sections = boardSections(view.arrangement).filter(section => section !== 'contacts' || !view.contactsFolded)
      return { folded: view.contactsFolded, engageable: view.contacts!.sides.some(side => side.engageable.rows.length > 0), template: listRowsTemplate(sections, boardHeightFor(768 - 44), view.contactsFolded) }
    }
    expect(board.view().arrangement.lead).toBe('work-list')
    const before = snapshot(quiet, 0)
    expect([before.folded, before.engageable]).toEqual([true, false])
    const engaged = snapshot(objects, 1_000)
    expect([engaged.folded, engaged.engageable]).toEqual([false, true])
    // The track leaves the picture: nothing is engageable, and the list stays open, the lists as they were.
    const after = snapshot(quiet, 2_000)
    expect([after.folded, after.engageable]).toEqual([false, false])
    expect(after.template).toBe(engaged.template)
    expect(after.template).not.toBe(before.template)
  })

  test('the Controller\'s screen lists each side\'s tracks under the side\'s declared label, in declared order, so no two rows of a group share a serial', async () => {
    const { objects, nowMs } = await engagement()
    const board = createBoardController({ config, viewer: controllerViewer(), declaredRoles: [], sides: declaredSides })
    board.dispatch({ kind: 'snapshot', objects, currentTime: new Date(nowMs).toISOString() as IsoTimestamp, wallMs: 0 })
    const contacts = board.view().contacts!
    const records = readBoardRecords(objects)
    const observing = new Set([...records.tracks.values()].map(track => (track.audience as ReadonlyArray<string>)[0]!))
    expect(observing).toEqual(new Set([blue, red]))
    expect(contacts.sides.map(side => side.label)).toEqual(declaredSides.map(side => side.label))
    for (const [index, side] of contacts.sides.entries()) {
      const sideId = declaredSides[index]!.id
      for (const group of [side.engageable, side.other]) {
        expect(group.rows.every(row => (records.tracks.get(row.id)!.audience as ReadonlyArray<string>)[0] === sideId)).toBe(true)
        expect(new Set(group.rows.map(row => row.label)).size).toBe(group.rows.length)
      }
    }
    expect(rowsOf(contacts).map(row => row.id).sort()).toEqual([...records.tracks.keys()].sort())
    // Each side numbers its own tracks, so their serials repeat across sides: listed flat, two rows would read the same.
    const labels = rowsOf(contacts).map(row => row.label)
    expect(new Set(labels).size).toBeLessThan(labels.length)
  })

  test('a track identified as what no declared unit type bears is an error, never passed over as a track nobody could fire on', async () => {
    const { objects, nowMs } = await engagement()
    const records = blueRecords(objects)
    const identified = [...records.tracks.values()].find(track => track.identity !== undefined)!
    const tracks = new Map(records.tracks)
    tracks.set(identified.id, { ...identified, identity: { ...identified.identity!, typeLabel: 'Unheard-of' } })
    expect(() => contactsView(createBoardRules(config, blueCommander(), () => []), { ...records, tracks }, nowMs, declaredSides))
      .toThrow(`Track ${identified.label} is identified as Unheard-of/${identified.identity!.icon}, which no declared unit type bears`)
  })

  test('the unit board shows an armed unit\'s rules of engagement and the track it fires on, and how visible each unit stands', async () => {
    const { state, objects, nowMs } = await engagement()
    const board = createBoardController({ config, viewer: blueCommander(), declaredRoles: [], sides: declaredSides })
    board.dispatch({ kind: 'snapshot', objects, currentTime: new Date(nowMs).toISOString() as IsoTimestamp, wallMs: 0 })
    const rows = new Map(board.view().unitBoard.rows.map(row => [row.id, row]))
    const nearTrack = state.combat.tracks.get(trackOn(state, blue, 'near'))!
    expect(rows.get('b1')).toMatchObject({ roeText: roeWords.free, targetText: `→ ${nearTrack.label}`, postureText: 'Revealed' })
    expect(rows.get('s1')).toMatchObject({ roeText: null, targetText: null, postureText: 'Concealed' })
    // Right after it was placed, the scout is still halting: the count runs down to concealment.
    const fresh = createBoardController({ config, viewer: blueCommander(), declaredRoles: [], sides: declaredSides })
    const placed = await stateWith([place('s1', types.blueScout, blue, at(0))])
    fresh.dispatch({ kind: 'snapshot', objects: engineObjects(placed, () => ({ at: new Date(placed.timeMs).toISOString() as IsoTimestamp, provenance: { source: 'simulator' } })), currentTime: new Date(placed.timeMs + 12_000).toISOString() as IsoTimestamp, wallMs: 0 })
    const concealAfterS = config.unitTypes.find(type => type.id === types.blueScout)!.components.signature!.concealAfterS
    expect(fresh.view().unitBoard.rows[0]?.postureText).toBe(`Halting ${clockText(concealAfterS - 12)}`)
  })
})

