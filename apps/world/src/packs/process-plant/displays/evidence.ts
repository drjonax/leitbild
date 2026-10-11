import { recordingSeriesIdFor } from '../../../core/model/index.ts'
import { linkCarrier, nextLinks, previousLinks, type ProcessSignalBinding, type VariablePath } from '../graph/index.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'
import { actionEquipment, actionFlows, actionFlowsInto, actionStates, actsIn, automaticActions, branchFlows, conditionBindings, feeds, throughputDownstream, type AutomaticAction } from './actuations.ts'
import { composedPanelPens, rankedAsRead, type CompiledComposedDisplay, type ComposedDisplayReading } from './compose.ts'
import { COMPOSED_EVIDENCE_MAX, COMPOSED_EVIDENCE_MAX_ROWS, type DisplayEvidence, type DisplayEvidenceKind } from './composition.ts'
import { formatQuantity, isPast, offScale, readingResolution, simulationClock } from './display-text.ts'
import { icThresholdsForSignal } from './ic-thresholds.ts'
import { itemBinding, type MimicItem } from './mimic/bindings.ts'
import { itemLook, type SampleIndex } from './mimic/evaluate.ts'
import { MIMIC_REACH_LINKS } from './mimic/scope.ts'
import { operatingPointValue } from './operating-point.ts'
import { overviewCandidates, overviewKeyValues, plantNowOf } from './overview-key-values.ts'
import { COMPARISON_HISTORY_MS, gateStatesOf, limitsInForce, TREND_HISTORY_LIMIT, type TrendPoint } from './trend-reading.ts'

// The evidence a composed display carries besides what the agent chose: what
// the Plant's model says bears on the question now, added by World and
// labelled as added (compose.ts withEvidence), so the answer needs no second
// turn (evaluation run 22: a
// runback display without the failed feed valve or a healthy steam generator,
// a loss-of-feed display without the auxiliary feedwater the actuation
// delivers). Every rule reads declared semantics, never names: commands and
// states the model declares, the automatic actions its I&C declares, loops,
// headers, programs and annunciator systems.

/** A value as World reads it now, for judging whether equipment follows its command. */
export type EvidenceSample = (path: VariablePath) => { readonly value: unknown; readonly quality: string }

const shortLabel = (system: ProcessPlantRuntimeInstance, component: number): string => {
  const item = system.plant.graph.components[component]!
  return item.metadata?.presentation?.shortLabel ?? item.label
}

