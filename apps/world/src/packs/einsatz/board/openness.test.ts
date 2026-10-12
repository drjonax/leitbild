import { describe, expect, test } from 'bun:test'
import atlas from '../../../core/map-symbols/common.json'
import { einsatzCommandIds as ids } from '../capabilities.ts'
import { einsatzConfigSchema } from '../config-validation.ts'
import { createWall, openScreen, pastGuardMs, runFor } from '../fixtures/board-harness.ts'
import { openRun } from '../fixtures/run-harness.ts'
import supplyConfig from '../fixtures/supply-run.config.json'
import supplyRun from '../../../scenarios/supply-run.scenario.json'

/**
 * Openness: a unit type that no code knows, with a property and an icon the
 * map's atlas never drew, is dispatched through the same Board. Types and
 * wording are read from the Definition, never written here.
 */

const config = einsatzConfigSchema.parse(supplyRun.packs[0]!.config)
const startMs = Date.parse(supplyRun.world.startsAt)
type Cue = typeof supplyRun.timeline.cues[number]
/** The Capability call a cue makes; the closing cue shows guidance instead. */
const invoked = (entry: Cue) => {
  const action = entry.actions[0]!
  if (!('capabilityId' in action)) throw new Error(`${entry.id} invokes no Capability`)
  return action
}
/** The first cue invoking a Capability. */
const cue = (capabilityId: string) => {
  const found = supplyRun.timeline.cues.filter(entry => {
    const action = entry.actions[0]!
    return 'capabilityId' in action && action.capabilityId === capabilityId
  })
  if (found.length === 0) throw new Error(`supply-run needs a ${capabilityId} cue`)
  return found[0]!
}
const created = cue(ids.unitCreate)
const requested = cue(ids.taskCreate)
const raised = cue(ids.unitAdjust)
const mover = config.unitTypes.find(type => type.components.mobility !== undefined)!
const template = config.taskTemplates[0]!
const condition = template.requires[0]!.where[0]!
const property = mover.properties.find(entry => entry.id === condition.property)!
const unitOf = (property.kind === 'number' ? property.unit : undefined) ?? ''
const lighter = supplyRun.packs[0]!.items.find(item => item.type === 'unit' && item.unitType === mover.id)!
const lighterPayload = (lighter as { properties: Record<string, number> }).properties[property.id]!
const atLeast = 'atLeast' in condition ? condition.atLeast : Number.NaN
const raise = invoked(raised).input as { unitId: string; properties: Record<string, number> }
/**
 * The openness core of supply-run: its first place, the lighter vehicle and
 * the first request of the first template, with the first cues that add a
 * vehicle and a request and the raise. The rest of the exercise sends other
 * vehicles to the requests first.
 */
const core = {
  ...supplyRun,
  packs: [{
    ...supplyRun.packs[0]!,
    items: [
      supplyRun.packs[0]!.items.find(item => item.type === 'unit' && item.unitType !== mover.id)!,
      lighter,
      supplyRun.packs[0]!.items.find(item => item.type === 'task' && item.template === template.id)!,
    ],
  }],
  timeline: { cues: [created, requested, raised] },
}

