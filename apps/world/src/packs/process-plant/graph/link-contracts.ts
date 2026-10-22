import type { CompiledProcessLink, DesignPhase, FluidKind, FluidSolverModel, LocalVariablePath } from './model.ts'
import type { RatioMeasurand, VariableActuation } from './semantics.ts'

interface FluidLinkContract {
  readonly solverModel: FluidSolverModel
  readonly allowedFluids: ReadonlySet<FluidKind>
  readonly requiredDesignPhase: DesignPhase
  readonly requiredVariables: ReadonlySet<string>
  readonly optionalVariables: ReadonlySet<string>
}

const setOf = <T extends string>(values: ReadonlyArray<T>): ReadonlySet<T> => new Set(values)

const baseFluidVariables = ['flowKgPerS', 'temperatureC'] as const
const linkLossVariables = ['leak.areaFraction', 'leakFlowKgPerS'] as const
const liquidChemistryVariables = ['soluteConcentrationPpm'] as const

const fluidLinkContracts: Readonly<Record<FluidSolverModel, FluidLinkContract>> = {
  sourceSink: {
    solverModel: 'sourceSink',
    allowedFluids: setOf(['water', 'oil', 'generic']),
    requiredDesignPhase: 'liquid',
    requiredVariables: setOf(baseFluidVariables),
    optionalVariables: setOf([...linkLossVariables, ...liquidChemistryVariables]),
  },
  incompressibleLiquid: {
    solverModel: 'incompressibleLiquid',
    allowedFluids: setOf(['water', 'oil', 'generic']),
    requiredDesignPhase: 'liquid',
    requiredVariables: setOf(baseFluidVariables),
    optionalVariables: setOf([
      ...linkLossVariables,
      ...liquidChemistryVariables,
      'pressureMPa',
      'pressureDropMPa',
    ]),
  },
  compressibleSteam: {
    solverModel: 'compressibleSteam',
    allowedFluids: setOf(['steam', 'generic']),
    requiredDesignPhase: 'steam',
    requiredVariables: setOf(baseFluidVariables),
    optionalVariables: setOf([
      ...linkLossVariables,
      'pressureMPa',
      'qualityFraction',
      'voidFraction',
      'enthalpyKJPerKg',
      'radiationMSvPerH',
    ]),
  },
  twoPhaseApprox: {
    solverModel: 'twoPhaseApprox',
    allowedFluids: setOf(['water', 'steam', 'generic']),
    requiredDesignPhase: 'twoPhase',
    requiredVariables: setOf(baseFluidVariables),
    optionalVariables: setOf([
      ...linkLossVariables,
      ...liquidChemistryVariables,
      'pressureMPa',
      'qualityFraction',
      'voidFraction',
      'enthalpyKJPerKg',
      'radiationMSvPerH',
    ]),
  },
}

// What link variables are, declared once with the contracts rather than per link.
const linkVariableSemantics: Readonly<Record<string, { readonly actuation?: VariableActuation; readonly measurand?: RatioMeasurand; readonly faultTruth?: true }>> = {
  'leak.areaFraction': { actuation: 'faultInjection', measurand: 'leak' },
  // A line's leak flow exists only while a leak is injected on it.
  leakFlowKgPerS: { faultTruth: true },
  qualityFraction: { measurand: 'quality' },
  voidFraction: { measurand: 'void' },
}

export const linkVariableSemanticsFor = (path: LocalVariablePath | string): { readonly actuation?: VariableActuation; readonly measurand?: RatioMeasurand; readonly faultTruth?: true } =>
  linkVariableSemantics[String(path)] ?? {}

const localVariablePathsFor = (link: CompiledProcessLink): ReadonlySet<string> =>
  new Set(link.variables.map(variable => String(variable.path).slice(String(link.id).length + 1)))

const assertHasFluidMetadata = (link: CompiledProcessLink): void => {
  if (link.solverModel === undefined) throw new Error(`fluid connection ${link.id} must declare solverModel`)
  if (link.nominalFluid === undefined) throw new Error(`fluid connection ${link.id} must declare nominalFluid`)
  if (link.designPhase === undefined) throw new Error(`fluid connection ${link.id} must declare designPhase`)
}

const assertExpectedVariable = (
  link: CompiledProcessLink,
  localPaths: ReadonlySet<string>,
  path: LocalVariablePath | string,
): void => {
  if (!localPaths.has(String(path))) throw new Error(`fluid connection ${link.id} with solverModel ${link.solverModel} must declare variable ${path}`)
}

const assertOnlyContractVariables = (
  link: CompiledProcessLink,
  localPaths: ReadonlySet<string>,
  contract: FluidLinkContract,
): void => {
  const allowedPaths = new Set([...contract.requiredVariables, ...contract.optionalVariables])
  for (const path of localPaths) {
    if (!allowedPaths.has(path)) {
      throw new Error(`fluid connection ${link.id} with solverModel ${link.solverModel} cannot declare unsupported variable ${path}`)
    }
  }
}

export const validateProcessLinkContract = (link: CompiledProcessLink): void => {
  if (link.kind !== 'fluidFlow') {
    if (link.solverModel !== undefined || link.nominalFluid !== undefined || link.designPhase !== undefined) {
      throw new Error(`non-fluid connection ${link.id} cannot declare fluid metadata`)
    }
    return
  }

  assertHasFluidMetadata(link)
  const solverModel = link.solverModel
  const nominalFluid = link.nominalFluid
  const designPhase = link.designPhase
  if (solverModel === undefined || nominalFluid === undefined || designPhase === undefined) {
    throw new Error(`fluid connection ${link.id} is missing required fluid metadata`)
  }
  const contract = fluidLinkContracts[solverModel]
  if (!contract) throw new Error(`fluid connection ${link.id} has unsupported solverModel ${link.solverModel}`)
  if (!contract.allowedFluids.has(nominalFluid)) {
    throw new Error(`fluid connection ${link.id} solverModel ${solverModel} does not support nominalFluid ${nominalFluid}`)
  }
  if (designPhase !== contract.requiredDesignPhase) {
    throw new Error(`fluid connection ${link.id} solverModel ${solverModel} requires designPhase ${contract.requiredDesignPhase}`)
  }

  const localPaths = localVariablePathsFor(link)
  for (const requiredVariable of contract.requiredVariables) {
    assertExpectedVariable(link, localPaths, requiredVariable)
  }
  assertOnlyContractVariables(link, localPaths, contract)

  if (link.service === 'primaryCoolant') {
    assertExpectedVariable(link, localPaths, 'pressureMPa')
    assertExpectedVariable(link, localPaths, 'pressureDropMPa')
  }
}

export const validateProcessLinkContracts = (links: ReadonlyArray<CompiledProcessLink>): void => {
  for (const link of links) {
    validateProcessLinkContract(link)
  }
}
