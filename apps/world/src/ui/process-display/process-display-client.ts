import type { OperationalObject, SimulationRunId } from '../../core/model/index.ts'
import { embeddedViewEnvelopeSchema, type EmbeddedViewEnvelope, type EmbeddedViewPublication } from '@leitbild/contracts'
import { querySimulationRunCapability } from '../simulation-run-client.ts'
import { activeWorkspaceId } from '../workspace-context.ts'

export type ProcessPlantArtifactKind = 'authored-spec' | 'compiled-graph-mermaid'

export interface ProcessPlantArtifactSourceLink {
  readonly symbol: string
  readonly importedName: string
  readonly targetPath: string
  readonly targetLineIndex: number | null
}

export interface ProcessPlantArtifactSourceFile {
  readonly path: string
  readonly content: string
}

export interface ProcessPlantArtifactComponent {
  readonly id: string
  readonly label: string
  readonly kind: string
  readonly shownOnOverview: boolean
  readonly sourcePath: string | null
  readonly sourceLinks: ReadonlyArray<ProcessPlantArtifactSourceLink>
}

export interface ProcessPlantArtifact {
  readonly plantId: string
  readonly artifact: ProcessPlantArtifactKind
  readonly title: string
  readonly language: 'json' | 'mermaid'
  readonly content: string
  readonly components: ReadonlyArray<ProcessPlantArtifactComponent>
  readonly sourceFiles: ReadonlyArray<ProcessPlantArtifactSourceFile>
  readonly metadata: {
    readonly specId: string
    readonly componentCount: number
    readonly linkCount: number
    readonly variableCount: number
    readonly overviewComponentCount: number
  }
}

export interface ProcessPlantCatalogEntry {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly compatibleModelRefs?: ReadonlyArray<string>
  readonly parameters?: Readonly<Record<string, unknown>>
}

export interface ProcessPlantActionParameter {
  readonly id: string
  readonly label: string
  readonly unit: string
  readonly defaultValue: number
  readonly min: number
  readonly max: number
  readonly step: number
  readonly digits: number
}

export interface ProcessPlantActionCatalogEntry extends Omit<ProcessPlantCatalogEntry, 'parameters'> {
  readonly parameters: ReadonlyArray<ProcessPlantActionParameter>
  readonly inputSchema: Readonly<Record<string, unknown>>
}

export interface ProcessPlantCatalog {
  readonly models: ReadonlyArray<ProcessPlantCatalogEntry>
  readonly operatingPoints: ReadonlyArray<ProcessPlantCatalogEntry>
  readonly automations: ReadonlyArray<ProcessPlantCatalogEntry>
  readonly actions: ReadonlyArray<ProcessPlantActionCatalogEntry>
  readonly assessments: ReadonlyArray<ProcessPlantCatalogEntry>
  readonly recordingProfiles: ReadonlyArray<ProcessPlantCatalogEntry>
  readonly credibilityEvidence: ReadonlyArray<ProcessPlantCatalogEntry>
}

export const processPlantIdForObject = (
  object: Pick<OperationalObject, 'id' | 'packId'>,
): string | null => object.packId === 'process-plant' ? String(object.id) : null

export type ProcessPlantCredibilityArtifactLanguage = 'json' | 'svg'

export interface ProcessPlantCredibilityArtifactRef {
  readonly id: string
  readonly title: string
  readonly language: ProcessPlantCredibilityArtifactLanguage
  readonly contentType: string
  readonly path: string
}

export interface ProcessPlantCredibilityEvidence {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly scope: string
  readonly generatedFromCommand: string
  readonly artifacts: ReadonlyArray<ProcessPlantCredibilityArtifactRef>
}

export interface ProcessPlantCredibilityList {
  readonly plantId: string
  readonly evidence: ReadonlyArray<ProcessPlantCredibilityEvidence>
}

