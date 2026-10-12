import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compile } from 'svelte/compiler'
import ts from 'typescript'

/**
 * The Board's Svelte files compile in runes mode with no warning: no
 * accessibility, unused-style or reactivity warning slips into the panel.
 * And, as World's lifecycle policy asks of `src/ui`, no raw `$effect` does
 * mount-only setup: timers, listeners and observers start in `runOnMount`.
 */

const files = [...new Bun.Glob('*.svelte').scanSync({ cwd: import.meta.dir })].sort()
const mountOnlyCalls = ['addEventListener', 'setInterval', 'ResizeObserver', 'new MapLibre']

/** Every `$effect(…)` call in a component's script, as written. */
const effectSnippets = (source: string): ReadonlyArray<string> => {
  const script = /<script[^>]*>([\s\S]*?)<\/script>/.exec(source)?.[1]
  if (script === undefined) return []
  const ast = ts.createSourceFile('component.ts', script, ts.ScriptTarget.Latest, true)
  const snippets: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === '$effect') snippets.push(node.getText(ast))
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return snippets
}

describe('Einsatz Svelte files', () => {
  test('the Board panel and its parts are all here', () => {
    expect(files).toEqual(['BoardActionBar.svelte', 'BoardContacts.svelte', 'BoardIcon.svelte', 'BoardPanel.svelte', 'BoardUnits.svelte', 'BoardWorkList.svelte'])
  })

  for (const file of files) {
    const source = readFileSync(join(import.meta.dir, file), 'utf8')
    test(`${file} compiles without warnings`, () => {
      const result = compile(source, { filename: file, generate: 'client', runes: true })
      expect(result.warnings.map(warning => `${warning.code}: ${warning.message}`)).toEqual([])
    })
    test(`${file} does mount-only setup in runOnMount, never in a raw $effect`, () => {
      const violations = effectSnippets(source).filter(snippet => mountOnlyCalls.some(call => snippet.includes(call)))
      expect(violations.map(snippet => snippet.split('\n')[0])).toEqual([])
    })
  }

  test('the check finds mount-only setup in a raw $effect', () => {
    const source = '<script lang="ts">\n  $effect(() => {\n    const timer = setInterval(() => undefined, 200)\n    return () => clearInterval(timer)\n  })\n</script>\n'
    expect(effectSnippets(source).filter(snippet => mountOnlyCalls.some(call => snippet.includes(call)))).toHaveLength(1)
  })
})