/** "SG A", "SG A, SG B and SG C". */
const joined = (names: ReadonlyArray<string>): string => names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`

/**
 * The values a composed display adds to what the agent chose, each once and
 * none already shown, most telling first (PRIORITY); the values one rule adds
 * for one reason are read together in one row (compose.ts composeEvidenceRows):
 * - cause: equipment the question's values are measured on, or one line from
 *   it, whose state does not follow its command (a feed valve stuck at 35 %
 *   while demanded shut), as its state and its command, and how both stood
 *   across the onset of their disagreement over the display's window;
 * - isolation: for such equipment, or a relief device shown open, the device
 *   in series on its line that isolates it, its position and its demand (the
 *   PORV's block valve);
 * - wider: for a shown reading at an end of its instrument's span (a
 *   narrow-range level at 0 %) that no trend legend already reads on its
 *   wider instrument, or a trended one its rate carries there within the
 *   trend's horizon, or a value a chat drawing writes there, the same
 *   quantity on the instrument the equipment declares reads it over a wider
 *   span (its wide-range level);
 * - delivers and isolates: what an automatic action acting in the mode
 *   delivers or isolates (the header flow its pumps feed, or the flow it
 *   starts or shuts off into the one piece of shown equipment it feeds),
 *   where the action is active, or its limit is the one a shown value is
 *   heading for, and it judges a shown value or acts on shown equipment; and
 *   where it is active, what its header delivers to each destination (the
 *   auxiliary feed to each steam generator), as the header flow alone cannot
 *   say whether one is unfed;
 * - trip: on a trend whose window holds a reactor trip, what says the
 *   Plant's energy sources and sinks stopped: their declared shutdown readings
 *   (power range, startup rate, rod bottom) and the states of what the trips
 *   that command them move on or beside them (the turbine stop valve);
 * - program: for a shown reading the Plant's control holds to a program, the
 *   program and the reading's deviation from it (TREF beside TAVG);
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
 * - flow: along a drawn line-up, the header flow each drawn header carries,
 *   and to each destination, and each drawn pump feeds.
 * Equipment a drawing shows says its own command and state, so it is never a
 * cause or an isolation here.
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
  // What the operator reads as a value: the panels' signals and the values a drawing writes beside its items, or
  // its wider instrument's where the value stands off its span (a header's flow drawn only as flowing or not is no
  // value read).
  const shown = new Set<string>([
    ...pens.map(pen => String(pen.path)),
    ...mimics.flatMap(mimic => mimic.items.flatMap(item => item.rows.flatMap(row => row.kind === 'value' ? [row.path, ...(row.wider === undefined ? [] : [row.wider.path])] : []))),
    // A trend's legend reads a reading off its span on its wider instrument.
    ...readings.flatMap(entry => entry.legend && entry.reading.offScale !== null && entry.pen.wider !== undefined ? [String(entry.pen.wider.path)] : []),
  ])
  const drawn = new Set(mimics.flatMap(mimic => mimic.items.flatMap(item => item.components.map(id => graph.componentIndexById.get(id as never)!))))
  const drawnDevices = new Set(mimics.flatMap(mimic => mimic.items.flatMap(item => item.binding.item.kind === 'device' ? [`${item.binding.item.component}|${item.binding.item.device}`] : [])))
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
  const add = (path: VariablePath, kind: DisplayEvidenceKind, reason: string, note?: string): void => {
    if (!readable(path) || shown.has(String(path)) || added.has(String(path))) return
    added.set(String(path), { path: String(path), kind, reason, ...(note === undefined ? {} : { note }) })
  }
  // The window the display reads history over: its trend's horizon, else the ten minutes a comparison keeps.
  const trends = display.panels.flatMap(panel => panel.kind === 'trend' ? [panel] : [])
  const windowMs = Math.max(0, ...trends.map(panel => panel.horizonMs)) || COMPARISON_HISTORY_MS
  const windowStart = now.simulationMs - windowMs
  const clock = (ms: number): string => simulationClock(ms).slice(0, 8)
  // A recorded numeric signal's history over the window, ending with its value now; null where it has none.
  const history = (path: VariablePath): ReadonlyArray<TrendPoint> | null => {
    const seriesId = recordingSeriesIdFor(plant.id, path)
    const value = sample(path).value
    if (!recordedSeriesIds.has(seriesId) || typeof value !== 'number') return null
    return [...now.history(seriesId, { from: windowStart, to: now.simulationMs - 1 }, TREND_HISTORY_LIMIT), { t: now.simulationMs, v: value }]
  }
  const resolutionOf = (path: VariablePath): number | null => {
    const binding = bindingOf(path)
    return readingResolution(binding.limits, icThresholdsForSignal(plant, path).thresholds, operatingPointValue(plant, path))
  }
  const quantity = (path: VariablePath, value: number): string => formatQuantity(value, bindingOf(path).unit, resolutionOf(path))

  /**
   * How a state and its demand stood across the onset of their disagreement,
   * from the Run's recorded history over the display's window: "35.0 % since
   * 10:00:01; demand 100 % then, 0 % since 10:01:32" says a valve that stuck
   * part open while demanded open, which the present pair alone (35 % against
   * a demand of 0 %) does not. None where neither moved in the window, or
   * either is not recorded.
   */
  const onsetNote = (state: VariablePath, command: VariablePath): string | undefined => {
    const states = history(state)
    const commands = history(command)
    if (states === null || commands === null) return undefined
    const heldSince = (points: ReadonlyArray<TrendPoint>, path: VariablePath): number | null => {
      const tolerance = (resolutionOf(path) ?? 0) / 2
      const last = points.at(-1)!.v
      for (let at = points.length - 2; at >= 0; at -= 1) if (Math.abs(points[at]!.v - last) > tolerance) return points[at + 1]!.t
      return null
    }
    const valueAt = (points: ReadonlyArray<TrendPoint>, time: number): number => [...points].reverse().find(point => point.t <= time)?.v ?? points[0]!.v
    const stateSince = heldSince(states, state)
    const commandSince = heldSince(commands, command)
    if (stateSince === null && commandSince === null) return undefined
    const stateNow = quantity(state, states.at(-1)!.v)
    const commandNow = quantity(command, commands.at(-1)!.v)
    const stateText = stateSince === null ? `${stateNow} throughout the last ${Math.round(windowMs / 60_000)} min` : `${stateNow} since ${clock(stateSince)}`
    const commandText = commandSince === null ? `demand ${commandNow} throughout`
      : stateSince !== null && commandSince <= stateSince ? `demand ${commandNow} since ${clock(commandSince)}`
        : `demand ${quantity(command, valueAt(commands, stateSince ?? states[0]!.t))} ${stateSince === null ? 'at first' : 'then'}, ${commandNow} since ${clock(commandSince)}`
    return `${stateText}; ${commandText}`
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
  // The equipment on a fault path: what does not follow its demand, and what isolates its line.
  const faults: Array<{ readonly item: MimicItem; readonly label: string }> = []
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
      faults.push({ item, label: binding.label })
      // One reason for both, so the state and its demand are read together, with how they stood across the onset.
      const reason = `${binding.label} does not follow its demand (${look.mismatch})`
      const note = onsetNote(commanded.state!.path, commanded.command!)
      add(commanded.state!.path, 'cause', reason, note)
      add(commanded.command!, 'cause', reason, note)
    }
  }

  /**
   * The isolating equipment in series on an item's line: for a device a
   * component bundles, the isolating devices on the same port (a PORV's block
   * valve); for a component, the isolating components on its line up- and
   * downstream, through equipment that only passes the flow on.
   */
  const isolatorsOf = (item: MimicItem): ReadonlyArray<MimicItem> => {
    const host = graph.components[item.component]!
    if (item.kind === 'device') {
      const port = host.semantics.embedded.find(device => device.id === item.device)!.port
      return host.semantics.embedded.filter(device => device.port === port && device.id !== item.device && device.function === 'isolating')
        .map(device => ({ kind: 'device' as const, component: item.component, device: device.id }))
    }
    const found: MimicItem[] = []
    const fluid = (indexes: ReadonlyArray<number> | undefined) => (indexes ?? []).map(at => graph.links[at]!).filter(link => link.kind === 'fluidFlow')
    for (const [start, step, far] of [
      [fluid(graph.outgoingLinksByComponent[item.component]), nextLinks, 'toComponentIndex'],
      [fluid(graph.incomingLinksByComponent[item.component]), previousLinks, 'fromComponentIndex'],
    ] as const) {
      for (const first of start) {
        let link = first
        for (let steps = 0; steps < MIMIC_REACH_LINKS; steps += 1) {
          const next = graph.components[link[far]]!
          if (next.semantics.function === 'isolating') found.push({ kind: 'component', component: next.index })
          const onward = step(graph, link, new Set([linkCarrier(link)]))
          if (onward.length !== 1) break
          link = onward[0]!
        }
      }
    }
    return found
  }

  // Isolation: the device that isolates a fault or relief path, where the drawing does not show it.
  const deviceKey = (item: MimicItem): string => item.kind === 'device' ? `${item.component}|${item.device}` : `${item.component}|`
  const shownDevices = graph.components.flatMap(component => component.semantics.embedded
    .filter(device => device.function === 'relieving' && device.variables.some(variable => shown.has(String(variable))))
    .map(device => ({ item: { kind: 'device' as const, component: component.index, device: device.id }, open: device.aspects.some(aspect => aspect.aspect === 'position' && aspect.state !== undefined && Number(sample(aspect.state.path).value) > 0) })))
  const paths = [...faults, ...shownDevices.filter(device => device.open).map(device => ({ item: device.item, label: itemBinding(plant, device.item, 'position', new Map()).label }))]
  for (const { item, label } of [...new Map(paths.map(path => [deviceKey(path.item), path])).values()]) {
    for (const isolator of isolatorsOf(item).filter(candidate => !drawnDevices.has(deviceKey(candidate)) && (candidate.kind === 'device' || !drawn.has(candidate.component)))) {
      const binding = itemBinding(plant, isolator, 'position', new Map())
      // Where the display shows where it stands, its demand alone adds nothing.
      if (binding.state?.state !== undefined && shown.has(String(binding.state.state.path))) continue
      const reason = `${binding.label} isolates the ${label}'s line`
      if (binding.state?.state !== undefined) add(binding.state.state.path, 'isolation', reason)
      if (binding.state?.command !== undefined) add(binding.state.command, 'isolation', reason)
    }
  }
  // Wider: a reading off its span says only that the quantity is there or beyond; its wider instrument says where.
  // So does a trended reading its rate carries off its span within the trend's horizon (a narrow-range level
  // falling at 18 %/min a minute after a trip), and a value a drawing writes at an end of its span.
  const offSpan: Array<{ readonly path: VariablePath; readonly name: string; readonly end: 'below' | 'above'; readonly heading: boolean }> = []
  const trendHorizon = (path: VariablePath): number | null => trends.find(panel => panel.strips.some(strip => strip.pens.some(pen => pen.path === path)))?.horizonMs ?? null
  for (const entry of readings) {
    const binding = bindingOf(entry.pen.path)
    if (binding.owner.type !== 'component') continue
    const wider = graph.components[binding.owner.componentIndex]!.semantics.widerRanges.find(range => range.reading === entry.pen.path)?.wider
    if (wider === undefined) continue
    const name = entry.pen.tagId ?? entry.pen.name
    if (entry.reading.offScale !== null) {
      offSpan.push({ path: wider, name, end: entry.reading.offScale, heading: false })
      continue
    }
    const span = entry.pen.limits?.instrumentSpan
    const horizon = trendHorizon(entry.pen.path)
    const rate = entry.reading.rate
    if (span === undefined || horizon === null || rate === null || rate === 0) continue
    const minutes = rate < 0 ? (entry.value - span.min) / -rate : (span.max - entry.value) / rate
    if (minutes <= horizon / 60_000) offSpan.push({ path: wider, name, end: rate < 0 ? 'below' : 'above', heading: true })
  }
  for (const item of mimics.flatMap(mimic => mimic.items)) {
    for (const binding of item.binding.values) {
      const written = item.rows.some(row => row.kind === 'value' && row.path === binding.path && row.wider === undefined)
      const value = sample(binding.path).value
      const end = typeof value === 'number' ? offScale(value, binding.span) : null
      if (written && end !== null && binding.wider !== undefined) offSpan.push({ path: binding.wider.path, name: bindingOf(binding.path).tagId ?? `${bindingOf(binding.path).label} · ${item.binding.label}`, end, heading: false })
    }
  }
  for (const heading of [false, true]) {
    for (const end of ['below', 'above'] as const) {
      const group = offSpan.filter(entry => entry.heading === heading && entry.end === end)
      if (group.length === 0) continue
      const names = [...new Set(group.map(entry => entry.name))]
      const one = names.length === 1
      const what = heading ? `${one ? 'heads' : 'head'} for the ${end === 'below' ? 'bottom' : 'top'} of ${one ? 'its' : 'their'} span` : `${one ? 'reads' : 'read'} ${end} ${one ? 'its' : 'their'} span`
      const listed = joined(names)
      const reason = `${listed.length > 100 ? `${names.length} shown readings` : listed} ${what}: the same quantity on the instrument${one ? '' : 's'} with the wider span`
      for (const entry of group) add(entry.path, 'wider', reason)
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
  const ownerOf = (path: VariablePath): number | undefined => {
    const owner = bindingOf(path).owner
    return owner.type === 'component' ? owner.componentIndex : undefined
  }
  // What a header sends to each destination, read together.
  const toEach = (header: number | undefined): { readonly paths: ReadonlyArray<VariablePath>; readonly to: string } | null => {
    const branches = header === undefined ? [] : branchFlows(plant, header, MIMIC_REACH_LINKS)
    return branches.length === 0 ? null : { paths: branches.map(branch => branch.path), to: joined(branches.map(branch => shortLabel(system, branch.destination))) }
  }
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
      // Delivering, the header's flow alone cannot say whether a destination is unfed: its flow to each is read beside it.
      const branches = active && flow.effect === 'starts' ? toEach(ownerOf(flow.path)) : null
      for (const path of branches?.paths ?? []) add(path, 'delivers', `${named}: what it delivers to ${branches!.to}`)
    }
  }

  // Trip: on a trend whose window holds a reactor trip, what says the energy sources and sinks stopped.
  const tripGroups = new Set(plant.automation.firstOutGroups.filter(group => group.reactorTrip).map(group => group.id))
  const tripLabel = plant.automation.firstOutGroups.find(group => group.reactorTrip)?.label
  const reactorTrips = [...automaticActions(plant).values()].filter(action => now.activeRuleIds.has(action.rule.id)
    && action.rule.effects.some(effect => effect.type === 'trip.enter' && effect.annunciator?.firstOutGroup !== undefined && tripGroups.has(effect.annunciator.firstOutGroup)))
  // When the trip acted: the first time since which every numeric command it writes has read what it writes.
  const tripOnset = (() => {
    if (trends.length === 0 || reactorTrips.length === 0) return null
    const onsets = reactorTrips.flatMap(action => action.writes.flatMap(write => {
      const points = typeof write.value === 'number' ? history(write.binding.path) : null
      if (points === null) return []
      const last = [...points.keys()].reverse().find(at => points[at]!.v !== write.value)
      return last === undefined || last === points.length - 1 ? [] : [points[last + 1]!.t]
    }))
    return onsets.length === 0 ? null : Math.min(...onsets)
  })()
  if (tripOnset !== null && tripLabel !== undefined) {
    const ends = [...graph.components.filter(component => component.semantics.energy.some(role => role.role === 'source')), ...graph.components.filter(component => component.semantics.energy.some(role => role.role === 'sink'))]
    const reason = `${tripLabel} at ${clock(tripOnset)}: what says ${joined(ends.map(end => shortLabel(system, end.index)))} stopped`
    for (const end of ends) {
      for (const path of end.semantics.shutdownReadings) add(path, 'trip', reason)
      // What the trips that command it move, on it or on the lines beside it (the stop valve on the turbine's inlet).
      const beside = new Set([end.index, ...neighbours(end.index)])
      const commanding = [...automaticActions(plant).values()].filter(action => action.writes.some(write => write.component === end.index))
      for (const state of commanding.flatMap(action => actionStates(plant, action))) if (beside.has(state.component)) add(state.path, 'trip', reason)
    }
  }

  // Program: what the Plant's control holds a shown reading to, and how far it stands from it.
  const programs = graph.components.flatMap(component => component.semantics.programs)
  for (const pen of pens) {
    for (const program of programs.filter(candidate => candidate.reading === pen.path)) {
      const reason = `the program ${pen.tagId ?? pen.name} is held to, and how far it stands from it`
      add(program.program, 'program', reason)
      if (program.deviation !== undefined) add(program.deviation, 'program', reason)
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
    const peers = parallelReadings(system, ofMeasurement[0]!.path).filter(peer => !loops.has(peer.loop))
    if (peers.length === 0) continue
    if (loops.size > 1) {
      const reason = `the same reading on ${peers.length === 1 ? 'loop' : 'loops'} ${joined(peers.map(peer => peer.loop))}, which the display left out`
      for (const peer of peers) add(peer.path, 'reference', reason)
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
      if (throughput === undefined) continue
      add(throughput, 'flow', `the flow ${item.binding.label} carries`)
      const branches = toEach(ownerOf(throughput))
      for (const path of branches?.paths ?? []) add(path, 'flow', `the flow ${item.binding.label} carries to ${branches!.to}`)
    }
    for (const item of mimic.items) {
      if (item.binding.state?.aspect !== 'running') continue
      for (const id of item.components) {
        const component = graph.componentIndexById.get(id as never)!
        for (const path of throughputDownstream(plant, component, MIMIC_REACH_LINKS)) add(path, 'flow', `the flow ${item.binding.label} feeds`)
      }
    }
  }

  const ordered = [...added.values()].sort((left, right) => PRIORITY.indexOf(left.kind) - PRIORITY.indexOf(right.kind))
  return firstRows(ordered, COMPOSED_EVIDENCE_MAX_ROWS, COMPOSED_EVIDENCE_MAX)
}

