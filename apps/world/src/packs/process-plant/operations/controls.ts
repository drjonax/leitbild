import { z } from 'zod'
import type {
  CompiledComponent,
  CompiledPlantGraph,
  CompiledStateAspect,
  EquipmentFunction,
  ProcessSignalBinding,
  ProcessSignalTagId,
  ProcessVariableValue,
  StateAspect,
  VariablePath,
} from '../graph/index.ts'
import { energyEnds, variablePathSchema } from '../graph/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import type { ProcessPlantIcCondition, ProcessPlantIcRule } from '../runtime/index.ts'
import { resolveProcessPlantSignalBinding } from '../signals.ts'
import { displayValue, unitLabel } from '../displays/display-text.ts'
import { actionOf, icRuleKind } from '../displays/ic-thresholds.ts'
import { deviceLabel, mimicItemId, type MimicItem } from '../displays/mimic/bindings.ts'
import { presentationFor } from '../displays/mimic/presentation.ts'

// What a person may operate on each drawn item, read from what the model
// declares: an aspect's writable command is a two-state control in the
// aspect's words (a pump STARTs and STOPs, an isolating valve OPENs and
// SHUTs, a breaker CLOSEs and OPENs); an on/off command the equipment's
// presentation marks momentary is a pushbutton. Every other writable variable of the item is withheld, with
// why: a fault or a condition outside the Plant is the instructor's; a demand
// a controller holds reads AUTO; a demand or set point is not operated from
// the display. What a command sets going (a trip whose condition reads what
// it moves) and what works against it (automation writing the same command)
// come from the I&C config. Nothing here names a Plant, equipment, signal or
// component kind: the mimic's kind table only says what is drawn.

/** What the model does not declare yet: which commands are not offered to operators. */
export interface ControlDeclarations {
  /**
   * Why a command is not offered to operators where the model would make it
   * look wrong (an RCP start, whose permissives are not modelled): per value
   * written; undefined where it is offered.
   */
  readonly notOffered: (binding: ProcessSignalBinding, value: ProcessVariableValue) => string | undefined
}

/** A rule an operation sets going or that works against it, as displays name what the I&C does there ("RX TRIP", "AFW", "CTL"). */
export interface ControlRule {
  readonly ruleId: string
  readonly label: string
  readonly action: string
}

/** A rule writing the same equipment: through its command, or through its isolation input, which shuts it whatever its command. */
export interface OpposingRule extends ControlRule {
  readonly value: ProcessVariableValue
  readonly via: 'command' | 'isolation'
}

export interface ControlOption {
  /** What the button says: "START", "SHUT", a pushbutton's declared word. */
  readonly word: string
  /** What the command writes. */
  readonly value: ProcessVariableValue
  /** What the equipment reads once it follows ("RUN", "SHUT"); none for a pushbutton. */
  readonly state?: string
  /**
   * How long the equipment takes to follow it, as its kind declares
   * (StateAspectDeclaration.travel); null where the model declares no time:
   * the state is then awaited, never judged not followed.
   */
  readonly travelMs: number | null
  /** What it moves: each variable it sets, with the value it reads after (OptionEffect). */
  readonly moves: ReadonlyArray<{ readonly path: VariablePath; readonly value: ProcessVariableValue | 'unknown' }>
  /** Trips whose condition reads what this option moves, in the direction it moves it. */
  readonly consequences: ReadonlyArray<ControlRule>
  /** Automation that writes the opposite to the same equipment. */
  readonly opposing: ReadonlyArray<OpposingRule>
}

export interface OfferedControl {
  /** The command variable written. */
  readonly path: VariablePath
  readonly tagId?: ProcessSignalTagId
  /** What a button names besides its word: tag and label ("MOV-8000A PZR block valve"). */
  readonly target: string
  readonly form: 'twoState' | 'pushbutton'
  /** The aspect it commands, and the solved state that says whether the equipment followed. */
  readonly aspect?: StateAspect
  readonly state?: VariablePath
  /** The isolation input that shuts the equipment whatever this command demands. */
  readonly isolation?: VariablePath
  readonly options: ReadonlyArray<ControlOption>
  /** Options the model declares not offered, with why (an RCP's START). */
  readonly withheldOptions: ReadonlyArray<{ readonly word: string; readonly value: ProcessVariableValue; readonly reason: string }>
  /** The undrawn logic whose pushbutton this is, where it is shown on the equipment its rules command. */
  readonly from?: string
}

