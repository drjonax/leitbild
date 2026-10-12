import { z } from 'zod'
import type { CompiledPlantGraph, CompiledProcessLink, ProcessSignalBinding, ProcessVariableValue, VariablePath } from '../graph/index.ts'
import { variablePathSchema } from '../graph/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import type { ProcessPlantIcCondition, ProcessPlantIcOperatingMode, ProcessPlantIcRule } from '../runtime/index.ts'
import { resolveProcessPlantSignalBinding } from '../signals.ts'
import { actsIn } from '../displays/actuations.ts'
import { formatQuantity } from '../displays/display-text.ts'
import { actionOf, icRuleKind } from '../displays/ic-thresholds.ts'
import { linkFlowBinding, type MimicItem } from '../displays/mimic/bindings.ts'
import type { ControlRule, OfferedControl } from './controls.ts'

// What an operation that stops, shuts, disconnects or throttles takes away,
// read from the plant graph and the Plant now (C2a, expert reviews of
// v0.5.0): the flow the item carries and where it goes, that flow's share of
// its circuit, the mode the unit is in, and the protection rules that read
// along the path and may actuate. The path is the item's own outlets (a
// bundled device's, at its port) and what feeds it: the item, the lines in
// and out, and the equipment at either end. At the ends only what the path
// carries counts: a fluid's inventory (a level, a flow) and a line's
// electrical readings. A stopped flow moves its ends' inventory first; their
// pressures, nuclear and thermal readings answer to the whole plant. Nothing
// here names a Plant, equipment or signal.

const ruleRefSchema = z.object({ ruleId: z.string().min(1), label: z.string().min(1), action: z.string().min(1) }).strict()

export const operationConsequenceSchema = z.object({
  /** The line a person reads: "stops 378 kg/s main steam SG A → Steam header (25 % of main steam flow), with the unit in power operation; may actuate …". */
  text: z.string().min(1),
  verb: z.enum(['stops', 'shuts off', 'disconnects', 'throttles']),
  /** The fluid flow it takes away, as the item's outlets carry it now; its value is null where the model does not solve that line's flow. */
  flow: z.object({
    path: variablePathSchema,
    value: z.number().finite().nullable(),
    unit: z.string().min(1),
    service: z.string().min(1),
    from: z.string().min(1),
    to: z.string().min(1),
    /** Its share of the circuit's flow: the most that merges where it goes or splits where it comes from; null without flow. */
    sharePercent: z.number().finite().nullable(),
  }).strict().optional(),
  /** The power line it takes away, and whether it is live now. */
  line: z.object({ from: z.string().min(1), to: z.string().min(1), live: z.boolean() }).strict().optional(),
  /** The operating mode the unit is in. */
  mode: z.object({ id: z.string().min(1), label: z.string().min(1) }).strict().optional(),
  /** Protection rules, armed in this mode, that read along the path and may actuate. */
  mayActuate: z.array(ruleRefSchema),
}).strict()
export type OperationConsequence = z.infer<typeof operationConsequenceSchema>
export type ConsequenceVerb = OperationConsequence['verb']

/** The path an item's flow takes, as the graph declares it. */
interface ItemPath {
  readonly carrier: 'fluid' | 'power'
  readonly service: string | null
  /** The links leaving the item (a bundled device's, at its port). */
  readonly outlets: ReadonlyArray<CompiledProcessLink>
  /** The links feeding it; none for a bundled device, whose host feeds it. */
  readonly inlets: ReadonlyArray<CompiledProcessLink>
  /** What feeds it where no inlet does: a device's host, or the item itself. */
  readonly source: number
  /** Armed protection rules reading along the path, by id. */
  readonly readers: ReadonlyArray<ProcessPlantIcRule>
}

const comparisonLeaves = (condition: ProcessPlantIcCondition): ReadonlyArray<Extract<ProcessPlantIcCondition, { type: 'comparison' }>> =>
  condition.type === 'comparison' ? [condition] : condition.type === 'not' ? comparisonLeaves(condition.condition) : condition.conditions.flatMap(comparisonLeaves)

