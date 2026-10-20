import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { idSchema, matchesLiteralSearch, objectIdSchema, type ObjectId, type OperationalObject } from '../../../core/model/index.ts'
import type { PackRuntimeQuery } from '../../../simulation/protocol.ts'
import type { CompiledPlantGraph, ComponentId } from '../graph/index.ts'
import { plantGraphToMermaid } from '../graph/index.ts'
import { processPlantComponentBehaviorSourcePathByKind } from '../runtime/behaviors/index.ts'
import { principalCircuits, plantCarriers, plantLoops } from '../equipment/circuits.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'
import { rejectCapabilityInput } from '../../../simulation/capability-rejection.ts'
import { capabilityTargetNotFound, requirePlant, processPlantSearchPaginationShape, paginateProcessPlantSearch } from './common.ts'
import { graphReadQuerySchema, graphReadView } from './graph-read.ts'

const artifactIdentityShape = {
  plantId: idSchema,
  artifact: z.enum(['authored-spec', 'compiled-graph-mermaid']),
}

export const artifactReadQuerySchema = z.union([
  z.object({ ...artifactIdentityShape, mode: z.literal('index').default('index'), ...processPlantSearchPaginationShape }).strict(),
  z.object({ ...artifactIdentityShape, mode: z.literal('full') }).strict(),
  z.object({ ...artifactIdentityShape, mode: z.literal('component'), componentId: idSchema }).strict(),
  z.object({
    ...artifactIdentityShape,
    mode: z.literal('source'),
    sourcePath: z.string().min(1).describe('Exact path from the artifact sourceFiles index.'),
    startLine: z.number().int().min(1).default(1).describe('One-based line; existing sourceLinks.targetLineIndex is zero-based, so add 1.'),
    lineCount: z.number().int().min(1).max(200).default(80),
    expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional().describe('Pin from the index or a previous source slice; rejects changed source bytes.'),
  }).strict(),
])

export const componentsSearchQuerySchema = z.object({
  plantId: idSchema,
  query: z.string().trim().min(1).optional(),
  componentIds: z.array(idSchema).optional(),
  kinds: z.array(z.string().trim().min(1)).optional(),
  includeParameters: z.boolean().default(false),
}).strict()

interface ArtifactComponentView {
  readonly id: ComponentId
  readonly label: string
  readonly kind: string
  readonly shownOnOverview: boolean
  readonly sourcePath: string | null
  readonly sourceLinks: ReadonlyArray<ComponentSourceImportView>
}

interface ComponentSourceImportView {
  readonly symbol: string
  readonly importedName: string
  readonly targetPath: string
  readonly targetLineIndex: number | null
}

interface ArtifactSourceFileView {
  readonly path: string
  readonly content: string
}

// Public artifact references use repository-relative paths, the same identity
// as product source inspection. The behavior registry is World-local only.
const sourceRoot = new URL('../../../../../..', import.meta.url)
const processPlantSourceRoot = new URL('apps/world/src/packs/process-plant/', sourceRoot)
const componentSourceCache = new Map<string, string>()
const componentSourceImportCache = new Map<string, ReadonlyArray<ComponentSourceImportView>>()

const sourceUrlFor = (sourcePath: string): URL => {
  const url = new URL(sourcePath, sourceRoot)
  if (!url.href.startsWith(processPlantSourceRoot.href)) {
    throw new Error(`process plant source path leaves the Pack boundary: ${sourcePath}`)
  }
  return url
}

const sourceTextFor = (sourcePath: string): string => {
  const existing = componentSourceCache.get(sourcePath)
  if (existing !== undefined) return existing
  const content = readFileSync(sourceUrlFor(sourcePath), 'utf8')
  componentSourceCache.set(sourcePath, content)
  return content
}

const importDeclarationPattern = /(?:^|\n)\s*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g
const identifierCharacters = /^[A-Za-z_$][A-Za-z0-9_$]*$/

const relativeSourcePathFor = (url: URL): string | null => {
  if (!url.href.startsWith(processPlantSourceRoot.href)) return null
  return decodeURIComponent(url.href.slice(sourceRoot.href.length))
}

