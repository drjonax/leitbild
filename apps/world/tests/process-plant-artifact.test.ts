import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { workspaceIdSchema } from '@leitbild/contracts'
import type { SimulationRunId } from '../src/core/model/index.ts'
import { answerProcessPlantQuery, compileProcessPlant, createPwrReferencePlantDefinition, plantGraphToMermaid } from '../src/packs/process-plant/index.ts'
import type { ProcessPlantRuntimeInstance } from '../src/packs/process-plant/runtime-instance.ts'
import { processPlantCapabilities } from '../src/packs/process-plant/capabilities.ts'
import { PROCESS_PLANT_SEARCH_DEFAULT_LIMIT } from '../src/packs/process-plant/queries/common.ts'
import { artifactReadQuerySchema } from '../src/packs/process-plant/queries/graph-query.ts'
import { configureActiveWorkspace } from '../src/ui/workspace-context.ts'
import { readProcessPlantArtifact, type ProcessPlantArtifact } from '../src/ui/process-display/process-display-client.ts'

const plant = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:artifact' }))
const plants = new Map([[plant.id, { plant } as ProcessPlantRuntimeInstance]])
const identity = { plantId: plant.id, artifact: 'authored-spec' }
const output = processPlantCapabilities.find(item => item.id === 'world.process-plant.artifact.read')!.output
const read = (input: Record<string, unknown>) => {
  const result = answerProcessPlantQuery({ request: { capabilityId: 'world.process-plant.artifact.read', input: { ...identity, ...input } }, plants, objects: new Map() })
  expect(output.parse(result)).toEqual(result)
  return result
}
interface ArtifactIndex {
  total: number; offset: number; returned: number; hasMore: boolean; coverage: string
  components: Array<{ id: string; sourcePath: string | null }>
  sourceFiles: Array<{ path: string; sha256: string; lineCount: number; byteCount: number }>
}
interface SourceSlice {
  content: string; sha256: string; startLine: number; endLine: number; returnedLines: number; totalLines: number; hasMore: boolean
  nextRead: Record<string, unknown> | null
}
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

