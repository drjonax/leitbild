import type { ProcessVariableValue, VariablePath } from '../../../../packs/process-plant/graph/index.ts'
import { followAllowanceMs, type ControlOption, type OfferedControl, type OpposingRule } from '../../../../packs/process-plant/operations/controls.ts'
import type { RuleStanding } from '../../../../packs/process-plant/operations/control-standing.ts'
import type { ListedControl, ListedItem } from '../../../../packs/process-plant/operations/instance-ports.ts'
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
}

export interface ControlView {
  readonly path: VariablePath
  readonly target: string
  readonly form: OfferedControl['form']
  /** The state the equipment reads now, in the options' words; null for a pushbutton, or a position between them ("35 %"). */
  readonly now: string | null
  readonly options: ReadonlyArray<OptionView>
  readonly withheldOptions: ReadonlyArray<{ readonly word: string; readonly reason: string }>
  readonly statePath?: VariablePath
  readonly travelMs: number | null
  /** The undrawn logic whose pushbutton it is, where it sits on the equipment its rules command. */
  readonly from?: string
}

export interface ItemControlView {
  readonly id: string
  readonly label: string
  readonly controls: ReadonlyArray<ControlView>
  /** Demands a controller holds, read-only: "AUTO · SG-A-LVL-NR held to 55 %". */
  readonly auto: ReadonlyArray<string>
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

const optionView = (listed: ListedControl, option: ControlOption, index: number, current: ControlOption | undefined, now: OperationNow): OptionView => {
  const { control } = listed
  const standing = listed.standing[index]
  if (standing === undefined) throw new Error(`no standing for option ${option.word} of ${control.target}`)
  const setsTripGoing = standing.consequences.some(rule => rule.state === 'armed')
  const protective = control.form === 'pushbutton' && option.consequences.length > 0
  const held = standing.heldBy
  return {
    key: optionKey(control, option),
    word: option.word,
    value: option.value,
    current: current === option,
    action: `${option.word} ${control.target}`,
    confirm: setsTripGoing || protective ? 'slide' : 'button',
    slideOnly: protective,
    consequences: standing.consequences.map(rule => `→ ${rule.action} · ${rule.label}: ${standingWords(rule, now)}`),
    opposing: standing.opposing.map(rule => `${rule.action} · ${rule.label} ${opposingWords(control, rule)}: ${standingWords(rule, now)}`),
    heldBy: held === undefined ? null
      : `${held.label} holds ${control.target} ${wordFor(control, held.value)} since ${now.clock(held.atElapsedMs)}: overriding it is not offered here`,
    isolated: standing.isolated ? `Its isolation input stands: ${control.target} stays shut whatever it is commanded` : null,
    travelMs: option.travelMs,
  }
}

/** The CONTROL section of one item, as it reads now. */
export const itemControlView = (item: ListedItem, now: OperationNow): ItemControlView => ({
  id: item.id,
  label: item.label,
  controls: item.offered.map(listed => {
    const { control } = listed
    const current = currentOption(control, now)
    return {
      path: control.path,
      target: control.target,
      form: control.form,
      now: nowWords(control, now),
      options: control.options.map((option, index) => optionView(listed, option, index, current, now)),
      withheldOptions: control.withheldOptions.map(option => ({ word: option.word, reason: option.reason })),
      ...(control.state === undefined ? {} : { statePath: control.state }),
      travelMs: listed.travelMs,
      ...(control.from === undefined ? {} : { from: control.from }),
    }
  }),
  auto: item.withheld.flatMap(control => control.reason.kind === 'automatic' ? [control.reason.text] : []),
  withheld: item.withheld.flatMap(control => control.reason.kind === 'automatic' ? [] : [{ name: control.tagId ?? String(control.path), reason: control.reason.text }]),
})

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
  const target = control.options.find(candidate => candidate.key === option.key)
  if (control.statePath === undefined || control.form === 'pushbutton' || target === undefined) return { kind: 'done', text: `${option.word} ${at}` }
  if (target.current) return { kind: 'done', text: `${optionState(option, control)} ${now.clock(now.elapsedMs)}` }
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
  /** "AI · assistant-1 · 10:02:40" */
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
  readonly consequences: ReadonlyArray<string>
  readonly opposing: ReadonlyArray<string>
  readonly reversibility: string
  readonly expires: { readonly at: string; readonly inMs: number } | null
  readonly extendable: boolean
  readonly approve: { readonly label: string; readonly confirm: 'button' | 'slide'; readonly enabled: boolean } | null
  /** How it closed: "Approved by op-1 at 10:02:58", "Expired 10:04:40, not executed". */
  readonly closed: string | null
}