const resolveRelativeSourcePath = (sourcePath: string, importPath: string): string | null => {
  if (!importPath.startsWith('.')) return null
  const resolved = new URL(importPath, sourceUrlFor(sourcePath))
  if (!resolved.pathname.endsWith('.ts')) resolved.pathname = `${resolved.pathname}.ts`
  return relativeSourcePathFor(resolved)
}

const importedSymbolsFor = (importClause: string): ReadonlyArray<{ readonly symbol: string; readonly importedName: string }> => {
  const namedImportBody = /\{([\s\S]*?)\}/.exec(importClause)?.[1]
  if (namedImportBody === undefined) return []
  return namedImportBody
    .split(',')
    .map(part => part.trim().replace(/^type\s+/, '').trim())
    .filter(part => part.length > 0)
    .flatMap(part => {
      const [imported, alias] = part.split(/\s+as\s+/).map(value => value.trim())
      if (!imported || !identifierCharacters.test(imported)) return []
      const symbol = alias && identifierCharacters.test(alias) ? alias : imported
      return [{ symbol, importedName: imported }]
    })
}

const escapedIdentifier = (identifier: string): string => identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const definitionLineIndexFor = (content: string, exportedName: string): number | null => {
  const pattern = new RegExp(`^\\s*export\\s+(?:const|function|interface|type|enum)\\s+${escapedIdentifier(exportedName)}\\b`)
  const index = content.split(/\r\n|\r|\n/).findIndex(line => pattern.test(line))
  return index < 0 ? null : index
}

const componentSourceImportsFor = (sourcePath: string): ReadonlyArray<ComponentSourceImportView> => {
  const cached = componentSourceImportCache.get(sourcePath)
  if (cached) return cached
  const imports: ComponentSourceImportView[] = []
  const seen = new Set<string>()
  for (const match of sourceTextFor(sourcePath).matchAll(importDeclarationPattern)) {
    const targetPath = resolveRelativeSourcePath(sourcePath, match[2] ?? '')
    if (!targetPath) continue
    const targetContent = sourceTextFor(targetPath)
    for (const imported of importedSymbolsFor(match[1] ?? '')) {
      const key = `${imported.symbol}:${targetPath}:${imported.importedName}`
      if (seen.has(key)) continue
      seen.add(key)
      imports.push({
        ...imported,
        targetPath,
        targetLineIndex: definitionLineIndexFor(targetContent, imported.importedName),
      })
    }
  }
  componentSourceImportCache.set(sourcePath, imports)
  return imports
}

export const processPlantGraphQueryKinds = [
  'world.process-plant.plants.list',
  'world.process-plant.components.search',
  'world.process-plant.graph.read',
  'world.process-plant.artifact.read',
] as const

const componentSearchView = (
  system: ProcessPlantRuntimeInstance,
  input: z.infer<typeof componentsSearchQuerySchema>,
): unknown => {
  const idSet = input.componentIds ? new Set(input.componentIds) : undefined
  const kindSet = input.kinds ? new Set(input.kinds) : undefined
  const matches = system.plant.graph.components.filter(component => {
    if (idSet && !idSet.has(component.id)) return false
    if (kindSet && !kindSet.has(component.kind)) return false
    return matchesLiteralSearch(input.query, [component.id, component.kind, component.label])
  })
  const byKind: Record<string, number> = {}
  for (const component of system.plant.graph.components) {
    byKind[component.kind] = (byKind[component.kind] ?? 0) + 1
  }
  return {
    plantId: system.plant.id,
    specification: {
      id: system.plant.graph.specId,
      title: system.plant.graph.title,
      timestep: system.plant.graph.timestep,
    },
    totalComponents: system.plant.graph.components.length,
    matchedComponents: matches.length,
    byKind,
    components: matches.map(component => ({
      id: component.id,
      kind: component.kind,
      label: component.label,
      ...(component.metadata ? { metadata: component.metadata } : {}),
      ...(input.includeParameters ? { parameters: component.parameters } : {}),
    })),
  }
}

const overviewComponentIdsCache = new WeakMap<ProcessPlantRuntimeInstance, ReadonlySet<ComponentId>>()

