/** Evaluation of AI-composed operator displays on the LOCAL stack (plan v3.1
 * §6). Creates only its own Workspace and Runs. Each scenario declares its Run
 * (scenarios.ts ScenarioRun): the probe copies a paused Run of that Scenario,
 * invokes the setup steps on the copy, plays simulated time, asks a fresh
 * Assistant Room one question and records what it presented, what every model
 * call cost and why any correction round ran.
 *
 *   LEITBILD_PROBE_ORIGIN=http://127.0.0.1:<port> \
 *   bun scripts/display-eval/probe.ts <stage> <absolute-output-dir> --agents-log=<stack dir>/agents.log \
 *     [--set=dev|smoke|near-duplicate|all] [--scenarios=<absolute module path>#<export>] [--request-display] [scenario-id ...]
 *
 * --set picks the repository scenarios (default dev); --scenarios runs the
 * scenarios a module outside the repository exports instead (the private
 * hold-out). --request-display asks for a display after every answer that
 * showed none, as the "Show display" action under an answer does.
 *
 * After every answer it reads the Run's operation proposals; for an operation
 * question it also judges whether the answer proposes what it should, claims
 * nothing executed, says what awaits a person and, where the operation upsets
 * the unit, warns of it. It never decides a proposal.
 *
 * The origin must be a loopback stack (bun run dev:stack --models): the probe
 * never runs against production. Model and upstream are pinned: every call's
 * model and OpenRouter upstream are checked against --model and --upstream
 * (defaults openai/gpt-6-sol and OpenAI) and a mismatch is recorded on the
 * scenario. The probe never reads credentials; costs come from the Agents
 * log's per-call usage.cost. Results are evidence for review, not fixtures.
 */
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { allScenarios, devScenarios, fixturePath, loadScenarioModule, runRequests, smokeScenarios, type EvalScenario, type ScenarioRun } from './scenarios.ts'
import { vignetteEvidenceOf, scoreKey, addedEvidenceUse, answerProse, type ComposeRecord, type KeyResult } from './decisive.ts'
import { correctionsIn, type Correction } from './corrections.ts'
import { callsBetween, logOffset, summariseCalls, type ModelCall } from './billing.ts'
import { referencePlantCatalog } from './plant-catalog.ts'
import { operationChecks } from './operation-checks.ts'
import { worryVerdict } from './worry.ts'

const usage = 'Usage: LEITBILD_PROBE_ORIGIN=http://127.0.0.1:<port> bun scripts/display-eval/probe.ts <stage> <absolute-output-dir> --agents-log=<path> [--set=dev|smoke|near-duplicate|all] [--scenarios=<abs module>#<export>] [--model=<id>] [--upstream=<name>] [--request-display] [scenario-id ...]'
const [stage, directory, ...rest] = Bun.argv.slice(2)
if (!stage || !/^[a-z0-9-]+$/.test(stage) || !directory || !isAbsolute(directory)) throw new Error(usage)
const option = (name: string): string | undefined => rest.find(argument => argument.startsWith(`--${name}=`))?.slice(name.length + 3)
const agentsLog = option('agents-log')
if (agentsLog === undefined || !isAbsolute(agentsLog) || !await Bun.file(agentsLog).exists()) throw new Error(`--agents-log must name the local stack's agents.log. ${usage}`)
const pinnedModel = option('model') ?? 'openai/gpt-6-sol'
const pinnedUpstream = option('upstream') ?? 'OpenAI'
const requestDisplays = rest.includes('--request-display')
const selected = rest.filter(argument => !argument.startsWith('--'))
const external = option('scenarios')
const pool: ReadonlyArray<EvalScenario> = external !== undefined
  ? await (async () => {
    const [path, exportName] = external.split('#')
    if (!path || !isAbsolute(path) || !exportName) throw new Error(`--scenarios takes <absolute module path>#<export>. ${usage}`)
    return loadScenarioModule(path, exportName)
  })()
  : (() => {
    const set = option('set') ?? 'dev'
    if (set === 'dev') return selected.length === 0 ? devScenarios : allScenarios
    if (set === 'all') return allScenarios
    if (set === 'smoke') return smokeScenarios
    if (set === 'near-duplicate') return allScenarios.filter(scenario => scenario.set === 'near-duplicate')
    throw new Error(`Unknown --set ${set}. ${usage}`)
  })()
