/** Manual, budget-guarded proof that the Leitbild Assistant runs E-0 itself on
 * an order: it starts E-0, trips the reactor as step 1 calls for, decides each
 * step on the plant's readings (RNO, transfers and untagged steps included)
 * and tells the person each step in a progress line. Creates only its own
 * Workspace, Run and Room; never reads credentials. Evidence for review, not
 * a benchmark.
 *
 *   bun scripts/agent-procedure-probe.ts <origin> <evidenceDir> [--model <openrouter model id>] [--reasoning-effort <effort>]
 *     [--budget-usd 1.5] [--unit "Halden Unit 2"] [--turns 1|2] [--price <in>,<cached>,<write>,<out> --worst-turn-usd <usd>] [--dry]
 *
 * --reasoning-effort sets the Assistant's effort for the run (the Room's definition otherwise decides), as a
 * model under test may need another effort than the default model.
 *
 * 1. A fresh Workspace plays the Halden four-unit scenario in realtime; the unit is at power.
 * 2. A new Assistant Room from the leitbild-assistant definition (with the
 *    procedure-runner skill); --model sets its Agent's model.
 * 3. Turn 1 says "Run E-0 on <unit>". Nothing else is posted and no person
 *    acts: the Assistant should start E-0 and drive it, trip the reactor
 *    with a control write, wait in plant seconds, and decide step after
 *    step, each with a say line, until a hold, END or its turn budget.
 * 4. With --turns 2, turn 2 says "continue" if the procedure is still active
 *    and the AI still drives it.
 * After each turn it records the answer, the progress lines, model, usage,
 * tool trace, every procedure run's state and every Plant's proposals, then
 * judges the pass criteria and prints them.
 *
 * Cost: per million tokens from the table below (or --price), the part of the
 * prompt not read from the cache billed at the higher of the input and cache
 * write rates. Budget guard: before every turn, stop if spent plus the model's
 * worst-case turn would exceed --budget-usd; stop at once if a turn costs more
 * than twice its estimate (cache on).
 *
 * --dry posts no message and so calls no model: a scripted stand-in with an AI
 * actor (not a model) starts E-0, writes the trip, waits on the plant and
 * selects the first branch of each step with a basis and the step's readable
 * tags for up to six steps, under World's AI rules, against a real stack.
 */
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// A turn costing less than this never counts as a runaway, however far over its estimate: cheap models' estimates are cents.
const runawayFloorUsd = 0.05
const usage = 'Usage: bun scripts/agent-procedure-probe.ts <origin> <evidenceDir> [--model <openrouter model id>] [--reasoning-effort <effort>] [--budget-usd 1.5] [--unit "Halden Unit 2"] [--turns 1|2] [--price <in>,<cached>,<write>,<out> --worst-turn-usd <usd>] [--dry]'

// ---- Arguments ----
const valued = new Set(['--model', '--reasoning-effort', '--budget-usd', '--unit', '--turns', '--price', '--worst-turn-usd'])
const positional: string[] = []
const flags = new Map<string, string>()
let dry = false
{
  const argv = Bun.argv.slice(2)
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!
    if (argument === '--dry') dry = true
    else if (valued.has(argument)) {
      const value = argv[++index]
      if (value === undefined || flags.has(argument)) throw new Error(`${argument} needs one value. ${usage}`)
      flags.set(argument, value)
    } else if (argument.startsWith('--')) throw new Error(`Unknown option ${argument}. ${usage}`)
    else positional.push(argument)
  }
}
const [originArgument, evidenceArgument] = positional
if (positional.length !== 2 || !originArgument || !evidenceArgument || !/^https?:\/\/[^/]+$/.test(originArgument.replace(/\/$/, ''))) throw new Error(usage)
const origin = originArgument.replace(/\/$/, '')
const directory = resolve(evidenceArgument)
const budgetUsd = Number(flags.get('--budget-usd') ?? '1.5')
if (!(budgetUsd > 0)) throw new Error('--budget-usd must be a positive number')
const unitLabel = flags.get('--unit') ?? 'Halden Unit 2'
const turnLimit = Number(flags.get('--turns') ?? '1')
if (turnLimit !== 1 && turnLimit !== 2) throw new Error('--turns is 1 or 2')
const requestedModel = flags.get('--model')
const requestedEffort = flags.get('--reasoning-effort')

interface Price { readonly input: number; readonly cached: number; readonly write: number; readonly output: number }
/** USD per million tokens, and the most one probe turn may cost (budget guard). */
const PRICES: Readonly<Record<string, Price & { readonly worstTurnUsd: number }>> = {
  'openai/gpt-6-sol': { input: 2.00, cached: 0.20, write: 2.50, output: 10, worstTurnUsd: 0.90 },
  'openai/gpt-6-luna': { input: 0.10, cached: 0.01, write: 0.125, output: 0.50, worstTurnUsd: 0.08 },
}
/** Tokens per turn, estimated for an autonomous E-0 turn of about 25 rounds (most of each prompt cached), then a "continue". */
const SCENARIO_TURNS = [
  { uncached: 90_000, cached: 800_000, completion: 7_000 },
  { uncached: 40_000, cached: 300_000, completion: 3_000 },
] as const
const priceArgument = flags.get('--price')
const givenPrice: Price | undefined = priceArgument === undefined ? undefined : (() => {
  const parts = priceArgument.split(',').map(Number)
  if (parts.length !== 4 || parts.some(part => !(part >= 0))) throw new Error('--price is <input>,<cached>,<cacheWrite>,<output> in USD per million tokens')
  return { input: parts[0]!, cached: parts[1]!, write: parts[2]!, output: parts[3]! }
})()
const givenWorst = flags.get('--worst-turn-usd') === undefined ? undefined : Number(flags.get('--worst-turn-usd'))
if (givenWorst !== undefined && !(givenWorst > 0)) throw new Error('--worst-turn-usd must be a positive number')

