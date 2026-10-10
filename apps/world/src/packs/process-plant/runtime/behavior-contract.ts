import type { CompiledComponent, CompiledProcessLink, VariablePath } from '../graph/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import type { ProcessPlantSolverPhase, ProcessPlantValue } from './model.ts'
import type { ProcessPlantVariableTable } from './variable-table.ts'
import { assertProcessPlantValueIsFinite } from './variable-validation.ts'

const componentVariablePathCache = new WeakMap<CompiledComponent, Map<string, VariablePath>>()
const processLinkVariablePathCache = new WeakMap<CompiledProcessLink, Map<string, VariablePath>>()

export const componentVariablePath = (component: CompiledComponent, localPath: string): VariablePath =>
  cachedVariablePath(componentVariablePathCache, component, String(component.id), localPath)

export const processLinkVariablePath = (link: CompiledProcessLink, localPath: string): VariablePath =>
  cachedVariablePath(processLinkVariablePathCache, link, String(link.id), localPath)

const cachedVariablePath = <T extends object>(
  cache: WeakMap<T, Map<string, VariablePath>>,
  owner: T,
  ownerId: string,
  localPath: string,
): VariablePath => {
  const existingOwnerCache = cache.get(owner)
  if (existingOwnerCache) {
    const existing = existingOwnerCache.get(localPath)
    if (existing) return existing
    const created = `${ownerId}.${localPath}` as VariablePath
    existingOwnerCache.set(localPath, created)
    return created
  }
  const created = `${ownerId}.${localPath}` as VariablePath
  cache.set(owner, new Map([[localPath, created]]))
  return created
}

export interface ProcessPlantBehaviorContext {
  readonly phase: ProcessPlantSolverPhase
  readonly dtSeconds: number
  readonly has: (path: VariablePath) => boolean
  readonly read: (path: VariablePath) => ProcessPlantValue
  readonly readNumber: (path: VariablePath) => number
  readonly readBoolean: (path: VariablePath) => boolean
  readonly readOptionalNumber: (path: VariablePath, defaultValue: number) => number
  readonly write: (path: VariablePath, value: ProcessPlantValue) => void
}

export interface ReusableProcessPlantBehaviorContext extends ProcessPlantBehaviorContext {
  readonly configure: (config: {
    readonly behaviorId: string
    readonly phase: ProcessPlantSolverPhase
    readonly dtSeconds: number
    readonly writablePaths: ReadonlySet<VariablePath>
  }) => void
}

export interface ComponentBehaviorDefinition {
  readonly id: string
  readonly phase: ProcessPlantSolverPhase
  readonly componentKind: string
  readonly reads: ReadonlyArray<string>
  readonly writes: ReadonlyArray<string>
  readonly update: (input: {
    readonly system: CompiledProcessPlant
    readonly component: CompiledComponent
    readonly context: ProcessPlantBehaviorContext
  }) => void
}

export interface ComponentInitialReconciliationDefinition {
  readonly id: string
  readonly componentKind: string
  /** Runs once the links' initial flows and pressures are solved, for values derived from them. */
  readonly afterLinks?: boolean
  readonly reads: ReadonlyArray<string>
  readonly writes: ReadonlyArray<string>
  readonly reconcile: (input: {
    readonly system: CompiledProcessPlant
    readonly component: CompiledComponent
    readonly context: ProcessPlantBehaviorContext
  }) => void
}

export interface ProcessLinkBehaviorDefinition {
  readonly id: string
  readonly phase: ProcessPlantSolverPhase
  readonly reads: ReadonlyArray<string>
  readonly writes: ReadonlyArray<string>
  readonly appliesTo: (link: CompiledProcessLink) => boolean
  readonly update: (input: {
    readonly system: CompiledProcessPlant
    readonly link: CompiledProcessLink
    readonly context: ProcessPlantBehaviorContext
  }) => void
}

export const createBehaviorContext = (config: {
  readonly behaviorId: string
  readonly phase: ProcessPlantSolverPhase
  readonly dtSeconds: number
  readonly table: ProcessPlantVariableTable
  readonly writablePaths: ReadonlySet<VariablePath>
}): ProcessPlantBehaviorContext => {
  const context = createReusableBehaviorContext(config.table)
  context.configure(config)
  return context
}

export const createReusableBehaviorContext = (
  table: ProcessPlantVariableTable,
): ReusableProcessPlantBehaviorContext => {
  let behaviorId = ''
  let phase: ProcessPlantSolverPhase = 'updateControlLogic'
  let dtSeconds = 0
  let writablePaths: ReadonlySet<VariablePath> = new Set()

  return {
    get phase(): ProcessPlantSolverPhase {
      return phase
    },
    get dtSeconds(): number {
      return dtSeconds
    },
    configure: (config): void => {
      behaviorId = config.behaviorId
      phase = config.phase
      dtSeconds = config.dtSeconds
      writablePaths = config.writablePaths
    },
    has: table.has,
    read: table.read,
    readNumber: table.readNumber,
    readBoolean: table.readBoolean,
    readOptionalNumber: table.readOptionalNumber,
    write: (path, value): void => {
      if (!writablePaths.has(path)) {
        throw new Error(`process plant behavior ${behaviorId} cannot write undeclared variable: ${path}`)
      }
      assertProcessPlantValueIsFinite(path, value)
      table.write(path, value)
    },
  }
}

export const assertProcessPlantRuntimeInvariants = (table: ProcessPlantVariableTable): void => {
  table.assertInvariants()
}
