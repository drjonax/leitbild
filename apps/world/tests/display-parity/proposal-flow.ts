/**
 * T01: an operation proposal end to end at the Capability boundary of a Run,
 * as the Plant's element panel sees it (P5): an AI agent proposes, the
 * Plant's proposals carry it (control.proposals), the agent may not decide, a
 * person rejects, extends or approves, the proposer withdraws. Read as plain facts (ids and times
 * left out), so the new display path can be held to the same flow.
 *
 * The `test-plant` fixture trips itself about 2 s into plant time (SG A
 * low-low level, p1-plant 20 Oct). The one fact that depends on the unit's
 * mode, the MSIV proposal and its consequence, is taken at 0 s, in power
 * operation (the record says so); what is read after the 13 s of travel (the
 * block valve shut, who may withdraw, the RCP refusal, the journal) are rules
 * that do not change with the trip. At-power expiry, extension, mode change
 * and the approval card are characterized on a steady Plant in
 * process-plant-proposal-characterization.test.ts, so T01 adds no second
 * steady case. The 13 s are counted from the paused clock after the approval,
 * so the valve travels exactly 13 s however far the Run played in realtime
 * before the pause; no recorded fact depends on time since the Scenario
 * start (p1-plant's c6c0daf3e fixed tests that did).
 */
import { newWorkspaceId } from '@leitbild/contracts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActorId, CommandResult, IsoTimestamp } from '../../src/core/model/index.ts'
import type { Actor } from '../../src/core/simulation-runs/actors.ts'
import { createSimulationRunRegistry } from '../../src/core/simulation-runs/registry.ts'
import type { SimulationRunRuntime } from '../../src/core/simulation-runs/runtime.ts'
import { createTestPackRuntimeAdapters, createTestScenarioRuntimeResolver, testScenarioAuthoring } from '../helpers.ts'
import { citedMargin } from '../../src/packs/process-plant/ui/displays/operation/cited-reading.ts'

const operator: Actor = { id: 'actor:human:characterization-operator' as ActorId, label: 'Characterization operator', role: 'operator' }
const supervisor: Actor = { id: 'actor:human:characterization-supervisor' as ActorId, label: 'Characterization supervisor', role: 'operator' }
const agent: Actor = { id: 'actor:ai:characterization-agent' as ActorId, label: 'Characterization agent', role: 'ai_agent' }

const command = async (run: SimulationRunRuntime, actor: Actor, capabilityId: string, input: Record<string, unknown>): Promise<CommandResult & Record<string, any>> => {
  const outcome = await run.invokeCapability(actor, { capabilityId, input })
  if (outcome.kind !== 'command') throw new Error(`${capabilityId} is not a command`)
  return outcome.result as CommandResult & Record<string, any>
}
const query = async (run: SimulationRunRuntime, actor: Actor, capabilityId: string, input: Record<string, unknown>): Promise<any> => {
  const outcome = await run.invokeCapability(actor, { capabilityId, input })
  if (outcome.kind !== 'query') throw new Error(`${capabilityId} is not a query`)
  return outcome.result
}

/** What the display window reads of a proposal: no ids, no times. */
const shown = (proposal: any) => ({
  item: proposal.item,
  word: proposal.word,
  status: proposal.status,
  origin: proposal.proposer.origin,
  write: proposal.write ?? null,
  consequence: proposal.consequence?.text === undefined ? null : String(proposal.consequence.text).replace(/\d+(?:\.\d+)? kg\/s/g, 'N kg/s'),
  procedureStep: proposal.procedureStep ?? null,
  evidence: (proposal.evidence ?? []).map((entry: { tagId: string }) => entry.tagId),
  ...(proposal.closed === undefined ? {} : { closedBy: proposal.closed.actorId }),
})

const decisionOf = (result: CommandResult & Record<string, any>) => result.ok ? { ok: true } : { ok: false, reason: result.reason }

