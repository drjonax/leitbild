import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compile } from 'svelte/compiler'

// The vignette's components compile in runes mode with no warning (no
// accessibility, unused-style or reactivity warning slips in), and none uses
// a raw $effect: what runs once on mount runs in runOnMount.

const dir = join(import.meta.dir, '../src/ui/embed/vignette')
const files = [...new Bun.Glob('*.svelte').scanSync({ cwd: dir })].sort()

describe('vignette components', () => {
  test('every primitive B1 names is here', () => {
    expect(files).toEqual(expect.arrayContaining(['AlertsSection.svelte', 'GroupedValues.svelte', 'Readout.svelte', 'StateWord.svelte', 'TrendStrip.svelte', 'Vignette.svelte']))
  })

  test('every OpenBridge element and icon a vignette draws is defined by a bare import in its one loader (policy §5)', () => {
    const loader = readFileSync(join(dir, 'openbridge.ts'), 'utf8')
    const bare = new Set([...loader.matchAll(/^import '@oicl\/openbridge-webcomponents\/dist\/[^']*\/([a-z0-9-]+)\.js'$/gm)].map(match => match[1]!))
    const drawn = new Set(files.flatMap(file => [...readFileSync(join(dir, file), 'utf8').matchAll(/<(ob[ci])-([a-z0-9-]+)/g)].map(match => (match[1] === 'obi' ? `icon-${match[2]}` : match[2]!))))
    expect([...drawn].filter(module => !bare.has(module))).toEqual([])
    expect([...drawn].sort()).toEqual(['bar-horizontal', 'bus', 'icon-ai', 'readout-block', 'source', 'status-indicator', 'switch', 'transformer'])
  })

  for (const file of files) {
    test(`${file} compiles without warnings and without a raw $effect`, () => {
      const source = readFileSync(join(dir, file), 'utf8')
      const result = compile(source, { filename: file, generate: 'client', runes: true })
      expect(result.warnings.map(warning => `${warning.code}: ${warning.message}`)).toEqual([])
      expect(source).not.toContain('$effect(')
    })
  }
})
