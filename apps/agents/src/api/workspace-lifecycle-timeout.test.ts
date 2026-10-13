import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newWorkspaceId } from '@leitbild/contracts'

// Bun drops a request idle for 10 s only while its process is otherwise busy,
// as a live Agents Module is; so the server runs in its own process.
test('a Workspace removal that takes longer than Bun\'s 10 s idle limit still answers the Host', async () => {
  const uiPath = await mkdtemp(join(tmpdir(), 'agents-slow-remove-'))
  const child = Bun.spawn([process.execPath, join(import.meta.dir, '__fixtures__', 'slow-workspace-removal.ts'), uiPath], { stdout: 'pipe', stderr: 'inherit' })
  try {
    const reader = child.stdout.getReader()
    let output = ''
    while (!/port=\d+/.test(output)) {
      const { value, done } = await reader.read()
      if (done) throw new Error(`Fixture exited before listening: ${output}`)
      output += new TextDecoder().decode(value)
    }
    const port = Number(/port=(\d+)/.exec(output)![1])
    const response = await fetch(`http://127.0.0.1:${port}/internal/workspaces/${newWorkspaceId()}`, { method: 'DELETE' })
    expect(response.status).toBe(204)
  } finally { child.kill(); await child.exited; await rm(uiPath, { recursive: true, force: true }) }
}, 60_000)
