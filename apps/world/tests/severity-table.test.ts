import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { priorityLevels } from '../src/core/model/alerts.ts'
import { severityStyle, severityTable } from '../src/ui/displays/severity.ts'

// The World severity table's shape and rules (plan v3.1 §2.7, T04a; lead
// ruling R2): one family and one glyph per priority, notice without hue, and
// an alert without a priority neutral (R1). The colours' parity with
// OpenBridge 2.0.0 per palette is p1-light's display-colour test.

const hued = ['emergency', 'alarm', 'warning', 'caution'] as const

describe('severity table', () => {
  test('one entry per priority above none, each with the OpenBridge family it is drawn in; emergency is critical magenta', () => {
    expect(Object.keys(severityTable).sort()).toEqual(priorityLevels.filter(level => level !== 'none').sort())
    expect(Object.fromEntries(Object.entries(severityTable).map(([priority, style]) => [priority, style.family]))).toEqual({
      emergency: 'critical', alarm: 'alarm', warning: 'warning', caution: 'caution', notice: null,
    })
  })

  test('each hued priority has its own glyph and a colour in day, dusk and night; notice has neither hue nor glyph', () => {
    expect(new Set(hued.map(priority => severityTable[priority].glyph)).size).toBe(hued.length)
    for (const priority of hued) {
      expect(severityTable[priority].glyph).not.toBeNull()
      expect(Object.keys(severityTable[priority].rgb!).sort()).toEqual(['day', 'dusk', 'night'])
      for (const colour of Object.values(severityTable[priority].rgb!)) expect(colour).toMatch(/^rgb\(\d{1,3}, \d{1,3}, \d{1,3}\)$/)
    }
    expect(severityTable.notice).toMatchObject({ family: null, glyph: null, rgb: null, word: 'Notice' })
  })

  test('no two families share a colour in any palette', () => {
    for (const palette of ['day', 'dusk', 'night'] as const) {
      expect(new Set(hued.map(priority => severityTable[priority].rgb![palette])).size).toBe(hued.length)
    }
  })

  test('R1: without a priority the severity word shows neutrally with "priority not declared"; critical is never drawn as emergency', () => {
    for (const severity of ['info', 'warning', 'critical'] as const) {
      expect(severityStyle(null, severity)).toMatchObject({ family: null, glyph: null, rgb: null })
      expect(severityStyle(null, severity)!.word).toEndWith(' · priority not declared')
    }
    expect(severityStyle(null, 'critical')!.word).toBe('Critical · priority not declared')
    expect(severityStyle(null, 'critical')).not.toEqual(severityTable.emergency)
    expect(severityStyle(null, 'critical')).not.toEqual(severityTable.alarm)
  })

  test('a declared priority is drawn as the table says, whatever the severity; priority none is not drawn', () => {
    expect(severityStyle('emergency', 'critical')).toBe(severityTable.emergency)
    expect(severityStyle('caution', 'warning')).toBe(severityTable.caution)
    expect(severityStyle('none', 'info')).toBeNull()
  })

  test('the table imports no OpenBridge, so the main app can draw it (T28)', () => {
    const source = readFileSync(join(import.meta.dir, '../src/ui/displays/severity.ts'), 'utf8')
    expect([...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1])).toEqual(['../../core/model/alerts.ts'])
  })
})
