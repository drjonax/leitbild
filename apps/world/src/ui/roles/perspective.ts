import type { CompiledScenario, ObjectId, OperationalObject, ScenarioExecutionState, SimulationClockState } from '../../core/model/index.ts'
import { runRolesOf } from '../../core/model/index.ts'
import { noteAction, type CommandFeedback } from '../command-feedback.ts'
import { roleSetText } from './role-controller.ts'
import { sameRoleSet } from './role-session.ts'

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

/** A role Run's ready message: its epoch, the role set it began, and everything the screen keeps of the Run. */
export interface RealtimePerspective {
  readonly epoch: number
  readonly roleIds: ReadonlyArray<string>
  readonly snapshot: PerspectiveSnapshot
  /** The Compiled Scenario as this perspective may see it. */
  readonly compiledScenario: CompiledScenario
}

/**
 * Every Run-scoped store a World screen keeps for one perspective. Map
 * viewport, panel sizes, theme and rail width are not Run-scoped and stay.
 */
export interface RunScopedStores {
  readonly compiledScenario: CompiledScenario
  readonly objects: ReadonlyArray<OperationalObject>
  readonly scenarioState: ScenarioExecutionState | undefined
  readonly clock: SimulationClockState | undefined
  readonly selectedControllerId: ObjectId | null
  readonly seenRevisions: ReadonlyMap<string, number>
  readonly packDataRevisions: Readonly<Record<string, number>>
  readonly packPanelSelections: Readonly<Record<string, string | null>>
  readonly commandFeedback: CommandFeedback
}

/** What the screen showed before a ready message arrived. */
export interface ScreenPerspective {
  readonly epoch: number
  readonly roleIds: ReadonlyArray<string> | null
  readonly feedback: CommandFeedback
}

/**
 * The stores of a perspective, built only from its own ready message; nothing
 * carries over. The feedback line belongs to a perspective too: a new epoch
 * replaces it with the role set now played, so no line names an object of the
 * old one. A ready re-sent in the same epoch (after a reset) keeps the line.
 */
export const storesForPerspective = (
  perspective: RealtimePerspective,
  screen: ScreenPerspective,
  /** Whether an object may be the starting selection; the first that may is selected. */
  startsSelected: (object: OperationalObject) => boolean,
): RunScopedStores => {
  const { snapshot, compiledScenario } = perspective
  const declaration = runRolesOf(compiledScenario)
  if (declaration === null) throw new Error(`A role perspective arrived for a Run whose Scenario declares no roles: ${compiledScenario.id}`)
  const played = roleSetText(declaration, perspective.roleIds)
  return {
    compiledScenario,
    objects: [...snapshot.objects],
    scenarioState: snapshot.scenario,
    clock: snapshot.clock,
    selectedControllerId: snapshot.objects.find(startsSelected)?.id ?? null,
    seenRevisions: new Map(snapshot.objects.map(object => [object.id, object.revision])),
    packDataRevisions: {},
    packPanelSelections: {},
    commandFeedback: perspective.epoch === screen.epoch
      ? screen.feedback
      : noteAction(screen.feedback, sameRoleSet(screen.roleIds, perspective.roleIds) ? `Playing ${played}` : `Switched to ${played}`),
  }
}

/**
 * The perspective a screen's Run-scoped requests belong to. A request's
 * answer is applied only while the screen still holds the role set it was
 * asked under.
 */
export const perspectiveKey = (roleIds: ReadonlyArray<string> | null): string =>
  roleIds === null ? '' : [...roleIds].sort().join(',')
