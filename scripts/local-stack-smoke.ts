import { workspaceResourceCatalogSchema } from '../packages/contracts/src/index.ts'

/** Deterministic integration smoke, not a numerical, maps or LLM qualification.
 * Every operation goes through the public proxy and real production services. */
export const smokeLocalStack = async (origin: string): Promise<void> => {
  const firstFrame = (path: string): Promise<any> => new Promise((resolve, reject) => {
    const socket = new WebSocket(`${origin.replace('http:', 'ws:')}${path}`)
    const timer = setTimeout(() => finish(new Error('WebSocket readiness timed out')), 5_000)
    const finish = (error?: Error, value?: unknown) => { clearTimeout(timer); socket.close(); error ? reject(error) : resolve(value) }
    socket.addEventListener('error', () => finish(new Error('WebSocket failed')))
    socket.addEventListener('message', event => {
      try { finish(undefined, JSON.parse(String(event.data))) }
      catch (error) { finish(error as Error) }
    }, { once: true })
  })
  const request = async (path: string, body?: unknown, method = body ? 'POST' : 'GET'): Promise<any> => {
    const response = await fetch(`${origin}${path}`, {
      method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
      signal: AbortSignal.timeout(30_000),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`)
    return text ? JSON.parse(text) : undefined
  }
  await request('/health')
  const knowledge = await request('/api/knowledge/read?path=index.md')
  if (!knowledge.content) throw new Error('Knowledge read returned no content')
  const { workspace } = await request('/api/workspaces', { name: 'Local stack smoke' })
  const base = `/api/workspaces/${workspace.id}`
  const invoke = (id: string, body: unknown) => request(`${base}/capabilities/${id}/invoke`, body)
  try {
    if (workspace.modules.length !== 2 || workspace.modules.some((module: { status: string }) => module.status !== 'ready')) throw new Error('Core Modules were not provisioned')
    const catalog = await request(`${base}/capabilities`)
    if (!catalog.capabilities.some((capability: { id: string }) => capability.id === 'agents.assistance.open')) throw new Error('Agents discovery unavailable')
    const authored = await invoke('world.scenario.create', { input: { source: {
      id: 'local-stack-weather', title: 'Local stack weather',
      packs: [{ id: 'weather', items: [{ type: 'weather_probe', id: 'weather:local', label: 'Local weather', point: [10.75, 59.91] }] }],
      world: { startsAt: '2026-01-01T12:00:00Z' }, view: { map: { center: [10.75, 59.91], zoom: 8 } },
    } } })
    const started = await invoke('world.scenario.start', { definition: authored.result.definition, input: {} })
    const resource = { workspaceId: workspace.id, moduleId: 'world', type: 'world.simulation-run', id: started.result.id }
    await invoke('world.simulation-run.execution.set', { resource, input: { playback: 'paused' } })
    const before = (await invoke('world.simulation-run.execution.read', { resource, input: {} })).result
    if (before.playback !== 'paused' || !Number.isFinite(Date.parse(before.currentSimulationTime))) throw new Error('Run execution unavailable')
    const context = (await invoke('world.simulation-run.context', { resource, input: {} })).result
    if (!context) throw new Error('Run context unavailable')
    const ready = await firstFrame(`${base}/world/ws?simulationRun=${resource.id}`)
    if (ready.type !== 'realtime.ready' || ready.simulationRunId !== resource.id || ready.workspaceId !== workspace.id) throw new Error('Wrong World WebSocket scope/readiness')
    const resources = workspaceResourceCatalogSchema.parse(await request(`${base}/resources`)).resources
    const family = resources.find(item => item.ref.type === 'world.run-family' && item.links.some(link => link.rel === 'contains' && link.ref.id === resource.id))
    if (!family) throw new Error('Run family was not discoverable')
    const assistance = await invoke('agents.assistance.open', {
      input: { scope: { kind: 'collection', collection: family.ref, members: { mode: 'all', except: [] } }, title: 'Local weather assistant', focusedSubjects: [resource] },
      actor: { kind: 'human', id: 'local-smoke', displayName: 'Local smoke' },
    })
    const roomId = assistance.result.resource.id
    const snapshot = await firstFrame(`${base}/agents/ws?room=${roomId}`)
    if (snapshot.type !== 'snapshot' || snapshot.rooms.length !== 1 || snapshot.rooms[0].id !== roomId || !snapshot.agents.some((agent: { kind: string }) => agent.kind === 'ai')) throw new Error('Assistant did not initialize in its scoped room')
    const copied = await invoke('world.simulation-run.copy', { resource, input: { name: 'Local weather copy' } })
    const copy = { ...resource, id: copied.result.id }
    const after = (await invoke('world.simulation-run.execution.read', { resource: copy, input: {} })).result
    if (after.playback !== 'paused' || after.currentSimulationTime !== before.currentSimulationTime) throw new Error('Copy did not preserve paused time')
    await invoke('world.simulation-run.delete', { resource: copy, input: {} })
    await invoke('world.simulation-run.delete', { resource, input: {} })
    const remaining = workspaceResourceCatalogSchema.parse(await request(`${base}/resources`))
    if (remaining.resources.some(item => item.ref.type === 'world.simulation-run')) throw new Error('Run deletion incomplete')
  } finally {
    await request(base, undefined, 'DELETE')
  }
  const list = await request('/api/workspaces')
  if (list.workspaces.some((item: { id: string }) => item.id === workspace.id)) throw new Error('Workspace deletion incomplete')
}
