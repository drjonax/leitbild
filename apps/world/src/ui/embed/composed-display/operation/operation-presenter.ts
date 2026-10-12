import type { CompiledComposedDisplay } from '../../../../packs/process-plant/displays/compose.ts'
import { displayValue, formatQuantity } from '../../../../packs/process-plant/displays/display-text.ts'
import { readingStateText, type TrendReading } from '../../../../packs/process-plant/displays/trend-reading.ts'
import type { ProcessVariableValue, VariablePath } from '../../../../packs/process-plant/graph/index.ts'
import { demandSetting, followAllowanceMs, type ControlOption, type OfferedControl, type OpposingRule } from '../../../../packs/process-plant/operations/controls.ts'
import type { RuleStanding } from '../../../../packs/process-plant/operations/control-standing.ts'
import type { ListedControl, ListedItem } from '../../../../packs/process-plant/operations/instance-ports.ts'
import type { PushbuttonRole } from '../../../../packs/process-plant/operations/pushbutton-protection.ts'
import type { OperationRecord } from '../../../../packs/process-plant/operations/plant-operations.ts'
import type { ProcessPlantProposal, ProposalReview } from '../../../../packs/process-plant/operations/proposals.ts'

export type { ListedControl, ListedItem, OperationRecord }

// What the operation parts of a display render, from what World derives
// (operations/controls.ts, control-standing.ts, proposals.ts) and what the
// latest sample reads: an item's CONTROL section, a proposal's approval card,
// the window's list of pending proposals, and the badges its symbol carries.
// Every word comes from the derivation, the I&C config or the proposal book;
// nothing here names a Plant, equipment or signal. Pure: the components and
// the mimic renderer only draw what this returns.

/** A selection not executed within this wall time is cancelled (select-before-operate, plan §4.2). */
export const SELECTION_TIMEOUT_MS = 30_000
/** What every control and decision says while the page's samples are stale: it is disabled (HMI review of run 26c). */
export const STALE_CONTROLS = 'Plant data stale: controls disabled'
/** How long an operation's attribution stays on its symbol, in plant time (plan §4.3). */
export const ATTRIBUTION_MS = 5 * 60_000
/** A position reads as an option's state within this fraction of its travel. */
const POSITION_TOLERANCE = 0.05

/** The Plant as the latest sample reads it. */
export interface OperationNow {
  readonly read: (path: VariablePath) => ProcessVariableValue | undefined
  readonly elapsedMs: number
  /** A plant time as the display's clock writes it ("10:03:12"). */
  readonly clock: (elapsedMs: number) => string
  /** A value of a signal as the display writes it, with its unit ("20.0 %", "15.17 MPa", a state in its words). */
  readonly format: (path: VariablePath, value: ProcessVariableValue) => string
}

/** A plant time as the display window writes it beside an operation ("10:03:12"): the Run's clock, which is UTC. */
const plantClock = (ms: number): string => new Date(ms).toISOString().slice(11, 19)

/**
 * The Plant as an operated display's latest sample reads it. `units` are the
 * units of the signals its controls and proposals write and cite (from World's
 * signals.resolve); a value of a signal without one is a fault of the caller.
 */
export const operationNow = (
  sample: { readonly simulationTime: string; readonly plantElapsedMs: number; readonly values: ReadonlyArray<{ readonly path: string; readonly value: ProcessVariableValue }> },
  units: ReadonlyMap<string, string>,
): OperationNow => {
  const values = new Map(sample.values.map(entry => [entry.path, entry.value]))
  const startMs = Date.parse(sample.simulationTime) - sample.plantElapsedMs
  return {
    read: path => values.get(String(path)),
    elapsedMs: sample.plantElapsedMs,
    clock: elapsedMs => plantClock(startMs + elapsedMs),
    format: (path, value) => {
      if (typeof value === 'boolean') return value ? 'true' : 'false'
      const unit = units.get(String(path))
      if (unit === undefined) throw new Error(`no unit resolved for ${path}`)
      return formatQuantity(value, unit)
    },
  }
}

// --- CONTROL ----------------------------------------------------------------

export interface OptionView {
  readonly key: string
  readonly word: string
  readonly value: ProcessVariableValue
  /** The equipment reads this option's state now: not offered for selection. */
  readonly current: boolean
  /** What Execute, a slide or Approve says: verb, tag and label (QA-7). */
  readonly action: string
  /**
   * How it is confirmed: a slide for an option that sets a trip going or is a
   * protective pushbutton, a button otherwise (plan §4.2).
   */
  readonly confirm: 'button' | 'slide'
  /** A protective pushbutton: its slide is select and execute at once, with no timeout (QA-8). */
  readonly slideOnly: boolean
  /** The trips it sets going, and where they stand: "→ RX TRIP · Reactor trip on RCP breaker open: armed". */
  readonly consequences: ReadonlyArray<string>
  /** Automation writing the opposite, and where it stands: "AFW START · … writes START: acted at 10:01:02". */
  readonly opposing: ReadonlyArray<string>
  /** The protection actuation that stands against it: the command is refused while it stands (QA-2). */
  readonly heldBy: string | null
  /** How long the equipment takes to follow it, as its kind declares; null where none is declared (its state is awaited, never judged not followed). */
  readonly travelMs: number | null
  /** The equipment's isolation input stands: it stays shut whatever this option demands. */
  readonly isolated: string | null
  /** World's consequence line for it, where World derives one: what it stops, shuts or isolates now, and what may actuate. */
  readonly consequence: string | null
}

/**
 * A demand control's span and where it stands (a modulating valve set "OPEN
 * to 40 %"), in its shown unit (%): its OPEN and SHUT options are its ends;
 * any setting on its step between them is an option of its own
 * (demandOption).
 */