// The equipment the generated unit overview draws: its principal circuits.
// A Plant whose energy has no closed circuit has no overview, so nothing is on one.
const overviewComponentIdsFor = (system: ProcessPlantRuntimeInstance): ReadonlySet<ComponentId> => {
  const existing = overviewComponentIdsCache.get(system)
  if (existing) return existing
  const graph = system.plant.graph
  const circuits = principalCircuits(graph)
  const ids = new Set<ComponentId>(circuits.ok ? circuits.components.map(index => graph.components[index]!.id) : [])
  overviewComponentIdsCache.set(system, ids)
  return ids
}

const artifactMetadata = (
  graph: CompiledPlantGraph,
  overviewComponentIds: ReadonlySet<ComponentId>,
): Record<string, unknown> => ({
  specId: graph.specId,
  componentCount: graph.components.length,
  linkCount: graph.links.length,
  variableCount: graph.variables.length,
  overviewComponentCount: overviewComponentIds.size,
})

const artifactComponents = (
  graph: CompiledPlantGraph,
  overviewComponentIds: ReadonlySet<ComponentId>,
): ReadonlyArray<ArtifactComponentView> => {
  return graph.components.map(component => {
    const localSourcePath = processPlantComponentBehaviorSourcePathByKind.get(component.kind)
    const sourcePath = localSourcePath === undefined ? null : `apps/world/${localSourcePath}`
    return {
      id: component.id,
      label: component.label,
      kind: component.kind,
      shownOnOverview: overviewComponentIds.has(component.id),
      sourcePath,
      sourceLinks: sourcePath === null ? [] : componentSourceImportsFor(sourcePath),
    }
  })
}

const artifactSourceFiles = (components: ReadonlyArray<ArtifactComponentView>): ReadonlyArray<ArtifactSourceFileView> => {
  const paths = new Set<string>()
  for (const component of components) {
    if (component.sourcePath !== null) paths.add(component.sourcePath)
    for (const link of component.sourceLinks) paths.add(link.targetPath)
  }
  return [...paths].sort().map(path => ({ path, content: sourceTextFor(path) }))
}

const fullArtifactView = (
  system: ProcessPlantRuntimeInstance,
  artifact: 'authored-spec' | 'compiled-graph-mermaid',
): unknown => {
  const overviewComponentIds = overviewComponentIdsFor(system)
  const components = artifactComponents(system.plant.graph, overviewComponentIds)
  if (artifact === 'authored-spec') {
    return {
      plantId: system.plant.id,
      artifact,
      title: `${system.plant.graph.title} source specification`,
      language: 'json',
      content: JSON.stringify(system.plant.sourceGraph, null, 2),
      components,
      sourceFiles: artifactSourceFiles(components),
      metadata: artifactMetadata(system.plant.graph, overviewComponentIds),
    }
  }
  return {
    plantId: system.plant.id,
    artifact,
    title: `${system.plant.graph.title} full component graph`,
    language: 'mermaid',
    content: plantGraphToMermaid(system.plant.graph, { highlightedComponentIds: overviewComponentIds }),
    components,
    sourceFiles: artifactSourceFiles(components),
    metadata: artifactMetadata(system.plant.graph, overviewComponentIds),
  }
}

const artifactCoverage = 'Implementation coverage is component behavior source files and their direct named imports inside the process-plant Pack, not the complete Pack, application, integration, or controller implementation. Absence from this bundle does not establish absence from the model. Component selection returns one exact authored component, not its surrounding configuration. Source links use zero-based targetLineIndex; source reads use one-based startLine.'

// Keep original line endings so concatenating pinned pages reproduces the file exactly.
const sourceLines = (content: string): string[] => content.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? []
const sourceSha256 = (content: string): string => createHash('sha256').update(content).digest('hex')

