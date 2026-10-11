import { describe, expect, test } from 'bun:test'
import { gridAlarmLifecycleCommandKind } from '../src/packs/electric-grid/commands/alarm.ts'
import { gridOpenBranchCommandKind } from '../src/packs/electric-grid/commands/branch.ts'
import { gridShedLoadCommandKind } from '../src/packs/electric-grid/commands/load.ts'
import type { GridLoadDefinition } from '../src/packs/electric-grid/grid-model.ts'
import type { GridAlarmsListResult } from '../src/packs/electric-grid/queries/alarms.ts'
import type { GridContingencyScreenResult, GridRemedialEvaluationResult } from '../src/packs/electric-grid/queries/contingency.ts'
import type { GridIslandsResult } from '../src/packs/electric-grid/queries/islands.ts'
import { answerElectricGridQuery, electricGridQueryCapabilities } from '../src/packs/electric-grid/queries/index.ts'
import { manualShedRejection } from '../src/packs/electric-grid/runtime/load-shedding.ts'
import {
  formatGridAlarmTime,
  gridAlarmIdsToAcknowledge,
  gridAlarmLifecycleBatchLimit,
  gridAlarmRows,
  gridLocalTimeZone,
} from '../src/packs/electric-grid/ui/operator-alarms.ts'
import { gridHvdcSetpointGuidance, gridShedLoadPlan, type GridShedLoadContext } from '../src/packs/electric-grid/ui/operator-commands.ts'
import {
  gridCandidateAction,
  gridCandidateActionText,
  gridContingencyRows,
  gridFlowModelSummary,
  gridRemedialComparison,
} from '../src/packs/electric-grid/ui/operator-contingency.ts'
import { corridorDefinition, corridorModel, steppedGrid, type SteppedGrid } from './fixtures/grid-corridor.ts'
import { gridDefinitionForModel, handBuiltModel } from './fixtures/synthetic-grid.ts'

/** A query as the browser receives it: answered, validated by its published output schema, sent as JSON. */
const ask = async <T>(run: SteppedGrid, capabilityId: string, input: Readonly<Record<string, unknown>> = {}): Promise<T> => {
  const capability = electricGridQueryCapabilities.find(candidate => candidate.id === capabilityId)!
  const answer = await answerElectricGridQuery({
    request: { capabilityId, input: { gridId: run.grid.definition.gridId, ...input } },
    grids: new Map([[run.grid.definition.gridId, run.grid]]),
  })
  return JSON.parse(JSON.stringify(capability.output.parse(answer))) as T
}

/** The test corridor with its direct line open: the A path runs above its emergency rating. */
const overloadedCorridor = (): SteppedGrid => {
  const run = steppedGrid(corridorDefinition())
  run.advanceTo(10_000)
  expect(run.command(gridOpenBranchCommandKind, { assetId: 'branch:g-l' }).ok).toBe(true)
  run.advanceTo(30_000)
  return run
}