export interface ProcessPlantCredibilityArtifact {
  readonly plantId: string
  readonly evidence: ProcessPlantCredibilityEvidence
  readonly artifact: ProcessPlantCredibilityArtifactRef
  readonly content: string
}

const assertObject = (value: unknown, message: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}

const assertArray = (value: unknown, message: string): ReadonlyArray<unknown> => {
  if (!Array.isArray(value)) throw new Error(message)
  return value
}

const assertString = (value: unknown, message: string): string => {
  if (typeof value !== 'string') throw new Error(message)
  return value
}

const assertNumber = (value: unknown, message: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(message)
  return value
}

const parseProcessPlantArtifactComponent = (value: unknown): ProcessPlantArtifactComponent => {
  const component = assertObject(value, 'process plant artifact component is malformed')
  if (typeof component.shownOnOverview !== 'boolean') throw new Error('process plant artifact component requires shownOnOverview')
  if (component.sourcePath !== null && typeof component.sourcePath !== 'string') throw new Error('process plant artifact component has invalid sourcePath')
  return {
    id: assertString(component.id, 'process plant artifact component requires id'),
    label: assertString(component.label, 'process plant artifact component requires label'),
    kind: assertString(component.kind, 'process plant artifact component requires kind'),
    shownOnOverview: component.shownOnOverview,
    sourcePath: component.sourcePath,
    sourceLinks: assertArray(component.sourceLinks, 'process plant artifact component requires sourceLinks').map(value => {
      const link = assertObject(value, 'process plant artifact source link is malformed')
      if (link.targetLineIndex !== null && (typeof link.targetLineIndex !== 'number' || !Number.isInteger(link.targetLineIndex))) {
        throw new Error('process plant artifact source link has invalid targetLineIndex')
      }
      return {
        symbol: assertString(link.symbol, 'process plant artifact source link requires symbol'),
        importedName: assertString(link.importedName, 'process plant artifact source link requires importedName'),
        targetPath: assertString(link.targetPath, 'process plant artifact source link requires targetPath'),
        targetLineIndex: link.targetLineIndex,
      }
    }),
  }
}

const parseProcessPlantArtifactSourceFile = (value: unknown): ProcessPlantArtifactSourceFile => {
  const file = assertObject(value, 'process plant artifact source file is malformed')
  return {
    path: assertString(file.path, 'process plant artifact source file requires path'),
    content: assertString(file.content, 'process plant artifact source file requires content'),
  }
}

const parseProcessPlantCatalogEntry = (value: unknown): ProcessPlantCatalogEntry => {
  const entry = assertObject(value, 'process plant catalog entry is malformed')
  return {
    id: assertString(entry.id, 'process plant catalog entry requires id'),
    title: assertString(entry.title, 'process plant catalog entry requires title'),
    ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
    ...(entry.compatibleModelRefs === undefined ? {} : {
      compatibleModelRefs: assertArray(entry.compatibleModelRefs, 'process plant catalog compatibleModelRefs must be an array')
        .map(ref => assertString(ref, 'process plant catalog compatible model ref must be a string')),
    }),
    ...(entry.parameters !== undefined && !Array.isArray(entry.parameters)
      ? { parameters: assertObject(entry.parameters, 'process plant catalog parameters must be an object') }
      : {}),
  }
}

const parseProcessPlantActionParameter = (value: unknown): ProcessPlantActionParameter => {
  const parameter = assertObject(value, 'process plant action parameter is malformed')
  return {
    id: assertString(parameter.id, 'process plant action parameter requires id'),
    label: assertString(parameter.label, 'process plant action parameter requires label'),
    unit: assertString(parameter.unit, 'process plant action parameter requires unit'),
    defaultValue: assertNumber(parameter.defaultValue, 'process plant action parameter requires defaultValue'),
    min: assertNumber(parameter.min, 'process plant action parameter requires min'),
    max: assertNumber(parameter.max, 'process plant action parameter requires max'),
    step: assertNumber(parameter.step, 'process plant action parameter requires step'),
    digits: assertNumber(parameter.digits, 'process plant action parameter requires digits'),
  }
}