const artifactView = (system: ProcessPlantRuntimeInstance, input: z.infer<typeof artifactReadQuerySchema>): unknown => {
  if (input.mode === 'full') return fullArtifactView(system, input.artifact)
  const overviewComponentIds = overviewComponentIdsFor(system)
  const components = artifactComponents(system.plant.graph, overviewComponentIds)
  const common = {
    plantId: system.plant.id,
    artifact: input.artifact,
    mode: input.mode,
    metadata: artifactMetadata(system.plant.graph, overviewComponentIds),
    coverage: artifactCoverage,
  }
  if (input.mode === 'component') {
    const component = components.find(candidate => candidate.id === input.componentId)
    if (!component) return capabilityTargetNotFound(`Artifact component not found: ${input.componentId}. Discover exact component ids with world.process-plant.artifact.read mode index.`)
    const authoredComponent = system.plant.sourceGraph.components.find(candidate => candidate.id === input.componentId)
    if (!authoredComponent) throw new Error(`Compiled component has no authored artifact component: ${input.componentId}`)
    // Match the authored JSON export, which omits in-memory undefined properties.
    return { ...common, component, authoredComponent: JSON.parse(JSON.stringify(authoredComponent)) }
  }
  const sourceFiles = artifactSourceFiles(components)
  if (input.mode === 'index') {
    const { items, ...page } = paginateProcessPlantSearch(components, input.offset, input.limit)
    return {
      ...common,
      ...page,
      components: items.map(({ sourceLinks: _links, ...component }) => component),
      sourceFiles: sourceFiles.map(file => ({ path: file.path, lineCount: sourceLines(file.content).length, byteCount: Buffer.byteLength(file.content), sha256: sourceSha256(file.content) })),
    }
  }
  const file = sourceFiles.find(candidate => candidate.path === input.sourcePath)
  if (!file) return capabilityTargetNotFound(`Artifact source file not found: ${input.sourcePath}. Select an exact sourceFiles path from world.process-plant.artifact.read mode index; this is not a complete repository reader.`)
  const sha256 = sourceSha256(file.content)
  if (input.expectedSha256 !== undefined && input.expectedSha256 !== sha256) return rejectCapabilityInput('Artifact source bytes changed. Read the index again before continuing; do not combine pages with different sha256 values.')
  const lines = sourceLines(file.content)
  if (input.startLine > Math.max(1, lines.length)) return rejectCapabilityInput(`Artifact source startLine ${input.startLine} exceeds totalLines ${lines.length}.`)
  const selected = lines.slice(input.startLine - 1, input.startLine - 1 + input.lineCount)
  const endLine = input.startLine + selected.length - 1
  const hasMore = endLine < lines.length
  return {
    ...common,
    sourcePath: file.path,
    sha256,
    totalLines: lines.length,
    byteCount: Buffer.byteLength(file.content),
    startLine: input.startLine,
    endLine,
    returnedLines: selected.length,
    content: selected.join(''),
    hasMore,
    nextRead: hasMore ? { ...input, startLine: endLine + 1, expectedSha256: sha256 } : null,
  }
}

export const answerProcessPlantGraphQuery = (config: {
  readonly request: PackRuntimeQuery
  readonly plants: ReadonlyMap<string, ProcessPlantRuntimeInstance>
  readonly objects: ReadonlyMap<ObjectId, Pick<OperationalObject, 'id' | 'label'>>
}): unknown | undefined => {
  if (!processPlantGraphQueryKinds.some(kind => kind === config.request.capabilityId)) return undefined
  if (config.request.capabilityId === 'world.process-plant.plants.list') {
    return {
      plants: [...config.plants.values()].map(({ plant, runtime }) => {
        const object = config.objects.get(objectIdSchema.parse(plant.id))
        if (!object) return capabilityTargetNotFound(`Operational object missing for active Process Plant: ${plant.id}`)
        return {
          id: plant.id,
          label: object.label,
          model: { id: plant.graph.specId, title: plant.graph.title },
          modelRef: plant.modelRef,
          modelDigest: plant.modelDigest,
          componentCount: plant.graph.components.length,
          linkCount: plant.graph.links.length,
          variableCount: plant.graph.variables.length,
          // What a display can name: the Plant's fluid services and power, and its loops.
          services: plantCarriers(plant.graph),
          loops: plantLoops(plant.graph),
          elapsedMs: runtime.elapsedMs(),
        }
      }),
    }
  }
  if (config.request.capabilityId === 'world.process-plant.graph.read') {
    const payload = graphReadQuerySchema.parse(config.request.input)
    const system = requirePlant(config.plants, payload.plantId)
    return graphReadView(system.plant.id, system.plant.graph, payload)
  }
  if (config.request.capabilityId === 'world.process-plant.components.search') {
    const payload = componentsSearchQuerySchema.parse(config.request.input)
    const system = requirePlant(config.plants, payload.plantId)
    return componentSearchView(system, payload)
  }
  const payload = artifactReadQuerySchema.parse(config.request.input)
  const system = requirePlant(config.plants, payload.plantId)
  return artifactView(system, payload)
}
