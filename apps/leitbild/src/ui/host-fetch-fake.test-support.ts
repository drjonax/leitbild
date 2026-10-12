// A scripted fetch for the Host UI tests: routes answer in order, every call is recorded.

export interface FakeCall {
  readonly method: string
  readonly path: string
  readonly body: unknown
  readonly signal: AbortSignal | undefined
}

type Answer = Response | ((call: FakeCall) => Response | Promise<Response>)

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export const hostError = (status: number, code: string, message: string): Response => json({ error: { code, message } }, status)

export const fakeFetch = () => {
  const routes = new Map<string, Answer[]>()
  const calls: FakeCall[] = []
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    const call = { method, path: input, body, signal: init?.signal ?? undefined }
    calls.push(call)
    if (call.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    const queue = routes.get(`${method} ${input}`)
    const answer = queue && queue.length > 1 ? queue.shift()! : queue?.[0]
    if (!answer) throw new Error(`Unexpected request: ${method} ${input}`)
    return typeof answer === 'function' ? answer(call) : answer.clone()
  }
  return {
    fetch,
    calls,
    /** Answers in order; the last answer repeats. */
    on(method: string, path: string, ...answers: Answer[]) {
      routes.set(`${method} ${path}`, answers)
      return this
    },
  }
}

export const workspaceFixture = (id: string, overrides: { name?: string | null; world?: string; agents?: string } = {}) => ({
  id,
  name: overrides.name === undefined ? 'Grid study' : overrides.name,
  modules: [
    { moduleId: 'world', status: overrides.world ?? 'ready', updatedAt: '2026-10-12T20:41:00.000Z',
      ...(overrides.world === 'provision_failed' ? { failure: { code: 'module_unavailable', message: 'World did not answer', retryable: true } } : {}) },
    { moduleId: 'agents', status: overrides.agents ?? 'ready', updatedAt: '2026-10-12T20:41:00.000Z',
      ...(overrides.agents === 'provision_failed' ? { failure: { code: 'module_unavailable', message: 'Agents did not answer', retryable: true } } : {}) },
  ],
  createdAt: '2026-10-12T20:41:00.000Z',
  updatedAt: '2026-10-12T20:41:00.000Z',
})
