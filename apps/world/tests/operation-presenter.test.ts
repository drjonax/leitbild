import { describe, expect, test } from 'bun:test'
import type { SimulationRunId } from '../src/core/model/index.ts'
import {
  commandsForProcessPlantAction,
  compilePlantGraph,
  compileProcessPlant,
  createProcessPlantProtectionRunner,
  createProcessPlantRuntime,
  createPwrReferencePlantDefinition,
  processPlantComponentRegistry,
  processPlantOperatingMode,
  type CompiledProcessPlant,
  type PlantGraphSpec,
  type ProcessSignalBinding,
  type ProcessVariableValue,
  type VariablePath,
} from '../src/packs/process-plant/index.ts'
import { resolveProcessPlantSignalBinding } from '../src/packs/process-plant/signals.ts'
import { validateProcessPlantControlWrite } from '../src/packs/process-plant/control-write-validation.ts'
import { derivePlantControls, offeredOption, type ControlDeclarations, type ItemControls, type OfferedControl, type PlantControls } from '../src/packs/process-plant/operations/controls.ts'
import { optionStanding, ruleStatesFrom } from '../src/packs/process-plant/operations/control-standing.ts'
import { decideProposal, emptyProposalBook, proposeOperation, reviewProposal, type ProposalPorts } from '../src/packs/process-plant/operations/proposals.ts'
import {
  ATTRIBUTION_MS,
  commandPhase,
  itemBadges,
  itemControlView,
  pendingProposals,
  proposalCard,
  travelAllowanceMs,
  type ListedItem,
  type OperationNow,
  type OperationRecord,
} from '../src/ui/embed/composed-display/operation/operation-presenter.ts'
import { guardPlantTests, PLANT_HANG_GUARD_MS } from './plant-hang-guard.ts'

guardPlantTests()

// The operation parts of a display, on the four-loop reference Plant: the
// stuck-open PORV whose block valve an AI proposes to shut (demo beat 4, at 20 %
// as QA-17 sets it), a protective pushbutton, a feed valve its controller holds,
// and the SI block the I&C refuses at power. The SI block's input is marked
// momentary as the model lane declares it; an RCP's start is declared not offered.

const withMomentary = (system: CompiledProcessPlant, tagId: string): CompiledProcessPlant => {
  const binding = resolveProcessPlantSignalBinding(system.graph, { tagId: tagId as never })
  if (binding.owner.type !== 'component') throw new Error(`${tagId} is not a component variable`)
  const owner = system.graph.components[binding.owner.componentIndex]!
  const local = String(binding.path).slice(String(owner.id).length + 1)
  const sourceGraph: PlantGraphSpec = {
    ...system.sourceGraph,
    components: system.sourceGraph.components.map(component => {
      if (component.id !== owner.id) return component
      const presentation = component.metadata?.presentation ?? {}
      const momentary = [...new Set([...(presentation.momentary ?? []), local])]
      return { ...component, metadata: { ...component.metadata, presentation: { ...presentation, momentary } } }
    }),
  }
  return { ...system, sourceGraph, graph: compilePlantGraph(sourceGraph, processPlantComponentRegistry) }
}

const declarations: ControlDeclarations = {
  notOffered: (binding, value) => binding.tagId !== undefined && /^RCP-[A-Z]-RUN$/.test(binding.tagId) && value === true ? 'RCP start needs seal injection and oil lift, which are not modelled' : undefined,
}

const START = Date.parse('2026-10-16T10:00:00.000Z')

