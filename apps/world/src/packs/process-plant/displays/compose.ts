import { SUGGESTION_COUNT, editDistance, letters, matchedWords, normalized, words } from './name-matching.ts'
import { z } from 'zod'
import type { EmbeddedViewContent } from '@leitbild/contracts'
import { recordingSeriesIdFor } from '../../../core/model/index.ts'
import type {
  CompiledPlantGraph,
  CompiledProcessLink,
  ProcessQuantity,
  ProcessSignalBinding,
  ProcessUnit,
  ProcessVariableLimits,
  VariablePath,
} from '../graph/index.ts'
import { linkCarrier, processSignalTagIdSchema, variablePathSchema } from '../graph/index.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'
import { findProcessPlantSignalBinding } from '../signals.ts'
import {
  COMPOSED_DISPLAY_MAX_HEIGHT_PX,
  COMPOSED_MIMIC_DISPLAY_MAX_HEIGHT_PX,
  composedDisplayLayout,
  composedDisplayMaxHeight,
  composedPanelMinimumHeight,
  COMPOSED_DISPLAY_MAX_SAMPLE_PATHS,
  COMPOSED_DISPLAY_MAX_SUBJECTS,
  COMPOSED_DISPLAY_MAX_TRENDS,
  COMPOSED_TREND_MAX_SIGNALS,
  COMPOSED_TREND_MAX_STRIPS,
  COMPOSED_TREND_STRIP_MAX_PENS,
  LEAD_VALUE_SPARKLINE_MS,
  composedDisplayCompositionSchema,
  composedPanelHeight,
  fitComposedDisplay,
  composedDisplayHorizonMs,
  type ComposedDisplayComposition,
  type ComposedDisplayHorizon,
  type ComposedDisplayPanel,
  type ComposedDisplaySignal,
  type ComposedDisplaySignalRole,
  type ComposedPanelShape,
  type ComposedPanelSize,
  type DisplayEvidence,
} from './composition.ts'
import { displayValue, isPast, marginLimitName, nearestThresholdMargin, readingDecimals, readingResolution, readingText, shownReading, thresholdName, trendSpanMs, unitLabel, writtenDecimals } from './display-text.ts'
import { appendPoint, changeBesideState, COMPARISON_HISTORY_MS, gateStatesOf, limitsInForce, rateWindowMs, readingLookBackMs, readingStateText, travelText, TREND_HISTORY_LIMIT, trendReading, type PlantModeNow, type TrendPoint, type TrendReading } from './trend-reading.ts'
import { compileMimic, compileMimicScope, groupLabel, type MimicCompileResult } from './mimic/compile-mimic.ts'
import { MIMIC_MAX_WIDTH } from './mimic/mimic-model.ts'
import { chatMimicProfile, detailMimicProfile, overviewMimicProfile } from './mimic/profiles.ts'
import { principalCircuits } from './mimic/principal.ts'
import { equipmentKeyValues, leadValuesKey, overviewKeyValues, plantNowOf } from './overview-key-values.ts'
import { annunciatorSystems, displayAnnunciation, type AnnunciatorSystem, type DisplayAnnunciation } from './annunciators.ts'
import { operatingPointValue } from './operating-point.ts'
import { shorterSignalNames } from './signal-names.ts'
import { MIMIC_REACH_LINKS, componentDescription, itemServices, plantCarriers, plantLoops, portName, resolveEquipmentName, resolveMimicScope, serviceResembles, withOtherServicesStopped } from './mimic/scope.ts'
import type { CompiledMimic } from './mimic/mimic-model.ts'
import {
  icAlarmRuleIdsForEquipment,
  icThresholdsForSignal,
  type ComposedDisplayCombinedRule,
  type ComposedDisplayThreshold,
} from './ic-thresholds.ts'

export interface ComposedDisplayPen {
  readonly ref: string
  readonly role: ComposedDisplaySignalRole
  readonly path: VariablePath
  readonly tagId?: string
  readonly label: string
  /** What operators call it: the tag, or the label with its equipment ("Feedwater inflow · Steam Generator B"). */
  readonly name: string
  /** Shorter forms of a name that is not a tag, from longest to shortest, for a room too narrow for it (signal-names.ts). */
  readonly shorterNames: ReadonlyArray<string>
  /** The label with its equipment, where the label does not name it: what a state reads as ("Electrical bus energized · Safety Bus A"). */
  readonly described: string
  /** One measurement across parallel equipment ("steam-generator.levelPercent|percent"); pens sharing it share an axis. */
  readonly measurement: string
  readonly unit: ProcessUnit
  readonly quantity: ProcessQuantity
  readonly valueKind: 'number' | 'boolean'
  readonly seriesId: string
  /** Recorded by this Run's historian, so a trend has history from before the view opened. */
  readonly recorded: boolean
  /**
   * A writable operator or automation command (a demand), not a measured
   * state: a valve's commanded position can read closed while the valve is
   * stuck open. Shown as "demand" wherever it appears.
   */
  readonly command: boolean
  readonly limits?: ProcessVariableLimits
  /** The finest step its reading is shown in, in native units (readingResolution); null where the model declares nothing to derive it from. */
  readonly resolution: number | null
  readonly thresholds: ReadonlyArray<ComposedDisplayThreshold>
  readonly combinedRules: ReadonlyArray<ComposedDisplayCombinedRule>
  /** Added by World to an agent's display (evidence.ts): why, labelled on the readout. */
  readonly added?: Pick<DisplayEvidence, 'kind' | 'reason'>
}

/**
 * A threshold drawn on a panel: one per limit identity (its value, order,
 * action and modes) among the panel's signals, so parallel loops' limits
 * share one. Limits of different identity at one value (the AFW start and
 * the reactor trip at 20 %) are drawn as one line with a label for each.
 */
export interface ComposedTrendThreshold extends ComposedDisplayThreshold {
  /** Every rule merged into this line, so an active alarm on any of them marks it. */
  readonly ruleIds: ReadonlyArray<string>
  /** Tags or paths of the signals these rules act on. */
  readonly signals: ReadonlyArray<string>
}

/** One value axis of a trend: one measurement of parallel equipment, and its thresholds. */
export interface ComposedTrendStrip {
  readonly unit: ProcessUnit
  readonly pens: ReadonlyArray<ComposedDisplayPen>
  readonly thresholds: ReadonlyArray<ComposedTrendThreshold>
}

/** Strips stacked on one time axis, the strip with the primary signal on top. */
export interface ComposedTrendPanel {
  readonly kind: 'trend'
  readonly horizon: ComposedDisplayHorizon
  readonly horizonMs: number
  readonly strips: ReadonlyArray<ComposedTrendStrip>
  /** Signals this Run does not record: shown as live values beside the trend, never as empty plots. */
  readonly live: ReadonlyArray<ComposedDisplayPen>
  /** Plot height of each strip, fitted to the display. */
  readonly plot: number
}

export interface ComposedComparisonPanel {
  readonly kind: 'comparison'
  readonly unit: ProcessUnit
  readonly pens: ReadonlyArray<ComposedDisplayPen>
  readonly thresholds: ReadonlyArray<ComposedTrendThreshold>
}

export interface ComposedReadoutsPanel {
  readonly kind: 'readouts'
  readonly pens: ReadonlyArray<ComposedDisplayPen>
  /** Every value in it was added by World (evidence.ts): a line over them says so. */
  readonly added?: true
  /**
   * A generated display's lead values: the time the sparkline beside each
   * recorded one spans, in the column beside the drawing. Advice readouts
   * show current values only.
   */
  readonly sparklineMs?: number
}

export interface ComposedAlarmsPanel {
  readonly kind: 'alarms'
  readonly scope: 'related' | 'plant'
  /** I&C rules acting on the displayed signals; used when scope is related. */
  readonly ruleIds: ReadonlyArray<string>
  /** A unit overview's annunciator tiles over the list: the Plant's declared systems (annunciators.ts), labelled for the tile width. */
  readonly systems?: ReadonlyArray<AnnunciatorSystem>
  /** The tiles' least width (composedDisplayLayout.annunciatorTile.widths). */
  readonly tileWidth?: number
}

export interface ComposedMimicPanel {
  readonly kind: 'mimic'
  readonly mimic: CompiledMimic
}

export type CompiledComposedPanel = ComposedTrendPanel | ComposedComparisonPanel | ComposedReadoutsPanel | ComposedAlarmsPanel | ComposedMimicPanel

/** Every signal a compiled panel shows, in display order. */
export const composedPanelPens = (panel: CompiledComposedPanel): ReadonlyArray<ComposedDisplayPen> => {
  if (panel.kind === 'alarms' || panel.kind === 'mimic') return []
  return panel.kind === 'trend' ? [...panel.strips.flatMap(strip => strip.pens), ...panel.live] : panel.pens
}

export interface CompiledComposedDisplay {
  readonly plantId: string
  readonly title: string
  /** What an agent composed the display to answer; null for a display World generates itself (the unit overview). */
  readonly advice: { readonly question: string; readonly need: string } | null
  readonly modelDigest: string
  readonly height: number
  readonly panels: ReadonlyArray<CompiledComposedPanel>
  /** How its banner, actuation line and alarm rows name what the Plant's alarms and trips do. */
  readonly annunciation: DisplayAnnunciation
}

export interface ComposedDisplayIssue {
  readonly path: string
  readonly message: string
  readonly didYouMean?: ReadonlyArray<string>
}

export type ComposedDisplayCompileResult =
  | { readonly ok: true; readonly display: CompiledComposedDisplay }
  | { readonly ok: false; readonly issues: ReadonlyArray<ComposedDisplayIssue> }


// A signal is named by its tag, path and label, and by the equipment it is
// measured on: "reactor power" is the reactor core's power, not the power a
// reactor trip breaker passes, though both labels say power.
const suggestionsFor = (ref: string, graph: CompiledPlantGraph): ReadonlyArray<string> => {
  const guessed = words(ref)
  const target = normalized(ref)
  if (guessed.length === 0) return []
  const ownerLabels = (binding: ProcessSignalBinding): ReadonlyArray<string> => {
    if (binding.owner.type !== 'component') return []
    const component = graph.components[binding.owner.componentIndex]!
    return [component.label, component.metadata?.presentation?.shortLabel ?? '']
  }
  return graph.signalBindings
    .map(binding => {
      const keys = [binding.tagId, binding.path].filter((key): key is NonNullable<typeof key> => key !== undefined).map(String)
      // The owner adds what it is ("reactor"), not its designator, which tags and paths already carry.
      const named = [...new Set([...[...keys, binding.label].flatMap(words), ...ownerLabels(binding).flatMap(words).filter(word => word.length >= 3)])]
      const matched = matchedWords(guessed, named)
      const label = words(binding.label)
      const distance = Math.min(...keys.map(key => editDistance(normalized(key), target)))
      return {
        binding,
        // Longer guessed words carry more meaning: in RCS-TAVG, tavg outweighs rcs.
        score: letters(matched) / letters(guessed),
        // Whole words and prefixes before abbreviations: "power" is power, not the "per" of a kg/s path.
        whole: guessed.filter(guess => named.some(word => word === guess || word.startsWith(guess))).length,
        substantive: matched.some(guess => guess.length >= 2),
        // How much of what the signal is (its label) the guess names: PZR-PRESS is pressurizer pressure, not spray.
        labelCover: label.length === 0 ? 0 : matchedWords(label, guessed).length / label.length,
        distance,
      }
    })
    .filter(entry => entry.substantive && entry.score >= 0.5)
    // Operators name instruments by tag, so tagged signals lead among equal matches.
    .sort((left, right) => right.score - left.score
      || right.whole - left.whole
      || Number(left.binding.tagId === undefined) - Number(right.binding.tagId === undefined)
      || right.labelCover - left.labelCover
      || left.distance - right.distance
      || String(left.binding.path).localeCompare(String(right.binding.path)))
    .slice(0, SUGGESTION_COUNT)
    .map(({ binding }) => `${binding.tagId ?? binding.path} (${binding.label}, ${binding.unit})`)
}