const parseProcessPlantAction = (value: unknown): ProcessPlantActionCatalogEntry => {
  const entry = assertObject(value, 'process plant action is malformed')
  const base = parseProcessPlantCatalogEntry(entry)
  return {
    ...base,
    parameters: assertArray(entry.parameters, 'process plant action requires parameters').map(parseProcessPlantActionParameter),
    inputSchema: assertObject(entry.inputSchema, 'process plant action requires inputSchema'),
  }
}

export const readProcessPlantCatalog = async (
  simulationRunId: SimulationRunId,
): Promise<ProcessPlantCatalog> => {
  const result = assertObject(await querySimulationRunCapability(
    simulationRunId,
    'world.process-plant.catalog.list',
    {},
  ), 'process plant catalog result is malformed')
  return {
    models: assertArray(result.models, 'process plant catalog result has no models array').map(parseProcessPlantCatalogEntry),
    operatingPoints: assertArray(result.operatingPoints, 'process plant catalog result has no operatingPoints array').map(parseProcessPlantCatalogEntry),
    automations: assertArray(result.automations, 'process plant catalog result has no automations array').map(parseProcessPlantCatalogEntry),
    actions: assertArray(result.actions, 'process plant catalog result has no actions array').map(parseProcessPlantAction),
    assessments: assertArray(result.assessments, 'process plant catalog result has no assessments array').map(parseProcessPlantCatalogEntry),
    recordingProfiles: assertArray(result.recordingProfiles, 'process plant catalog result has no recordingProfiles array').map(parseProcessPlantCatalogEntry),
    credibilityEvidence: assertArray(result.credibilityEvidence, 'process plant catalog result has no credibilityEvidence array').map(parseProcessPlantCatalogEntry),
  }
}

const parseProcessPlantCredibilityArtifactLanguage = (value: unknown): ProcessPlantCredibilityArtifactLanguage => {
  const language = assertString(value, 'process plant credibility artifact requires language')
  if (language !== 'json' && language !== 'svg') throw new Error(`unsupported process plant credibility artifact language: ${language}`)
  return language
}

const parseProcessPlantCredibilityArtifactRef = (value: unknown): ProcessPlantCredibilityArtifactRef => {
  const artifact = assertObject(value, 'process plant credibility artifact ref is malformed')
  return {
    id: assertString(artifact.id, 'process plant credibility artifact requires id'),
    title: assertString(artifact.title, 'process plant credibility artifact requires title'),
    language: parseProcessPlantCredibilityArtifactLanguage(artifact.language),
    contentType: assertString(artifact.contentType, 'process plant credibility artifact requires contentType'),
    path: assertString(artifact.path, 'process plant credibility artifact requires path'),
  }
}

const parseProcessPlantCredibilityEvidence = (value: unknown): ProcessPlantCredibilityEvidence => {
  const evidence = assertObject(value, 'process plant credibility evidence is malformed')
  return {
    id: assertString(evidence.id, 'process plant credibility evidence requires id'),
    title: assertString(evidence.title, 'process plant credibility evidence requires title'),
    description: assertString(evidence.description, 'process plant credibility evidence requires description'),
    scope: assertString(evidence.scope, 'process plant credibility evidence requires scope'),
    generatedFromCommand: assertString(evidence.generatedFromCommand, 'process plant credibility evidence requires generatedFromCommand'),
    artifacts: assertArray(evidence.artifacts, 'process plant credibility evidence requires artifacts').map(parseProcessPlantCredibilityArtifactRef),
  }
}

