import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { newWorkspaceId } from '@leitbild/contracts'

test('SIGTERM checkpoints a running Weather scenario and restores it without clock regression', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'world-process-shutdown-'))
  let child: ReturnType<typeof Bun.spawn> | undefined
  const start = async (): Promise<string> => {
    const proc = Bun.spawn([process.execPath, 'run', 'src/index.ts'], {
      cwd: resolve(import.meta.dir, '..'),
      env: { ...process.env, PORT: '0', LEITBILD_BIND_HOST: '127.0.0.1', LEITBILD_DATA_DIR: dataDir, LEITBILD_ROUTING_PROVIDER: 'direct', WORKSPACE_HOST_URL: 'http://host.test' },
      stdout: 'pipe', stderr: 'pipe',
    })
    child = proc
    const reader = proc.stdout.getReader()
    let output = ''
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) throw new Error(`World exited before listening: ${output}`)
        output += new TextDecoder().decode(value)
        const match = output.match(/Leitbild running at http:\/\/localhost:(\d+)/)
        if (match) return `http://127.0.0.1:${match[1]}`
      }
    } finally { reader.releaseLock() }
  }
  try {
    let origin = await start()
    const workspaceId = newWorkspaceId()
    const root = `/internal/workspaces/${workspaceId}`
    expect((await fetch(origin + root, { method: 'PUT', body: JSON.stringify({ workspaceId }), headers: { 'Content-Type': 'application/json' } })).status).toBe(201)
    const catalog = await (await fetch(origin + root + '/definitions')).json() as { definitions: Array<{ ref: object; currentRevisionId: string; title: string }> }
    const definition = catalog.definitions.find(item => item.title === 'Halden weather response')!
    const invoke = (capabilityId: string, target: object) => fetch(`${origin}${root}/capabilities/${capabilityId}/invoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, capabilityId, ...target, input: {}, access: { workspaceId, requestId: crypto.randomUUID(), actor: { kind: 'human' }, client: { id: 'shutdown-test', kind: 'service' } } }),
    })
    const started = await invoke('world.scenario.start', { definition: { ...definition.ref, revisionId: definition.currentRevisionId } })
    expect(started.status).toBe(201)
    const runId = (await started.json() as { result: { id: string } }).result.id
    const resource = { workspaceId, moduleId: 'world', type: 'world.simulation-run', id: runId }
    await Bun.sleep(1200) // Cross a real Weather mechanics tick before signalling.
    child!.kill('SIGTERM')
    expect(await child!.exited).toBe(0)
    origin = await start()
    const restored = await invoke('world.simulation-run.context', { resource })
    expect(restored.status).toBe(200)
    const context = await restored.json() as { result: { objects: { total: number }; situation: { runtimeHealth: Array<{ state: string }> } } }
    expect(context.result.objects.total).toBeGreaterThan(0)
    expect(context.result.situation.runtimeHealth.every(health => health.state === 'ready')).toBe(true)
    child!.kill('SIGTERM')
    expect(await child!.exited).toBe(0)
  } finally {
    if (child && child.exitCode === null) { child.kill('SIGKILL'); await child.exited }
    await rm(dataDir, { recursive: true, force: true })
  }
}, 120_000)