export interface DemandView {
  readonly control: OfferedControl
  readonly min: number
  readonly max: number
  readonly step: number
  /** min, max and step as a person reads and sets them ("%"). */
  readonly shown: { readonly min: number; readonly max: number; readonly step: number; readonly unit: string }
  /** What it is commanded to now, in the command's unit, and as a person reads it ("40 %"). */
  readonly setting: number
  readonly settingText: string
  /** Where the equipment stands, in the command's unit. */
  readonly position: number
}

export interface ControlView {
  readonly path: VariablePath
  readonly target: string
  readonly form: OfferedControl['form']
  /** The state the equipment reads now, in the options' words; null for a pushbutton, or a position between them ("35 %"). */
  readonly now: string | null
  /** A demand control's command beside where it stands, where they differ ("CMD 40 %"); null otherwise. */
  readonly commanded: string | null
  readonly options: ReadonlyArray<OptionView>
  /** A demand control's span and setting; absent on two-state controls and pushbuttons. */
  readonly demand?: DemandView
  /** "Throttled under <label>": the standing actuations that drove its demand to an end while a person sets it between (World's labels as given). */
  readonly throttled: ReadonlyArray<string>
  readonly withheldOptions: ReadonlyArray<{ readonly word: string; readonly reason: string }>
  readonly statePath?: VariablePath
  readonly travelMs: number | null
  /** The undrawn logic whose pushbutton it is, where it sits on the equipment its rules command. */
  readonly from?: string
  /**
   * A protective pushbutton: whether it trips, actuates or blocks protection,
   * and the permissive or interlock gating it, as it stands now ("Low
   * pressurizer pressure SI block permitted below P-11: not met now").
   */
  readonly protection?: { readonly role: PushbuttonRole; readonly gate: { readonly text: string; readonly allows: boolean; readonly message: string | null } | null }
}

export interface ItemControlView {
  readonly id: string
  readonly label: string
  readonly controls: ReadonlyArray<ControlView>
  /** Demands a controller holds, read-only: "AUTO · SG-A-LVL-NR held to 55 %", and what operating them by hand would take. */
  readonly auto: ReadonlyArray<{ readonly text: string; readonly manual: string }>
  /** Where a valve stands, as its popover shows it in place of a trend ("35 %"); null for other equipment. */
  readonly position: string | null
  /** What the item withholds besides, with why: demands, set points, isolation inputs (a fault or boundary input is never listed: controls.ts). */
  readonly withheld: ReadonlyArray<{ readonly name: string; readonly reason: string }>
}

const optionKey = (control: OfferedControl, option: ControlOption): string => `${control.path}=${String(option.value)}`

/** The value an option's state reads once the equipment followed it; undefined for a pushbutton or a state that settles to no declared value. */
const stateValue = (control: OfferedControl, option: ControlOption): ProcessVariableValue | undefined => {
  const move = option.moves.find(candidate => candidate.path === control.state)
  return move === undefined || move.value === 'unknown' ? undefined : move.value
}

const reads = (reading: ProcessVariableValue | undefined, value: ProcessVariableValue | undefined): boolean =>
  reading !== undefined && value !== undefined
  && (typeof reading === 'number' && typeof value === 'number' ? Math.abs(reading - value) <= POSITION_TOLERANCE * Math.max(1, Math.abs(value)) : reading === value)

/** The option whose state the equipment reads now; undefined between them or without a state. */
const currentOption = (control: OfferedControl, now: OperationNow): ControlOption | undefined => {
  if (control.state === undefined) return undefined
  const reading = now.read(control.state)
  return control.options.find(option => reads(reading, stateValue(control, option)))
    // A stopped speed or flow reads zero; a running one any other value.
    ?? control.options.find(option => {
      const move = option.moves.find(candidate => candidate.path === control.state)
      return move?.value === 'unknown' && typeof reading === 'number' && reading > 0
    })
}

const nowWords = (control: OfferedControl, now: OperationNow): string | null => {
  if (control.form === 'pushbutton' || control.state === undefined) return null
  // A demand control reads where it stands on its own step ("35 %"), or at an end in its word.
  if (control.demand !== undefined) {
    const reading = now.read(control.state)
    if (typeof reading !== 'number') return null
    const end = currentOption(control, now)
    return end?.state ?? formatQuantity(reading, control.demand.unit, control.demand.step)
  }
  const current = currentOption(control, now)
  if (current?.state !== undefined) return current.state
  const reading = now.read(control.state)
  return reading === undefined ? null : now.format(control.state, reading)
}

const standingWords = (standing: RuleStanding, now: OperationNow): string =>
  standing.state === 'armed' ? 'armed' : standing.sealedIn ? `sealed in since ${now.clock(standing.atElapsedMs)}` : `acted at ${now.clock(standing.atElapsedMs)}`

const wordFor = (control: OfferedControl, value: ProcessVariableValue): string =>
  control.options.find(option => option.value === value)?.word ?? control.withheldOptions.find(option => option.value === value)?.word ?? String(value)

const opposingWords = (control: OfferedControl, rule: OpposingRule): string =>
  rule.via === 'isolation' ? 'isolates it' : `writes ${wordFor(control, rule.value)}`

/**
 * World's consequence line for an option or a proposal (C2a, O-core): what
 * the operation stops, shuts or isolates now and where that flow goes, the
 * mode, and what may actuate. Shown where World gives one; none otherwise.
 */
export const consequenceLine = (carrier: object): string | null => {
  const line = (carrier as { readonly consequence?: unknown }).consequence
  return typeof line === 'string' && line !== '' ? line : null
}