const pathFor = (plant: CompiledProcessPlant, item: MimicItem): ItemPath | null => {
  const graph = plant.graph
  const component = graph.components[item.component]!
  const device = item.kind === 'device' ? component.semantics.embedded.find(candidate => candidate.id === item.device) : undefined
  const leaving = (graph.outgoingLinksByComponent[component.index] ?? []).map(index => graph.links[index]!)
    .filter(link => device === undefined || String(link.fromPortName) === device.port)
  const fluid = leaving.filter(link => link.kind === 'fluidFlow')
  const power = leaving.filter(link => link.kind === 'electricalPower')
  const carrier = fluid.length > 0 ? 'fluid' : power.length > 0 ? 'power' : null
  if (carrier === null) return null
  const service = carrier === 'fluid' ? fluid[0]!.service ?? null : null
  const outlets = carrier === 'fluid' ? fluid.filter(link => link.service === service) : power
  const entering = device !== undefined ? [] : (graph.incomingLinksByComponent[component.index] ?? []).map(index => graph.links[index]!)
  const inlets = carrier === 'fluid'
    ? (entering.some(link => link.kind === 'fluidFlow' && link.service === service) ? entering.filter(link => link.kind === 'fluidFlow' && link.service === service) : entering.filter(link => link.kind === 'fluidFlow'))
    : entering.filter(link => link.kind === 'electricalPower')
  const links = new Set([...outlets, ...inlets].map(link => link.index))
  const ends = new Set([...inlets.map(link => link.fromComponentIndex), ...outlets.map(link => link.toComponentIndex)])
  const carried = (binding: ProcessSignalBinding): boolean => carrier === 'power' ? binding.discipline === 'electrical'
    : binding.measurand === 'level' || binding.quantity === 'flowRate' || binding.quantity === 'flowRateDelta'
  const onPath = (path: VariablePath): boolean => {
    const binding = graph.signalBindingByPath.get(path)
    if (binding === undefined) return false
    if (binding.owner.type === 'link') return links.has(binding.owner.linkIndex)
    if (binding.owner.componentIndex === component.index) return true
    return ends.has(binding.owner.componentIndex) && carried(binding)
  }
  const readers = plant.automation.rules.filter(rule => rule.enabled && rule.ruleClass === 'protection' && icRuleKind(rule) === 'trip'
    && comparisonLeaves(rule.condition).some(leaf => onPath(resolveProcessPlantSignalBinding(graph, leaf.signal).path)))
  return { carrier, service, outlets, inlets, source: component.index, readers }
}

const pathsByPlant = new WeakMap<CompiledProcessPlant, Map<string, ItemPath | null>>()

/** pathFor, once per drawn item of a compiled Plant. */
const itemPathOf = (plant: CompiledProcessPlant, item: MimicItem): ItemPath | null => {
  const key = item.kind === 'device' ? `${item.component}.${item.device}` : String(item.component)
  const byItem = pathsByPlant.get(plant) ?? new Map<string, ItemPath | null>()
  pathsByPlant.set(plant, byItem)
  if (!byItem.has(key)) byItem.set(key, pathFor(plant, item))
  return byItem.get(key)!
}

const nameOf = (graph: CompiledPlantGraph, index: number): string => {
  const component = graph.components[index]!
  return component.metadata?.presentation?.shortLabel ?? component.label
}

/** A service id as words: "mainSteam" reads "main steam". */
const serviceWords = (service: string): string => service.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()

/** A declared label inside a sentence: "Power operation" reads "power operation", "RCS …" stays. */
const inSentence = (label: string): string => /^[A-Z][a-z]/.test(label) ? `${label.charAt(0).toLowerCase()}${label.slice(1)}` : label

/** The verb an off option of a control says, by what its aspect is and what its item carries. */
export const offVerb = (control: OfferedControl, carrier: 'fluid' | 'power'): ConsequenceVerb =>
  control.aspect === 'running' ? 'stops' : carrier === 'power' || control.aspect === 'energized' ? 'disconnects' : 'shuts off'

export interface ConsequenceContext {
  readonly read: (path: VariablePath) => ProcessVariableValue
  /** The operating mode the Plant is in now; null where it declares none that holds. */
  readonly mode: ProcessPlantIcOperatingMode | null
  /** Whether a rule stands active or sealed in now: it acts again only after a reset. */
  readonly standing: (rule: ProcessPlantIcRule) => boolean
}

/** The carrier of a drawn item's path, where it has one: what the off option's verb depends on. */
export const itemCarrier = (plant: CompiledProcessPlant, item: MimicItem): 'fluid' | 'power' | null => itemPathOf(plant, item)?.carrier ?? null

/**
 * What an operation on a drawn item takes away now, worded with `verb`; null
 * where the item carries nothing the graph declares (a heater, logic).
 * `alsoActuates` are the rules its option already names as set going
 * (ControlOption.consequences): they are listed with the path's readers.
 */
