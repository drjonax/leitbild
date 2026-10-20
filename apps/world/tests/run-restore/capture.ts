/** Captures a saved Run from a local stack's World data directory as a T03 fixture: every file of the Run gzipped,
 * except its Historian database. The Run must be paused and unloaded first (the stack closes idle Runs).
 *   bun tests/run-restore/capture.ts <world data dir> <workspaceId> <runId> <fixture name> <scenarioId> <commit> "<how it was made>" */
import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { FIXTURE_ROOT } from './fixture-runs.ts'

const [dataDir, workspaceId, runId, name, scenarioId, commit, how] = Bun.argv.slice(2)
if (!dataDir || !workspaceId || !runId || !name || !scenarioId || !commit || !how) throw new Error('Usage: capture.ts <world data dir> <workspaceId> <runId> <name> <scenarioId> <commit> "<how>"')
const source = join(dataDir, 'workspaces', workspaceId, 'world', 'simulation-runs', runId)
const target = join(FIXTURE_ROOT, name)
let bytes = 0
for (const entry of await readdir(source, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || entry.name.startsWith('history.sqlite')) continue
  const relative = join(entry.parentPath.slice(source.length), entry.name)
  const zipped = Bun.gzipSync(new Uint8Array(await Bun.file(join(entry.parentPath, entry.name)).arrayBuffer()), { level: 9 })
  await mkdir(join(target, 'run', relative, '..'), { recursive: true })
  await Bun.write(join(target, 'run', `${relative}.gz`), zipped)
  bytes += zipped.byteLength
}
await Bun.write(join(target, 'meta.json'), JSON.stringify({ workspaceId, runId, scenarioId, capturedAt: new Date().toISOString(), commit, how }, null, 2) + '\n')
console.log(`Captured ${runId} as ${name}: ${bytes} bytes gzipped`)