const bare = (model: string): string => model.replace(/^[^/]+\//, '')
/** The table entry for a model id as an Agent or a provider names it: with or without its vendor, or with a dated suffix. */
const tableEntry = (model: string) => Object.entries(PRICES).find(([key]) =>
  key === model || bare(key) === bare(model) || (bare(model).startsWith(`${bare(key)}-`) && /^[\d-]+$/.test(bare(model).slice(bare(key).length + 1))))
const pricingFor = (model: string) => {
  const entry = tableEntry(model)
  const price = givenPrice ?? entry?.[1]
  const worstTurnUsd = givenWorst ?? entry?.[1].worstTurnUsd
  if (price === undefined || worstTurnUsd === undefined) {
    throw new Error(`No price for model ${model}: pass --price <in>,<cached>,<write>,<out> and --worst-turn-usd <usd>`)
  }
  return { model: entry?.[0] ?? model, price, worstTurnUsd }
}
// Refuse a model without a price before creating anything.
if (requestedModel !== undefined) pricingFor(requestedModel)
const estimateUsd = (price: Price, turn: number): number => {
  const tokens = SCENARIO_TURNS[turn]!
  return (tokens.uncached * Math.max(price.input, price.write) + tokens.cached * price.cached + tokens.completion * price.output) / 1e6
}
interface Usage { readonly promptTokens: number; readonly cacheRead: number; readonly cacheCreation: number | null; readonly completionTokens: number; readonly modelCalls: number | null }
const costUsd = (spent: Usage, price: Price): number =>
  (Math.max(0, spent.promptTokens - spent.cacheRead) * Math.max(price.input, price.write) + spent.cacheRead * price.cached + spent.completionTokens * price.output) / 1e6
const usd = (value: number): number => Math.round(value * 10_000) / 10_000

// ---- HTTP ----
class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
const request = async (path: string, body?: unknown, method = 'POST'): Promise<any> => {
  const response = await fetch(origin + path, {
    ...(body === undefined ? {} : { method, body: JSON.stringify(body) }),
    headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60_000),
  })
  const text = await response.text()
  if (!response.ok) throw new ApiError(response.status, `${path}: ${response.status} ${text.slice(0, 400)}`)
  return JSON.parse(text)
}

type Actor = { readonly kind: 'human' | 'ai'; readonly id: string; readonly displayName: string }
const person: Actor = { kind: 'human', id: 'procedure-probe', displayName: 'Procedure probe (person)' }
const personActorId = `actor:human:${person.id}`
// --dry only: scripted, so the person's actions have something to act on; never a model.
const standIn: Actor = { kind: 'ai', id: 'procedure-probe-stand-in', displayName: 'Dry-run stand-in (not a model)' }

await mkdir(directory, { recursive: true })
if (await Bun.file(join(directory, 'summary.json')).exists()) throw new Error('Evidence directory already holds a summary; choose a new one, do not overwrite evidence')
const save = (name: string, value: unknown) => Bun.write(join(directory, `${name}.json`), JSON.stringify(value, null, 2))

class ProbeStop extends Error {}
const REQUIRED_CAPABILITIES = [
  'agents.assistance.create', 'world.process-plant.control.proposals', 'world.process-plant.control.write', 'world.process-plant.signals.read',
  'world.procedure.runs.list', 'world.procedure.run.step.read', 'world.procedure.run.transition', 'world.procedure.run.start', 'world.procedure.run.drive', 'world.simulation-run.wait',
]
const stop = (reason: string): never => { throw new ProbeStop(reason) }

// ---- Probe state, written to summary.json however the probe ends ----
const turns: Array<Record<string, any>> = []
const notes: string[] = []
let workspaceId = ''
let target: { resource: Record<string, string> } | undefined
let plants: ReadonlyArray<{ id: string; label: string }> = []
let unit: { id: string; label: string } | undefined
let e0: { steps: ReadonlyArray<{ id: string; label: string; tagIds: ReadonlyArray<string> }> } | undefined
const tripPaths = new Map<string, string>()
let pricing: ReturnType<typeof pricingFor> | undefined
let spentUsd = 0
let finalState: Observation | undefined
let room: Record<string, any> | undefined

const invoke = (actor: Actor, operationId: string, input: unknown, at: Record<string, unknown> = target ?? {}) =>
  request(`/api/workspaces/${workspaceId}/capabilities/${operationId}/invoke`, { ...at, input, actor })

const simulationTime = async (): Promise<string> =>
  (await request(`/api/workspaces/${workspaceId}/world/simulation-runs/${encodeURIComponent(target!.resource.id!)}/presence`)).execution.currentSimulationTime

const readProposals = async (plantId: string) => {
  const { result } = await invoke(person, 'world.process-plant.control.proposals', { plantId })
  return (result.proposals as ReadonlyArray<{ proposal: any; review?: any }>).map(({ proposal, review }) => ({
    id: proposal.id as string,
    plantId,
    path: (proposal.write?.path ?? null) as string | null,
    value: proposal.write?.value ?? null,
    ...(proposal.reset === undefined ? {} : { reset: proposal.reset.ruleId as string }),
    trip: proposal.write?.path !== undefined && proposal.write.path === tripPaths.get(plantId),
    word: proposal.word as string,
    status: proposal.status as string,
    origin: proposal.proposer.origin as string,
    proposer: proposal.proposer.actorId as string,
    reason: proposal.reason as string,
    procedureStep: proposal.procedureStep ?? null,
    evidence: (proposal.evidence as ReadonlyArray<{ tagId: string; value: unknown }>).map(entry => ({ tagId: entry.tagId, value: entry.value })),
    ...(proposal.closed === undefined ? {} : { closed: proposal.closed }),
    ...(review === undefined ? {} : { permitted: review.permitted as boolean, ...(review.refusal === undefined ? {} : { refusal: review.refusal as string }) }),
  }))
}

