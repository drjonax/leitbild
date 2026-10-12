import type { OperationalObject, ScenarioExecutionState, SimulationClockState } from '../../core/model/index.ts'

/**
 * A connection to a role Run tags every message with the epoch of the role
 * set it was produced for. The gate admits messages of the current epoch and
 * later ones; a ready message of a newer epoch carries a fresh snapshot that
 * replaces every Run-scoped store, and nothing from an older epoch is applied
 * after that. A Run without roles sends no epochs and the gate admits all.
 * Epochs count per connection: a new connection starts a new gate.
 */
export interface PerspectiveGate {
  /** The newest epoch adopted on this connection; 0 before its first ready. */
  readonly epoch: () => number
  /** Whether a message tagged with this epoch may still be applied. */
  readonly admits: (epoch: number | undefined) => boolean
  /** A ready message: true when its snapshot must replace the Run stores. */
  readonly adopt: (epoch: number) => boolean
}

export const createPerspectiveGate = (): PerspectiveGate => {
  let current = 0
  return {
    epoch: () => current,
    admits: epoch => epoch === undefined || epoch >= current,
    adopt: epoch => {
      if (epoch < current) return false
      current = epoch
      return true
    },
  }
}

export interface PerspectiveSnapshot {
  readonly objects: ReadonlyArray<OperationalObject>
  readonly seq: number
  readonly scenario?: ScenarioExecutionState
  readonly clock?: SimulationClockState
}

/**
 * Every Run-scoped store a World screen keeps for one perspective. Map
 * viewport, panel sizes, theme and rail width are not Run-scoped and stay.
 */
export interface RunScopedStores {
  readonly objects: ReadonlyArray<OperationalObject>
  readonly scenarioState: ScenarioExecutionState | undefined
  readonly clock: SimulationClockState | undefined
  readonly selectedControllerId: string | null
  readonly seenRevisions: ReadonlyMap<string, number>
  readonly packDataRevisions: Readonly<Record<string, number>>
  readonly packPanelSelections: Readonly<Record<string, string | null>>
}

/** The stores of a perspective, built only from its own snapshot; nothing carries over. */
export const storesForPerspective = (
  snapshot: PerspectiveSnapshot,
  isController: (object: OperationalObject) => boolean,
): RunScopedStores => ({
  objects: [...snapshot.objects],
  scenarioState: snapshot.scenario,
  clock: snapshot.clock,
  selectedControllerId: snapshot.objects.find(isController)?.id ?? null,
  seenRevisions: new Map(snapshot.objects.map(object => [object.id, object.revision])),
  packDataRevisions: {},
  packPanelSelections: {},
})

/**
 * The perspective a screen's Run-scoped requests belong to. A request's
 * answer is applied only while the screen still holds the role set it was
 * asked under.
 */
export const perspectiveKey = (roleIds: ReadonlyArray<string> | null): string =>
  roleIds === null ? '' : [...roleIds].sort().join(',')