const unknown = selected.filter(id => !pool.some(scenario => scenario.id === id))
if (unknown.length > 0) throw new Error(`Unknown scenarios: ${unknown.join(', ')}`)
const chosen = selected.length === 0 ? pool : pool.filter(scenario => selected.includes(scenario.id))
const origin = process.env.LEITBILD_PROBE_ORIGIN
if (origin === undefined || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)) {
  throw new Error('LEITBILD_PROBE_ORIGIN must be a loopback local stack; the display evaluation never runs against production')
}
const catalog = referencePlantCatalog()
await mkdir(directory, { recursive: true })
if (await Bun.file(join(directory, `${stage}-summary.json`)).exists()) throw new Error('Stage already exists; choose a new stage name, do not overwrite evidence')

const request = async (path: string, body?: unknown, method = 'POST'): Promise<any> => {
  const response = await fetch(origin + path, {
    ...(body === undefined ? {} : { method, body: JSON.stringify(body) }),
    headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120_000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text.slice(0, 400)}`)
  return JSON.parse(text)
}
const save = (name: string, value: unknown) => Bun.write(join(directory, `${name}.json`), JSON.stringify(value, null, 2))
const actor = { kind: 'human', id: 'display-probe', displayName: 'Display probe' }
const invoke = (workspaceId: string, operationId: string, input: unknown, target: Record<string, unknown> = {}) =>
  request(`/api/workspaces/${workspaceId}/capabilities/${operationId}/invoke`, { ...target, input, actor })

// One Workspace and one paused seed Run per Scenario and output directory; every scenario works on its own copy.
const seedFile = Bun.file(join(directory, 'seed.json'))
const seeds: { workspaceId: string; runs: Record<string, Record<string, string>> } = await seedFile.exists() ? await seedFile.json()
  : { workspaceId: (await request('/api/workspaces', { name: 'Operator display evaluation (local)' })).workspace.id, runs: {} }
const { workspaceId } = seeds
const seedOf = async (scenario: string): Promise<Record<string, string>> => {
  if (seeds.runs[scenario] !== undefined) return seeds.runs[scenario]!
  // A repository fixture is saved in this Workspace only: it is never a product Scenario.
  const fixture = fixturePath(scenario)
  const source = fixture === null ? null : await Bun.file(fixture).json()
  if (source !== null && `fixture:${source.id}` !== scenario) throw new Error(`${fixture} holds Scenario ${source.id}, not ${scenario}`)
  if (source !== null) await invoke(workspaceId, 'world.scenario.create', { source })
  const { definitions } = await request(`/api/workspaces/${workspaceId}/definitions`)
  const definition = definitions.find((entry: { ref: { id: string } }) => entry.ref.id === (source?.id ?? scenario))
  if (!definition) throw new Error(`Scenario ${scenario} is absent`)
  const launched = await invoke(workspaceId, 'world.scenario.start', {}, { definition: { ...definition.ref, revisionId: definition.currentRevisionId } })
  const resource = launched.createdResources?.find((entry: { type: string }) => entry.type === 'world.simulation-run') ?? launched.result?.resource
  if (!resource) throw new Error('Launch did not return a Simulation Run reference')
  await invoke(workspaceId, 'world.simulation-run.execution.set', { playback: 'paused' }, { resource })
  seeds.runs[scenario] = resource
  await save('seed', seeds)
  return resource
}

const presence = (runId: string) => request(`/api/workspaces/${workspaceId}/world/simulation-runs/${encodeURIComponent(runId)}/presence`)

const simulationMs = async (resource: Record<string, string>) => Date.parse((await presence(resource.id!)).execution.currentSimulationTime)
const ADVANCE = 'world.simulation-run.execution.advance'

/**
 * Sends the scenario's Run requests (runRequests) on its copy, waiting out an
 * advance, then plays realtime minutes when the Run declares that pace. Returns
 * the first refusal: the scenario's defect, recorded and not scored.
 */
const prepare = async (resource: Record<string, string>, run: ScenarioRun): Promise<string | null> => {
  for (const [at, step] of runRequests(run).entries()) {
    const before = await simulationMs(resource)
    const refused = await invoke(workspaceId, step.operationId, step.input, { resource }).then(() => null, (error: unknown) => `request ${at} (${step.operationId}): ${String(error).slice(0, 600)}`)
    if (refused !== null) return refused
    if (step.operationId === ADVANCE) await reach(resource, before + Number(step.input.minutes) * 60_000, false)
  }
  if (run.pace === 'realtime' && run.advanceMinutes !== undefined) {
    const before = await simulationMs(resource)
    await invoke(workspaceId, 'world.simulation-run.execution.set', { playback: 'playing', pace: 'realtime' }, { resource })
    await reach(resource, before + run.advanceMinutes * 60_000, true)
  }
  return null
}

// Waits until the Run stands at or past `target` (pausing it there when it plays in realtime). Probe patience, not a product limit.
const reach = async (resource: Record<string, string>, target: number, realtime: boolean): Promise<void> => {
  const deadline = Date.now() + 300_000 + (realtime ? target - await simulationMs(resource) : 0)
  while (Date.now() < deadline) {
    const state = await presence(resource.id!)
    const at = Date.parse(state.execution.currentSimulationTime)
    if (realtime && at >= target) { await invoke(workspaceId, 'world.simulation-run.execution.set', { playback: 'paused' }, { resource }); return }
    if (state.execution.playback === 'paused' && at >= target) return
    await Bun.sleep(realtime ? 1_000 : 2_000)
  }
  throw new Error(`Run ${resource.id} did not reach ${new Date(target).toISOString()} within the probe deadline`)
}

/** The display Capability: World's vignette composer (the swap deleted the Plant's composer). */
const WORLD_COMPOSE = 'world.simulation-run.display.compose'

interface ComposeOutcome {
  readonly accepted: boolean
  readonly panels: ReadonlyArray<string>
  readonly signals: ReadonlyArray<string>
  readonly mimics: ReadonlyArray<Record<string, unknown>>
  readonly subjects: ReadonlyArray<string>
  readonly record: ComposeRecord
  readonly error?: string
  /** A World vignette's compiled view, fetched when it draws a topology. */
  readonly view?: any
}

/** One operation a workspace_call of the turn issued, with its batch result. */
interface TurnOperation { readonly operationId: string; readonly input: any; readonly result: any }

// Every operation the answer's turn issued, from its own execution evidence, in call order.
const turnOperations = async (roomId: string, turnId: string): Promise<ReadonlyArray<TurnOperation>> => {
  const turn = await request(`/api/workspaces/${workspaceId}/agents/rooms/${roomId}/executions/${turnId}`)
  const operations: TurnOperation[] = []
  for (const summary of turn.calls ?? []) {
    if (summary.tool !== 'workspace_call') continue
    const call = await request(`/api/workspaces/${workspaceId}/agents/rooms/${roomId}/executions/${turnId}/calls/${summary.id}`)
    const results = call.result?.data?.results ?? []
    for (const entry of call.arguments?.calls ?? []) {
      operations.push({ operationId: entry.operationId, input: entry.input, result: results.find((candidate: { key: string }) => candidate.key === entry.key) })
    }
  }
  return operations
}

// Exact compose inputs and outcomes. Full refusal texts are kept: a cut refusal hides its class.
// A vignette's compiled view (POST displays/view, as a person opens it) for each accepted World compose that draws a
// topology: which elements it draws, so a key on a drawn element counts and an operation's equipment is "around".
const withDrawings = async (resource: Record<string, string>, outcomes: ReadonlyArray<ComposeOutcome>): Promise<ReadonlyArray<ComposeOutcome>> => Promise.all(outcomes.map(async outcome => {
  const state = outcome.record.result?.data?.view?.state
  if (!outcome.accepted || typeof state !== 'string' || !(JSON.parse(state).views ?? []).some((view: { kind: string }) => view.kind === 'topology')) return outcome
  const view = await request(`/api/workspaces/${workspaceId}/world/simulation-runs/${encodeURIComponent(resource.id!)}/displays/view`, { state })
    .then(body => body.view, (error: unknown) => ({ error: String(error).slice(0, 300) }))
  const drawn = (view?.sections ?? []).filter((section: any) => section.kind === 'topology').flatMap((section: any) => section.nodes.flatMap((node: any) => typeof node.element === 'string' ? [node.element] : []))
  return { ...outcome, mimics: [{ drawn }], view, record: { ...outcome.record, drawn } }
}))

const composeOutcomesOf = (operations: ReadonlyArray<TurnOperation>): ReadonlyArray<ComposeOutcome> =>
  operations.filter(operation => operation.operationId === WORLD_COMPOSE).map(({ input, result }) => {
    const accepted = result?.success === true && typeof result.viewRef === 'string'
    const record = { input, result }
    const evidence = accepted ? vignetteEvidenceOf(record) : null
    return {
      accepted,
      panels: evidence?.panels ?? ((input?.views ?? []) as ReadonlyArray<{ kind: string }>).map(view => view.kind),
      mimics: [],
      subjects: ((input?.subjects ?? []) as ReadonlyArray<unknown>).map(subject => typeof subject === 'string' ? subject : JSON.stringify(subject)),
      signals: evidence === null ? [] : [...evidence.refs ?? []],
      record,
      ...(accepted ? {} : { error: String(result?.error ?? 'no result') }),
    }
  })

// Each control.propose the turn attempted (a write, or an actuation's reset by rule id), and whether World recorded it
// (its command id is the proposal's id), with the consequence it returned, or refused it.
const proposeAttemptsOf = (operations: ReadonlyArray<TurnOperation>) =>
  operations.filter(operation => operation.operationId === 'world.process-plant.control.propose').map(({ input, result }) => ({
    target: input?.tagId ?? input?.path ?? input?.reset ?? null,
    ...(typeof input?.reset === 'string' ? { reset: true } : {}),
    value: input?.value ?? null,
    reason: input?.reason ?? null,
    procedureStep: input?.procedureStep ?? null,
    evidence: input?.evidence ?? [],
    accepted: result?.success === true && result?.data?.ok === true,
    ...(result?.success === true && typeof result?.data?.commandId === 'string' ? { proposalId: result.data.commandId as string } : {}),
    ...(result?.success === true && typeof result?.data?.consequence?.text === 'string' ? { consequence: result.data.consequence.text as string } : {}),
    ...(result?.success === true ? {} : { error: String(result?.error ?? 'no result').slice(0, 400) }),
  }))

// What World holds after the answer: every proposal each Plant of the Run keeps, read as the probe (a query; the probe never decides).
const readProposals = async (resource: Record<string, string>) => {
  const { objects } = await request(`/api/workspaces/${workspaceId}/world/simulation-runs/${encodeURIComponent(resource.id!)}/objects`)
  const plants = (objects as ReadonlyArray<{ id: string; packId: string }>).filter(object => object.packId === 'process-plant').map(object => object.id)
  const read = await Promise.all(plants.map(async plantId => ({ plantId, result: (await invoke(workspaceId, 'world.process-plant.control.proposals', { plantId }, { resource })).result })))
  // A proposal is a write, or an actuation's reset, which has no path or value.
  const entries = read.flatMap(({ plantId, result }) => (result.proposals as ReadonlyArray<{ proposal: any; review?: any }>).map(({ proposal, review }) => ({
    plantId,
    id: proposal.id as string,
    item: proposal.item as string,
    path: (proposal.write?.path ?? null) as string | null,
    value: (proposal.write?.value ?? null) as number | boolean | null,
    ...(proposal.reset === undefined ? {} : { reset: proposal.reset.ruleId as string }),
    word: proposal.word as string,
    consequence: (proposal.consequence?.text ?? null) as string | null,
    status: proposal.status as string,
    origin: proposal.proposer.origin as string,
    reason: proposal.reason as string,
    procedureStep: proposal.procedureStep ?? null,
    evidence: (proposal.evidence as ReadonlyArray<{ tagId: string }>).map(entry => entry.tagId),
    ...(review === undefined ? {} : { permitted: review.permitted as boolean, ...(review.refusal === undefined ? {} : { refusal: review.refusal as string }) }),
  })))
  return {
    plantElapsedMs: Object.fromEntries(read.map(({ plantId, result }) => [plantId, result.plantElapsedMs as number])),
    count: entries.length,
    controls: entries.map(entry => entry.path),
    values: entries.map(entry => entry.value),
    status: entries.map(entry => entry.status),
    entries,
  }
}

// A consequence line as World words it, and the protection rules it names as may actuate.
const consequenceLine = (line: any): { readonly text: string; readonly mayActuate: ReadonlyArray<string> } | null =>
  line === null || line === undefined ? null : { text: line.text as string, mayActuate: (line.mayActuate as ReadonlyArray<{ label: string }>).map(rule => rule.label) }

// The equipment's controls as a person sees them now: each option's word, the trips it sets going, what it takes away
// (its consequence line, in option order), and what holds it; and every latched actuation's RESET, offered or why not.
const readControls = async (resource: Record<string, string>, plantId: string, equipment: string) => {
  const { result } = await invoke(workspaceId, 'world.process-plant.controls.list', { plantId, items: [equipment] }, { resource })
  const items = (result.items as ReadonlyArray<any>).map(item => ({
    id: item.id,
    label: item.label,
    offered: (item.offered as ReadonlyArray<any>).map(listed => ({
      tagId: listed.control?.tagId ?? null,
      path: listed.control?.path ?? null,
      form: listed.control?.form ?? null,
      ...(listed.now === undefined ? {} : { now: listed.now }),
      ...(listed.throttledUnder === undefined ? {} : { throttledUnder: (listed.throttledUnder as ReadonlyArray<{ label: string }>).map(rule => rule.label) }),
      ...(listed.throttleLine === undefined ? {} : { throttleLine: consequenceLine(listed.throttleLine) }),
      options: ((listed.control?.options ?? []) as ReadonlyArray<any>).map((option, index) => ({
        word: option.word,
        value: option.value,
        consequences: ((option.consequences ?? []) as ReadonlyArray<{ label: string }>).map(rule => rule.label),
        consequenceLine: consequenceLine(listed.consequenceLines?.[index]),
        heldBy: listed.standing?.[index]?.heldBy?.label ?? null,
      })),
    })),
    withheld: item.withheld,
  }))
  const resets = (result.resets as ReadonlyArray<any>).map(reset => ({
    ruleId: reset.ruleId as string,
    label: reset.label as string,
    offered: reset.offered as boolean,
    ...(reset.reason === undefined ? {} : { reason: reset.reason as string }),
  }))
  return { items, resets }
}

const viewFence = (content: string): string | null => /```leitbild-view\n(view \S+)\n```/.exec(content)?.[1] ?? null
const wordsIn = (content: string): number => answerProse(content).split(/\s+/).filter(word => /[\p{L}\p{N}]/u.test(word)).length

/**
 * The answer of the turn a message started: the message its execution record
 * names once the turn is over. An interim line the turn posted (a `say` beside
 * control.propose) is never taken for the answer; it is kept on record.
 */
const nextAnswer = async (roomId: string, roomPath: string, prior: ReadonlySet<string>, agentId: string, label: string): Promise<{ answer: any; interim: ReadonlyArray<any> }> => {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 300_000) { // Probe deadline, not a product limit.
    const messages = (await request(roomPath + '?limit=100')).messages as ReadonlyArray<any>
    // A progress line (a `say` beside an operation) is never the answer; Agents marks it `progress: true`.
    const fresh = messages.filter(message => !prior.has(message.id) && message.senderId === agentId && message.progress !== true)
    const traced = fresh.find(message => typeof message.generationTraceId === 'string')
    if (traced !== undefined) {
      const { turn } = await request(`/api/workspaces/${workspaceId}/agents/rooms/${roomId}/executions/${traced.generationTraceId}`)
      const answer = turn.status === 'running' ? undefined : messages.find(message => message.id === turn.messageId)
      if (answer !== undefined) return { answer, interim: messages.filter(message => !prior.has(message.id) && message.senderId === agentId && message.id !== answer.id) }
    } else {
      const failed = fresh.find(message => message.type === 'error' || message.type === 'pass')
      if (failed !== undefined) return { answer: failed, interim: [] }
    }
    await Bun.sleep(2_000)
  }
  throw new Error(`No answer for ${label} within the probe deadline`)
}

/** What one answer cost and why it was corrected: its model calls from the Agents log and the corrections in its generation query. */
const turnCosts = async (roomId: string, answer: any, calls: ReadonlyArray<ModelCall>) => {
  const billing = summariseCalls(calls)
  let corrections: ReadonlyArray<Correction> | null = null
  let correctionsError: string | undefined
  if (answer.type === 'chat') {
    try {
      const record = await request(`/api/workspaces/${workspaceId}/agents/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(answer.id)}/generation-query`)
      corrections = correctionsIn(record.query.messages)
    } catch (error) { correctionsError = String(error).slice(0, 400) }
  }
  const pinViolations = [
    ...(answer.model === undefined || answer.model === pinnedModel ? [] : [`model ${answer.model}`]),
    ...calls.filter(call => call.upstream !== pinnedUpstream).map(call => `upstream ${call.upstream ?? 'unreported'} (${call.source})`),
  ]
  return {
    model: answer.model ?? null,
    modelCalls: answer.modelCalls ?? null,
    toolCalls: (answer.toolTrace ?? []).length,
    loggedCalls: billing.calls,
    generationMs: answer.generationMs ?? null,
    promptTokens: answer.promptTokens ?? null,
    completionTokens: answer.completionTokens ?? null,
    cacheRead: answer.cacheRead ?? null,
    cacheCreation: answer.cacheCreation ?? null,
    costUsd: billing.costUsd,
    unbilledCalls: billing.unbilledCalls,
    upstreams: billing.upstreams,
    pinViolations,
    words: wordsIn(answer.content ?? ''),
    corrections,
    ...(correctionsError === undefined ? {} : { correctionsError }),
    calls,
  }
}

// Asks the answer's author for a display, as the "Show display" action does,
// and records what the reply presents and what it cost.
const requestDisplay = async (roomId: string, roomPath: string, human: { id: string }, agentId: string, answer: { id: string }, label: string) => {
  const prior = new Set<string>((await request(roomPath + '?limit=100')).messages.map((message: { id: string }) => message.id))
  const offset = await logOffset(agentsLog)
  const startedAt = Date.now()
  const accepted = await request(`/api/workspaces/${workspaceId}/agents/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(answer.id)}/display-request`, { requesterId: human.id })
  const { answer: reply, interim } = await nextAnswer(roomId, roomPath, prior, agentId, `${label} display request`)
  const wallMs = Date.now() - startedAt
  await Bun.sleep(1_500) // the last [llm] line lands after the reply is posted
  const costs = await turnCosts(roomId, reply, await callsBetween(agentsLog, offset, await logOffset(agentsLog)))
  const composes = reply.generationTraceId ? composeOutcomesOf(await turnOperations(roomId, reply.generationTraceId)) : []
  const cards = reply.generationTraceId ? (await request(`/api/workspaces/${workspaceId}/agents/rooms/${roomId}/executions/${reply.generationTraceId}/cards`)).cards : []
  return {
    reply,
    interim,
    cards,
    composes: composes.map(outcome => outcome.record),
    row: {
      queued: accepted.queued,
      type: reply.type,
      cause: reply.cause ?? null,
      repliesToAnswer: reply.inReplyTo?.[0] === answer.id,
      displayed: viewFence(reply.content) !== null,
      composeCalls: composes.length,
      validWithinTwo: composes.length === 0 ? null : composes.slice(0, 2).some(outcome => outcome.accepted),
      panels: composes.filter(outcome => outcome.accepted).at(-1)?.panels ?? [],
      signals: composes.filter(outcome => outcome.accepted).at(-1)?.signals ?? [],
      rejections: composes.filter(outcome => !outcome.accepted).map(outcome => outcome.error),
      wallMs,
      ...costs,
      calls: undefined,
      replyChars: reply.content.length,
    },
    calls: costs.calls,
  }
}

const rows: Array<Record<string, unknown>> = []
for (const scenario of chosen) {
  const copy = await invoke(workspaceId, 'world.simulation-run.copy', { name: `Display probe · ${stage} · ${scenario.id}` }, { resource: await seedOf(scenario.run.scenario) })
  const resource = copy.createdResources?.find((entry: { type: string }) => entry.type === 'world.simulation-run') ?? copy.result?.resource
  if (!resource) throw new Error('Copy did not return a Simulation Run reference')
  const prepareStarted = Date.now()
  const refused = await prepare(resource, scenario.run)
  if (refused !== null) {
    const row = { id: scenario.id, set: scenario.set, flaky: scenario.flaky, expect: scenario.expect, answerType: 'setup-refused', setupError: refused, runId: resource.id }
    rows.push(row)
    await save(`${stage}-${scenario.id}`, { scenario, row })
    await Bun.write(join(directory, `${stage}-rows.jsonl`), rows.map(entry => JSON.stringify(entry)).join('\n') + '\n')
    console.log(JSON.stringify({ id: scenario.id, setupRefused: refused }))
    continue
  }
  const prepareWallMs = Date.now() - prepareStarted
  const opened = await invoke(workspaceId, 'agents.assistance.open', { scope: { kind: 'resource', resource }, title: `Display probe · ${scenario.id}`, focusedSubjects: [resource] })
  if (opened.result.reused) throw new Error('Probe requires a fresh Room per scenario')
  const roomId = opened.result.resource.id as string
  const roomPath = `/api/workspaces/${workspaceId}/agents/rooms/${roomId}`
  const members = await request(roomPath + '/members')
  const human = members.find((member: { kind: string }) => member.kind === 'human')
  const agent = members.find((member: { kind: string }) => member.kind === 'ai')
  // The Room already holds the Assistant's join notice; only a new chat reply counts.
  const prior = new Set<string>((await request(roomPath + '?limit=100')).messages.map((message: { id: string }) => message.id))
  const offset = await logOffset(agentsLog)
  const startedAt = Date.now()
  await request(`/api/workspaces/${workspaceId}/agents/messages`, { senderId: human.id, senderName: human.name, content: scenario.prompt, target: { rooms: [roomId] } })
  const { answer, interim } = await nextAnswer(roomId, roomPath, prior, agent.id, scenario.id)
  const wallMs = Date.now() - startedAt
  await Bun.sleep(1_500) // the last [llm] line lands after the answer is posted
  const answerCalls = await callsBetween(agentsLog, offset, await logOffset(agentsLog))
  const costs = await turnCosts(roomId, answer, answerCalls)
  const fence = viewFence(answer.content)
  const operations = answer.generationTraceId ? await turnOperations(roomId, answer.generationTraceId) : []
  const composes = await withDrawings(resource, composeOutcomesOf(operations))
  const accepted = composes.filter(outcome => outcome.accepted)
  const presented = fence === null ? null : accepted.at(-1) ?? null
  const display = presented === null ? null : vignetteEvidenceOf(presented.record, presented.view)
  // The turn's cards as its answer cites them (re-keyed in dispatch order), for the citation measures (T10, T34).
  const cards = answer.generationTraceId ? (await request(`/api/workspaces/${workspaceId}/agents/rooms/${roomId}/executions/${answer.generationTraceId}/cards`)).cards : []
  const decisive: ReadonlyArray<KeyResult> = scenario.evidence.map(key => key.use === 'P0'
    ? scoreKey(key, display, answer.content, catalog)
    : { key: key.key, kind: key.kind, use: key.use, hit: null, hits: [], unknown: [] })
  const scoredSignals = decisive.filter(result => result.kind === 'signal' && result.use === 'P0')
  // Every scenario's Run is read for proposals, so one the agent made unasked is on record too.
  const proposals = await readProposals(resource)
  // A listing World refuses is recorded with its reason; the operation is still judged on the answer and the proposals.
  const controls = scenario.operation === undefined ? null : await readControls(resource, scenario.operation.plantId, scenario.operation.equipment)
    .then(listed => listed, (error: unknown) => ({ items: [], resets: [], error: String(error).slice(0, 400) }))
  const operation = scenario.operation === undefined || controls === null ? null
    : operationChecks(scenario.operation, answer.type === 'chat', answer.content, proposals, proposeAttemptsOf(operations), accepted, fence !== null, controls.items)
  const row = {
    id: scenario.id,
    set: scenario.set,
    flaky: scenario.flaky,
    expect: scenario.expect,
    answerType: answer.type,
    displayed: fence !== null,
    correct: scenario.expect === 'either' ? null : (fence !== null) === (scenario.expect === 'display'),
    composeCalls: composes.length,
    cardItems: (cards as ReadonlyArray<{ card: { items: ReadonlyArray<unknown> } }>).reduce((sum, entry) => sum + entry.card.items.length, 0),
    firstComposeAccepted: composes.length === 0 ? null : composes[0]!.accepted,
    // A refusal names fixes known to fit; the owner counts a display the agent fixes on its next call as valid.
    validWithinTwo: composes.length === 0 ? null : composes.slice(0, 2).some(outcome => outcome.accepted),
    subjects: presented?.subjects ?? [],
    panels: presented?.panels ?? [],
    signals: presented?.signals ?? [],
    keyPanelHit: scenario.keyPanel === undefined || fence === null ? null : (presented?.panels ?? []).includes(scenario.keyPanel),
    mimic: scenario.mimic ?? null,
    mimicShown: (presented?.panels ?? []).includes('mimic'),
    mimicIntents: presented?.mimics ?? [],
    drawnEquipment: display === null ? [] : [...display.drawn],
    rejections: composes.filter(outcome => !outcome.accepted).map(outcome => outcome.error),
    decisive,
    decisiveSignalKeys: scoredSignals.length,
    decisiveSignalHits: scoredSignals.filter(result => result.hit === true).length,
    decisivePass: scenario.expect !== 'display' || scoredSignals.length === 0 ? null : fence !== null && scoredSignals.every(result => result.hit === true),
    staleKeyNames: [...new Set(decisive.flatMap(result => result.unknown))],
    ...(scenario.set === 'worry' ? { worry: answer.type === 'chat' ? worryVerdict(scenario.evidence, answer.content) : null } : {}),
    addedEvidence: display === null ? [] : addedEvidenceUse(display, answer.content),
    prepareWallMs,
    wallMs,
    interimMessages: interim.length,
    answerChars: answer.content.length,
    ...costs,
    calls: undefined,
    correctionRounds: costs.corrections === null ? null : costs.corrections.length,
    roomId,
    runId: resource.id,
    proposals: { count: proposals.count, controls: proposals.controls, values: proposals.values, status: proposals.status },
    ...(operation === null ? {} : {
      operation: { ...operation, proposals: undefined },
      falseProposal: operation.falseProposal,
      executionClaim: operation.executionClaim,
      operationCorrect: operation.operationCorrect,
    }),
  }
  const requested = requestDisplays && fence === null && answer.type === 'chat'
    ? await requestDisplay(roomId, roomPath, human, agent.id, answer, scenario.id)
    : null
  const fullRow = requested === null ? row : {
    ...row,
    requested: { ...requested.row, expected: scenario.requested ?? null, correct: scenario.requested === undefined ? null : requested.row.displayed === (scenario.requested === 'display') },
  }
  rows.push(fullRow)
  await save(`${stage}-${scenario.id}`, {
    scenario, row: fullRow, answer, interim, calls: answerCalls, composes: composes.map(outcome => outcome.record), cards, proposals,
    ...(operation === null ? {} : { operation, controls }),
    ...(requested === null ? {} : { requestedReply: requested.reply, requestedInterim: requested.interim, requestedCalls: requested.calls, requestedCards: requested.cards, requestedComposes: requested.composes }),
  })
  await Bun.write(join(directory, `${stage}-rows.jsonl`), rows.map(entry => JSON.stringify(entry)).join('\n') + '\n')
  console.log(JSON.stringify({ id: fullRow.id, displayed: fullRow.displayed, correct: fullRow.correct, decisive: `${fullRow.decisiveSignalHits}/${fullRow.decisiveSignalKeys}`, ...('worry' in fullRow ? { worry: fullRow.worry?.pass ?? null } : {}), modelCalls: fullRow.modelCalls, corrections: fullRow.correctionRounds, wallMs, costUsd: fullRow.costUsd, pin: fullRow.pinViolations }))
}

const { summariseRows } = await import('./report.ts')
const summary = { stage, origin, pinnedModel, pinnedUpstream, ...summariseRows(rows as never), rows }
await save(`${stage}-summary`, summary)
console.log(JSON.stringify({ ...summary, rows: undefined }, null, 2))
