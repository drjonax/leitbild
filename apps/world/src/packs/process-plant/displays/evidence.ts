import type { ProcessSignalBinding, VariablePath } from '../graph/index.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'
import { actionEquipment, actionFlows, actionFlowsInto, actsIn, automaticActions, conditionBindings, feeds, throughputDownstream, type AutomaticAction } from './actuations.ts'
import { composedPanelPens, rankedAsRead, type CompiledComposedDisplay, type ComposedDisplayPen, type ComposedDisplayReading } from './compose.ts'
import { COMPOSED_EVIDENCE_MAX, type DisplayEvidence, type DisplayEvidenceKind } from './composition.ts'
import { isPast } from './display-text.ts'
import { icThresholdsForSignal } from './ic-thresholds.ts'
import { itemBinding, type MimicItem } from './mimic/bindings.ts'
import { itemLook, type SampleIndex } from './mimic/evaluate.ts'
import { MIMIC_REACH_LINKS } from './mimic/scope.ts'
import { overviewCandidates, overviewKeyValues, plantNowOf } from './overview-key-values.ts'
import { gateStatesOf, limitsInForce } from './trend-reading.ts'

// The evidence a composed display carries besides what the agent chose: what
// the Plant's model says bears on the question now, added by World and
// labelled as added (compose.ts withEvidence), so the answer needs no second
// turn (evaluation run 22: a
// runback display without the failed feed valve or a healthy steam generator,
// a loss-of-feed display without the auxiliary feedwater the actuation
// delivers). Every rule reads declared semantics, never names: commands and
// states the model declares, the automatic actions its I&C declares, loops,
// headers and annunciator systems.

/** A value as World reads it now, for judging whether equipment follows its command. */
export type EvidenceSample = (path: VariablePath) => { readonly value: unknown; readonly quality: string }

const shortLabel = (system: ProcessPlantRuntimeInstance, component: number): string => {
  const item = system.plant.graph.components[component]!
  return item.metadata?.presentation?.shortLabel ?? item.label
}

/**
 * The values a composed display adds to what the agent chose, each once and
 * none already shown, most telling first (PRIORITY):
 * - cause: equipment the question's values are measured on, or one line from
 *   it, whose state does not follow its command (a feed valve stuck at 35 %
 *   while demanded open), as its state and its command;
 * - wider: for a shown reading at an end of its instrument's span (a
 *   narrow-range level at 0 %), the same quantity on the instrument the
 *   equipment declares reads it over a wider span (its wide-range level);
 * - delivers and isolates: what an automatic action acting in the mode
 *   delivers or isolates (the header flow its pumps feed, or the flow it
 *   starts or shuts off into the one piece of shown equipment it feeds),
 *   where the action is active, or
 *   its limit is the one a shown value is heading for, and it judges a shown
 *   value or acts on shown equipment;
 * - reference: for a primary reading of parallel equipment that is off
 *   normal (in alarm, past a limit in force, or heading for one), shown on
 *   one loop, the same reading on the healthiest other loop (the fewest
 *   active alarms, then nearest the others' median); shown on some loops,
 *   the rest;
 * - mode: what the unit watches in this mode (what its overview leads with,
 *   and what it would lead with given room), in an annunciator system the
 *   question's primary values alarm in (the subcooling margin beside a
 *   falling pressurizer pressure after a trip): what the overview leads
 *   with, and of the rest what the display would lead with as off normal,
 *   heading for a limit or past one, most telling first;
 * - flow: along a drawn line-up, the header flow each drawn header carries
 *   and each drawn pump feeds.
 * Equipment a drawing shows says its own command and state, so it is never a
 * cause here.
 */
