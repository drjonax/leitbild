/** Small, budget-capped comparison of models and reasoning efforts on the
 * production Leitbild Assistant. Creates only its own Workspace and Runs.
 * For each scenario, each setting gets a fresh Assistant Room on its own copy
 * of a paused Halden Run; the Room's Agent is switched to that setting before
 * the question is asked. Settings alternate per scenario, so provider load
 * affects them alike.
 *
 *   bun scripts/model-probe.ts <absolute-output-dir> <model@effort> [<model@effort> ...]
 *
 * `effort` is a reasoning effort (none, low, medium, ...) or `default` for the
 * provider's own default. Spend is computed from each answer's reported tokens
 * at direct OpenAI list prices; the probe stops before a turn could take it past
 * the fork's guard ($0.50 luna, $2.00 sol; LEITBILD_PROBE_BUDGET_USD lowers it).
 * LEITBILD_PROBE_ORIGIN selects another loopback stack (default
 * http://127.0.0.1:43100). Never reads credentials. Evidence for review, not a benchmark.
 */
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { assertLocalOrigin, callCostUsd, runGuardUsd } from './fork/openai-spend.ts'

interface Scenario {
  readonly id: string
  readonly prompt: string
  readonly expect: 'display' | 'none'
  readonly fault?: { readonly actionId: string; readonly parameters?: Record<string, unknown> }
  readonly advanceMinutes: number
}

// Diagnosis, an equipment mimic, a comparison, and two questions that need no display.
const scenarios: ReadonlyArray<Scenario> = [
  { id: 'sg-a-tube-leak', fault: { actionId: 'steam-generator-tube-leak-a', parameters: { leakPercent: 1.2 } }, advanceMinutes: 3, expect: 'display',
    prompt: 'We have secondary radiation indications on Unit 2. Assess the situation.' },
  { id: 'diesel-afw', fault: { actionId: 'loss-offsite-power' }, advanceMinutes: 1, expect: 'display',
    prompt: 'Unit 2 lost offsite power. Is the diesel feeding the motor-driven auxiliary feedwater pump?' },
  { id: 'compare-sg-levels', advanceMinutes: 1, expect: 'display', prompt: 'Compare the four steam generator levels on Unit 2.' },
  { id: 'single-state', advanceMinutes: 1, expect: 'none', prompt: 'Is main feedwater pump A on Unit 2 running?' },
  { id: 'single-value', advanceMinutes: 1, expect: 'none', prompt: 'What is the current pressurizer pressure on Unit 2?' },
]

const [directory, ...settingArgs] = Bun.argv.slice(2)
const settings = settingArgs.map(arg => {
  const match = /^([^@\s]+)@([a-z]+)$/.exec(arg)
  if (!match) throw new Error(`Setting "${arg}" is not <model@effort>`)
  return { label: arg, model: match[1]!, effort: match[2] === 'default' ? null : match[2]! }
})
if (!directory || !isAbsolute(directory) || settings.length === 0) {
  throw new Error('Usage: bun scripts/model-probe.ts <absolute-output-dir> <model@effort> [<model@effort> ...]')
}
// Fork: a loopback stack only, and the plan's per-run guard for the models compared (§6).
const origin = assertLocalOrigin(process.env.LEITBILD_PROBE_ORIGIN ?? 'http://127.0.0.1:43100')
const budgetUsd = runGuardUsd(settings.map(setting => setting.model))
const plantId = 'plant:halden-2'
await mkdir(directory, { recursive: true })
if (await Bun.file(join(directory, 'summary.json')).exists()) throw new Error('Output directory already holds a summary; choose a new one')

// Fork: direct OpenAI list prices (scripts/fork/openai-spend.ts); an answer from an unpriced model stops the probe.
const turnCost = (answer: any): number => callCostUsd({ model: answer.model, promptTokens: answer.promptTokens, cacheRead: answer.cacheRead ?? 0, completionTokens: answer.completionTokens })