const runSummary = (run: any) => ({
  runId: run.runId as string,
  procedureId: run.procedureId as string,
  plantId: run.scope.plantId as string,
  status: run.status as string,
  startedAt: run.startedAt as string,
  startedBy: run.startedBy as string,
  currentStepId: (run.currentStepId ?? null) as string | null,
  driver: run.driver ?? null,
  stepStates: (run.stepStates as ReadonlyArray<any>).map(state => ({
    stepId: state.stepId as string,
    assessment: state.assessment as string,
    ...(state.comment === undefined ? {} : { comment: state.comment as string }),
    decision: state.decision === undefined ? null : {
      branchIndex: state.decision.branchIndex,
      label: state.decision.label ?? null,
      outcome: state.decision.outcome ?? null,
      target: state.decision.target,
      basis: state.decision.basis ?? null,
      evidence: state.decision.evidence ?? [],
      selectedBy: state.decision.selectedBy as string,
      selectedByLabel: state.decision.selectedByLabel ?? null,
      simulationTime: state.decision.simulationTime as string,
    },
  })),
})
type Observation = Awaited<ReturnType<typeof observe>>
const observe = async () => {
  const time = await simulationTime()
  const runs = ((await invoke(person, 'world.procedure.runs.list', {})).result.runs as ReadonlyArray<any>).map(runSummary)
  const proposals = []
  for (const plant of plants) proposals.push(...await readProposals(plant.id))
  return { simulationTime: time, runs, proposals }
}
const e0RunOf = (state: Observation) => state.runs
  .filter(run => run.procedureId === 'E-0' && run.plantId === unit!.id)
  .sort((left, right) => left.startedAt.localeCompare(right.startedAt)).at(-1)

const breakers = async (plantId: string) => {
  const { result } = await invoke(person, 'world.process-plant.signals.read', { plantId, signals: [{ tagId: 'TRIP-BKR-A-POS' }, { tagId: 'TRIP-BKR-B-POS' }] })
  return (result.signals as ReadonlyArray<any>).map(entry => ({ tagId: entry.signal.tagId as string, closed: entry.variable.value as boolean, quality: entry.quality?.status ?? null }))
}

// ---- Agents ----
let roomPath = ''
let human: { id: string; name: string } | undefined
let agent: { id: string; name: string } | undefined

const nextReply = async (prior: ReadonlySet<string>, label: string): Promise<any> => {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 900_000) { // Probe deadline, not a product limit: a whole E-0 turn runs ~25 rounds with plant waits.
    // Progress lines precede the answer; the answer is the turn's first other message.
    const reply = (await request(roomPath + '?limit=200')).messages.find((message: { id: string; senderId: string; type: string; progress?: true }) =>
      !prior.has(message.id) && message.senderId === agent!.id && message.progress !== true && ['chat', 'pass', 'error'].includes(message.type))
    if (reply) return reply
    await Bun.sleep(2_000)
  }
  await request(`/api/workspaces/${workspaceId}/agents/agents/${encodeURIComponent(agent!.id)}/cancel`, {})
  return stop(`No answer to ${label} within the probe deadline; the probe's Agent was cancelled`)
}

/** Every operation the turn's workspace_call batches issued, from its own execution evidence, in call order. */
const turnOperations = async (turnId: string) => {
  const execution = await request(`${roomPath}/executions/${encodeURIComponent(turnId)}`)
  const operations: Array<Record<string, unknown>> = []
  for (const summary of execution.calls ?? []) {
    if (summary.tool !== 'workspace_call') continue
    const call = await request(`${roomPath}/executions/${encodeURIComponent(turnId)}/calls/${encodeURIComponent(summary.id)}`)
    const results = call.result?.data?.results ?? []
    for (const entry of call.arguments?.calls ?? []) {
      const result = results.find((candidate: { key: string }) => candidate.key === entry.key)
      operations.push({
        operationId: entry.operationId,
        input: entry.input,
        ...(entry.say === undefined ? {} : { say: entry.say }),
        success: result?.success === true,
        ...(result?.success === true ? {} : { error: String(result?.error ?? 'no result').slice(0, 400) }),
      })
    }
  }
  return operations
}

/** One row per operation a tool call ran (a workspace_call batches several; resultBytes is the whole call's). The argument
 * keys tell a discovery call's kind: an operation search (queries), by id (operationIds), with schemas (includeInputSchema). */
const toolTraceOf = (answer: any) => (answer.toolTrace as ReadonlyArray<any> | undefined ?? []).flatMap((entry, call) => {
  const outcomes = entry.operationOutcomes as ReadonlyArray<{ operationId: string; success: boolean }> | undefined
  const base = { call, tool: entry.tool as string, argumentKeys: (entry.argumentKeys ?? []) as ReadonlyArray<string>, resultBytes: (entry.resultBytes ?? null) as number | null }
  if (outcomes !== undefined && outcomes.length > 0) return outcomes.map(outcome => ({ ...base, operationId: outcome.operationId, success: outcome.success }))
  const ids = (entry.operationIds ?? []) as ReadonlyArray<string>
  return [{ ...base, operationId: ids.length === 0 ? null : ids.join(','), success: entry.success as boolean }]
})

