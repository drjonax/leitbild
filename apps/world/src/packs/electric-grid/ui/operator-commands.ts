// Operator guidance for Grid commands whose rules an operator must see before sending: shed-load's
// interruptible limit and emergency flag, and the sign, limit and ramp of an HVDC set-point. The
// runtime decides; a command it rejects shows the runtime's reason.

const mw = (value: number): string => `${(Math.round(value * 10) / 10).toLocaleString('en-GB')} MW`

/** The load fields shed-load's rules read, from world.electric-grid.asset.get. */
export interface GridShedLoadContext {
  readonly label: string
  readonly priority: string
  readonly criticalMw: number
  readonly interruptibleMw: number
  readonly demandMw: number
  readonly modelledDemandMw: number
  readonly nominalDemandMw: number
}

export interface GridShedLoadPlan {
  /** Interruptible demand curtailment may still use: the Model's, less what an EV schedule below the modelled demand uses (MW). */
  readonly interruptibleMw: number
  /** The lowest limit curtailment reaches without emergency (MW). */
  readonly curtailmentFloorMw: number
  readonly disconnectMw: number
  /** Why the command would be rejected as set, with what to change; null when it may be sent. */
  readonly problem: string | null
  /** The limits, always shown beside the form. */
  readonly limits: string
  readonly confirmation: string
}

export const gridShedLoadPlan = (load: GridShedLoadContext, targetMw: number, emergency: boolean): GridShedLoadPlan => {
  const interruptibleMw = Math.max(0, load.interruptibleMw - Math.max(0, load.modelledDemandMw - load.nominalDemandMw))
  const curtailmentFloorMw = Math.max(load.criticalMw, load.demandMw - interruptibleMw)
  const disconnectMw = Math.max(0, load.demandMw - targetMw)
  const limits = interruptibleMw > 0
    ? `Interruptible ${mw(interruptibleMw)}: curtailment goes down to ${mw(curtailmentFloorMw)}; emergency shedding down to the critical ${mw(load.criticalMw)}.`
    : `Interruptible 0 MW: the Grid Model records no flexible demand for this load, so curtailment cannot reduce it. Only emergency shedding can, down to the critical ${mw(load.criticalMw)}.`
  const problem = load.priority === 'critical'
    ? `${load.label} is critical in full; manual shedding never disconnects it.`
    : !Number.isFinite(targetMw) || targetMw < 0
      ? 'Enter the demand limit in MW, 0 or more.'
      : targetMw < load.criticalMw
        ? `The limit ${mw(targetMw)} is below the critical demand ${mw(load.criticalMw)}, which is never shed.`
        : targetMw >= load.demandMw
          ? `The limit ${mw(targetMw)} sheds nothing: ${load.label} draws ${mw(load.demandMw)}.`
          : !emergency && disconnectMw > interruptibleMw + 1e-9
            ? interruptibleMw > 0
              ? `Disconnecting ${mw(disconnectMw)} exceeds the ${mw(interruptibleMw)} interruptible demand: curtailment stops at ${mw(curtailmentFloorMw)}. Tick Emergency to shed further, recorded as emergency shedding.`
              : `Curtailment would be rejected: ${load.label} has 0 MW interruptible demand. Tick Emergency to shed ${mw(disconnectMw)} as emergency shedding.`
            : null
  const confirmation = emergency
    ? `Emergency-shed ${load.label} to ${mw(targetMw)}? This disconnects ${mw(disconnectMw)} at once, ${mw(Math.max(0, disconnectMw - interruptibleMw))} beyond its ${mw(interruptibleMw)} interruptible limit, recorded as emergency shedding until Restore load.`
    : `Curtail ${load.label} to ${mw(targetMw)}? This disconnects ${mw(disconnectMw)} of its ${mw(interruptibleMw)} interruptible demand at once, until Restore load.`
  return { interruptibleMw, curtailmentFloorMw, disconnectMw, problem, limits, confirmation }
}

/** The HVDC link fields a set-point's rules read, from world.electric-grid.asset.get. */
export interface GridHvdcSetpointContext {
  readonly label: string
  readonly ratingMw: number
  readonly rampMwPerMinute: number
  readonly transferMw: number
  readonly setpointMw: number
}

const exchange = (valueMw: number): string => valueMw === 0 ? '0 MW' : `${mw(Math.abs(valueMw))} ${valueMw > 0 ? 'export' : 'import'}`

/** The sign convention, the limit and, for a requested set-point, its ramp or why it would be rejected. */
export const gridHvdcSetpointGuidance = (link: GridHvdcSetpointContext, requestedMw: number | null): { readonly convention: string; readonly outcome: string | null; readonly problem: string | null } => {
  const convention = `Positive exports from Norway over ${link.label}, negative imports into Norway; at most ±${mw(link.ratingMw)}.`
  if (requestedMw === null) return { convention, outcome: null, problem: null }
  if (!Number.isFinite(requestedMw)) return { convention, outcome: null, problem: 'Enter the set-point in MW.' }
  if (Math.abs(requestedMw) > link.ratingMw) return { convention, outcome: null, problem: `${mw(requestedMw)} is beyond the ±${mw(link.ratingMw)} rating.` }
  if (requestedMw === link.setpointMw) return { convention, outcome: null, problem: `${link.label} already has the set-point ${mw(requestedMw)}.` }
  const minutes = Math.abs(requestedMw - link.transferMw) / link.rampMwPerMinute
  return {
    convention,
    outcome: `Ramps from ${exchange(link.transferMw)} to ${exchange(requestedMw)} in ${minutes.toFixed(1)} min at ${mw(link.rampMwPerMinute)}/min.`,
    problem: null,
  }
}