/** The Plant's declared operating mode and live values now: what lead values are chosen by. */
const plantNow = plantNowOf

/**
 * What equipment opened now leads with besides itself (the Plant's mode, and
 * which readings measure nothing): a detail compiled under the same key shows
 * the same values, so a cached detail is reused only while it still holds.
 */
export const detailLeadKey = (system: ProcessPlantRuntimeInstance): string => leadValuesKey(system.plant, plantNow(system))

/**
 * What a unit overview leads with now: it follows the Plant's mode and what
 * its protection can still do, so a cached overview is reused only while
 * these hold.
 */
export const overviewLeadKey = (system: ProcessPlantRuntimeInstance): string => overviewKeyValues(system.plant, plantNow(system)).join(',')

const resolveRef = (system: ProcessPlantRuntimeInstance, ref: string): ProcessSignalBinding | undefined => {
  const tag = processSignalTagIdSchema.safeParse(ref)
  if (tag.success) {
    const binding = findProcessPlantSignalBinding(system.plant.graph, { tagId: tag.data })
    if (binding) return binding
  }
  const path = variablePathSchema.safeParse(ref)
  if (path.success) return findProcessPlantSignalBinding(system.plant.graph, { path: path.data })
  return undefined
}

const zodIssues = (error: z.ZodError): ReadonlyArray<ComposedDisplayIssue> => error.issues.map(issue => ({
  path: issue.path.map(String).join('.') || '(composition)',
  message: issue.message,
}))

// Every displayed signal's thresholds are drawn: an operator must see when any
// of them nears or crosses a limit. Parallel loops share set points, so one
// threshold per limit identity (kind, direction, value, order, action, modes)
// keeps the panel readable and names every signal it covers.
const drawnThresholds = (pens: ReadonlyArray<ComposedDisplayPen>): ReadonlyArray<ComposedTrendThreshold> => {
  const byAction = new Map<string, ComposedTrendThreshold>()
  for (const pen of pens) {
    for (const threshold of pen.thresholds) {
      const key = `${threshold.kind}|${threshold.direction}|${threshold.value}|${threshold.order}|${threshold.action}|${threshold.modeLabel ?? ''}|${(threshold.gatedBy ?? []).join(',')}`
      const signal = pen.tagId ?? String(pen.path)
      const existing = byAction.get(key)
      byAction.set(key, existing === undefined
        ? { ...threshold, ruleIds: [threshold.ruleId], signals: [signal] }
        : {
            ...existing,
            label: existing.label === threshold.label ? existing.label : `${existing.label} · ${threshold.label}`,
            ruleIds: [...existing.ruleIds, threshold.ruleId],
            signals: [...existing.signals, signal],
          })
    }
  }
  return [...byAction.values()].sort((left, right) => left.value - right.value || left.ruleId.localeCompare(right.ruleId))
}

// Parallel equipment shares an equipment class (the four steam generators);
// a pipe's measurements belong to its service (main steam).
const signalIdentity = (
  system: ProcessPlantRuntimeInstance,
  binding: ProcessSignalBinding,
): { readonly name: string; readonly described: string; readonly measurement: string } => {
  const variable = String(binding.path).slice(String(binding.path).indexOf('.') + 1)
  if (binding.owner.type === 'link') {
    const link = system.plant.graph.links[binding.owner.linkIndex]!
    return { name: binding.tagId ?? binding.label, described: binding.label, measurement: `link:${link.service ?? link.kind}.${variable}|${binding.unit}` }
  }
  const component = system.plant.graph.components[binding.owner.componentIndex]!
  const named = binding.label.toLowerCase().includes(component.label.toLowerCase()) ? binding.label : `${binding.label} · ${component.label}`
  return {
    name: binding.tagId ?? named,
    described: named,
    measurement: `${component.metadata?.equipmentClass ?? component.kind}.${variable}|${binding.unit}`,
  }
}

const resolvePens = (
  system: ProcessPlantRuntimeInstance,
  signals: ReadonlyArray<ComposedDisplaySignal>,
  panelPath: string,
  options: { readonly numericOnly: boolean; readonly panelName: string; readonly recordedSeriesIds: ReadonlySet<string> },
  issues: ComposedDisplayIssue[],
): ReadonlyArray<ComposedDisplayPen> | undefined => {
  const pens: ComposedDisplayPen[] = []
  const seen = new Set<VariablePath>()
  signals.forEach((signal, signalIndex) => {
    const path = `${panelPath}.signals.${signalIndex}.ref`
    const binding = resolveRef(system, signal.ref)
    if (!binding) {
      const didYouMean = suggestionsFor(signal.ref, system.plant.graph)
      issues.push({
        path,
        message: `unknown signal "${signal.ref}"; use an exact tagId or variable path from your evidence or world.process-plant.signals.search`,
        ...(didYouMean.length === 0 ? {} : { didYouMean }),
      })
      return
    }
    if (seen.has(binding.path)) {
      issues.push({ path, message: `"${signal.ref}" repeats a signal already in this ${options.panelName}` })
      return
    }
    seen.add(binding.path)
    const value = system.runtime.readVariableSnapshot(binding.path).value
    if (typeof value !== 'number' && (options.numericOnly || typeof value !== 'boolean')) {
      issues.push({ path, message: `"${signal.ref}" is a ${typeof value} state signal; ${options.panelName} panels show numeric signals only (use a readouts panel for states)` })
      return
    }
    const { thresholds, combinedRules } = icThresholdsForSignal(system.plant, binding.path)
    const seriesId = recordingSeriesIdFor(system.plant.id, binding.path)
    const identity = signalIdentity(system, binding)
    pens.push({
      ref: signal.ref,
      role: signal.role,
      path: binding.path,
      ...(binding.tagId === undefined ? {} : { tagId: binding.tagId }),
      label: binding.label,
      name: identity.name,
      shorterNames: shorterSignalNames(system.plant.graph, binding, identity.name),
      described: identity.described,
      measurement: identity.measurement,
      unit: binding.unit,
      quantity: binding.quantity,
      valueKind: typeof value === 'number' ? 'number' : 'boolean',
      seriesId,
      recorded: options.recordedSeriesIds.has(seriesId),
      command: binding.writable,
      ...(binding.limits === undefined ? {} : { limits: binding.limits }),
      resolution: readingResolution(binding.limits, thresholds, operatingPointValue(system.plant, binding.path)),
      thresholds,
      combinedRules,
    })
  })
  return pens.length === signals.length ? pens : undefined
}

const unitGroups = (pens: ReadonlyArray<ComposedDisplayPen>): string => [...new Set(pens.map(pen => pen.unit))]
  .map(unit => `[${unit}] ${pens.filter(pen => pen.unit === unit).map(pen => pen.ref).join(', ')}`).join('; ')

const stripGroups = (strips: ReadonlyArray<ComposedTrendStrip>): string => strips
  .map(strip => `[${strip.pens[0]!.label}, ${strip.unit}] ${strip.pens.map(pen => pen.ref).join(', ')}`).join('; ')

const sharedUnit = (
  pens: ReadonlyArray<ComposedDisplayPen>,
  panelPath: string,
  issues: ComposedDisplayIssue[],
): ProcessUnit | undefined => {
  const units = [...new Set(pens.map(pen => pen.unit))]
  if (units.length === 1) return units[0]
  issues.push({
    path: `${panelPath}.signals`,
    message: `a comparison shares one value axis, but these signals use ${units.length} units: ${unitGroups(pens)}; keep the primary signal's unit here and trend the others`,
  })
  return undefined
}

// The Pack, not the author, decides how trended signals share axes. Only the
// same measurement of parallel equipment shares one (the four SG levels);
// pressurizer and SG pressure, or core outlet temperature and subcooling
// margin, get their own strips so neither is flattened by the other's range
// and no strip shows another signal's limits. The strip holding a primary
// signal comes first, then request order.
const trendStrips = (pens: ReadonlyArray<ComposedDisplayPen>): ReadonlyArray<ComposedTrendStrip> => {
  const measurements = [...new Set(pens.map(pen => pen.measurement))]
  const hasPrimary = (measurement: string): boolean => pens.some(pen => pen.measurement === measurement && pen.role === 'primary')
  return [...measurements.filter(hasPrimary), ...measurements.filter(measurement => !hasPrimary(measurement))].map(measurement => {
    const stripPens = pens.filter(pen => pen.measurement === measurement)
    return { unit: stripPens[0]!.unit, pens: stripPens, thresholds: drawnThresholds(stripPens) }
  })
}

/** A compiled panel before the display is fitted: trends have no plot height yet. */
type UnsizedPanel = Exclude<CompiledComposedPanel, ComposedTrendPanel> | Omit<ComposedTrendPanel, 'plot'>

const compilePanel = (
  system: ProcessPlantRuntimeInstance,
  panel: ComposedDisplayPanel,
  panelIndex: number,
  recordedSeriesIds: ReadonlySet<string>,
  issues: ComposedDisplayIssue[],
): UnsizedPanel | undefined => {
  const panelPath = `panels.${panelIndex}`
  if (panel.kind === 'alarms') return { kind: 'alarms', scope: panel.scope, ruleIds: [] }
  if (panel.kind === 'mimic') throw new Error('a mimic is compiled once the other panels are known')
  if (panel.kind === 'readouts') {
    const pens = resolvePens(system, panel.signals, panelPath, { numericOnly: false, panelName: 'readouts', recordedSeriesIds }, issues)
    return pens === undefined ? undefined : { kind: 'readouts', pens }
  }
  const pens = resolvePens(system, panel.signals, panelPath, { numericOnly: true, panelName: panel.kind, recordedSeriesIds }, issues)
  if (pens === undefined) return undefined
  if (panel.kind === 'trend') {
    return {
      kind: 'trend',
      horizon: panel.horizon,
      horizonMs: composedDisplayHorizonMs[panel.horizon],
      strips: trendStrips(pens.filter(pen => pen.recorded)),
      live: pens.filter(pen => !pen.recorded),
    }
  }
  const unit = sharedUnit(pens, panelPath, issues)
  if (unit === undefined) return undefined
  return { kind: 'comparison', unit, pens, thresholds: drawnThresholds(pens) }
}

