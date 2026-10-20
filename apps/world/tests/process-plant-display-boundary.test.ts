import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

// Plant operations, queries and the map projection are plant model code:
// displays read them, never the other way round (plan v3.1 §2.10, T29). They
// import nothing from displays/, directly or through the modules they import.
// One dated exception: the plant display Capability's own query, which the
// swap deletes with the plant display Capabilities.

const root = join(import.meta.dir, '..')
const plant = join(root, 'src/packs/process-plant')
const displays = join(plant, 'displays')

const exceptions: Readonly<Record<string, string>> = {
  'src/packs/process-plant/queries/composed-display-query.ts': 'the plant display Capability\'s query, until the swap deletes it (plan v3.1 §2.10, lead ruling 20 Oct 2026)',
}

const filesUnder = (dir: string): ReadonlyArray<string> => readdirSync(dir).flatMap(name => {
  const path = join(dir, name)
  return statSync(path).isDirectory() ? filesUnder(path) : [path]
})

const roots = [
  ...filesUnder(join(plant, 'operations')),
  ...filesUnder(join(plant, 'queries')),
  join(plant, 'projection.ts'),
].filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts') && exceptions[relative(root, file)] === undefined)

const importSpecifiers = (source: string): ReadonlyArray<string> =>
  [...source.matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1] ?? match[2]!)

/** The files a module imports by relative path; packages and aliases lie outside the Plant's code. */
const relativeImports = (file: string): ReadonlyArray<string> =>
  importSpecifiers(readFileSync(file, 'utf8')).filter(specifier => specifier.startsWith('.')).map(specifier => resolve(dirname(file), specifier))

const inDisplays = (file: string): boolean => file.startsWith(`${displays}/`)

describe('process-plant display boundary', () => {
  test('scans operations, queries and the projection, and every exception still names a file', () => {
    const scanned = roots.map(file => relative(root, file))
    expect(scanned).toEqual(expect.arrayContaining([
      'src/packs/process-plant/operations/controls.ts',
      'src/packs/process-plant/operations/instance-ports.ts',
      'src/packs/process-plant/queries/graph-query.ts',
      'src/packs/process-plant/projection.ts',
    ]))
    expect(Object.keys(exceptions).filter(file => !existsSync(join(root, file)))).toEqual([])
  })

  test('operations, queries and the projection import nothing from displays/', () => {
    const offenders = roots.flatMap(file => relativeImports(file).filter(inDisplays).map(target => `${relative(root, file)} -> ${relative(root, target)}`))
    expect(offenders).toEqual([])
  })

  test('nor do the modules they import, however far', () => {
    // Breadth first, so each display module reached is named by the shortest chain to it; nothing is followed past one.
    const reached = new Map<string, string>()
    const pending = roots.map(file => ({ file, chain: relative(root, file) }))
    while (pending.length > 0) {
      const { file, chain } = pending.shift()!
      if (reached.has(file) || !file.endsWith('.ts') || exceptions[relative(root, file)] !== undefined) continue
      reached.set(file, chain)
      if (inDisplays(file)) continue
      for (const target of relativeImports(file)) if (!reached.has(target)) pending.push({ file: target, chain: `${chain} -> ${relative(root, target)}` })
    }
    const offenders = [...reached].filter(([file]) => inDisplays(file)).map(([, chain]) => chain)
    expect(offenders).toEqual([])
  })
})
