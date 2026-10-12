import { describe, expect, test } from 'bun:test'
import atlas from '../../../core/map-symbols/common.json'
import { einsatzCommandIds as ids } from '../capabilities.ts'
import { einsatzConfigSchema } from '../config-validation.ts'
import { createWall, openScreen, pastGuardMs, runFor } from '../fixtures/board-harness.ts'
import { openRun } from '../fixtures/run-harness.ts'
import supplyConfig from '../fixtures/supply-run.config.json'
import supplyRun from '../fixtures/supply-run.scenario.json'

/**
 * Openness: a unit type that no code knows, with a property and an icon the
 * map's atlas never drew, is dispatched through the same Board. Types and
 * wording are read from the Definition, never written here.
 */

const config = einsatzConfigSchema.parse(supplyRun.packs[0]!.config)
const startMs = Date.parse(supplyRun.world.startsAt)
/** The cue invoking a Capability; the Definition has one of each. */
const cue = (capabilityId: string) => {
  const found = supplyRun.timeline.cues.filter(entry => entry.actions[0]!.capabilityId === capabilityId)
  if (found.length !== 1) throw new Error(`supply-run needs exactly one ${capabilityId} cue`)
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
const raise = raised.actions[0]!.input as { unitId: string; properties: Record<string, number> }

describe('Board openness on supply-run', () => {
  test('the Definition carries the T1 supply configuration unchanged', () => {
    expect(supplyRun.packs[0]!.config).toEqual(supplyConfig)
  })

  test('the cue-created unit is dispatched in 2 actions; the lighter one is free but not eligible, says why naming itself once, then becomes eligible once raised', async () => {
    const run = await openRun({ definition: supplyRun })
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
      expect(newcomer.properties).toEqual([{ label: property.label, value: `${(created.actions[0]!.input as { properties: Record<string, number> }).properties[property.id]} ${unitOf}` }])
      await screen.wait(pastGuardMs)
      screen.resetActions()
      await screen.key('n')
      await screen.key('Enter')
      expect(screen.actions()).toBe(2)
      expect(screen.calls.at(-1)).toMatchObject({ input: { units: [newcomer.id] }, result: { ok: true } })

      await runFor(run, (requested.at.seconds + 30) * 1_000 - (run.nowMs() - startMs), [screen])
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
    const run = await openRun({ definition: supplyRun, paused: true })
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