const usageOf = (answer: any): Usage | null => typeof answer.promptTokens !== 'number' || typeof answer.completionTokens !== 'number' ? null : {
  promptTokens: answer.promptTokens,
  cacheRead: answer.cacheRead ?? 0,
  cacheCreation: answer.cacheCreation ?? null,
  completionTokens: answer.completionTokens,
  modelCalls: answer.modelCalls ?? null,
}

/** Before a turn starts: the budget guard, and the Room's messages so far, so the turn's answer is told apart. */
const beforeTurn = async (turn: number) => {
  if (spentUsd + pricing!.worstTurnUsd > budgetUsd) {
    stop(`Budget guard before turn ${turn + 1}: $${usd(spentUsd)} spent + $${pricing!.worstTurnUsd} worst-case turn > $${budgetUsd}`)
  }
  const prior = new Set<string>((await request(roomPath + '?limit=200')).messages.map((message: { id: string }) => message.id))
  return { prior, startedAt: Date.now() }
}

const ask = async (turn: number, prompt: string) => {
  const before = await beforeTurn(turn)
  await request(`/api/workspaces/${workspaceId}/agents/messages`, { senderId: human!.id, senderName: human!.name, content: prompt, target: { rooms: [room!.id] } })
  return await answered(turn, prompt, before)
}

const answered = async (turn: number, prompt: string, before: Awaited<ReturnType<typeof beforeTurn>>) => {
  const estimate = estimateUsd(pricing!.price, turn)
  const answer = await nextReply(before.prior, `turn ${turn + 1}`)
  const wallMs = Date.now() - before.startedAt
  const spent = usageOf(answer)
  const answeredBy = typeof answer.model === 'string' ? answer.model : null
  const turnPricing = answeredBy === null ? pricing! : (() => {
    const entry = tableEntry(answeredBy)
    return entry === undefined && givenPrice === undefined ? null : pricingFor(answeredBy)
  })()
  const cost = spent === null || turnPricing === null ? null : costUsd(spent, turnPricing.price)
  spentUsd += cost ?? 0
  const operations = typeof answer.generationTraceId === 'string' ? await turnOperations(answer.generationTraceId) : []
  // The progress lines the turn posted before its answer, in Room order.
  const progress = ((await request(roomPath + '?limit=200')).messages as ReadonlyArray<{ id: string; senderId: string; progress?: true; content: string }>)
    .filter(message => !before.prior.has(message.id) && message.senderId === agent!.id && message.progress === true).map(message => message.content)
  const state = await observe()
  const run = e0RunOf(state)
  const record = {
    turn: turn + 1,
    prompt,
    wallMs,
    answer: { id: answer.id, type: answer.type, text: answer.content, generationTraceId: answer.generationTraceId ?? null, cause: answer.cause ?? null, ...(answer.errorCode === undefined ? {} : { errorCode: answer.errorCode }) },
    model: answeredBy,
    usage: spent,
    costUsd: cost === null ? null : usd(cost),
    estimateUsd: usd(estimate),
    toolTrace: toolTraceOf(answer),
    operations,
    progress,
    procedure: run === undefined ? null : { runId: run.runId, currentStepId: run.currentStepId, driver: run.driver, stepStates: run.stepStates },
    state,
  }
  turns.push(record)
  await save(`turn-${turn + 1}`, record)
  console.log(JSON.stringify({ turn: turn + 1, type: answer.type, model: answeredBy, costUsd: record.costUsd, spentUsd: usd(spentUsd), modelCalls: spent?.modelCalls ?? null, wallMs, currentStepId: run?.currentStepId ?? null }))
  if (answer.type !== 'chat') stop(`Turn ${turn + 1} answered with a ${answer.type} message: ${String(answer.content).slice(0, 200)}`)
  if (spent === null) stop(`Turn ${turn + 1} reported no token usage; its cost cannot be guarded`)
  if (turnPricing === null) stop(`Turn ${turn + 1} was answered by ${answeredBy}, which has no price; pass --price to run it`)
  const expected = requestedModel ?? String(room!.model)
  const sameModel = answeredBy === null || bare(answeredBy) === bare(expected) || (tableEntry(answeredBy) !== undefined && tableEntry(answeredBy)?.[0] === tableEntry(expected)?.[0])
  if (!sameModel) stop(`Turn ${turn + 1} was answered by ${answeredBy}, not the Agent's ${expected}`)
  if (cost! > 2 * estimate && cost! > runawayFloorUsd) stop(`Turn ${turn + 1} cost $${usd(cost!)}, more than twice its scenario estimate $${usd(estimate)}`)
  return record
}

// ---- The --dry stand-in ----
/** One step of a procedure run as an actor reads it (world.procedure.run.step.read): the run's current step unless stepId. */
const readStep = async (actor: Actor, runId: string, stepId?: string): Promise<any> =>
  (await invoke(actor, 'world.procedure.run.step.read', { runId, ...(stepId === undefined ? {} : { stepId }) })).result
const stepSummary = (view: any) => ({
  runId: view.run.runId as string,
  procedureId: view.run.procedureId as string,
  stepId: (view.step?.id ?? null) as string | null,
  label: (view.step?.label ?? null) as string | null,
  driver: view.run.driver ?? null,
  simulationTime: view.simulationTime as string,
  sequence: view.sequence as number,
  branches: ((view.step?.branches ?? []) as ReadonlyArray<any>).map(branch => ({
    index: branch.index as number, label: branch.label as string, outcome: (branch.outcome ?? null) as string | null, targetKind: branch.targetKind as string, target: branch.target as string,
  })),
  tags: ((view.tags ?? []) as ReadonlyArray<any>).map(tag => ({
    id: tag.id as string, binding: tag.binding as string, reading: (tag.reading?.formatted ?? null) as string | null,
    ...(tag.reading?.signal === undefined ? {} : { signal: tag.reading.signal as string }),
    ...(tag.unavailable === undefined ? {} : { unavailable: tag.unavailable as string }),
  })),
})

