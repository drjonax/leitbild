import { describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/index.ts'
import {
  commandsForProcessPlantAction,
  compileProcessPlant,
  createProcessPlantProtectionRunner,
  createProcessPlantRampRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
  type ProcessSignalBinding,
  type ProcessVariableValue,
  type VariablePath,
} from '../src/packs/process-plant/index.ts'
import { createProcessPlantRuntimePerformance, type ProcessPlantRuntimeInstance } from '../src/packs/process-plant/runtime-instance.ts'
import { resolveProcessPlantSignalBinding } from '../src/packs/process-plant/signals.ts'
import { formatQuantity } from '../src/packs/process-plant/displays/display-text.ts'
import { followAllowanceMs, plantControlsFor, type ItemControls, type PlantControls } from '../src/packs/process-plant/operations/controls.ts'
import { listedControlsFor, listedResetsFor, proposalPortsFor } from '../src/packs/process-plant/operations/instance-ports.ts'
import { decideProposal, emptyProposalBook, proposeOperation, reviewProposal, type ProposalPorts } from '../src/packs/process-plant/operations/proposals.ts'
import { pushbuttonProtection } from '../src/packs/process-plant/operations/pushbutton-protection.ts'
import { compileDetailDisplay } from '../src/packs/process-plant/displays/compose.ts'
import {
  actorName,
  ATTRIBUTION_MS,
  commandPhase,
  consequenceView,
  demandOption,
  drawsOwnSymbol,
  evidenceMargin,
  itemBadges,
  itemControlView,
  moreActuations,
  operationNow,
  operationsLogRows,
  pendingProposals,
  proposalCard,
  reviewOpens,
  shownProposal,
  type ListedItem,
  type OperationNow,
  type OperationRecord,
} from '../src/ui/embed/composed-display/operation/operation-presenter.ts'
import { guardPlantTests, PLANT_HANG_GUARD_MS } from './plant-hang-guard.ts'

guardPlantTests()

// The operation parts of a display, on the four-loop reference Plant as the
// model declares it: the stuck-open PORV whose block valve an AI proposes to
// shut (demo beat 4, at 20 % as QA-17 sets it), the manual reactor trip
// pushbutton (beat 5), a feed valve its controller holds, an RCP whose start is
// not offered, and the SI block the I&C refuses at power. What an item lists,
// and what a proposal is held to, come from World's own ports (instance-ports.ts).

const START = Date.parse('2026-10-16T10:00:00.000Z')

/** A running four-loop Plant with protection evaluated each second, its controls derived, and what World would list for an item now. */
const unit = () => {
  const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:operation', loopCount: 4 }))
  const runtime = createProcessPlantRuntime({ system: plant })
  const protection = createProcessPlantProtectionRunner({ system: plant, protection: plant.automation })
  const instance: ProcessPlantRuntimeInstance = { plant, runtime, ramps: createProcessPlantRampRunner({ runtime }), protection, performance: createProcessPlantRuntimePerformance() }
  const step = (seconds = 1) => {
    for (let second = 0; second < seconds; second += 1) {
      runtime.tick(1_000)
      protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-operation' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
    }
  }
  const controls: PlantControls = plantControlsFor(plant)
  const tag = (tagId: string): ProcessSignalBinding => resolveProcessPlantSignalBinding(plant.graph, { tagId: tagId as never })
  const now = (): OperationNow => ({
    read: path => runtime.readVariable(path),
    elapsedMs: runtime.elapsedMs(),
    clock: elapsedMs => new Date(START + elapsedMs).toISOString().slice(11, 19),
    format: (path, value) => typeof value === 'number' ? formatQuantity(value, plant.graph.signalBindingByPath.get(path)!.unit, null) : String(value),
  })
  const listed = (entry: ItemControls): ListedItem => listedControlsFor(instance, [entry.id])[0]!
  const itemOffering = (path: VariablePath): ItemControls => controls.items.find(entry => entry.offered.some(control => control.path === path))!
  const itemWithholding = (path: VariablePath): ItemControls => controls.items.find(entry => entry.withheld.some(control => control.path === path))!
  const ports: ProposalPorts = proposalPortsFor(instance, 'ai')
  const validate = (write: { readonly path: VariablePath; readonly value: ProcessVariableValue }) => proposalPortsFor(instance, 'person').validate(write)
  const fault = (actionId: string, parameters: Record<string, unknown> = {}) => {
    for (const command of commandsForProcessPlantAction({ actionId, parameters, graph: plant.graph })) runtime.writeCommand({ type: 'setVariable', path: command.path, value: command.value })
  }
  const resets = () => listedResetsFor(instance)
  return { plant, runtime, protection, step, controls, tag, now, listed, itemOffering, itemWithholding, validate, ports, fault, resets }
}

describe('the CONTROL section of an item', () => {
  test('an isolating valve in its host offers OPEN and SHUT, the one it reads not selectable, and Execute names verb, tag and label', () => {
    const plant = unit()
    plant.step()
    const blockValve = plant.tag('MOV-8000A')
    const view = itemControlView(plant.listed(plant.itemOffering(blockValve.path)), plant.now())
    const control = view.controls.find(candidate => candidate.path === blockValve.path)!
    expect(control.now).toBe('OPEN')
    expect(control.options.map(option => [option.word, option.current, option.confirm])).toEqual([['OPEN', true, 'button'], ['SHUT', false, 'button']])
    expect(control.options[1]!.action).toBe(`SHUT ${control.target}`)
    expect(control.target.startsWith('MOV-8000A ')).toBe(true)
    expect(control.travelMs).toBe(10_000)
  })

  test('a feed valve its controller holds reads AUTO with what it holds, and offers no position', () => {
    const plant = unit()
    plant.step()
    const feedValve = plant.tag('MFW-A-CV')
    const view = itemControlView(plant.listed(plant.itemWithholding(feedValve.path)), plant.now())
    // Read-only: a manual demand needs an AUTO/MAN mode the model does not have, and the popover says so.
    expect(view.auto).toEqual([{ text: 'AUTO · SG-A-LVL-NR held to 55 %', manual: expect.stringContaining('AUTO/MAN mode the model does not have') }])
    expect(view.controls.some(control => control.path === feedValve.path)).toBe(false)
  })

  test('stopping an RCP at power sets its reactor trip going: the stop is confirmed by a slide, and its start is withheld with why', () => {
    const plant = unit()
    plant.step(5)
    const rcp = plant.tag('RCP-A-RUN')
    const control = itemControlView(plant.listed(plant.itemOffering(rcp.path)), plant.now()).controls.find(candidate => candidate.path === rcp.path)!
    expect(control.withheldOptions).toEqual([{ word: 'START', reason: 'An RCP start needs seal injection and oil lift, which the model does not have: not started from the display' }])
    const stop = control.options.find(option => option.word === 'STOP')!
    expect(stop.confirm).toBe('slide')
    expect(stop.slideOnly).toBe(false)
    expect(stop.consequences.some(line => line.startsWith('→ RX TRIP · ') && line.endsWith(': armed'))).toBe(true)
  })

  test('the SI block is a slide the I&C refuses at power, in its own words, with whether it stands and its permissive; after a safety injection a pump stop is held by the sealed-in SI signal', () => {
    const plant = unit()
    plant.step(5)
    const block = plant.tag('SI-BLOCK')
    const view = itemControlView(plant.listed(plant.itemOffering(block.path)), plant.now())
    const pushbutton = view.controls.find(candidate => candidate.path === block.path)!
    expect(pushbutton.form).toBe('pushbutton')
    // A block defeats protection: slid like a trip, never pressed once (HMI review of run 26c), and it says whether it stands.
    expect(pushbutton.now).toBe('not blocked')
    expect(pushbutton.options.map(option => [option.confirm, option.slideOnly])).toEqual([['slide', true]])
    expect(pushbutton.options[0]!.consequences).toEqual(['Blocks SI · Safety injection on low pressurizer pressure'])
    expect(pushbutton.protection).toEqual({
      role: 'block',
      gate: { text: 'Low pressurizer pressure SI block permitted below P-11: not met now', allows: false, message: expect.stringContaining('P-11') },
    })
    // Trips first, then actuations, blocks last: the core's pushbuttons in that order.
    expect(view.controls.filter(control => control.form === 'pushbutton').map(control => control.protection?.role)).toEqual(['trip', 'actuation', 'block'])
    const refusal = plant.validate({ path: block.path, value: true })
    expect(refusal.accepted).toBe(false)
    if (refusal.accepted) return
    expect(refusal.reason).toContain('P-11')
    // Pressurizer pressure below the SI set point: the SI signal starts the pumps once and seals in.
    let elapsed = 0
    while (!plant.protection.snapshot().rules.find(rule => rule.ruleId === 'safety-injection-low-pzr-pressure')!.latched && elapsed < 600) {
      plant.runtime.writeCommand({ type: 'setVariable', path: plant.tag('PZR-HTR').path, value: 0 })
      plant.runtime.writeCommand({ type: 'setVariable', path: plant.tag('PORV-456A').path, value: 1 })
      plant.step()
      elapsed += 1
    }
    const pump = plant.tag('SI-PUMP-A')
    const stop = itemControlView(plant.listed(plant.itemOffering(pump.path)), plant.now()).controls.find(candidate => candidate.path === pump.path)!.options.find(option => option.word === 'STOP')!
    expect(stop.heldBy).toMatch(/^Safety injection on low pressurizer pressure holds .+ START since \d\d:\d\d:\d\d: overriding it is not offered here$/)
    expect(stop.opposing.some(line => line.includes('writes START: acted at') || line.includes('writes START: sealed in since'))).toBe(true)
  }, PLANT_HANG_GUARD_MS)

  test('the manual reactor trip on the core is a slide that selects and executes at once (demo beat 5)', () => {
    const plant = unit()
    plant.step()
    const button = plant.tag('RX-TRIP-MAN')
    const control = itemControlView(plant.listed(plant.itemOffering(button.path)), plant.now()).controls.find(candidate => candidate.path === button.path)!
    expect(control.form).toBe('pushbutton')
    const [trip] = control.options
    expect([trip!.word, trip!.confirm, trip!.slideOnly]).toEqual(['TRIP REACTOR', 'slide', true])
    expect(trip!.action).toBe(`TRIP REACTOR ${control.target}`)
    expect(trip!.consequences.some(line => line.startsWith('→ RX TRIP · '))).toBe(true)
    // It sits on the core, whose rods its rule inserts, with the manual SI and the SI block.
    expect(plant.itemOffering(button.path).offered.map(candidate => candidate.tagId)).toEqual(expect.arrayContaining(['RX-TRIP-MAN', 'SI-MAN', 'SI-BLOCK']))
  })
})

describe('feedback while a command executes', () => {
  test('sent, then accepted and travelling within its stroke time, then done; a command the equipment does not follow reads not followed only after its stroke time and margin', () => {
    const plant = unit()
    plant.step()
    const blockValve = plant.tag('MOV-8000A')
    const viewNow = () => itemControlView(plant.listed(plant.itemOffering(blockValve.path)), plant.now()).controls.find(candidate => candidate.path === blockValve.path)!
    const control = viewNow()
    const shut = control.options.find(option => option.word === 'SHUT')!
    const fromState = plant.runtime.readVariable(control.statePath!)
    const sent = { path: blockValve.path, value: shut.value, sentAtElapsedMs: plant.runtime.elapsedMs(), fromState }
    expect(commandPhase(control, shut, sent, plant.now())).toEqual({ kind: 'sent', text: `${shut.action}: sent 10:00:01` })
    expect(commandPhase(control, shut, { ...sent, result: { ok: false, reason: 'MOV-8000A is held' } }, plant.now())).toEqual({ kind: 'refused', text: 'Refused: MOV-8000A is held' })
    // Not written to the Plant: the valve stays open. Within its 10 s stroke and margin it travels, after that it is not followed.
    const accepted = { ...sent, result: { ok: true as const } }
    // The option as the control reads now: whether the equipment has followed it.
    const shutNow = () => viewNow().options.find(option => option.word === 'SHUT')!
    plant.step(5)
    expect(commandPhase(viewNow(), shutNow(), accepted, plant.now()).kind).toBe('travelling')
    plant.step(Math.ceil(followAllowanceMs(10_000) / 1_000))
    expect(commandPhase(viewNow(), shutNow(), accepted, plant.now())).toEqual({ kind: 'notFollowed', text: 'Not followed: CMD SHUT, OPEN since 10:00:01' })
    // Written: it strokes shut, part of the way first, then done.
    const written = { ...accepted, sentAtElapsedMs: plant.runtime.elapsedMs(), fromState: plant.runtime.readVariable(control.statePath!) }
    plant.runtime.writeCommand({ type: 'setVariable', path: blockValve.path, value: shut.value })
    plant.step(4)
    const travelling = commandPhase(viewNow(), shutNow(), written, plant.now())
    expect(travelling.kind).toBe('travelling')
    if (travelling.kind === 'travelling') expect(travelling.fraction).toBeGreaterThan(0.2)
    plant.step(8)
    expect(commandPhase(viewNow(), shutNow(), written, plant.now()).kind).toBe('done')
  })

  test('the stuck PORV does not follow its SHUT: it reads not followed once its declared travel and margin have passed, never before', () => {
    const plant = unit()
    plant.step()
    plant.fault('pressurizer-relief-open', { positionPercent: 20 })
    plant.step(10)
    const porv = plant.tag('PORV-456A')
    const view = () => itemControlView(plant.listed(plant.itemOffering(porv.path)), plant.now()).controls.find(candidate => candidate.path === porv.path)!
    const control = view()
    expect(control.now).toBe('20.0 %')
    expect(plant.runtime.readVariable(control.statePath!)).toBeCloseTo(0.2, 3)
    // Its fault inputs are the instructor's and are never listed.
    expect(itemControlView(plant.listed(plant.itemOffering(porv.path)), plant.now()).withheld).toEqual([])
    const shut = control.options.find(option => option.word === 'SHUT')!
    expect(shut.travelMs).toBe(0)
    plant.runtime.writeCommand({ type: 'setVariable', path: porv.path, value: shut.value })
    const sent = { path: porv.path, value: shut.value, sentAtElapsedMs: plant.runtime.elapsedMs(), fromState: 0.2, result: { ok: true as const } }
    plant.step(1)
    expect(commandPhase(view(), shut, sent, plant.now()).kind).toBe('travelling')
    plant.step(Math.ceil(followAllowanceMs(0) / 1_000))
    expect(commandPhase(view(), shut, sent, plant.now())).toEqual({ kind: 'notFollowed', text: 'Not followed: CMD SHUT, 20.0 % since 10:00:11' })
    // Where the model declares no travel time the state is awaited, and never judged.
    const undeclared = { ...shut, travelMs: null }
    plant.step(60)
    const awaited = commandPhase(view(), undeclared, sent, plant.now())
    expect(awaited).toMatchObject({ kind: 'travelling', by: null })
    expect(awaited.text).toContain('awaiting its state')
  })
})

describe('an AI proposal on the stuck-open PORV, from its card to the badges', () => {
  test('pending: the exact command, who and why, the I&C now, evidence and World\'s ranking; Approve and Reject while it stands', () => {
    const plant = unit()
    plant.step()
    plant.fault('pressurizer-relief-open', { positionPercent: 20 })
    plant.step(60)
    const blockValve = plant.tag('MOV-8000A')
    const at = () => ({ elapsedMs: plant.runtime.elapsedMs(), wallMs: plant.runtime.elapsedMs() })
    const proposed = proposeOperation(emptyProposalBook, {
      id: 'cmd-propose-1',
      plantId: plant.plant.id,
      write: { path: blockValve.path, value: 0 },
      reason: 'PORV-456A stuck 20 % open with no demand: isolate it with its block valve',
      procedureStep: 'AOP PORV leakage step 3',
      evidence: ['PORV-456A-POS' as never, 'PT-455' as never],
      proposer: { actorId: 'assistant', origin: 'ai' },
      at: at(),
    }, plant.ports)
    expect(proposed.ok).toBe(true)
    const proposal = proposed.book.proposals[0]!
    const item = plant.listed(plant.itemOffering(blockValve.path))
    expect(proposal.item).toBe(item.id)
    const margins = [{ tagId: 'PT-455', text: '0.31 MPa above LO-LO 13.8 MPa · RX TRIP', minutes: 3.5 }, { tagId: 'PORV-456A-POS', text: 'no limit in force', minutes: null }]
    const card = proposalCard(proposal, reviewProposal(proposal, plant.ports), item, margins, plant.now())
    const target = item.offered.find(entry => entry.control.path === blockValve.path)!.control.target
    expect(card).toMatchObject({
      status: 'pending',
      action: `SHUT ${target}`,
      from: 'OPEN',
      to: 'SHUT',
      // Who, by kind: the Run records actors by id only, never shown raw ("actor:operator").
      proposer: 'AI agent · 10:01:01',
      proposerOrigin: 'ai',
      reason: 'PORV-456A stuck 20 % open with no demand: isolate it with its block valve',
      procedureStep: 'AOP PORV leakage step 3',
      checked: { permitted: true, text: 'I&C allows this command now' },
      changed: false,
      expected: `${target} reads SHUT within 10 s`,
      reversibility: `Reversible: OPEN ${target} is a new command`,
      expires: { at: '10:03:01', inMs: 120_000 },
      extendable: true,
      approve: { label: `Approve: SHUT ${target}`, confirm: 'button', enabled: true },
      closed: null,
    })
    expect(card.margins.map(margin => margin.tagId)).toEqual(['PT-455', 'PORV-456A-POS'])
    expect(card.evidence.map(entry => [entry.tagId, entry.then])).toEqual([['PORV-456A-POS', '20.0 %'], ['PT-455', expect.stringMatching(/^1\d\.\d+ MPa$/)]])
    // The window's list and the symbol say a proposal waits for a person.
    expect(pendingProposals(proposed.book.proposals, [item], () => margins, plant.now()).map(entry => [entry.action, entry.proposer, entry.minutes])).toEqual([[`SHUT ${target}`, 'AI', 3.5]])
    expect(itemBadges(item, { operations: [], proposals: proposed.book.proposals, ownCommands: new Set(), now: plant.now() }).proposal?.text).toBe('AI ?')
    // Thirty seconds on the pressure has fallen: the card says the plant changed, and Approve says so too.
    plant.step(30)
    const later = proposalCard(proposal, reviewProposal(proposal, plant.ports), plant.listed(plant.itemOffering(blockValve.path)), margins, plant.now())
    expect(later.changed).toBe(true)
    expect(later.evidence.find(entry => entry.tagId === 'PT-455')!.changed).toBe(true)
    expect(later.approve?.label).toBe(`Approve anyway, plant changed: SHUT ${target}`)
    expect(later.expires?.inMs).toBe(90_000)
  }, PLANT_HANG_GUARD_MS)

  test('approved: the stored write travels with a ring, then the symbol carries OP·AI for five plant minutes', () => {
    const plant = unit()
    plant.step()
    plant.fault('pressurizer-relief-open', { positionPercent: 20 })
    plant.step(60)
    const blockValve = plant.tag('MOV-8000A')
    const at = () => ({ elapsedMs: plant.runtime.elapsedMs(), wallMs: plant.runtime.elapsedMs() })
    const proposed = proposeOperation(emptyProposalBook, {
      id: 'cmd-propose-1', plantId: plant.plant.id, write: { path: blockValve.path, value: 0 }, reason: 'Isolate the stuck PORV',
      evidence: ['PORV-456A-POS' as never], proposer: { actorId: 'assistant', origin: 'ai' }, at: at(),
    }, plant.ports)
    const decided = decideProposal(proposed.book, { proposalId: 'cmd-propose-1', decision: 'approve', decider: { actorId: 'op-1', origin: 'person' }, commandId: 'cmd-approve-1', at: at() }, plant.ports)
    expect(decided.execute).toEqual({ path: blockValve.path, value: 0 })
    plant.runtime.writeCommand({ type: 'setVariable', path: decided.execute!.path, value: decided.execute!.value })
    const record: OperationRecord = { commandId: 'cmd-approve-1', path: blockValve.path, value: 0, origin: 'person', actorId: 'op-1', elapsedMs: plant.runtime.elapsedMs(), kind: 'approval', proposalId: 'cmd-propose-1' }
    const badges = () => itemBadges(plant.listed(plant.itemOffering(blockValve.path)), { operations: [record], proposals: decided.book.proposals, ownCommands: new Set(['cmd-approve-1']), now: plant.now() })
    // Approved and closed: no pending badge; its card reads who approved it.
    const closed = proposalCard(decided.book.proposals[0]!, null, plant.listed(plant.itemOffering(blockValve.path)), [], plant.now())
    expect([closed.status, closed.closed, closed.approve, closed.expires]).toEqual(['approved', 'Approved by an operator at 10:01:01', null, null])
    plant.step(4)
    const travelling = badges()
    expect(travelling.proposal).toBeNull()
    expect(travelling.progress).toMatchObject({ mode: 'determinate' })
    if (travelling.progress?.mode === 'determinate') expect(travelling.progress.value).toBeGreaterThan(20)
    // The command this screen issued locks nothing for it; one another screen issued does.
    expect(travelling.commandLocked).toBeNull()
    expect(itemBadges(plant.listed(plant.itemOffering(blockValve.path)), { operations: [record], proposals: decided.book.proposals, ownCommands: new Set(), now: plant.now() }).commandLocked?.title).toContain('another operator\'s command travels since 10:01:01')
    plant.step(8)
    const done = badges()
    expect(done.progress).toBeNull()
    expect(done.attribution?.text).toBe('OP·AI')
    expect(done.attribution?.title).toMatch(/^SHUT MOV-8000A .+ by an operator, proposed by an AI agent at 10:01:01$/)
    plant.step(ATTRIBUTION_MS / 1_000)
    expect(badges().attribution).toBeNull()
  }, PLANT_HANG_GUARD_MS)

  test('the I&C\'s own writes carry no ring or badge; a person\'s direct command reads OP, an AI\'s direct command AI', () => {
    const plant = unit()
    plant.step()
    const blockValve = plant.tag('MOV-8000A')
    plant.runtime.writeCommand({ type: 'setVariable', path: blockValve.path, value: 0 })
    plant.step(15)
    const item = plant.listed(plant.itemOffering(blockValve.path))
    const record = (origin: OperationRecord['origin']): OperationRecord => ({ commandId: `cmd-${origin}`, path: blockValve.path, value: 0, origin, actorId: origin === 'system' ? 'scenario' : `${origin}-1`, elapsedMs: 1_000, kind: 'write' })
    const badgesFor = (origin: OperationRecord['origin']) => itemBadges(item, { operations: [record(origin)], proposals: [], ownCommands: new Set(), now: plant.now() })
    expect(badgesFor('system')).toEqual({ progress: null, attribution: null, proposal: null, interlock: null, commandLocked: null, throttled: null })
    expect(badgesFor('person').attribution?.text).toBe('OP')
    expect(badgesFor('ai').attribution?.text).toBe('AI')
  })

  test('an operated display reads the Plant from its sample, and shows an item\'s pending proposal, else the one that closed last', () => {
    const now = operationNow({ simulationTime: '2026-10-16T10:01:00.000Z', plantElapsedMs: 60_000, values: [{ path: 'v.position', value: 0.2 }, { path: 'v.open', value: true }] }, new Map([['v.position', 'fraction']]))
    expect([now.read('v.position' as never), now.elapsedMs, now.clock(0), now.clock(75_000)]).toEqual([0.2, 60_000, '10:00:00', '10:01:15'])
    expect([now.format('v.position' as never, 0.2), now.format('v.open' as never, true)]).toEqual([formatQuantity(0.2, 'fraction'), 'true'])
    // A value is written in its signal's unit, never guessed without one.
    expect(() => now.format('v.other' as never, 3)).toThrow('no unit resolved for v.other')
    const proposal = (id: string, status: 'pending' | 'rejected' | 'expired', expiresAtElapsedMs: number, closedAt?: number) => ({
      id, plantId: 'p', write: { path: 'v.open' as never, value: false }, item: 'valve', word: 'SHUT', reason: 'r', evidence: [{ tagId: 'T' as never, path: 'v.position' as never, value: 0.2 }],
      proposer: { actorId: 'assistant', origin: 'ai' as const }, proposedAtElapsedMs: 0, proposedAtWallMs: 0, expiresAtElapsedMs, extended: false, status,
      ...(closedAt === undefined ? {} : { closed: { atElapsedMs: closedAt } }),
    })
    const rejected = proposal('p1', 'rejected', 120_000, 30_000)
    const expired = proposal('p2', 'expired', 50_000, 50_000)
    expect(shownProposal('valve', [rejected, expired], now)?.id).toBe('p2')
    expect(shownProposal('valve', [rejected, expired, proposal('p3', 'pending', 180_000), proposal('p4', 'pending', 170_000)], now)?.id).toBe('p4')
    expect(shownProposal('other', [rejected], now)).toBeUndefined()
    // Closed longer ago than the attribution time, it is no longer shown.
    expect(shownProposal('valve', [expired], { ...now, elapsedMs: 50_000 + ATTRIBUTION_MS + 1 })).toBeUndefined()
  })

  test('a cited reading\'s margin is its limit state in words, with its projected minutes; past a limit it is first', () => {
    const threshold = { value: 13.8e6, kind: 'trip', direction: 'low', order: 2, action: 'RX TRIP', ruleId: 'r', severity: 'critical' } as never
    const margin = { threshold, distance: 0.5e6 } as never
    expect(evidenceMargin('PT-455', { offScale: null, limit: { kind: 'margin', margin, eta: '≈3 min', minutes: 3 } }, 'Pa', null)?.minutes).toBe(3)
    expect(evidenceMargin('PT-455', { offScale: null, limit: { kind: 'past', margin, back: null } }, 'Pa', null)?.minutes).toBe(0)
    expect(evidenceMargin('PT-455', { offScale: null, limit: null }, 'Pa', null)).toBeNull()
  })

  test('the operations log lists who did what, the approval chain and what came of it, newest first', () => {
    const plant = unit()
    plant.step()
    plant.fault('pressurizer-relief-open', { positionPercent: 20 })
    plant.step(60)
    const blockValve = plant.tag('MOV-8000A')
    const at = () => ({ elapsedMs: plant.runtime.elapsedMs(), wallMs: plant.runtime.elapsedMs() })
    const proposed = proposeOperation(emptyProposalBook, {
      id: 'cmd-propose-1', plantId: plant.plant.id, write: { path: blockValve.path, value: 0 }, reason: 'Isolate the stuck PORV',
      evidence: ['PORV-456A-POS' as never], proposer: { actorId: 'assistant', origin: 'ai' }, at: at(),
    }, plant.ports)
    const decided = decideProposal(proposed.book, { proposalId: 'cmd-propose-1', decision: 'approve', decider: { actorId: 'op-1', origin: 'person' }, commandId: 'cmd-approve-1', at: at() }, plant.ports)
    plant.runtime.writeCommand({ type: 'setVariable', path: blockValve.path, value: 0 })
    const approval: OperationRecord = { commandId: 'cmd-approve-1', path: blockValve.path, value: 0, origin: 'person', actorId: 'op-1', elapsedMs: plant.runtime.elapsedMs(), kind: 'approval', proposalId: 'cmd-propose-1' }
    const item = plant.listed(plant.itemOffering(blockValve.path))
    const rejected = { ...proposed.book.proposals[0]!, id: 'cmd-propose-0', status: 'rejected' as const, closed: { atElapsedMs: 30_000, actorId: 'op-1', reason: 'not yet' } }
    const rows = () => operationsLogRows([approval], [...decided.book.proposals, rejected], [item], plant.now())
    plant.step(4)
    expect(rows()[0]).toMatchObject({ who: 'Operator', action: expect.stringMatching(/^SHUT MOV-8000A /), chain: 'approved an AI agent\'s proposal of 10:01:01', result: 'travelling' })
    plant.step(8)
    expect(rows().map(row => [row.time, row.who, row.chain, row.result])).toEqual([
      ['10:01:01', 'Operator', 'approved an AI agent\'s proposal of 10:01:01', 'SHUT now'],
      ['10:00:30', 'AI agent', 'proposed 10:01:01', 'rejected by an operator: not yet, not executed'],
    ])
  }, PLANT_HANG_GUARD_MS)

})

describe('demand controls and valve positions', () => {
  test('a modulating valve no controller drives is set on its 1 % grid between SHUT and OPEN, its command beside where it stands', () => {
    const plant = unit()
    plant.step()
    const valve = plant.tag('AFW-A-CV')
    const view = () => itemControlView(plant.listed(plant.itemOffering(valve.path)), plant.now()).controls.find(candidate => candidate.path === valve.path)!
    const control = view()
    expect(control.form).toBe('demand')
    expect(control.demand?.shown).toEqual({ min: 0, max: 100, step: 1, unit: '%' })
    expect([control.now, control.commanded, control.options.map(option => [option.word, option.current])]).toEqual(['SHUT', null, [['OPEN', false], ['SHUT', true]]])
    // A setting between its ends is an option of its own, in World's words for it, moving as its OPEN end does.
    const forty = demandOption(control, 0.4)!
    expect([forty.word, forty.action, forty.confirm, forty.current]).toEqual(['OPEN to 40 %', `OPEN to 40 % ${control.target}`, 'button', false])
    expect(forty.travelMs).toBe(control.options.find(option => option.word === 'OPEN')!.travelMs)
    // Off its grid or its span it is no setting.
    expect(demandOption(control, 0.405)).toBeNull()
    expect(demandOption(control, 1.2)).toBeNull()
    // Written and followed (the model moves this valve within the step): it reads 40 %, its command no longer shown apart, and the command is done.
    plant.runtime.writeCommand({ type: 'setVariable', path: valve.path, value: 0.4 })
    const sent = { path: valve.path, value: 0.4, sentAtElapsedMs: plant.runtime.elapsedMs(), fromState: 0, result: { ok: true as const } }
    plant.step(2)
    const set = view()
    expect([set.now, set.commanded, set.demand?.settingText]).toEqual(['40 %', null, '40 %'])
    expect(commandPhase(set, demandOption(set, 0.4)!, sent, plant.now()).kind).toBe('done')
    // A further setting is selectable; the one it stands at is not.
    expect([demandOption(set, 0.4)!.current, demandOption(set, 0.55)!.current]).toEqual([true, false])
  }, PLANT_HANG_GUARD_MS)

  test('a valve shows where it stands; a controller\'s valve reads AUTO with what it holds and why it is not operated by hand', () => {
    const plant = unit()
    plant.step()
    const feed = plant.tag('MFW-A-CV')
    const item = itemControlView(plant.listed(plant.itemWithholding(feed.path)), plant.now())
    expect(item.controls).toEqual([])
    expect(item.position).toMatch(/%$/)
    expect(item.auto[0]?.manual).toContain('AUTO/MAN mode')
  }, PLANT_HANG_GUARD_MS)

  test('a setting between the ends an actuation drove the valve to reads "Throttled under" the actuation, in World\'s label, in its row, on its symbol and in the log', () => {
    const plant = unit()
    plant.step()
    const valve = plant.tag('AFW-A-CV')
    const listed = plant.listed(plant.itemOffering(valve.path))
    const under = { ruleId: 'afw-actuation', label: 'AFW actuation on SG low-low level', action: 'AFW START' }
    const throttled = { ...listed, offered: listed.offered.map(entry => (entry.control.path === valve.path ? { ...entry, throttledUnder: [under] } : entry)) }
    const control = itemControlView(throttled, plant.now()).controls.find(candidate => candidate.path === valve.path)!
    expect(control.throttled).toEqual(['Throttled under AFW actuation on SG low-low level'])
    // Under several, the first in full and the rest counted in words (HMI review of run 26c: "actuation+3").
    const several = { ...listed, offered: listed.offered.map(entry => (entry.control.path === valve.path ? { ...entry, throttledUnder: [under, { ...under, ruleId: 'b' }, { ...under, ruleId: 'c', label: 'AFW actuation on bus loss' }, { ...under, ruleId: 'd', label: 'AFW actuation manual' }] } : entry)) }
    expect(itemBadges(several, { operations: [], proposals: [], ownCommands: new Set(), now: plant.now() }).throttled?.text).toBe('Throttled under AFW actuation on SG low-low level +2 more actuations')
    expect([moreActuations(1), moreActuations(3)]).toEqual(['+1 more actuation', '+3 more actuations'])
    expect(itemBadges(throttled, { operations: [], proposals: [], ownCommands: new Set(), now: plant.now() }).throttled).toEqual({ text: 'Throttled under AFW actuation on SG low-low level', title: 'Throttled under AFW actuation on SG low-low level' })
    const record: OperationRecord = { commandId: 'cmd-throttle', path: valve.path, value: 0.4, origin: 'person', actorId: 'op-1', elapsedMs: 1_000, kind: 'write', throttledUnder: [under] }
    expect(operationsLogRows([record], [], [throttled], plant.now())[0]).toMatchObject({ action: expect.stringMatching(/^OPEN to 40 % AFW-A-CV/), chain: 'direct command · throttled under AFW actuation on SG low-low level' })
  }, PLANT_HANG_GUARD_MS)

  test('after a trip the AFW actuation holds an AFW valve\'s SHUT, which is not offered; a setting between its ends is, as a throttle', () => {
    const plant = unit()
    plant.step()
    plant.runtime.writeCommand({ type: 'setVariable', path: plant.tag('RX-TRIP-MAN').path, value: true })
    plant.step(90)
    const valve = plant.tag('AFW-A-CV')
    const control = itemControlView(plant.listed(plant.itemOffering(valve.path)), plant.now()).controls.find(candidate => candidate.path === valve.path)!
    const shut = control.options.find(option => option.word === 'SHUT')!
    expect(shut.heldBy).toMatch(/auxiliary feedwater actuation holds AFW-A-CV .* overriding it is not offered here$/)
    expect(demandOption(control, 0.9)).toMatchObject({ word: 'THROTTLE to 90 %', heldBy: null })
    expect(plant.validate({ path: valve.path, value: 0.9 })).toEqual({ accepted: true })
    expect(plant.validate({ path: valve.path, value: 0 })).toMatchObject({ accepted: false })
  }, PLANT_HANG_GUARD_MS)
})

describe('C2a: protection pushbuttons, who acted, consequence lines and the review display', () => {
  test('a block stands while the memory its press latches reads so, and its permissive allows the press while its condition holds', () => {
    const plant = unit()
    plant.step()
    const block = plant.tag('SI-BLOCK')
    const control = plant.itemOffering(block.path).offered.find(candidate => candidate.path === block.path)!
    const memory = plant.tag('SI-BLOCKED').path
    const at = (blocked: boolean, holds: boolean) => pushbuttonProtection(plant.plant, control, { read: path => (path === memory ? blocked : plant.runtime.readVariable(path)), holds: () => holds })
    expect(at(false, false)).toMatchObject({ role: 'block', blocks: { blocked: false }, gate: { kind: 'permissive', allows: false } })
    expect(at(true, true)).toMatchObject({ role: 'block', blocks: { blocked: true, rules: [{ ruleId: 'safety-injection-low-pzr-pressure', action: 'SI' }] }, gate: { allows: true } })
    // The trip and the actuation beside it carry no block and no gate.
    const trip = plant.itemOffering(block.path).offered.find(candidate => candidate.tagId === 'RX-TRIP-MAN')!
    const injection = plant.itemOffering(block.path).offered.find(candidate => candidate.tagId === 'SI-MAN')!
    expect(pushbuttonProtection(plant.plant, trip, { read: path => plant.runtime.readVariable(path), holds: () => true })).toEqual({ role: 'trip' })
    expect(pushbuttonProtection(plant.plant, injection, { read: path => plant.runtime.readVariable(path), holds: () => true })).toEqual({ role: 'actuation' })
  })

  test('actors are named by kind, never by raw id', () => {
    expect([actorName('actor:operator'), actorName('actor:human:u-17'), actorName('actor:ai:assistant'), actorName('op-1', 'person'), actorName('assistant', 'ai'), actorName('actor:scenario-timeline')])
      .toEqual(['operator', 'operator', 'AI agent', 'operator', 'AI agent', 'the Run'])
  })

  test('World\'s consequence line shows on each option that takes something away and on the stored proposal\'s card, what it may set going apart', () => {
    const plant = unit()
    plant.step()
    const msiv = plant.tag('MSIV-A')
    const listed = plant.listed(plant.itemOffering(msiv.path))
    const view = itemControlView(listed, plant.now()).controls.find(candidate => candidate.path === msiv.path)!
    const [opening, shut] = [view.options.find(option => option.word === 'OPEN')!, view.options.find(option => option.word === 'SHUT')!]
    expect(opening.consequence).toBeNull()
    expect(shut.consequence?.text).toMatch(/^shuts off \d+ kg\/s main steam SG A → .+, with the unit in power operation$/)
    expect(shut.consequence?.mayActuate).toMatch(/^may actuate: .*reactor trip/)
    const line = listed.offered.find(entry => entry.control.path === msiv.path)!.consequenceLines.find(candidate => candidate !== null)!
    expect(consequenceView(line)).toEqual(shut.consequence)
    const blockValve = plant.tag('MOV-8000A')
    const block = plant.listed(plant.itemOffering(blockValve.path))
    const proposed = proposeOperation(emptyProposalBook, {
      id: 'cmd-propose-1', plantId: plant.plant.id, write: { path: blockValve.path, value: 0 }, reason: 'PORV leaking', evidence: ['PORV-456A-POS' as never], proposer: { actorId: 'actor:ai:assistant', origin: 'ai' },
      at: { elapsedMs: plant.runtime.elapsedMs(), wallMs: 0 },
    }, plant.ports)
    if (!proposed.ok) throw new Error(proposed.reason)
    const stored = proposed.book.proposals[0]!
    expect(stored.consequence?.verb).toBe('shuts off')
    expect(proposalCard(stored, null, block, [], plant.now()).consequence).toEqual(consequenceView(stored.consequence))
    // A proposal of the state the equipment reads already says so, never "OPEN → OPEN".
    const open = proposeOperation(emptyProposalBook, {
      id: 'cmd-propose-2', plantId: plant.plant.id, write: { path: blockValve.path, value: 1 }, reason: 'Keep the path open', evidence: ['PORV-456A-POS' as never], proposer: { actorId: 'actor:ai:assistant', origin: 'ai' },
      at: { elapsedMs: plant.runtime.elapsedMs(), wallMs: 0 },
    }, plant.ports)
    if (!open.ok) throw new Error(open.reason)
    expect(proposalCard(open.book.proposals[0]!, null, block, [], plant.now()).already).toBe('Already OPEN: approving it changes nothing')
    expect(proposalCard(stored, null, block, [], plant.now()).already).toBeNull()
  })

  test('a review opens a detail that draws the proposal\'s item on its own symbol: a bundled valve\'s host and the line it sits on, where the host alone has room only for the host', () => {
    const plant = unit()
    plant.step()
    const blockValve = plant.tag('MOV-8000A')
    const item = plant.listed(plant.itemOffering(blockValve.path))
    const opens = reviewOpens(item)
    expect(opens).toHaveLength(2)
    expect(opens[1]!.slice(0, 1)).toEqual([...opens[0]!])
    const instance = { plant: plant.plant, runtime: plant.runtime, ramps: createProcessPlantRampRunner({ runtime: plant.runtime }), protection: plant.protection, performance: createProcessPlantRuntimePerformance() }
    const drawn = (components: ReadonlyArray<string>) => {
      const result = compileDetailDisplay(instance, new Set(), components, { width: 1920, height: 1000 })
      if (!result.ok) throw new Error(JSON.stringify(result.issues))
      return drawsOwnSymbol(result.display, item.id)
    }
    expect(opens.map(drawn)).toEqual([false, true])
    // A component's own detail draws it: one detail to open.
    const pump = plant.listed(plant.itemOffering(plant.tag('RCP-A-RUN').path))
    expect(reviewOpens(pump)).toEqual([pump.components])
  }, PLANT_HANG_GUARD_MS)

  test('after a trip the AFW valve is throttled no lower than its actuation\'s floor, with its basis; a setting below it is not offered, one above reads what it throttles', () => {
    const plant = unit()
    plant.step()
    plant.runtime.writeCommand({ type: 'setVariable', path: plant.tag('RX-TRIP-MAN').path, value: true })
    plant.step(90)
    const valve = plant.tag('AFW-A-CV')
    const control = itemControlView(plant.listed(plant.itemOffering(valve.path)), plant.now()).controls.find(candidate => candidate.path === valve.path)!
    expect(control.hold).toMatchObject({ floor: 0.2, floorShown: 20 })
    expect(control.hold?.text).toMatch(/^No lower than 20 %: keeps every steam generator's auxiliary feedwater line open/)
    expect(demandOption(control, 0.1)?.heldBy).toBe(control.hold!.text)
    expect(demandOption(control, 0.3)).toMatchObject({ word: 'THROTTLE to 30 %', heldBy: null })
    expect(demandOption(control, 0.3)?.consequence?.text).toMatch(/^throttles [0-9.]+ kg\/s aux feedwater /)
  }, PLANT_HANG_GUARD_MS)

  test('a standing actuation\'s RESET shows on what it holds: not offered while its condition stands, its hold sentence saying so; a reset proposal has its own card, and a reset its log row', () => {
    const plant = unit()
    plant.step()
    plant.runtime.writeCommand({ type: 'setVariable', path: plant.tag('RX-TRIP-MAN').path, value: true })
    plant.step(90)
    const valve = plant.tag('AFW-A-CV')
    const item = plant.listed(plant.itemOffering(valve.path))
    const holding = plant.resets().filter(reset => reset.items.includes(item.id))
    expect(holding.length).toBeGreaterThan(0)
    const view = itemControlView(item, plant.now(), holding)
    const afw = view.resets.find(reset => reset.action === 'AFW START')!
    expect(afw).toMatchObject({ word: `RESET ${afw.label}`, offered: false, reason: expect.stringMatching(/^condition still present/) })
    expect(afw.acted).toMatch(/^acted at \d\d:\d\d:\d\d$/)
    const shut = view.controls.find(candidate => candidate.path === valve.path)!.options.find(option => option.word === 'SHUT')!
    expect(shut.heldBy).toMatch(/; it cannot be reset yet: condition still present/)
    // The manual reactor trip stands sealed in with its demand gone: its reset is offered, and an AI agent proposes it.
    const trip = plant.resets().find(reset => reset.offered)!
    const proposed = proposeOperation(emptyProposalBook, {
      id: 'cmd-propose-reset', plantId: plant.plant.id, reset: trip.ruleId, reason: 'The trip is complete', evidence: ['PT-455' as never], proposer: { actorId: 'actor:ai:assistant', origin: 'ai' },
      at: { elapsedMs: plant.runtime.elapsedMs(), wallMs: 0 },
    }, plant.ports)
    if (!proposed.ok) throw new Error(proposed.reason)
    const proposal = proposed.book.proposals[0]!
    const owner = plant.listed(plant.controls.items.find(entry => entry.id === proposal.item)!)
    const card = proposalCard(proposal, reviewProposal(proposal, plant.ports), owner, [], plant.now())
    expect(card).toMatchObject({ action: trip.word, from: null, to: null, already: null, draftable: false, approve: { label: `Approve: ${trip.word}`, confirm: 'slide', enabled: true }, checked: { permitted: true } })
    expect(pendingProposals([proposal], [owner], () => [], plant.now())[0]).toMatchObject({ action: trip.word, proposer: 'AI' })
    const record = { commandId: 'cmd-reset', kind: 'reset' as const, ruleId: trip.ruleId, label: trip.label, holds: [...trip.holds], origin: 'person' as const, actorId: 'actor:operator', elapsedMs: plant.runtime.elapsedMs(), proposalId: proposal.id }
    expect(operationsLogRows([], [proposal], [owner], plant.now(), [record]).find(row => row.key === 'cmd-reset')).toMatchObject({ who: 'Operator', action: trip.word, chain: expect.stringMatching(/^approved an AI agent's proposal of /), result: expect.stringMatching(/^reset; the hold on \d+ commands? it wrote lifted$/) })
  }, PLANT_HANG_GUARD_MS)
})
