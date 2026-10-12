// The wire oracle on both halden-border Definitions, as T6 acceptance asks:
// a screen holding Red's groups, a screen holding the "Blue (one person)"
// preset and a Controller screen, each driven by the real World client
// modules, play the shipped Definition over a real server: with Red scripted
// for its thirty minutes, and with Red played by a person for fifteen, its
// screen sending its recommendations for both of its opening calls and moving
// a tank to a point. Every instance id and label of the copy carries a per-run
// nonce, and each label its own suffix, so no label is another's prefix.
// Blue sends the recommended units as calls appear, its screening and
// overwatch calls included. After every minute the oracle deep-scans what
// each side screen received and built, its Board included, for anything
// outside its side: the other side's objects, labels and command ids. The
// Definitions are read through the border harness.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { OperationalObject, RunRoles } from '../src/core/model/index.ts'
import type { ScenarioDefinition } from '../src/core/scenarios/definition.ts'
import { einsatzCommandIds } from '../src/packs/einsatz/capabilities.ts'
import { borderDefinitions, borderRoles } from '../src/packs/einsatz/fixtures/border-harness.ts'
import { createEinsatzSidedRuntimeAdapter } from '../src/packs/einsatz/fixtures/sided-run.ts'
import { einsatzPack } from '../src/packs/einsatz/pack.ts'
import { createWireOracle, sideVisibleEventTypes, type Screen } from './fixtures/wire-oracle.ts'
import { waitForCondition } from './helpers.ts'

/**
 * The Definition with every item id suffixed by the nonce, every reference
 * to an item rewritten to match, and every item and cue-created label given
 * a suffix of its own, so no label is another's prefix. Groups, types and
 * templates are configuration and keep their ids.
 */