export type WithheldReason =
  | { readonly kind: 'instructor'; readonly actuation: 'faultInjection' | 'boundary'; readonly text: string }
  /** A demand a controller writes every step: a manual demand would be overwritten. */
  | { readonly kind: 'automatic'; readonly measured: VariablePath; readonly setpoint: number; readonly text: string }
  /** A demand or set point (a rod insertion, a pump's speed, a modulating valve's position). */
  | { readonly kind: 'demand'; readonly text: string }
  | { readonly kind: 'isolationInput'; readonly text: string }
  /** A boolean input of the equipment's logic for which the model declares no operator words. */
  | { readonly kind: 'unworded'; readonly text: string }
  | { readonly kind: 'declared'; readonly text: string }

export interface WithheldControl {
  readonly path: VariablePath
  readonly tagId?: ProcessSignalTagId
  readonly reason: WithheldReason
}

export interface ItemControls {
  readonly item: MimicItem
  /** The id an agent names the item by (mimicItemId). */
  readonly id: string
  readonly label: string
  readonly offered: ReadonlyArray<OfferedControl>
  readonly withheld: ReadonlyArray<WithheldControl>
}

export interface PlantControls {
  readonly items: ReadonlyArray<ItemControls>
  /** Pushbuttons of undrawn logic whose rules command no drawn energy end: shown nowhere, so a test can insist there are none. */
  readonly unplaced: ReadonlyArray<{ readonly path: VariablePath; readonly reason: string }>
}

const instructorText: Readonly<Record<'faultInjection' | 'boundary', string>> = {
  faultInjection: 'Instructor only: a fault the scenario injects',
  boundary: 'Instructor only: a condition outside the Plant',
}
const demandText = 'A demand or set point: not operated from the display'
const isolationText = 'Automatic isolation input: set by the I&C'
const unwordedText = 'An input of the equipment logic: no operator words are declared for it'

interface TwoStateWords {
  readonly on: { readonly word: string; readonly state: string }
  readonly off: { readonly word: string; readonly state: string }
}

// The aspect's words, as its state reads (state-words.ts): equipment that runs
// starts and stops; a breaker's contacts close and open; an isolating or
// relieving valve opens and shuts. A modulating valve's position is a demand.
const aspectWords = (aspect: CompiledStateAspect, equipmentFunction: EquipmentFunction | undefined): TwoStateWords | null =>
  aspect.aspect === 'running' ? { on: { word: 'START', state: 'RUN' }, off: { word: 'STOP', state: 'STOP' } }
    : aspect.aspect === 'energized' ? { on: { word: 'CONNECT', state: 'LIVE' }, off: { word: 'DISCONNECT', state: 'DEAD' } }
      : aspect.aspect === 'position' && aspect.state?.reading === 'closedWhileTrue' ? { on: { word: 'CLOSE', state: 'CLOSED' }, off: { word: 'OPEN', state: 'OPEN' } }
        : aspect.aspect === 'position' && (equipmentFunction === 'isolating' || equipmentFunction === 'relieving') ? { on: { word: 'OPEN', state: 'OPEN' }, off: { word: 'SHUT', state: 'SHUT' } }
          : null

// The values a two-state command writes: true and false, or a position's full span.
const twoStateValues = (binding: ProcessSignalBinding): { readonly on: ProcessVariableValue; readonly off: ProcessVariableValue } | null =>
  binding.quantity === 'boolean' ? { on: true, off: false }
    : binding.quantity === 'ratio' && binding.unit === 'fraction' ? { on: 1, off: 0 }
      : binding.quantity === 'ratio' && binding.unit === 'percent' ? { on: 100, off: 0 }
        : null

