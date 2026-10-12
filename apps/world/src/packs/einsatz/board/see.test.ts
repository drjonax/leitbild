import { describe, expect, test } from 'bun:test'
import { createWall, openScreen, roleScreen } from '../fixtures/board-harness.ts'
import { groupDeclaration, groupItems } from '../fixtures/groups-run.ts'
import { openRun } from '../fixtures/run-harness.ts'
import { groupRoleId } from '../ids.ts'

/**
 * The See boxes on the Board: a screen that chose not to see a group's role
 * leaves that group's units out of Assets, as the map leaves them out,
 * even where another held role commands them. It is this tab's display
 * filter: the Run still shows the screen those units, so a call may still
 * offer one, named with its group.
 */

describe('Board See filter', () => {
  test('units of a group the screen does not see leave Assets, a highlighted one lets go, and seeing the group again brings them back', async () => {
    const run = await openRun({ items: groupItems, declared: groupDeclaration })
    try {
      const screen = await openScreen(run, createWall(), { actor: roleScreen(run, groupRoleId('haul-a'), 'north-desk') })
      const shown = () => screen.view().unitBoard.rows.map(row => row.id).sort()
      expect(shown()).toEqual(['a1', 'a2', 'b1'])
      await screen.click({ kind: 'row', list: 'units', id: 'b1' })
      expect(screen.mapSelection()).toBe('b1')
      const declared = run.run.roles()!.roles.map(role => role.id)
      expect(declared).toContain(groupRoleId('haul-b'))
      await screen.see(declared.filter(id => id !== groupRoleId('haul-b')))
      expect([shown(), screen.view().selected, screen.mapSelection()]).toEqual([['a1', 'a2'], null, null])
      await screen.see(declared)
      expect(shown()).toEqual(['a1', 'a2', 'b1'])
      await screen.see(null)
      expect(shown()).toEqual(['a1', 'a2', 'b1'])
    } finally {
      await run.close()
    }
  })

  test('a call still offers a unit of a group the screen does not see, named with its group in the row and in what one tap sends', async () => {
    const run = await openRun({ items: groupItems, declared: groupDeclaration })
    try {
      const screen = await openScreen(run, createWall(), { actor: roleScreen(run, groupRoleId('haul-a'), groupRoleId('haul-b')) })
      const declared = run.run.roles()!.roles.map(role => role.id)
      await screen.see(declared.filter(id => id !== groupRoleId('haul-b')))
      await screen.click({ kind: 'row', list: 'work', id: 'load' })
      const selected = screen.view().selected
      if (selected?.kind !== 'task') throw new Error('expected the call selected')
      const offered = new Map([...selected.proposal, ...selected.alternatives].map(entry => [entry.unitId, entry.label]))
      expect([...offered.keys()].sort()).toEqual(['a1', 'a2', 'b1'])
      expect([offered.get('a1'), offered.get('a2'), offered.get('b1')]).toEqual(['A1', 'A2', 'B1 (Haulers B hidden)'])
      // One tap sends it, as the proposal or as its alternative, and what it sent names the group too.
      const alternative = selected.alternatives.find(row => row.unitId === 'b1')
      await screen.click(alternative === undefined ? { kind: 'commit' } : { kind: 'alternative', number: alternative.number })
      expect([screen.calls.at(-1)?.input, screen.view().feedback?.text]).toEqual([{ units: ['b1'], to: { taskId: 'load' } }, expect.stringContaining('B1 (Haulers B hidden) → LOAD')])
    } finally {
      await run.close()
    }
  })
})
