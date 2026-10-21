import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { build, mergeConfig, type Rollup } from 'vite'
import { fromOpenBridge, LEITBILD_SOURCE_URL, openBridgeNotice } from '../src/ui/embed/openbridge-notice.ts'
import { worldUiConfig } from '../vite.config.ts'

const packages = [
  { name: '@oicl/openbridge-webcomponents', version: '2.0.0' },
  { name: '@oicl/connector-diagram', version: '1.0.0' },
]

describe('the OpenBridge licence notice', () => {
  test('names each bundled package and version, the AGPL and where the corresponding source is', () => {
    const notice = openBridgeNotice(packages)
    expect(notice.startsWith('/*!')).toBe(true)
    expect(notice.endsWith('*/')).toBe(true)
    expect(notice).toContain('@oicl/openbridge-webcomponents 2.0.0, @oicl/connector-diagram 1.0.0')
    expect(notice).toContain('AGPL-3.0-only')
    expect(notice).toContain(LEITBILD_SOURCE_URL)
    expect(notice.slice(3, -2)).not.toContain('*/')
    expect(() => openBridgeNotice([])).toThrow('names no package')
  })

  test('heads every emitted embed script and stylesheet with OpenBridge code, and only those', async () => {
    // The embed entry as production builds it, in memory.
    const output = await build({
      configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
      logLevel: 'silent',
      build: {
        write: false,
        emptyOutDir: false,
        rollupOptions: { input: { embed: fileURLToPath(new URL('../src/ui/embed.html', import.meta.url)) } },
      },
    }) as Rollup.RollupOutput | ReadonlyArray<Rollup.RollupOutput>
    const files = (Array.isArray(output) ? output : [output]).flatMap(result => result.output)
    const chunks = files.filter((file): file is Rollup.OutputChunk => file.type === 'chunk')
    const withOpenBridge = chunks.filter(chunk => chunk.moduleIds.some(fromOpenBridge))
    expect(withOpenBridge.length).toBeGreaterThan(0)
    const headed = (text: string): boolean => text.startsWith('/*! This file contains OpenBridge web components (@oicl/openbridge-webcomponents ')
    expect(chunks.filter(chunk => headed(chunk.code) !== chunk.moduleIds.some(fromOpenBridge)).map(chunk => chunk.fileName)).toEqual([])
    const stylesheets = new Set(withOpenBridge.flatMap(chunk => [...((chunk as Rollup.OutputChunk & { viteMetadata?: { importedCss: Set<string> } }).viteMetadata?.importedCss ?? [])]))
    expect(stylesheets.size).toBeGreaterThan(0)
    for (const fileName of stylesheets) {
      const asset = files.find(file => file.fileName === fileName)
      expect(asset?.type).toBe('asset')
      expect(headed(String((asset as Rollup.OutputAsset).source))).toBe(true)
    }
  }, 120_000)

  // World serves assets/world immutable (server.ts staticCacheControl), so a file's name must
  // say its final bytes: two embed builds whose notices differ share no name with different bytes.
  test('names every file the notice changes anew when the notice changes', async () => {
    const embedBuild = async (notice: ReadonlyArray<{ readonly name: string; readonly version: string }>): Promise<ReadonlyMap<string, string>> => {
      const config = mergeConfig(worldUiConfig(notice), { configFile: false, logLevel: 'silent', build: { write: false, emptyOutDir: false } })
      config.build!.rollupOptions!.input = { embed: fileURLToPath(new URL('../src/ui/embed.html', import.meta.url)) }
      const output = await build(config) as Rollup.RollupOutput | ReadonlyArray<Rollup.RollupOutput>
      return new Map((Array.isArray(output) ? output : [output]).flatMap(result => result.output)
        .map(file => [file.fileName, file.type === 'chunk' ? file.code : String(file.source)] as const))
    }
    const before = await embedBuild(packages)
    const after = await embedBuild([{ ...packages[0]!, version: '2.0.1' }, packages[1]!])
    const noticed = [...before].filter(([, text]) => text.includes('@oicl/openbridge-webcomponents 2.0.0')).map(([name]) => name)
    expect(noticed.some(name => name.endsWith('.js'))).toBe(true)
    expect(noticed.some(name => name.endsWith('.css'))).toBe(true)
    expect(noticed.filter(name => after.has(name))).toEqual([])
    expect([...before].filter(([name, text]) => name !== 'embed.html' && after.has(name) && after.get(name) !== text).map(([name]) => name)).toEqual([])
    // The page, which revalidates, links each stylesheet under its headed name; every file it links is built.
    for (const [files, version] of [[before, '2.0.0'], [after, '2.0.1']] as const) {
      const linked = [...files.get('embed.html')!.matchAll(/(?:href|src)="\/(assets\/world\/[^"]+)"/g)].map(match => match[1]!)
      expect(linked.filter(name => !files.has(name))).toEqual([])
      const stylesheets = linked.filter(name => name.endsWith('.css'))
      expect(stylesheets.length).toBeGreaterThan(0)
      expect(stylesheets.filter(name => !files.get(name)!.startsWith(`/*! This file contains OpenBridge web components (@oicl/openbridge-webcomponents ${version}`))).toEqual([])
    }
  }, 240_000)
})