export const operationConsequence = (
  plant: CompiledProcessPlant,
  item: MimicItem,
  verb: ConsequenceVerb,
  context: ConsequenceContext,
  alsoActuates: ReadonlyArray<ControlRule> = [],
): OperationConsequence | null => {
  const path = itemPathOf(plant, item)
  if (path === null) return null
  const graph = plant.graph
  const resolutionOf = (link: CompiledProcessLink): number | null => linkFlowBinding(graph, link.index).noFlowBelow
  const flowOf = (link: CompiledProcessLink): number | null => {
    const binding = linkFlowBinding(graph, link.index)
    if (binding.fidelity === 'unverified') return null
    const value = context.read(binding.flowPath)
    if (typeof value !== 'number') throw new Error(`${binding.flowPath} reads no flow`)
    const magnitude = Math.abs(value)
    return binding.noFlowBelow !== null && magnitude < binding.noFlowBelow ? 0 : magnitude
  }
  const total = (links: ReadonlyArray<CompiledProcessLink>): number | null => {
    const flows = links.map(flowOf)
    return flows.some(flow => flow === null) ? null : flows.reduce<number>((sum, flow) => sum + flow!, 0)
  }
  // What feeds it now: the inlet carrying the most, else the first, else its host or itself.
  const feeding = path.inlets.length === 0 ? null
    : path.inlets.reduce((most, link) => (flowOf(link) ?? 0) > (flowOf(most) ?? 0) ? link : most)
  const from = feeding === null ? path.source : feeding.fromComponentIndex
  const destinations = [...new Set(path.outlets.map(link => link.toComponentIndex))]
  const fromName = nameOf(graph, from)
  const toName = destinations.map(index => nameOf(graph, index)).join(', ')
  let line: string
  const consequence: { -readonly [K in keyof OperationConsequence]?: OperationConsequence[K] } = { verb }
  if (path.carrier === 'fluid') {
    const service = path.service!
    const words = serviceWords(service)
    const value = total(path.outlets)
    const sameService = (link: CompiledProcessLink): boolean => link.kind === 'fluidFlow' && link.service === service
    const merged = total(destinations.flatMap(index => (graph.incomingLinksByComponent[index] ?? []).map(link => graph.links[link]!)).filter(sameService))
    const split = total((graph.outgoingLinksByComponent[from] ?? []).map(link => graph.links[link]!).filter(sameService))
    const circuit = Math.max(merged ?? 0, split ?? 0)
    const sharePercent = value === null || value === 0 || circuit === 0 ? null : 100 * value / circuit
    const flowPath = linkFlowBinding(graph, path.outlets[0]!.index).flowPath
    const unit = graph.signalBindingByPath.get(flowPath)!.unit
    consequence.flow = { path: flowPath, value, unit, service, from: fromName, to: toName, sharePercent }
    const share = sharePercent === null ? '' : sharePercent >= 99.5 ? ` (all ${words} flow)` : ` (${Math.round(sharePercent)} % of ${words} flow)`
    line = value === null ? `${verb} ${words} ${fromName} → ${toName}, a flow the model does not solve`
      : value === 0 ? `${verb} ${words} ${fromName} → ${toName}, carrying no flow now`
        : `${verb} ${formatQuantity(value, unit, resolutionOf(path.outlets[0]!))} ${words} ${fromName} → ${toName}${share}`
  } else {
    const live = path.outlets.some(link => {
      const energized = link.variables.find(variable => String(variable.path) === `${link.id}.energized`)
      return energized !== undefined && context.read(energized.path) === true
    })
    consequence.line = { from: fromName, to: toName, live }
    line = `${verb} ${fromName} → ${toName} (${live ? 'live' : 'dead'} now)`
  }
  if (context.mode !== null) {
    consequence.mode = { id: context.mode.id, label: context.mode.label }
    line = `${line}, with the unit in ${inSentence(context.mode.label)}`
  }
  const rules = new Map(plant.automation.rules.map(rule => [rule.id, rule]))
  const named = alsoActuates.map(reference => rules.get(reference.ruleId)!).filter(rule => rule !== undefined)
  const armed = [...new Map([...named, ...path.readers].map(rule => [rule.id, rule])).values()]
    .filter(rule => actsIn(rule, context.mode?.id ?? null) && !context.standing(rule))
  consequence.mayActuate = armed.map(rule => ({ ruleId: rule.id, label: rule.label ?? rule.id, action: actionOf(plant, rule) }))
  const text = armed.length === 0 ? line : `${line}; may actuate: ${armed.map(rule => rule.label ?? rule.id).join('; ')}`
  return operationConsequenceSchema.parse({ ...consequence, text })
}
