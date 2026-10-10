import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

// No asset type is built into Einsatz: its code, tests included, never names a
// demo asset, role or casualty concept, not even inside an identifier such as
// `isTank`. Every such word comes from configuration. This file lies outside
// the scope because it must spell the words out. The scope widens at the cut
// to ui/**, core/**, simulation/**, tests/helpers* and the integration tests.

const worldRoot = join(import.meta.dir, '..')
const scopeRoots: ReadonlyArray<string> = ['src/packs/einsatz']
/** JSON (scenario data and the icon catalogue), built UI output and Process Plant display code, where the word names a vessel. */
const exempt = (path: string): boolean => path.endsWith('.json') || path.startsWith('src/ui/dist/') || path.startsWith('src/ui/embed/composed-display/')

const demoWord = /^(?:ambulances?|patients?|hospitals?|police|firefighting|recces?|tanks?|armou?r(?:ed)?|casualt(?:y|ies)|ems|triage|helicopters?|patrol|trucks?)$/
/** "fire" alone is mechanism vocabulary; only the sequence names an asset. */
const demoSequences: ReadonlyArray<readonly [string, RegExp]> = [['fire', /^engines?$/]]

/** Lower-case tokens, split at non-alphanumerics (so `_`, `-`, `.` and `/`), digits, and camelCase or PascalCase boundaries. */
const tokenize = (text: string): string[] => text
  .split(/[^A-Za-z0-9]+/)
  .flatMap(word => word.split(/[0-9]+/))
  .flatMap(word => word.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(' '))
  .filter(token => token.length > 0)
  .map(token => token.toLowerCase())

/** Each demo word among the tokens, at the index of its first token; sequences are joined by a space. */
const demoMatches = (tokens: ReadonlyArray<string>): Array<{ readonly index: number; readonly word: string }> => tokens.flatMap((token, index) => {
  if (demoWord.test(token)) return [{ index, word: token }]
  const next = tokens[index + 1]
  return demoSequences.some(([first, second]) => token === first && next !== undefined && second.test(next)) ? [{ index, word: `${token} ${next}` }] : []
})
const demoWordsIn = (text: string): string[] => demoMatches(tokenize(text)).map(match => match.word)

const filesInScope = async (): Promise<string[]> => {
  const files: string[] = []
  for (const root of scopeRoots) {
    for await (const path of new Bun.Glob('**/*').scan({ cwd: join(worldRoot, root), onlyFiles: true, dot: true })) {
      const relative = `${root}/${path}`
      if (!exempt(relative)) files.push(relative)
    }
  }
  return files.sort()
}

describe('Einsatz vocabulary', () => {
  test('the scanner catches demo words inside identifiers, snake case, kebab case and phrases', () => {
    expect(demoWordsIn('recceId')).toEqual(['recce'])
    expect(demoWordsIn('fireEngine')).toEqual(['fire engine'])
    expect(demoWordsIn('tank_count')).toEqual(['tank'])
    expect(demoWordsIn('casualties')).toEqual(['casualties'])
    expect(demoWordsIn("'fire-engine'")).toEqual(['fire engine'])
    expect(demoWordsIn('isTank || EMSBoard || unit2Patrol')).toEqual(['tank', 'ems', 'patrol'])
  })

  test('the scanner leaves mechanism words and words that merely contain a demo word alone', () => {
    for (const text of ['fireRate', 'firedFactor', 'fire', 'items', 'systems', 'XMLParser', 'tanker']) expect(demoWordsIn(text)).toEqual([])
  })

  test('the scope holds the Pack code and its tests, never its JSON fixtures', async () => {
    const files = await filesInScope()
    expect(files.some(path => path.endsWith('.test.ts'))).toBe(true)
    expect(files.some(path => path.endsWith('.ts') && !path.endsWith('.test.ts'))).toBe(true)
    expect(files.filter(path => path.endsWith('.json'))).toEqual([])
  })

  test('no file in scope names a demo asset', async () => {
    const findings: string[] = []
    for (const path of await filesInScope()) {
      const text = await Bun.file(join(worldRoot, path)).text()
      const located = text.split('\n').flatMap((line, index) => tokenize(line).map(token => ({ token, line: index + 1 })))
      for (const match of demoMatches(located.map(entry => entry.token))) findings.push(`${path}:${located[match.index]!.line}: ${match.word}`)
    }
    expect(findings).toEqual([])
  })
})