const optionView = (listed: ListedControl, option: ControlOption, index: number, current: ControlOption | undefined, now: OperationNow): OptionView => {
  const { control } = listed
  const standing = listed.standing[index]
  if (standing === undefined) throw new Error(`no standing for option ${option.word} of ${control.target}`)
  const setsTripGoing = standing.consequences.some(rule => rule.state === 'armed')
  // A pushbutton that trips, actuates or blocks protection is slid, never pressed once (HMI review of run 26c).
  const blocks = listed.protection?.blocks
  const protective = control.form === 'pushbutton' && (option.consequences.length > 0 || blocks !== undefined)
  const held = standing.heldBy
  return {
    key: optionKey(control, option),
    word: option.word,
    value: option.value,
    current: current === option,
    action: `${option.word} ${control.target}`,
    confirm: setsTripGoing || protective ? 'slide' : 'button',
    slideOnly: protective,
    consequences: [
      ...standing.consequences.map(rule => `→ ${rule.action} · ${rule.label}: ${standingWords(rule, now)}`),
      ...(blocks === undefined ? [] : blocks.rules.map(rule => `Blocks ${rule.action} · ${rule.label}`)),
    ],
    opposing: standing.opposing.map(rule => `${rule.action} · ${rule.label} ${opposingWords(control, rule)}: ${standingWords(rule, now)}`),
    heldBy: held === undefined ? null
      : `${held.label} holds ${control.target} ${wordFor(control, held.value)} since ${now.clock(held.atElapsedMs)}: overriding it is not offered here`,
    isolated: standing.isolated ? `Its isolation input stands: ${control.target} stays shut whatever it is commanded` : null,
    travelMs: option.travelMs,
    consequence: consequenceLine(option) ?? consequenceLine(standing),
  }
}

/** Where a control stands in its item's list: trips first, then actuations, then the rest, blocks last (actuate before defeat). */
const protectionRank = (listed: ListedControl): number => {
  const role = listed.protection?.role
  return role === 'trip' ? 0 : role === 'actuation' ? 1 : role === 'block' ? 3 : 2
}

/** A protective pushbutton's role and the gate on it, in words. */
const protectionView = (listed: ListedControl): ControlView['protection'] => {
  const protection = listed.protection
  if (protection === undefined) return undefined
  const gate = protection.gate
  return {
    role: protection.role,
    gate: gate === undefined ? null : {
      text: `${gate.label}: ${gate.kind === 'permissive' ? (gate.allows ? 'met now' : 'not met now') : (gate.allows ? 'clear now' : 'standing now')}`,
      allows: gate.allows,
      message: gate.message ?? null,
    },
  }
}

/** The CONTROL section of one item, as it reads now. */
const demandView = (listed: ListedControl, now: OperationNow): DemandView | undefined => {
  const { control } = listed
  const demand = control.demand
  if (demand === undefined || control.state === undefined) return undefined
  // Where it stands and what it is commanded to, as the latest sample reads them; as World listed them before the first.
  const read = (path: VariablePath, listedValue: number | undefined): number => {
    const value = now.read(path)
    if (typeof value === 'number') return value
    if (listedValue === undefined) throw new Error(`${path} reads no number`)
    return listedValue
  }
  const shown = (value: number): number => Number(displayValue(value, demand.unit).toPrecision(12))
  const setting = read(control.path, listed.now?.demand)
  return {
    control,
    min: demand.min,
    max: demand.max,
    step: demand.step,
    shown: { min: shown(demand.min), max: shown(demand.max), step: shown(demand.step), unit: demand.shownUnit },
    setting,
    settingText: formatQuantity(setting, demand.unit, demand.step),
    position: read(control.state, listed.now?.position),
  }
}

/** The CONTROL section of one item, as it reads now. */
export const itemControlView = (item: ListedItem, now: OperationNow): ItemControlView => ({
  id: item.id,
  label: item.label,
  controls: [...item.offered].sort((left, right) => protectionRank(left) - protectionRank(right)).map(listed => {
    const { control } = listed
    const current = currentOption(control, now)
    const demand = demandView(listed, now)
    const protection = protectionView(listed)
    const blocks = listed.protection?.blocks
    return {
      path: control.path,
      target: control.target,
      form: control.form,
      // A block reads whether it stands; any other pushbutton has no state of its own.
      now: blocks === undefined ? nowWords(control, now) : blocks.blocked ? 'blocked' : 'not blocked',
      commanded: demand === undefined || Math.abs(demand.setting - demand.position) <= demand.step / 2 ? null : `CMD ${demand.settingText}`,
      throttled: (listed.throttledUnder ?? []).map(rule => `Throttled under ${rule.label}`),
      options: control.options.map((option, index) => optionView(listed, option, index, current, now)),
      ...(demand === undefined ? {} : { demand }),
      withheldOptions: control.withheldOptions.map(option => ({ word: option.word, reason: option.reason })),
      ...(control.state === undefined ? {} : { statePath: control.state }),
      travelMs: listed.travelMs,
      ...(control.from === undefined ? {} : { from: control.from }),
      ...(protection === undefined ? {} : { protection }),
    }
  }),
  auto: item.withheld.flatMap(control => control.reason.kind === 'automatic' ? [{ text: control.reason.text, manual: control.reason.manual }] : []),
  position: item.position === undefined ? null : now.format(item.position.path, now.read(item.position.path) ?? item.position.value),
  withheld: item.withheld.flatMap(control => control.reason.kind === 'automatic' ? [] : [{ name: control.tagId ?? String(control.path), reason: control.reason.text }]),
})

/**
 * A demand control's setting between its ends as an option of its own
 * ("OPEN to 40 % AFW-A-CV …"), in World's words for it (demandSetting); null
 * where the value is no setting of it. It moves the equipment as its end in
 * the same direction does, within that end's declared travel (plan-final
 * I-2); what it sets going or works against, World's check on the exact
 * write says (control.validate).
 */
