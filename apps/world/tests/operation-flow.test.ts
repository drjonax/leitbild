import { newWorkspaceId } from '@leitbild/contracts'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorldApplicationAssembly } from '../src/app-assembly.ts'
import { displayRunOf } from '../src/core/api/display-capabilities.ts'
import type { ActorId, IsoTimestamp, ObjectId, SimulationRunId } from '../src/core/model/index.ts'
import { scenarioAuthoringCatalogFor } from '../src/core/scenarios/authoring.ts'
import { compileScenarioDefinition } from '../src/core/scenarios/compiler.ts'
import { createScenarioRuntimeResolver } from '../src/core/scenarios/runtime-resolver.ts'
import type { Actor } from '../src/core/simulation-runs/actors.ts'
import { createSimulationRunRegistry, type SimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import type { SimulationRunRuntime } from '../src/core/simulation-runs/runtime.ts'
import { composeDefault } from '../src/features/displays/compose/compose.ts'
import { compileVignette, type ViewRun } from '../src/features/displays/compose/view.ts'
import processPlantEmbed from '../src/packs/process-plant/ui/embed.ts'
import { operatedItems, readElementOperation } from '../src/packs/process-plant/ui/displays/operation/element-operation.ts'
import { createOperationClient, type OperationClient } from '../src/packs/process-plant/ui/displays/operation/operation-client.ts'
import { itemControlView, operationNow, proposalCard, shownProposal } from '../src/packs/process-plant/ui/displays/operation/operation-presenter.ts'
import { reviewSubject } from '../src/packs/process-plant/ui/displays/window/window-operations.ts'
import { createDirectRoutingAdapter } from '../src/routing/direct-adapter.ts'
import { builtinScenarioDefinitions } from '../src/scenarios/definitions.ts'
import { guardPlantTests } from './plant-hang-guard.ts'

guardPlantTests()

// E2 item 5: the operation flow end to end, at the highest level a test here
// reaches without a browser: the units the window and the embed run, over a
// Run in process. An AI agent proposes; the proposal's review subject (the
// window's chip, the chat card's Review, both `<plant>#<item>`) composes the
// item's World default, which draws the item as an element of the Plant's
// flow; its pop-over's Pack actions read what ElementActions reads and show
// the pending card with approve, beside select-check-execute; a person
// approves through the same client, and the command executes and is logged.

const routing = createDirectRoutingAdapter()
const assembly = createWorldApplicationAssembly({ routing })
const person: Actor = { id: 'actor:human:flow-operator' as ActorId, label: 'Flow operator', role: 'operator' }
const agent: Actor = { id: 'actor:ai:flow-agent' as ActorId, label: 'Flow agent', role: 'ai_agent' }
const plantId = 'plant:halden-1' as ObjectId
const item = 'pressurizer.blockValve'

let registry: SimulationRunRegistry
let dataDir: string
let runtime: SimulationRunRuntime
let run: ViewRun
let runId: SimulationRunId

/** The pop-over's client, as a person's screen reaches the Run: the operation client over this Run in process. */
const clientFor = (actor: Actor): OperationClient => createOperationClient({
  query: async <T,>(_runId: SimulationRunId, capabilityId: string, input: unknown): Promise<T> => {
    const outcome = await runtime.invokeCapability(actor, { capabilityId, input })
    if (outcome.kind !== 'query') throw new Error(`${capabilityId} is not a query`)
    return outcome.result as T
  },
  command: async (_runId, capabilityId, input) => {
    const outcome = await runtime.invokeCapability(actor, { capabilityId, input })
    if (outcome.kind !== 'command') throw new Error(`${capabilityId} is not a command`)
    return outcome.result.ok ? { ok: true, commandId: outcome.result.commandId } : { ok: false, reason: outcome.result.reason }
  },
})

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'leitbild-operation-flow-'))
  registry = createSimulationRunRegistry({
    dataDir, workspaceId: newWorkspaceId(), scenarioDefinitions: builtinScenarioDefinitions,
    compileScenarioDefinition: source => compileScenarioDefinition(source, assembly.packs, { routing }),
    scenarioAuthoringCatalog: scenarioAuthoringCatalogFor(assembly.packs), runtimeAdapters: assembly.runtimeAdapters,
    scenarioRuntimeResolver: createScenarioRuntimeResolver({ packs: assembly.packs }), idleRuntimeCloseTimer: () => () => {},
  })
  runtime = await registry.create({ scenarioId: 'halden-power-complex' })
  runId = runtime.id
  await runtime.setClock({ paused: true })
  const start = Date.parse(runtime.snapshot().clock!.currentTime)
  await runtime.runMaximumPace(new Date(start + 10_000).toISOString() as IsoTimestamp, { shouldStop: () => false })
  run = await displayRunOf(registry, runtime, person, new Set())
})
afterAll(async () => { await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) })

