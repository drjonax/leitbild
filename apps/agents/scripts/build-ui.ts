import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const uiRoot = join(import.meta.dir, '..', 'src', 'ui')
const outdir = join(uiRoot, 'dist')

await rm(outdir, { recursive: true, force: true })
await mkdir(outdir, { recursive: true })

const result = await Bun.build({
  entrypoints: [join(uiRoot, 'modules', 'app.ts')],
  outdir,
  target: 'browser',
  format: 'esm',
  minify: true,
  splitting: true,
  naming: { entry: 'app.js', chunk: 'chunk-[hash].js', asset: 'asset-[name]-[hash].[ext]' },
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

const entry = result.outputs.find(output => output.kind === 'entry-point' && output.path.endsWith('.js'))
if (!entry) throw new Error('Agents UI build did not produce a JavaScript entry point')
if (entry.path !== join(outdir, 'app.js')) throw new Error(`Unexpected Agents UI entry path: ${entry.path}`)

const sourceHtml = await readFile(join(uiRoot, 'index.html'), 'utf8')
await writeFile(join(outdir, 'index.html'), sourceHtml)