const panelShape = (panel: UnsizedPanel): ComposedPanelShape => {
  if (panel.kind === 'trend') return { kind: 'trend', strips: panel.strips.map(strip => strip.pens.length), live: panel.live.length }
  if (panel.kind === 'comparison') return { kind: 'comparison', rows: panel.pens.length }
  if (panel.kind === 'readouts') return { kind: 'readouts', values: panel.pens.length, ...(panel.added === true ? { added: true } : {}) }
  if (panel.kind === 'mimic') return { kind: 'mimic', height: panel.mimic.height }
  return { kind: 'alarms' }
}

const compositionIssues = (composition: ComposedDisplayComposition): ReadonlyArray<ComposedDisplayIssue> => {
  const issues: ComposedDisplayIssue[] = []
  const kinds = composition.panels.map(panel => panel.kind)
  if (kinds.filter(kind => kind === 'trend').length > COMPOSED_DISPLAY_MAX_TRENDS) {
    issues.push({ path: 'panels', message: 'use one trend panel and list every signal whose history matters in it; the display stacks one strip per measurement on a shared time axis' })
  }
  composition.panels.forEach((panel, index) => {
    if (panel.kind === 'trend' && panel.signals.length > COMPOSED_TREND_MAX_SIGNALS) {
      issues.push({ path: `panels.${index}.signals`, message: `a trend shows at most ${COMPOSED_TREND_MAX_SIGNALS} signals, but this one lists ${panel.signals.length}; keep the ones the question is about` })
    }
  })
  for (const kind of ['comparison', 'readouts', 'alarms', 'mimic'] as const) {
    if (kinds.filter(candidate => candidate === kind).length > 1) issues.push({ path: 'panels', message: `use at most one ${kind} panel` })
  }
  if (kinds.every(kind => kind === 'alarms')) issues.push({ path: 'panels', message: 'an alarms panel accompanies signal panels; add a trend, comparison, readouts or mimic panel' })
  if (composition.subjects === undefined) issues.push({ path: 'subjects', message: `name in subjects the 1-${COMPOSED_DISPLAY_MAX_SUBJECTS} pieces of equipment (id, tag or label) or signals (tag or path) the question is about; every one must be shown` })
  const signals = composition.panels.flatMap(panel => panel.kind === 'alarms' || panel.kind === 'mimic' ? [] : panel.signals)
  // A mimic alone answers an equipment question and names no signals.
  if (signals.length > 0 && !signals.some(signal => signal.role === 'primary')) issues.push({ path: 'panels', message: 'mark at least one signal with role "primary": the signal the operator question is about' })
  // A signal repeated in a second panel of the same kind, or as a readout of a
  // trended signal (whose legend already carries its value), adds height but
  // no evidence. A comparison (now, across loops) and a trend (history) of the
  // same signal answer different questions and may both show it.
  const redundantPair = (first: ComposedDisplayPanel['kind'], second: ComposedDisplayPanel['kind']): boolean =>
    first === second || (first === 'trend' && second === 'readouts') || (first === 'readouts' && second === 'trend')
  const shownIn = new Map<string, Array<{ readonly index: number; readonly kind: ComposedDisplayPanel['kind'] }>>()
  composition.panels.forEach((panel, panelIndex) => {
    if (panel.kind === 'alarms' || panel.kind === 'mimic') return
    for (const signal of panel.signals) {
      const earlier = shownIn.get(signal.ref) ?? []
      const clash = earlier.find(entry => entry.index !== panelIndex && redundantPair(entry.kind, panel.kind))
      if (clash !== undefined) {
        issues.push({ path: `panels.${panelIndex}.signals`, message: `"${signal.ref}" is already shown in panels.${clash.index} (${clash.kind}); a ${panel.kind} adds nothing for it, so remove it here` })
      }
      shownIn.set(signal.ref, [...earlier, { index: panelIndex, kind: panel.kind }])
    }
  })
  return issues
}

/**
 * The flows the model declares through the ports at a link's ends: what a
 * component's kind names as the whole flow through a port (a steam
 * generator's feedwater inflow through its feedwater inlet), and the
 * throughput of a device it bundles there (the PORV on the pressurizer's
 * relief outlet). Each says what it is the flow through, and the other links
 * on that port: none where the link carries the same flow, else the links
 * whose flow it shares. Only declared flows count, never names.
 */
export const declaredPortFlows = (graph: CompiledPlantGraph, linkIndex: number): ReadonlyArray<{
  readonly path: VariablePath
  readonly through: string
  /** The component whose port it is. */
  readonly component: number
  readonly others: ReadonlyArray<CompiledProcessLink>
}> => {
  const link = graph.links[linkIndex]!
  const ends = [{ index: link.fromComponentIndex, port: String(link.fromPortName) }, { index: link.toComponentIndex, port: String(link.toPortName) }]
  return ends.flatMap(end => {
    const component = graph.components[end.index]!
    const others = graph.links.filter(other => other.index !== link.index
      && ((other.fromComponentIndex === end.index && String(other.fromPortName) === end.port) || (other.toComponentIndex === end.index && String(other.toPortName) === end.port)))
    return [
      ...component.semantics.portFlows.filter(flow => String(flow.port) === end.port).map(flow => ({ path: flow.path, through: `${component.label}'s ${portName(end.port)}`, component: end.index, others })),
      ...component.semantics.embedded.filter(device => String(device.port) === end.port).flatMap(device => device.aspects
        .flatMap(aspect => aspect.aspect === 'throughput' && aspect.state !== undefined ? [{ path: aspect.state.path, through: `${component.label}'s ${device.label}`, component: end.index, others }] : [])),
    ]
  })
}

/**
 * A link's flow the I&C judges no rule on, where the model declares a flow
 * through the port at one of its ends that the I&C does judge. A link alone
 * on the port carries that same flow: shown as it is, the display would read
 * "no I&C limit" beside an alarm on it, so the judged signal is shown instead
 * and the refusal names it with its limits. A link that shares the port
 * carries only part of the judged flow (auxiliary feed beside main feed into
 * a steam generator), a reading of its own that no limit applies to, and is
 * never refused (evaluation run 22: "is AFW reaching every SG?" was refused
 * its very evidence).
 */
const judgedElsewhereIssues = (system: ProcessPlantRuntimeInstance, composition: ComposedDisplayComposition): ReadonlyArray<ComposedDisplayIssue> => {
  const graph = system.plant.graph
  const acting = (path: VariablePath) => icThresholdsForSignal(system.plant, path).thresholds.filter(threshold => threshold.kind !== 'control')
  return composition.panels.flatMap((panel, panelIndex) => !('signals' in panel) ? [] : panel.signals.flatMap((signal, signalIndex): ComposedDisplayIssue[] => {
    const binding = resolveRef(system, signal.ref)
    if (binding?.owner.type !== 'link' || acting(binding.path).length > 0) return []
    const link = graph.links[binding.owner.linkIndex]!
    for (const flow of declaredPortFlows(graph, link.index)) {
      const judged = graph.signalBindingByPath.get(flow.path)
      if (judged === undefined || judged.unit !== binding.unit || judged.quantity !== binding.quantity) continue
      const limits = acting(judged.path)
      if (limits.length === 0 || flow.others.length > 0) continue
      const ref = judged.tagId ?? String(judged.path)
      const named = `${ref} (${judged.label}, ${limits.map(limit => thresholdName(limit, judged.unit)).join(', ')})`
      return [{
        path: `panels.${panelIndex}.signals.${signalIndex}.ref`,
        message: `"${signal.ref}" is judged by no I&C rule, but the same flow through ${flow.through} is: show ${named} instead, so the display carries the limits its alarms act on`,
        didYouMean: [ref],
      }]
    }
    return []
  }))
}

/**
 * Each subject the display must show: a signal some panel shows (a trend,
 * comparison or readout pen, or a value or state a mimic draws); a service a
 * mimic draws or a flow of which a panel shows; a loop whose equipment is
 * drawn or one of whose signals is shown; or equipment a mimic draws or one
 * of whose signals a panel shows. A subject shown nowhere is refused with
 * what of it could be shown.
 */
const subjectIssues = (
  system: ProcessPlantRuntimeInstance,
  subjects: ReadonlyArray<string>,
  panels: ReadonlyArray<CompiledComposedPanel>,
): ReadonlyArray<ComposedDisplayIssue> => {
  const graph = system.plant.graph
  const mimics = panels.flatMap(panel => panel.kind === 'mimic' ? [panel.mimic] : [])
  const pens = panels.flatMap(composedPanelPens)
  const shownPaths = new Set([...pens.map(pen => String(pen.path)), ...mimics.flatMap(mimic => mimic.paths.map(String))])
  const ownerOf = (path: string): number | undefined => {
    const owner = graph.signalBindingByPath.get(path as VariablePath)?.owner
    return owner?.type === 'component' ? owner.componentIndex : undefined
  }
  const shownComponents = new Set([
    ...mimics.flatMap(mimic => mimic.items.flatMap(item => item.components.map(id => graph.componentIndexById.get(id as never)!))),
    ...pens.flatMap(pen => ownerOf(String(pen.path)) ?? []),
  ])
  const linkOf = (path: string) => {
    const owner = graph.signalBindingByPath.get(path as VariablePath)?.owner
    return owner?.type === 'link' ? graph.links[owner.linkIndex] : undefined
  }
  const shownServices = new Set([
    ...mimics.flatMap(mimic => mimic.summary.carriers),
    ...pens.flatMap(pen => { const link = linkOf(String(pen.path)); return link === undefined ? [] : [linkCarrier(link)] }),
  ])
  // A pipe drawn into a loop (safety injection to cold leg C) shows that loop as its equipment does.
  const drawnLinks = new Set(mimics.flatMap(mimic => mimic.pipes.map(pipe => pipe.linkId)))
  const shownLoops = new Set([
    ...[...shownComponents].flatMap(component => graph.components[component]!.metadata?.loopId ?? []),
    ...graph.links.filter(link => drawnLinks.has(String(link.id))).flatMap(link => link.metadata?.loopId ?? []),
    ...pens.flatMap(pen => linkOf(String(pen.path))?.metadata?.loopId ?? []),
  ])
  const shownNames = (): string => [...new Set(pens.map(pen => pen.name))].slice(0, SUGGESTION_COUNT).join(', ') || 'no signals'
  return subjects.flatMap((subject, index): ComposedDisplayIssue[] => {
    const path = `subjects.${index}`
    const signal = resolveRef(system, subject)
    if (signal !== undefined) {
      return shownPaths.has(String(signal.path)) ? [] : [{ path, message: `${subject} is what the question is about but no panel shows it; this display shows ${shownNames()}` }]
    }
    // A service or loop as plants.list names them, ignoring case, spaces and hyphens ("aux feedwater", "loop C").
    const wanted = normalized(subject)
    const service = plantCarriers(graph).find(candidate => normalized(candidate) === wanted)
    if (service !== undefined) {
      return shownServices.has(service) ? [] : [{ path, message: `the ${service} service is what the question is about but no panel shows it: draw it in a mimic or show a flow of it` }]
    }
    // plants.list names loops by their ids ("C"); "loop C" names the same loop.
    const loop = plantLoops(graph).find(candidate => normalized(candidate) === wanted || normalized(`loop ${candidate}`) === wanted)
    if (loop !== undefined) {
      return shownLoops.has(loop) ? [] : [{ path, message: `loop ${loop} is what the question is about but no panel shows it: draw its equipment or show one of its signals` }]
    }
    const equipment = resolveEquipmentName(graph, subject)
    if ('error' in equipment) {
      const didYouMean = [...plantCarriers(graph).filter(candidate => serviceResembles(subject, candidate)), ...suggestionsFor(subject, graph), ...equipment.didYouMean].slice(0, SUGGESTION_COUNT)
      return [{ path, message: `"${subject}" names no signal, equipment, service or loop of this Plant: give a tag or path, equipment by id, tag or label, or a service or loop as plants.list names them; the Plant itself is not a subject (${equipment.error})`, ...(didYouMean.length === 0 ? {} : { didYouMean }) }]
    }
    if (equipment.components.some(component => shownComponents.has(component))) return []
    const named = equipment.components.map(component => componentDescription(graph, component)).join(', ')
    // Equipment the model connects to nothing has no place in any drawing, and its signals describe nothing it does.
    const linked = (component: number) => (graph.incomingLinksByComponent[component] ?? []).length + (graph.outgoingLinksByComponent[component] ?? []).length > 0
    if (!equipment.components.some(linked)) {
      return [{ path, message: `${named} is connected to no other equipment in the Plant model, so no display can show it; name the equipment it is part of or acts on instead` }]
    }
    // Its lead values as a detail of it shows them: what its I&C judges, its key values and instruments.
    const leads = equipmentKeyValues(system.plant, equipment.components, plantNow(system)).map(value => graph.signalBindingByPath.get(value)?.tagId ?? String(value)).slice(0, SUGGESTION_COUNT)
    return [{ path, message: `${named} is what the question is about but no panel shows it: draw it in a mimic or show one of its signals${leads.length === 0 ? '' : ` (such as ${leads.join(', ')})`}` }]
  })
}

