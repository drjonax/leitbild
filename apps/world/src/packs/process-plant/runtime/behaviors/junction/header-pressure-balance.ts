import type { CompiledComponent, CompiledProcessLink, VariablePath } from '../../../graph/index.ts'
import type { CompiledProcessPlant } from '../../../plant-compiler.ts'
import { componentVariablePath } from '../../behavior-contract.ts'
import { clamp, parameterNumber } from '../../component-helpers.ts'
import { incomingComponentLinks, outgoingComponentLinks } from '../../component-link-helpers.ts'
import { componentHasElectricalPower, type ElectricalReadContext } from '../electrical-behaviors.ts'

// A pressure-balanced header is the discharge manifold of pumps that feed
// several branches, each through a valve to a vessel at its own pressure, as
// auxiliary feedwater feeds the steam generators. Its pressure settles where
// the pumps deliver what the branches pass: each pump along its curve, from
// its rated flow and head to its shutoff head, and each branch with its
// opening, its flow coefficient (valve, flow-limiting orifice and piping
// together) and the square root of the pressure it drops to its vessel. A
// branch to a vessel at lower pressure, or one more open, takes more; the
// pumps run back along their curves when few branches are open, and deliver
// nothing against branches all shut. The pumps take suction from vented
// tanks, at atmospheric pressure.

const atmosphericPressureMPa = 0.101325

interface FeedPump {
  readonly pump: CompiledComponent
  readonly ratedFlowKgPerS: number
  readonly ratedHeadMPa: number
  readonly shutoffHeadMPa: number
}

interface Branch {
  readonly link: CompiledProcessLink
  readonly valve: CompiledComponent
  readonly coefficientKgPerSPerSqrtMPa: number
  readonly terminalPressurePath: VariablePath
}

interface BalancedHeader {
  readonly pumps: ReadonlyArray<FeedPump>
  readonly branches: ReadonlyArray<Branch>
}

export interface HeaderPressureBalance {
  readonly pressureMPa: number
  readonly pumpFlowKgPerS: ReadonlyMap<number, number>
  readonly branchFlowKgPerS: ReadonlyMap<number, number>
}

export const isPressureBalancedHeader = (component: CompiledComponent | undefined): component is CompiledComponent =>
  component?.kind === 'processHeader'
  && (component.parameters as Readonly<Record<string, unknown>>).distributionMode === 'pressureBalance'

const balancedHeaderCache = new WeakMap<CompiledProcessPlant, Map<number, BalancedHeader>>()

const fluidLinksOf = (links: ReadonlyArray<CompiledProcessLink>, service: CompiledProcessLink['service']): ReadonlyArray<CompiledProcessLink> =>
  links.filter(link => link.kind === 'fluidFlow' && link.service === service)

const feedPumpFor = (header: CompiledComponent, pump: CompiledComponent | undefined): FeedPump => {
  if (pump?.kind !== 'centrifugalPump') throw new Error(`pressure-balanced header ${header.id} must be fed by pumps only; ${pump?.id ?? 'a missing component'} is not one`)
  const parameters = pump.parameters as Readonly<Record<string, unknown>>
  if (parameters.flowDemandPath !== undefined) throw new Error(`pump ${pump.id} feeds pressure-balanced header ${header.id}, so the header, not a flow demand, sets its flow`)
  const ratedHeadMPa = parameterNumber(pump, 'nominalHeadPa') / 1_000_000
  const shutoffHeadMPa = parameterNumber(pump, 'shutoffHeadPa') / 1_000_000
  if (!(shutoffHeadMPa > ratedHeadMPa)) throw new Error(`pump ${pump.id} shutoff head must exceed its rated head`)
  return { pump, ratedFlowKgPerS: parameterNumber(pump, 'nominalFlowKgPerS'), ratedHeadMPa, shutoffHeadMPa }
}

const branchFor = (system: CompiledProcessPlant, header: CompiledComponent, link: CompiledProcessLink, knownPaths: ReadonlySet<VariablePath>): Branch => {
  const valve = system.graph.components[link.toComponentIndex]
  if (valve?.kind !== 'processValve') throw new Error(`pressure-balanced header ${header.id} branch ${link.id} must lead to a valve`)
  const onward = fluidLinksOf(outgoingComponentLinks(system, valve), link.service)
  const terminal = onward.length === 1 ? system.graph.components[onward[0]!.toComponentIndex] : undefined
  if (terminal === undefined) throw new Error(`valve ${valve.id} on pressure-balanced header ${header.id} must lead to exactly one vessel`)
  const terminalPressurePath = componentVariablePath(terminal, 'pressureMPa')
  if (!knownPaths.has(terminalPressurePath)) throw new Error(`branch ${link.id} of pressure-balanced header ${header.id} ends at ${terminal.id}, which has no pressure to feed against`)
  return { link, valve, coefficientKgPerSPerSqrtMPa: parameterNumber(valve, 'cvKgPerSPerSqrtMPa'), terminalPressurePath }
}

