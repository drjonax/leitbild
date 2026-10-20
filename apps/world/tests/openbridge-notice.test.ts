import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { build, type Rollup } from 'vite'
import { fromOpenBridge, LEITBILD_SOURCE_URL, openBridgeNotice } from '../src/ui/embed/openbridge-notice.ts'

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
})