// Strip and size limits need resolved units, so they are checked after compiling.
const layoutIssues = (
  panels: ReadonlyArray<CompiledComposedPanel>,
  fit: { readonly height: number; readonly panels: ReadonlyArray<ComposedPanelSize> },
): ReadonlyArray<ComposedDisplayIssue> => {
  const issues: ComposedDisplayIssue[] = []
  panels.forEach((panel, index) => {
    if (panel.kind !== 'trend') return
    const pens = composedPanelPens(panel)
    if (panel.strips.length === 0) {
      issues.push({ path: `panels.${index}.signals`, message: `none of ${pens.map(pen => pen.ref).join(', ')} is recorded by this Run's historian, so the trend would have no history; show them in a readouts panel, or trend tagged instruments` })
    }
    if (panel.strips.length > COMPOSED_TREND_MAX_STRIPS) {
      issues.push({ path: `panels.${index}.signals`, message: `a trend stacks at most ${COMPOSED_TREND_MAX_STRIPS} strips, one per measurement (parallel equipment shares one), but these signals are ${panel.strips.length} measurements: ${stripGroups(panel.strips)}; drop the measurement that answers least of the question` })
    }
    for (const strip of panel.strips.filter(candidate => candidate.pens.length > COMPOSED_TREND_STRIP_MAX_PENS)) {
      issues.push({ path: `panels.${index}.signals`, message: `a trend strip shows at most ${COMPOSED_TREND_STRIP_MAX_PENS} parallel signals, but [${strip.pens[0]!.label}, ${strip.unit}] has ${strip.pens.length}: ${strip.pens.map(pen => pen.ref).join(', ')}; keep the most telling ones, or compare the loops in a comparison panel` })
    }
  })
  const sampled = new Set(panels.flatMap(panel => panel.kind === 'mimic' ? panel.mimic.paths : composedPanelPens(panel).map(pen => pen.path)))
  if (sampled.size > COMPOSED_DISPLAY_MAX_SAMPLE_PATHS) {
    issues.push({ path: 'panels', message: `the display would read ${sampled.size} live values, more than the ${COMPOSED_DISPLAY_MAX_SAMPLE_PATHS} a chat view samples; draw fewer loops in the mimic or show fewer signals` })
  }
  const maxHeight = composedDisplayMaxHeight(panels)
  if (fit.height > maxHeight) {
    const parts = fit.panels.map((size, index) => `panels.${index} ${size.kind}${size.kind === 'trend' && size.strips.length > 1 ? ` (${size.strips.length} strips)` : ''} ${composedPanelHeight(size)} px`).join(', ')
    const shrunk = fit.panels.some(size => size.kind === 'trend') ? ' even with its trend at the smallest height' : ''
    const fixes = sizeFixes(panels)
    issues.push({
      path: 'panels',
      message: `the display needs ${fit.height} px${shrunk}, but chat views allow ${maxHeight} (${parts}); ${fixes.length === 0 ? 'drop the panel or trend measurement that answers least of the question' : `it fits ${fixes.join(', or ')}`}`,
    })
  }
  return issues
}

const fits = (panels: ReadonlyArray<UnsizedPanel>): boolean =>
  panels.length > 0 && fitComposedDisplay(panels.map(panelShape)).height <= composedDisplayMaxHeight(panels)

// Concrete ways to fit, so the next compose succeeds: dropping one supporting
// panel, keeping fewer readouts, or trending fewer measurements.
const sizeFixes = (panels: ReadonlyArray<CompiledComposedPanel>): ReadonlyArray<string> => {
  const fixes: string[] = []
  panels.forEach((panel, index) => {
    if (panel.kind === 'readouts') {
      const kept = [6, 5, 4, 3, 2, 1].filter(count => count < panel.pens.length)
        .find(count => fits(panels.map((candidate, at) => at === index ? { ...panel, pens: panel.pens.slice(0, count) } : candidate)))
      if (kept !== undefined) fixes.push(`with at most ${kept} readouts in panels.${index}`)
    }
    if (panel.kind === 'trend' && panel.strips.length > 1) {
      const kept = [3, 2, 1].filter(count => count < panel.strips.length)
        .find(count => fits(panels.map((candidate, at) => at === index ? { ...panel, strips: panel.strips.slice(0, count) } : candidate)))
      if (kept !== undefined) fixes.push(`with at most ${kept} trend measurements (strips)`)
    }
    if (panel.kind !== 'trend' && fits(panels.filter((_, at) => at !== index))) fixes.push(`without panels.${index} (${panel.kind})`)
  })
  return fixes
}

// Alarms "related" to a display are those whose rules act on its signals or
// on other signals of the same equipment.
const relatedRuleIds = (system: ProcessPlantRuntimeInstance, panels: ReadonlyArray<CompiledComposedPanel>): ReadonlyArray<string> => {
  const pens = panels.flatMap(composedPanelPens)
  return [...new Set([
    ...pens.flatMap(pen => [
      ...pen.thresholds.filter(threshold => threshold.kind !== 'control').map(threshold => threshold.ruleId),
      ...pen.combinedRules.filter(rule => rule.kind !== 'control').map(rule => rule.ruleId),
    ]),
    ...icAlarmRuleIdsForEquipment(system.plant, pens.map(pen => pen.path)),
    ...panels.flatMap(panel => panel.kind === 'mimic' ? panel.mimic.items.flatMap(item => item.binding.frames.map(frame => frame.ruleId)) : []),
  ])].sort()
}

// The panels whose removal lets a drawing fit as asked: each one alone, or else all of them.
const fewerPanels = (besides: ReadonlyArray<number>, fits: (kept: ReadonlyArray<number>) => boolean): ReadonlyArray<ReadonlyArray<number>> => {
  if (besides.length === 0) return []
  const singles = besides.filter(removed => fits(besides.filter(other => other !== removed))).map(removed => [removed])
  if (singles.length > 0) return singles
  return besides.length > 1 && fits([]) ? [besides] : []
}

/**
 * `compose` applies the authoring rules (panel counts, strips, size budget,
 * one panel per signal, a primary signal) that keep new displays lean. `view` re-opens a
 * display already shown in a conversation: it checks only what rendering
 * needs, so a later authoring rule never breaks earlier advice.
 */
export const compileComposedDisplay = (
  system: ProcessPlantRuntimeInstance,
  input: unknown,
  purpose: 'compose' | 'view',
  /** Series this Run's historian records; trends of other signals start when the view opens. */
  recordedSeriesIds: ReadonlySet<string>,
): ComposedDisplayCompileResult => {
  const parsed = composedDisplayCompositionSchema.safeParse(input)
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) }
  const composition = parsed.data
  // Authoring issues are reported with the resolution and layout issues, so a
  // single rejection lists every fix; layout needs resolved signals, so it is
  // checked only once every reference resolves.
  const authoring = purpose === 'compose' ? compositionIssues(composition) : []
  const issues: ComposedDisplayIssue[] = []
  if (composition.plantId !== system.plant.id) {
    issues.push({ path: 'plantId', message: `composition targets ${composition.plantId}, not ${system.plant.id}` })
  }
  const others = composition.panels.map((panel, index) => panel.kind === 'mimic' ? undefined : compilePanel(system, panel, index, recordedSeriesIds, issues))
  // The mimic draws in the room the other panels leave at their smallest.
  const heights = others.map(panel => panel === undefined ? 0 : composedPanelMinimumHeight(panelShape(panel)) + composedDisplayLayout.panelGap)
  const mimicBudget = (left: ReadonlyArray<number>) => ({
    profile: chatMimicProfile,
    maxWidth: MIMIC_MAX_WIDTH,
    maxHeight: COMPOSED_MIMIC_DISPLAY_MAX_HEIGHT_PX - composedDisplayLayout.frame - composedDisplayLayout.mimicLegend - left.reduce((sum, index) => sum + heights[index]!, 0),
  })
  const besides = others.flatMap((panel, index) => panel === undefined ? [] : [index])
  const panels = composition.panels.map((panel, index): UnsizedPanel | undefined => {
    if (panel.kind !== 'mimic') return others[index]
    const { kind: _kind, ...intent } = panel
    const compiled = compileMimic(system.plant, intent, mimicBudget(besides))
    if (!compiled.ok) {
      // A drawing refused for its size may fit as asked beside fewer panels.
      const roomier = compiled.issues.some(issue => issue.field === '(mimic)') ? fewerPanels(besides, kept => compileMimic(system.plant, intent, mimicBudget(kept)).ok) : []
      const without = roomier.map(removed => removed.map(other => `panels.${other} (${composition.panels[other]!.kind})`).join(' and '))
      for (const issue of compiled.issues) {
        const message = issue.field === '(mimic)' && without.length > 0 ? `${issue.message}; or it fits as asked without ${without.join(', or without ')}` : issue.message
        issues.push({ path: `panels.${index}${issue.field === '(mimic)' ? '' : `.${issue.field}`}`, message, ...(issue.didYouMean === undefined ? {} : { didYouMean: issue.didYouMean }) })
      }
      return undefined
    }
    return { kind: 'mimic', mimic: compiled.mimic }
  })
  if (issues.length > 0) return { ok: false, issues: [...authoring, ...issues] }
  const unsized = panels.filter((panel): panel is UnsizedPanel => panel !== undefined)
  const fit = fitComposedDisplay(unsized.map(panelShape))
  const compiled = unsized.map((panel, index): CompiledComposedPanel => {
    if (panel.kind !== 'trend') return panel
    const size = fit.panels[index]
    if (size?.kind !== 'trend') throw new Error('fitted panels follow the compiled panels')
    return { ...panel, plot: size.plot }
  })
  const layout = purpose === 'compose' ? layoutIssues(compiled, fit) : []
  const uncovered = purpose === 'compose' && composition.subjects !== undefined ? subjectIssues(system, composition.subjects, compiled) : []
  const elsewhere = purpose === 'compose' ? judgedElsewhereIssues(system, composition) : []
  if (authoring.length > 0 || layout.length > 0 || uncovered.length > 0 || elsewhere.length > 0) return { ok: false, issues: [...authoring, ...layout, ...uncovered, ...elsewhere] }
  const ruleIds = relatedRuleIds(system, compiled)
  return {
    ok: true,
    display: {
      plantId: system.plant.id,
      title: composition.title,
      advice: { question: composition.question, need: composition.need },
      modelDigest: system.plant.modelDigest,
      height: fit.height,
      panels: compiled.map(panel => panel.kind === 'alarms' ? { ...panel, ruleIds } : panel),
      annunciation: displayAnnunciation(system.plant),
    },
  }
}

