import { describe, expect, test } from 'bun:test'
import type { ScenarioRole, ScenarioSide } from '../../../core/model/index.ts'
import { einsatzCommandIds as ids } from '../capabilities.ts'
import { einsatzConfigSchema } from '../config-validation.ts'
import { low, templates, types } from '../fixtures/engine-harness.ts'
import { lonLat, openRun, screenOf, taskItem, unitItem, type OpenRun, type RoleRunDeclaration, type TaskItem, type UnitItem } from '../fixtures/run-harness.ts'
import { einsatzSidedSelection } from '../fixtures/sided-run.ts'
import { einsatzPackId } from '../ids.ts'

/**
 * Job chains in a sided role Run with its clock running: who may give,
 * remove, pause, resume and clear a unit's steps, what a side may name as a
 * step's target, and an armed unit's move then engage chain, every call
 * through the Run's Capability path as a screen holding roles.
 */

const sides: ReadonlyArray<ScenarioSide> = [
  { id: 'north', label: 'North', colour: '#1565c0' },
  { id: 'south', label: 'South', colour: '#c62828' },
]
const roles: ReadonlyArray<ScenarioRole> = [
  { id: 'north-lead', label: 'North lead', class: 'operator', sees: ['north'] },
  { id: 'north-watch', label: 'North watch', class: 'operator', sees: ['north'] },
  { id: 'south-lead', label: 'South lead', class: 'operator', sees: ['south'] },
  { id: 'control', label: 'Control', class: 'controller', sees: 'all' },
]
/** Each side's lead commands its crews; North watch sees North's picture and commands nothing. */
const selection = einsatzSidedSelection('chains', { side: 'north', role: 'north-lead' }, { side: 'south', role: 'south-lead' })
const declared: RoleRunDeclaration = { roles, sides, config: selection.config }
const unitTypes = einsatzConfigSchema.parse(selection.config).unitTypes
const gun = unitTypes.find(type => type.components.effector !== undefined)!.id
const scout = unitTypes.find(type => type.components.sensor !== undefined && type.components.effector === undefined)!.id

const screens = {
  lead: screenOf(declared, 'north-lead'),
  watch: screenOf(declared, 'north-watch'),
  south: screenOf(declared, 'south-lead'),
  control: screenOf(declared, 'control'),
}

/** A point this many metres north of the field's origin. */
const north = (metres: number): [number, number] => lonLat(0.2, metres / 110_540)
const point = (metres: number) => ({ type: 'Point', coordinates: north(metres) })
const sided = <T extends UnitItem | TaskItem>(item: T, side: string): T => ({ ...item, side })
/**
 * North's scout, and South's 500 m north of it, which North identifies at
 * the first 2 s boundary; North's shooter 3 km south, out of its weapon's
 * reach; North's carrier and a North task.
 */
const items = [
  sided(unitItem('ns', scout, north(0)), 'north'),
  sided(unitItem('ss', scout, north(500)), 'south'),
  sided(unitItem('ng', gun, north(-3_000)), 'north'),
  sided(unitItem('nc', types.roadCarrier, north(-3_000)), 'north'),
  sided(taskItem('tn', templates.load, north(-2_000), { [low]: 1 }), 'north'),
]

const withRun = async (body: (run: OpenRun) => Promise<void>): Promise<void> => {
  const run = await openRun({ items, declared })
  try { await body(run) } finally { await run.close() }
}

const accepted = async (run: OpenRun, capabilityId: string, input: unknown, actor = screens.lead): Promise<void> => {
  const result = await run.invoke(capabilityId, input, actor)
  if (!result.ok) throw new Error(`${capabilityId} refused: ${result.reason}`)
}
const steps = (run: OpenRun, unitId: string) => run.unit(unitId).orders.map(step => [step.id, step.kind, step.state])
const healthy = (run: OpenRun) => expect(run.connection.health?.().map(entry => entry.state)).toEqual(['ready'])

/** The one track a side holds, by its object: its id and the label its side knows it by. */
const trackOf = (run: OpenRun, side: string): { readonly id: string; readonly label: string } => {
  const tracks = run.run.snapshot().objects.filter(object => object.packId === einsatzPackId
    && (object.packData as { readonly type?: unknown } | undefined)?.type === 'track'
    && Array.isArray(object.audience) && object.audience.length === 1 && object.audience[0] === side)
  if (tracks.length !== 1) throw new Error(`${side} holds ${tracks.length} tracks; expected one`)
  return { id: tracks[0]!.id, label: tracks[0]!.label }
}

