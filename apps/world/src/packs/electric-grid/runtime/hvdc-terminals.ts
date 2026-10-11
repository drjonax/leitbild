import type { CompiledGridModelIndex, GridExternalSystemDefinition } from '../grid-model.ts'
import type { GridHvdcLinkOperatingState, GridHvdcLinkState } from './instance.ts'

// HVDC terminals: the boundary buses of asynchronous external systems (DE, DK1, GB and NL in the
// Norway model). They lie outside the modelled AC network and in no Norwegian island, so they take
// no part in island accounting, energisation or alarms: the external system holds their AC voltage
// and absorbs or supplies the transfer of the links ending there. Their state is that of those links.

/** A link ending at an HVDC terminal, as the link reports it (positive exports from Norway). */
export interface GridHvdcTerminalLink {
  readonly linkId: string
  readonly state: GridHvdcLinkOperatingState
  readonly setpointMw: number
  readonly transferMw: number
}

/** An HVDC terminal of an asynchronous external system: in no island, with the state of its links. */
export interface GridHvdcTerminalState {
  readonly busId: string
  readonly externalSystemId: string
  readonly area: GridExternalSystemDefinition['area']
  /** The links ending at the terminal, in Model order. */
  readonly links: ReadonlyArray<GridHvdcTerminalLink>
  /** Net power the converters at the terminal deliver into the external system (MW): positive while Norway exports, after converter and cable losses. */
  readonly deliveredMw: number
}

/**
 * Power the receiving end of a link delivers into its to-bus (MW), wherever that bus lies: the sent
 * power less losses while the link exports from its from-bus, the drawn power (negative) while it imports.
 */
export const hvdcReceivingEndMw = (transferMw: number, lossPercent: number): number =>
  transferMw >= 0 ? Math.abs(transferMw) * (1 - lossPercent / 100) : transferMw

/** Live views of every HVDC terminal by bus id over the links' states, in Model order of the external systems. */
export const hvdcTerminalStateViews = (index: CompiledGridModelIndex, links: ReadonlyMap<string, GridHvdcLinkState>): ReadonlyMap<string, GridHvdcTerminalState> => {
  const terminals = new Map<string, GridHvdcTerminalState>()
  for (const system of index.externalSystems) {
    if (system.synchronous) continue
    for (const busId of system.boundaryBusIds) {
      const ending = index.hvdcLinks.filter(link => link.toBusId === busId).map(link => ({ definition: link, state: links.get(link.id)! }))
      const terminal = {}
      Object.defineProperties(terminal, {
        busId: { value: busId, enumerable: true },
        externalSystemId: { value: system.id, enumerable: true },
        area: { value: system.area, enumerable: true },
        links: {
          enumerable: true,
          get: (): ReadonlyArray<GridHvdcTerminalLink> => ending.map(({ definition, state }) => ({
            linkId: definition.id, state: state.state, setpointMw: state.setpointMw, transferMw: state.transferMw,
          })),
        },
        deliveredMw: {
          enumerable: true,
          get: (): number => ending.reduce((sum, { definition, state }) => sum + hvdcReceivingEndMw(state.transferMw, definition.lossPercent), 0),
        },
      })
      terminals.set(busId, terminal as GridHvdcTerminalState)
    }
  }
  return terminals
}