export const demandOption = (control: ControlView, value: number): OptionView | null => {
  const demand = control.demand
  if (demand === undefined) return null
  if (value === demand.max || value === demand.min) return control.options.find(option => option.value === value) ?? null
  // Opening moves it as its OPEN end does, closing as its SHUT end does.
  const end = control.options.find(option => option.value === (value >= demand.position ? demand.max : demand.min))
  const setting = demandSetting(demand.control, value)
  if (!setting.ok) return null
  return {
    key: `${control.path}=${String(value)}`,
    word: setting.word,
    value,
    current: Math.abs(demand.position - value) <= demand.step / 2,
    action: `${setting.word} ${control.target}`,
    confirm: 'button',
    slideOnly: false,
    consequences: [],
    opposing: [],
    heldBy: null,
    travelMs: end?.travelMs ?? null,
    isolated: control.options.find(option => option.isolated !== null)?.isolated ?? null,
    consequence: null,
  }
}

/** The option a value of a control is: one it lists, or a demand control's setting between its ends. */
export const optionOf = (control: ControlView, value: ProcessVariableValue): OptionView | undefined =>
  control.options.find(option => option.value === value) ?? (typeof value === 'number' ? demandOption(control, value) ?? undefined : undefined)

// --- Feedback ---------------------------------------------------------------

/** A command this screen sent, and what came of it. */
export interface SentCommand {
  readonly path: VariablePath
  readonly value: ProcessVariableValue
  readonly sentAtElapsedMs: number
  /** What the state read when it was sent, so a position's travel can be told. */
  readonly fromState?: ProcessVariableValue
  /** The command result: accepted, or refused with the I&C's reason; undefined until it returns. */
  readonly result?: { readonly ok: true } | { readonly ok: false; readonly reason: string }
}

export type CommandPhase =
  | { readonly kind: 'sent'; readonly text: string }
  | { readonly kind: 'refused'; readonly text: string }
  /** Moving toward its state: `fraction` of the way where the state is a position; `by` the time it should arrive, null where the model declares no travel time. */
  | { readonly kind: 'travelling'; readonly text: string; readonly fraction: number | null; readonly by: string | null }
  | { readonly kind: 'done'; readonly text: string }
  | { readonly kind: 'notFollowed'; readonly text: string }

/** Where a sent command stands: sent → accepted or refused → travelling → done or not followed (plan §4.2). */
export const commandPhase = (control: ControlView, option: OptionView, sent: SentCommand, now: OperationNow): CommandPhase => {
  const at = now.clock(sent.sentAtElapsedMs)
  if (sent.result === undefined) return { kind: 'sent', text: `${option.action}: sent ${at}` }
  if (!sent.result.ok) return { kind: 'refused', text: `Refused: ${sent.result.reason}` }
  // `option` is read from the control as it stands now, so `current` says whether the equipment has followed.
  if (control.statePath === undefined || control.form === 'pushbutton') return { kind: 'done', text: `${option.word} ${at}` }
  if (option.current) return { kind: 'done', text: `${optionState(option, control)} ${now.clock(now.elapsedMs)}` }
  const since = now.elapsedMs - sent.sentAtElapsedMs
  const reading = now.read(control.statePath)
  const goal = option.value
  const fraction = typeof reading === 'number' && typeof sent.fromState === 'number' && typeof goal === 'number' && sent.fromState !== goal
    ? Math.min(1, Math.max(0, (reading - sent.fromState) / (goal - sent.fromState)))
    : null
  if (option.travelMs === null) return { kind: 'travelling', text: `${option.action}: accepted ${at}, awaiting its state`, fraction, by: null }
  if (since <= followAllowanceMs(option.travelMs)) {
    return { kind: 'travelling', text: `${option.action}: travelling, expected by ${now.clock(sent.sentAtElapsedMs + option.travelMs)}`, fraction, by: now.clock(sent.sentAtElapsedMs + option.travelMs) }
  }
  return { kind: 'notFollowed', text: `Not followed: CMD ${option.word}, ${control.now ?? 'state unknown'} since ${at}` }
}

const optionState = (option: OptionView, control: ControlView): string =>
  control.now ?? option.word

// --- Proposals --------------------------------------------------------------

/** A cited reading's limit state as the display reads it: "0.53 MPa above LO-LO 13.8 MPa · RX TRIP", with the projected minutes to it where it heads there. */
export interface EvidenceMargin {
  readonly tagId: string
  readonly text: string
  readonly minutes: number | null
}

export interface ProposalCard {
  readonly id: string
  readonly item: string
  readonly status: ProcessPlantProposal['status'] | 'blocked'
  /** "SHUT MOV-8000A PZR block valve" */
  readonly action: string
  readonly from: string | null
  readonly to: string | null
  /** The equipment reads the proposed state already: approving it changes nothing ("Already SHUT"), never "SHUT → SHUT". */
  readonly already: string | null
  /** "AI agent · 10:02:40" */
  readonly proposer: string
  readonly proposerOrigin: 'person' | 'ai'
  readonly reason: string
  readonly procedureStep?: string
  /** "I&C allows this command now", or the I&C's refusal verbatim (QA-9: neutral, no tick). */
  readonly checked: { readonly permitted: boolean; readonly text: string }
  readonly evidence: ReadonlyArray<{ readonly tagId: string; readonly then: string; readonly now: string; readonly changed: boolean }>
  /** Some cited reading moved since it was proposed. */
  readonly changed: boolean
  /** World's ranking: the cited readings' limit states, the soonest first; never the proposer's urgency (QA-9). */
  readonly margins: ReadonlyArray<EvidenceMargin>
  readonly expected: string
  /** World's consequence line, as the proposal stored it (or its option carries it now); null where World gives none. */
  readonly consequence: string | null
  readonly consequences: ReadonlyArray<string>
  readonly opposing: ReadonlyArray<string>
  readonly reversibility: string
  readonly expires: { readonly at: string; readonly inMs: number } | null
  readonly extendable: boolean
  readonly approve: { readonly label: string; readonly confirm: 'button' | 'slide'; readonly enabled: boolean } | null
  /** How it closed: "Approved by op-1 at 10:02:58", "Expired 10:04:40, not executed". */
  readonly closed: string | null
}

