import { variablePathSchema } from './graph/index.ts'
import { findProcessPlantSignalBinding, processPlantSignalQuality, processPlantSignalView } from './signals.ts'
import { processPlantPwrReferenceModelRef } from './plant-definitions.ts'
import type { ProcessPlantRuntimeInstance } from './runtime-instance.ts'

interface ProcessPlantAssessmentDefinition {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly source: string
  readonly paths: (plant: ProcessPlantRuntimeInstance) => ReadonlyArray<string>
}

const assessmentDefinitions: ReadonlyArray<ProcessPlantAssessmentDefinition> = [
  {
    id: 'subcriticality',
    title: 'Subcriticality',
    description: 'Reactivity and rod position are model diagnostics; qualified shutdown evidence and a procedure-specific criterion are required.',
    source: 'source:apps/world/src/packs/process-plant/runtime/behaviors/reactor-behaviors.ts',
    paths: () => ['core.effectiveReactivityPcm', 'core.rodInsertionFraction'],
  },
  {
    id: 'core-cooling',
    title: 'Core cooling',
    description: 'Availability and heat-up diagnostics do not establish sustained delivered core cooling or its required receiver.',
    source: 'source:apps/world/src/packs/process-plant/runtime/pwr-transient-kernel.ts',
    paths: () => ['core.coreCoolingAvailabilityFraction', 'core.fuelHeatupRateCPerS'],
  },
  {
    id: 'heat-sink',
    title: 'Heat sink',
    description: 'SG level and heat transfer are model diagnostics; level alone cannot establish heat-removal adequacy or continued ultimate heat rejection.',
    source: 'source:apps/world/src/packs/process-plant/runtime/behaviors/steam-generator-behaviors.ts',
    paths: plant => plant.plant.graph.components.filter(component => component.kind === 'steamGenerator')
      .flatMap(component => [`${component.id}.levelPercent`, `${component.id}.heatTransferMw`]),
  },
  {
    id: 'rcs-integrity',
    title: 'RCS integrity',
    description: 'Leakage and relief position are model diagnostics; neither supplies a qualified pressure-temperature boundary integrity assessment.',
    source: 'source:apps/world/src/packs/process-plant/runtime/pwr-transient-kernel.ts',
    paths: () => ['vessel.primaryLeakFlowKgPerS', 'pressurizer.reliefValveEffectivePositionFraction'],
  },
  {
    id: 'containment',
    title: 'Containment',
    description: 'Pressure and radiation proxies do not establish containment structural, radiological, hydrogen or continuing resource adequacy.',
    source: 'source:apps/world/src/packs/process-plant/runtime/behaviors/containment-behaviors.ts',
    paths: () => ['containment.pressureMPa', 'containment.radiationSourceTermMSvPerH'],
  },
  {
    id: 'rcs-inventory',
    title: 'RCS inventory',
    description: 'Total primary inventory and PZR level do not establish core cover, coolant distribution or delivered emergency injection.',
    source: 'source:apps/world/src/packs/process-plant/runtime/pwr-transient-kernel.ts',
    paths: () => ['vessel.primaryCoolantInventoryKg', 'pressurizer.levelPercent'],
  },
]

const assessmentById = new Map(assessmentDefinitions.map(definition => [definition.id, definition]))

export const processPlantAssessmentCatalog = (): ReadonlyArray<Record<string, unknown>> =>
  assessmentDefinitions.map(({ id, title, description, source }) => ({
    id, title, description, source, compatibleModelRef: processPlantPwrReferenceModelRef,
    qualification: 'observation-only',
  }))

export const evaluateProcessPlantAssessments = (
  plant: ProcessPlantRuntimeInstance,
  assessmentIds: ReadonlyArray<string>,
): ReadonlyArray<Record<string, unknown>> => assessmentIds.map(id => {
  const definition = assessmentById.get(id)
  const identity = { modelRef: plant.plant.modelRef, modelDigest: plant.plant.modelDigest, simTimeMs: plant.runtime.elapsedMs() }
  if (definition === undefined) return { ...identity, id, title: id, status: 'unknown', reason: 'Unknown assessment.', signalsRead: [] }
  const basis = { source: definition.source, qualification: 'observation-only', description: definition.description }
  if (plant.plant.modelRef !== processPlantPwrReferenceModelRef) {
    return { ...identity, id, title: definition.title, status: 'unknown', reason: 'This observation group is not applicable to the selected Plant model.', basis, signalsRead: [] }
  }
  const missingSignals: string[] = []
  const unavailableSignals: Array<{ path: string; reason: string }> = []
  const signalsRead = definition.paths(plant).flatMap(path => {
    const binding = findProcessPlantSignalBinding(plant.plant.graph, { path: variablePathSchema.parse(path) })
    if (binding === undefined) { missingSignals.push(path); return [] }
    try {
      const variable = plant.runtime.readVariableSnapshot(binding.path)
      return [{ signal: processPlantSignalView(binding), variable, quality: processPlantSignalQuality(variable), provenance: 'runtime-model', instrumentationValidity: 'not-established' }]
    } catch (error) {
      unavailableSignals.push({ path, reason: error instanceof Error ? error.message : String(error) })
      return []
    }
  })
  return {
    ...identity, id, title: definition.title, status: 'unknown', basis, missingSignals, unavailableSignals,
    reason: `No qualified automatic CSF criterion is installed. ${definition.description}`,
    signalsRead,
  }
})
