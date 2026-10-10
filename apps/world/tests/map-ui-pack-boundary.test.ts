import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// Generic map UI consumes Pack presentation protocols (apps/world/AGENTS.md):
// it must not import Pack modules or special-case a Pack or dataset by id.

const root = join(import.meta.dir, '..')

const filesUnder = (dir: string): ReadonlyArray<string> => readdirSync(dir).flatMap(name => {
  const path = join(dir, name)
  return statSync(path).isDirectory() ? filesUnder(path) : [path]
})

const genericMapDirectories = ['src/ui/map', 'src/ui/map-runtime'].map(dir => join(root, dir))
const genericMapFiles = [
  ...genericMapDirectories.flatMap(filesUnder),
  ...['src/ui/OperationalMap.svelte', 'src/ui/RailLayerGroupSection.svelte', 'src/ui/ControlRail.svelte'].map(file => join(root, file)),
  ...filesUnder(join(root, 'src/core/packs')),
].filter(file => /\.(ts|svelte)$/.test(file))

const importSpecifiers = (source: string): ReadonlyArray<string> =>
  [...source.matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1] ?? match[2]!)

describe('generic map UI Pack boundary', () => {
  test('scans the expected files', () => {
    expect(genericMapFiles.map(file => relative(root, file))).toContain('src/ui/map/reference-data-controller.ts')
    expect(genericMapFiles.map(file => relative(root, file))).toContain('src/ui/OperationalMap.svelte')
  })

  test('map UI modules import no Pack implementation', () => {
    const offenders = genericMapDirectories.flatMap(filesUnder).flatMap(file =>
      importSpecifiers(readFileSync(file, 'utf8'))
        .filter(specifier => /(^|\/)packs\//.test(specifier) && !/(^|\/)core\/packs\//.test(specifier))
        .map(specifier => `${relative(root, file)} -> ${specifier}`))
    expect(offenders).toEqual([])
  })

  test('generic map UI and Pack protocols name no grid Pack or dataset', () => {
    const offenders = genericMapFiles.filter(file => /electric-grid|grid-norway/.test(readFileSync(file, 'utf8'))).map(file => relative(root, file))
    expect(offenders).toEqual([])
  })
})