/**
 * How the display names who acted. A Run records an actor by its id only
 * (its label is the id), so the display names the kind of actor, never the
 * raw id ("actor:operator"): an operator, an AI agent, or the Run itself
 * (its scenario timeline, the system).
 */
export const actorName = (actorId: string, origin?: 'person' | 'ai' | 'system'): 'operator' | 'AI agent' | 'the Run' => {
  const kind = actorId.split(':')[1]
  if (origin === 'ai' || kind === 'ai') return 'AI agent'
  if (origin === 'system' || kind === 'system' || kind === 'scenario-timeline') return 'the Run'
  return 'operator'
}

const capitalized = (words: string): string => `${words.charAt(0).toUpperCase()}${words.slice(1)}`

/** An actor in running text: "an operator", "an AI agent", "the Run". */
const anActor = (actorId: string, origin?: 'person' | 'ai' | 'system'): string => {
  const name = actorName(actorId, origin)
  return name === 'the Run' ? name : name === 'AI agent' ? 'an AI agent' : 'an operator'
}

const proposerText = (proposal: ProcessPlantProposal, now: OperationNow): string =>
  `${capitalized(actorName(proposal.proposer.actorId, proposal.proposer.origin))} · ${now.clock(proposal.proposedAtElapsedMs)}`

const closedText = (proposal: ProcessPlantProposal, now: OperationNow): string | null => {
  const closed = proposal.closed
  if (proposal.status === 'pending' || closed === undefined) return null
  const at = now.clock(closed.atElapsedMs)
  const by = closed.actorId === undefined ? '' : ` by ${anActor(closed.actorId)}`
  if (proposal.status === 'approved') return `Approved${by} at ${at}`
  if (proposal.status === 'rejected') return `Rejected${by} at ${at}${closed.reason === undefined ? '' : `: ${closed.reason}`}`
  if (proposal.status === 'expired') return `Expired ${at}, not executed`
  if (proposal.status === 'withdrawn') return `Withdrawn${by} at ${at}`
  return `Superseded at ${at}${closed.reason === undefined ? '' : `: ${closed.reason}`}`
}

/** The listed control a proposal's write is, on its item, and its option as the control reads now. */
const proposedOption = (proposal: ProcessPlantProposal, item: ListedItem, now: OperationNow): { readonly listed: ListedControl; readonly control: ControlView; readonly option: OptionView } => {
  const listed = item.offered.find(candidate => candidate.control.path === proposal.write.path)
  const control = listed === undefined ? undefined : itemControlView({ ...item, offered: [listed], withheld: [] }, now).controls[0]
  const option = control === undefined ? undefined : optionOf(control, proposal.write.value)
  if (listed === undefined || control === undefined || option === undefined) throw new Error(`proposal ${proposal.id} writes ${proposal.write.path}, which item ${item.id} does not offer`)
  return { listed, control, option }
}

/**
 * A proposal's approval card (plan §4.4, QA-9): the exact command World
 * stored, what it changes, who proposed it and why (the proposer's words,
 * quoted), what the I&C says now, how its evidence moved, what World expects
 * and ranks, and the decisions a person may take while it is pending.
 */
export const proposalCard = (
  proposal: ProcessPlantProposal,
  review: ProposalReview | null,
  item: ListedItem,
  margins: ReadonlyArray<EvidenceMargin>,
  now: OperationNow,
): ProposalCard => {
  const { listed, control, option } = proposedOption(proposal, item, now)
  // A cited reading moved where it reads otherwise as the display writes it: a change below its resolution is none.
  const evidence = (review?.evidence ?? proposal.evidence.map(cited => ({ tagId: cited.tagId, then: cited.value, now: cited.value }))).map(entry => {
    const path = proposal.evidence.find(cited => cited.tagId === entry.tagId)!.path
    const then = now.format(path, entry.then)
    const shown = now.format(path, entry.now)
    return { tagId: entry.tagId, then, now: shown, changed: then !== shown }
  })
  const changed = (review?.changed ?? false) && evidence.some(entry => entry.changed)
  const pending = proposal.status === 'pending'
  const permitted = review?.permitted ?? false
  const other = control.options.find(candidate => candidate.key !== option.key)
  const travel = option.travelMs === null ? 'no travel time is declared' : option.travelMs === 0 ? 'at once' : `within ${Math.round(option.travelMs / 1_000)} s`
  const toState = listed.control.options.find(candidate => candidate.value === option.value)?.state ?? (control.demand === undefined ? null : option.word)
  return {
    id: proposal.id,
    item: proposal.item,
    status: pending && review !== null && !review.permitted ? 'blocked' : proposal.status,
    action: option.action,
    from: control.now,
    to: toState,
    already: option.current ? `Already ${toState ?? option.word}: approving it changes nothing` : null,
    proposer: proposerText(proposal, now),
    proposerOrigin: proposal.proposer.origin,
    reason: proposal.reason,
    ...(proposal.procedureStep === undefined ? {} : { procedureStep: proposal.procedureStep }),
    checked: review === null ? { permitted: false, text: 'Not checked yet' }
      : review.permitted ? { permitted: true, text: 'I&C allows this command now' } : { permitted: false, text: review.refusal ?? 'The I&C refuses it now' },
    evidence,
    changed,
    margins: [...margins].sort((left, right) => (left.minutes ?? Infinity) - (right.minutes ?? Infinity)),
    expected: control.form === 'pushbutton' ? `${listed.control.target} pressed: ${option.consequences.length === 0 ? 'no trip follows' : option.consequences.join('; ')}`
      : `${listed.control.target} reads ${toState ?? option.word} ${travel}`,
    consequence: consequenceLine(proposal) ?? option.consequence,
    consequences: option.consequences,
    opposing: option.opposing,
    reversibility: control.protection?.role === 'block' ? 'Not reversed here: the block stands until its logic resets it'
      : control.form === 'pushbutton' ? 'Not reversed here: what it actuates latches until reset, which is not offered'
      : other === undefined ? 'No opposite command is offered' : `Reversible: ${other.action} is a new command`,
    expires: pending ? { at: now.clock(proposal.expiresAtElapsedMs), inMs: Math.max(0, proposal.expiresAtElapsedMs - now.elapsedMs) } : null,
    extendable: pending && !proposal.extended,
    approve: !pending ? null : {
      label: `${changed ? 'Approve anyway, plant changed: ' : 'Approve: '}${option.action}`,
      confirm: option.confirm,
      enabled: permitted && option.heldBy === null,
    },
    closed: closedText(proposal, now),
  }
}

