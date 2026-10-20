/** For a recorded probe stage still on its local stack: each turn's
 * signals.search queries with the signals they returned, and the signals the
 * turn then composed. mine-retrieval-pairs.ts turns them into pairs.
 *
 *   LEITBILD_PROBE_ORIGIN=http://127.0.0.1:<port> bun scripts/display-eval/collect-searches.ts <absolute-stage-dir> <stage>
 *
 * Writes <stage>-searches.json beside the stage. */
import { join } from 'node:path'

const [directory, stage] = Bun.argv.slice(2)
if (!directory || !stage) throw new Error('Usage: collect-searches.ts <absolute-stage-dir> <stage>')
const origin = process.env.LEITBILD_PROBE_ORIGIN
if (origin === undefined || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)) throw new Error('LEITBILD_PROBE_ORIGIN must be the loopback stack the stage ran on')
const { workspaceId } = await Bun.file(join(directory, 'seed.json')).json() as { workspaceId: string }
const get = async (path: string): Promise<any> => {
  const response = await fetch(origin + path, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`${path}: ${response.status}`)
  return response.json()
}
const namesIn = (value: unknown): ReadonlyArray<string> => {
  const found = new Set<string>()
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node === null || typeof node !== 'object') return
    const record = node as Record<string, unknown>
    for (const key of ['tagId', 'path', 'ref']) if (typeof record[key] === 'string') found.add(record[key] as string)
    Object.values(record).forEach(walk)
  }
  walk(value)
  return [...found]
}
const rows = (await Bun.file(join(directory, `${stage}-rows.jsonl`)).text()).split('\n').filter(line => line.trim()).map(line => JSON.parse(line))
const turns = []
for (const row of rows) {
  const recorded = await Bun.file(join(directory, `${stage}-${row.id}.json`)).json()
  const traceId = recorded.answer?.generationTraceId
  if (typeof traceId !== 'string') continue
  const turn = await get(`/api/workspaces/${workspaceId}/agents/rooms/${row.roomId}/executions/${traceId}`)
  const searches: Array<{ query: string; returned: ReadonlyArray<string> }> = []
  for (const summary of turn.calls ?? []) {
    if (summary.tool !== 'workspace_call') continue
    const call = await get(`/api/workspaces/${workspaceId}/agents/rooms/${row.roomId}/executions/${traceId}/calls/${summary.id}`)
    const results = call.result?.data?.results ?? []
    for (const entry of call.arguments?.calls ?? []) {
      if (entry.operationId !== 'world.process-plant.signals.search') continue
      // signals.search takes free words in `text`; a search by tag or equipment id alone is no wording to pair.
      const query = typeof entry.input?.text === 'string' ? entry.input.text : ''
      const result = results.find((candidate: { key: string }) => candidate.key === entry.key)
      if (query.length > 0 && result?.success === true) searches.push({ query, returned: namesIn(result.data) })
    }
  }
  const composed = (recorded.composes ?? []).filter((record: any) => record.result?.success === true)
    .flatMap((record: any) => ((record.input?.panels ?? []) as ReadonlyArray<any>).flatMap(panel => (panel.signals ?? []).map((signal: { ref: string }) => signal.ref)))
  turns.push({ scenario: row.id, searches, composed: [...new Set(composed)] })
}
await Bun.write(join(directory, `${stage}-searches.json`), JSON.stringify(turns, null, 1))
console.log(JSON.stringify({ turns: turns.length, searches: turns.reduce((sum, turn) => sum + turn.searches.length, 0) }))
