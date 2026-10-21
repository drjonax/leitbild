import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

// The display boundaries of plan v3.1 §2.10 (T29) beside the plant rule
// (process-plant-display-boundary.test.ts):
// 1. World's display feature (features/displays) imports no Pack;
// 2. no World feature (features/**) imports a Pack;
// 3. the display UI (ui/displays) imports no Pack;
// 4. features/displays holds no pixel constants: the layout engine takes
//    every size from the caller's DiagramProfile, measured by the client;
// 5. the vignette renderer (ui/embed/vignette) imports no Pack and names
//    none: no Pack id and no Pack's own words, in code or comments.
// A Pack is reached through the Pack registry and protocols in core/packs,
// which are no Pack import. Exceptions are dated: each says until when it
// holds, and the swap deletes what they allow.

const root = join(import.meta.dir, '..')
const src = join(root, 'src')
const packs = join(src, 'packs')

const filesUnder = (dir: string): ReadonlyArray<string> => !existsSync(dir) ? [] : readdirSync(dir).flatMap(name => {
  const path = join(dir, name)
  return statSync(path).isDirectory() ? filesUnder(path) : [path]
})
const sourcesUnder = (dir: string): ReadonlyArray<string> => filesUnder(join(src, dir)).filter(file => /\.(ts|svelte)$/.test(file) && !file.endsWith('.test.ts'))

const importSpecifiers = (source: string): ReadonlyArray<string> =>
  [...source.matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1] ?? match[2]!)

/** The Pack modules a file imports by path. */
const packImports = (file: string): ReadonlyArray<string> => importSpecifiers(readFileSync(file, 'utf8'))
  .filter(specifier => specifier.startsWith('.'))
  .map(specifier => resolve(dirname(file), specifier))
  .filter(target => target.startsWith(`${packs}/`))
  .map(target => relative(src, target))

interface PackImportException {
  /** The Pack modules the file may import, and nothing else of a Pack. */
  readonly allows: ReadonlyArray<string>
  readonly until: string
  readonly why: string
  /** Set where the file lands on main later than this rule: the exception then waits for it. */
  readonly landsWith?: string
}

const packImportExceptions: Readonly<Record<string, PackImportException>> = {
  'features/study-views/read-profile.ts': {
    allows: [
      'packs/process-plant/displays/composition.ts',
      'packs/process-plant/queries/composed-display-query.ts',
      'packs/process-plant/displays/compose.ts',
      'packs/process-plant/displays/trend-reading.ts',
    ],
    until: 'the swap (plan v3.1 §2.10, §7): its study kind becomes a display spec by value',
    why: 'Synopticon\'s study views read the plant display state and sample schemas',
    landsWith: 'Synopticon (D3)',
  },
}

const offendersIn = (files: ReadonlyArray<string>): ReadonlyArray<string> => files.flatMap(file => {
  const own = relative(src, file)
  const allowed = packImportExceptions[own]?.allows ?? []
  return packImports(file).filter(target => !allowed.includes(target)).map(target => `${own} -> ${target}`)
})

/** Pack ids and the words that belong to a Pack's own domain (plan v4: no pack ids or pack words in World display code). */
const PACK_WORDS: ReadonlyArray<string> = [
  ...readdirSync(packs).filter(name => statSync(join(packs, name)).isDirectory()),
  'plant', 'reactor', 'reaktor', 'loop', 'pump', 'turbine', 'feedwater', 'halden', 'sg',
]
const packWords = (source: string): ReadonlyArray<string> =>
  [...source.toLowerCase().matchAll(new RegExp(`(?<![\\w-])(${PACK_WORDS.join('|')})(?![\\w-])`, 'g'))].map(match => match[1]!)

/**
 * A pixel constant in features/displays, read narrowly from the code, comments
 * aside: a CSS pixel length, in a string too ('12px', `${size}px`); a name
 * ending in Px, PX, Pixel or Pixels; or a size from the profile added to,
 * scaled by or compared with a literal other than 0, 1, 2 and 0.5 (halves and
 * doubles of a profile size are geometry, not constants), strings aside.
 */