/** A running four-loop Plant with protection evaluated each second, its controls derived, and what World would list for an item now. */
const unit = () => {
  const plant = withMomentary(compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:operation', loopCount: 4 })), 'SI-BLOCK')
  const runtime = createProcessPlantRuntime({ system: plant })
  const protection = createProcessPlantProtectionRunner({ system: plant, protection: plant.automation })
  const step = (seconds = 1) => {
    for (let second = 0; second < seconds; second += 1) {
      runtime.tick(1_000)
      protection.evaluate({ runtime, elapsedMs: runtime.elapsedMs(), simulationRunId: 'run-operation' as SimulationRunId, sourceRuntimeId: 'process-plant.local' })
    }
  }
  const controls: PlantControls = derivePlantControls(plant, declarations)
  const tag = (tagId: string): ProcessSignalBinding => resolveProcessPlantSignalBinding(plant.graph, { tagId: tagId as never })
  const now = (): OperationNow => ({
    read: path => runtime.readVariable(path),
    elapsedMs: runtime.elapsedMs(),
    clock: elapsedMs => new Date(START + elapsedMs).toISOString().slice(11, 19),
  })
  // The declared stroke time of what a control moves, as World reads it from the model (QA-6); none for others here.
  const travelMs = (control: OfferedControl): number | null => {
    const owner = plant.graph.signalBindingByPath.get(control.path)!.owner
    if (owner.type !== 'component') return null
    const parameters = plant.graph.components[owner.componentIndex]!.parameters as Readonly<Record<string, unknown>>
    return control.target.startsWith('MOV-8000A') && typeof parameters.blockValveStrokeTimeS === 'number' ? parameters.blockValveStrokeTimeS * 1_000 : null
  }
  const listed = (entry: ItemControls, offered: ReadonlyArray<OfferedControl> = entry.offered): ListedItem => {
    const context = {
      read: (path: VariablePath) => runtime.readVariable(path),
      mode: processPlantOperatingMode({ system: plant, runtime, modes: plant.automation.operatingModes })?.id ?? null,
      rules: ruleStatesFrom(protection.snapshot()),
    }
    return {
      id: entry.id,
      label: entry.label,
      offered: offered.map(control => ({ control, standing: control.options.map(option => optionStanding(plant, control, option, context)), travelMs: travelMs(control) })),
      withheld: entry.withheld,
    }
  }
  const itemOffering = (path: VariablePath): ItemControls => controls.items.find(entry => entry.offered.some(control => control.path === path))!
  const itemWithholding = (path: VariablePath): ItemControls => controls.items.find(entry => entry.withheld.some(control => control.path === path))!
  const validate = (write: { readonly path: VariablePath; readonly value: ProcessVariableValue }) => {
    const validation = validateProcessPlantControlWrite({ system: plant, runtime, protection, payload: { plantId: plant.id, path: write.path, value: write.value } })
    return validation.accepted ? { accepted: true as const } : { accepted: false as const, reason: validation.reason }
  }
  const ports: ProposalPorts = {
    offered: write => offeredOption(controls, write),
    validate,
    reading: tagId => {
      const binding = plant.graph.signalBindingByTagId.get(tagId)
      return binding?.published === true ? { ok: true, path: binding.path, value: runtime.readVariable(binding.path) } : { ok: false, reason: `${tagId} is not a published reading` }
    },
  }
  const fault = (actionId: string, parameters: Record<string, unknown> = {}) => {
    for (const command of commandsForProcessPlantAction({ actionId, parameters, graph: plant.graph })) runtime.writeCommand({ type: 'setVariable', path: command.path, value: command.value })
  }
  return { plant, runtime, protection, step, controls, tag, now, listed, itemOffering, itemWithholding, validate, ports, fault }
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
    expect(view.auto).toEqual(['AUTO · SG-A-LVL-NR held to 55 %'])
    expect(view.controls.some(control => control.path === feedValve.path)).toBe(false)
  })

  test('stopping an RCP at power sets its reactor trip going: the stop is confirmed by a slide, and its start is withheld with why', () => {
    const plant = unit()
    plant.step(5)
    const rcp = plant.tag('RCP-A-RUN')
    const control = itemControlView(plant.listed(plant.itemOffering(rcp.path)), plant.now()).controls.find(candidate => candidate.path === rcp.path)!
    expect(control.withheldOptions).toEqual([{ word: 'START', reason: 'RCP start needs seal injection and oil lift, which are not modelled' }])
    const stop = control.options.find(option => option.word === 'STOP')!
    expect(stop.confirm).toBe('slide')
    expect(stop.slideOnly).toBe(false)
    expect(stop.consequences.some(line => line.startsWith('→ RX TRIP · ') && line.endsWith(': armed'))).toBe(true)
  })

  test('the SI block is a pushbutton the I&C refuses at power, in its own words; after a safety injection a pump stop is held by the sealed-in SI signal', () => {
    const plant = unit()
    plant.step(5)
    const block = plant.tag('SI-BLOCK')
    const view = itemControlView(plant.listed(plant.itemOffering(block.path)), plant.now())
    const pushbutton = view.controls.find(candidate => candidate.path === block.path)!
    expect(pushbutton.form).toBe('pushbutton')
    expect(pushbutton.now).toBeNull()
    // Blocking SI sets no trip going: a button, not a slide.
    expect(pushbutton.options.map(option => [option.confirm, option.slideOnly])).toEqual([['button', false]])
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

  test('a pushbutton whose press trips the reactor is a slide that selects and executes at once', () => {
    const plant = unit()
    plant.step()
    // The model lane's manual reactor trip (O6) where it has landed; until then the SI block's pushbutton stands in for
    // it, with a reactor trip of this Plant as the trip its press sets going, as the derivation gives O6's.
    const declared = plant.controls.items.flatMap(entry => entry.offered.filter(control => control.form === 'pushbutton' && control.options.some(option => option.consequences.some(rule => rule.action === 'RX TRIP'))))
    const block = plant.tag('SI-BLOCK')
    const entry = plant.itemOffering(declared[0]?.path ?? block.path)
    const reactorTrip = plant.plant.automation.rules.find(rule => rule.id === 'reactor-high-power-trip')!
    const control = declared[0] ?? (() => {
      const stand = entry.offered.find(candidate => candidate.path === block.path)!
      return { ...stand, options: stand.options.map(option => ({ ...option, word: 'TRIP REACTOR', consequences: [{ ruleId: reactorTrip.id, label: reactorTrip.label ?? reactorTrip.id, action: 'RX TRIP' }] })) }
    })()
    const listed = plant.listed(entry, [control])
    const trip = itemControlView(listed, plant.now()).controls[0]!.options[0]!
    expect([trip.confirm, trip.slideOnly]).toEqual(['slide', true])
    expect(trip.action).toBe(`${trip.word} ${control.target}`)
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
    plant.step(5)
    expect(commandPhase(viewNow(), shut, accepted, plant.now()).kind).toBe('travelling')
    plant.step(Math.ceil(travelAllowanceMs(10_000) / 1_000))
    expect(commandPhase(viewNow(), shut, accepted, plant.now())).toEqual({ kind: 'notFollowed', text: 'Not followed: CMD SHUT, OPEN since 10:00:01' })
    // Written: it strokes shut, part of the way first, then done.
    const written = { ...accepted, sentAtElapsedMs: plant.runtime.elapsedMs(), fromState: plant.runtime.readVariable(control.statePath!) }
    plant.runtime.writeCommand({ type: 'setVariable', path: blockValve.path, value: shut.value })
    plant.step(4)
    const travelling = commandPhase(viewNow(), shut, written, plant.now())
    expect(travelling.kind).toBe('travelling')
    if (travelling.kind === 'travelling') expect(travelling.fraction).toBeGreaterThan(0.2)
    plant.step(8)
    expect(commandPhase(viewNow(), shut, written, plant.now()).kind).toBe('done')
  })

  test('a valve with no declared travel time waits for its state and is never said not followed: the stuck PORV', () => {
    const plant = unit()
    plant.step()
    plant.fault('pressurizer-relief-open', { positionPercent: 20 })
    plant.step(10)
    const porv = plant.tag('PORV-456A')
    const control = itemControlView(plant.listed(plant.itemOffering(porv.path)), plant.now()).controls.find(candidate => candidate.path === porv.path)!
    expect(control.travelMs).toBeNull()
    expect(control.now).toBe('20 %')
    const shut = control.options.find(option => option.word === 'SHUT')!
    const phase = commandPhase(control, shut, { path: porv.path, value: shut.value, sentAtElapsedMs: 0, result: { ok: true } }, plant.now())
    expect(phase).toMatchObject({ kind: 'travelling', by: null })
    expect(phase.text).toContain('awaiting its state')
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
      proposer: 'AI · assistant · 10:01:01',
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
    expect(card.evidence.map(entry => entry.tagId)).toEqual(['PORV-456A-POS', 'PT-455'])
    // The window's list and the symbol say a proposal waits for a person.
    expect(pendingProposals(proposed.book.proposals, [item], () => margins, plant.now()).map(entry => [entry.action, entry.proposer, entry.minutes])).toEqual([[`SHUT ${target}`, 'AI', 3.5]])
    expect(itemBadges(item, { operations: [], proposals: proposed.book.proposals, viewerActorId: 'op-1', now: plant.now() }).proposal?.text).toBe('AI ?')
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
    const badges = () => itemBadges(plant.listed(plant.itemOffering(blockValve.path)), { operations: [record], proposals: decided.book.proposals, viewerActorId: 'op-1', now: plant.now() })
    // Approved and closed: no pending badge; its card reads who approved it.
    const closed = proposalCard(decided.book.proposals[0]!, null, plant.listed(plant.itemOffering(blockValve.path)), [], plant.now())
    expect([closed.status, closed.closed, closed.approve, closed.expires]).toEqual(['approved', 'Approved by op-1 at 10:01:01', null, null])
    plant.step(4)
    const travelling = badges()
    expect(travelling.proposal).toBeNull()
    expect(travelling.progress).toMatchObject({ mode: 'determinate' })
    if (travelling.progress?.mode === 'determinate') expect(travelling.progress.value).toBeGreaterThan(20)
    // This screen's own command locks nothing for it; anyone else's does.
    expect(travelling.commandLocked).toBeNull()
    expect(itemBadges(plant.listed(plant.itemOffering(blockValve.path)), { operations: [record], proposals: decided.book.proposals, viewerActorId: 'op-2', now: plant.now() }).commandLocked?.title).toContain('op-1\'s command travels since 10:01:01')
    plant.step(8)
    const done = badges()
    expect(done.progress).toBeNull()
    expect(done.attribution?.text).toBe('OP·AI')
    expect(done.attribution?.title).toMatch(/^SHUT MOV-8000A .+ by op-1, proposed by AI \(assistant\) at 10:01:01$/)
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
    const badgesFor = (origin: OperationRecord['origin']) => itemBadges(item, { operations: [record(origin)], proposals: [], viewerActorId: null, now: plant.now() })
    expect(badgesFor('system')).toEqual({ progress: null, attribution: null, proposal: null, interlock: null, commandLocked: null })
    expect(badgesFor('person').attribution?.text).toBe('OP')
    expect(badgesFor('ai').attribution?.text).toBe('AI')
  })
})