export const observeProposalFlow = async (): Promise<Record<string, unknown>> => {
  const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-display-characterization-'))
  const registry = createSimulationRunRegistry({
    dataDir, workspaceId: newWorkspaceId(), ...testScenarioAuthoring(),
    runtimeAdapters: createTestPackRuntimeAdapters(), scenarioRuntimeResolver: createTestScenarioRuntimeResolver(),
  })
  try {
    const run = await registry.create({ scenarioId: 'test-plant' })
    await run.setClock({ paused: true })
    const plantId = run.snapshot().objects.find(object => object.packId === 'process-plant')!.id
    const sampleProposals = async () => ((await query(run, operator, 'world.process-plant.control.proposals', { plantId })).proposals as ReadonlyArray<any>).map(entry => shown(entry.proposal))
    const propose = (input: Record<string, unknown>) => command(run, agent, 'world.process-plant.control.propose', { plantId, ...input })

    const msiv = await propose({ tagId: 'MSIV-A', value: 0, reason: 'Isolate steam generator A', procedureStep: 'Isolate the faulted steam generator', evidence: ['SG-A-LVL-NR'] })
    const afterPropose = await sampleProposals()
    // The cited reading as its approval card shows it: its margin to the nearest protection limit (numbers shaped).
    const cited = await query(run, operator, 'world.process-plant.signals.read', { plantId, signals: [{ tagId: 'SG-A-LVL-NR' }], observed: true })
    const citedMargins = cited.signals.map((signal: any) => citedMargin({ value: signal.variable.value, unit: signal.observed.unit, quantity: signal.observed.quantity, thresholds: signal.observed.thresholds, ...(signal.observed.observation?.past === undefined ? {} : { past: signal.observed.observation.past }), ratePerMinute: null })?.text.replace(/\d+(?:\.\d+)?/g, 'N') ?? null)
    const agentApproves = decisionOf(await command(run, agent, 'world.process-plant.control.decide', { plantId, proposalId: msiv.commandId, decision: 'approve' }))
    const personExtends = decisionOf(await command(run, supervisor, 'world.process-plant.control.decide', { plantId, proposalId: msiv.commandId, decision: 'extend' }))
    const personRejects = decisionOf(await command(run, operator, 'world.process-plant.control.decide', { plantId, proposalId: msiv.commandId, decision: 'reject', reason: 'Not at power' }))
    const afterReject = await sampleProposals()

    const block = await propose({ tagId: 'MOV-8000A', value: 0, reason: 'Isolate the relief line with its block valve', evidence: ['PT-455'] })
    const personApproves = decisionOf(await command(run, operator, 'world.process-plant.control.decide', { plantId, proposalId: block.commandId, decision: 'approve' }))
    const startedAt = Date.parse(run.snapshot().clock!.currentTime)
    await run.runMaximumPace(new Date(startedAt + 13_000).toISOString() as IsoTimestamp, { shouldStop: () => false })
    const sample = await query(run, operator, 'world.process-plant.signals.read', { plantId, signals: [{ path: 'pressurizer.blockValveEffectivePositionFraction' }, { path: 'pressurizer.blockValvePositionFraction' }], operations: true })

    const again = await propose({ tagId: 'MSIV-A', value: 0, reason: 'Isolate steam generator A', evidence: ['SG-A-LVL-NR'] })
    const otherWithdraws = decisionOf(await command(run, operator, 'world.process-plant.control.decide', { plantId, proposalId: again.commandId, decision: 'withdraw' }))
    const proposerWithdraws = decisionOf(await command(run, agent, 'world.process-plant.control.decide', { plantId, proposalId: again.commandId, decision: 'withdraw' }))
    const refusedOffer = decisionOf(await propose({ tagId: 'RCP-A-RUN', value: true, reason: 'Restart the pump', evidence: ['PT-455'] }))

    return {
      citedMargins,
      proposeResult: { ok: msiv.ok, word: msiv.word ?? null, consequenceVerb: msiv.consequence?.verb ?? null, mode: msiv.consequence?.mode?.id ?? null },
      afterPropose,
      agentApproves,
      personExtends,
      personRejects,
      afterReject,
      personApproves,
      blockValveAfterTravel: Number(sample.signals[0].variable.value) <= 0.05 ? 'shut' : `open at ${sample.signals[0].variable.value}`,
      log: (sample.operations.log as ReadonlyArray<any>).map(entry => ({ kind: entry.kind, origin: entry.origin, actor: entry.actorId })),
      otherWithdraws,
      proposerWithdraws,
      afterWithdraw: (await sampleProposals()).map(entry => entry.status),
      refusedOffer,
      journal: run.events().flatMap(event => event.type === 'interaction.signal.received' && event.signal.type.startsWith('process-plant.proposal.') ? [event.signal.type] : []),
    }
  } finally {
    await registry.shutdown()
    await rm(dataDir, { recursive: true, force: true })
  }
}
