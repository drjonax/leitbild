/** The few Host and World routes the display acceptance and performance scripts call on a loopback stack, as a
 * person's page calls them: Workspace Capabilities, Run presence, the display routes. */
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const actor = { kind: 'human', id: 'display-eval', displayName: 'Display evaluation' }

export const createStackApi = (origin: string, workspaceId: string) => {
  const request = async (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<any> => {
    const response = await fetch(origin + path, {
      method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
      signal: AbortSignal.timeout(600_000),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 600)}`)
    return text ? JSON.parse(text) : undefined
  }
  const ws = `/api/workspaces/${workspaceId}`
  const runPath = (runId: string, suffix = ''): string => `${ws}/world/simulation-runs/${encodeURIComponent(runId)}${suffix}`
  const ref = (id: string) => ({ workspaceId, moduleId: 'world', type: 'world.simulation-run', id })
  const invoke = (operationId: string, input: unknown, target: Record<string, unknown>): Promise<any> =>
    request(`${ws}/capabilities/${operationId}/invoke`, { ...target, input, actor })
  const onRun = (runId: string, operationId: string, input: unknown): Promise<any> => invoke(operationId, input, { resource: ref(runId) })
  const presence = (runId: string): Promise<any> => request(runPath(runId, '/presence'))
  const simulationMs = async (runId: string): Promise<number> => Date.parse((await presence(runId)).execution.currentSimulationTime)
  const createdRun = (result: any): string => {
    const resource = result.createdResources?.find((entry: { type: string }) => entry.type === 'world.simulation-run') ?? result.result?.resource ?? result.result
    if (typeof resource?.id !== 'string') throw new Error(`no Run in the result: ${JSON.stringify(result).slice(0, 400)}`)
    return resource.id
  }
  return {
    request, invoke, onRun, presence, simulationMs, runPath,
    pause: (runId: string) => onRun(runId, 'world.simulation-run.execution.set', { playback: 'paused' }),
    playRealtime: (runId: string) => onRun(runId, 'world.simulation-run.execution.set', { playback: 'playing', pace: 'realtime' }),
    rename: async (runId: string, name: string) => onRun(runId, 'world.simulation-run.rename', { name, expectedTitle: (await presence(runId)).title }),
    /** An independent paused copy at the Run's instant. */
    copy: async (runId: string, name: string): Promise<string> => createdRun(await onRun(runId, 'world.simulation-run.copy', { name })),
    /** Starts a featured demo through its Definition's published Capability, as the Host's Start demo does; paused. */
    launchFeatured: async (definitionId: string): Promise<string> => {
      const featured = await request('/api/featured-definitions')
      const demo = featured.definitions.find((entry: any) => entry.definition?.id === definitionId)
      if (!demo) throw new Error(`featured definition ${definitionId} missing`)
      const { definitions } = await request(`${ws}/definitions?moduleId=world`)
      const descriptor = definitions.find((entry: any) => entry.ref.moduleId === 'world' && entry.ref.id === definitionId)
      const runId = createdRun(await invoke(descriptor.primaryCapabilityId, {}, { definition: { ...descriptor.ref, revisionId: demo.revisionId } }))
      await onRun(runId, 'world.simulation-run.execution.set', { playback: 'paused' })
      return runId
    },
    /** Advances `minutes` of Run time at maximum pace and waits until it stands paused there. */
    advance: async (runId: string, minutes: number, onProgress?: (at: string) => void): Promise<string> => {
      const target = await simulationMs(runId) + minutes * 60_000
      await onRun(runId, 'world.simulation-run.execution.advance', { minutes, onComplete: 'pause' })
      for (;;) {
        await sleep(3_000)
        const state = await presence(runId)
        const at = Date.parse(state.execution.currentSimulationTime)
        if (state.execution.playback === 'paused' && at >= target - 1_000) return state.execution.currentSimulationTime
        onProgress?.(state.execution.currentSimulationTime)
      }
    },
    /** The Run's Historian status (samples held against its budget). */
    historian: async (runId: string): Promise<any> => (await onRun(runId, 'world.simulation-run.history-series.list', { limit: 1 })).result?.status ?? null,
    /** Loads the Run (World keeps a Run loaded only while someone uses it). */
    load: (runId: string): Promise<any> => request(runPath(runId)),
    objects: async (runId: string): Promise<ReadonlyArray<any>> => (await request(runPath(runId, '/objects'))).objects,
    /** World's default display of a subject as it composes it now (POST displays/default), compiled (POST displays/view). */
    defaultView: async (runId: string, subject: string): Promise<{ readonly state: string; readonly view: any }> => {
      const { result } = await request(runPath(runId, '/displays/default'), { subject })
      const { view } = await request(runPath(runId, '/displays/view'), { state: result.view.state })
      return { state: result.view.state, view }
    },
    view: async (runId: string, state: string): Promise<any> => (await request(runPath(runId, '/displays/view'), { state })).view,
    sample: async (runId: string, state: string): Promise<any> => (await request(runPath(runId, '/displays/sample'), { state })).sample,
  }
}
export type StackApi = ReturnType<typeof createStackApi>