describe('Grid operator alarms presenter', () => {
  test('rows carry priority, lifecycle state, Oslo time, asset and the actions that change them', async () => {
    const run = overloadedCorridor()
    const listed = await ask<GridAlarmsListResult>(run, 'world.electric-grid.alarms.list')
    const rows = gridAlarmRows(listed.alarms, gridLocalTimeZone)
    expect(rows.map(row => row.priority)).toEqual([...rows.map(row => row.priority)].sort())
    const emergency = rows.find(row => row.id === 'branch:g-a:loading-above-emergency')!
    expect(emergency).toMatchObject({ priorityLabel: 'P1', tone: 'critical', active: true, stateLabel: 'Active · unacknowledged', assetLabel: 'branch:g-a', mapAssetId: 'branch:g-a', actions: ['acknowledge', 'shelve'] })
    // The corridor raises at 10:00:10 UTC on 15 January, 11:00:10 in Oslo (CET).
    expect(emergency.time).toBe('11:00:10')
    expect(emergency.timeDetail).toBe('Raised 2026-01-15T10:00:10.000Z')
    expect(emergency.valueText).toMatch(/^\d+\.\d % \(limit 100\.0 %\)$/)

    expect(run.command(gridAlarmLifecycleCommandKind, { alarmIds: [emergency.id], action: 'acknowledge' }).ok).toBe(true)
    expect(run.command(gridAlarmLifecycleCommandKind, { alarmIds: ['branch:g-a:loading-overload'], action: 'shelve', shelveSeconds: 900 }).ok).toBe(true)
    const after = gridAlarmRows((await ask<GridAlarmsListResult>(run, 'world.electric-grid.alarms.list')).alarms, gridLocalTimeZone)
    expect(after.find(row => row.id === emergency.id)).toMatchObject({ stateLabel: 'Active · acknowledged', actions: ['shelve'] })
    expect(after.find(row => row.id === 'branch:g-a:loading-overload')).toMatchObject({ stateLabel: 'Shelved until 11:15:30', actions: ['unshelve'] })
    expect(gridAlarmIdsToAcknowledge(after)).not.toContain(emergency.id)
  })

  test('acknowledge-all stays within one lifecycle command', () => {
    const row = gridAlarmRows([], gridLocalTimeZone)
    expect(row).toEqual([])
    const many = Array.from({ length: 130 }, (_, index) => ({
      id: `branch:b-${index}:tripped`, priority: 1 as const, priorityLabel: 'P1', tone: 'critical' as const, active: true, stateLabel: '', title: '', message: '',
      assetLabel: '', mapAssetId: null, time: '', timeDetail: '', valueText: null, occurrences: 1, actions: ['acknowledge', 'shelve'] as const,
    }))
    expect(gridAlarmIdsToAcknowledge(many)).toHaveLength(gridAlarmLifecycleBatchLimit)
    expect(() => formatGridAlarmTime('not a time', gridLocalTimeZone)).toThrow('not an ISO timestamp')
  })

  test('island alarms are named after and located at the island\'s anchor bus, as islands.list names it', async () => {
    // Bus B first in model order: the part L–A–B that forms is referenced at B but named after L,
    // its 300 kV station with the most connected branch capacity.
    const byId = new Map(corridorModel.buses.map(bus => [bus.id, bus]))
    const reordered = handBuiltModel({ ...corridorModel, buses: ['bus:g', 'bus:b', 'bus:a', 'bus:l'].map(busId => byId.get(busId)!) })
    const run = steppedGrid(gridDefinitionForModel(reordered))
    run.advanceTo(10_000)
    for (const branchId of ['branch:g-l', 'branch:g-a', 'branch:g-b']) expect(run.command(gridOpenBranchCommandKind, { assetId: branchId }).ok).toBe(true)
    run.advanceTo(12_000)
    const listed = await ask<GridAlarmsListResult>(run, 'world.electric-grid.alarms.list', { states: ['active'] })
    const islands = await ask<GridIslandsResult>(run, 'world.electric-grid.islands.list')
    const formed = gridAlarmRows(listed.alarms, gridLocalTimeZone).find(row => row.id.startsWith('island:') && row.id.endsWith(':formed'))!
    const island = islands.islands.find(candidate => formed.id === `island:${candidate.id.slice('island:'.length)}:formed`)!
    expect([island.anchorBus.id, island.referenceBus.id]).toEqual(['bus:l', 'bus:b'])
    expect(formed).toMatchObject({ mapAssetId: 'bus:l', assetLabel: 'Island at bus:l' })
  })
})

