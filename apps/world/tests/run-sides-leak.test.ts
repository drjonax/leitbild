// The wire oracle on a sided fixture Run: Red, Blue and Controller screens,
// each driven by the real World client modules, play one scripted sided Run
// over a real server: the fixture Pack's objects and Einsatz units, tasks and
// a public site side by side. Every id and label carries a per-run nonce.
// After each step the oracle deep-scans every HTTP body and WebSocket message
// a side screen received, and every store it built, for any id or label of an
// object outside that side's audience and for any command id another side
// issued. The screens and the oracle live in fixtures/wire-oracle.ts.
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import type { OperationalObject, RunRoles } from '../src/core/model/index.ts'
import { scenarioDefinitionSchema } from '../src/core/scenarios/definition.ts'
import { querySimulationRunCapability, resetSimulationRun } from '../src/ui/simulation-run-client.ts'
import { einsatzCommandIds } from '../src/packs/einsatz/capabilities.ts'
import { roeWords } from '../src/packs/einsatz/lexicon.ts'
import { createEinsatzSidedRuntimeAdapter, einsatzCrossSideCue, einsatzSidedCombat, einsatzSidedNames, einsatzSidedSelection } from '../src/packs/einsatz/fixtures/sided-run.ts'
import { einsatzPack } from '../src/packs/einsatz/pack.ts'
import { fixtureRuntimeId } from './fixtures/fixture-pack.ts'
import { fixtureAnnouncementType, fixtureCommandIds, fixtureQueryIds } from './fixtures/fixture-runtime.ts'
import { roleAwareFixturePack, sidedNames, sidedRoles, sidedRunDefinition, sides } from './fixtures/role-runs.ts'
import { createWireOracle, sideVisibleEventTypes, type Screen } from './fixtures/wire-oracle.ts'
import { waitForCondition } from './helpers.ts'

const nonce = crypto.randomUUID().slice(0, 8)
const names = sidedNames(nonce)
/** Einsatz plays Blue as its first side: Red's carrier, tagged like Blue's, lies nearer Blue's task. */
const einsatz = (() => {
  const named = einsatzSidedNames(nonce)
  return { blueCarrier: named.firstCarrier, redCarrier: named.secondCarrier, blueTask: named.firstTask, redTask: named.secondTask, site: named.site }
})()
const fixtureDefinition = sidedRunDefinition(nonce)
const definition = {
  ...fixtureDefinition,
  packs: [...fixtureDefinition.packs, einsatzSidedSelection(nonce, { side: 'blue', role: 'blue-lead' }, { side: 'red', role: 'red-lead' })],
  timeline: { cues: [...fixtureDefinition.timeline.cues, einsatzCrossSideCue(nonce)] },
}
const declaration: RunRoles = { roles: [...sidedRoles], presets: [], sides: [...sides] }

const oracle = createWireOracle(declaration)
const {
  registry, liveRun, asScreen, createScreen, readRun, join, objectIds, einsatzIds, attributions, storeText, einsatzType,
  attempt, sideCommands, takeInventory, forbiddenFor, holds, expectNoLeak, barrier, eventsReceived, command, refusalOf, recommendAs,
  shownOn, boardText, recommended, screens,
} = oracle

let red: Screen
let blue: Screen
let controller: Screen

beforeAll(async () => {
  await oracle.open({
    packs: [roleAwareFixturePack, einsatzPack],
    definitions: [definition, sidedRunDefinition(nonce, { sided: false })],
    runtimeAdapters: [createEinsatzSidedRuntimeAdapter()],
    scenarioId: 'sided-run',
  })
})

afterAll(async () => { await oracle.close() })

