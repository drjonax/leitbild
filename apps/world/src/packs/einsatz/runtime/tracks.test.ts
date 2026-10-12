import { describe, expect, test } from 'bun:test'
import { geoPointFromLonLat, type ObjectAudience, type OperationalObject, type SimulationRunEvent } from '../../../core/model/index.ts'
import type { PackRuntimeEvent } from '../../../simulation/protocol.ts'
import { einsatzCommandIds as ids } from '../capabilities.ts'
import { borderConfig, borderDefinitions, isScout } from '../fixtures/border-harness.ts'
import { blue, red } from '../fixtures/combat-harness.ts'
import scripted from '../../../scenarios/halden-border.scenario.json'
import { openRun, screenOf, type OpenRun, type RoleRunDeclaration } from '../fixtures/run-harness.ts'
import { einsatzPackId } from '../ids.ts'

/**
 * Tracks as the Einsatz runtime publishes them in a sided Run (§7.1, §7.2),
 * observed on the runtime's own emissions and on the Run's journal: a track
 * or index changes as a record only at a transition, a sighting moves a
 * track snapshot-only, a dropped track is deleted for its observing side,
 * and every track names only its source and is seen by its observing side
 * alone, whichever commit carries it.
 */

const config = scripted.packs[0]!.config
const kmEast = (lonLat: readonly [number, number], km: number): [number, number] => [lonLat[0] + km / 57.12, lonLat[1]]
const origin: [number, number] = [11.45649, 59.12924]
const roles = borderDefinitions.scripted.roles ?? []
/** A side's scout type, which sees far and carries no weapon, and the operator role of that side that commands it: found by component and authority. */
const scoutOf = (side: string): { readonly typeId: string; readonly roleId: string } => {
  const parsed = borderConfig()
  for (const type of parsed.unitTypes.filter(isScout)) {
    const role = roles.find(entry => entry.class === 'operator' && entry.sees !== 'all' && (entry.sees ?? []).includes(side)
      && parsed.authority.some(item => item.roleId === entry.id && 'types' in item.units && item.units.types.includes(type.id)))
    if (role !== undefined) return { typeId: type.id, roleId: role.id }
  }
  throw new Error(`No role of side ${side} commands a scout`)
}
const scout = (id: string, side: string, position: readonly [number, number]) =>
  ({ type: 'unit', id, label: id.toUpperCase(), unitType: scoutOf(side).typeId, side, position })

/** halden-border's roles, sides and configuration over a scene, without its timeline. */
const definitionWith = (items: ReadonlyArray<Record<string, unknown>>, configuration: unknown = config) => ({
  ...scripted,
  packs: [{ ...scripted.packs[0]!, config: configuration, items }],
  timeline: undefined,
})
const declared: RoleRunDeclaration = { roles: scripted.roles as RoleRunDeclaration['roles'], config }
const blueCommander = screenOf(declared, scoutOf(blue).roleId)
const controller = screenOf(declared, roles.find(role => role.class === 'controller')!.id)

type Upserted = Extract<PackRuntimeEvent, { readonly type: 'object.upserted' }>
const isTrackData = (object: OperationalObject): boolean => {
  const type = (object.packData as { readonly type?: unknown }).type
  return object.packId === einsatzPackId && (type === 'track' || type === 'track-index')
}

/** Every emission of the Einsatz runtime, one per commit, with the history each event asks for. */
const emissionsOf = (run: OpenRun) => {
  const batches: PackRuntimeEvent[][] = []
  const events: PackRuntimeEvent[] = []
  const unsubscribe = run.connection.subscribe(message => {
    if (message.type !== 'event.emission') return
    batches.push([...message.events])
    events.push(...message.events)
  })
  return {
    batches,
    events,
    unsubscribe,
    tracks: () => events.filter((event): event is Upserted => event.type === 'object.upserted' && isTrackData(event.object)),
  }
}
const observingAudience = (object: OperationalObject): ObjectAudience =>
  (object.packData as { readonly type: string }).type === 'track-index' ? [] : [object.id.split(':')[1]!]

const journalUpserts = (journal: ReadonlyArray<SimulationRunEvent>) =>
  journal.flatMap(event => event.type === 'object.upserted' && isTrackData(event.object) ? [event.object] : [])

