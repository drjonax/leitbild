// The wire oracle on halden-border, as T6 acceptance asks: a screen holding
// Red's groups, a screen holding the "Blue (one person)" preset and a
// Controller screen, each driven by the real World client modules, play the
// shipped Definition with Red scripted for its thirty minutes over a real
// server. Every instance id and label of the copy carries a per-run nonce, and
// each label its own suffix, so a side's "Tank 2" is never the other's. Blue
// sends the recommended units as calls appear, its screening and overwatch
// calls included. After every minute the oracle deep-scans what each side
// screen received and built, its Board included, for anything outside its
// side. The Definition is read through the border harness.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { OperationalObject, RunRoles } from '../src/core/model/index.ts'
import type { ScenarioDefinition } from '../src/core/scenarios/definition.ts'
import { einsatzCommandIds } from '../src/packs/einsatz/capabilities.ts'
import { borderDefinitions, borderRoles } from '../src/packs/einsatz/fixtures/border-harness.ts'
import { createEinsatzSidedRuntimeAdapter } from '../src/packs/einsatz/fixtures/sided-run.ts'
import { einsatzPack } from '../src/packs/einsatz/pack.ts'
import { createWireOracle, sideVisibleEventTypes, type Screen } from './fixtures/wire-oracle.ts'
import { waitForCondition } from './helpers.ts'

const nonce = crypto.randomUUID().slice(0, 8)

/**
 * The Definition with every item id suffixed by the nonce, every reference
 * to an item rewritten to match, and every item and cue-created label given
 * a suffix of its own, so no label is another's prefix. Groups, types and
 * templates are configuration and keep their ids.
 */
const withNonce = (source: ScenarioDefinition) => {
  const [selection] = source.packs
  const ids = new Map<string, string>(selection!.items.map(item => [item.id, `${item.id}-${nonce}`]))
  const rewrite = (value: unknown): unknown => {
    if (typeof value === 'string') return ids.get(value) ?? value
    if (Array.isArray(value)) return value.map(rewrite)
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewrite(entry)]))
    return value
  }
  const suffix = (label: string, tag: string) => `${label} ${nonce}-${tag}`
  return {
    ...source,
    packs: [{
      ...selection!,
      items: selection!.items.map((item, index) => ({ ...item, id: ids.get(item.id)! as typeof item.id, label: suffix(item.label, `i${String(index).padStart(2, '0')}`) })),
    }],
    timeline: {
      ...source.timeline!,
      cues: source.timeline!.cues.map((cue, cueIndex) => ({
        ...cue,
        actions: cue.actions.map(action => {
          if (action.type !== 'invoke_capability') return action
          const input = rewrite(action.input) as Record<string, unknown>
          return { ...action, input: typeof input.label === 'string' ? { ...input, label: suffix(input.label, `c${String(cueIndex).padStart(2, '0')}`) } : input }
        }),
      })),
    },
  }
}

const definition = withNonce(borderDefinitions.scripted)
/** The Run's roles: the declared Controller and the role each group derives, as compile merges them. */
const roles = borderRoles(definition)
const declaration: RunRoles = { roles, presets: definition.rolePresets ?? [], sides: definition.sides ?? [] }
const [blueSide, redSide] = (definition.sides ?? []).map(side => side.id) as [string, string]
const sideRoles = (side: string) => roles.filter(role => role.class === 'operator' && role.sees !== 'all' && role.sees?.includes(side) === true).map(role => role.id)
const controllerRole = roles.find(role => role.class === 'controller')!.id
const originalId = (id: string) => `${id}-${nonce}`

const oracle = createWireOracle(declaration)
const { registry, createScreen, join, einsatzIds, einsatzType, sideCommands, takeInventory, forbiddenFor, expectNoLeak, barrier, eventsReceived, command, recommendAs, boardText, screens } = oracle

let red: Screen
let blue: Screen
let controller: Screen

beforeAll(async () => {
  await oracle.open({ packs: [einsatzPack], definitions: [definition], runtimeAdapters: [createEinsatzSidedRuntimeAdapter()], scenarioId: definition.id })
})

afterAll(async () => { await oracle.close() })

/** What each side screen received before this step: the oracle scans what came since, and every store. */
const marks = (): Map<Screen, { readonly http: number; readonly ws: number }> => new Map([red, blue].map(screen => [screen, { http: screen.http.length, ws: screen.ws.length }]))

/** Blue sends the recommended units to each of its unserved tasks that free units can cover, as a tap on the call and one on Dispatch would. */
const dispatchAsBlue = async (): Promise<number> => {
  let sent = 0
  for (const object of blue.stores?.objects ?? []) {
    if (einsatzType(object) !== 'task' || object.operational.status !== 'open') continue
    const recommendation = await recommendAs(blue, object.id)
    if (recommendation.need === null || !recommendation.proposal.covers || recommendation.proposal.units.length === 0) continue
    if (recommendation.proposal.units.some(unit => unit.divertFrom !== undefined)) continue
    const outcome = await command(blue, einsatzCommandIds.send, { units: recommendation.proposal.units.map(unit => unit.unitId), to: { taskId: object.id } })
    if (outcome.kind === 'command' && outcome.result.ok) sent++
  }
  return sent
}