/**
 * An agent's display with what World adds to it (evidence.ts), each value
 * labelled as added: first in the free places of the last row of the agent's
 * readouts, then in one panel of its own over the alarms, under a line that
 * says so, or where that line does not fit, in further rows of the agent's
 * readouts. It never makes a display taller than a chat view allows: trends
 * shrink first, then the least telling values are left out. A value that no
 * longer resolves (a display re-opened on a changed model) is refused as any
 * other signal is.
 */
export const withEvidence = (
  system: ProcessPlantRuntimeInstance,
  display: CompiledComposedDisplay,
  evidence: ReadonlyArray<DisplayEvidence>,
  recordedSeriesIds: ReadonlySet<string>,
): { readonly ok: true; readonly display: CompiledComposedDisplay; readonly evidence: ReadonlyArray<DisplayEvidence> } | { readonly ok: false; readonly issues: ReadonlyArray<ComposedDisplayIssue> } => {
  if (evidence.length === 0) return { ok: true, display, evidence }
  const issues: ComposedDisplayIssue[] = []
  const resolved = resolvePens(system, evidence.map(entry => ({ ref: entry.path, role: 'context' as const })), 'evidence', { numericOnly: false, panelName: 'evidence', recordedSeriesIds }, issues)
  if (resolved === undefined) return { ok: false, issues }
  const pens = resolved.map((pen, index): ComposedDisplayPen => ({ ...pen, added: { kind: evidence[index]!.kind, reason: evidence[index]!.reason } }))
  const perRow = composedDisplayLayout.readoutsPerRow
  const readouts = display.panels.findIndex(panel => panel.kind === 'readouts')
  const free = readouts === -1 ? 0 : (perRow - (composedPanelPens(display.panels[readouts]!).length % perRow)) % perRow
  const joined = pens.slice(0, free)
  const own = display.panels.map((panel, index) => index === readouts && panel.kind === 'readouts' && joined.length > 0 ? { ...panel, pens: [...panel.pens, ...joined] } : panel)
  const alarms = own.findIndex(panel => panel.kind === 'alarms')
  const at = alarms === -1 ? own.length : alarms
  const kept = (panels: ReadonlyArray<CompiledComposedPanel>, count: number) => {
    const fit = fitComposedDisplay(panels.map(panelShape))
    if (fit.height > composedDisplayMaxHeight(panels)) return null
    const sized = panels.map((panel, index): CompiledComposedPanel => {
      if (panel.kind !== 'trend') return panel
      const size = fit.panels[index]
      if (size?.kind !== 'trend') throw new Error('fitted panels follow the compiled panels')
      return { ...panel, plot: size.plot }
    })
    return { ok: true as const, display: { ...display, height: fit.height, panels: sized }, evidence: evidence.slice(0, count) }
  }
  for (let count = pens.length; count > joined.length; count -= 1) {
    const added: ComposedReadoutsPanel = { kind: 'readouts', pens: pens.slice(joined.length, count), added: true }
    const fitted = kept([...own.slice(0, at), added, ...own.slice(at)], count)
    if (fitted !== null) return fitted
    // Where a panel of its own, with its line and gap, does not fit, the values join the agent's readouts in
    // rows of their own, each still labelled as added (evaluation run 22: a pressurizer depressurization 2 px
    // too tall to carry the subcooling margin).
    if (readouts === -1) continue
    const extended = kept(own.map((panel, index) => index === readouts && panel.kind === 'readouts' ? { ...panel, pens: [...panel.pens, ...pens.slice(joined.length, count)] } : panel), count)
    if (extended !== null) return extended
  }
  return kept(own, joined.length) ?? { ok: true, display, evidence: [] }
}

/** The view a unit overview is shown in: its window's inner size in CSS px. */
export interface OverviewView {
  readonly width: number
  readonly height: number
}

/** Room no drawing reaches: leaves the layout unconstrained along that axis. */
const UNCONSTRAINED = 1_000_000

/** How much more height a drawing that scrolls is offered at a time: two rows of its grid. */
const SCROLL_STEP = 2 * overviewMimicProfile.layout.grid

/**
 * How an overview's panels share its window: the drawing beside a column of
 * lead values over the alarms, or lead values, drawing and alarms stacked.
 * The view takes the column wherever the drawing leaves room for it.
 */
export type OverviewArrangement = 'column' | 'stacked'

/**
 * What a generated display shows besides its drawing: how many lead values,
 * and how many annunciator tiles over its alarms at what least width.
 */
export interface GeneratedPanels {
  readonly readouts: number
  readonly annunciators: number
  readonly tileWidth: number
}

/** Annunciator tiles across a width: as many to a row as fit at their least width (the view's grid does the same). */
export const annunciatorHeight = (count: number, tileWidth: number, width: number): number => {
  if (count === 0) return 0
  const { annunciatorTile: tile, annunciatorGap: gap, panelGap } = composedDisplayLayout
  const perRow = Math.max(1, Math.floor((width + gap) / (tileWidth + gap)))
  const rows = Math.ceil(count / perRow)
  return rows * tile.height + (rows - 1) * gap + panelGap
}

/**
 * The room a window leaves an overview's drawing in an arrangement, from the
 * declared panel sizes (composition.ts); null when the column does not fit
 * its height.
 */
export const overviewDrawingRoom = (
  view: OverviewView,
  arrangement: OverviewArrangement,
  panels: GeneratedPanels,
): { readonly maxWidth: number; readonly maxHeight: number } | null => {
  const layout = composedDisplayLayout
  const width = view.width - 2 * layout.overviewPadding
  const height = view.height - layout.overviewFrame
  if (arrangement === 'column') {
    const column = overviewColumnHeight(panels)
    if (column > height) return null
    return { maxWidth: width - layout.overviewColumnGap - layout.overviewColumn, maxHeight: height - layout.mimicLegend }
  }
  return { maxWidth: width, maxHeight: height - layout.overviewFooter - stackedPanelsHeight(panels, width) - layout.mimicLegend }
}

/** The column's least height: its lead values under their title, the annunciator tiles, the alarms and the footer. */
const overviewColumnHeight = (panels: GeneratedPanels): number => {
  const layout = composedDisplayLayout
  return (panels.readouts === 0 ? 0 : layout.overviewReadoutsTitle + panels.readouts * layout.overviewReadoutRow + layout.panelGap)
    + annunciatorHeight(panels.annunciators, panels.tileWidth, layout.overviewColumn) + layout.alarms + layout.overviewFooter
}

/** Stacked with the drawing across a width: the lead values above it, the annunciator tiles and the alarms below. */
const stackedPanelsHeight = (panels: GeneratedPanels, width: number): number => {
  const layout = composedDisplayLayout
  return (panels.readouts === 0 ? 0 : composedPanelHeight({ kind: 'readouts', values: panels.readouts }) + layout.panelGap)
    + layout.panelGap + annunciatorHeight(panels.annunciators, panels.tileWidth, width) + layout.alarms
}

/** A generated display's whole height in an arrangement across a width: what a window shows without scrolling. */
const overviewHeight = (arrangement: OverviewArrangement, panels: GeneratedPanels, mimic: CompiledMimic, width: number): number => {
  const layout = composedDisplayLayout
  const drawing = mimic.height + layout.mimicLegend
  if (arrangement === 'column') return layout.overviewFrame + Math.max(drawing, overviewColumnHeight(panels))
  return layout.overviewFrame + drawing + stackedPanelsHeight(panels, width) + layout.overviewFooter
}

/** A generated display's drawing for the room a view leaves it. */
type GeneratedDrawing = (room: { readonly maxWidth: number; readonly maxHeight: number }) => MimicCompileResult

/**
 * Fits a generated display to its view at 1:1, taking the first that fits:
 * each drawing in turn (the most it can show first), beside the column of
 * lead values and alarms (the drawing has the view's height), with the
 * panels' widest tiles first, then stacked with them (the view's width);
 * then, the drawings in the same order, at the least height that draws
 * beside the column, then as wide as the view, scrolling down, then at any
 * width; then at their own size, scrolling both ways. Without a view (a
 * listing of what it draws) the first drawing that draws at all is drawn at
 * its own size. `panels` lists the same panels at each tile width, widest
 * first.
 */
const fitGenerated = (
  view: OverviewView | null,
  panels: ReadonlyArray<GeneratedPanels>,
  drawings: ReadonlyArray<GeneratedDrawing>,
): { readonly ok: true; readonly arrangement: OverviewArrangement; readonly panels: GeneratedPanels; readonly mimic: CompiledMimic } | { readonly ok: false; readonly issues: ReadonlyArray<string> } => {
  const widest = panels[0]!
  const whole = view === null ? [] : [
    ...panels.map(option => ({ arrangement: 'column' as const, panels: option })),
    { arrangement: 'stacked' as const, panels: widest },
  ].flatMap(layout => {
    const room = overviewDrawingRoom(view, layout.arrangement, layout.panels)
    // A window too small for an arrangement leaves it no room at all; it is skipped, never asked to draw.
    return room === null || room.maxWidth <= 0 || room.maxHeight <= 0 ? [] : [{ ...layout, room }]
  })
  // A window too small scrolls by as little as the drawing needs: the least
  // height that draws, in steps of two grid rows up to twice the window,
  // beside the column while the window is wide enough for it, else stacked,
  // else at any width; a drawing that fits no such height is drawn at its
  // own size.
  // A window shorter than its frame still scrolls from the least room a drawing can have.
  const shortest = view === null ? 0 : Math.max(SCROLL_STEP, view.height - composedDisplayLayout.overviewFrame - composedDisplayLayout.mimicLegend)
  const heights = Array.from({ length: Math.floor(shortest / SCROLL_STEP) }, (_, step) => shortest + (step + 1) * SCROLL_STEP)
  const scrolling = (view === null ? [] : [
    { arrangement: 'column' as const, maxWidth: overviewDrawingRoom({ width: view.width, height: UNCONSTRAINED }, 'column', widest)!.maxWidth },
    { arrangement: 'stacked' as const, maxWidth: view.width - 2 * composedDisplayLayout.overviewPadding },
  ]).filter(rung => rung.maxWidth > 0)
  // Taller room never stops a drawing that fits in less, so the least height is found by halving.
  const leastHeight = (draw: GeneratedDrawing, maxWidth: number): MimicCompileResult => {
    let best = draw({ maxWidth, maxHeight: heights.at(-1) ?? shortest })
    if (!best.ok) return best
    let [low, high] = [0, heights.length - 1]
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      const drawn = draw({ maxWidth, maxHeight: heights[middle]! })
      if (drawn.ok) { best = drawn; high = middle } else low = middle + 1
    }
    return best
  }
  // Unconstrained room draws whatever can be drawn verified, so the last refusal says why nothing can.
  let refusal: ReadonlyArray<string> = []
  const attempts = [
    ...drawings.flatMap(draw => whole.map(layout => ({ arrangement: layout.arrangement, panels: layout.panels, draw: () => draw(layout.room) }))),
    ...scrolling.flatMap(rung => drawings.map(draw => ({ arrangement: rung.arrangement, panels: widest, draw: () => leastHeight(draw, rung.maxWidth) }))),
    ...(view === null ? [] : drawings.map(draw => ({ arrangement: 'stacked' as const, panels: widest, draw: () => leastHeight(draw, UNCONSTRAINED) }))),
    ...drawings.map(draw => ({ arrangement: 'stacked' as const, panels: widest, draw: () => draw({ maxWidth: UNCONSTRAINED, maxHeight: UNCONSTRAINED }) })),
  ]
  for (const { arrangement, panels: shown, draw } of attempts) {
    const drawn = draw()
    if (drawn.ok) return { ok: true, arrangement, panels: shown, mimic: drawn.mimic }
    refusal = drawn.issues.map(issue => issue.message)
  }
  return { ok: false, issues: refusal }
}