const SIZE_NAME = String.raw`[A-Za-z_$.]*(?:[Oo]utline|[Gg]rid|[Cc]ell|[Pp]itch|[Cc]learance|[Mm]argin|[Rr]adius|[Gg]ap|[Ww]idth|[Hh]eight|[Ii]nset|[Pp]adding|[Ss]pacing|[Ss]ize|[Ss]tep)\b`
const LITERAL = String.raw`(\d+(?:\.\d+)?)`
const pixelPatterns: ReadonlyArray<{ readonly kind: string; readonly pattern: RegExp; readonly literal?: true; readonly inStrings?: true }> = [
  { kind: 'CSS pixel length', pattern: /\b\d+(?:\.\d+)?px\b|\}px\b/g, inStrings: true },
  { kind: 'pixel name', pattern: /\b\w*(?:Px|PX|Pixels?)\b/g },
  { kind: 'size and literal', pattern: new RegExp(`${SIZE_NAME}\\s*[-+*/]\\s*${LITERAL}`, 'g'), literal: true },
  { kind: 'literal and size', pattern: new RegExp(`${LITERAL}\\s*[-+*]\\s*${SIZE_NAME}`, 'g'), literal: true },
  { kind: 'size against literal', pattern: new RegExp(`${SIZE_NAME}\\s*[<>]=?\\s*${LITERAL}`, 'g'), literal: true },
]
const GEOMETRY_LITERALS: ReadonlySet<string> = new Set(['0', '1', '2', '0.5'])

/** A line without its comment, null for a comment line; with `strings: false` its quoted strings emptied too. Template text stays: its interpolations are code. */
const codeOf = (line: string, strings: boolean): string | null => {
  const trimmed = line.trim()
  if (trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('//')) return null
  const code = line.replace(/\s\/\/.*$/, '')
  return strings ? code : code.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, '\'\'')
}

const pixelMatches = (line: string): ReadonlyArray<{ readonly kind: string; readonly text: string }> => pixelPatterns.flatMap(({ kind, pattern, literal, inStrings }) =>
  [...(codeOf(line, inStrings === true) ?? '').matchAll(pattern)]
    .filter(match => literal !== true || !GEOMETRY_LITERALS.has(match[1]!))
    .map(match => ({ kind, text: match[0] })))

const pixelConstants = (file: string): ReadonlyArray<string> => readFileSync(file, 'utf8').split('\n')
  .flatMap((line, index) => pixelMatches(line).map(({ kind, text }) => `${relative(src, file)}:${index + 1} ${kind}: ${text}`))

describe('display boundaries (plan v3.1 §2.10)', () => {
  test('scan the trees the rules name; every exception names a file present, or one that lands later', () => {
    expect(sourcesUnder('features/displays').map(file => relative(src, file))).toContain('features/displays/diagram/channels.ts')
    expect(sourcesUnder('features').map(file => relative(src, file))).toContain('features/procedures/pack-observations.ts')
    expect(Object.entries(packImportExceptions).filter(([file, exception]) => exception.landsWith === undefined && !existsSync(join(src, file))).map(([file]) => file)).toEqual([])
  })

  test('1. features/displays imports no Pack', () => {
    expect(offendersIn(sourcesUnder('features/displays'))).toEqual([])
  })

  test('2. no World feature imports a Pack, beyond its dated exceptions', () => {
    expect(offendersIn(sourcesUnder('features'))).toEqual([])
  })

  test('3. ui/displays imports no Pack (it holds nothing yet: the rule waits for it)', () => {
    expect(offendersIn(sourcesUnder('ui/displays'))).toEqual([])
  })

  test('4. features/displays holds no pixel constants', () => {
    expect(sourcesUnder('features/displays').flatMap(pixelConstants)).toEqual([])
  })

  test('5. ui/embed/vignette imports no Pack and names no Pack', () => {
    const files = sourcesUnder('ui/embed/vignette')
    expect(files.map(file => relative(src, file))).toContain('ui/embed/vignette/Vignette.svelte')
    expect(offendersIn(files)).toEqual([])
    expect(files.flatMap(file => packWords(readFileSync(file, 'utf8')).map(word => `${relative(src, file)}: ${word}`))).toEqual([])
  })

  test('the Pack-word rule catches what it names', () => {
    expect(packWords('const id = \'process-plant\' // the reactor loop')).toEqual(['process-plant', 'reactor', 'loop'])
    expect(packWords('a unit of measure on a 24 px grid; electric-ac and steam media')).toEqual([])
  })

  test('the pixel rule catches what it names', () => {
    const probe = (line: string): ReadonlyArray<string> => pixelMatches(line).map(match => match.text)
    expect(probe('const width = `${size}px`')).toEqual(['}px'])
    expect(probe('el.style.top = \'12px\'')).toEqual(['12px'])
    expect(probe('push(\'spacing\', `${across} px from ${name}`)')).toEqual([])
    expect(probe('const top = 12 + 4px')).toEqual(['4px'])
    expect(probe('const MAX_HEIGHT_PX = 960')).toEqual(['MAX_HEIGHT_PX'])
    expect(probe('const pad = profile.frameMargin + 3')).toEqual(['profile.frameMargin + 3'])
    expect(probe('const half = profile.grid / 2')).toEqual([])
    expect(probe('if (gap < 12) return')).toEqual(['gap < 12'])
    expect(probe('const spacing = outline + 4')).toEqual(['outline + 4'])
    expect(probe('const spacing = outline + profile.pipe.trackGap')).toEqual([])
    expect(probe('// a 24 px grid: profile.grid + 24')).toEqual([])
  })
})

