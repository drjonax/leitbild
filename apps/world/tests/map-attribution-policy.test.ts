import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// The base map's OpenStreetMap, OpenMapTiles and Natural Earth credit belongs on every map display.

const root = join(import.meta.dir, '..')

const filesUnder = (dir: string): ReadonlyArray<string> => readdirSync(dir).flatMap(name => {
  const path = join(dir, name)
  if (statSync(path).isDirectory()) return name === 'dist' ? [] : filesUnder(path)
  return /\.(ts|svelte)$/.test(name) ? [path] : []
})

const uiFiles = filesUnder(join(root, 'src/ui'))

describe('map attribution policy', () => {
  test('scans the map components', () => {
    const scanned = uiFiles.map(file => relative(root, file))
    expect(scanned).toContain('src/ui/ScenarioBuilderMap.svelte')
    expect(scanned).toContain('src/ui/map-runtime/map-runtime.ts')
  })

  test('no map in the World UI turns its attribution control off', () => {
    const offenders = uiFiles.filter(file => /attributionControl\s*:\s*false/.test(readFileSync(file, 'utf8'))).map(file => relative(root, file))
    expect(offenders).toEqual([])
  })

  test('the scenario editor map keeps a compact credit', () => {
    expect(readFileSync(join(root, 'src/ui/ScenarioBuilderMap.svelte'), 'utf8')).toMatch(/attributionControl:\s*\{\s*compact:\s*true\s*\}/)
  })
})