/** A display World generates: lead values, a drawing and alarms, sized for its arrangement. */
const generatedDisplay = (
  system: ProcessPlantRuntimeInstance,
  title: string,
  readouts: ComposedReadoutsPanel | undefined,
  view: OverviewView | null,
  fitted: { readonly arrangement: OverviewArrangement; readonly panels: GeneratedPanels; readonly mimic: CompiledMimic },
  alarms: (panels: ReadonlyArray<CompiledComposedPanel>) => ComposedAlarmsPanel,
): CompiledComposedDisplay => {
  // Nothing generated is a trend, so every panel has its natural height.
  const shown: ReadonlyArray<CompiledComposedPanel> = [...(readouts === undefined ? [] : [readouts]), { kind: 'mimic', mimic: fitted.mimic }]
  const width = view === null ? fitted.mimic.width : view.width - 2 * composedDisplayLayout.overviewPadding
  return {
    plantId: system.plant.id,
    title,
    advice: null,
    modelDigest: system.plant.modelDigest,
    height: overviewHeight(fitted.arrangement, fitted.panels, fitted.mimic, width),
    panels: [...shown, alarms(shown)],
    annunciation: displayAnnunciation(system.plant),
  }
}

/** A generated display's lead values, each recorded one with a sparkline of its history. */
const leadValues = (
  system: ProcessPlantRuntimeInstance,
  paths: ReadonlyArray<VariablePath>,
  recordedSeriesIds: ReadonlySet<string>,
  issues: ComposedDisplayIssue[],
): ComposedReadoutsPanel | undefined => {
  if (paths.length === 0) return undefined
  const panel = compilePanel(system, { kind: 'readouts', signals: paths.map(path => ({ ref: path, role: 'primary' as const })) }, 0, recordedSeriesIds, issues)
  return panel?.kind === 'readouts' ? { ...panel, sparklineMs: LEAD_VALUE_SPARKLINE_MS } : undefined
}

/**
 * The unit overview World generates for a Plant: its lead values for the
 * mode it is in (protection, delivery and energy, overview-key-values.ts),
 * its principal circuits drawn by the
 * overview profile (principal.ts), and the whole Plant's active alarms. Every
 * part comes from the model; nothing names equipment. It is drawn for the
 * view it is shown in (fitGenerated).
 */
export const compileOverviewDisplay = (system: ProcessPlantRuntimeInstance, recordedSeriesIds: ReadonlySet<string>, view: OverviewView | null): ComposedDisplayCompileResult => {
  const issues: ComposedDisplayIssue[] = []
  const readouts = leadValues(system, overviewKeyValues(system.plant, plantNow(system)), recordedSeriesIds, issues)
  const circuits = principalCircuits(system.plant.graph)
  if (!circuits.ok) return { ok: false, issues: [{ path: 'overview', message: circuits.reason }] }
  if (issues.length > 0) return { ok: false, issues }
  // The tiles at each width their names fit, widest first; the widest must fit, so a narrower one only ever saves height.
  const [widest, ...narrower] = composedDisplayLayout.annunciatorTile.widths
  const regular = annunciatorSystems(system.plant, widest)
  if (!regular.ok) return { ok: false, issues: regular.issues.map(message => ({ path: 'overview', message })) }
  const tiles = [{ width: widest, systems: regular.systems }, ...narrower.flatMap(width => {
    const fitted = annunciatorSystems(system.plant, width)
    return fitted.ok ? [{ width, systems: fitted.systems }] : []
  })]
  const values = readouts?.pens.length ?? 0
  const fitted = fitGenerated(view, tiles.map(option => ({ readouts: values, annunciators: option.systems.length, tileWidth: option.width })), [room => compileMimicScope(system.plant, circuits.scope, { profile: overviewMimicProfile, ...room })])
  if (!fitted.ok) return { ok: false, issues: fitted.issues.map(message => ({ path: 'overview', message })) }
  const systems = tiles.find(option => option.width === fitted.panels.tileWidth)!.systems
  return { ok: true, display: generatedDisplay(system, 'Unit overview', readouts, view, fitted, () => ({ kind: 'alarms', scope: 'plant', ruleIds: [], systems, tileWidth: fitted.panels.tileWidth })) }
}

/**
 * Equipment opened from a generated display: what feeds it and where its
 * outflow goes (narrowed to its loop when all of it belongs to one), drawn by
 * the detail profile as far as the view allows, from the reach a mimic
 * follows down to the next link;
 * its lead values (equipmentKeyValues); and the alarms related to what is
 * drawn. Where the drawing stops, its stubs say what lies beyond.
 * The lead values are chosen for the Plant's operating mode when the detail
 * is opened (what rules acting in that mode judge first, readings that
 * measure nothing then last); they stay as chosen while the detail is open,
 * and opening it again in another mode chooses again (detailLeadKey).
 */
export const compileDetailDisplay = (
  system: ProcessPlantRuntimeInstance,
  recordedSeriesIds: ReadonlySet<string>,
  componentIds: ReadonlyArray<string>,
  view: OverviewView | null,
): ComposedDisplayCompileResult => {
  const graph = system.plant.graph
  const unknown = componentIds.filter(id => graph.componentIndexById.get(id as never) === undefined)
  if (unknown.length > 0) return { ok: false, issues: [{ path: 'detail', message: `${system.plant.id} has no ${unknown.length === 1 ? 'component' : 'components'} ${unknown.join(', ')}` }] }
  const components = componentIds.map(id => graph.componentIndexById.get(id as never)!)
  const issues: ComposedDisplayIssue[] = []
  const readouts = leadValues(system, equipmentKeyValues(system.plant, components, plantNow(system)), recordedSeriesIds, issues)
  if (issues.length > 0) return { ok: false, issues }
  const loops = [...new Set(components.map(index => graph.components[index]!.metadata?.loopId))]
  const narrowed = loops.every((loop): loop is string => loop !== undefined) ? { loops } : {}
  const reaches = Array.from({ length: MIMIC_REACH_LINKS }, (_, step) => MIMIC_REACH_LINKS - step)
  const panels = [{ readouts: readouts?.pens.length ?? 0, annunciators: 0, tileWidth: composedDisplayLayout.annunciatorTile.widths[0] }]
  const whole = reaches.map(reach => resolveMimicScope(graph, { around: componentIds, ...narrowed, reach }))
  const unresolved = whole.find(scope => !scope.ok)
  if (unresolved !== undefined && !unresolved.ok) return { ok: false, issues: unresolved.issues.map(issue => ({ path: 'detail', message: issue.message })) }
  // Where every service at once does not draw legibly, one at a time, the
  // equipment's own first; its other services stop at it.
  const services = itemServices(graph, components)
  const oneService = services.length < 2 ? [] : services.flatMap(service => reaches.flatMap(reach => {
    const scope = resolveMimicScope(graph, { around: componentIds, ...narrowed, services: [service], reach })
    return scope.ok ? [withOtherServicesStopped(graph, scope.scope, components, services)] : []
  }))
  const scopes = [...whole.flatMap(scope => scope.ok ? [scope.scope] : []), ...oneService]
  const fitted = fitGenerated(view, panels, scopes.map(scope => (room: Parameters<GeneratedDrawing>[0]) => compileMimicScope(system.plant, scope, { profile: detailMimicProfile, ...room })))
  if (!fitted.ok) return { ok: false, issues: [{ path: 'detail', message: `nothing around it can be drawn legibly; ${fitted.issues.join('; ')}` }] }
  const title = groupLabel(components.map(index => graph.components[index]!.label))
  return { ok: true, display: generatedDisplay(system, title, readouts, view, fitted, shown => ({ kind: 'alarms', scope: 'related', ruleIds: relatedRuleIds(system, shown) })) }
}

const operatorText = { '<': 'below', '<=': 'at or below', '>': 'above', '>=': 'at or above' } as const
const signalName = (pen: ComposedDisplayPen): string => `${pen.name} (${pen.tagId === undefined ? `${pen.path}, ` : `${pen.label}, `}${pen.unit}, ${pen.role}${pen.command ? ', a command (demand), shown as demand' : ''})`

// Lines are named as the display labels them ("LO-LO 20 % · RX TRIP"), so
// an answer can refer to them by the same name; an actuation is named by what
// it actuates, never as a trip unless it trips the reactor.
const thresholdText = (threshold: ComposedTrendThreshold, unit: ProcessUnit): string =>
  `${threshold.kind === 'control' ? `I&C control set point marked on the axis: ${threshold.label}` : `"${thresholdName(threshold, unit)}" ${threshold.kind === 'alarm' ? 'alarm' : 'automatic action'} line: ${threshold.label}`}, acts ${operatorText[threshold.operator]} ${threshold.value} ${unit} for ${threshold.signals.join(', ')}${threshold.modeNames === undefined ? '' : ` (only in ${threshold.modeNames}: ${threshold.modeLabel}; drawn faint in other modes, even with the value past it)`}${threshold.gatedBy === undefined ? '' : ` (only while ${threshold.gatedBy.join(' and ')})`}`

/** How each requested reference resolved, so the agent learns exact tags, paths and units. */
export const composedDisplaySignals = (display: CompiledComposedDisplay): ReadonlyArray<{
  readonly ref: string
  readonly tagId?: string
  readonly path: string
  readonly label: string
  readonly name: string
  readonly unit: string
}> => display.panels.flatMap(panel => composedPanelPens(panel).map(pen => ({
  ref: pen.ref,
  ...(pen.tagId === undefined ? {} : { tagId: pen.tagId }),
  path: String(pen.path),
  label: pen.label,
  name: pen.name,
  unit: pen.unit,
})))