describe('the wire oracle on a sided fixture Run', () => {
  test('Red, Blue and Controller screens join, each with its own picture', async () => {
    red = createScreen('red', ['red-lead'])
    blue = createScreen('blue', ['blue-lead'])
    controller = createScreen('controller', ['control'])
    for (const screen of [red, blue, controller]) await join(screen)
    expect(objectIds(red)).toEqual([names.depot.id, names.redTask.id, names.redUnit.id].sort())
    expect(objectIds(blue)).toEqual([names.depot.id, names.blueTask.id, names.blueUnit.id].sort())
    expect(objectIds(controller)).toHaveLength(6)
    expect(einsatzIds(red)).toEqual([einsatz.redCarrier.id, einsatz.redTask.id, einsatz.site.id].sort())
    expect(einsatzIds(blue)).toEqual([einsatz.blueCarrier.id, einsatz.blueTask.id, einsatz.site.id].sort())
    expect(einsatzIds(controller)).toHaveLength(5)
    // The opening highlights the Red unit for truth views only; its guidance names the public depot for all.
    expect(controller.stores?.scenarioState?.highlightedObjectIds as ReadonlyArray<string> | undefined).toEqual([names.redUnit.id])
    for (const side of [red, blue]) {
      expect(side.stores?.scenarioState?.highlightedObjectIds).toEqual([])
      expect(side.stores?.scenarioState?.guidance?.objectIds as ReadonlyArray<string> | undefined).toEqual([names.depot.id])
      expect(side.stores?.compiledScenario.initialObjects).toEqual([])
    }
    await expectNoLeak(red, 'red')
    await expectNoLeak(blue, 'blue')
  })

  test('case 7: a Pack write without an audience is refused whole and reaches no one, Blue\'s later commands are answered without it, and a public site reaches both sides', async () => {
    const marks = { red: red.ws.length, blue: blue.ws.length, blueHttp: blue.http.length }
    const loose = attempt({ type: 'unit', id: `unit:loose-${nonce}`, label: `loose ${nonce}`, position: [10.74, 59.92], speedMps: 10 } as const)
    const job = attempt({ type: 'task', id: `task:loosejob-${nonce}`, label: `loosejob ${nonce}`, position: [10.74, 59.92], priority: 'low', audience: [] } as const)
    const run = await liveRun()
    const faults = () => run.health().find(entry => entry.runtimeId === fixtureRuntimeId)?.failureCount ?? 0
    const logged = spyOn(console, 'error').mockImplementation(() => {})
    try {
      // The fixture Pack accepts the unit without an audience and keeps it;
      // the Run refuses each emission that writes it, as the Pack's fault.
      expect(await command(controller, fixtureCommandIds.createItem, { item: loose })).toMatchObject({ result: { ok: true } })
      expect(await command(controller, fixtureCommandIds.createItem, { item: job })).toMatchObject({ result: { ok: true } })
      expect(await command(controller, fixtureCommandIds.assign, { unitId: loose.id, taskId: job.id })).toMatchObject({ result: { ok: true } })
      // On the Run's clock the Pack moves the unit it kept: a refused write no
      // caller made, which a later caller's command must not be handed.
      const before = faults()
      await (await registry()).setExecution(oracle.runId(), { playback: 'playing' })
      await waitForCondition('the Pack writes the refused unit on its own', () => faults() > before)
      await (await registry()).setExecution(oracle.runId(), { playback: 'paused' })
      // Blue commands over HTTP and over its realtime connection.
      expect(await command(blue, fixtureCommandIds.setPriority, { taskId: names.blueTask.id, priority: 'high' })).toMatchObject({ result: { ok: true } })
      expect(await blue.connection.invokeCapability(oracle.runId(), { capabilityId: fixtureCommandIds.setPriority, input: { taskId: names.blueTask.id, priority: 'low' } })).toMatchObject({ result: { ok: true } })
      let deleteRefusal: unknown
      try { await blue.connection.invokeCapability(oracle.runId(), { capabilityId: 'world.object.delete', input: { objectId: names.redUnit.id } }) }
      catch (error) { deleteRefusal = error }
      expect(deleteRefusal).toBeInstanceOf(Error)
      const refusal = blue.ws.slice(marks.blue).find(entry => entry.type === 'capability.error')
      expect(refusal === undefined ? null : (JSON.parse(refusal.text) as { readonly code?: string }).code).toBe('role_controller_only')
      // Blue asks the Pack for a Red object by id: the Pack answers as if it did not exist.
      expect(await asScreen(blue, async () => await querySimulationRunCapability<{ readonly object: unknown }>(oracle.runId(), fixtureQueryIds.object, { objectId: names.redUnit.id }))).toEqual({ object: null })
    } finally { logged.mockRestore() }
    await barrier(red, blue, controller)
    for (const screen of [red, blue, controller]) expect(objectIds(screen)).not.toContain(loose.id)
    expect(objectIds(controller)).toContain(job.id)
    expect(eventsReceived(red, marks.red).filter(event => event.type === 'object.upserted')).toEqual([])
    expect(eventsReceived(blue, marks.blue).filter(event => event.type === 'object.upserted').map(event => event.object?.id)).toEqual([names.blueTask.id, names.blueTask.id])
    // The fault is the Pack's: on its runtime's health, naming no object, and the Run itself has not failed.
    expect(run.health().find(entry => entry.runtimeId === fixtureRuntimeId)).toMatchObject({ state: 'degraded', lastFailure: { operation: 'emission', message: expect.stringMatching(/^audience_required: /) } })
    expect(JSON.stringify(run.health())).not.toContain(nonce)
    expect(run.health().some(entry => entry.runtimeId === 'world.core')).toBe(false)
    expect(objectIds(red)).toContain(names.depot.id)
    expect(objectIds(blue)).toContain(names.depot.id)
    await expectNoLeak(blue, 'blue', { http: marks.blueHttp, ws: marks.blue })
    await expectNoLeak(blue, 'blue')
    await expectNoLeak(red, 'red')
  })

  test('case 1: the Controller creates a Red unit and Blue receives nothing about it', async () => {
    const marks = { red: red.ws.length, blue: blue.ws.length }
    const created = await command(controller, fixtureCommandIds.createItem, { item: { type: 'unit', id: `unit:rednew-${nonce}`, label: `rednew ${nonce}`, position: [10.82, 59.95], speedMps: 10, crew: 'alpha', audience: ['red'] } })
    expect(created).toMatchObject({ kind: 'command', result: { ok: true } })
    await barrier(red, blue, controller)
    expect(objectIds(red)).toContain(`unit:rednew-${nonce}`)
    expect(objectIds(controller)).toContain(`unit:rednew-${nonce}`)
    // Blue's only message since is the barrier itself.
    expect(blue.ws.slice(marks.blue).map(entry => entry.type)).toEqual(['events'])
    expect(eventsReceived(blue, marks.blue).map(event => event.type)).toEqual(['clock.updated'])
    expect(eventsReceived(red, marks.red).map(event => event.type)).toEqual(['object.upserted', 'clock.updated'])
    await expectNoLeak(blue, 'blue')
    await expectNoLeak(red, 'red')
  })

  test('a side commands within its picture and is answered without naming what it cannot see', async () => {
    const assigned = await command(red, fixtureCommandIds.assign, { unitId: names.redUnit.id, taskId: names.redTask.id })
    expect(assigned).toMatchObject({ kind: 'command', result: { ok: true } })
    const refused = await command(red, fixtureCommandIds.assign, { unitId: names.blueUnit.id, taskId: names.redTask.id })
    expect(refused.kind === 'command' && !refused.result.ok ? refused.result.reason : null).toMatch(/^not_in_picture: /)
    // An id taken by another side's object, or a place on one, is refused as not in the picture, never as taken.
    for (const item of [
      { type: 'unit', id: names.redUnit.id, label: `copy ${nonce}`, position: [10.70, 59.91], speedMps: 10, audience: ['blue'] },
      attempt({ type: 'unit', id: `unit:bluenear-${nonce}`, label: `bluenear ${nonce}`, atObject: names.redTask.id, speedMps: 10, audience: ['blue'] }),
    ]) {
      const taken = await command(blue, fixtureCommandIds.createItem, { item })
      expect(taken.kind === 'command' && !taken.result.ok ? taken.result.reason : null).toMatch(/^not_in_picture: /)
    }
    const state = await asScreen(blue, async () => await querySimulationRunCapability<{ units: Array<{ id: string }>; tasks: Array<{ id: string }>; sites: Array<{ id: string }> }>(oracle.runId(), fixtureQueryIds.state, {}))
    expect([...state.units, ...state.tasks, ...state.sites].map(object => object.id).sort()).toEqual([names.depot.id, names.blueTask.id, names.blueUnit.id].sort())
    await barrier(red, blue)
    expect(red.stores?.objects.find(object => object.id === names.redUnit.id)?.operational.status).toBe('en_route')
    await expectNoLeak(red, 'red')
    await expectNoLeak(blue, 'blue')
  })

  test('case 2: the Scenario timeline creates one unit per side and each reaches only its own side', async () => {
    const reg = await registry()
    await reg.advanceExecution(oracle.runId(), { minutes: 1 })
    await waitForCondition('both cued units', () => objectIds(controller).includes(names.redCued.id) && objectIds(controller).includes(names.blueCued.id))
    await waitForCondition('maximum pace finished', () => reg.leaseSummary(oracle.runId()).leasesByKind['maximum-pace'] === 0)
    await barrier(red, blue, controller)
    expect(objectIds(red)).toContain(names.redCued.id)
    expect(objectIds(red)).not.toContain(names.blueCued.id)
    expect(objectIds(blue)).toContain(names.blueCued.id)
    expect(objectIds(blue)).not.toContain(names.redCued.id)
    // The Red unit moved during the advance; only Red and the Controller saw it.
    expect(red.stores?.objects.find(object => object.id === names.redUnit.id)?.spatial.position?.point.coordinates).not.toEqual([10.80, 59.95])
    await expectNoLeak(red, 'red')
    await expectNoLeak(blue, 'blue')
  })

  test('case 5: a Red unit tagged like Blue\'s is absent from Blue\'s recommendation, a Blue send naming it is refused as not in the picture, and only a truth view sets the public site, which both sides then see', async () => {
    const marks = { http: blue.http.length, ws: blue.ws.length }
    const asBlue = await recommendAs(blue, einsatz.blueTask.id)
    expect(asBlue.proposal.units.map(entry => entry.unitId)).toEqual([einsatz.blueCarrier.id])
    expect(recommended(asBlue)).toEqual([einsatz.blueCarrier.id])
    expect(recommended(await recommendAs(red, einsatz.redTask.id))).toEqual([einsatz.redCarrier.id])
    const send = { units: [einsatz.redCarrier.id], to: { taskId: einsatz.blueTask.id } }
    expect(refusalOf(await command(blue, einsatzCommandIds.send, send))).toBe('not_in_picture: Not in your picture')
    expect(await blue.connection.invokeCapability(oracle.runId(), { capabilityId: einsatzCommandIds.send, input: send })).toMatchObject({ result: { ok: false, reason: 'not_in_picture: Not in your picture' } })
    // A side role commands no public unit: Blue's command on the public site is refused within Blue's picture.
    const refused = await command(blue, einsatzCommandIds.siteSet, { siteId: einsatz.site.id, accepting: false })
    if (refused.kind !== 'command' || refused.result.ok) throw new Error(`Expected Blue's command on the public site to be refused: ${JSON.stringify(refused)}`)
    expect(refused.result.reason).toBe(`unit_not_authorized: Blue lead does not command ${einsatz.site.label}, and no operator role does`)
    // The Controller closes and reopens it, and each side sees each change.
    for (const accepting of [false, true]) {
      const outcome = await command(controller, einsatzCommandIds.siteSet, { siteId: einsatz.site.id, accepting })
      if (outcome.kind !== 'command' || !outcome.result.ok) throw new Error(`The Controller could not set the public site: ${JSON.stringify(outcome)}`)
      await barrier(red, blue, controller)
      for (const side of [red, blue]) {
        expect(side.stores?.objects.find(object => object.id === einsatz.site.id)?.packData).toMatchObject({ accepting, lastAction: { verb: 'set', by: 'Controller' } })
      }
    }
    // No Einsatz object a side holds names the other side's role as the one that gave its last order.
    for (const side of [red, blue]) expect(attributions(side)).toContain('Controller')
    expect(attributions(red).filter(by => by.includes('Blue lead'))).toEqual([])
    expect(attributions(blue).filter(by => by.includes('Red lead'))).toEqual([])
    await expectNoLeak(blue, 'blue', marks)
    await expectNoLeak(blue, 'blue')
    await expectNoLeak(red, 'red')
    // The oracle watched Red's screen for Blue's refused command.
    expect(sideCommands.get(refused.result.commandId)).toEqual(['blue'])
  })

  test('case 6: the Controller\'s recommendation for a Blue task lists no Red unit, and cross-side sends by the Controller or a cue are refused', async () => {
    expect(recommended(await recommendAs(controller, einsatz.blueTask.id))).toEqual([einsatz.blueCarrier.id])
    const send = { units: [einsatz.redCarrier.id], to: { taskId: einsatz.blueTask.id } }
    expect(refusalOf(await command(controller, einsatzCommandIds.send, send))).toBe(`cross_side_reference: ${einsatz.redCarrier.label} cannot serve another side's ${einsatz.blueTask.label}`)
    // The cue a minute in, fired by case 2's advance, was refused alike, and only truth views heard of it.
    const events = (await liveRun()).events()
    const cued = events.find(event => event.type === 'command.issued' && event.command.kind === einsatzCommandIds.send && event.command.roleIds === undefined)
    if (cued?.type !== 'command.issued') throw new Error('expected the cross-side cue to issue its send')
    expect(cued.command.payload).toEqual(send)
    const result = events.find(event => event.type === 'command.result' && event.result.commandId === cued.command.id)
    expect(result?.type === 'command.result' && !result.result.ok ? result.result.reason : null).toMatch(/^cross_side_reference: /)
    await barrier(red, blue, controller)
    expect(red.stores?.objects.find(object => object.id === einsatz.redCarrier.id)?.packData).toMatchObject({ phase: 'available' })
    expect(controller.stores?.objects.find(object => object.id === einsatz.blueTask.id)?.packData).toMatchObject({ coverage: { loads: [expect.objectContaining({ covered: 0 })] } })
    await expectNoLeak(red, 'red')
    await expectNoLeak(blue, 'blue')
  })

  test('cases 2 and 4 on Einsatz: in a fight, a Blue step-loss task and Red\'s orders reach only their own side, and every track a side receives is whitelisted', async () => {
    const combat = einsatzSidedCombat(nonce, { side: 'blue', role: 'blue-lead' }, { side: 'red', role: 'red-lead' })
    const named = einsatzSidedNames(nonce)
    const marks = { red: red.ws.length, blue: blue.ws.length }
    for (const input of [combat.scout, combat.nearGun, combat.farGun]) {
      const outcome = await command(controller, einsatzCommandIds.unitCreate, input)
      if (outcome.kind !== 'command' || !outcome.result.ok) throw new Error(`The Controller could not create ${input.label}: ${JSON.stringify(outcome)}`)
    }
    await barrier(red, blue, controller)
    const idOf = (label: string): string => {
      const found = controller.stores?.objects.find(object => object.label === label)
      if (found === undefined) throw new Error(`The Controller holds no ${label}`)
      return found.id
    }
    const scout = idOf(named.scout.label)
    const farGun = idOf(named.farGun.label)
    // Each side gives its carrier a job chain: a long move, then its own task queued behind it, so steps naming each side's ids ride through the fight.
    const away = { type: 'Point', coordinates: [10.40, 59.91] }
    for (const [screen, carrier, task] of [[red, einsatz.redCarrier.id, einsatz.redTask.id], [blue, einsatz.blueCarrier.id, einsatz.blueTask.id]] as const) {
      for (const [capabilityId, input] of [[einsatzCommandIds.send, { units: [carrier], to: { point: away } }], [einsatzCommandIds.queue, { unitId: carrier, to: { taskId: task } }]] as const) {
        const outcome = await command(screen, capabilityId, input)
        if (outcome.kind !== 'command' || !outcome.result.ok) throw new Error(`${screen.name} could not chain ${carrier}: ${JSON.stringify(outcome)}`)
      }
    }
    const before = { red: shownOn(red), blue: shownOn(blue) }
    // Red orders its far shooter to hold fire: a side's order, which only Red and truth views hear of.
    const held = await command(red, einsatzCommandIds.setRoe, { unitId: farGun, roe: 'hold' })
    if (held.kind !== 'command' || !held.result.ok) throw new Error(`Red could not order its shooter: ${JSON.stringify(held)}`)
    const reg = await registry()
    await reg.advanceExecution(oracle.runId(), { minutes: 2 })
    await waitForCondition('maximum pace finished', () => reg.leaseSummary(oracle.runId()).leasesByKind['maximum-pace'] === 0)
    await barrier(red, blue, controller)

    // Case 2: the scout's step-loss tasks are Blue's alone; Red's order shows on Red's shooter only.
    const lossTasks = (screen: Screen) => einsatzIds(screen).filter(id => id.startsWith(`${scout}:loss-`))
    expect(lossTasks(blue).length).toBeGreaterThan(0)
    expect(lossTasks(controller)).toEqual(lossTasks(blue))
    expect(lossTasks(red)).toEqual([])
    expect(red.stores?.objects.find(object => object.id === farGun)?.packData).toMatchObject({ roe: 'hold', lastAction: { by: 'Red lead' } })
    expect(einsatzIds(blue)).not.toContain(farGun)
    // Each side's Board, fed what its screen held before Red's order and what it holds now, shows the step-loss work to Blue alone and Red's order in Red's log alone.
    const boards = { red: await boardText(red, before.red), blue: await boardText(blue, before.blue) }
    expect(lossTasks(blue).every(id => boards.blue.includes(id))).toBe(true)
    const logOf = (board: string): ReadonlyArray<string> => (JSON.parse(board) as { readonly log: ReadonlyArray<{ readonly recordId: string; readonly text: string }> }).log.filter(entry => entry.recordId === farGun).map(entry => entry.text)
    expect(logOf(boards.red)).toContain(`${named.farGun.label}: set · ${roeWords.hold}`)
    expect(logOf(boards.blue)).toEqual([])
    // Each side's carrier holds its queued step on its side's screen alone.
    const queuedTask = (screen: Screen, carrier: string) => (screen.stores?.objects.find(object => object.id === carrier)?.packData as { readonly orders?: ReadonlyArray<{ readonly target: unknown; readonly state: string }> } | undefined)?.orders?.find(step => step.state === 'queued')?.target
    expect(queuedTask(red, einsatz.redCarrier.id)).toEqual({ taskId: einsatz.redTask.id })
    expect(queuedTask(blue, einsatz.blueCarrier.id)).toEqual({ taskId: einsatz.blueTask.id })
    await expectNoLeak(red, 'red', {}, [boards.red])
    await expectNoLeak(blue, 'blue', {}, [boards.blue])
    expect(sideCommands.get(held.result.commandId)).toEqual(['red'])

    // Case 4: every track a side screen received, and every one it holds, carries its observation and nothing more.
    const tracksOf = (screen: Screen, since: number): ReadonlyArray<OperationalObject> => [
      ...eventsReceived(screen, since).flatMap(event => event.type === 'object.upserted' && event.object !== undefined ? [event.object as OperationalObject] : []),
      ...(screen.stores?.objects ?? []),
    ].filter(object => einsatzType(object) === 'track')
    const tiers = new Set<string>()
    for (const [screen, side, since] of [[blue, 'blue', marks.blue], [red, 'red', marks.red]] as const) {
      const received = tracksOf(screen, since)
      expect(received.length).toBeGreaterThan(0)
      for (const track of received) {
        const data = track.packData as { readonly tier: string; readonly identity?: unknown }
        tiers.add(`${side}:${data.tier}`)
        expect({ id: track.id, audience: track.audience, provenance: track.provenance, alerts: track.alerts }).toEqual({ id: track.id, audience: [side], provenance: { source: 'simulator' }, alerts: [] })
        expect([track.id, Object.keys(track.spatial).sort(), Object.keys(track.spatial.position ?? {}).sort()]).toEqual([track.id, ['frame', 'position'], ['observedAt', 'point', 'simAt']])
        // The fix's simulation time (C7) is the sighting's own time: no truth beyond what the side observed.
        expect([track.id, track.spatial.position?.simAt]).toEqual([track.id, track.spatial.position?.observedAt])
        expect([track.id, ['tasking', 'telemetry', 'context'].filter(key => key in track)]).toEqual([track.id, []])
        expect([track.id, Object.keys(track.packData as object).filter(key => !['type', 'tier', 'fix', 'identity'].includes(key))]).toEqual([track.id, []])
        // A contact names no type, side or colour of what it follows.
        if (data.tier === 'contact') expect([track.id, data.identity, JSON.stringify(track).includes(side === 'blue' ? '"red"' : '"blue"')]).toEqual([track.id, undefined, false])
      }
      // The per-side index of which unit each track follows reaches no side screen.
      expect((screen.stores?.objects ?? []).filter(object => einsatzType(object) === 'track-index')).toEqual([])
    }
    // Blue's scout held the far shooter as a contact and the near one identified; Red watched its kill of the scout.
    expect([...tiers].sort()).toEqual(expect.arrayContaining(['blue:contact', 'blue:identified', 'red:destroyed']))
  })

  test('case 8: side sockets get only side-visible event types, deletions by their audience, and no runtime messages', async () => {
    const marks = { red: red.ws.length, blue: blue.ws.length }
    for (const objectId of [names.hidden.id, names.redCued.id]) {
      expect(await command(controller, 'world.object.delete', { objectId })).toMatchObject({ result: { ok: true } })
    }
    expect(await command(controller, fixtureCommandIds.announce, { text: `announcement ${nonce}` })).toMatchObject({ result: { ok: true } })
    await waitForCondition('the Controller hears the announcement', () => controller.realtime.includes(fixtureAnnouncementType))
    await barrier(red, blue, controller)
    expect(objectIds(red)).not.toContain(names.redCued.id)
    expect(eventsReceived(red, marks.red).filter(event => event.type === 'object.deleted')).toEqual([expect.objectContaining({ objectId: names.redCued.id, audience: ['red'] })])
    expect(eventsReceived(blue, marks.blue).filter(event => event.type === 'object.deleted')).toEqual([])
    for (const side of [red, blue]) {
      expect(side.realtime).toEqual([])
      expect(side.ws.some(entry => entry.type === 'runtime.realtime')).toBe(false)
      const types = new Set(eventsReceived(side).map(event => event.type))
      expect([...types].filter(type => !sideVisibleEventTypes.has(type))).toEqual([])
    }
    await expectNoLeak(red, 'red')
    await expectNoLeak(blue, 'blue')
  })

  test('case 3: the Controller switches to Blue in place, no store keeps a Red truth id, and nothing of the old epoch applies', async () => {
    expect(storeText(controller.stores)).toContain(names.redUnit.id)
    // An earlier truth batch naming a Red object, to replay late.
    const late = controller.ws.find(entry => entry.type === 'events' && entry.epoch === 1 && entry.text.includes(`unit:rednew-${nonce}`))
    if (!late) throw new Error('expected a truth batch naming the new Red unit')
    const marks = { http: controller.http.length, applied: controller.applied.length }
    controller.connection.setRoles(oracle.runId(), ['blue-lead'])
    await waitForCondition('the Controller screen adopts epoch 2', () => controller.epoch === 2)
    const readyIndex = controller.ws.findIndex(entry => entry.type === 'realtime.ready' && entry.epoch === 2)
    expect(controller.roleIds).toEqual(['blue-lead'])
    expect(objectIds(controller)).toEqual(objectIds(blue))
    expect(einsatzIds(controller)).toEqual(einsatzIds(blue))
    expect(controller.stores?.scenarioState?.highlightedObjectIds).toEqual([])
    expect(controller.stores?.compiledScenario.initialObjects).toEqual([])
    // A late message of the old epoch is dropped at the gate.
    const socket = controller.socket!
    const appliedBefore = controller.applied.length
    socket.onmessage?.call(socket, new MessageEvent('message', { data: late.text }))
    expect(controller.applied).toHaveLength(appliedBefore)
    await barrier(controller)
    const sinceReady = controller.applied.slice(controller.applied.findIndex((entry, index) => index >= marks.applied && entry.kind === 'ready' && entry.epoch === 2))
    expect(sinceReady.length).toBeGreaterThan(1)
    expect(sinceReady.map(entry => entry.epoch)).toEqual(sinceReady.map(() => 2))
    await expectNoLeak(controller, 'blue', { http: marks.http, ws: readyIndex })
    // A Definition with roles may not restrict AI.
    const restricted = scenarioDefinitionSchema.safeParse({ ...definition, agentRestrictions: { operationIds: [fixtureCommandIds.assign] } })
    expect(restricted.success ? null : restricted.error.issues.map(issue => (issue as { readonly params?: { readonly code?: string } }).params?.code)).toContain('agent_restrictions_in_role_run')
  })

  test('case 9: every request this script\'s side screens made reached an allow-listed route with their role set, other routes refuse a side view, and after a reset a side screen re-joins through the Run read', async () => {
    const director = createScreen('director', ['control'])
    await join(director)
    const readies = blue.applied.filter(entry => entry.kind === 'ready').length
    await asScreen(director, async () => { await resetSimulationRun(oracle.runId()) })
    await (await liveRun()).setClock({ paused: true })
    await waitForCondition('Blue adopts the reset Run', () => blue.applied.filter(entry => entry.kind === 'ready').length > readies)
    expect(objectIds(blue)).toEqual([names.depot.id, names.blueTask.id, names.blueUnit.id].sort())
    expect(einsatzIds(blue)).toEqual([einsatz.blueCarrier.id, einsatz.blueTask.id, einsatz.site.id].sort())
    // A screen re-joining reads the Run, never the Scenario fetch.
    const reread = await readRun(blue)
    expect(reread.snapshot.objects.map(object => String(object.id)).sort()).toEqual([names.depot.id, names.blueTask.id, names.blueUnit.id, einsatz.blueCarrier.id, einsatz.blueTask.id, einsatz.site.id].sort())
    // This proves the requests the client modules made for the steps scripted
    // here, not every request a full World screen could make.
    const runPath = `/api/workspaces/${oracle.workspaceId()}/world/simulation-runs/${oracle.runId()}`
    const allowed = (screen: Screen) => new RegExp(`^${runPath.replaceAll('.', '\\.')}(/snapshot|/presence|/capabilities/world\\.(fixture|einsatz)\\.[a-z.-]+/invoke)?\\?roles=${encodeURIComponent(screen.roleIds.join(','))}$`)
    for (const screen of [red, blue]) {
      expect(screen.http.map(entry => entry.url).filter(url => !allowed(screen).test(url))).toEqual([])
      expect(screen.http.some(entry => entry.url.includes('/scenarios/'))).toBe(false)
    }
    // The routes a side view never reaches, asked directly.
    const probe = async (suffix: string, init?: RequestInit) => {
      const separator = suffix.includes('?') ? '&' : '?'
      const response = await oracle.originalFetch(`${oracle.base()}${suffix.startsWith('/scenarios') ? `/api/workspaces/${oracle.workspaceId()}/world` : runPath}${suffix}${separator}roles=blue-lead`, init)
      return { suffix, status: response.status, code: ((await response.json()) as { error?: { code?: string } }).error?.code }
    }
    for (const [suffix, init] of [
      ['/events', undefined], ['/objects', undefined], ['/history', undefined], ['/procedures', undefined], ['/procedure-runs', undefined],
      ['/signals', { method: 'POST', body: JSON.stringify({ type: 'note', payload: {} }) }], ['/reset', { method: 'POST' }],
      ['/copies', { method: 'POST', body: '{}' }], ['/scenarios/sided-run', undefined],
    ] as const) expect(await probe(suffix, init)).toEqual({ suffix, status: 403, code: 'role_view_not_supported' })
    await expectNoLeak(red, 'red')
    await expectNoLeak(blue, 'blue')
    for (const screen of screens) expect({ screen: screen.name, errors: screen.errors }).toEqual({ screen: screen.name, errors: [] })
  })
})

