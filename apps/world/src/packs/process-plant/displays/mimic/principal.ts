import type { CompiledPlantGraph } from '../../graph/index.ts'
import { linkCarrier } from '../../graph/index.ts'
import { pumpDriveSteamPorts } from '../../graph/pump-component-definitions.ts'
import { principalCircuits, type PrincipalRing } from '../../equipment/circuits.ts'
import { drawingStops, type MimicScope } from './scope.ts'

// A unit overview draws the Plant's principal circuits (equipment/circuits.ts).
// Their auxiliary links (charging, a residual-heat train) and the heat handed
// to once-through flow (a condenser's cooling water) only stub the drawing.
// Relief valves that discharge straight out of the Plant (safety and
// atmospheric relief valves venting to the atmosphere) are left to the detail
// views: shut in operation, they would only widen the overview, and their
// alarms say when they open. So are the valves that only supply a pump's
// drive turbine with steam (the turbine-driven auxiliary feedwater pump's),
// which also stand shut in operation and take the steam out of the Plant.

export type OverviewScopeResult =
  | {
    readonly ok: true
    readonly rings: ReadonlyArray<PrincipalRing>
    /** Transfers into flow that does not return: drawn as the stubs where heat leaves the overview. */
    readonly onceThrough: ReadonlyArray<{ readonly component: number; readonly circuit: string }>
    readonly scope: MimicScope
  }
  | { readonly ok: false; readonly reason: string }

/** What a unit overview draws: the principal circuits, and where the drawing stops. */
export const overviewScope = (graph: CompiledPlantGraph): OverviewScopeResult => {
  const circuits = principalCircuits(graph)
  if (!circuits.ok) return circuits
  // The drawing stops at every other fluid link of its equipment: where auxiliary and safety services join or leave it.
  const fluidCarriers = new Set(graph.links.filter(link => link.kind === 'fluidFlow').map(linkCarrier))
  // A relief valve vents out of the Plant when everything it discharges into takes the flow no further.
  const ventsOutOfPlant = (component: number): boolean => graph.components[component]!.semantics.function === 'relieving'
    && (graph.outgoingLinksByComponent[component] ?? []).every(index => (graph.outgoingLinksByComponent[graph.links[index]!.toComponentIndex] ?? []).length === 0)
  // A valve whose every outlet is a pump's drive steam inlet supplies that pump's turbine only.
  const suppliesDriveTurbine = (component: number): boolean => {
    const outlets = graph.outgoingLinksByComponent[component] ?? []
    return outlets.length > 0 && outlets.every(index => String(graph.links[index]!.toPortName) === pumpDriveSteamPorts.inlet)
  }
  const stubs = drawingStops(graph, circuits.components, new Set(circuits.links), fluidCarriers, () => false)
    .filter(stub => !stub.others.every(other => ventsOutOfPlant(other.component) || suppliesDriveTurbine(other.component)))
  return {
    ok: true,
    rings: circuits.rings,
    onceThrough: circuits.onceThrough,
    scope: { components: circuits.components, links: circuits.links, stubs, carriers: circuits.carriers, names: [] },
  }
}