const declaredControllerSchema = z.object({
  measuredPath: variablePathSchema,
  setpoint: z.number().finite(),
}).passthrough()

/**
 * The controller a component declares on its demand, which writes that
 * demand every step from what it measures (a feed regulating valve held to
 * its steam generator's level); null where it declares none.
 */
export const declaredController = (component: CompiledComponent): { readonly measured: VariablePath; readonly setpoint: number } | null => {
  const parameters = component.parameters
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) return null
  const controller = (parameters as Readonly<Record<string, unknown>>).controller
  if (controller === undefined) return null
  const parsed = declaredControllerSchema.parse(controller)
  return { measured: parsed.measuredPath, setpoint: parsed.setpoint }
}

const automaticReason = (graph: CompiledPlantGraph, controller: { readonly measured: VariablePath; readonly setpoint: number }): WithheldReason => {
  const measured = graph.signalBindingByPath.get(controller.measured)
  if (measured === undefined) throw new Error(`controller measures an unknown variable: ${controller.measured}`)
  const unit = unitLabel(measured.unit)
  const setpoint = `${Number(displayValue(controller.setpoint, measured.unit).toPrecision(12))}${unit === '' ? '' : ` ${unit}`}`
  return { kind: 'automatic', measured: controller.measured, setpoint: controller.setpoint, text: `AUTO · ${measured.tagId ?? measured.label} held to ${setpoint}` }
}

const labelOf = (component: CompiledComponent): string => component.metadata?.presentation?.shortLabel ?? component.label

const localPath = (component: CompiledComponent, path: VariablePath): string => String(path).slice(String(component.id).length + 1)

const declaredWords = (component: CompiledComponent, path: VariablePath): { readonly on: string; readonly off: string } | undefined =>
  component.metadata?.presentation?.states?.[localPath(component, path)]

const stateWordsOf = (graph: CompiledPlantGraph, path: VariablePath): { readonly on: string; readonly off: string } | undefined => {
  const owner = graph.signalBindingByPath.get(path)?.owner
  return owner?.type === 'component' ? declaredWords(graph.components[owner.componentIndex]!, path) : undefined
}

const defined = <T,>(value: T | undefined): value is T => value !== undefined

const comparisonLeaves = (condition: ProcessPlantIcCondition, positive = true): ReadonlyArray<{ readonly leaf: Extract<ProcessPlantIcCondition, { type: 'comparison' }>; readonly positive: boolean }> =>
  condition.type === 'comparison' ? [{ leaf: condition, positive }]
    : condition.type === 'not' ? comparisonLeaves(condition.condition, !positive)
      : condition.conditions.flatMap(child => comparisonLeaves(child, positive))

/** As the I&C compares (control-protection-conditions.ts). */
export const compareIcValues = (left: ProcessVariableValue, operator: Extract<ProcessPlantIcCondition, { type: 'comparison' }>['operator'], right: number | boolean): boolean => {
  if (operator === '==' || operator === '!=') return operator === '==' ? left === right : left !== right
  if (typeof left !== 'number' || typeof right !== 'number') throw new Error(`operator ${operator} requires numeric values`)
  return operator === '<' ? left < right : operator === '<=' ? left <= right : operator === '>' ? left > right : left >= right
}

/**
 * How long after a command its equipment may still be travelling before it
 * reads as not followed: its travel time and a quarter of it more, at least
 * 2 s more (plan-final I-2). The display's not-followed rule uses the same.
 */
export const followAllowanceMs = (travelMs: number): number => travelMs + Math.max(travelMs / 4, 2_000)

/** What an option moves: each variable it sets, with the value it reads after, or 'unknown' where the model's state settles to no declared value (a speed). */
export type OptionEffect = ReadonlyMap<VariablePath, ProcessVariableValue | 'unknown'>

const ruleRef = (plant: CompiledProcessPlant, rule: ProcessPlantIcRule): ControlRule => ({ ruleId: rule.id, label: rule.label ?? rule.id, action: actionOf(plant, rule) })