describe('selective Plant artifact evidence', () => {
  test('defaults to a compact paged index with explicit implementation coverage', () => {
    const index = read({}) as ArtifactIndex
    const full = read({ mode: 'full' }) as ProcessPlantArtifact
    // The reference Plant has more components than a default page holds, so the index pages them.
    expect(full.components.length).toBeGreaterThan(PROCESS_PLANT_SEARCH_DEFAULT_LIMIT)
    expect(index).toMatchObject({ mode: 'index', total: full.components.length, returned: PROCESS_PLANT_SEARCH_DEFAULT_LIMIT, hasMore: true })
    expect(index).not.toHaveProperty('content')
    expect(index.coverage).toContain('not the complete Pack')
    expect(index.coverage).toContain('Absence from this bundle does not establish absence')
    const rest = read({ offset: index.returned }) as ArtifactIndex
    expect(rest).toMatchObject({ total: full.components.length, returned: full.components.length - index.returned, hasMore: false })
    expect([...index.components, ...rest.components]).toEqual(full.components.map(({ sourceLinks: _links, ...component }) => component))
    expect(index.sourceFiles.map(file => file.path)).toEqual(full.sourceFiles.map(file => file.path))
    expect(JSON.stringify(index).length).toBeLessThan(JSON.stringify(full).length / 10)
    const first = read({ limit: 2 }) as ArtifactIndex
    const second = read({ offset: first.offset + first.returned, limit: 2 }) as ArtifactIndex
    expect(first.hasMore).toBe(true)
    expect([...first.components, ...second.components]).toEqual(index.components.slice(0, 4))
    expect(second.sourceFiles).toEqual(first.sourceFiles)
    expect(read({ offset: index.total })).toMatchObject({ components: [], returned: 0, hasMore: false })
  })

  test('retains the complete explicit export contract and exact authored/source text', () => {
    const full = read({ mode: 'full' }) as ProcessPlantArtifact
    expect(Object.keys(full).sort()).toEqual(['plantId', 'artifact', 'title', 'language', 'content', 'components', 'sourceFiles', 'metadata'].sort())
    expect(full.content).toBe(JSON.stringify(plant.sourceGraph, null, 2))
    expect(full).toMatchObject({ plantId: plant.id, artifact: 'authored-spec', title: `${plant.graph.title} source specification`, language: 'json' })
    for (const file of full.sourceFiles) {
      expect(file.path.startsWith('apps/world/src/packs/process-plant/')).toBe(true)
      expect(file.content).toBe(readFileSync(new URL(`../../../${file.path}`, import.meta.url), 'utf8'))
    }
    const mermaid = read({ artifact: 'compiled-graph-mermaid', mode: 'full' }) as ProcessPlantArtifact
    expect(mermaid).toEqual({ ...full, artifact: 'compiled-graph-mermaid', title: `${plant.graph.title} full component graph`, language: 'mermaid', content: plantGraphToMermaid(plant.graph, { highlightedComponentIds: new Set(plant.graph.components.filter(component => full.components.find(item => item.id === component.id)?.shownOnOverview).map(component => component.id)) }) })
  })

  test('marks as shown on the overview the equipment of the principal circuits the generated overview draws', () => {
    const full = read({ mode: 'full' }) as ProcessPlantArtifact
    const shown = new Set(full.components.filter(component => component.shownOnOverview).map(component => String(component.id)))
    for (const id of ['core', 'pressurizer', 'sgA', 'rcpD', 'turbine', 'condenser', 'mainFeedwaterPumpB']) expect(shown.has(id)).toBe(true)
    for (const id of ['safetyInjectionPumpA', 'dieselGeneratorA', 'auxFeedwaterPumpMotor', 'containment']) expect(shown.has(id)).toBe(false)
    expect((full.metadata as { overviewComponentCount: number }).overviewComponentCount).toBe(shown.size)
  })

  test('selects the exact authored component and existing source links without sibling data', () => {
    const full = read({ mode: 'full' }) as ProcessPlantArtifact
    const selected = read({ mode: 'component', componentId: 'core' })
    expect(selected).toMatchObject({ mode: 'component', component: full.components.find(item => item.id === 'core'), authoredComponent: JSON.parse(full.content).components.find((item: { id: string }) => item.id === 'core') })
    expect(selected).not.toHaveProperty('sourceFiles')
    expect(selected).not.toHaveProperty('content')
    expect(() => read({ mode: 'component', componentId: 'missing' })).toThrow('Discover exact component ids')
  })

  test('pinned source slices reassemble every indexed file exactly with unchanged link coordinates', () => {
    const index = read({}) as ArtifactIndex
    const full = read({ mode: 'full' }) as ProcessPlantArtifact
    for (const file of index.sourceFiles) {
      let next: Record<string, unknown> | null = { ...identity, mode: 'source', sourcePath: file.path, lineCount: 71, expectedSha256: file.sha256 }
      let content = ''
      let nextLine = 1
      while (next) {
        const page = read(next) as SourceSlice
        expect(page.sha256).toBe(file.sha256)
        expect(page.totalLines).toBe(file.lineCount)
        expect(page.startLine).toBe(nextLine)
        expect(page.returnedLines).toBeLessThanOrEqual(71)
        expect(page.hasMore).toBe(page.nextRead !== null)
        if (page.nextRead) expect(page.nextRead).toMatchObject({ sourcePath: file.path, expectedSha256: file.sha256, startLine: page.endLine + 1 })
        content += page.content
        nextLine = page.endLine + 1
        next = page.nextRead
      }
      expect(content).toBe(full.sourceFiles.find(candidate => candidate.path === file.path)!.content)
      expect(Buffer.byteLength(content)).toBe(file.byteCount)
      expect(createHash('sha256').update(content).digest('hex')).toBe(file.sha256)
    }
    const link = full.components.find(component => component.id === 'core')!.sourceLinks.find(link => link.symbol === 'reactorKineticsPowerStep')!
    const selected = read({ mode: 'source', sourcePath: link.targetPath, startLine: link.targetLineIndex! + 1, lineCount: 1 }) as SourceSlice
    expect(selected.content).toContain('export const reactorKineticsPowerStep')
  })

  test('rejects unknown/outside source paths, stale pins and invalid mode selectors', () => {
    const file = (read({}) as ArtifactIndex).sourceFiles[0]!
    for (const sourcePath of ['../../../../etc/passwd', 'src/packs/process-plant/queries/graph-query.ts', `${file.path}/../${file.path}`, 'file:///etc/passwd']) {
      expect(() => read({ mode: 'source', sourcePath })).toThrow('Select an exact sourceFiles path')
    }
    expect(() => read({ mode: 'source', sourcePath: file.path, expectedSha256: '0'.repeat(64) })).toThrow('source bytes changed')
    expect(() => read({ mode: 'source', sourcePath: file.path, startLine: file.lineCount + 1 })).toThrow('exceeds totalLines')
    for (const input of [
      { mode: 'source', sourcePath: file.path, startLine: 0 },
      { mode: 'source', sourcePath: file.path, lineCount: 201 },
      { mode: 'source', sourcePath: file.path, componentId: 'core' },
      { mode: 'full', offset: 1 }, { mode: 'index', sourcePath: file.path },
      { mode: 'component' }, { componentId: 'core' },
    ]) expect(artifactReadQuerySchema.safeParse({ ...identity, ...input }).success).toBe(false)
  })

  test('the real UI client explicitly requests full and preserves the prior decoded payload', async () => {
    const full = read({ mode: 'full' }) as ProcessPlantArtifact
    configureActiveWorkspace(workspaceIdSchema.parse('11111111-1111-4111-8111-111111111111'))
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ input: { ...identity, mode: 'full' } })
      return Response.json({ kind: 'query', result: full })
    }) as typeof fetch
    expect(await readProcessPlantArtifact('run-artifact' as SimulationRunId, plant.id, 'authored-spec')).toEqual(full)
  })
})
