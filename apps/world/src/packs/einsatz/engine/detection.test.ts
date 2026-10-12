import { describe, expect, test } from 'bun:test'
import type { IsoTimestamp, OperationalObject } from '../../../core/model/index.ts'
import { advanceTo, at, blue, config, cycles, place, red, run, start, stateWith, trackOf, types } from '../fixtures/combat-harness.ts'
import { removeRecords } from '../runtime/removal.ts'
import { trackDataSchema } from './combat-model.ts'
import { fixWindowMs, sense, signatureFactor, trackTimeoutMs } from './detection.ts'
import type { UnitRecord } from './model.ts'
import { engineObjects, readEngineState, runtimeStateOf } from './objects.ts'
import { refusalCode } from '../refusal.ts'
import { trackDeletionRefusal, trackIndexObject, trackObject } from './track-objects.ts'

const typeOf = (id: string) => config.unitTypes.find(type => type.id === id)!
const sensorOf = (id: string) => typeOf(id).components.sensor!
const signatureOf = (id: string) => typeOf(id).components.signature!

/** Furthest distance, to the metre, at which a sensor reaches a tier against a factor. */
const reach = (sensor: ReturnType<typeof sensorOf>, factor: number, tier: 'contact' | 'identified'): number => {
  let metres = 0
  while (sense(sensor, metres + 1, factor) !== undefined && (tier === 'contact' || sense(sensor, metres + 1, factor) === 'identified')) metres += 1
  return metres
}