describe('Grid operator N-1 presenter', () => {
  test('rows show each outage\'s violations, the base flow models, the loading basis and a before/after comparison', async () => {
    const run = overloadedCorridor()
    const screening = await ask<GridContingencyScreenResult>(run, 'world.electric-grid.contingency.screen', { contingencies: 'all-branches', ratingBasis: 'emergency' })
    const rows = gridContingencyRows(screening)
    expect(rows.map(row => row.assetId)).toEqual(screening.results.map(result => result.contingency.assetId))
    const violating = rows.find(row => row.severity === 'violation')!
    expect(violating.outcome).toMatch(/^\d+ overloaded branch(es)?/)
    expect(violating.worst!.basis).toBe('MVA (AC base)')
    expect(violating.worst!.overloaded).toBe(true)
    expect(violating.overloaded.length).toBeGreaterThan(0)
    expect(gridFlowModelSummary(screening)).toBe('Base flows: AC load flow in 1 island; outage increments DC.')
    expect(gridFlowModelSummary({ baseFlowModels: [{ islandId: 'a', flowModel: 'ac' }, { islandId: 'b', flowModel: 'dc' }], incrementModel: 'dc' }))
      .toBe('Base flows: AC load flow in 1 island, DC solution in 1 island whose AC load flow did not converge; outage increments DC.')

    const shed = gridCandidateAction({ kind: 'shed-load', assetId: 'load:l', assetKind: 'load', value: '450', emergency: true })
    if ('error' in shed) throw new Error(shed.error)
    expect(gridCandidateActionText(shed.action, 'Load L')).toBe('Emergency-shed Load L to 450 MW')
    const evaluation = await ask<GridRemedialEvaluationResult>(run, 'world.electric-grid.remedial-actions.evaluate', { contingencies: 'all-branches', ratingBasis: 'emergency', actions: [shed.action] })
    const comparison = gridRemedialComparison(evaluation)
    expect(comparison.map(row => row.label)).toEqual(['Base-case overloads', 'Base-case worst loading', 'Contingencies with overloads', 'Overloads over all contingencies', 'Islanding contingencies'])
    expect(comparison[0]).toMatchObject({ before: '2', after: '0', improved: true })
    expect(comparison[1]!.improved).toBe(true)
  })

  test('candidate actions need a fitting selected asset and a value where the command takes one', () => {
    expect(gridCandidateAction({ kind: 'open-branch', assetId: '', assetKind: null, value: '', emergency: false })).toEqual({ error: 'Select a branch on the map or in Assets first.' })
    expect(gridCandidateAction({ kind: 'redispatch', assetId: 'branch:g-a', assetKind: 'branch', value: '100', emergency: false }))
      .toEqual({ error: 'Redispatch unit needs a generator; the selection is branch.' })
    expect(gridCandidateAction({ kind: 'redispatch', assetId: 'generator:g1', assetKind: 'generator', value: '', emergency: false }))
      .toEqual({ error: 'Target (MW) must be a number of at least 0.' })
    expect(gridCandidateAction({ kind: 'close-branch', assetId: 'branch:g-l', assetKind: 'branch', value: '', emergency: false }))
      .toEqual({ action: { kind: 'close-branch', assetId: 'branch:g-l' } })
    expect(gridCandidateAction({ kind: 'redispatch', assetId: 'generator:g1', assetKind: 'generator', value: '700', emergency: false }))
      .toEqual({ action: { kind: 'redispatch', assetId: 'generator:g1', targetMw: 700 } })
  })
})