describe('Board openness on supply-run', () => {
  test('the Definition extends the T1 supply configuration: every word, class, type and template it declared, with only the time on scene tuned', () => {
    const t1 = einsatzConfigSchema.parse(supplyConfig)
    expect(config.lexicon).toMatchObject(t1.lexicon)
    expect(config.loadClasses).toEqual(t1.loadClasses)
    for (const type of t1.unitTypes) {
      const extended = config.unitTypes.find(entry => entry.id === type.id)
      const tuned = type.components.service === undefined || extended?.components.service === undefined
        ? type
        : { ...type, components: { ...type.components, service: { ...type.components.service, onSceneS: extended.components.service.onSceneS } } }
      expect(extended).toEqual(tuned)
    }
    for (const template of t1.taskTemplates) expect(config.taskTemplates.find(entry => entry.id === template.id)).toEqual(template)
    expect(config.taskTemplates.length).toBeGreaterThan(t1.taskTemplates.length)
  })

  test('the cue-created unit is dispatched in 2 actions; the lighter one is free but not eligible, says why naming itself once, then becomes eligible once raised', async () => {
    const run = await openRun({ definition: core })
    try {
      const wall = createWall()
      const screen = await openScreen(run, wall)
      const lighterReason = `${lighter.label} · ${property.label} ${lighterPayload} ${unitOf} · needs ≥ ${atLeast} ${unitOf}`

      await screen.key('n')
      const before = screen.view()
      expect(before.selected).toMatchObject({ kind: 'task', ineligible: [lighterReason] })
      expect(before.commit).toMatchObject({ state: 'none', enabled: false })
      // Not "no unit can serve": a unit could, once its property allows it.
      expect(before.commit.text).toBe(`No eligible unit · ${lighterReason}`)
      expect(before.workList.rows[0]!.statusText).toBe(before.commit.text)
      expect(before.alerts.filter(alert => alert.code === 'no_unit_can_serve')).toEqual([])

      await runFor(run, created.at.seconds * 1_000 + 1_000, [screen])
      const newcomer = screen.view().unitBoard.rows.find(row => row.id !== lighter.id)!
      expect(newcomer.properties).toEqual([{ label: property.label, value: `${(invoked(created).input as { properties: Record<string, number> }).properties[property.id]} ${unitOf}` }])
      await screen.wait(pastGuardMs)
      screen.resetActions()
      await screen.key('n')
      await screen.key('Enter')
      expect(screen.actions()).toBe(2)
      expect(screen.calls.at(-1)).toMatchObject({ input: { units: [newcomer.id] }, result: { ok: true } })

      // Between the request and the raise: the request waits for the lighter unit, which may not serve it yet.
      await runFor(run, Math.floor((requested.at.seconds + raised.at.seconds) / 2) * 1_000 - (run.nowMs() - startMs), [screen])
      await screen.key('n')
      const waiting = screen.view()
      expect(waiting.selected).toMatchObject({ kind: 'task', ineligible: [lighterReason] })
      expect(waiting.commit.text).toBe(`No eligible unit · ${lighterReason} · 1 busy`)

      await runFor(run, (raised.at.seconds + 5) * 1_000 - (run.nowMs() - startMs), [screen])
      expect(screen.view().unitBoard.rows.find(row => row.id === lighter.id)!.properties[0]!.value).toBe(`${raise.properties[property.id]} ${unitOf}`)
      await screen.wait(pastGuardMs)
      screen.resetActions()
      await screen.key('n')
      expect(screen.view().selected).toMatchObject({ ineligible: [] })
      await screen.key('Enter')
      expect(screen.actions()).toBe(2)
      expect(screen.calls.at(-1)).toMatchObject({ input: { units: [lighter.id] }, result: { ok: true } })
      expect(screen.calls.every(call => call.result.ok)).toBe(true)
    } finally {
      await run.close()
    }
  })

  test('the unit and request icons are catalogue icons the atlas never drew, and the Board shows them as declared', async () => {
    const run = await openRun({ definition: core, paused: true })
    try {
      const screen = await openScreen(run, createWall())
      const view = screen.view()
      expect(Object.keys(atlas)).not.toContain(mover.icon)
      expect(Object.keys(atlas)).not.toContain(template.icon)
      expect(view.unitBoard.rows.map(row => row.icon)).toEqual([mover.icon])
      expect(view.workList.rows.map(row => [row.icon, row.noun])).toEqual([[template.icon, template.label]])
      expect(view.headings.workList).toBe(config.lexicon.workList!)
      expect(view.headings.unitBoard).toBe(config.lexicon.unitBoard!)
    } finally {
      await run.close()
    }
  })
})