const request = async (path: string, body?: unknown, method = 'POST'): Promise<any> => {
  const response = await fetch(origin + path, {
    ...(body === undefined ? {} : { method, body: JSON.stringify(body) }),
    headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60_000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text.slice(0, 400)}`)
  return JSON.parse(text)
}
const save = (name: string, value: unknown) => Bun.write(join(directory, `${name}.json`), JSON.stringify(value, null, 2))
const actor = { kind: 'human', id: 'model-probe', displayName: 'Model probe' }

const { workspace } = await request('/api/workspaces', { name: 'Model probe' })
const workspaceId = workspace.id as string
const agentsPath = `/api/workspaces/${workspaceId}/agents`
const invoke = (operationId: string, input: unknown, target: Record<string, unknown> = {}) =>
  request(`/api/workspaces/${workspaceId}/capabilities/${operationId}/invoke`, { ...target, input, actor })
const runOf = (outcome: any): Record<string, string> => {
  const resource = outcome.createdResources?.find((entry: { type: string }) => entry.type === 'world.simulation-run') ?? outcome.result?.resource
  if (!resource) throw new Error('Expected a Simulation Run reference')
  return resource
}

const { definitions } = await request(`/api/workspaces/${workspaceId}/definitions`)
const definition = definitions.find((entry: { ref: { id: string } }) => entry.ref.id === 'halden-power-complex')
if (!definition) throw new Error('Expected bundled Halden scenario is absent')
const seed = runOf(await invoke('world.scenario.start', {}, { definition: { ...definition.ref, revisionId: definition.currentRevisionId } }))
await invoke('world.simulation-run.execution.set', { playback: 'paused' }, { resource: seed })

const advance = async (resource: Record<string, string>, minutes: number): Promise<void> => {
  const presence = () => request(`/api/workspaces/${workspaceId}/world/simulation-runs/${encodeURIComponent(resource.id!)}/presence`)
  const target = Date.parse((await presence()).execution.currentSimulationTime) + minutes * 60_000
  await invoke('world.simulation-run.execution.advance', { minutes, onComplete: 'pause' }, { resource })
  const deadline = Date.now() + 300_000 // Probe patience, not a product limit.
  while (Date.now() < deadline) {
    const state = await presence()
    if (state.execution.playback === 'paused' && Date.parse(state.execution.currentSimulationTime) >= target) return
    await Bun.sleep(2_000)
  }
  throw new Error(`Run ${resource.id} did not advance ${minutes} min within the probe deadline`)
}

// Compose calls in the answer's own execution evidence, in order: accepted or not.
const composeOutcomes = async (roomId: string, turnId: string): Promise<ReadonlyArray<boolean>> => {
  const turnPath = `${agentsPath}/rooms/${roomId}/executions/${turnId}`
  const outcomes: boolean[] = []
  for (const summary of (await request(turnPath)).calls ?? []) {
    if (summary.tool !== 'workspace_call') continue
    const call = await request(`${turnPath}/calls/${summary.id}`)
    const results = call.result?.data?.results ?? []
    for (const entry of call.arguments?.calls ?? []) {
      if (entry.operationId !== 'world.process-plant.display.compose') continue
      const result = results.find((candidate: { key: string }) => candidate.key === entry.key)
      outcomes.push(result?.success === true && typeof result.viewRef === 'string')
    }
  }
  return outcomes
}

const ask = async (scenario: Scenario, setting: typeof settings[number]) => {
  const copy = runOf(await invoke('world.simulation-run.copy', { name: `Model probe · ${scenario.id} · ${setting.label}` }, { resource: seed }))
  if (scenario.fault) await invoke('world.process-plant.action.invoke', { plantId, actionId: scenario.fault.actionId, parameters: scenario.fault.parameters ?? {} }, { resource: copy })
  await advance(copy, scenario.advanceMinutes)
  const opened = await invoke('agents.assistance.open', { scope: { kind: 'resource', resource: copy }, title: `Model probe · ${scenario.id} · ${setting.label}`, focusedSubjects: [copy] })
  const roomId = opened.result.resource.id as string
  const roomPath = `${agentsPath}/rooms/${roomId}`
  const members = await request(roomPath + '/members')
  const human = members.find((member: { kind: string }) => member.kind === 'human')
  const agent = members.find((member: { kind: string }) => member.kind === 'ai')
  await request(`${agentsPath}/agents/${encodeURIComponent(agent.name)}`, { model: setting.model, reasoningEffort: setting.effort }, 'PATCH')
  const prior = new Set((await request(roomPath + '?limit=100')).messages.map((message: { id: string }) => message.id))
  const startedAt = Date.now()
  await request(`${agentsPath}/messages`, { senderId: human.id, senderName: human.name, content: scenario.prompt, target: { rooms: [roomId] } })
  while (Date.now() - startedAt < 300_000) { // Probe deadline, not a product limit.
    // A failed poll is reported and retried; the deadline still bounds the wait.
    const messages = await request(roomPath + '?limit=100').then(page => page.messages, error => {
      console.warn(`Poll for ${scenario.id} with ${setting.label} failed: ${error instanceof Error ? error.message : String(error)}`)
      return []
    })
    const answer = messages.find((message: { id: string; senderId: string; type: string }) =>
      !prior.has(message.id) && message.senderId === agent.id && message.type === 'chat')
    if (answer) return { answer, wallMs: Date.now() - startedAt, roomId }
    await Bun.sleep(2_000)
  }
  throw new Error(`No answer for ${scenario.id} with ${setting.label} within the probe deadline`)
}

const rows: Array<Record<string, any>> = []
let spentUsd = 0
let largestTurnUsd = 0
probe: for (const scenario of scenarios) {
  for (const setting of settings) {
    if (spentUsd + Math.max(largestTurnUsd, 0.25) > budgetUsd) {
      console.log(`Stopping before ${scenario.id} with ${setting.label}: $${spentUsd.toFixed(2)} spent of $${budgetUsd}`)
      break probe
    }
    const { answer, wallMs, roomId } = await ask(scenario, setting)
    const costUsd = turnCost(answer)
    spentUsd += costUsd
    largestTurnUsd = Math.max(largestTurnUsd, costUsd)
    const composes = answer.generationTraceId ? await composeOutcomes(roomId, answer.generationTraceId) : []
    const displayed = /```leitbild-view\n/.test(answer.content)
    const row = {
      scenario: scenario.id,
      setting: setting.label,
      model: answer.model,
      correctDisplayChoice: displayed === (scenario.expect === 'display'),
      composeCalls: composes.length,
      firstComposeAccepted: composes[0] ?? null,
      wallMs,
      generationMs: answer.generationMs,
      modelCalls: answer.modelCalls,
      promptTokens: answer.promptTokens,
      cacheRead: answer.cacheRead,
      completionTokens: answer.completionTokens,
      costUsd: Math.round(costUsd * 1000) / 1000,
      answerChars: answer.content.length,
      roomId,
    }
    rows.push(row)
    await save(`${scenario.id}-${setting.label.replace(/[^a-z0-9.-]+/gi, '_')}`, { scenario, setting, row, answer })
    console.log(JSON.stringify(row))
  }
}

const median = (values: ReadonlyArray<number>): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]!
}
const bySetting = settings.map(setting => {
  const own = rows.filter(row => row.setting === setting.label)
  const composed = own.filter(row => row.firstComposeAccepted !== null)
  return {
    setting: setting.label,
    turns: own.length,
    correctDisplayChoice: own.filter(row => row.correctDisplayChoice).length,
    firstComposeAccepted: `${composed.filter(row => row.firstComposeAccepted).length}/${composed.length}`,
    medianWallMs: median(own.map(row => row.wallMs)),
    medianModelCalls: median(own.map(row => row.modelCalls)),
    meanCompletionTokens: own.length === 0 ? null : Math.round(own.reduce((sum, row) => sum + row.completionTokens, 0) / own.length),
    costUsd: Math.round(own.reduce((sum, row) => sum + row.costUsd, 0) * 100) / 100,
  }
})
const summary = { origin, workspaceId, budgetUsd, spentUsd: Math.round(spentUsd * 100) / 100, bySetting, rows }
await save('summary', summary)
console.log(JSON.stringify({ ...summary, rows: undefined }, null, 2))