/** Whether a condition has a leaf the option's effect satisfies, as the leaf sits (under a NOT, by leaving it false). */
const reachedBy = (plant: CompiledProcessPlant, condition: ProcessPlantIcCondition, effect: OptionEffect): boolean =>
  comparisonLeaves(condition).some(({ leaf, positive }) => {
    const value = effect.get(resolveProcessPlantSignalBinding(plant.graph, leaf.signal).path)
    if (value === undefined) return false
    if (value === 'unknown') return true
    return compareIcValues(value, leaf.operator, leaf.value) === positive
  })

const consequencesOf = (plant: CompiledProcessPlant, effect: OptionEffect): ReadonlyArray<ControlRule> =>
  plant.automation.rules.filter(rule => rule.enabled && icRuleKind(rule) === 'trip' && reachedBy(plant, rule.condition, effect)).map(rule => ruleRef(plant, rule))

const opposingOf = (plant: CompiledProcessPlant, command: VariablePath, value: ProcessVariableValue, isolation: VariablePath | undefined, on: boolean): ReadonlyArray<OpposingRule> =>
  plant.automation.rules.filter(rule => rule.enabled).flatMap(rule => rule.effects.flatMap((effect): ReadonlyArray<OpposingRule> => {
    if (effect.type !== 'writeSignal') return []
    const path = resolveProcessPlantSignalBinding(plant.graph, effect.signal).path
    if (path === command && effect.value !== value) return [{ ...ruleRef(plant, rule), value: effect.value, via: 'command' as const }]
    if (path === isolation && on && effect.value === true) return [{ ...ruleRef(plant, rule), value: effect.value, via: 'isolation' as const }]
    return []
  }))

// The value a state reads once the equipment follows a command: as the
// command for an on/off state or a position, zero for a stopped speed or flow,
// and unknown for a running speed or flow.
const stateAfter = (reading: NonNullable<CompiledStateAspect['state']>['reading'], value: ProcessVariableValue): ProcessVariableValue | 'unknown' => {
  if (reading === 'true' || reading === 'closedWhileTrue' || reading === 'value') return value
  return value === false || value === 0 ? 0 : 'unknown'
}

const optionFor = (
  plant: CompiledProcessPlant,
  context: { readonly command: VariablePath; readonly aspect?: CompiledStateAspect; readonly memories: ReadonlyArray<VariablePath> },
  choice: { readonly word: string; readonly value: ProcessVariableValue; readonly state?: string; readonly on: boolean },
): ControlOption => {
  const effect = new Map<VariablePath, ProcessVariableValue | 'unknown'>([[context.command, choice.value]])
  if (context.aspect?.state !== undefined) effect.set(context.aspect.state.path, stateAfter(context.aspect.state.reading, choice.value))
  // A pushbutton's logic latches the press in a memory of the same equipment (QA-4): what reads it set acts on the press.
  for (const memory of context.memories) effect.set(memory, true)
  return {
    word: choice.word,
    value: choice.value,
    ...(choice.state === undefined ? {} : { state: choice.state }),
    travelMs: context.aspect?.travel === undefined ? null : 1_000 * (choice.on ? context.aspect.travel.onS : context.aspect.travel.offS),
    moves: [...effect].map(([path, value]) => ({ path, value })),
    consequences: consequencesOf(plant, effect),
    opposing: opposingOf(plant, context.command, choice.value, context.aspect?.isolation, choice.on),
  }
}

type Classified =
  | { readonly offered: OfferedControl }
  | { readonly withheld: WithheldControl }

const withheld = (binding: ProcessSignalBinding, reason: WithheldReason): Classified =>
  ({ withheld: { path: binding.path, ...(binding.tagId === undefined ? {} : { tagId: binding.tagId }), reason } })

// The on/off memories of a pushbutton's own equipment: read-only booleans its logic sets on the press.
const memoriesOf = (graph: CompiledPlantGraph, component: CompiledComponent): ReadonlyArray<VariablePath> =>
  component.variables.flatMap(variable => {
    const binding = graph.signalBindingByPath.get(variable.path)
    return binding !== undefined && !binding.writable && binding.quantity === 'boolean' ? [binding.path] : []
  })

