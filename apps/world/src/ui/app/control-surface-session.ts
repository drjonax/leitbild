import type { SimulationRunId, ObjectId, OperationalObject, ScenarioExecutionState, SimulationClockState } from '../../core/model/index.ts'
import type { ActivePackViews } from '../../core/packs/active-views.ts'
import type { PackSurfacePanelContribution, PackTargetContext } from '../../core/packs/protocol.ts'
import { startingControllerId } from '../surface-panel-interaction.ts'
import type { StartupStepId } from '../startup.ts'
import type { SimulationRunResponse } from '../types.ts'

export interface ControlSurfaceSnapshotStartupConfig {
  readonly response: SimulationRunResponse
  readonly pack: ActivePackViews
  readonly startStep: (id: StartupStepId) => void
  readonly completeStep: (id: StartupStepId) => void
  readonly setActiveStartupStep: (id: StartupStepId) => void
  readonly setSimulationRunId: (id: SimulationRunId) => void
  readonly setObjects: (objects: OperationalObject[]) => void
  readonly setScenarioState: (state: ScenarioExecutionState | undefined) => void
  readonly setClock: (clock: SimulationClockState | undefined) => void
  readonly setExpectedRealtimeScenarioId: (scenarioId: string) => void
  readonly setSelectedControllerId: (id: ObjectId | null) => void
  /** The targeting context of this screen for a snapshot's objects. */
  readonly targetContext: (objects: ReadonlyArray<OperationalObject>) => PackTargetContext
  /** Whether a surface panel is open; an open map-target panel owns the selection. */
  readonly isSurfacePanelOpen: (panel: PackSurfacePanelContribution) => boolean
  readonly setSeenRevisions: (seen: Map<string, number>) => void
  readonly setSnapshotReady: (ready: boolean) => void
  readonly loadSurfaceForScenario: (scenarioId: string) => Promise<void>
  readonly completeObjectsWhenReady: () => Promise<void>
  readonly connectRealtime: (id: SimulationRunId) => void
}

export const completeControlSurfaceStartupFromSnapshot = async (
  config: ControlSurfaceSnapshotStartupConfig,
): Promise<void> => {
  const snapshot = config.response.snapshot
  config.completeStep('simulation-run')
  config.setActiveStartupStep('snapshot')
  config.startStep('snapshot')
  config.setSimulationRunId(config.response.id)
  config.setObjects([...snapshot.objects])
  config.setScenarioState(snapshot.scenario)
  config.setClock(snapshot.clock)
  if (!snapshot.scenario?.scenarioId) throw new Error('simulation run snapshot is missing scenario state')
  config.setExpectedRealtimeScenarioId(snapshot.scenario.scenarioId)
  config.setSelectedControllerId(startingControllerId(snapshot.objects, config.pack, config.targetContext(snapshot.objects), config.isSurfacePanelOpen))
  config.setSeenRevisions(new Map(snapshot.objects.map(object => [object.id, object.revision])))
  config.setSnapshotReady(true)
  config.completeStep('snapshot')
  config.setActiveStartupStep('realtime')
  config.connectRealtime(config.response.id)
  config.setActiveStartupStep('map')
  config.startStep('map')
  await config.loadSurfaceForScenario(snapshot.scenario.scenarioId)
  config.setActiveStartupStep('objects')
  config.startStep('objects')
  await config.completeObjectsWhenReady()
}