describe('the wire oracle on halden-border', () => {
  test('the copy carries the nonce on every item, and a side\'s "Tank 2" is not the other\'s', () => {
    const items = definition.packs[0]!.items
    expect(items.every(item => item.id.endsWith(`-${nonce}`) && item.label.includes(nonce))).toBe(true)
    const labels = items.map(item => item.label)
    expect(labels.filter(label => labels.some(other => other !== label && other.startsWith(label)))).toEqual([])
    // Every reference the timeline makes to an item names the copy's id.
    const references: string[] = []
    const collect = (value: unknown): void => {
      if (typeof value === 'string' && /^(unit|task|site):/.test(value)) references.push(value)
      else if (Array.isArray(value)) value.forEach(collect)
      else if (value !== null && typeof value === 'object') Object.values(value).forEach(collect)
    }
    collect(definition.timeline)
    expect(references.length).toBeGreaterThan(0)
    expect(references.filter(reference => !reference.endsWith(`-${nonce}`))).toEqual([])
  })

  test('Red\'s groups, the one-person Blue preset and the Controller play thirty minutes, and nothing reaches a side screen outside its side, its Board included', async () => {
    red = createScreen('red', sideRoles(redSide))
    blue = createScreen('blue', definition.rolePresets![0]!.roles)
    controller = createScreen('controller', [controllerRole])
    expect(blue.roleIds).toEqual(sideRoles(blueSide))
    for (const screen of [red, blue, controller]) await join(screen)
    expect(einsatzIds(controller).length).toBeGreaterThan(einsatzIds(blue).length)
    // The oracle watches each side's units by id and by label, and a public site by neither.
    const item = (id: string) => definition.packs[0]!.items.find(entry => entry.id === originalId(id))!
    await takeInventory()
    expect(forbiddenFor(blueSide)).toEqual(expect.arrayContaining([item('unit:red-tank-2').id, item('unit:red-tank-2').label]))
    expect(forbiddenFor(redSide)).toEqual(expect.arrayContaining([item('unit:blue-tank-2').id, item('unit:blue-tank-2').label, item('unit:blue-op-1').id]))
    expect(forbiddenFor(blueSide)).not.toContain(item('site:ystehede').id)
    expect(forbiddenFor(redSide)).not.toContain(item('site:knut').id)
    await expectNoLeak(red, redSide)
    await expectNoLeak(blue, blueSide)

    const reg = await registry()
    let sent = 0
    for (let minute = 1; minute <= 30; minute++) {
      const since = marks()
      if (minute === 1) sent += await dispatchAsBlue()
      await reg.advanceExecution(oracle.runId(), { minutes: 1 })
      await waitForCondition('maximum pace finished', () => reg.leaseSummary(oracle.runId()).leasesByKind['maximum-pace'] === 0)
      await barrier(red, blue, controller)
      sent += await dispatchAsBlue()
      await barrier(red, blue, controller)
      const built = minute % 5 === 0 ? { red: [await boardText(red)], blue: [await boardText(blue)] } : { red: [], blue: [] }
      await expectNoLeak(red, redSide, since.get(red), built.red)
      await expectNoLeak(blue, blueSide, since.get(blue), built.blue)
    }
    expect(sent).toBeGreaterThan(10)
    // Blue's own commands never reach Red; Red's scripted moves come from the timeline, not from a side.
    expect([...sideCommands.values()].every(sees => !sees.includes(redSide))).toBe(true)
    expect(sideCommands.size).toBeGreaterThanOrEqual(sent)
  }, 300_000)

  test('Blue\'s step-loss tasks reach Blue alone, every track a side holds or received is whitelisted, and side sockets get only side-visible events', async () => {
    const lossTasks = (screen: Screen) => einsatzIds(screen).filter(id => id.includes(':loss-'))
    expect(lossTasks(blue).length).toBeGreaterThan(0)
    expect(lossTasks(controller)).toEqual(expect.arrayContaining(lossTasks(blue)))
    expect(lossTasks(red)).toEqual([])
    for (const [screen, side] of [[blue, blueSide], [red, redSide]] as const) {
      const tracks = [
        ...eventsReceived(screen).flatMap(event => event.type === 'object.upserted' && event.object !== undefined ? [event.object as OperationalObject] : []),
        ...(screen.stores?.objects ?? []),
      ].filter(object => einsatzType(object) === 'track')
      expect(tracks.length).toBeGreaterThan(0)
      for (const track of tracks) {
        expect({ id: track.id, audience: track.audience, provenance: track.provenance, alerts: track.alerts }).toEqual({ id: track.id, audience: [side], provenance: { source: 'simulator' }, alerts: [] })
        expect([track.id, Object.keys(track.packData as object).filter(key => !['type', 'tier', 'fix', 'identity'].includes(key))]).toEqual([track.id, []])
        expect([track.id, ['tasking', 'telemetry', 'context'].filter(key => key in track)]).toEqual([track.id, []])
      }
      expect((screen.stores?.objects ?? []).filter(object => einsatzType(object) === 'track-index')).toEqual([])
      expect(screen.realtime).toEqual([])
      expect([...new Set(eventsReceived(screen).map(event => event.type))].filter(type => !sideVisibleEventTypes.has(type))).toEqual([])
    }
    await expectNoLeak(red, redSide)
    await expectNoLeak(blue, blueSide)
  })

  test('the Controller switches to the one-person Blue preset in place and keeps no Red truth id', async () => {
    const epoch = controller.epoch
    const http = controller.http.length
    controller.connection.setRoles(oracle.runId(), blue.roleIds)
    await waitForCondition('the Controller screen adopts its Blue perspective', () => controller.epoch > epoch)
    const readyIndex = controller.ws.findIndex(entry => entry.type === 'realtime.ready' && entry.epoch === controller.epoch)
    expect(readyIndex).toBeGreaterThan(0)
    await barrier(controller, blue)
    expect(einsatzIds(controller)).toEqual(einsatzIds(blue))
    await expectNoLeak(controller, blueSide, { http, ws: readyIndex })
    for (const screen of screens) expect({ screen: screen.name, errors: screen.errors }).toEqual({ screen: screen.name, errors: [] })
  })
})
