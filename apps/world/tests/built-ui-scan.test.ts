import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { build, type Rolldown } from 'vite'
import { embedDrawnTags } from './openbridge-elements.ts'

// The built World UI (main app and embed) as the browser receives it, built in
// memory from vite.config.ts so the scan never reads a stale dist, once for
// every check below. ELK runs on the server only (D6, elk-licence obligation
// 3): none of its code reaches any chunk or asset. The marks: its package name,
// its copyright, the Java packages of its layout engine, and the API wrapper's
// own error (every entry includes it).
const root = join(import.meta.dir, '..')
let building: Promise<ReadonlyArray<Rolldown.RolldownOutput>> | null = null
const built = (): Promise<ReadonlyArray<Rolldown.RolldownOutput>> => building ??= build({ configFile: join(root, 'vite.config.ts'), logLevel: 'silent', build: { write: false, emptyOutDir: false } })
  .then(result => (Array.isArray(result) ? result : [result]) as ReadonlyArray<Rolldown.RolldownOutput>)

const builtFiles = async (): Promise<ReadonlyArray<{ readonly name: string; readonly text: string }>> => (await built()).flatMap(output => output.output.map(file => ({
  name: file.fileName,
  text: file.type === 'chunk' ? file.code : typeof file.source === 'string' ? file.source : new TextDecoder().decode(file.source),
})))

/** The chunks a page's entry loads, statically or lazily. */
const chunksOf = async (page: string): Promise<ReadonlyArray<Rolldown.OutputChunk>> => {
  const chunks = (await built()).flatMap(output => output.output.filter((file): file is Rolldown.OutputChunk => file.type === 'chunk'))
  const byName = new Map(chunks.map(chunk => [chunk.fileName, chunk]))
  const entry = chunks.find(chunk => chunk.isEntry && chunk.facadeModuleId?.endsWith(`/src/ui/${page}`) === true)
  if (entry === undefined) throw new Error(`no entry chunk for ${page}`)
  const reached = new Map<string, Rolldown.OutputChunk>()
  const pending = [entry]
  while (pending.length > 0) {
    const chunk = pending.pop()!
    if (reached.has(chunk.fileName)) continue
    reached.set(chunk.fileName, chunk)
    pending.push(...[...chunk.imports, ...chunk.dynamicImports].flatMap(name => byName.get(name) ?? []))
  }
  return [...reached.values()]
}

describe('built World UI', () => {
  // A whole World UI build takes about 3.5 s on a quiet machine; the wall-clock timeouts are sized for a loaded one.
  test('carries no ELK in any chunk or asset', async () => {
    const files = await builtFiles()
    expect(files.some(file => file.name.endsWith('.js'))).toBe(true)
    expect(files.flatMap(file => ['elkjs', 'Kiel University', 'org.eclipse.elk', 'Cannot construct an ELK'].filter(mark => file.text.includes(mark)).map(mark => `${file.name}: ${mark}`))).toEqual([])
  }, 120_000)

  // A source can import an element's module bare (openbridge-usage.test.ts) and the
  // bundler still drop it, should OpenBridge ever declare its modules free of side
  // effects: the built embed must define each element itself. A definition is its
  // class decorated with the tag, `[x(\`obc-…\`)]`; a mere use is not.
  test('defines every OpenBridge element the embedded view draws in a chunk the embed loads', async () => {
    const code = (await chunksOf('embed.html')).map(chunk => chunk.code).join('\n')
    const tags = [...new Set(embedDrawnTags.map(drawn => drawn.tag))].sort()
    expect(tags).toContain('obc-heat-exchanger')
    expect(tags.filter(tag => !new RegExp(`\\[[A-Za-z_$][\\w$]*\\(\`${tag}\`\\)\\]`).test(code))).toEqual([])
  }, 120_000)

  test('keeps OpenBridge out of every chunk the World application loads (D-03: embed bundles only)', async () => {
    const chunks = await chunksOf('index.html')
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.flatMap(chunk => chunk.moduleIds.filter(id => id.includes('/@oicl/')).map(id => `${chunk.fileName}: ${id.slice(id.indexOf('/@oicl/') + 1)}`))).toEqual([])
  }, 120_000)

  // World serves everything under assets/world as immutable (server.ts staticCacheControl):
  // the build names each file there by its content hash, and its only other files are the two pages.
  test('names every file it builds under assets/world by its content hash, and builds nothing else but the two pages', async () => {
    const names = (await builtFiles()).map(file => file.name)
    expect(names).toContain('index.html')
    expect(names).toContain('embed.html')
    expect(names.filter(name => name !== 'index.html' && name !== 'embed.html' && !/^assets\/world\/[^/]+-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/.test(name))).toEqual([])
  }, 120_000)

  test('names every public file it copies, unhashed, into assets/world by the hash of its own bytes', () => {
    const publicDir = join(root, 'src', 'ui', 'public')
    const files = readdirSync(publicDir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
      .map(entry => relative(publicDir, join(entry.parentPath, entry.name))).filter(file => file.startsWith('assets/world/'))
    expect(files.length).toBeGreaterThan(0)
    expect(files.filter(file => !file.endsWith(`.${createHash('sha256').update(readFileSync(join(publicDir, file))).digest('hex').slice(0, 8)}${extname(file)}`))).toEqual([])
  })
})