const mimicShows = (mimic: CompiledMimic): ReadonlyArray<string> => [
  `Live equipment mimic generated from the Plant model (${mimic.summary.carriers.join(', ')}): ${mimic.summary.equipment.map(item => `${item.label} (${item.id})`).join(', ')}. Pumps are drawn running or stopped from their actual speed and say RUN or STOP, valves from their actual position, levels as vessel fills; pipes show flow, no flow (hollow) or unknown (dashed), with a direction arrow only where the model computes the direction; a command that disagrees with the equipment is stated as "CMD …" and the equipment is outlined as abnormal (not an alarm), so the cause of an upset stands out; equipment with an active alarm or actuation acting in the current mode is framed with its most severe limit, named as its signal's chip names it ("P LO-LO · SI")`,
  ...(mimic.summary.stops.length === 0 ? [] : [`The drawing stops at: ${mimic.summary.stops.join('; ')}`]),
]

// A sparkline has no value axis: it shows which way a value went and how fast, never a value to quote.
const sparklinesShow = (pens: ReadonlyArray<ComposedDisplayPen>, sparklineMs: number): string => {
  const unrecorded = pens.filter(pen => pen.valueKind === 'number' && !pen.recorded)
  return `Where the lead values stand beside the drawing, each recorded one has a sparkline of its last ${sparklineMs / 60_000} min, for direction and rate only (no value scale)${unrecorded.length === 0 ? '' : `; not recorded by this Run, so without one: ${unrecorded.map(pen => pen.name).join(', ')}`}`
}

const minutes = (ms: number): string => `${Number((ms / 60_000).toFixed(1))} min`

// Axis width follows elapsed Run age, rounded up with a one-minute minimum.
// It is presentation geometry, not the retained recording's coverage: a new
// or sparsely recorded Run can have far fewer samples than this axis spans.
const trendSpanText = (panel: ComposedTrendPanel, historyMs: number): string => {
  const shown = trendSpanMs(panel.horizonMs, historyMs)
  return shown === panel.horizonMs ? `a ${panel.horizon} time axis` : `a ${minutes(shown)} time axis (widens to ${panel.horizon} as the Run continues)`
}

/** Plain statements of what the view shows, so the agent's text need not repeat it. */
export const composedDisplayShows = (display: CompiledComposedDisplay, historyMs: number): ReadonlyArray<string> => display.panels.flatMap(panel => {
  if (panel.kind === 'trend') {
    const strips = panel.strips.length === 1 ? '' : ` in ${panel.strips.length} stacked strips (one per measurement)`
    return [
      ...(panel.strips.length === 0 ? [] : [`Live trend with ${trendSpanText(panel, historyMs)}${strips}; recorded samples may cover less: ${panel.strips.flatMap(strip => strip.pens).map(signalName).join('; ')}`]),
      ...(panel.live.length === 0 ? [] : [`Current values only, not recorded by this Run (no history to describe): ${panel.live.map(signalName).join('; ')}`]),
      ...panel.strips.flatMap(strip => strip.thresholds.map(threshold => thresholdText(threshold, strip.unit))),
    ]
  }
  if (panel.kind === 'comparison') return [`Live side-by-side comparison with the median: ${panel.pens.map(signalName).join('; ')}`, ...panel.thresholds.map(threshold => thresholdText(threshold, panel.unit))]
  if (panel.kind === 'readouts') {
    const chosen = panel.pens.filter(pen => pen.added === undefined)
    const added = panel.pens.flatMap(pen => pen.added === undefined ? [] : [`${signalName(pen)}, ${pen.added.kind}: ${pen.added.reason}`])
    return [
      ...(chosen.length === 0 ? [] : [`Live readouts with margin to the nearest I&C alarm or trip threshold: ${chosen.map(signalName).join('; ')}`]),
      ...(added.length === 0 ? [] : [`World added these readouts, each labelled as added, for what the Plant model says bears on the question now; cite them as shown: ${added.join('; ')}`]),
      ...(panel.sparklineMs === undefined ? [] : [sparklinesShow(panel.pens, panel.sparklineMs)]),
    ]
  }
  if (panel.kind === 'mimic') return mimicShows(panel.mimic)
  return [panel.scope === 'related' ? `Active alarms and trips of the ${panel.ruleIds.length} I&C rules acting on the displayed signals and their equipment` : 'All active alarms and trips of the Plant']
})

/**
 * What a composed display reads as it opens: each value now, the Plant's
 * mode and active rules (which limits act), and the recorded history of a
 * signal it draws over time. The history is the Run's: the newest samples of
 * a series between two Run times, up to a limit, oldest first.
 */
export interface ComposedDisplayNow {
  readonly read: (path: VariablePath) => unknown
  /** The Run time the display opens at, in epoch milliseconds. */
  readonly simulationMs: number
  readonly mode: PlantModeNow
  readonly activeRuleIds: ReadonlySet<string>
  readonly history: (seriesId: string, window: { readonly from: number; readonly to: number }, limit: number) => ReadonlyArray<TrendPoint>
}

/** Each signal the view shows once, in display order. */
const shownPens = (display: CompiledComposedDisplay): ReadonlyArray<ComposedDisplayPen> =>
  [...new Map(display.panels.flatMap(composedPanelPens).map(pen => [pen.path, pen])).values()]

/**
 * Where the display states a signal's limit and rate: a trend strip's legend
 * (rate over the trend's horizon, the limit ahead in words); a legend row of
 * a trended signal the Run does not record (no rate, the nearest limit in
 * words); a comparison row (rate over ten minutes, limits drawn as lines); or
 * a readout (the nearest limit's margin). A legend takes precedence where a
 * signal is in more than one panel.
 */
type PenView =
  | { readonly kind: 'legend'; readonly horizonMs: number }
  | { readonly kind: 'live' }
  | { readonly kind: 'comparison'; readonly horizonMs: number }
  | { readonly kind: 'readout' }

const penView = (display: CompiledComposedDisplay, pen: ComposedDisplayPen): PenView => {
  const trends = display.panels.filter((panel): panel is ComposedTrendPanel => panel.kind === 'trend')
  const legend = trends.find(panel => panel.strips.some(strip => strip.pens.some(candidate => candidate.path === pen.path)))
  if (legend !== undefined) return { kind: 'legend', horizonMs: legend.horizonMs }
  if (trends.some(panel => panel.live.some(candidate => candidate.path === pen.path))) return { kind: 'live' }
  const compared = display.panels.some(panel => panel.kind === 'comparison' && panel.pens.some(candidate => candidate.path === pen.path))
  return compared ? { kind: 'comparison', horizonMs: COMPARISON_HISTORY_MS } : { kind: 'readout' }
}

interface PenReading {
  readonly pen: ComposedDisplayPen
  readonly value: number
  readonly reading: TrendReading
  /** Whether a trend legend words its limit, so the limit it names is the one ahead. */
  readonly legend: boolean
  readonly text: string
  /** Its order in what the display leads with; null where it names no limit. */
  readonly rank: ReadingRank | null
}

/**
 * Where a reading stands in what a display leads with: order 0, heading for a
 * limit (by minutes to it); 1, past a trip limit; 2, past an alarm limit; 3,
 * nearest (by its margin relative to the limit).
 */
export interface ReadingRank {
  readonly order: 0 | 1 | 2 | 3
  readonly by: number
}

/**
 * The recorded history a reading over the window needs, as the display's
 * whole window would give it: the samples within its look-back and the
 * newest one before them (readingLookBackMs). Two small reads, however long
 * the trend's horizon and the Run.
 */
const historyForReading = (now: ComposedDisplayNow, seriesId: string, windowStart: number, windowMs: number): ReadonlyArray<TrendPoint> => {
  const recentFrom = Math.max(windowStart, now.simulationMs - readingLookBackMs(windowMs))
  const recent = now.history(seriesId, { from: recentFrom, to: now.simulationMs }, TREND_HISTORY_LIMIT)
  return recentFrom <= windowStart ? recent : [...now.history(seriesId, { from: windowStart, to: recentFrom - 1 }, 1), ...recent]
}

/**
 * Each shown value read as the display reads it on opening: its recorded
 * history up to now and the value now, through the legend's own functions
 * (trend-reading.ts), worded as its panel words it. Recorded history is read
 * only for signals drawn over time, and only what their reading needs.
 */
const penReadings = (display: CompiledComposedDisplay, now: ComposedDisplayNow): ReadonlyArray<PenReading> =>
  shownPens(display).flatMap(pen => penReading(pen, penView(display, pen), now))

/** One value read as a panel of the given view reads it on opening; none where it is not a number or says nothing. */
const penReading = (pen: ComposedDisplayPen, view: PenView, now: ComposedDisplayNow): ReadonlyArray<PenReading> => {
  const read = now.read(pen.path)
  if (typeof read !== 'number') return []
  // As the view shows it: below its resolution a reading is 0, and so is every point its rate is read from.
  const value = shownReading(read, pen.resolution)
  const overTime = view.kind === 'legend' || view.kind === 'comparison' ? view : null
  const windowStart = overTime === null ? now.simulationMs : now.simulationMs - overTime.horizonMs
  const windowMs = rateWindowMs(overTime?.horizonMs ?? COMPARISON_HISTORY_MS)
  const history = overTime === null || !pen.recorded ? [] : historyForReading(now, pen.seriesId, windowStart, windowMs)
  const reading = trendReading({
    value,
    points: overTime === null ? null : appendPoint(history.map(point => ({ t: point.t, v: shownReading(point.v, pen.resolution) })), { t: now.simulationMs, v: value }, windowStart),
    windowMs,
    unit: pen.unit,
    thresholds: pen.thresholds,
    mode: now.mode,
    gates: gateStatesOf(path => now.read(path as VariablePath)),
    activeRuleIds: now.activeRuleIds,
    resolution: pen.resolution,
    ...(pen.limits?.instrumentSpan === undefined ? {} : { span: pen.limits.instrumentSpan }),
  })
  // A legend words every state of its limits; a readout and a comparison show only a margin to one, or the one it is past, in words or as lines.
  const worded = view.kind === 'legend' || view.kind === 'live' || reading.limit?.kind === 'margin' || reading.limit?.kind === 'past'
  const state = readingStateText({ offScale: reading.offScale, limit: worded ? reading.limit : null }, pen.unit, pen.resolution)
  // A change the limit state already gives as its reason for no time ("· reversing") is not said twice.
  const travel = travelText(reading.rate, value, pen.unit, worded ? changeBesideState(reading) : reading.change, pen.resolution, overTime === null ? undefined : windowMs)
  if (state === '' && travel === '') return []
  // The alarm chip beside the value names the active limit, where the words do not say it is past one.
  const saysPast = worded && reading.limit?.kind === 'past'
  const chip = reading.inAlarm === null || saysPast ? '' : `in ${thresholdName(reading.inAlarm, pen.unit)}`
  return [{
    pen,
    value,
    reading,
    legend: view.kind === 'legend',
    text: [`${pen.name}: ${readingText(value, pen.unit, pen.resolution, pen.limits?.instrumentSpan)}`, travel, chip, state].filter(part => part !== '').join(', '),
    rank: penRank(value, reading, limitsInForce(pen.thresholds, now.mode, gateStatesOf(path => now.read(path as VariablePath)))),
  }]
}