/**
 * The order rows are kept in where room is short: the cause first, the
 * device that isolates the fault, the wider instrument of a reading off its
 * span, what the automatic actions deliver, whether the trip acted, the
 * program a reading is held to, the healthy or left-out loops to compare,
 * what the actions isolate, what the unit leads with, the line-up's flows.
 */
const PRIORITY: ReadonlyArray<DisplayEvidenceKind> = ['cause', 'isolation', 'wider', 'delivers', 'trip', 'program', 'reference', 'isolates', 'mode', 'flow']

/** The values of the first rows, a row being consecutive values of one kind and reason: at most `rows` rows and `values` values, each row whole. */
const firstRows = (evidence: ReadonlyArray<DisplayEvidence>, rows: number, values: number): ReadonlyArray<DisplayEvidence> => {
  let count = 0
  let end = 0
  while (end < evidence.length && count < rows) {
    const first = evidence[end]!
    let next = end + 1
    while (next < evidence.length && evidence[next]!.kind === first.kind && evidence[next]!.reason === first.reason) next += 1
    if (next > values) break
    end = next
    count += 1
  }
  return evidence.slice(0, end)
}

/** The same reading on parallel equipment of the other loops: the same measurement, by loop, in loop order. */
const parallelReadings = (system: ProcessPlantRuntimeInstance, path: VariablePath): ReadonlyArray<{ readonly path: VariablePath; readonly loop: string; readonly component: number }> => {
  const graph = system.plant.graph
  const binding = graph.signalBindingByPath.get(path)!
  if (binding.owner.type !== 'component') return []
  const own = graph.components[binding.owner.componentIndex]!
  const variable = String(path).slice(String(path).indexOf('.') + 1)
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