/**
 * A cited reading's limit state, as the display reads it where it draws the
 * reading with its limits (a lead value's pen): its trend reading's state in
 * words, and its projected minutes to the limit it heads for; 0 past one.
 */
export const evidenceMargin = (tagId: string, reading: Pick<TrendReading, 'offScale' | 'limit'>, unit: string, resolution: number | null): EvidenceMargin | null => {
  const text = readingStateText(reading, unit, resolution)
  if (text === '') return null
  const limit = reading.limit
  return { tagId, text, minutes: limit?.kind === 'margin' ? limit.minutes : limit?.kind === 'past' ? 0 : null }
}

/**
 * The proposal an item's popover shows: its pending one, else the one that
 * closed last within the attribution time, so the person sees what became of
 * it; none otherwise.
 */
export const shownProposal = (itemId: string, proposals: ReadonlyArray<ProcessPlantProposal>, now: OperationNow): ProcessPlantProposal | undefined => {
  const own = proposals.filter(proposal => proposal.item === itemId)
  const pending = own.filter(proposal => proposal.status === 'pending').sort((left, right) => left.expiresAtElapsedMs - right.expiresAtElapsedMs)[0]
  if (pending !== undefined) return pending
  return own
    .filter(proposal => proposal.closed !== undefined && now.elapsedMs - proposal.closed.atElapsedMs <= ATTRIBUTION_MS)
    .sort((left, right) => right.closed!.atElapsedMs - left.closed!.atElapsedMs)[0]
}

export interface ProposalListEntry {
  readonly id: string
  readonly item: string
  /** The details that may draw the item on its own symbol, in the order the window tries them (reviewOpens). */
  readonly opens: ReadonlyArray<ReadonlyArray<string>>
  readonly action: string
  readonly proposer: 'AI' | 'OP'
  /** World's soonest projected minutes to a limit among its cited readings; null where none heads for one. */
  readonly minutes: number | null
  readonly text: string
}

/**
 * The details a review may open to draw a proposal's item on its own symbol,
 * the card pinned on it (HMI review of run 26c, g2): its own detail first;
 * for a device its host bundles, then the detail around the host and the line
 * the device sits on, which draws the line and the device on it where the
 * host's own detail has room only for the host.
 */
export const reviewOpens = (item: Pick<ListedItem, 'components' | 'line'>): ReadonlyArray<ReadonlyArray<string>> =>
  item.line === undefined ? [item.components] : [item.components, [...new Set([...item.components, ...item.line])]]

/** Whether a compiled display draws an item on a symbol of its own (by the ids display.compose and controls.list name it by). */
export const drawsOwnSymbol = (display: Pick<CompiledComposedDisplay, 'panels'>, itemId: string): boolean =>
  display.panels.some(panel => panel.kind === 'mimic' && panel.mimic.items.some(item =>
    (item.binding.item.kind === 'device' ? [`${item.components[0]}.${item.binding.item.device}`] : item.components).includes(itemId)))

/**
 * The window's list of pending proposals (plan §4.3, QA-10): the most
 * time-critical first, by World's projected time to a limit, then the
 * oldest; none, and the chip is absent.
 */
export const pendingProposals = (
  proposals: ReadonlyArray<ProcessPlantProposal>,
  items: ReadonlyArray<ListedItem>,
  marginsOf: (proposal: ProcessPlantProposal) => ReadonlyArray<EvidenceMargin>,
  now: OperationNow,
): ReadonlyArray<ProposalListEntry> => proposals
  .filter(proposal => proposal.status === 'pending')
  .map(proposal => {
    const item = items.find(candidate => candidate.id === proposal.item)
    if (item === undefined) throw new Error(`proposal ${proposal.id} names item ${proposal.item}, which offers no controls`)
    const card = proposalCard(proposal, null, item, marginsOf(proposal), now)
    const soonest = card.margins[0]
    return {
      proposal,
      entry: {
        id: proposal.id,
        item: proposal.item,
        opens: reviewOpens(item),
        action: card.action,
        proposer: proposal.proposer.origin === 'ai' ? 'AI' as const : 'OP' as const,
        minutes: soonest?.minutes ?? null,
        text: `${card.action} · ${soonest?.text ?? 'no cited reading heads for a limit'} · expires ${card.expires!.at}`,
      },
    }
  })
  .sort((left, right) => (left.entry.minutes ?? Infinity) - (right.entry.minutes ?? Infinity) || left.proposal.proposedAtElapsedMs - right.proposal.proposedAtElapsedMs)
  .map(({ entry }) => entry)

