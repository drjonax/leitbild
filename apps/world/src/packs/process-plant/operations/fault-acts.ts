// Which plant commands inject a fault (D-88, D13): a write to a variable the
// model marks `faultInjection` (a tube leak, a failed valve position), and an
// instructor action that writes one. World withholds such commands from the
// Run's AI agents (SimulationCapability.withheldFromAgents); other instructor
// events, a turbine trip or a loss of offsite power, the plant shows anyway.
import { processPlantActions } from '../actions.ts'
import { processPlantComponentDefinitions } from '../graph/component-registry.ts'
import { linkVariableSemanticsFor } from '../graph/link-contracts.ts'
import { createPwrReferencePlantDefinition } from '../plant-definitions.ts'
import { compileProcessPlant } from '../plant-compiler.ts'

/** A variable path's local part: what its component or line declares (`sgA.tubeLeakFraction` → `tubeLeakFraction`). */
const localPath = (path: string): string => path.slice(path.indexOf('.') + 1)

const faultVariables: ReadonlySet<string> = new Set(processPlantComponentDefinitions.flatMap(definition =>
  definition.variables.filter(variable => variable.actuation === 'faultInjection').map(variable => String(variable.path))))

/**
 * Whether a write to this variable path may inject a fault: its local part is one some component kind or line marks
 * `faultInjection`. A command names no kind, so a name one kind marks and another does not (a diesel's and the grid
 * source's `available`) is withheld either way.
 */
export const writesFault = (path: string): boolean => faultVariables.has(localPath(path)) || linkVariableSemanticsFor(localPath(path)).actuation === 'faultInjection'

let faultActions: ReadonlySet<string> | undefined
/**
 * The instructor actions that write a variable the model marks `faultInjection`, judged once, exactly, on the four-loop
 * reference Plant, which carries every piece of equipment an action names (an action writes the same variables of the
 * same kinds on any Plant).
 */
export const faultActionIds = (): ReadonlySet<string> => faultActions ??= (() => {
  const graph = compileProcessPlant(createPwrReferencePlantDefinition({ id: 'plant:fault-acts', loopCount: 4 })).graph
  const actuation = new Map(graph.signalBindings.map(binding => [String(binding.path), binding.actuation]))
  return new Set(processPlantActions.filter(action => action.commands(Object.fromEntries(action.parameters.map(parameter => [parameter.id, parameter.defaultValue])), graph)
    .some(command => actuation.get(String(command.path)) === 'faultInjection')).map(action => action.id))
})()