export const displayEvidence = (
  system: ProcessPlantRuntimeInstance,
  display: CompiledComposedDisplay,
  { now, readings }: ComposedDisplayReading,
  sample: EvidenceSample,
  recordedSeriesIds: ReadonlySet<string>,
): ReadonlyArray<DisplayEvidence> => {
  const plant = system.plant
  const graph = plant.graph
  const pens = display.panels.flatMap(composedPanelPens)
  const mimics = display.panels.flatMap(panel => panel.kind === 'mimic' ? [panel.mimic] : [])
  // What the operator reads as a value: the panels' signals and the values a drawing writes beside its items
  // (a header's flow drawn only as flowing or not is no value read).
  const shown = new Set<string>([...pens.map(pen => String(pen.path)), ...mimics.flatMap(mimic => mimic.items.flatMap(item => item.rows.flatMap(row => row.kind === 'value' ? [row.path] : [])))])
  const drawn = new Set(mimics.flatMap(mimic => mimic.items.flatMap(item => item.components.map(id => graph.componentIndexById.get(id as never)!))))
  const bindingOf = (path: VariablePath): ProcessSignalBinding => graph.signalBindingByPath.get(path)!
  // A value is measured on the component that owns it, or a line's on the equipment it flows into.
  const measuredOn = (path: VariablePath): number => {
    const owner = bindingOf(path).owner
    return owner.type === 'component' ? owner.componentIndex : graph.links[owner.linkIndex]!.toComponentIndex
  }
  const penEquipment = [...new Set(pens.map(pen => measuredOn(pen.path)))]
  const shownEquipment = new Set([...penEquipment, ...drawn])
  const readable = (path: VariablePath | undefined): path is VariablePath => {
    const binding = path === undefined ? undefined : graph.signalBindingByPath.get(path)
    return binding !== undefined && binding.published && (!binding.writable || binding.actuation === 'command')
  }
  const added = new Map<string, DisplayEvidence>()
  const add = (path: VariablePath, kind: DisplayEvidenceKind, reason: string): void => {
    if (!readable(path) || shown.has(String(path)) || added.has(String(path))) return
    added.set(String(path), { path: String(path), kind, reason })
  }

  // Cause: shown equipment and its neighbours on fluid lines, and the devices they bundle.
  const neighbours = (component: number): ReadonlyArray<number> => [
    ...(graph.incomingLinksByComponent[component] ?? []).map(index => graph.links[index]!).filter(link => link.kind === 'fluidFlow').map(link => link.fromComponentIndex),
    ...(graph.outgoingLinksByComponent[component] ?? []).map(index => graph.links[index]!).filter(link => link.kind === 'fluidFlow').map(link => link.toComponentIndex),
  ]
  const suspects = [...new Set([...penEquipment, ...penEquipment.flatMap(neighbours)])].filter(component => !drawn.has(component))
  const values = new Map<string, { readonly value: unknown; readonly quality: string }>()
  const index: SampleIndex = values
  const read = (path: VariablePath | undefined) => {
    if (path !== undefined && !values.has(String(path))) values.set(String(path), sample(path))
  }
  for (const component of suspects) {
    const semantics = graph.components[component]!.semantics
    const items: ReadonlyArray<{ readonly item: MimicItem; readonly aspects: typeof semantics.aspects }> = [
      { item: { kind: 'component', component }, aspects: semantics.aspects },
      ...semantics.embedded.map(device => ({ item: { kind: 'device' as const, component, device: device.id }, aspects: device.aspects })),
    ]
    for (const { item, aspects } of items) {
      const commanded = aspects.find(aspect => (aspect.aspect === 'position' || aspect.aspect === 'running') && aspect.state !== undefined && aspect.command !== undefined)
      if (commanded === undefined || !readable(commanded.state!.path) || !readable(commanded.command)) continue
      const binding = itemBinding(plant, item, commanded.aspect, new Map())
      read(binding.state?.state?.path)
      read(binding.state?.command)
      const look = itemLook(binding, index)
      if (look.mismatch === null) continue
      add(commanded.state!.path, 'cause', `${binding.label} does not follow its demand (${look.mismatch})`)
      add(commanded.command!, 'cause', `${binding.label} demand`)
    }
  }

  // Wider: a reading off its span says only that the quantity is there or beyond; its wider instrument says where.
  for (const entry of readings) {
    if (entry.reading.offScale === null) continue
    const binding = bindingOf(entry.pen.path)
    if (binding.owner.type !== 'component') continue
    for (const range of graph.components[binding.owner.componentIndex]!.semantics.widerRanges) {
      if (range.reading === entry.pen.path) add(range.wider, 'wider', `${entry.pen.name} reads ${entry.reading.offScale} its span: the same quantity on the instrument with the wider span`)
    }
  }

  // Delivers and isolates: automatic actions acting in the mode that bear on what is shown.
  const mode = now.mode === undefined || now.mode === null ? null : now.mode.id
  const ahead = new Set(readings.flatMap(entry => entry.reading.limit?.kind === 'margin' && !isPast(entry.reading.limit.margin) && entry.reading.limit.eta !== ''
    ? [entry.reading.limit.margin.threshold.ruleId] : []))
  const shownPaths = new Set(pens.map(pen => String(pen.path)))
  // Those that judge a shown value first, so a flow several actions send is named by the one the display is about
  // (SG B's own low-low level, not SG A's, for the auxiliary feed into SG B every start lines up).
  const judging = (action: AutomaticAction): boolean =>
    conditionBindings(plant, action.rule.condition).some(binding => shownPaths.has(String(binding.path)))
  const bearing = [...automaticActions(plant).values()].sort((left, right) => Number(judging(right)) - Number(judging(left)))
  for (const action of bearing) {
    if (!actsIn(action.rule, mode) || !(now.activeRuleIds.has(action.rule.id) || ahead.has(action.rule.id))) continue
    const flows = actionFlows(plant, action, MIMIC_REACH_LINKS)
    const commanded = actionEquipment(plant, action)
    // The equipment its flows reach: the shown equipment it feeds, within a mimic's reach of what it commands.
    const fed = [...shownEquipment].filter(component => commanded.some(source => source === component || feeds(plant, source, component, MIMIC_REACH_LINKS)))
    const judgesShown = judging(action)
    if (!judgesShown && fed.length === 0) continue
    // Named as the I&C names the action ("Safety injection on low pressurizer pressure").
    const named = action.rule.label ?? action.rule.id
    const active = now.activeRuleIds.has(action.rule.id)
    const into = fed.length === 1 ? actionFlowsInto(plant, action, fed[0]!).filter(flow => readable(flow.path)) : []
    for (const flow of into) {
      const what = flow.effect === 'starts' ? (active ? 'its flow' : 'what it would send') : (active ? 'the flow it shuts off' : 'the flow it would shut off')
      add(flow.path, flow.effect === 'starts' ? 'delivers' : 'isolates', `${named}${active ? '' : ', its limit ahead'}: ${what} into ${shortLabel(system, fed[0]!)}`)
    }
    if (into.length > 0) continue
    for (const flow of flows) {
      const effect = flow.effect === 'starts' ? (active ? 'what it delivers' : 'what it would deliver') : (active ? 'what it isolates' : 'what it would isolate')
      add(flow.path, flow.effect === 'starts' ? 'delivers' : 'isolates', `${named}${active ? '' : ', its limit ahead'}: ${effect}`)
    }
  }

  // Reference: parallel equipment by its loops, for a primary reading that is off normal: in alarm, past a limit
  // in force, or heading for one with a time to it. A normal reading needs no reference.
  const loopOf = (component: number): string | undefined => graph.components[component]!.metadata?.loopId
  const offNormal = new Set(readings.flatMap(entry => entry.reading.inAlarm !== null
    || (entry.reading.limit?.kind === 'margin' && (isPast(entry.reading.limit.margin) || entry.reading.limit.minutes !== null)) ? [String(entry.pen.path)] : []))
  const primary = pens.filter(pen => pen.role === 'primary')
  for (const measurement of [...new Set(primary.filter(pen => !pen.command && offNormal.has(String(pen.path))).map(pen => pen.measurement))]) {
    const ofMeasurement = pens.filter(pen => pen.measurement === measurement)
    const loops = new Set(ofMeasurement.flatMap(pen => loopOf(measuredOn(pen.path)) ?? []))
    if (loops.size === 0) continue
    const peers = parallelReadings(system, ofMeasurement[0]!).filter(peer => !loops.has(peer.loop))
    if (peers.length === 0) continue
    if (loops.size > 1) {
      for (const peer of peers) add(peer.path, 'reference', `the same reading on loop ${peer.loop}, which the display left out`)
      continue
    }
    const healthiest = healthiestPeer(system, peers, now.activeRuleIds, sample)
    if (healthiest !== undefined) add(healthiest.path, 'reference', `the same reading on loop ${healthiest.loop}, the healthiest other loop`)
  }

  // Mode: what the overview leads with now, in the annunciator systems the primary values alarm in. Alarms,
  // not trips: a trip annunciates on the protection that acts (a steam generator's low-low level trips the
  // reactor), an alarm on the system whose state it is.
  const systemsOf = (path: VariablePath): ReadonlyArray<string> => plant.automation.rules
    .filter(rule => rule.enabled && conditionBindings(plant, rule.condition).some(binding => binding.path === path))
    .flatMap(rule => rule.effects.flatMap(effect => effect.type === 'alarm.enter' && effect.annunciator?.system !== undefined ? [effect.annunciator.system] : []))
  const asked = new Set(primary.flatMap(pen => systemsOf(pen.path)))
  const modeLabel = now.mode === undefined || now.mode === null ? 'this mode' : now.mode.label
  const plantNow = plantNowOf(system)
  const leads = new Set(overviewKeyValues(plant, plantNow))
  const { leads: candidates, ends } = overviewCandidates(plant, plantNow)
  // Ranked as the display ranks what it leads with, so where the slots run short the most telling are kept: the
  // shortest time to a limit from the Run's history, past a trip limit, past an alarm limit, the nearest. What the
  // overview leads with is added; a value it has no room for only off normal (heading for a limit, or past one):
  // containment pressure standing at normal 7 kPa below its alarm is not, a subcooling margin falling towards its
  // alarm is. Only a value with a limit in force can be off normal, so only those and the leads are read.
  const limited = (path: VariablePath): boolean => limitsInForce(icThresholdsForSignal(plant, path).thresholds, now.mode, gateStatesOf(gate => now.read(gate as VariablePath))).length > 0
  const watched = [...candidates, ...ends].filter(path => systemsOf(path).some(name => asked.has(name)) && readable(path) && !shown.has(String(path))
    && (leads.has(path) || limited(path)))
  for (const { path, offNormal } of rankedAsRead(system, watched, now, recordedSeriesIds)) {
    if (leads.has(path)) add(path, 'mode', `what the unit leads with in ${modeLabel}`)
    else if (offNormal) add(path, 'mode', `what the unit watches in ${modeLabel}`)
  }

  // Flow: along a drawn line-up.
  for (const mimic of mimics) {
    for (const item of mimic.items) {
      const throughput = item.binding.state?.aspect === 'throughput' ? item.binding.state.state?.path : undefined
      if (throughput !== undefined) add(throughput, 'flow', `the flow ${item.binding.label} carries`)
    }
    for (const item of mimic.items) {
      if (item.binding.state?.aspect !== 'running') continue
      for (const id of item.components) {
        const component = graph.componentIndexById.get(id as never)!
        for (const path of throughputDownstream(plant, component, MIMIC_REACH_LINKS)) add(path, 'flow', `the flow ${item.binding.label} feeds`)
      }
    }
  }

  return [...added.values()].sort((left, right) => PRIORITY.indexOf(left.kind) - PRIORITY.indexOf(right.kind)).slice(0, COMPOSED_EVIDENCE_MAX)
}