/** The standing actuations past the first that a setting is throttled under: "+3 more actuations". */
export const moreActuations = (count: number): string => `+${count} more actuation${count === 1 ? '' : 's'}`

// --- Badges -----------------------------------------------------------------

/** What a symbol carries for operation (plan §4.3, QA-8/QA-10): quiet when normal, never an alarm colour. */
export interface ItemBadges {
  /** A command from a person or an AI travelling: a determinate ring where the state is a position, a static one otherwise. */
  readonly progress: { readonly mode: 'determinate'; readonly value: number } | { readonly mode: 'static' } | null
  /** Who operated it, for 5 plant minutes after: OP, AI, or OP·AI for a person's approval of an AI proposal. */
  readonly attribution: { readonly text: 'OP' | 'AI' | 'OP·AI'; readonly title: string } | null
  /** A pending proposal: "AI ?" (or "OP ?" for a person's). */
  readonly proposal: { readonly text: 'AI ?' | 'OP ?'; readonly title: string } | null
  /** A protection actuation that stands holds one of its commands. */
  readonly interlock: { readonly title: string } | null
  /** Another actor's command travels on it. */
  readonly commandLocked: { readonly title: string } | null
  /** A person sets its demand between the ends a standing actuation drove it to: "Throttled under <label>" (+n more), each in full in `title`. */
  readonly throttled: { readonly text: string; readonly title: string } | null
}

const byWhom = (record: OperationRecord, proposals: ReadonlyArray<ProcessPlantProposal>): { readonly text: 'OP' | 'AI' | 'OP·AI'; readonly words: string } => {
  if (record.origin === 'ai') return { text: 'AI', words: 'by an AI agent' }
  const proposed = record.kind === 'approval' && record.proposalId !== undefined ? proposals.find(proposal => proposal.id === record.proposalId) : undefined
  return proposed?.proposer.origin === 'ai'
    ? { text: 'OP·AI', words: 'by an operator, proposed by an AI agent' }
    : { text: 'OP', words: 'by an operator' }
}

/** The badges of one item's symbol, from the operations log, the proposal book and the item's controls as they read now. */
export const itemBadges = (
  item: ListedItem,
  input: {
    readonly operations: ReadonlyArray<OperationRecord>
    readonly proposals: ReadonlyArray<ProcessPlantProposal>
    /** The commands this screen issued: one of anyone else's travelling locks the item. */
    readonly ownCommands: ReadonlySet<string>
    readonly now: OperationNow
  },
): ItemBadges => {
  const { now } = input
  const view = itemControlView(item, now)
  // Only commands from people and AI: the banner and alarms already tell what the I&C did (QA-10).
  const latest = view.controls.flatMap(control => {
    const record = input.operations.filter(candidate => candidate.path === control.path && candidate.origin !== 'system')
      .reduce<OperationRecord | undefined>((last, candidate) => last === undefined || candidate.elapsedMs >= last.elapsedMs ? candidate : last, undefined)
    if (record === undefined) return []
    const option = optionOf(control, record.value)
    return option === undefined ? [] : [{ control, option, record }]
  })
  const travelling = latest.filter(({ control, option, record }) => control.form !== 'pushbutton' && control.statePath !== undefined && !option.current
    && option.travelMs !== null && now.elapsedMs - record.elapsedMs <= followAllowanceMs(option.travelMs))
  const done = latest.filter(({ control, option, record }) => (control.form === 'pushbutton' || option.current) && now.elapsedMs - record.elapsedMs <= ATTRIBUTION_MS)
    .sort((left, right) => right.record.elapsedMs - left.record.elapsedMs)
  const moving = travelling[0]
  const reading = moving?.control.statePath === undefined ? undefined : now.read(moving.control.statePath)
  const others = travelling.filter(entry => !input.ownCommands.has(entry.record.commandId))
  const pending = input.proposals.filter(proposal => proposal.status === 'pending' && proposal.item === item.id)
  const held = view.controls.flatMap(control => control.options.flatMap(option => option.heldBy === null ? [] : [option.heldBy]))
  const last = done[0]
  // A position's travel is told against the span between its options (fully open to shut).
  const span = moving === undefined ? 0 : (() => {
    const values = moving.control.options.flatMap(option => typeof option.value === 'number' ? [option.value] : [])
    return values.length < 2 ? 0 : Math.max(...values) - Math.min(...values)
  })()
  return {
    progress: moving === undefined ? null
      : typeof reading === 'number' && typeof moving.option.value === 'number' && span > 0
        ? { mode: 'determinate', value: Math.round(100 * (1 - Math.min(1, Math.abs(moving.option.value - reading) / span))) }
        : { mode: 'static' },
    attribution: last === undefined ? null : (() => {
      const who = byWhom(last.record, input.proposals)
      return { text: who.text, title: `${last.option.action} ${who.words} at ${now.clock(last.record.elapsedMs)}` }
    })(),
    proposal: pending.length === 0 ? null : {
      text: pending.some(proposal => proposal.proposer.origin === 'ai') ? 'AI ?' : 'OP ?',
      title: pending.map(proposal => `${proposal.word} proposed by ${proposal.proposer.origin === 'ai' ? 'an AI agent' : 'an operator'} at ${now.clock(proposal.proposedAtElapsedMs)}, expires ${now.clock(proposal.expiresAtElapsedMs)}`).join('\n'),
    },
    interlock: held.length === 0 ? null : { title: [...new Set(held)].join('\n') },
    throttled: (() => {
      const lines = [...new Set(view.controls.flatMap(control => control.throttled))]
      return lines.length === 0 ? null : { text: `${lines[0]}${lines.length === 1 ? '' : ` ${moreActuations(lines.length - 1)}`}`, title: lines.join('\n') }
    })(),
    commandLocked: others.length === 0 ? null : { title: others.map(({ option, record }) => `${option.action}: ${record.origin === 'ai' ? 'an AI agent' : 'another operator'}'s command travels since ${now.clock(record.elapsedMs)}`).join('\n') },
  }
}

