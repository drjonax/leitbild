import { describe, expect, test } from 'bun:test'
import { createProcedureSourceService, type ProcedureSourceConfig } from '../src/features/procedures/source.ts'
import { createKnowledge } from '@leitbild/knowledge'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { procedureSourceUrlSchema } from '../src/core/model/procedures.ts'
import { newWorkspaceId } from '@leitbild/contracts'
import { actorIdSchema } from '../src/core/model/index.ts'
import { createSimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { createLocalWeatherPackRuntimeAdapter } from '../src/packs/weather/sim/adapter.ts'
import { createFixturePackRuntimeAdapter } from './fixtures/fixture-runtime.ts'
import { createTestScenarioRuntimeResolver, testScenarioAuthoring } from './helpers.ts'
import { procedureSources } from '../src/procedure-sources.ts'

const revisionA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const revisionB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const markdownFor = (id: string, title: string): string => `---
type: procedure
procedure-md: 0.7
procedure-id: ${id}
title: ${title}
profile: nuclear-erg
---

# ${id} — ${title}

## Step 1 [id: first-step]
Check: verify the initial condition
- Verified → END
`

const localSource: ProcedureSourceConfig = {
  sourceId: 'leitbild', label: 'Leitbild PWR reference procedures — model annotated',
  repository: 'Leitbild-wiki', ref: 'publication', procedurePath: 'packs/process-plant/procedures',
}
const localPath = (id: string) => `${localSource.procedurePath}/${id}.md`
const publication = (revision: string, title = 'Reactor Trip') => createKnowledge({ revision, documents: [
  { path: 'index.md', content: '# Wiki\nNot a procedure.' },
  { path: localPath('E-0'), content: markdownFor('E-0', title).replace('- Verified → END', '- Continue → [[E-1]]').replaceAll('\n', '\r\n') },
  { path: localPath('E-1'), content: markdownFor('E-1', 'Cooling') },
] })

describe('native local procedure publication', () => {
  test('catalog exposes authored applicability and uninstalled status without inventing runtime compatibility', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'leitbild-procedure-applicability-'))
    try {
      const content = markdownFor('E-0', 'Design guidance').replace('profile: nuclear-erg', 'profile: nuclear-erg\napplies-to: LD-01 reference design\nreference-plant: LD-01\nruntime-bindings: uninstalled\nprocedure-status: design-guidance')
      const service = createProcedureSourceService({ sources: [localSource], retentionDirectory: directory,
        loadKnowledge: async () => createKnowledge({ revision: revisionA, documents: [{ path: localPath('E-0'), content }] }) })
      const item = (await service.readCatalog()).procedures[0]!
      expect(item.appliesTo).toBe('LD-01 reference design')
      expect(item.referencePlant).toBe('LD-01')
      expect(item.annotations).toMatchObject({ 'runtime-bindings': 'uninstalled', 'procedure-status': 'design-guidance' })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  test('authored assessment survives World parsing and source retention with its exact engineering owner', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'leitbild-assessment-source-'))
    try {
      const assessment = { condition: { type: 'comparison', tagId: 'LD01.SG.A.NR1', operator: '>=', value: 1.1, unit: 'm', bound: 'lower', evidence: 'instrument', source: '../engineering/criteria.md#level', maxAgeSeconds: 2 } } as const
      const content = `${markdownFor('E-0', 'Evidence').replace('- Verified → END', `\`\`\`procedure-assessment\n${JSON.stringify(assessment)}\n\`\`\`\n- Verified → END`)}\n## Tags\n- id: LD01.SG.A.NR1\n  units: m`
      const owner = { path: 'packs/process-plant/engineering/criteria.md', content: '# Criteria\n\n## Level\nAn owned acquired lower-bound criterion.' }
      const service = createProcedureSourceService({ sources: [localSource], retentionDirectory: directory,
        loadKnowledge: async () => createKnowledge({ revision: revisionA, documents: [{ path: localPath('E-0'), content }, owner] }) })
      const document = await service.readDocument({ procedureId: 'E-0' })
      expect(document.steps[0]!.assessment).toEqual(assessment)
      expect(document.steps[0]!.tagIds).toEqual(['LD01.SG.A.NR1'])
      const pinned = await service.readEvidence({ sourceRevision: revisionA, sourcePath: owner.path, section: 'level' })
      expect(pinned.content).toContain('owned acquired lower-bound')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  test('retains direct step Basis owners, supports exact sections offline, and never substitutes updated evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'leitbild-procedure-basis-'))
    try {
      const basisPath = 'packs/process-plant/engineering/criteria.md'
      let current = createKnowledge({ revision: revisionA, documents: [
        { path: localPath('E-0'), content: markdownFor('E-0', 'Evidence').replace('Check:', 'Basis: [Criteria](../engineering/criteria.md#level)\nCheck:') },
        { path: basisPath, content: '# Criteria\n\n## Level\nAn authored engineering bound.\n\n## Other\nNot selected.\n[Further](not-retained.md)' },
        { path: 'packs/process-plant/engineering/not-retained.md', content: '# Unselected\nNot direct procedure evidence.' },
      ] })
      const options = { sources: [localSource], retentionDirectory: directory, loadKnowledge: async () => current }
      const service = createProcedureSourceService(options)
      await service.readDocument({ procedureId: 'E-0' })
      const retained = JSON.parse(await readFile(join(directory, `leitbild-${revisionA}.json`), 'utf8'))
      expect(retained.documents.map((doc: { path: string }) => doc.path)).toEqual([basisPath, localPath('E-0')])
      expect((await service.readDocument({ procedureId: 'E-0', sourceRevision: revisionA })).procedureId).toBe('E-0')
      current = createKnowledge({ revision: revisionB, documents: [{ path: basisPath, content: '# Criteria\n\n## Level\nChanged.' }] })
      const offline = createProcedureSourceService({ ...options, loadKnowledge: async () => { throw new Error('Offline') } })
      const exact = await offline.readEvidence({ sourceRevision: revisionA, sourcePath: basisPath, section: 'level' })
      expect(exact.content).toContain('An authored engineering bound.')
      expect(exact.content).not.toContain('Other')
      expect(exact.revision).toBe(revisionA)
      await expect(offline.readEvidence({ sourceRevision: revisionA, sourcePath: 'packs/process-plant/engineering/not-retained.md' })).rejects.toThrow('not found')
      await expect(offline.readEvidence({ sourceRevision: revisionB, sourcePath: basisPath })).rejects.toThrow()
      await expect(offline.readEvidence({ sourceRevision: revisionA, sourcePath: basisPath, section: 'missing' })).rejects.toThrow('Unknown section')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  test('navigation hubs are not procedures and retained pins survive source directory changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'leitbild-procedure-move-'))
    try {
      const before = publication(revisionA)
      const original = await createProcedureSourceService({ sources: [localSource], retentionDirectory: directory, loadKnowledge: async () => before }).readDocument({ procedureId: 'E-0' })
      const moved = procedureSources[0]!
      const after = createKnowledge({ revision: revisionB, documents: [
        { path: `${moved.procedurePath}/index.md`, content: '# Procedures\n\nReference guidance.' },
        { path: `${moved.procedurePath}/E-0.md`, content: markdownFor('E-0', 'Current') },
      ] })
      const service = createProcedureSourceService({ sources: [moved], retentionDirectory: directory, loadKnowledge: async () => after })
      expect((await service.readCatalog()).procedures).toHaveLength(1)
      expect((await service.readDocument({ procedureId: 'E-0' })).title).toBe('Current')
      const pinned = await service.readDocument({ procedureId: 'E-0', sourceRevision: revisionA, sourcePath: localPath('E-0') })
      expect(pinned.rawMarkdown).toBe(original.rawMarkdown)
      expect(pinned.source.path).toBe(localSource.procedurePath)
      expect((await service.readDocument({ procedureId: 'E-1', sourceRevision: revisionA })).title).toBe('Cooling')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  test('derives catalog and exact CRLF documents from the shared parser, with no network calls', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'leitbild-procedure-source-'))
    try {
      const knowledge = publication(revisionA)
      const service = createProcedureSourceService({ sources: [localSource], retentionDirectory: directory,
        loadKnowledge: async () => knowledge })
      const catalog = await service.readCatalog()
      expect(catalog.source.sourceId).toBe('leitbild')
      expect(catalog.source.label).toContain('reference procedures')
      expect(catalog.procedures.map(item => [item.procedureId, item.stepCount, item.tagCount])).toEqual([['E-0', 1, 0], ['E-1', 1, 0]])
      expect(await readdir(directory)).toEqual([]) // Discovery does not select/persist a Run source.
      const [first, second] = await Promise.all([
        service.readDocument({ procedureId: 'E-0', sourceRevision: revisionA, sourcePath: localPath('E-0') }),
        service.readDocument({ procedureId: 'E-0', sourceRevision: revisionA }),
      ])
      expect(first.rawMarkdown).toBe(knowledge.read(localPath('E-0')).content)
      expect(second.rawMarkdown).toBe(first.rawMarkdown)
      expect(first.steps[0]!.branches[0]!.target).toBe('E-1')
      expect(first.sourceUrl).toBe(`/wiki?path=packs%2Fprocess-plant%2Fprocedures%2FE-0.md&revision=${revisionA}`)
      expect(await readdir(directory)).toEqual([`leitbild-${revisionA}.json`])
      const saved = JSON.parse(await readFile(join(directory, `leitbild-${revisionA}.json`), 'utf8'))
      expect(saved).toEqual({ revision: revisionA, documents: ['E-0', 'E-1'].map(id => ({ path: localPath(id), content: knowledge.read(localPath(id)).content })) })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  test('retains all transition targets across restart, changed publication and unavailable latest knowledge', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'leitbild-procedure-source-'))
    try {
      let current = publication(revisionA)
      const options = { sources: [localSource], retentionDirectory: directory,
        loadKnowledge: async () => current }
      const original = await createProcedureSourceService(options).readDocument({ procedureId: 'E-0' })
      current = publication(revisionB, 'New publication title')
      const restarted = createProcedureSourceService(options)
      expect((await restarted.readCatalog()).source.revision).toBe(revisionB)
      expect((await restarted.readDocument({ procedureId: 'E-0' })).title).toBe('New publication title')
      const offline = createProcedureSourceService({ ...options, loadKnowledge: async () => { throw new Error('Latest publication offline') } })
      const pinned = await offline.readDocument({ procedureId: 'E-0', sourceRevision: revisionA, sourcePath: localPath('E-0') })
      expect(pinned.rawMarkdown).toBe(original.rawMarkdown)
      expect(pinned.title).toBe('Reactor Trip')
      const transition = await offline.readDocument({ procedureId: 'E-1', sourceRevision: revisionA })
      expect(transition.source.revision).toBe(revisionA)
      expect(transition.rawMarkdown).toBe(markdownFor('E-1', 'Cooling'))
      expect((await readdir(directory)).sort()).toEqual([`leitbild-${revisionA}.json`, `leitbild-${revisionB}.json`])
      await expect(offline.readCatalog()).rejects.toThrow('Latest publication offline')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  test('fails conflicting same-revision bytes, wrong pins, duplicate ids and failed retention explicitly', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'leitbild-procedure-source-'))
    try {
      let current = publication(revisionA)
      const service = createProcedureSourceService({ sources: [localSource], retentionDirectory: directory, loadKnowledge: async () => current })
      await service.readDocument({ procedureId: 'E-0' })
      const retainedPath = join(directory, `leitbild-${revisionA}.json`)
      const original = await readFile(retainedPath, 'utf8')
      current = publication(revisionA, 'Conflicting bytes')
      await expect(service.readDocument({ procedureId: 'E-0' })).rejects.toThrow('conflicts with the same source revision')
      expect(await readFile(retainedPath, 'utf8')).toBe(original)
      await expect(service.readDocument({ procedureId: 'E-0', sourceRevision: revisionB })).rejects.toThrow('unavailable')
      await expect(service.readDocument({ procedureId: 'E-0', sourceRevision: revisionA, sourcePath: 'index.md' })).rejects.toThrow('does not match')
      await expect(service.readDocument({ procedureId: 'E-1', sourceRevision: revisionA, sourcePath: localPath('E-0') })).rejects.toThrow('does not match')
      await expect(service.readDocument({ procedureId: 'UNKNOWN', sourceRevision: revisionA })).rejects.toThrow('not found')
      await expect(service.readDocument({ procedureId: 'E-0', sourcePath: localPath('E-0') })).rejects.toThrow('requires sourceRevision')
      current = createKnowledge({ revision: revisionB, documents: [
        { path: localPath('E-0'), content: markdownFor('E-0', 'First') },
        { path: localPath('E-1'), content: markdownFor('E-0', 'Duplicate') },
      ] })
      await expect(service.readCatalog()).rejects.toThrow('Duplicate procedure id')
      current = createKnowledge({ revision: revisionB, documents: [{ path: localPath('index'), content: '# Not a procedure' }] })
      await expect(service.readCatalog()).rejects.toThrow('No procedure documents')
      current = publication(revisionB)
      const blockedDirectory = join(directory, 'not-a-directory')
      await writeFile(blockedDirectory, 'existing file')
      const blocked = createProcedureSourceService({ sources: [localSource], retentionDirectory: blockedDirectory, loadKnowledge: async () => current })
      await expect(blocked.readDocument({ procedureId: 'E-0' })).rejects.toThrow()
      expect(await readFile(blockedDirectory, 'utf8')).toBe('existing file')
      await writeFile(retainedPath, original.replace(revisionA, revisionB))
      await expect(service.readDocument({ procedureId: 'E-0', sourceRevision: revisionA })).rejects.toThrow('does not match its pin')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  test('unknown source IDs fail explicitly and never repoint to the native source', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'leitbild-procedure-source-'))
    try {
      const service = createProcedureSourceService({ sources: [localSource], retentionDirectory: directory,
        loadKnowledge: async () => { throw new Error('Unknown source must not read the current publication') } })
      await expect(service.readDocument({ sourceId: 'pwr-ops', procedureId: 'E-0', sourceRevision: revisionA,
        sourcePath: 'wiki/procedures/E-0.md' })).rejects.toThrow('Unknown procedure source')
      await expect(service.readCatalog({ sourceId: 'pwr-ops' })).rejects.toThrow('Unknown procedure source')
      await expect(createProcedureSourceService().readCatalog()).rejects.toThrow('none configured')
      expect(await readdir(directory)).toEqual([])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  test('real accepted Run pins survive durable restore and cross-procedure transition without the publication', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'leitbild-procedure-run-source-'))
    const workspaceId = newWorkspaceId()
    let current = publication(revisionA)
    let offline = false
    const createRegistry = () => createSimulationRunRegistry({
      dataDir, workspaceId, scenarioRuntimeResolver: createTestScenarioRuntimeResolver(), ...testScenarioAuthoring(),
      runtimeAdapters: [createFixturePackRuntimeAdapter(), createLocalWeatherPackRuntimeAdapter()],
      procedureSourceService: createProcedureSourceService({ sources: [localSource], retentionDirectory: join(dataDir, 'procedure-publications'),
        loadKnowledge: async () => { if (offline) throw new Error('Latest publication offline'); return current }, }),
    })
    let registry = createRegistry()
    let runtime = await registry.create({ scenarioId: 'test-response' })
    const actor = { id: actorIdSchema.parse('operator:test'), role: 'operator' as const, label: 'Test operator' }
    const command = async (capabilityId: string, input: unknown) => {
      const result = await runtime.invokeCapability(actor, { capabilityId, input })
      if (result.kind !== 'command') throw new Error('Expected command')
      expect(result.result.ok).toBe(true)
      if (!result.result.ok) throw new Error(result.result.reason)
    }
    try {
      await runtime.setClock({ paused: true })
      await command('world.procedure.run.start', { sourceId: 'leitbild', sourceRevision: revisionA,
        procedureId: 'E-0', scope: { plantId: runtime.snapshot().objects[0]!.id } })
      const original = structuredClone(runtime.snapshot().procedures!)
      expect(original.runs[0]!.sourcePath).toBe(localPath('E-0'))
      const retained = JSON.parse(await readFile(join(dataDir, 'procedure-publications', `leitbild-${revisionA}.json`), 'utf8'))
      expect(retained.documents).toHaveLength(2)
      await registry.close(runtime.id)
      current = publication(revisionB, 'Changed publication')
      offline = true
      registry = createRegistry()
      runtime = await registry.load(runtime.id)
      expect(runtime.snapshot().procedures).toEqual(original)
      await command('world.procedure.step.update', { runId: original.runs[0]!.runId, stepId: 'first-step', comment: 'Checked after restart' })
      await command('world.procedure.run.transition', { runId: original.runs[0]!.runId, stepId: 'first-step', branchIndex: 0 })
      const transitioned = structuredClone(runtime.snapshot().procedures!)
      expect(transitioned.runs.map(run => [run.procedureId, run.sourceId, run.sourceRevision, run.sourcePath, run.status])).toEqual([
        ['E-0', 'leitbild', revisionA, localPath('E-0'), 'transferred'],
        ['E-1', 'leitbild', revisionA, localPath('E-1'), 'active'],
      ])
      await registry.close(runtime.id)
      registry = createRegistry()
      runtime = await registry.load(runtime.id)
      expect(runtime.snapshot().procedures).toEqual(transitioned)
    } finally {
      await registry.close(runtime.id)
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  test('citation schema accepts safe local and existing HTTP references only', () => {
    for (const value of ['/wiki?path=a.md&revision=123', 'https://github.com/a/b/blob/revision/file.md', 'http://localhost/wiki']) {
      expect(procedureSourceUrlSchema.safeParse(value).success).toBe(true)
    }
    for (const value of ['//external.test', '/\\external.test', '/wiki\nmalicious', '/wiki\tmalicious', 'javascript:alert(1)', 'relative.md']) {
      expect(procedureSourceUrlSchema.safeParse(value).success).toBe(false)
    }
  })
})