describe('Einsatz track publication in a sided Run', () => {
  test('records only at transitions, sightings snapshot-only, a deletion for the observing side on drop, and only the source named, a side command among them', async () => {
    // Two scouts 500 m apart: each identifies the other, halted or not, and neither carries a weapon.
    const run = await openRun({ definition: definitionWith([scout('unit:b1', blue, origin), scout('unit:r1', red, kmEast(origin, 0.5))]) })
    const emitted = emissionsOf(run)
    try {
      await runFor(run, 60_000)
      const recordsAfterOneMinute = journalUpserts(run.journal).length
      expect(recordsAfterOneMinute).toBeGreaterThan(0)
      const sightingsBefore = emitted.tracks().filter(event => event.history === 'snapshot-only').length
      const observedBefore = run.object('track:blue:1')?.spatial.position?.observedAt

      // Four more static minutes in 24 commits: each publishes both tracks' newest sightings, and nothing is journaled.
      await runFor(run, 4 * 60_000)
      expect(journalUpserts(run.journal)).toHaveLength(recordsAfterOneMinute)
      expect(emitted.tracks().filter(event => event.history === 'snapshot-only').length).toBe(sightingsBefore + 24 * 2)
      expect(run.object('track:blue:1')?.spatial.position?.observedAt).not.toBe(observedBefore)
      expect(emitted.tracks().filter(event => event.history === 'record').map(event => event.object.id).sort())
        .toEqual(journalUpserts(run.journal).map(object => object.id).sort())

      // Blue's commander sends its scout away; once neither side has seen the other for 300 s, both tracks are dropped.
      const sent = await run.invoke(ids.send, { units: ['unit:b1'], to: { point: geoPointFromLonLat(...kmEast(origin, -6)) } }, blueCommander)
      expect(sent.ok).toBe(true)
      for (let minute = 0; minute < 20 && run.object('track:red:1') !== undefined; minute++) await runFor(run, 60_000)
      expect([run.object('track:blue:1'), run.object('track:red:1')]).toEqual([undefined, undefined])
      const deletions = run.journal.flatMap(event => event.type === 'object.deleted' && event.objectId.startsWith('track:') ? [[String(event.objectId), event.audience]] : [])
      expect(deletions.sort()).toEqual([['track:blue:1', ['blue']], ['track:red:1', ['red']]])
      expect(emitted.events.filter(event => event.type === 'object.deleted').every(event => event.history === 'record')).toBe(true)

      // The Blue unit names Blue's command; no track, sighting or index ever names one, and each is seen by its observing side alone.
      const named = emitted.events.flatMap(event => event.type === 'object.upserted' && event.object.provenance.causedByCommandId === sent.commandId ? [[event.object.id, event.object.audience]] : [])
      expect(named.length).toBeGreaterThan(0)
      expect(named.every(([id, audience]) => id === 'unit:b1' && JSON.stringify(audience) === '["blue"]')).toBe(true)
      for (const event of emitted.tracks()) {
        expect([event.object.id, event.object.provenance]).toEqual([event.object.id, { source: 'simulator' }])
        expect([event.object.id, event.object.audience]).toEqual([event.object.id, observingAudience(event.object)])
      }
    } finally {
      emitted.unsubscribe()
      await run.close()
    }
  }, 120_000)

  test('a command that brings the first sensor into the Run at a 2 s boundary commits the tracks it opens there, naming no command', async () => {
    // A test-only type that can be seen but sees nothing, so no engagement runs until a sensor arrives.
    const beaconConfig = {
      ...config,
      unitTypes: [...config.unitTypes, { id: 'beacon', label: 'Beacon', icon: 'radio-tower', components: { mobility: { mode: 'road', speedFactor: 1, mobilizeS: 30 }, signature: { factor: 1 } } }],
    }
    const run = await openRun({ definition: definitionWith([{ type: 'unit', id: 'unit:beacon', label: 'BEACON', unitType: 'beacon', side: blue, position: origin }], beaconConfig) })
    const emitted = emissionsOf(run)
    try {
      await runFor(run, 10_000)
      expect(emitted.tracks()).toEqual([])
      expect(run.nowMs() % 2_000).toBe(0)
      const created = await run.invoke(ids.unitCreate, { type: scoutOf(red).typeId, side: red, at: geoPointFromLonLat(...kmEast(origin, 1)), label: 'Watcher' }, controller)
      expect(created.ok).toBe(true)
      // The command's own commit carries Red's scout, which names the command, and the track it opened there, which does not.
      const commandCommit = emitted.batches.find(batch => batch.some(event => event.type === 'object.upserted' && event.object.provenance.causedByCommandId === created.commandId))!
      const upserts = commandCommit.filter((event): event is Upserted => event.type === 'object.upserted')
      expect(upserts.filter(event => !isTrackData(event.object)).map(event => [event.object.audience, event.object.provenance.causedByCommandId])).toEqual([[['red'], created.commandId]])
      expect(upserts.filter(event => isTrackData(event.object)).map(event => [String(event.object.id), event.history, event.object.audience, event.object.provenance])).toEqual([
        ['tracks:red', 'record', [], { source: 'simulator' }],
        ['track:red:1', 'record', ['red'], { source: 'simulator' }],
      ])
    } finally {
      emitted.unsubscribe()
      await run.close()
    }
  }, 60_000)
})

/** Moves the running Run clock forward and lets the Run publish. */
const runFor = async (run: OpenRun, ms: number): Promise<void> => {
  for (let step = 0; step < ms; step += 10_000) {
    run.forward(Math.min(10_000, ms - step))
    await run.settle()
  }
}