/** A stand-in call as World answers an AI agent: accepted, or refused with World's words. */
const standInCall = async (operationId: string, input: unknown): Promise<Record<string, any>> => {
  try {
    const response = await invoke(standIn, operationId, input)
    return { operationId, input, ok: true, result: response.result ?? response }
  } catch (error) {
    if (error instanceof ApiError) return { operationId, input, ok: false, error: error.message }
    throw error
  }
}
/** As the skill directs, mechanically: select the step's first branch, citing the step's tags that read. */
const standInDecide = async (view: ReturnType<typeof stepSummary>): Promise<Record<string, any>> => {
  const branch = view.branches[0]
  if (view.stepId === null || branch === undefined) return { operationId: 'world.procedure.run.transition', ok: false, held: 'no step to work' }
  const evidence = view.tags.filter(tag => tag.reading !== null).slice(0, 6)
  const basis = `Dry-run stand-in, not a model: step ${view.label}, "${branch.label}". Evidence: ${evidence.map(tag => `${tag.id} ${tag.reading}`).join(', ') || 'none'} at ${view.simulationTime}.`
  return await standInCall('world.procedure.run.transition', {
    runId: view.runId, stepId: view.stepId, branchIndex: branch.index, basis: basis.length <= 300 ? basis : `${basis.slice(0, 299)}…`,
    ...(evidence.length === 0 ? {} : { evidenceTagIds: evidence.map(tag => tag.id) }),
  })
}
const standInTurn = async (turn: number) => {
  const operations: Array<Record<string, unknown>> = []
  const started = await standInCall('world.procedure.run.start', { procedureId: 'E-0', scope: { plantId: unit!.id, label: unit!.label } })
  operations.push({ ...started, result: undefined })
  const trip = await standInCall('world.process-plant.control.write', { plantId: unit!.id, tagId: 'RX-TRIP-MAN', value: true })
  operations.push({ ...trip, result: undefined })
  const run = e0RunOf(await observe())
  if (started.ok && run !== undefined) {
    const waited = await standInCall('world.simulation-run.wait', { procedureRunId: run.runId, simulationSeconds: 10, maxWaitMs: 20_000 })
    operations.push({ ...waited, result: undefined, ...(waited.ok ? { reason: waited.result.reason } : {}) })
    let view = waited.ok && waited.result.next !== undefined ? stepSummary(waited.result.next) : stepSummary(await readStep(standIn, run.runId))
    for (let step = 0; step < 6 && view.stepId !== null; step++) {
      const transition = await standInDecide(view)
      operations.push({ ...transition, result: undefined, stepId: view.stepId })
      if (!transition.ok || transition.result?.next === undefined) break
      view = stepSummary(transition.result.next)
    }
  }
  const state = await observe()
  const e0Run = e0RunOf(state)
  const record = {
    turn: turn + 1, standIn: true, prompt: null, answer: null, model: null, usage: null, costUsd: 0, estimateUsd: null, toolTrace: [], operations, progress: [],
    procedure: e0Run === undefined ? null : { runId: e0Run.runId, currentStepId: e0Run.currentStepId, driver: e0Run.driver, stepStates: e0Run.stepStates },
    state,
  }
  turns.push(record)
  await save(`turn-${turn + 1}`, record)
  console.log(JSON.stringify({ turn: turn + 1, standIn: true, operations: operations.map(operation => ({
    operationId: operation.operationId, ok: operation.ok,
    ...(operation.held === undefined ? {} : { held: operation.held }),
    ...(operation.error === undefined ? {} : { error: String(operation.error).slice(0, 200) }),
  })), currentStepId: e0Run?.currentStepId ?? null, driver: e0Run?.driver?.kind ?? null }))
  return record
}

// ---- The probe ----
const unitPhrase = (label: string): string => /\bunit\s+(\d+)\s*$/i.exec(label) ? `unit ${/\bunit\s+(\d+)\s*$/i.exec(label)![1]}` : label
let stopReason: string | null = null
let errored = false
let breakersAtStart: Awaited<ReturnType<typeof breakers>> | undefined

