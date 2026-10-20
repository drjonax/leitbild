/**
 * T03 (plan v3.1 Appendix F): saved Runs captured from a local stack at
 * bacf7a115, restored by today's code. A fixture is a Run directory as World
 * persisted it, every file gzipped, without its Historian database (Historian
 * v1 is frozen; restore is about the Run's own state). meta.json names the
 * Workspace and Run the files belong to.
 */
import { mkdir, mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface FixtureRunMeta {
  readonly workspaceId: string
  readonly runId: string
  readonly scenarioId: string
  readonly capturedAt: string
  readonly commit: string
  readonly how: string
}

export const FIXTURE_ROOT = join(import.meta.dir, '../fixtures/run-restore')

export const readFixtureMeta = async (name: string): Promise<FixtureRunMeta> => Bun.file(join(FIXTURE_ROOT, name, 'meta.json')).json()

/** The fixture's files, unzipped, in a fresh World data directory at the path World keeps that Run. */
export const unpackFixtureRun = async (name: string): Promise<{ readonly dataDir: string; readonly runDir: string; readonly meta: FixtureRunMeta }> => {
  const meta = await readFixtureMeta(name)
  const dataDir = await mkdtemp(join(tmpdir(), `leitbild-restore-${name}-`))
  const runDir = join(dataDir, 'workspaces', meta.workspaceId, 'world', 'simulation-runs', meta.runId)
  const source = join(FIXTURE_ROOT, name, 'run')
  for (const entry of await readdir(source, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.gz')) continue
    const relative = join(entry.parentPath.slice(source.length), entry.name.slice(0, -'.gz'.length))
    await mkdir(join(runDir, relative, '..'), { recursive: true })
    await Bun.write(join(runDir, relative), Bun.gunzipSync(new Uint8Array(await Bun.file(join(entry.parentPath, entry.name)).arrayBuffer())))
  }
  return { dataDir, runDir, meta }
}
