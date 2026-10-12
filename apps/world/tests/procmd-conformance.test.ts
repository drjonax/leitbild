import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { parseProcedure } from '@leitbild/procmd'
import baseline from '../../../packages/procmd/fixtures/pwr-ops-baseline.json'
import { procedureRunStateSchema, type ActorId, type CommandEnvelope, type EventId, type IsoTimestamp, type SimulationRunId } from '../src/core/model/index.ts'
import { parseProcedureMarkdown } from '../src/features/procedures/procmd.ts'
import { prepareProcedureCommand } from '../src/features/procedures/run-state.ts'
import { createSimulationRunStateStore } from '../src/core/simulation-runs/state-store.ts'

const revision = 'e8e045f9c31f47e4c5ba0ad7f6acdfb64271c44a'
const at = '2026-01-01T00:00:00.000Z' as IsoTimestamp
const source = { sourceId: 'pwr-ops', label: 'Frozen conformance corpus', repository: 'samsinn-wikis/pwr-ops',
  ref: 'main', path: 'wiki/procedures', revision, fetchedAt: at, sourceUrl: `https://github.com/samsinn-wikis/pwr-ops/tree/${revision}/wiki/procedures` }
const raw = (id: string) => readFileSync(`${import.meta.dir}/../../../packages/procmd/fixtures/pwr-ops/${id}.md`, 'utf8')
const document = (id: string) => parseProcedureMarkdown({ source, sourcePath: `wiki/procedures/${id}.md`,
  sourceUrl: `https://github.com/samsinn-wikis/pwr-ops/blob/${revision}/wiki/procedures/${id}.md`, rawMarkdown: raw(id) })

describe('World consumes the canonical format without semantic projection', () => {
  for (const item of baseline) test(item.procedureId, () => {
    const parsed = parseProcedure(raw(item.procedureId))
    const world = document(item.procedureId)
    expect<unknown>(world.steps).toEqual(parsed.steps)
    expect<unknown>(world.tags).toEqual(parsed.tags)
    expect(world.referencePlant).toBe(parsed.referencePlant)
    expect<unknown>(world.diagnostics).toEqual(parsed.diagnostics)
  })

  test('a serialized pinned Run reopens with unchanged branchIndex meaning against its source', async () => {
    // This is the pre-consolidation persisted Run shape: no parser AST or spans are stored.
    const persisted = JSON.stringify({ runId: 'procedure-run:pinned-before-parser-change', sourceId: 'pwr-ops',
      sourceRevision: revision, sourcePath: 'wiki/procedures/E-0.md', procedureId: 'E-0', title: 'Reactor Trip or Safety Injection',
      scope: { plantId: 'plant:test' }, status: 'active', startedAt: at, startedBy: 'operator:test',
      currentStepId: 'verify-reactor-trip', stepStates: [] })
    const run = procedureRunStateSchema.parse(JSON.parse(persisted))
    const store = createSimulationRunStateStore()
    store.hydrate({ objects: [], seq: 0, procedures: { runs: [run] } })
    const requests: Array<{ sourceId: string; sourceRevision: string; sourcePath?: string; procedureId: string }> = []
    const before = baseline.find(item => item.procedureId === 'E-0')!.steps[0]!
    const branchIndex = before.branches.findIndex(branch => branch.targetKind === 'procedure')
    expect(branchIndex).toBe(1)
    expect(before.branches[branchIndex]!.target).toBe('FR-S.1')
    const simulationRunId = 'test:reopened-run' as SimulationRunId
    const command: CommandEnvelope = { id: 'command:old-branch-index' as CommandEnvelope['id'], simulationRunId,
      actorId: 'operator:test' as ActorId, issuedAt: at, targetObjectIds: [], kind: 'world.procedure.run.transition',
      payload: { runId: run.runId, stepId: before.id, branchIndex } }
    const commit = await prepareProcedureCommand({ command, procedures: store.snapshot().procedures,
      readDocument: async input => { requests.push(input); return document(input.procedureId) } })
    expect(commit).not.toBeNull()
    let seq = 0
    const events = commit!({ simulationRunId, at, procedures: store.snapshot().procedures, actorKind: 'person',
      objectIds: new Set(['plant:test']), factory: { eventId: () => `event:${++seq}` as EventId, nextSeq: () => seq } })
    for (const event of events) store.apply(event)
    expect(requests[0]).toMatchObject({ sourceId: 'pwr-ops', sourceRevision: revision, sourcePath: 'wiki/procedures/E-0.md' })
    expect(requests[1]).toEqual({ sourceId: 'pwr-ops', sourceRevision: revision, procedureId: 'FR-S.1' })
    expect(store.snapshot().procedures!.runs.find(item => item.procedureId === 'FR-S.1')).toMatchObject({
      status: 'active', sourceRevision: revision, sourcePath: 'wiki/procedures/FR-S.1.md', currentStepId: document('FR-S.1').steps[0]!.id })
    expect(store.snapshot().procedures!.runs.find(item => item.runId === run.runId)!.status).toBe('transferred')
  })
})