/**
 * Values a display does not show, in the order it would lead with them were
 * they compared over time beside its own (penRank): the shortest time to a
 * limit from the Run's history first, then past a trip limit, past an alarm
 * limit, and the nearest; those naming no limit keep their order after them.
 * Each says whether it is off normal as its reading words it: past a limit,
 * or heading for one, with a time to it or approaching without one.
 */
export const rankedAsRead = (
  system: ProcessPlantRuntimeInstance,
  paths: ReadonlyArray<VariablePath>,
  now: ComposedDisplayNow,
  recordedSeriesIds: ReadonlySet<string>,
): ReadonlyArray<{ readonly path: VariablePath; readonly rank: ReadingRank | null; readonly offNormal: boolean }> => {
  const issues: ComposedDisplayIssue[] = []
  const pens = resolvePens(system, paths.map(path => ({ ref: path, role: 'context' as const })), 'ranked', { numericOnly: false, panelName: 'ranked', recordedSeriesIds }, issues) ?? []
  const read = new Map(pens.flatMap(pen => penReading(pen, { kind: 'comparison', horizonMs: COMPARISON_HISTORY_MS }, now).map(entry => [entry.pen.path, entry] as const)))
  const offNormal = (entry: PenReading | undefined): boolean => entry !== undefined && entry.rank !== null
    && (entry.rank.order <= 2 || (entry.reading.limit?.kind === 'margin' && entry.reading.limit.eta !== ''))
  return paths.map((path, index) => ({ path, index, rank: read.get(path)?.rank ?? null, offNormal: offNormal(read.get(path)) }))
    .sort((left, right) => left.rank === null || right.rank === null
      ? Number(left.rank === null) - Number(right.rank === null) || left.index - right.index
      : left.rank.order - right.rank.order || left.rank.by - right.rank.by || left.index - right.index)
    .map(({ path, rank, offNormal: off }) => ({ path, rank, offNormal: off }))
}

// The shortest projected time to a limit first; then past a trip limit, past
// an alarm limit, and nearest relative to the limit it names: the first is
// what the display leads with.
const penRank = (value: number, reading: TrendReading, inForce: ReadonlyArray<ComposedDisplayThreshold>): PenReading['rank'] => {
  const limit = reading.limit
  if (limit?.kind === 'margin' && limit.minutes !== null) return { order: 0, by: limit.minutes }
  const nearest = nearestThresholdMargin(value, inForce)
  if (nearest !== null && isPast(nearest)) return { order: nearest.threshold.kind === 'trip' ? 1 : 2, by: 0 }
  if (limit?.kind !== 'margin') return null
  return { order: 3, by: limit.margin.margin / Math.max(Math.abs(limit.margin.threshold.value), Number.EPSILON) }
}

/** How a display reads as it opens: the values now and each signal's reading, in the order it leads with them. */
export interface ComposedDisplayReading {
  readonly now: ComposedDisplayNow
  readonly readings: ReadonlyArray<PenReading>
}

/** Reads a display once as it opens; its margins and view content are stated from this. */
export const readComposedDisplay = (display: CompiledComposedDisplay, now: ComposedDisplayNow): ComposedDisplayReading => {
  const readings = penReadings(display, now)
  const ranked = readings.filter(entry => entry.rank !== null)
    .sort((left, right) => left.rank!.order - right.rank!.order || left.rank!.by - right.rank!.by)
  return { now, readings: [...ranked, ...readings.filter(entry => entry.rank === null)] }
}

/**
 * Each displayed numeric signal as the display states it: its value, which
 * way it is going and how fast over the legend's window, and the limit the
 * legend names (the one ahead in its direction of travel, with the time to it
 * or "approaching, not projected"; the nearest for a value shown now only).
 * The shortest time to a limit first, then values past a trip or alarm limit,
 * then the nearest; the first is what the display leads with. The answer's
 * "what to watch" should start from these, not from a limit the signal is
 * moving away from.
 */
export const composedDisplayMargins = (reading: ComposedDisplayReading): ReadonlyArray<string> =>
  reading.readings.map(entry => entry.text)

/** A native value as the view shows it, to six digits, or nothing for a state. */
/** A value as the view shows it, in its display unit, with the decimals it is written with where it is written as a number. */
export const shownQuantity = (value: number, unit: string, decimals: number | null): EmbeddedViewContent['items'][number]['values'] =>
  unitLabel(unit) === '' ? [] : [{ value: Number(displayValue(value, unit).toPrecision(6)), unit: unitLabel(unit), ...(decimals === null ? {} : { decimals }) }]

const penNames = (pen: ComposedDisplayPen): Array<string> =>
  [...new Set([pen.name, ...(pen.tagId === undefined ? [] : [pen.tagId]), String(pen.path), pen.label, pen.described])]

/**
 * How the view shows a signal moving: its rate and direction; and where its
 * trend legend names the limit ahead (not yet passed), that limit and the
 * projected time to it.
 */
const travelContent = (entry: PenReading | undefined): Pick<EmbeddedViewContent['items'][number], 'trend' | 'limitAhead' | 'timeToLimitMs'> => {
  if (entry === undefined) return {}
  const { pen, reading } = entry
  const unit = unitLabel(pen.unit)
  const trend = reading.travel === null || reading.rate === null ? {} : { trend: { rate: Number(displayValue(reading.rate, pen.unit).toPrecision(6)), unit, direction: reading.travel } }
  const limit = reading.limit
  if (!entry.legend || limit?.kind !== 'margin') return trend
  const threshold = limit.margin.threshold
  return {
    ...trend,
    limitAhead: { name: marginLimitName(limit.margin, pen.unit), value: displayValue(threshold.value, pen.unit), unit },
    ...(limit.minutes === null ? {} : { timeToLimitMs: Math.max(1, Math.round(limit.minutes * 60_000)) }),
  }
}

/**
 * What the view shows in the terms an answer may cite (the contract's
 * embedded view content): each signal with its current value, limits, rate
 * and direction and the limit ahead of it, the equipment its mimics draw
 * (from the caller, which reads their states), the related or plant alarms,
 * how far back the trend reaches now, and the signal the display leads with,
 * which the answer must name.
 */
export const composedDisplayContent = (
  display: CompiledComposedDisplay,
  { now, readings }: ComposedDisplayReading,
  historyMs: number,
  equipment: EmbeddedViewContent['items'],
): EmbeddedViewContent => {
  const pens = shownPens(display)
  const trended = new Set(display.panels.flatMap(panel => panel.kind === 'trend' ? panel.strips.flatMap(strip => strip.pens.filter(pen => pen.recorded).map(pen => pen.path)) : []))
  const items = pens.map(pen => {
    const value = now.read(pen.path)
    return {
      names: penNames(pen),
      values: typeof value === 'number' ? shownQuantity(shownReading(value, pen.resolution), pen.unit, readingDecimals(shownReading(value, pen.resolution), pen.unit, pen.resolution, pen.limits?.instrumentSpan)) : [],
      limits: pen.thresholds.flatMap(threshold => shownQuantity(threshold.value, pen.unit, writtenDecimals(displayValue(threshold.value, pen.unit)))),
      history: trended.has(pen.path),
      ...travelContent(readings.find(entry => entry.pen.path === pen.path)),
    }
  })
  const alarms = display.panels.flatMap(panel => panel.kind === 'alarms' && (panel.scope === 'plant' || panel.ruleIds.length > 0)
    ? [{ names: [panel.scope === 'plant' ? 'Active alarms and trips of the Plant' : 'Active alarms and trips of the displayed signals and equipment'], values: [], limits: [], history: false }]
    : [])
  const trend = display.panels.find(panel => panel.kind === 'trend')
  const lead = readings[0]?.rank === null ? undefined : readings[0]
  return {
    items: [...items, ...equipment, ...alarms],
    span: trend === undefined ? null : { shownMs: trendSpanMs(trend.horizonMs, historyMs), horizonMs: trend.horizonMs },
    lead: lead === undefined ? null : { item: pens.indexOf(lead.pen), reason: lead.text },
  }
}

export const composedDisplayWarnings = (display: CompiledComposedDisplay): ReadonlyArray<string> => display.panels.flatMap(panel => {
  if (panel.kind === 'alarms') return panel.scope === 'related' && panel.ruleIds.length === 0 ? ['No alarm or trip rule acts on the displayed signals; the related alarms panel will stay empty.'] : []
  if (panel.kind === 'mimic') {
    return [
      ...panel.mimic.summary.unverifiedFlows.map(link => `The Plant model does not verify the flow in ${link}; the mimic draws it as unknown, so say nothing about that flow.`),
      ...panel.mimic.summary.unmeasuredStates.map(label => `The Plant model does not compute the position of ${label}; the mimic judges it by the flow through it ("POS ?").`),
    ]
  }
  return composedPanelPens(panel).flatMap(pen => [
    ...(pen.command ? [`${pen.name} is a writable command (a demand), not a measured state; never present it as the equipment's actual state or position.`] : []),
    ...(panel.kind === 'trend' && pen.role === 'primary' && pen.thresholds.length === 0 ? [`No single-signal I&C threshold acts on ${pen.tagId ?? pen.path}; its trend shows values without threshold lines.`] : []),
    ...(panel.kind === 'trend' && !pen.recorded ? [`${pen.tagId ?? pen.path} is not recorded by this Run's historian; its trend starts when the view opens. Do not describe its history from the display.`] : []),
    ...pen.combinedRules.map(rule => `${pen.tagId ?? pen.path} also feeds the combined rule "${rule.label}" (${rule.kind}); it is listed, not drawn.`),
  ])
})

/** Why a display already shown in a conversation can no longer be drawn. */
export const formatComposedViewIssues = (issues: ReadonlyArray<ComposedDisplayIssue>): string =>
  `This display can no longer be shown for the current Plant model: ${issues.map(issue => `${issue.path}: ${issue.message}`).join('; ')}`

// A capability rejection's message is at most 2,048 characters on the wire;
// a longer one fails as a bare invalid request, losing every fix (evaluation
// run 22, four long refusals at once). Room is kept for the closing line.
const REJECTION_MAX_CHARS = 2_000

/** Every issue that fits, in order; those that do not are counted, to be seen once the first are fixed. */
export const formatComposedDisplayIssues = (issues: ReadonlyArray<ComposedDisplayIssue>): string => {
  const lines = [`Display composition rejected (${issues.length} issue${issues.length === 1 ? '' : 's'}); nothing will be shown. Fix every issue and call world.process-plant.display.compose again:`]
  let length = lines[0]!.length
  for (const [index, issue] of issues.entries()) {
    const line = `- ${issue.path}: ${issue.message}${issue.didYouMean === undefined ? '' : `. Did you mean: ${issue.didYouMean.join('; ')}`}`
    const rest = issues.length - index
    if (length + 1 + line.length > REJECTION_MAX_CHARS) {
      lines.push(`- and ${rest} more issue${rest === 1 ? '' : 's'}, shown once these are fixed`)
      break
    }
    lines.push(line)
    length += 1 + line.length
  }
  return lines.join('\n')
}