describe('Einsatz job chains in a sided role Run', () => {
  test('a role that does not command a unit is refused every chain command, naming the role it needs; the other side does not see the unit', async () => {
    await withRun(async run => {
      await accepted(run, ids.send, { units: ['nc'], to: { taskId: 'tn' } })
      await accepted(run, ids.queue, { unitId: 'nc', to: { point: point(-2_500) } })
      const denied = 'unit_not_authorized: North watch does not command NC. It belongs to North lead: add that role to command it'
      const orders: ReadonlyArray<readonly [string, unknown]> = [
        [ids.queue, { unitId: 'nc', to: { point: point(-2_600) } }],
        [ids.stepRemove, { unitId: 'nc', stepId: 'step-2' }],
        [ids.hold, { unitId: 'nc' }],
        [ids.resume, { unitId: 'nc' }],
        [ids.clear, { unitId: 'nc' }],
      ]
      for (const [capabilityId, input] of orders) {
        expect([capabilityId, (await run.refusal(capabilityId, input, screens.watch)).reason]).toEqual([capabilityId, denied])
        expect([capabilityId, (await run.refusal(capabilityId, input, screens.south)).reason]).toEqual([capabilityId, 'not_in_picture: Not in your picture'])
      }
      expect(steps(run, 'nc')).toEqual([['step-1', 'serve', 'active'], ['step-2', 'move', 'queued']])
      expect(run.unit('nc').lastAction).toMatchObject({ verb: 'queue', by: 'North lead', stepId: 'step-2' })

      // The role that commands it may do each of them.
      await accepted(run, ids.hold, { unitId: 'nc' })
      await accepted(run, ids.resume, { unitId: 'nc' })
      await accepted(run, ids.stepRemove, { unitId: 'nc', stepId: 'step-2' })
      await accepted(run, ids.clear, { unitId: 'nc' })
      expect(run.unit('nc')).toMatchObject({ orders: [], lastAction: { verb: 'clear', by: 'North lead' } })
      healthy(run)
    })
  })

  test('a side may not send or queue a unit to another side\'s track: refused as not in its picture, echoing nothing of it', async () => {
    await withRun(async run => {
      run.forward(2_000)
      await run.settle()
      const theirs = trackOf(run, 'south')
      const ours = trackOf(run, 'north')
      for (const [capabilityId, input] of [[ids.send, { units: ['ng'], to: { trackId: theirs.id } }], [ids.queue, { unitId: 'ng', to: { trackId: theirs.id } }]] as const) {
        expect([capabilityId, (await run.refusal(capabilityId, input, screens.lead)).reason]).toEqual([capabilityId, 'not_in_picture: Not in your picture'])
      }
      // An id no side holds reads the same, and a truth view is refused the other side's track as a cross-side reference.
      expect((await run.refusal(ids.queue, { unitId: 'ng', to: { trackId: 'track:north:99' } }, screens.lead)).reason).toBe('not_in_picture: Not in your picture')
      expect((await run.refusal(ids.send, { units: ['ng'], to: { trackId: theirs.id } }, screens.control)).reason).toBe('cross_side_reference: NG cannot engage another side\'s track')
      // South may not give North's shooter a step on North's track either.
      expect((await run.refusal(ids.queue, { unitId: 'ng', to: { trackId: ours.id } }, screens.south)).reason).toBe('not_in_picture: Not in your picture')
      expect(run.unit('ng').orders).toEqual([])
      healthy(run)
    })
  })

  test('an armed unit moves into range, then engages its side\'s track until the kill it watched ends the step, through the Capability path', async () => {
    await withRun(async run => {
      run.forward(2_000)
      await run.settle()
      const track = trackOf(run, 'north')
      // Its weapon reaches the track only in the last 100 m of the move.
      await accepted(run, ids.send, { units: ['ng'], to: { point: point(-1_400) } })
      await accepted(run, ids.queue, { unitId: 'ng', to: { trackId: track.id } })
      expect(steps(run, 'ng')).toEqual([['step-1', 'move', 'active'], ['step-2', 'engage', 'queued']])
      expect(run.unit('ng')).toMatchObject({ lastAction: { verb: 'queue', target: track.id, by: 'North lead', stepId: 'step-2' } })
      expect(run.unit('ng').engage).toBeUndefined()
      // A move sets off at once: it arrives when its leg is driven.
      expect(run.unit('ng').phase).toBe('en-route')
      run.forward(Math.ceil(run.unit('ng').leg!.durationMs) + 1)
      await run.settle()
      expect(run.unit('ng')).toMatchObject({ phase: 'holding', engage: track.id, orders: [{ id: 'step-2', kind: 'engage', state: 'active' }] })
      run.forward(120_000)
      await run.settle()
      expect(run.unit('ss').integrity).toBe('destroyed')
      expect(run.unit('ng')).toMatchObject({ orders: [], alerts: [], lastAction: { verb: 'engage', target: track.id, by: 'North lead', cause: 'destroyed', stepId: 'step-2' } })
      // The unit whose steps name North's track is in North's picture alone.
      expect(run.object('ng')?.audience).toEqual(['north'])
      healthy(run)
    })
  })
})