// ELK runs on the server only (D6, elk-licence obligation 3; the built-UI scan
// is built-ui-scan.test.ts): network.ts is the one module of any app or package
// that imports elkjs, and no World UI module reaches it through value imports
// (type-only imports are erased from bundles, so they may name its types).
const NETWORK = join(src, 'features/displays/topology/network.ts')
const repository = join(root, '../..')
const valueImports = (source: string): ReadonlyArray<string> =>
  [...source.matchAll(/(?:import|export)(\s+type\s)?[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g)]
    .filter(match => match[1] === undefined).map(match => match[2] ?? match[3] ?? match[4]!)
const resolveModule = (from: string, specifier: string): string | undefined => {
  const target = resolve(dirname(from), specifier)
  return [target, `${target}.ts`, `${target}.js`, join(target, 'index.ts')].find(path => existsSync(path) && statSync(path).isFile())
}
/** The chain of value imports by which `start` reaches `goal`, or null. */
const importChain = (start: string, goal: string, seen: Set<string>): ReadonlyArray<string> | null => {
  if (start === goal) return [goal]
  if (seen.has(start) || !/\.(ts|js|svelte)$/.test(start)) return null
  seen.add(start)
  for (const specifier of valueImports(readFileSync(start, 'utf8')).filter(specifier => specifier.startsWith('.'))) {
    const next = resolveModule(start, specifier)
    const chain = next === undefined ? null : importChain(next, goal, seen)
    if (chain !== null) return [start, ...chain]
  }
  return null
}

describe('ELK stays on the server (D6)', () => {
  test('only features/displays/topology/network.ts imports elkjs, in every app and package', () => {
    const trees = ['apps/world/src', 'apps/agents/src', 'apps/leitbild/src', ...readdirSync(join(repository, 'packages')).map(name => `packages/${name}/src`)]
    const importers = trees.flatMap(tree => filesUnder(join(repository, tree)))
      .filter(file => /\.(ts|svelte)$/.test(file) && !file.includes('/dist/') && valueImports(readFileSync(file, 'utf8')).some(specifier => specifier === 'elkjs' || specifier.startsWith('elkjs/')))
      .map(file => relative(repository, file))
    expect(importers).toEqual([relative(repository, NETWORK)])
  })

  test('no World UI module reaches network.ts through value imports', () => {
    const seen = new Set<string>()
    const chains = filesUnder(join(src, 'ui')).filter(file => /\.(ts|svelte)$/.test(file) && !file.includes('/dist/'))
      .map(file => importChain(file, NETWORK, seen)).filter(chain => chain !== null).map(chain => chain.map(file => relative(src, file)).join(' -> '))
    expect(chains).toEqual([])
    expect(seen.size).toBeGreaterThan(100)
  })

  test('the ELK rule reads what it names', () => {
    expect(valueImports('import ELK, { type ElkNode } from \'elkjs/lib/elk-api.js\'')).toEqual(['elkjs/lib/elk-api.js'])
    expect(valueImports('import type { TopologyLayout } from \'../topology/network.ts\'')).toEqual([])
    expect(valueImports('export { networkLayout } from \'./network.ts\'\nconst x = await import(\'elkjs\')\nimport \'./side-effect.ts\'')).toEqual(['./network.ts', 'elkjs', './side-effect.ts'])
    const probe = join(src, 'features/displays/topology/probe.ts')
    expect(importChain(join(src, 'features/displays/topology/network.ts'), NETWORK, new Set())).toEqual([NETWORK])
    expect(resolveModule(probe, './network')).toBe(NETWORK)
  })
})