const classify = (
  plant: CompiledProcessPlant,
  declarations: ControlDeclarations,
  context: {
    readonly component: CompiledComponent
    readonly aspects: ReadonlyArray<CompiledStateAspect>
    readonly isolations: ReadonlySet<VariablePath>
    readonly equipmentFunction: EquipmentFunction | undefined
    readonly controller: { readonly measured: VariablePath; readonly setpoint: number } | null
    readonly label: string
  },
  binding: ProcessSignalBinding,
): Classified => {
  if (binding.actuation === 'faultInjection' || binding.actuation === 'boundary') {
    return withheld(binding, { kind: 'instructor', actuation: binding.actuation, text: instructorText[binding.actuation] })
  }
  if (context.isolations.has(binding.path)) return withheld(binding, { kind: 'isolationInput', text: isolationText })
  const aspect = context.aspects.find(candidate => candidate.command === binding.path)
  if (aspect !== undefined && context.controller !== null) return withheld(binding, automaticReason(plant.graph, context.controller))
  const words = aspect === undefined ? undefined : aspectWords(aspect, context.equipmentFunction)
  const declared = declaredWords(context.component, binding.path)
  const target = `${binding.tagId === undefined ? '' : `${binding.tagId} `}${context.label}`
  const base = {
    path: binding.path,
    ...(binding.tagId === undefined ? {} : { tagId: binding.tagId }),
    target,
    ...(aspect === undefined ? {} : { aspect: aspect.aspect }),
    ...(aspect?.state === undefined ? {} : { state: aspect.state.path }),
    ...(aspect?.isolation === undefined ? {} : { isolation: aspect.isolation }),
  }
  const optionContext = { command: binding.path, ...(aspect === undefined ? {} : { aspect }), memories: [] as ReadonlyArray<VariablePath> }
  const offer = (form: OfferedControl['form'], choices: ReadonlyArray<{ readonly word: string; readonly value: ProcessVariableValue; readonly state?: string; readonly on: boolean }>, memories: ReadonlyArray<VariablePath> = []): Classified => {
    const kept = choices.filter(choice => declarations.notOffered(binding, choice.value) === undefined)
    const dropped = choices.flatMap(choice => {
      const reason = declarations.notOffered(binding, choice.value)
      return reason === undefined ? [] : [{ word: choice.word, value: choice.value, reason }]
    })
    if (kept.length === 0) return withheld(binding, { kind: 'declared', text: [...new Set(dropped.map(option => option.reason))].join('; ') })
    return { offered: { ...base, form, options: kept.map(choice => optionFor(plant, { ...optionContext, memories }, choice)), withheldOptions: dropped } }
  }
  // A pushbutton is never an aspect's input (the compiler holds it to that): it is worded as its presentation words it pressed.
  if (context.component.metadata?.presentation?.momentary?.includes(localPath(context.component, binding.path)) === true) {
    return offer('pushbutton', [{ word: declared?.on ?? binding.label, value: true, on: true }], memoriesOf(plant.graph, context.component))
  }
  if (aspect !== undefined) {
    const values = twoStateValues(binding)
    if (words === null || words === undefined || values === null) return withheld(binding, { kind: 'demand', text: demandText })
    // Words declared for the aspect's state replace its own (a generator on its breaker reads ON LINE).
    const stated = aspect.state === undefined ? undefined : stateWordsOf(plant.graph, aspect.state.path)
    return offer('twoState', [
      { word: words.on.word, value: values.on, state: stated?.on ?? words.on.state, on: true },
      { word: words.off.word, value: values.off, state: stated?.off ?? words.off.state, on: false },
    ])
  }
  if (binding.quantity !== 'boolean') return withheld(binding, { kind: 'demand', text: demandText })
  if (declared === undefined) return withheld(binding, { kind: 'unworded', text: unwordedText })
  return offer('twoState', [
    { word: declared.on, value: true, state: declared.on, on: true },
    { word: declared.off, value: false, state: declared.off, on: false },
  ])
}