export const listProcessPlantCredibilityEvidence = async (
  simulationRunId: SimulationRunId,
  plantId: string,
): Promise<ProcessPlantCredibilityList> => {
  const result = assertObject(await querySimulationRunCapability(
    simulationRunId,
    'world.process-plant.credibility.list',
    { plantId },
  ), 'process plant credibility list result is malformed')
  return {
    plantId: assertString(result.plantId, 'process plant credibility list requires plantId'),
    evidence: assertArray(result.evidence, 'process plant credibility list requires evidence').map(parseProcessPlantCredibilityEvidence),
  }
}

export const readProcessPlantCredibilityArtifact = async (
  simulationRunId: SimulationRunId,
  plantId: string,
  evidenceId: string,
  artifactId: string,
): Promise<ProcessPlantCredibilityArtifact> => {
  const result = assertObject(await querySimulationRunCapability(
    simulationRunId,
    'world.process-plant.credibility.read',
    { plantId, evidenceId, artifactId },
  ), 'process plant credibility artifact result is malformed')
  return {
    plantId: assertString(result.plantId, 'process plant credibility read requires plantId'),
    evidence: parseProcessPlantCredibilityEvidence(result.evidence),
    artifact: parseProcessPlantCredibilityArtifactRef(result.artifact),
    content: assertString(result.content, 'process plant credibility artifact requires content'),
  }
}

export const readProcessPlantArtifact = async (
  simulationRunId: SimulationRunId,
  plantId: string,
  artifact: ProcessPlantArtifactKind,
): Promise<ProcessPlantArtifact> => {
  const result = assertObject(await querySimulationRunCapability(
    simulationRunId,
    'world.process-plant.artifact.read',
    { plantId, artifact, mode: 'full' },
  ), 'process plant artifact result is malformed')
  const metadata = assertObject(result.metadata, 'process plant artifact result requires metadata')
  const language = assertString(result.language, 'process plant artifact result requires language')
  if (language !== 'json' && language !== 'mermaid') throw new Error(`unsupported process plant artifact language: ${language}`)
  const returnedArtifact = assertString(result.artifact, 'process plant artifact result requires artifact')
  if (returnedArtifact !== 'authored-spec' && returnedArtifact !== 'compiled-graph-mermaid') {
    throw new Error(`unsupported process plant artifact kind: ${returnedArtifact}`)
  }
  return {
    plantId: assertString(result.plantId, 'process plant artifact result requires plantId'),
    artifact: returnedArtifact,
    title: assertString(result.title, 'process plant artifact result requires title'),
    language,
    content: assertString(result.content, 'process plant artifact result requires content'),
    components: assertArray(result.components, 'process plant artifact result requires components').map(parseProcessPlantArtifactComponent),
    sourceFiles: assertArray(result.sourceFiles, 'process plant artifact result requires sourceFiles').map(parseProcessPlantArtifactSourceFile),
    metadata: {
      specId: assertString(metadata.specId, 'process plant artifact metadata requires specId'),
      componentCount: assertNumber(metadata.componentCount, 'process plant artifact metadata requires componentCount'),
      linkCount: assertNumber(metadata.linkCount, 'process plant artifact metadata requires linkCount'),
      variableCount: assertNumber(metadata.variableCount, 'process plant artifact metadata requires variableCount'),
      overviewComponentCount: assertNumber(metadata.overviewComponentCount, 'process plant artifact metadata requires overviewComponentCount'),
    },
  }
}

/**
 * The unit overview World generates for a Plant, as the embedded view the
 * process display window frames. The Run is the view's subject, as for a
 * display shown below an agent's answer.
 */
export const readUnitOverviewView = async (
  simulationRunId: SimulationRunId,
  plantId: string,
): Promise<EmbeddedViewEnvelope> => {
  const result = await querySimulationRunCapability<{ readonly view: EmbeddedViewPublication }>(simulationRunId, 'world.process-plant.display.overview', { plantId })
  return embeddedViewEnvelopeSchema.parse({
    moduleId: 'world',
    subject: { workspaceId: activeWorkspaceId(), moduleId: 'world', type: 'world.simulation-run', id: simulationRunId },
    ...result.view,
  })
}