const proposerText = (proposal: ProcessPlantProposal, now: OperationNow): string =>
  `${proposal.proposer.origin === 'ai' ? 'AI' : 'Operator'} · ${proposal.proposer.actorId} · ${now.clock(proposal.proposedAtElapsedMs)}`

const closedText = (proposal: ProcessPlantProposal, now: OperationNow): string | null => {
  const closed = proposal.closed
  if (proposal.status === 'pending' || closed === undefined) return null
  const at = now.clock(closed.atElapsedMs)
  const by = closed.actorId === undefined ? '' : ` by ${closed.actorId}`
  if (proposal.status === 'approved') return `Approved${by} at ${at}`
  if (proposal.status === 'rejected') return `Rejected${by} at ${at}${closed.reason === undefined ? '' : `: ${closed.reason}`}`
  if (proposal.status === 'expired') return `Expired ${at}, not executed`
  if (proposal.status === 'withdrawn') return `Withdrawn${by} at ${at}`
  return `Superseded at ${at}${closed.reason === undefined ? '' : `: ${closed.reason}`}`
}

/** The listed control and option a proposal's write is, on its item. */
const proposedOption = (proposal: ProcessPlantProposal, item: ListedItem): { readonly listed: ListedControl; readonly index: number } => {
  const listed = item.offered.find(candidate => candidate.control.path === proposal.write.path)
  const index = listed?.control.options.findIndex(option => option.value === proposal.write.value) ?? -1
  if (listed === undefined || index < 0) throw new Error(`proposal ${proposal.id} writes ${proposal.write.path}, which item ${item.id} does not offer`)
  return { listed, index }
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
  const { listed, index } = proposedOption(proposal, item)
  const control = itemControlView({ ...item, offered: [listed], withheld: [] }, now).controls[0]!
  const option = control.options[index]!
  const pending = proposal.status === 'pending'
  const permitted = review?.permitted ?? false
  const changed = review?.changed ?? false
  const other = control.options.find(candidate => candidate.key !== option.key)
  const travel = option.travelMs === null ? 'no travel time is declared' : option.travelMs === 0 ? 'at once' : `within ${Math.round(option.travelMs / 1_000)} s`
  const toState = listed.control.options[index]!.state ?? null
  return {
    id: proposal.id,
    item: proposal.item,
    status: pending && review !== null && !review.permitted ? 'blocked' : proposal.status,
    action: option.action,
    from: control.now,
    to: toState,
    proposer: proposerText(proposal, now),
    proposerOrigin: proposal.proposer.origin,
    reason: proposal.reason,
    ...(proposal.procedureStep === undefined ? {} : { procedureStep: proposal.procedureStep }),
    checked: review === null ? { permitted: false, text: 'Not checked yet' }
      : review.permitted ? { permitted: true, text: 'I&C allows this command now' } : { permitted: false, text: review.refusal ?? 'The I&C refuses it now' },
    evidence: (review?.evidence ?? proposal.evidence.map(cited => ({ tagId: cited.tagId, then: cited.value, now: cited.value }))).map(entry => {
      const path = proposal.evidence.find(cited => cited.tagId === entry.tagId)!.path
      return { tagId: entry.tagId, then: now.format(path, entry.then), now: now.format(path, entry.now), changed: entry.then !== entry.now }
    }),
    changed,
    margins: [...margins].sort((left, right) => (left.minutes ?? Infinity) - (right.minutes ?? Infinity)),
    expected: control.form === 'pushbutton' ? `${listed.control.target} pressed: ${option.consequences.length === 0 ? 'no trip follows' : option.consequences.join('; ')}`
      : `${listed.control.target} reads ${toState ?? option.word} ${travel}`,
    consequences: option.consequences,
    opposing: option.opposing,
    reversibility: control.form === 'pushbutton' ? 'Not reversed here: what it actuates latches until reset, which is not offered'
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

export interface ProposalListEntry {
  readonly id: string
  readonly item: string
  readonly action: string
  readonly proposer: 'AI' | 'OP'
  /** World's soonest projected minutes to a limit among its cited readings; null where none heads for one. */
  readonly minutes: number | null
  readonly text: string
}

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
        action: card.action,
        proposer: proposal.proposer.origin === 'ai' ? 'AI' as const : 'OP' as const,
        minutes: soonest?.minutes ?? null,
        text: `${card.action} · ${soonest?.text ?? 'no cited reading heads for a limit'} · expires ${card.expires!.at}`,
      },
    }
  })
  .sort((left, right) => (left.entry.minutes ?? Infinity) - (right.entry.minutes ?? Infinity) || left.proposal.proposedAtElapsedMs - right.proposal.proposedAtElapsedMs)
  .map(({ entry }) => entry)

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
}