// --- Operations log -----------------------------------------------------------

/** One line of the operations log view (plan §4.3): what a person or an AI agent did or proposed, newest first. */
export interface OperationsLogRow {
  readonly key: string
  readonly elapsedMs: number
  readonly time: string
  /** "Operator", "AI agent". */
  readonly who: string
  readonly equipment: string
  /** "SHUT MOV-8000A PZR block valve" */
  readonly action: string
  /** How it came about: a direct command, a person's approval of a proposal, or a proposal that closed unexecuted. */
  readonly chain: string
  /** What came of it: the equipment's state now for the latest command on it, else that it was accepted. */
  readonly result: string
}

const actorWords = (origin: 'person' | 'ai' | 'system', actorId: string): string => capitalized(actorName(actorId, origin))

/**
 * The operations log as its view lists it: every command the Plant's log
 * keeps (the last 64 that people and AI agents issued, each accepted), with
 * the proposal an approval carried out, every proposal still awaiting a
 * person, and every one that closed without an approval (rejected, expired,
 * withdrawn, superseded). The latest command
 * on a control says where the equipment stands now; an earlier one only that
 * it was accepted.
 */
export const operationsLogRows = (
  log: ReadonlyArray<OperationRecord>,
  proposals: ReadonlyArray<ProcessPlantProposal>,
  items: ReadonlyArray<ListedItem>,
  now: OperationNow,
): ReadonlyArray<OperationsLogRow> => {
  const views = items.map(item => ({ item, view: itemControlView(item, now) }))
  const controlOf = (path: VariablePath) => {
    for (const { item, view } of views) {
      const control = view.controls.find(candidate => candidate.path === path)
      if (control !== undefined) return { item, control }
    }
    return undefined
  }
  const latestOn = new Map<string, OperationRecord>()
  for (const record of log) {
    const known = latestOn.get(record.path)
    if (known === undefined || record.elapsedMs >= known.elapsedMs) latestOn.set(record.path, record)
  }
  const commands = log.map((record): OperationsLogRow => {
    const found = controlOf(record.path)
    const option = found === undefined ? undefined : optionOf(found.control, record.value)
    const proposal = record.proposalId === undefined ? undefined : proposals.find(candidate => candidate.id === record.proposalId)
    const how = record.kind === 'approval'
      ? `approved${proposal === undefined ? ' proposal' : ` ${anActor(proposal.proposer.actorId, proposal.proposer.origin)}'s proposal of ${now.clock(proposal.proposedAtElapsedMs)}`}`
      : record.kind === 'ramp' ? 'ramp' : 'direct command'
    const chain = record.throttledUnder === undefined ? how : `${how} · ${record.throttledUnder.map(rule => `throttled under ${rule.label}`).join(', ')}`
    const result = (() => {
      if (found === undefined || option === undefined) return 'accepted'
      if (latestOn.get(record.path) !== record) return 'accepted; a later command followed'
      if (found.control.form === 'pushbutton' || found.control.statePath === undefined) return 'pressed'
      if (option.current) return `${found.control.now ?? option.word} now`
      if (option.travelMs === null) return 'awaiting its state'
      return now.elapsedMs - record.elapsedMs <= followAllowanceMs(option.travelMs) ? 'travelling' : `not followed: ${found.control.now ?? 'state unknown'}`
    })()
    return {
      key: record.commandId,
      elapsedMs: record.elapsedMs,
      time: now.clock(record.elapsedMs),
      who: actorWords(record.origin, record.actorId),
      equipment: found?.item.label ?? String(record.path),
      action: option?.action ?? `${String(record.value)} ${String(record.path)}`,
      chain,
      result,
    }
  })
  const waiting = proposals.filter(proposal => proposal.status === 'pending').map((proposal): OperationsLogRow => {
    const found = controlOf(proposal.write.path)
    const option = found === undefined ? undefined : optionOf(found.control, proposal.write.value)
    return {
      key: proposal.id,
      elapsedMs: proposal.proposedAtElapsedMs,
      time: now.clock(proposal.proposedAtElapsedMs),
      who: actorWords(proposal.proposer.origin, proposal.proposer.actorId),
      equipment: found?.item.label ?? proposal.item,
      action: option?.action ?? `${proposal.word} ${proposal.item}`,
      chain: 'proposed',
      result: `awaiting a person's decision, expires ${now.clock(proposal.expiresAtElapsedMs)}`,
    }
  })
  const unexecuted = proposals.filter(proposal => proposal.status !== 'pending' && proposal.status !== 'approved' && proposal.closed !== undefined).map((proposal): OperationsLogRow => {
    const found = controlOf(proposal.write.path)
    const option = found === undefined ? undefined : optionOf(found.control, proposal.write.value)
    const closed = proposal.closed!
    return {
      key: proposal.id,
      elapsedMs: closed.atElapsedMs,
      time: now.clock(closed.atElapsedMs),
      who: actorWords(proposal.proposer.origin, proposal.proposer.actorId),
      equipment: found?.item.label ?? proposal.item,
      action: option?.action ?? `${proposal.word} ${proposal.item}`,
      chain: `proposed ${now.clock(proposal.proposedAtElapsedMs)}`,
      result: `${proposal.status}${closed.actorId === undefined ? '' : ` by ${anActor(closed.actorId)}`}${closed.reason === undefined ? '' : `: ${closed.reason}`}, not executed`,
    }
  })
  return [...commands, ...waiting, ...unexecuted].sort((left, right) => right.elapsedMs - left.elapsedMs)
}