// The writable variables an item stands for: a bundled device's own, or the
// component's apart from those of the devices it bundles.
const itemWritables = (graph: CompiledPlantGraph, component: CompiledComponent, device: string | undefined): ReadonlyArray<ProcessSignalBinding> => {
  const devicePaths = (declared: CompiledComponent['semantics']['embedded'][number]): ReadonlyArray<VariablePath> =>
    [...declared.variables, ...declared.aspects.flatMap(aspect => [aspect.command, aspect.isolation].filter(defined))]
  const paths = device === undefined
    ? (() => {
        const owned = new Set(component.semantics.embedded.flatMap(devicePaths))
        return component.variables.map(variable => variable.path).filter(path => !owned.has(path))
      })()
    : [...new Set(devicePaths(component.semantics.embedded.find(candidate => candidate.id === device)!))]
  return paths.flatMap(path => {
    const binding = graph.signalBindingByPath.get(path)
    if (binding === undefined) throw new Error(`process plant variable has no signal binding: ${path}`)
    return binding.writable ? [binding] : []
  })
}

const classifiedFor = (plant: CompiledProcessPlant, item: MimicItem, declarations: ControlDeclarations): { readonly label: string; readonly classified: ReadonlyArray<Classified> } => {
  const graph = plant.graph
  const component = graph.components[item.component]!
  const device = item.kind === 'device' ? component.semantics.embedded.find(candidate => candidate.id === item.device) : undefined
  if (item.kind === 'device' && device === undefined) throw new Error(`component ${component.id} bundles no device ${item.device}`)
  const aspects = device?.aspects ?? component.semantics.aspects
  const label = device === undefined ? labelOf(component) : deviceLabel(component, device)
  const isolations = new Set([...component.semantics.aspects, ...component.semantics.embedded.flatMap(candidate => candidate.aspects)].map(aspect => aspect.isolation).filter(defined))
  const context = {
    component,
    aspects,
    isolations,
    equipmentFunction: device?.function ?? component.semantics.function,
    // A controller drives the component's own demand, not a bundled device's.
    controller: device === undefined ? declaredController(component) : null,
    label,
  }
  const writables = itemWritables(graph, component, device?.id)
  // The aspects' commands first, in aspect order: the control an operator looks for.
  const commands = aspects.map(aspect => aspect.command).filter(defined)
  const ordered = [...writables.filter(binding => commands.includes(binding.path)).sort((left, right) => commands.indexOf(left.path) - commands.indexOf(right.path)), ...writables.filter(binding => !commands.includes(binding.path))]
  return { label, classified: ordered.map(binding => classify(plant, declarations, context, binding)) }
}

/** The controls one drawn item offers, and the writable variables it withholds with why. */
export const deriveItemControls = (plant: CompiledProcessPlant, item: MimicItem, declarations: ControlDeclarations): ItemControls => {
  const { label, classified } = classifiedFor(plant, item, declarations)
  return {
    item,
    id: mimicItemId(plant.graph, item),
    label,
    offered: classified.flatMap(entry => 'offered' in entry ? [entry.offered] : []),
    withheld: classified.flatMap(entry => 'withheld' in entry ? [entry.withheld] : []),
  }
}

/** Every item a mimic can draw: each component its kind table draws, and each device such a component bundles. */
export const operableItems = (plant: CompiledProcessPlant): ReadonlyArray<MimicItem> =>
  plant.graph.components.flatMap((component): ReadonlyArray<MimicItem> => presentationFor(component).element === 'not-drawn' ? [] : [
    { kind: 'component', component: component.index },
    ...component.semantics.embedded.map((device): MimicItem => ({ kind: 'device', component: component.index, device: device.id })),
  ])

const readsComponent = (plant: CompiledProcessPlant, rule: ProcessPlantIcRule, component: CompiledComponent): boolean =>
  comparisonLeaves(rule.condition).some(({ leaf }) => {
    const owner = resolveProcessPlantSignalBinding(plant.graph, leaf.signal).owner
    return owner.type === 'component' && owner.componentIndex === component.index
  })