const byWhom = (record: OperationRecord, proposals: ReadonlyArray<ProcessPlantProposal>): { readonly text: 'OP' | 'AI' | 'OP·AI'; readonly words: string } => {
  if (record.origin === 'ai') return { text: 'AI', words: `by AI (${record.actorId})` }
  const proposed = record.kind === 'approval' && record.proposalId !== undefined ? proposals.find(proposal => proposal.id === record.proposalId) : undefined
  return proposed?.proposer.origin === 'ai'
    ? { text: 'OP·AI', words: `by ${record.actorId}, proposed by AI (${proposed.proposer.actorId})` }
    : { text: 'OP', words: `by ${record.actorId}` }
}

/** The badges of one item's symbol, from the operations log, the proposal book and the item's controls as they read now. */
export const itemBadges = (
  item: ListedItem,
  input: {
    readonly operations: ReadonlyArray<OperationRecord>
    readonly proposals: ReadonlyArray<ProcessPlantProposal>
    /** The actor of this screen: a command of anyone else's travelling locks the item. */
    readonly viewerActorId: string | null
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
    const option = control.options.find(candidate => candidate.value === record.value)
    return option === undefined ? [] : [{ control, option, record }]
  })
  const travelling = latest.filter(({ control, option, record }) => control.form !== 'pushbutton' && control.statePath !== undefined && !option.current
    && option.travelMs !== null && now.elapsedMs - record.elapsedMs <= followAllowanceMs(option.travelMs))
  const done = latest.filter(({ control, option, record }) => (control.form === 'pushbutton' || option.current) && now.elapsedMs - record.elapsedMs <= ATTRIBUTION_MS)
    .sort((left, right) => right.record.elapsedMs - left.record.elapsedMs)
  const moving = travelling[0]
  const reading = moving?.control.statePath === undefined ? undefined : now.read(moving.control.statePath)
  const others = travelling.filter(entry => entry.record.actorId !== input.viewerActorId)
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
      title: pending.map(proposal => `${proposal.word} proposed by ${proposal.proposer.origin === 'ai' ? 'AI' : 'an operator'} (${proposal.proposer.actorId}) at ${now.clock(proposal.proposedAtElapsedMs)}, expires ${now.clock(proposal.expiresAtElapsedMs)}`).join('\n'),
    },
    interlock: held.length === 0 ? null : { title: [...new Set(held)].join('\n') },
    commandLocked: others.length === 0 ? null : { title: others.map(({ option, record }) => `${option.action}: ${record.actorId}'s command travels since ${now.clock(record.elapsedMs)}`).join('\n') },
  }
}