/**
 * The order values are kept in where room is short: the cause first, the
 * wider instrument of a reading off its span, what the automatic actions
 * deliver, the healthy or left-out loops to compare,
 * what they isolate, what the unit leads with, the line-up's flows.
 */
const PRIORITY: ReadonlyArray<DisplayEvidenceKind> = ['cause', 'wider', 'delivers', 'reference', 'isolates', 'mode', 'flow']

/** The same reading on parallel equipment of the other loops: the same measurement, by loop, in loop order. */
const parallelReadings = (system: ProcessPlantRuntimeInstance, pen: ComposedDisplayPen): ReadonlyArray<{ readonly path: VariablePath; readonly loop: string; readonly component: number }> => {
  const graph = system.plant.graph
  const binding = graph.signalBindingByPath.get(pen.path)!
  if (binding.owner.type !== 'component') return []
  const own = graph.components[binding.owner.componentIndex]!
  const variable = String(pen.path).slice(String(pen.path).indexOf('.') + 1)
  const kind = own.metadata?.equipmentClass ?? own.kind
  return graph.components
    .filter(component => component.index !== own.index && component.metadata?.loopId !== undefined && (component.metadata?.equipmentClass ?? component.kind) === kind)
    .flatMap(component => {
      const peer = graph.signalBindingByPath.get(`${component.id}.${variable}` as VariablePath)
      return peer === undefined || peer.unit !== binding.unit || !peer.published || peer.writable ? [] : [{ path: peer.path, loop: component.metadata!.loopId!, component: component.index }]
    })
    .sort((left, right) => left.loop.localeCompare(right.loop))
}

/** The peer with the fewest active alarms and trips on its own signals, then the one nearest the peers' median. */
const healthiestPeer = <Peer extends { readonly path: VariablePath; readonly component: number }>(
  system: ProcessPlantRuntimeInstance,
  peers: ReadonlyArray<Peer>,
  activeRuleIds: ReadonlySet<string>,
  sample: EvidenceSample,
): Peer | undefined => {
  const plant = system.plant
  const alarms = (component: number): number => plant.automation.rules
    .filter(rule => activeRuleIds.has(rule.id) && conditionBindings(plant, rule.condition).some(binding => binding.owner.type === 'component' && binding.owner.componentIndex === component))
    .length
  const values = peers.map(peer => sample(peer.path).value).filter((value): value is number => typeof value === 'number').sort((left, right) => left - right)
  const median = values.length === 0 ? 0 : values[Math.floor(values.length / 2)]!
  const distance = (peer: Peer): number => {
    const value = sample(peer.path).value
    return typeof value === 'number' ? Math.abs(value - median) : Number.POSITIVE_INFINITY
  }
  return [...peers].sort((left, right) => alarms(left.component) - alarms(right.component) || distance(left) - distance(right))[0]
}
