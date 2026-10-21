import { describe, expect, test } from 'bun:test'
import { checkCeiling, countLines, filesAtRevision, isCountedPath, measure, type DisplayLocReport } from './display-loc.ts'

const lines = (count: number): string => 'x\n'.repeat(count)

describe('display LOC counting', () => {
  test('counts lines as wc -l does, plus an unterminated last line', () => {
    expect(countLines('')).toBe(0)
    expect(countLines('a\n')).toBe(1)
    expect(countLines('a')).toBe(1)
    expect(countLines('a\nb')).toBe(2)
  })

  test('counts code, styles and the skill, never tests or data', () => {
    expect(isCountedPath('apps/world/src/ui/embed/embed.css')).toBe(true)
    expect(isCountedPath('apps/agents/skills/operator-displays/SKILL.md')).toBe(true)
    expect(isCountedPath('apps/world/src/ui/embed/panels/TrendPanel.svelte')).toBe(true)
    expect(isCountedPath('apps/agents/src/ui/modules/live-view/listing.test.ts')).toBe(false)
    expect(isCountedPath('apps/world/src/packs/process-plant/displays/mimic/text-metrics.json')).toBe(false)
  })

  test('the scope follows paths: moved code leaves the count, display-serving pack UI joins it', () => {
    const report = measure('fixture', [
      { path: 'apps/world/src/packs/process-plant/displays/compose.ts', text: lines(10) },
      { path: 'apps/world/src/packs/process-plant/ui/displays/VesselGlyph.svelte', text: lines(4) },
      { path: 'apps/world/src/packs/process-plant/ui/plant-card/PlantCard.svelte', text: lines(100) },
      { path: 'apps/world/src/packs/process-plant/ic/thresholds.ts', text: lines(100) },
      { path: 'apps/world/src/packs/electric-grid/observation/branches.ts', text: lines(3) },
      { path: 'apps/world/src/core/model/alerts.ts', text: lines(2) },
      { path: 'scripts/display-eval/checker-metrics.ts', text: lines(100) },
    ])
    expect(report.total).toBe(19)
    expect(report.groups.find(group => group.name === 'World display-serving pack UI')?.lines).toBe(4)
    expect(report.groups.find(group => group.name === 'World pack observation')?.lines).toBe(3)
    expect(report.files.map(file => file.path)).not.toContain('apps/world/src/packs/process-plant/ui/plant-card/PlantCard.svelte')
    expect(report.groups.find(group => group.name === 'Host view relay')?.emptyPatterns).toEqual(['apps/leitbild/src/ui/view-relay.ts'])
  })

  test('ceilings fail above the phase limit; the peak is one total', () => {
    const report = (total: number): DisplayLocReport => ({ revision: 'r', total, groups: [], files: [] })
    expect(checkCeiling(report(30_000), 'p0').pass).toBe(true)
    expect(checkCeiling(report(30_001), 'p0').reasons).toEqual(['30001 lines exceed the p0 ceiling of 30000'])
    expect(checkCeiling(report(38_000), 'peak').pass).toBe(true)
    expect(checkCeiling(report(38_001), 'peak').pass).toBe(false)
    expect(checkCeiling(report(23_000), 'swap').pass).toBe(true)
    expect(checkCeiling(report(22_400), 'end').pass).toBe(false)
  })
})

// One `git show` per file in scope (139 at bacf7a115, about 2.6 s on a quiet machine): sized for a loaded one, as
// Bun's 5 s default failed under parallel lanes.
const BASELINE_READ_TIMEOUT_MS = 60_000

test('reproduces the plan baseline at bacf7a115: 32,908 lines', async () => {
  const { commit, files } = await filesAtRevision(`${import.meta.dir}/..`, 'bacf7a115')
  const report = measure(commit, files)
  expect(report.total).toBe(32_908)
  expect(report.groups.find(group => group.name === 'World plant displays')?.lines).toBe(15_166)
  expect(checkCeiling(report, 'p0').pass).toBe(false)
}, BASELINE_READ_TIMEOUT_MS)