describe('a Run without sides on the WebSocket', () => {
  test('sends every role set the whole ready, every event and every runtime message, as before', async () => {
    const unsidedId = await oracle.workspaces().withRuntime(oracle.workspaceId(), async runtime => (await runtime.simulationRuns.create({ scenarioId: 'unsided-run' })).id)
    const socket = new oracle.nativeWebSocket(`ws://127.0.0.1:${oracle.port()}/api/workspaces/${oracle.workspaceId()}/world/ws?simulationRun=${unsidedId}&roles=red-lead`)
    const received: Array<{ readonly type: string; readonly [key: string]: unknown }> = []
    socket.onmessage = event => { received.push(JSON.parse(String(event.data)) as { readonly type: string }) }
    try {
      await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error('WebSocket failed')) })
      await waitForCondition('unsided ready', () => received.some(message => message.type === 'realtime.ready'))
      const ready = received.find(message => message.type === 'realtime.ready') as unknown as { snapshot: { objects: unknown[]; scenario: Record<string, unknown> }; compiledScenario: { initialObjects: unknown[]; timeline?: unknown } }
      expect(ready.snapshot.objects).toHaveLength(6)
      expect(ready.snapshot.scenario.highlightedObjectIds).toEqual([`unit:redunit-${nonce}`])
      expect(ready.compiledScenario.initialObjects).toHaveLength(6)
      expect(ready.compiledScenario.timeline).toBeDefined()
      socket.send(JSON.stringify({ type: 'capability.invoke', requestId: 'loose', capabilityId: fixtureCommandIds.createItem, invocation: { input: { item: { type: 'unit', id: `unit:unsided-${nonce}`, label: `unsided ${nonce}`, position: [10.74, 59.92], speedMps: 10 } } } }))
      socket.send(JSON.stringify({ type: 'capability.invoke', requestId: 'announce', capabilityId: fixtureCommandIds.announce, invocation: { input: { text: 'all hear this' } } }))
      await waitForCondition('unsided runtime message', () => received.some(message => message.type === 'runtime.realtime'))
      // Each request is answered on its own: the announce's runtime message says nothing of when the earlier loose request's result arrives.
      await waitForCondition('the loose request answered', () => received.some(message => message.type === 'capability.result' && message.requestId === 'loose'))
      expect(received.find(message => message.requestId === 'loose')).toMatchObject({ type: 'capability.result', outcome: { result: { ok: true } } })
      const types = () => received.filter(message => message.type === 'events').flatMap(message => (message.events as Array<{ type: string }>).map(event => event.type))
      await waitForCondition('the loose command\'s events', () => ['command.issued', 'object.upserted', 'command.result'].every(type => types().includes(type)))
      expect(types()).toEqual(expect.arrayContaining(['command.issued', 'object.upserted', 'command.result']))
    } finally { socket.close() }
  })
})