describe('the operation flow: proposal → review → element default → pop-over → approve → executed', () => {
  test('a person approves an AI agent\'s proposal from its element\'s pop-over, and the Plant does it', async () => {
    // 1. An AI agent proposes to shut the PORV's block valve.
    const proposed = await runtime.invokeCapability(agent, { capabilityId: 'world.process-plant.control.propose', input: {
      plantId, tagId: 'MOV-8000A', value: 0, reason: 'Isolate the relief line', evidence: ['PT-455'],
    } })
    if (proposed.kind !== 'command' || !proposed.result.ok) throw new Error(`the proposal was refused: ${JSON.stringify(proposed)}`)
    const proposalId = proposed.result.commandId

    // 2. Its review subject: the item's own element on the Plant, as the window's chip and the chat card's Review name it.
    const operator = clientFor(person)
    const held = await operator.proposals(runId, plantId)
    const pending = held.proposals.find(entry => entry.proposal.id === proposalId)!.proposal
    expect(pending).toMatchObject({ item, status: 'pending' })
    const subject = reviewSubject(plantId, pending)
    expect(subject).toBe(`${plantId}#${item}`)

    // 3. The window composes the subject's World default: it draws the item as an element of the Plant's flow, a node
    //    whose pop-over carries the Plant's actions (the Pack's embed contribution).
    const composed = await composeDefault(run, subject)
    if (!composed.ok) throw new Error(`the default was refused: ${JSON.stringify(composed.issues)}`)
    const view = await compileVignette(run, composed.state)
    const flow = view.sections.find(section => section.kind === 'topology')
    if (flow?.kind !== 'topology') throw new Error('the default draws no flow')
    expect([flow.packId, flow.objectId]).toEqual(['process-plant', plantId])
    expect(flow.nodes.map(node => node.id)).toContain(item)
    expect(typeof processPlantEmbed.elementActions).toBe('function')

    // 4. The pop-over's actions, read as ElementActions reads them: the pending card with approve, and the item's own
    //    controls for select-check-execute, each write checked by World.
    expect((await operatedItems(operator, runId, plantId)).has(item)).toBe(true)
    const shown = await readElementOperation(operator, runId, plantId, item)
    expect(shown.proposals.map(proposal => proposal.id)).toEqual([proposalId])
    const now = operationNow(shown.read!.sample, shown.read!.units)
    const card = proposalCard(shownProposal(item, shown.proposals, now)!, shown.reviews.get(proposalId) ?? null, shown.item, now)
    expect(card).toMatchObject({ status: 'pending', approve: { enabled: true } })
    const controls = itemControlView(shown.item, now, shown.resets).controls
    expect(controls.length).toBeGreaterThan(0)
    const write = shown.item.offered[0]!.control
    expect(await operator.validate(runId, plantId, { path: write.path, value: 0 })).toEqual({ accepted: true })

    // 5. A person approves in the pop-over; the stored write executes under their command, logged with the proposal.
    expect(await operator.decide(runId, plantId, proposalId, 'approve', null)).toMatchObject({ ok: true })
    const start = Date.parse(runtime.snapshot().clock!.currentTime)
    await runtime.runMaximumPace(new Date(start + 13_000).toISOString() as IsoTimestamp, { shouldStop: () => false })
    const after = await readElementOperation(operator, runId, plantId, item)
    expect(after.read!.log).toContainEqual(expect.objectContaining({ kind: 'approval', proposalId, origin: 'person', actorId: person.id }))
    expect((await operator.proposals(runId, plantId)).proposals.find(entry => entry.proposal.id === proposalId)!.proposal.status).toBe('approved')
    const position = after.read!.sample.values.find(entry => entry.path === 'pressurizer.blockValveEffectivePositionFraction')
    expect(position?.value).toBeLessThanOrEqual(0.05)
  }, 120_000)
})