const probe = async () => {
  // 1. Workspace and a realtime Halden Run.
  const { workspace } = await request('/api/workspaces', { name: `Procedure runner probe${dry ? ' (dry)' : ''}` })
  workspaceId = workspace.id
  const { definitions } = await request(`/api/workspaces/${workspaceId}/definitions`)
  const definition = definitions.find((entry: { ref: { id: string } }) => entry.ref.id === 'halden-power-complex')
  if (!definition) stop('The bundled Halden scenario is absent')
  const launched = await invoke(person, 'world.scenario.start', {}, { definition: { ...definition.ref, revisionId: definition.currentRevisionId } })
  const resource = launched.createdResources?.find((entry: { type: string }) => entry.type === 'world.simulation-run') ?? launched.result?.resource
  if (!resource) stop('Scenario start returned no Simulation Run')
  target = { resource }
  const execution = (await invoke(person, 'world.simulation-run.execution.set', { playback: 'playing', pace: 'realtime' })).result
  const capabilities = new Set(((await request(`/api/workspaces/${workspaceId}/capabilities`)).capabilities as ReadonlyArray<{ id: string }>).map(capability => capability.id))
  const missing = REQUIRED_CAPABILITIES.filter(id => !capabilities.has(id))
  if (missing.length > 0) stop(`This build lacks ${missing.join(', ')}`)
  plants = ((await invoke(person, 'world.process-plant.plants.list', {})).result.plants as ReadonlyArray<{ id: string; label: string }>).map(({ id, label }) => ({ id, label }))
  const matches = plants.filter(plant => plant.label.toLowerCase() === unitLabel.toLowerCase() || plant.id === unitLabel)
  if (matches.length !== 1) stop(`--unit "${unitLabel}" matches ${matches.length} of the Plants ${plants.map(plant => plant.label).join(', ')}`)
  unit = matches[0]!
  for (const plant of plants) {
    const { result } = await invoke(person, 'world.process-plant.signals.read', { plantId: plant.id, signals: [{ tagId: 'RX-TRIP-MAN' }] })
    tripPaths.set(plant.id, result.signals[0].signal.path)
  }
  breakersAtStart = await breakers(unit.id)
  if (!breakersAtStart.every(reading => reading.closed === true)) notes.push(`${unit.label} starts with a trip breaker open: ${JSON.stringify(breakersAtStart)}`)
  // E-0's steps in order, to name its steps by their ids.
  const document = (await invoke(person, 'world.procedure.document.read', { procedureId: 'E-0' })).result
  e0 = { steps: (document.steps as ReadonlyArray<any>).map(step => ({ id: step.id, label: step.label, tagIds: step.tagIds })) }

  // 2. A new Assistant Room from the leitbild-assistant definition, on the Run.
  const opened = await invoke(person, 'agents.assistance.create', { scope: { kind: 'resource', resource }, title: `Procedure probe${dry ? ' (dry)' : ''}` }, {})
  const roomId = opened.result.resource.id as string
  roomPath = `/api/workspaces/${workspaceId}/agents/rooms/${encodeURIComponent(roomId)}`
  const roomProfile = (await request(roomPath + '?limit=1')).profile
  const members = await request(roomPath + '/members')
  human = members.find((member: { kind: string }) => member.kind === 'human')
  agent = members.find((member: { kind: string }) => member.kind === 'ai')
  if (!human || !agent) stop('The Assistant Room lacks its person or its Assistant')
  const agentPath = `/api/workspaces/${workspaceId}/agents/agents/${encodeURIComponent(agent!.id)}`
  const patched = requestedModel === undefined && requestedEffort === undefined ? null : await request(agentPath, {
    ...(requestedModel === undefined ? {} : { model: requestedModel }),
    ...(requestedEffort === undefined ? {} : { reasoningEffort: requestedEffort }),
  }, 'PATCH')
  const profile = await request(agentPath)
  room = { id: roomId, name: roomProfile.name, sourceDefinition: roomProfile.sourceDefinition ?? null, agentId: agent!.id, model: profile.model, reasoningEffort: profile.reasoningEffort ?? null, skills: profile.skills, maxToolIterations: profile.maxToolIterations ?? null, modelStatus: patched?.modelStatus ?? null, modelInfo: profile.modelInfo ?? null }
  if (roomProfile.sourceDefinition?.id !== 'leitbild-assistant') stop(`The Room was created from ${roomProfile.sourceDefinition?.id ?? 'no definition'}, not leitbild-assistant`)
  if (!(profile.skills as ReadonlyArray<string>).includes('procedure-runner')) stop('The Assistant lacks the procedure-runner skill on this build')
  if (requestedModel !== undefined && profile.model !== requestedModel) stop(`The Agent's model reads ${profile.model} after setting ${requestedModel}`)
  if (requestedEffort !== undefined && profile.reasoningEffort !== requestedEffort) stop(`The Agent's reasoning effort reads ${profile.reasoningEffort ?? 'unset'} after setting ${requestedEffort}`)
  if (patched?.modelStatus === 'unavailable') stop(`The provider reports ${requestedModel} unavailable; the Agent would answer with a fallback model`)
  // No provider of this deployment may serve the model: the Agent would answer with another one, or not at all.
  if (profile.modelInfo?.source === 'no_eligible_route') {
    if (dry) notes.push(`no provider route serves ${profile.model} here (a dry run calls no model)`)
    else stop(`No provider route serves ${profile.model} on this deployment; the Agent would fall back to another model`)
  }
  pricing = pricingFor(requestedModel ?? profile.model)
  const setup = {
    origin, dry, workspaceId, run: resource, execution, unit, plants, tripPaths: Object.fromEntries(tripPaths), breakersAtStart, room,
    pricing: { ...pricing, budgetUsd, estimatesUsd: [0, 1].map(turn => usd(estimateUsd(pricing!.price, turn))) },
    e0: { source: document.source, steps: e0.steps },
    startedAt: new Date().toISOString(),
  }
  await save('setup', setup)
  console.log(JSON.stringify({ workspaceId, runId: resource.id, roomId, unit: unit.label, model: profile.model, pricedAs: pricing.model }))

  // 3. Turn 1: the order, and nothing else.
  if (dry) await standInTurn(0)
  else await ask(0, `Run E-0 on ${unitPhrase(unit.label)}`)

  // 4. Turn 2: "continue", while the AI still drives an active procedure on the unit.
  if (!dry && turnLimit === 2) {
    const driven = (await observe()).runs.filter(entry => entry.plantId === unit!.id && entry.status === 'active' && isAi(entry.driver?.actorId))
    if (driven.length > 0) await ask(1, 'continue')
    else notes.push('turn 2 not asked: no active procedure on the unit is driven by the AI')
  }
}