describe('the wire oracle itself', () => {
  test('flags an id or label outside a side\'s audience wherever it appears', async () => {
    await takeInventory()
    expect(forbiddenFor('blue')).toEqual(expect.arrayContaining([names.redUnit.id, names.redUnit.label, names.hidden.id]))
    expect(forbiddenFor('blue')).not.toContain(names.depot.id)
    expect(forbiddenFor('red')).toEqual(expect.arrayContaining([names.blueCued.id, names.blueCued.label]))
    const planted: Screen = { ...createScreen('planted', ['blue-lead']), ws: [{ text: JSON.stringify({ type: 'events', events: [{ type: 'object.deleted', objectId: names.redTask.id }] }), type: 'events' }] }
    const leaks = forbiddenFor('blue').filter(token => [...planted.ws.map(entry => entry.text), storeText(planted.stores)].some(text => text.includes(token)))
    expect(leaks).toEqual([names.redTask.id])
  })

  test('finds a token only as a whole id or label, never as the start of a longer id', () => {
    expect(holds('{"objectId":"task:1"}', 'task:1')).toBe(true)
    expect(holds('{"objectId":"task:12"}', 'task:1')).toBe(false)
    expect(holds('{"objectId":"task:12","next":"task:1"}', 'task:1')).toBe(true)
    expect(holds(`${names.redUnit.label} · damaged`, names.redUnit.label)).toBe(true)
  })
})