const balancedHeader = (system: CompiledProcessPlant, header: CompiledComponent): BalancedHeader => {
  let cached = balancedHeaderCache.get(system)
  if (cached === undefined) {
    cached = new Map()
    balancedHeaderCache.set(system, cached)
  }
  const known = cached.get(header.index)
  if (known !== undefined) return known
  const outgoing = outgoingComponentLinks(system, header, link => link.kind === 'fluidFlow')
  const service = outgoing[0]?.service
  const knownPaths = new Set(system.graph.variables.map(variable => variable.path))
  const built: BalancedHeader = {
    pumps: fluidLinksOf(incomingComponentLinks(system, header), service).map(link => feedPumpFor(header, system.graph.components[link.fromComponentIndex])),
    branches: fluidLinksOf(outgoing, service).map(link => branchFor(system, header, link, knownPaths)),
  }
  cached.set(header.index, built)
  return built
}

/** The pressure-balanced header a pump discharges into, or null for any other pump. */
export const pressureBalancedHeaderFedBy = (system: CompiledProcessPlant, pump: CompiledComponent): CompiledComponent | null => {
  const headers = outgoingComponentLinks(system, pump, link => link.kind === 'fluidFlow')
    .map(link => system.graph.components[link.toComponentIndex])
    .filter(isPressureBalancedHeader)
  if (headers.length > 1) throw new Error(`pump ${pump.id} discharges into more than one pressure-balanced header`)
  return headers[0] ?? null
}

/** A pump's flow at a discharge pressure: a parabola from its shutoff head through its rated point, scaled by speed. */
const pumpCurveFlowKgPerS = (feed: FeedPump, speed: number, dischargePressureMPa: number): number =>
  feed.ratedFlowKgPerS * Math.sqrt(Math.max(0, (feed.shutoffHeadMPa * speed * speed - (dischargePressureMPa - atmosphericPressureMPa)) / (feed.shutoffHeadMPa - feed.ratedHeadMPa)))

/** The header's pressure, and what each of its pumps delivers and each of its branches takes there. */
export const headerPressureBalance = (
  system: CompiledProcessPlant,
  header: CompiledComponent,
  context: ElectricalReadContext,
): HeaderPressureBalance => {
  const { pumps, branches } = balancedHeader(system, header)
  // A pump runs while it is commanded to and its motor has power.
  const running = pumps.flatMap(feed => context.readBoolean(componentVariablePath(feed.pump, 'running'))
    && componentHasElectricalPower(system, feed.pump, context)
    ? [{ feed, speed: clamp(context.readNumber(componentVariablePath(feed.pump, 'speedFraction')), 0, 1.2) }]
    : [])
  const open = branches.map(branch => ({
    branch,
    conductance: branch.coefficientKgPerSPerSqrtMPa * clamp(context.readNumber(componentVariablePath(branch.valve, 'effectivePositionFraction')), 0, 1),
    terminalPressure: context.readNumber(branch.terminalPressurePath),
  })).filter(branch => branch.conductance > 0)
  const pumpFlowAt = (pressure: number): number => running.reduce((total, { feed, speed }) => total + pumpCurveFlowKgPerS(feed, speed, pressure), 0)
  const branchFlowAt = (pressure: number): number => open.reduce((total, branch) => total + branch.conductance * Math.sqrt(Math.max(0, pressure - branch.terminalPressure)), 0)
  // The pumps deliver less, and the branches pass more, the higher the
  // pressure: they meet between the lowest vessel pressure and the highest
  // shutoff head.
  const shutoff = running.reduce((highest, { feed, speed }) => Math.max(highest, atmosphericPressureMPa + feed.shutoffHeadMPa * speed * speed), atmosphericPressureMPa)
  let low = Math.min(shutoff, ...open.map(branch => branch.terminalPressure))
  let high = shutoff
  for (let iteration = 0; iteration < 48 && open.length > 0; iteration += 1) {
    const middle = (low + high) / 2
    if (pumpFlowAt(middle) > branchFlowAt(middle)) low = middle
    else high = middle
  }
  const pressure = open.length === 0 ? shutoff : (low + high) / 2
  return {
    pressureMPa: pressure,
    pumpFlowKgPerS: new Map(running.map(({ feed, speed }) => [feed.pump.index, open.length === 0 ? 0 : pumpCurveFlowKgPerS(feed, speed, pressure)])),
    branchFlowKgPerS: new Map(open.map(branch => [branch.branch.link.index, branch.conductance * Math.sqrt(Math.max(0, pressure - branch.terminalPressure))])),
  }
}

/** For a valve on a pressure-balanced header's branch: the header's pressure ahead of it and its vessel's after it; null for any other valve. */
export const balancedBranchPressures = (
  system: CompiledProcessPlant,
  valve: CompiledComponent,
  context: ElectricalReadContext,
): { readonly upstreamMPa: number; readonly downstreamMPa: number } | null => {
  const header = incomingComponentLinks(system, valve, link => link.kind === 'fluidFlow')
    .map(link => system.graph.components[link.fromComponentIndex])
    .find(isPressureBalancedHeader)
  if (header === undefined) return null
  const branch = balancedHeader(system, header).branches.find(candidate => candidate.valve.index === valve.index)!
  return { upstreamMPa: headerPressureBalance(system, header, context).pressureMPa, downstreamMPa: context.readNumber(branch.terminalPressurePath) }
}
