import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

// The main-app alarm strip's host rules (plan v3.1 §2.7, §2.8; lead ruling
// R14): T28, the main World bundle reaches no OpenBridge, the strip included;
// T24's static half, the strip offers no acknowledge, shelve or suppress and
// states the acknowledgement rule as it stands (D7 default). The browser half
// of T24 and T17 is the eval lane's.

const src = join(import.meta.dir, '../src')

/** Every source file the main app loads at run time from ui/main.ts: static, side-effect and dynamic imports; type-only imports aside. */
const mainGraph = (): { readonly files: ReadonlySet<string>; readonly packages: ReadonlyMap<string, ReadonlyArray<string>> } => {
  const files = new Set<string>()
  const packages = new Map<string, string[]>()
  const visit = (file: string): void => {
    if (files.has(file)) return
    files.add(file)
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/(import|export)(\s+type)?\s+[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g)) {
      if (match[2] !== undefined) continue
      const specifier = match[3] ?? match[4] ?? match[5]!
      if (!specifier.startsWith('.')) {
        packages.set(specifier, [...(packages.get(specifier) ?? []), relative(src, file)])
        continue
      }
      const target = [resolve(dirname(file), specifier), `${resolve(dirname(file), specifier)}.ts`].find(path => existsSync(path) && statSync(path).isFile())
      if (target === undefined) throw new Error(`${relative(src, file)} imports ${specifier}, which resolves to no file`)
      visit(target)
    }
  }
  visit(join(src, 'ui/main.ts'))
  return { files, packages }
}

describe('the main-app alarm strip', () => {
  test('T28: the main app loads the strip and no OpenBridge package', () => {
    const { files, packages } = mainGraph()
    expect([...files].map(file => relative(src, file))).toEqual(expect.arrayContaining(['ui/displays/AlertStrip.svelte', 'ui/displays/AlertList.svelte', 'ui/displays/severity.ts']))
    expect([...packages.entries()].filter(([name]) => name.startsWith('@oicl/'))).toEqual([])
  })

  test('T28: the main app reaches no vignette module, so the vignette renderer and its OpenBridge stay in the embed bundle', () => {
    expect([...mainGraph().files].map(file => relative(src, file)).filter(file => file.startsWith('ui/embed/vignette/'))).toEqual([])
  })

  test('T24: the strip invokes nothing and offers no acknowledge, shelve or suppress; it states who may acknowledge as the code allows', () => {
    const strip = ['AlertStrip.svelte', 'AlertList.svelte'].map(name => readFileSync(join(src, 'ui/displays', name), 'utf8'))
    for (const source of strip) {
      expect(source).not.toMatch(/invoke|Capability|fetch\(|simulation-run-client/)
      expect(source.match(/<button\b[^>]*>/g) ?? []).toEqual(source === strip[0] ? ['<button type="button" aria-expanded={!folded} onclick={fold}>'] : [])
    }
    // D7 default (D-21): the Assistant may acknowledge where a Pack lets it; only a Pack that records the actor says so.
    expect(strip[0]).toContain('The Assistant may acknowledge alarms where a Pack lets it; a row says "acknowledged by Assistant" where its Pack records who acknowledged.')
  })
})