describe('Einsatz detection', () => {
  test('the shipped numbers give the emergent ranges: halted scouts see far and are seen close, firing reveals', () => {
    const moving = {} as UnitRecord
    const halted = { stillSinceMs: start - 60_000 } as UnitRecord
    const justStopped = { stillSinceMs: start - 29_000 } as UnitRecord
    const quiet = { fireS: 0 }
    const fired = { fireS: 0, firedAtMs: start - 1_000 }
    const gunSignature = signatureOf(types.redGun)
    const scoutSignature = signatureOf(types.blueScout)
    // A halted scout identifies moving shooters at 2.0 km while they see it only at 0.3 km.
    expect(reach(sensorOf(types.blueScout), signatureFactor(gunSignature, moving, quiet, start), 'identified')).toBe(2_000)
    expect(reach(sensorOf(types.redGun), signatureFactor(scoutSignature, halted, quiet, start), 'identified')).toBe(300)
    // Halted shooters are seen at 0.75 km by shooters, and at 2.0 km by a scout once they fire.
    expect(reach(sensorOf(types.redGun), signatureFactor(gunSignature, halted, quiet, start), 'contact')).toBe(750)
    expect(reach(sensorOf(types.redScout), signatureFactor(gunSignature, halted, fired, start), 'identified')).toBe(2_000)
    // A contact-only sensor never identifies, even at point blank.
    expect(sense(sensorOf(types.watcher), 0, 1)).toBe('contact')
    // Halting counts only after concealAfterS of standing still; firing reveals for 60 s.
    expect(signatureFactor(gunSignature, justStopped, quiet, start)).toBe(gunSignature.factor)
    expect(signatureFactor(gunSignature, halted, { fireS: 0, firedAtMs: start - 60_000 }, start)).toBe(gunSignature.factor * gunSignature.haltedFactor)
  })

  test('each side holds one track per unit, numbered from its own serial, identification sticks and a contact-only sensor never fixes', async () => {
    let state = await stateWith([
      place('s1', types.blueScout, blue, at(0)),
      place('w1', types.watcher, blue, at(0, 300)),
      place('g1', types.redGun, red, at(1_400)),
      place('g2', types.redGun, red, at(2_400)),
      place('s2', types.redScout, red, at(-1_500)),
    ])
    state = (await advanceTo(state, 2)).state
    // Not yet halted, g1 at 1.4 km is identified; g2 at 2.4 km is a contact.
    expect(trackOf(state, blue, 'g1')).toMatchObject({ tier: 'identified', fix: true, label: 'T-1', id: `track:${blue}:1` })
    expect(trackOf(state, blue, 'g2')).toMatchObject({ tier: 'contact', fix: true, label: 'T-2' })
    expect(trackOf(state, blue, 'g2')!.identity).toBeUndefined()
    // Red numbers its own tracks: its first is T-1 too, so no number tells one side about the other.
    expect(trackOf(state, red, 's1')).toMatchObject({ label: 'T-1', id: `track:${red}:1` })
    expect(new Set([...state.combat.tracks.values()].map(track => `${track.side}/${track.subjectId}`)).size).toBe(state.combat.tracks.size)
    // Halted for 30 s, g1 (f 0.5) is only within contact range of the scout, yet stays identified and fixed, and is refreshed.
    state = (await advanceTo(state, 40)).state
    expect(trackOf(state, blue, 'g1')).toMatchObject({ tier: 'identified', fix: true })
    expect(state.combat.sightings.get(trackOf(state, blue, 'g1')!.id)!.observedAtMs).toBe(start + 40_000)
    // A unit only the contact-only sensor sees is a contact without a fix.
    state = removeRecords(state, new Set(['s1'])).state
    state = await run(state, place('g3', types.redGun, red, at(400, 300)))
    const seen = (await advanceTo(state, 50)).state
    expect(trackOf(seen, blue, 'g3')).toMatchObject({ tier: 'contact', fix: false })
    expect(seen.combat.sightings.get(trackOf(seen, blue, 'g3')!.id)!.fixAtMs).toBeUndefined()
  })

  test('no unit or task may take an id the engine gives a track or a track index', async () => {
    const state = await stateWith([])
    const template = config.taskTemplates.find(entry => entry.priorityClass !== undefined)!
    for (const id of [`track:${blue}:1`, `tracks:${blue}`]) {
      await expect(run(state, place(id, types.blueScout, blue, at(0)))).rejects.toThrow('reserved_id: ')
      await expect(run(state, { kind: 'task.create', id, template: template.id, side: blue, at: at(0), label: id })).rejects.toThrow('reserved_id: ')
    }
  })

  test('a fix lasts three cycles after the last identifying detection and a track is dropped after its timeout', async () => {
    let state = await stateWith([place('s1', types.blueScout, blue, at(0)), place('g1', types.redGun, red, at(1_000))])
    state = (await advanceTo(state, 10)).state
    const track = trackOf(state, blue, 'g1')!
    state = removeRecords(state, new Set(['s1'])).state
    const fixes: boolean[] = []
    state = (await cycles(state, 18, stepped => { fixes.push(stepped.state.combat.tracks.get(track.id)!.fix) })).state
    expect(fixWindowMs).toBe(6_000)
    expect(fixes).toEqual([true, true, false, false])
    expect((await advanceTo(state, 10 + trackTimeoutMs / 1_000 - 2)).state.combat.tracks.has(track.id)).toBe(true)
    const dropped = await advanceTo(state, 10 + trackTimeoutMs / 1_000)
    expect(dropped.state.combat.tracks.has(track.id)).toBe(false)
    expect(dropped.transitions.filter(transition => transition.kind === 'track-dropped').map(transition => transition.record.id)).toEqual([track.id])
  })

  test('the Run may not delete a live track or a track index, while a track the engine drops at its timeout deletes itself', async () => {
    let state = await stateWith([place('s1', types.blueScout, blue, at(0)), place('g1', types.redGun, red, at(1_000))])
    state = (await advanceTo(state, 10)).state
    const track = trackOf(state, blue, 'g1')!
    expect(refusalCode(trackDeletionRefusal(state.combat, track.id)!)).toBe('track_not_deletable')
    expect(refusalCode(trackDeletionRefusal(state.combat, `tracks:${blue}`)!)).toBe('track_not_deletable')
    expect(trackDeletionRefusal(state.combat, 'g1')).toBeUndefined()
    expect(trackDeletionRefusal(state.combat, `tracks:${red}`)).toBeUndefined()
    state = removeRecords(state, new Set(['s1'])).state
    const dropped = await advanceTo(state, 10 + trackTimeoutMs / 1_000)
    expect(dropped.transitions.filter(transition => transition.kind === 'track-dropped').map(transition => transition.record.id)).toEqual([track.id])
    expect(trackDeletionRefusal(dropped.state.combat, track.id)).toBeUndefined()
    expect(refusalCode(trackDeletionRefusal(dropped.state.combat, `tracks:${blue}`)!)).toBe('track_not_deletable')
  })

  test('a track carries exactly its whitelist, as engine record and as object, and the index of what it follows is truth only', async () => {
    let state = await stateWith([
      place('s1', types.blueScout, blue, at(0)),
      place('g1', types.redGun, red, at(1_500)),
      place('g2', types.redGun, red, at(2_600)),
      place('g3', types.redGun, red, at(-1_000)),
    ])
    state = (await advanceTo(state, 4)).state
    const stamp = { at: new Date(start).toISOString() as IsoTimestamp }
    const tracks = [...state.combat.tracks.values()].filter(track => track.side === blue)
    expect(tracks.map(track => track.tier).sort()).toEqual(['contact', 'identified', 'identified'])
    for (const track of tracks) {
      expect(Object.keys(track).sort()).toEqual(['fix', 'id', 'label', 'side', 'subjectId', 'tier', 'type', ...(track.identity === undefined ? [] : ['identity'])].sort())
      const subject = state.units.get(track.subjectId)!
      const object = trackObject(track, state.combat.sightings.get(track.id)!, stamp)
      expect(Object.keys(object).sort()).toEqual(['alerts', 'audience', 'id', 'kind', 'label', 'lifecycle', 'operational', 'packData', 'packId', 'provenance', 'revision', 'spatial', 'timestamps'])
      expect(object.audience).toEqual([blue])
      expect(object.kind).toBe('observation')
      expect(Object.keys(object.spatial).sort()).toEqual(['frame', 'position'])
      expect(Object.keys(object.spatial.position!).sort()).toEqual(['observedAt', 'point'])
      expect(object.provenance).toEqual({ source: 'simulator' })
      expect(object.alerts).toEqual([])
      expect(object.tasking).toBeUndefined()
      expect(object.telemetry).toBeUndefined()
      expect(object.context).toBeUndefined()
      const data = trackDataSchema.parse(object.packData)
      expect(Object.keys(object.packData as object).sort()).toEqual(['fix', 'tier', 'type', ...(data.identity === undefined ? [] : ['identity'])].sort())
      if (data.tier === 'contact') expect(data.identity).toBeUndefined()
      else expect(Object.keys(data.identity!).sort()).toEqual(['icon', 'rangeM', 'side', 'typeLabel'])
      // Nothing of the unit's own id, label, phase, integrity or properties reaches the track.
      const wire = JSON.stringify(object)
      for (const leak of [subject.id, subject.label, subject.phase, 'healthy', 'properties', 'crew', 'route', 'heading', 'speed']) expect(wire.includes(`"${leak}"`)).toBe(false)
    }
    const index = trackIndexObject({ id: `tracks:${blue}`, label: 'Index', type: 'track-index', side: blue, next: 4, subjects: Object.fromEntries(tracks.map(track => [track.id, track.subjectId])) }, stamp)
    expect(index.audience).toEqual([])
  })

  test('tracks, fixes and fire received survive a restore from objects and the runtime state', async () => {
    let state = await stateWith([
      place('s1', types.blueScout, blue, at(0)),
      place('b1', types.blueGun, blue, at(200, 200)),
      place('g1', types.redGun, red, at(1_500)),
      { kind: 'set-roe', unitId: 'b1', roe: 'free' },
    ])
    state = (await advanceTo(state, 30)).state
    expect(state.combat.units.get('g1')!.fireS).toBeGreaterThan(0)
    expect(state.combat.units.get('b1')!.fireS).toBeGreaterThan(0)
    const stamp = () => ({ at: new Date(state.timeMs).toISOString() as IsoTimestamp, provenance: { source: 'simulator' as const } })
    const objects: OperationalObject[] = engineObjects(state, stamp)
    const restored = readEngineState({ config, sides: [blue, red], objects, runtime: JSON.parse(JSON.stringify(runtimeStateOf(state))) })
    expect([...restored.combat.tracks.values()]).toEqual([...state.combat.tracks.values()])
    expect(restored.combat.units).toEqual(state.combat.units)
    expect(restored.combat.serials).toEqual(state.combat.serials)
    expect(restored.combat.cycleMs).toBe(state.combat.cycleMs)
    const later = await advanceTo(state, 90)
    const resumed = await advanceTo(restored, 90)
    expect(runtimeStateOf(resumed.state)).toEqual(runtimeStateOf(later.state))
    expect(resumed.transitions).toEqual(later.transitions)
    // A track the index does not name, or a fix without its time, cannot be restored.
    const withoutFix = { ...runtimeStateOf(state), combat: { ...runtimeStateOf(state).combat, tracks: {} } }
    expect(() => readEngineState({ config, sides: [blue, red], objects, runtime: withoutFix })).toThrow('fire-control fix')
    expect(() => readEngineState({ config, sides: [blue, red], objects: objects.filter(object => object.id !== `tracks:${blue}`), runtime: runtimeStateOf(state) })).toThrow('no track index')
  })
})