describe('Grid operator command guidance', () => {
  test('shed-load guidance accepts exactly what the runtime accepts, and explains a 0 MW interruptible load', () => {
    const run = steppedGrid(corridorDefinition())
    run.advanceTo(2_000)
    const base = run.grid.definition.model.loads.find(load => load.id === 'load:l')!
    const state = run.grid.loads.get('load:l')!
    for (const interruptibleMw of [0, 150]) {
      for (const criticalMw of [0, 200]) {
        const definition: GridLoadDefinition = { ...base, interruptibleMw, criticalMw }
        const context: GridShedLoadContext = { label: definition.label, priority: definition.priority, criticalMw, interruptibleMw, demandMw: state.demandMw, modelledDemandMw: state.modelledDemandMw, nominalDemandMw: state.nominalDemandMw }
        for (const targetMw of [0, 150, 500, 900, state.demandMw - 100, state.demandMw, state.demandMw + 10]) {
          for (const emergency of [false, true]) {
            const plan = gridShedLoadPlan(context, targetMw, emergency)
            const runtime = manualShedRejection({ definition, state, demandMw: state.demandMw, targetMw, emergency })
            expect({ interruptibleMw, criticalMw, targetMw, emergency, accepted: plan.problem === null }).toEqual({ interruptibleMw, criticalMw, targetMw, emergency, accepted: runtime === null })
          }
        }
      }
    }
    const context: GridShedLoadContext = { label: 'Load L', priority: 'normal', criticalMw: 0, interruptibleMw: 0, demandMw: 1_000, modelledDemandMw: 1_000, nominalDemandMw: 1_000 }
    const curtailment = gridShedLoadPlan(context, 900, false)
    expect(curtailment.limits).toBe('Interruptible 0 MW: the Grid Model records no flexible demand for this load, so curtailment cannot reduce it. Only emergency shedding can, down to the critical 0 MW.')
    expect(curtailment.problem).toBe('Curtailment would be rejected: Load L has 0 MW interruptible demand. Tick Emergency to shed 100 MW as emergency shedding.')
    const emergency = gridShedLoadPlan(context, 900, true)
    expect(emergency.problem).toBeNull()
    expect(emergency.confirmation).toBe('Emergency-shed Load L to 900 MW? This disconnects 100 MW at once, 100 MW beyond its 0 MW interruptible limit, recorded as emergency shedding until Restore load.')
    const flexible = gridShedLoadPlan({ ...context, interruptibleMw: 150 }, 900, false)
    expect(flexible).toMatchObject({ problem: null, curtailmentFloorMw: 850, confirmation: 'Curtail Load L to 900 MW? This disconnects 100 MW of its 150 MW interruptible demand at once, until Restore load.' })
    // An EV schedule below the modelled demand uses part of the interruptible demand.
    expect(gridShedLoadPlan({ ...context, interruptibleMw: 150, nominalDemandMw: 950 }, 900, false).interruptibleMw).toBe(100)
  })

  test('the shed-load command records the emergency flag the guidance asks for', () => {
    const run = steppedGrid(corridorDefinition())
    run.advanceTo(2_000)
    const rejected = run.command(gridShedLoadCommandKind, { assetId: 'load:l', targetDemandMw: 900 })
    expect(rejected.ok).toBe(false)
    expect(rejected.reason).toContain('beyond its 0 MW of interruptible demand')
    expect(run.command(gridShedLoadCommandKind, { assetId: 'load:l', targetDemandMw: 900, emergency: true }).ok).toBe(true)
    expect(run.grid.loads.get('load:l')!.manualShedEmergency).toBe(true)
  })

  test('HVDC set-point guidance states the sign, the limit and the ramp', () => {
    const link = { label: 'NordLink', ratingMw: 1_400, rampMwPerMinute: 60, transferMw: 200, setpointMw: 200, rampGroup: null }
    expect(gridHvdcSetpointGuidance(link, null)).toEqual({ convention: 'Positive exports from Norway over NordLink, negative imports into Norway; at most ±1,400 MW.', outcome: null, problem: null })
    expect(gridHvdcSetpointGuidance(link, -600).outcome).toBe('Ramps from 200 MW export to 600 MW import in 13.3 min at 60 MW/min.')
    expect(gridHvdcSetpointGuidance(link, 1_500).problem).toBe('1,500 MW is beyond the ±1,400 MW rating.')
    expect(gridHvdcSetpointGuidance(link, 200).problem).toBe('NordLink already has the set-point 200 MW.')
  })

  test('HVDC set-point guidance ramps a grouped link at the lower of its own and its group\'s limit', () => {
    const grouped = { label: 'NordLink', ratingMw: 1_400, rampMwPerMinute: 60, transferMw: 200, setpointMw: 200, rampGroup: { id: 'ramp:no2-continental', rampMwPerMinute: 50, linkCount: 2 } }
    expect(gridHvdcSetpointGuidance(grouped, -600).outcome)
      .toBe('Ramps from 200 MW export to 600 MW import in 16.0 min at 50 MW/min. ramp:no2-continental limits its 2 links to 50 MW/min together, so it takes longer while another of them ramps.')
    const ownLimited = { ...grouped, label: 'NorNed', ratingMw: 700, rampMwPerMinute: 30 }
    expect(gridHvdcSetpointGuidance(ownLimited, -400).outcome).toStartWith('Ramps from 200 MW export to 400 MW import in 20.0 min at 30 MW/min.')
  })
})