const withNonce = (source: ScenarioDefinition, nonce: string) => {
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

/** One oracle run: a Definition, how many minutes it plays, and whether Red's screen gives orders. */
const oracleRun = (source: ScenarioDefinition, minutes: number, redOrders: boolean) => {
  const nonce = crypto.randomUUID().slice(0, 8)
  const definition = withNonce(source, nonce)
  /** The Run's roles: the declared Controller and the role each group derives, as compile merges them. */
  const roles = borderRoles(definition)
  const declaration: RunRoles = { roles, presets: definition.rolePresets ?? [], sides: definition.sides ?? [] }
  const [blueSide, redSide] = (definition.sides ?? []).map(side => side.id) as [string, string]
  const sideRoles = (side: string) => roles.filter(role => role.class === 'operator' && role.sees !== 'all' && role.sees?.includes(side) === true).map(role => role.id)
  const controllerRole = roles.find(role => role.class === 'controller')!.id
  const originalId = (id: string) => `${id}-${nonce}`
  const item = (id: string) => definition.packs[0]!.items.find(entry => entry.id === originalId(id))!

  const oracle = createWireOracle(declaration)
  const { registry, createScreen, join, einsatzIds, einsatzType, sideCommands, takeInventory, forbiddenFor, expectNoLeak, barrier, eventsReceived, command, recommendAs, boardText, screens } = oracle

  let red: Screen
  let blue: Screen
  let controller: Screen

  /** What each side screen received before this step: the oracle scans what came since, and every store. */
  const marks = (): Map<Screen, { readonly http: number; readonly ws: number }> => new Map([red, blue].map(screen => [screen, { http: screen.http.length, ws: screen.ws.length }]))

  /** A side sends the recommended units to each of its unserved tasks that free units can cover, as a tap on the call and one on Dispatch would. */
  const dispatchAs = async (screen: Screen): Promise<number> => {
    let sent = 0
    for (const object of screen.stores?.objects ?? []) {
      if (einsatzType(object) !== 'task' || object.operational.status !== 'open') continue
      const recommendation = await recommendAs(screen, object.id)
      if (recommendation.need === null || !recommendation.proposal.covers || recommendation.proposal.units.length === 0) continue
      if (recommendation.proposal.units.some(unit => unit.divertFrom !== undefined)) continue
      const outcome = await command(screen, einsatzCommandIds.send, { units: recommendation.proposal.units.map(unit => unit.unitId), to: { taskId: object.id } })
      if (outcome.kind === 'command' && outcome.result.ok) sent++
    }
    return sent
  }

  /** Red's commander sends its recommendations for its calls, then moves a free shooter of its own to a point beside KNUT. */
  const redOpens = async (): Promise<number> => {
    const sent = await dispatchAs(red)
    await barrier(red, blue, controller)
    const busy = new Set((red.stores?.objects ?? []).flatMap(object => {
      const data = object.packData as { readonly type?: string; readonly taskId?: string }
      return einsatzType(object) === 'unit' && data.taskId !== undefined ? [object.id] : []
    }))
    const shooter = (red.stores?.objects ?? []).find(object => einsatzType(object) === 'unit' && !busy.has(object.id) && object.id.startsWith('unit:red-tank'))
    expect(shooter).toBeDefined()
    const knut = (item('site:knut') as unknown as { readonly position: readonly [number, number] }).position
    const moved = await command(red, einsatzCommandIds.send, { units: [shooter!.id], to: { point: { type: 'Point', coordinates: [knut[0] + 0.01, knut[1] + 0.01] } } })
    expect(moved).toMatchObject({ kind: 'command', result: { ok: true } })
    return sent + 1
  }

  describe(`the wire oracle on ${source.id}`, () => {
    beforeAll(async () => {
      await oracle.open({ packs: [einsatzPack], definitions: [definition], runtimeAdapters: [createEinsatzSidedRuntimeAdapter()], scenarioId: definition.id })
    })

    afterAll(async () => { await oracle.close() })

    test('the copy carries the nonce on every item, and no label is another\'s prefix', () => {
      const items = definition.packs[0]!.items
      expect(items.every(entry => entry.id.endsWith(`-${nonce}`) && entry.label.includes(nonce))).toBe(true)
      const labels = items.map(entry => entry.label)
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

    test(`Red's groups, the one-person Blue preset and the Controller play ${minutes} minutes, and nothing reaches a side screen outside its side, its Board included`, async () => {
      red = createScreen('red', sideRoles(redSide))
      blue = createScreen('blue', definition.rolePresets![0]!.roles)
      controller = createScreen('controller', [controllerRole])
      expect(blue.roleIds).toEqual(sideRoles(blueSide))
      if (redOrders) expect(definition.rolePresets!.some(preset => [...preset.roles].sort().join() === [...red.roleIds].sort().join())).toBe(true)
      for (const screen of [red, blue, controller]) await join(screen)
      expect(einsatzIds(controller).length).toBeGreaterThan(einsatzIds(blue).length)
      // The oracle watches each side's units and tasks by id and by label, and a public site by neither.
      await takeInventory()
      expect(forbiddenFor(blueSide)).toEqual(expect.arrayContaining([item('unit:red-tank-2').id, item('unit:red-tank-2').label]))
      expect(forbiddenFor(redSide)).toEqual(expect.arrayContaining([item('unit:blue-tank-2').id, item('unit:blue-tank-2').label, item('unit:blue-op-1').id, item('task:blue-screen').id, item('task:blue-screen').label]))
      if (redOrders) expect(forbiddenFor(blueSide)).toEqual(expect.arrayContaining([item('task:red-attack').id, item('task:red-attack').label, item('task:red-scout').id, item('task:red-scout').label]))
      expect(forbiddenFor(blueSide)).not.toContain(item('site:ystehede').id)
      expect(forbiddenFor(redSide)).not.toContain(item('site:knut').id)
      await expectNoLeak(red, redSide)
      await expectNoLeak(blue, blueSide)

      const reg = await registry()
      let sent = 0
      let redSent = 0
      for (let minute = 1; minute <= minutes; minute++) {
        const since = marks()
        if (minute === 1) {
          sent += await dispatchAs(blue)
          if (redOrders) redSent += await redOpens()
        }
        await reg.advanceExecution(oracle.runId(), { minutes: 1 })
        await waitForCondition('maximum pace finished', () => reg.leaseSummary(oracle.runId()).leasesByKind['maximum-pace'] === 0)
        await barrier(red, blue, controller)
        sent += await dispatchAs(blue)
        if (redOrders) redSent += await dispatchAs(red)
        await barrier(red, blue, controller)
        const built = minute % 5 === 0 ? { red: [await boardText(red)], blue: [await boardText(blue)] } : { red: [], blue: [] }
        await expectNoLeak(red, redSide, since.get(red), built.red)
        await expectNoLeak(blue, blueSide, since.get(blue), built.blue)
      }
      expect(sent).toBeGreaterThan(redOrders ? 5 : 10)
      const commandsSeeing = (side: string) => [...sideCommands.entries()].filter(([, sees]) => sees.includes(side)).map(([commandId]) => commandId)
      expect(commandsSeeing(blueSide).length).toBeGreaterThanOrEqual(sent)
      if (redOrders) {
        // Red's commands are watched for on Blue's screen, and Blue's on Red's: the scans above found none of them.
        expect(redSent).toBeGreaterThanOrEqual(3)
        expect(commandsSeeing(redSide).length).toBeGreaterThanOrEqual(redSent)
        expect(forbiddenFor(blueSide)).toEqual(expect.arrayContaining(commandsSeeing(redSide)))
        expect(forbiddenFor(redSide)).toEqual(expect.arrayContaining(commandsSeeing(blueSide)))
      } else {
        // Red's scripted moves come from the timeline, not from a side.
        expect(commandsSeeing(redSide)).toEqual([])
      }
    }, 300_000)

    test('every track a side holds or received is whitelisted, side sockets get only side-visible events, and Blue\'s step-loss tasks reach Blue alone', async () => {
      const lossTasks = (screen: Screen) => einsatzIds(screen).filter(id => id.includes(':loss-'))
      if (!redOrders) expect(lossTasks(blue).length).toBeGreaterThan(0)
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
}

oracleRun(borderDefinitions.scripted, 30, false)
oracleRun(borderDefinitions.humanRed, 15, true)
