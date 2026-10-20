import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { build, type Rolldown } from 'vite'

// The built World UI (main app and embed) as the browser receives it, built in
// memory from vite.config.ts so the scan never reads a stale dist. ELK runs on
// the server only (D6, elk-licence obligation 3): none of its code reaches any
// chunk or asset. The marks: its package name, its copyright, the Java packages
// of its layout engine, and the API wrapper's own error (every entry includes it).
const root = join(import.meta.dir, '..')
const builtFiles = async (): Promise<ReadonlyArray<{ readonly name: string; readonly text: string }>> => {
  const result = await build({ configFile: join(root, 'vite.config.ts'), logLevel: 'silent', build: { write: false, emptyOutDir: false } })
  const outputs = (Array.isArray(result) ? result : [result]) as ReadonlyArray<Rolldown.RolldownOutput>
  return outputs.flatMap(output => output.output.map(file => ({
    name: file.fileName,
    text: file.type === 'chunk' ? file.code : typeof file.source === 'string' ? file.source : new TextDecoder().decode(file.source),
  })))
}

describe('built World UI', () => {
  test('carries no ELK in any chunk or asset', async () => {
    const files = await builtFiles()
    expect(files.some(file => file.name.endsWith('.js'))).toBe(true)
    expect(files.flatMap(file => ['elkjs', 'Kiel University', 'org.eclipse.elk', 'Cannot construct an ELK'].filter(mark => file.text.includes(mark)).map(mark => `${file.name}: ${mark}`))).toEqual([])
  }, 300_000)
})