const isAi = (actorId: string | undefined | null): boolean => typeof actorId === 'string' && actorId.startsWith('actor:ai:')

try { await probe() }
catch (error) {
  if (error instanceof ProbeStop) stopReason = error.message
  else { errored = true; stopReason = `error: ${error instanceof Error ? error.message : String(error)}` }
}
if (target !== undefined) finalState = await observe().catch(error => { notes.push(`final observation failed: ${String(error)}`); return undefined })

// ---- Pass criteria ----
interface Criterion { readonly id: string; readonly label: string; readonly pass: boolean | null; readonly detail: string }
const criteria: Criterion[] = []
const add = (id: string, label: string, pass: boolean | null, detail: string) => criteria.push({ id, label, pass, detail })
const state = finalState
const run = state === undefined || unit === undefined ? undefined : e0RunOf(state)
const decisionOf = (index: number) => {
  const stepId = e0?.steps[index]?.id
  return stepId === undefined ? undefined : run?.stepStates.find(entry => entry.stepId === stepId)?.decision ?? undefined
}
const modelTurns = turns.filter(entry => entry.standIn !== true)
const allOperations = turns.flatMap(entry => entry.operations as ReadonlyArray<Record<string, any>>)
// What step 1's tags read while the breakers' own position feedback reads open (they stay open after the trip):
// a cited breaker reading shows them open when its value is that reading.
const openReference = run === undefined || unit === undefined || e0 === undefined ? { unavailable: 'no E-0 run' } : await (async () => {
  const now = await breakers(unit!.id)
  if (!now.every(reading => reading.closed === false)) return { unavailable: `the breakers do not read open: ${now.map(reading => `${reading.tagId} closed=${reading.closed}`).join(', ')}` }
  const view = stepSummary(await readStep(person, run.runId, e0!.steps[0]!.id))
  // As World records evidence: a two-state reading names its model variable ("reactorTripBreakerA.closed = false").
  const recorded = (tag: { readonly reading: string | null; readonly signal?: string }): string | null =>
    tag.reading === null ? null : tag.signal === undefined ? tag.reading : `${tag.signal} = ${tag.reading.split(' ')[0]}`
  return { readings: Object.fromEntries(view.tags.flatMap(tag => recorded(tag) === null ? [] : [[tag.id, recorded(tag)!]])) as Record<string, string>, tags: view.tags }
})().catch(error => ({ unavailable: `reading step 1 failed: ${String(error)}` }))