/**
 * The energy ends a logic's rules command: the source or sink equipment whose
 * variables a rule reading the logic writes (a manual reactor trip's rule
 * inserts the core's rods).
 */
const commandedEnds = (plant: CompiledProcessPlant, component: CompiledComponent): ReadonlyArray<number> => {
  const energy = new Set(energyEnds(plant.graph).map(end => end.component.index))
  const ends = new Set<number>()
  for (const rule of plant.automation.rules) {
    if (!rule.enabled || !readsComponent(plant, rule, component)) continue
    for (const effect of rule.effects) {
      if (effect.type !== 'writeSignal') continue
      const owner = resolveProcessPlantSignalBinding(plant.graph, effect.signal).owner
      if (owner.type === 'component' && energy.has(owner.componentIndex)) ends.add(owner.componentIndex)
    }
  }
  return [...ends].sort((left, right) => left - right)
}

/**
 * Every drawn item's controls, with the pushbuttons of undrawn logic (a
 * manual trip, the SI block) on the energy ends their rules command (QA-11):
 * the drawing has no symbol for the logic itself.
 */
export const derivePlantControls = (plant: CompiledProcessPlant, declarations: ControlDeclarations): PlantControls => {
  const items = operableItems(plant).map(item => deriveItemControls(plant, item, declarations))
  const byComponent = new Map(items.flatMap(entry => entry.item.kind === 'component' ? [[entry.item.component, entry] as const] : []))
  const attached = new Map<number, OfferedControl[]>()
  const unplaced: Array<{ readonly path: VariablePath; readonly reason: string }> = []
  for (const component of plant.graph.components) {
    if (presentationFor(component).element !== 'not-drawn') continue
    const { classified } = classifiedFor(plant, { kind: 'component', component: component.index }, declarations)
    const pushbuttons = classified.flatMap(entry => 'offered' in entry && entry.offered.form === 'pushbutton' ? [entry.offered] : [])
    if (pushbuttons.length === 0) continue
    const ends = commandedEnds(plant, component).filter(end => byComponent.has(end))
    for (const pushbutton of pushbuttons) {
      if (ends.length === 0) {
        unplaced.push({ path: pushbutton.path, reason: `no rule reading ${component.label} commands a drawn energy end` })
        continue
      }
      for (const end of ends) attached.set(end, [...(attached.get(end) ?? []), { ...pushbutton, from: String(component.id) }])
    }
  }
  return {
    items: items.map(entry => entry.item.kind !== 'component' || !attached.has(entry.item.component) ? entry
      : { ...entry, offered: [...entry.offered, ...attached.get(entry.item.component)!] }),
    unplaced,
  }
}

/**
 * The offered option a write is, on the first item that offers it, or why
 * it is not offered: what a proposal, and later a person's own command, is
 * held to.
 */
export const offeredOption = (
  controls: PlantControls,
  write: { readonly path: VariablePath; readonly value: ProcessVariableValue },
): { readonly ok: true; readonly item: string; readonly word: string } | { readonly ok: false; readonly reason: string } => {
  for (const entry of controls.items) {
    for (const control of entry.offered) {
      if (control.path !== write.path) continue
      const option = control.options.find(candidate => candidate.value === write.value)
      if (option !== undefined) return { ok: true, item: entry.id, word: option.word }
      const withheldOption = control.withheldOptions.find(candidate => candidate.value === write.value)
      if (withheldOption !== undefined) return { ok: false, reason: withheldOption.reason }
      return { ok: false, reason: `${control.target} takes ${control.options.map(candidate => `${candidate.word} (${String(candidate.value)})`).join(' or ')}` }
    }
  }
  const withheldControl = controls.items.flatMap(entry => entry.withheld).find(control => control.path === write.path)
  if (withheldControl !== undefined) return { ok: false, reason: withheldControl.reason.text }
  return { ok: false, reason: `${write.path} is no control of any drawn equipment` }
}