add('e0-driven-by-ai', `E-0 on ${unit?.label ?? unitLabel} started and driven by the AI`,
  run === undefined ? false : isAi(run.startedBy) && (run.status !== 'active' || isAi(run.driver?.actorId)),
  run === undefined ? 'no E-0 run' : `started by ${run.startedBy}; ${run.status}; driver ${run.driver?.actorId ?? 'none'}`)
{
  const writes = allOperations.filter(operation => operation.operationId === 'world.process-plant.control.write' && operation.success !== false && operation.ok !== false
    && operation.input?.plantId === unit?.id && (operation.input?.tagId === 'RX-TRIP-MAN' || operation.input?.path === tripPaths.get(unit?.id ?? '')))
  const proposals = state?.proposals.filter(proposal => proposal.plantId === unit?.id && proposal.origin === 'ai') ?? []
  const open = 'readings' in openReference
  add('trip-by-ai', 'the AI tripped the reactor itself, no proposal, and the breakers read open', writes.length >= 1 && proposals.length === 0 && open,
    `${writes.length} trip write(s); ${proposals.length} AI proposal(s); ${open ? 'breakers open' : (openReference as { unavailable: string }).unavailable}`)
}
{
  const decision = decisionOf(0)
  const breakerTags = (e0?.steps[0]?.tagIds ?? []).filter(tagId => /TRIP-BKR/.test(tagId))
  const cited = decision?.evidence ?? []
  const open = 'readings' in openReference ? openReference.readings : undefined
  // A decision's reading is the value as formatted, then any quality or caveat after "; ".
  const breakerReadings = breakerTags.map(tagId => ({ tagId, reading: cited.find((entry: { tagId: string }) => entry.tagId === tagId)?.reading as string | undefined }))
  const evidenced = open !== undefined && breakerReadings.length > 0 && breakerReadings.every(entry =>
    entry.reading !== undefined && open[entry.tagId] !== undefined && entry.reading.split(';')[0]!.trim() === open[entry.tagId])
  add('step-1-by-ai', 'step 1 Verified by the AI, with basis and breaker evidence reading open',
    decision === undefined ? false : isAi(decision.selectedBy) && decision.outcome === 'normal' && decision.basis !== null && evidenced,
    decision === undefined ? 'step 1 undecided'
      : `${decision.label ?? decision.branchIndex} by ${decision.selectedBy}; basis: ${decision.basis ?? 'none'}; evidence: ${cited.map((entry: { tagId: string; reading: string }) => `${entry.tagId}=${entry.reading}`).join(', ') || 'none'}`)
}
{
  const decision = decisionOf(1)
  add('untagged-step-2-by-ai', 'step 2 (no tags) decided by the AI on a stated basis', decision === undefined ? false : isAi(decision.selectedBy) && decision.basis !== null,
    decision === undefined ? 'step 2 undecided' : `${decision.label ?? decision.branchIndex} by ${decision.selectedBy}; basis: ${decision.basis ?? 'none'}`)
}
{
  const decided = run?.stepStates.filter(entry => entry.decision !== null && isAi(entry.decision.selectedBy)) ?? []
  const byPerson = run?.stepStates.filter(entry => entry.decision !== null && !isAi(entry.decision.selectedBy)) ?? []
  add('past-step-4', 'the AI decided more than four E-0 steps, a person none', decided.length > 4 && byPerson.length === 0,
    `${decided.length} AI-decided step(s): ${decided.map(entry => `${e0?.steps.find(step => step.id === entry.stepId)?.label ?? entry.stepId}:${entry.decision!.outcome ?? '?'}`).join(', ') || 'none'}; by a person: ${byPerson.length}; run ${run?.status ?? 'none'} at ${run?.currentStepId ?? 'none'}`)
}
{
  const changes = modelTurns.flatMap(entry => (entry.operations as ReadonlyArray<Record<string, any>>)
    .filter(operation => operation.success === true && ['world.procedure.run.transition', 'world.process-plant.control.write'].includes(operation.operationId)))
  const said = changes.filter(operation => typeof operation.say === 'string' && operation.say.length > 0)
  const lines = modelTurns.flatMap(entry => entry.progress as ReadonlyArray<string>)
  add('step-lines', 'every accepted transition and write carried a say line, posted as progress', dry ? null : changes.length > 0 && said.length === changes.length && lines.length >= said.length,
    dry ? 'n/a: no model turns in a dry run' : `${said.length}/${changes.length} changes with say; ${lines.length} progress line(s); first: ${lines[0] ?? 'none'}`)
}
{
  const long = modelTurns.filter(entry => String(entry.answer?.text ?? '').length > 900)
  add('short-answer', 'each answer at most 900 characters', dry ? null : modelTurns.length > 0 && long.length === 0,
    dry ? 'n/a' : modelTurns.map(entry => `turn ${entry.turn}: ${String(entry.answer?.text ?? '').length} chars`).join('; '))
}
{
  const forbidden = (operationId: string | null) => operationId !== null && operationId.split(',').some(id =>
    id === 'world.procedure.run.reset' || /^world\.simulation-run\.execution\.(?:set|advance)$/.test(id) || id === 'world.process-plant.action.invoke')
  const calls = modelTurns.flatMap(entry => [
    ...(entry.toolTrace as ReadonlyArray<{ operationId: string | null }>).map(row => row.operationId),
    ...(entry.operations as ReadonlyArray<{ operationId: string }>).map(row => row.operationId),
  ]).filter(forbidden)
  add('no-reset-time-or-instructor', 'no procedure reset, time control or instructor action', dry ? null : modelTurns.length === 0 ? false : calls.length === 0,
    dry ? 'n/a: no model turns in a dry run' : calls.length === 0 ? 'none' : [...new Set(calls)].join(', '))
}
add('cost', `total cost within $${budgetUsd}, no turn over twice its estimate`,
  dry ? null : turns.length > 0 && spentUsd <= budgetUsd && turns.every(entry => entry.costUsd !== null && (entry.costUsd <= 2 * entry.estimateUsd || entry.costUsd <= runawayFloorUsd)),
  dry ? 'n/a: a dry run calls no model' : `$${usd(spentUsd)} over ${turns.length} turn(s): ${turns.map(entry => `$${entry.costUsd ?? '?'} (estimate $${entry.estimateUsd})`).join(', ')}`)

const judged = criteria.filter(criterion => criterion.pass !== null)
const pass = !dry && stopReason === null && criteria.every(criterion => criterion.pass === true)
// A dry run proves the plumbing: the stand-in's start, trip and steps ran under World's AI rules.
const plumbing = dry ? { completed: stopReason === null, judgedHold: judged.every(criterion => criterion.pass === true) } : null
const summary = {
  origin, dry, workspaceId, unit: unit ?? unitLabel, room, model: room?.model ?? null, pricing, budgetUsd,
  spentUsd: usd(spentUsd), stopReason, errored, pass, ...(plumbing === null ? {} : { plumbing }),
  criteria, notes, openReference,
  turns: turns.map(entry => ({ turn: entry.turn, standIn: entry.standIn ?? false, model: entry.model, usage: entry.usage, costUsd: entry.costUsd, estimateUsd: entry.estimateUsd, wallMs: entry.wallMs ?? null, currentStepId: entry.procedure?.currentStepId ?? null, driver: entry.procedure?.driver ?? null, toolCalls: entry.toolTrace.length, progressLines: entry.progress.length })),
  finalProcedures: state?.runs.filter(entry => entry.plantId === unit?.id) ?? null,
  finishedAt: new Date().toISOString(),
}
await save('summary', summary)

const mark = (value: boolean | null) => value === null ? 'n/a ' : value ? 'PASS' : 'FAIL'
const width = Math.max(...criteria.map(criterion => criterion.label.length))
console.log('')
for (const criterion of criteria) console.log(`${mark(criterion.pass)}  ${criterion.label.padEnd(width)}  ${criterion.detail}`)
console.log('')
if (stopReason !== null) console.log(`Stopped: ${stopReason}`)
for (const note of notes) console.log(`Note: ${note}`)
console.log(dry
  ? `Dry run (no model): plumbing ${plumbing!.completed && plumbing!.judgedHold ? 'proven' : 'NOT proven'}; ${judged.filter(criterion => criterion.pass).length}/${judged.length} judged criteria hold with the stand-in. Evidence: ${directory}`
  : `${pass ? 'PASS' : 'FAIL'} · $${usd(spentUsd)} of $${budgetUsd} · evidence: ${directory}`)
process.exitCode = dry ? (plumbing!.completed && plumbing!.judgedHold ? 0 : 1) : pass ? 0 : 1
