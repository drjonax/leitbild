import { audienceVisibleTo, type GeoJsonPoint, type IsoTimestamp, type ObjectId } from '../../../core/model/index.ts'
import type { EinsatzConfig } from '../config-schema.ts'
import { wordFor } from '../lexicon.ts'
import { groupUnseen, type PictureViewer } from '../picture.ts'
import { recommendationSchema, type Recommendation } from '../recommendation-schema.ts'
import { boardCommandIds, callKey, chainVerbCall, closeCall, closeDropText, createdSteps, holdCall, queueCall, recallCall, releaseText, sendToTask, stepRemoveCall, undoMarks, type CallDraft, type CreatedStep, type UndoMark } from './calls.ts'
import { intentOf, type BoardIntent } from './keymap.ts'
import { logChange, recordAlerts } from './log.ts'
import { alternativeRows, candidateIn, createRecommendations, droppedReason, proposalUnits, type Candidate } from './recommendations.ts'
import { readBoardRecords, type BoardRecords, type BoardTask, type BoardUnit } from './records.ts'
import { boardGroupUnitTypes, createBoardRules, hasLoad, notOrderedText, undoRestores, type DeclaredRole } from './rules.ts'
import { dropText, holdingText, mapOrderFor, orderPreview, orderRefusal, type MapOrder } from './taps.ts'
import { boardWords, classCode, etaText, namedOnce, reasonText, word } from './text.ts'
import type { BoardEffect, BoardEvent, BoardEventBody, BoardKey, BoardList, BoardMapPrompt, BoardView, CallResult, ChoiceOption, ClickTarget, CommitElement, Feedback, HeaderAlert, LogEntry, MapTarget, TargetPreview, UnitVerb } from './types.ts'
import { contactsView, type SideLabel } from './contacts.ts'
import { boardUnits, unitRow } from './unit-board.ts'
import { completeSeconds, couldBecomeEligible, isFreeIn, isUnserved, noRecommendationText, remainderFor, statusText, unservableText, workEntries, workRow, type WorkEntry } from './work-list.ts'

/**
 * The Einsatz Board controller: the dispatcher's Calls and Assets, action
 * bar, feedback line and event log as one framework-free state machine. It
 * takes snapshots of the Run's objects, recommendation answers, command
 * results and operator input, and returns the Capability calls and queries
 * to make. Confirmations, choices and the commit guard are states here,
 * never modals.
 *
 * Touch first (A9): a tap on an own asset highlights it, a second tap clears
 * it, a tap on another switches it. With an asset highlighted, a tap on a
 * target sends it: a call (map or Calls row), a site, an enemy track (an
 * armed asset engages it), or open ground, which first asks "Move here" at
 * the point. A free asset goes at once; a busy one (a task, load or
 * job-chain steps) asks "Do now" or "Add to end". An asset row's + makes
 * the next target tap join the end of its job chain; the highlighted row's × removes a step (the active step of a
 * committed unit asks first, since it releases the call), and its verbs
 * stop, resume, clear or recall it. A send or an added step can be undone
 * for 5 s, by removing the step it created, where that gives the unit back
 * as it stood (`undoRestores`). With no asset highlighted, a tap on a call
 * selects it and the action bar offers its proposal as one button, its
 * alternatives one tap each; a proposed unit holding job-chain steps asks
 * "Do now" or "Add to end" there too, and one of a group the screen chose
 * not to see is named with its group. Keys stay as hidden desktop
 * accelerators.
 *
 * - What is shown is exactly what commits: the action bar and the call it
 *   sends are built from the same draft.
 * - Recommendations are asked for the selected row and the top unserved rows
 *   and kept stable (`recommendations.ts`).
 * - The guard: when the selected row's commitment changes without operator
 *   input, commits are refused for 500 ms; navigation ends it. A Calls row
 *   that moved in the list within that time takes no asset tapped onto it:
 *   the tap may have been aimed at the row that was there before.
 * - A call stays locked from sending until the Run shows it: a task with a
 *   call on its way, or accepted but not yet shown, takes no second commit.
 * - After an own commit from Calls, once the Run shows it, the selection
 *   moves to the most urgent unserved row, unless the operator moved on
 *   meanwhile; with none left it clears, so a served row never lingers.
 */

const guardMs = 500
const prefetchRows = 5
const freshMs = 5_000
const undoMs = 5_000
const logLimit = 200
const alternativesShown = 9
/** How long a `select` effect waits for the map to echo it; a later report of that object is the operator's. */
const echoWindowMs = 1_000

interface Selection {
  readonly kind: 'task' | 'unit'
  readonly id: string
  /** False when the Board chose it after a commit: the operator has not seen its commitment yet. */
  readonly byOperator: boolean
}
interface Numbering { readonly taskId: string; readonly entries: ReadonlyArray<{ readonly unitId: string; readonly label: string }> }
/**
 * A call waiting for the operator: a confirmation names what it drops; a
 * choice is a busy asset's options, "Do now" (`call`) or "Add to end"
 * (`queue`).
 */
interface Confirmation { readonly kind: 'confirm' | 'choice'; readonly call: CallDraft; readonly detail: string; readonly queue: CallDraft | null }
interface Call extends CallDraft {
  readonly callId: string
  /** The Run time of each named unit's last order as the Board knew it at sending; a newer order shows the call took effect or was overtaken. */
  readonly knownOrderMs: ReadonlyMap<string, number>
  /** Each named unit's step serial at sending: a step the Run shows past it shows the call took effect. */
  readonly marks: ReadonlyArray<UndoMark>
  /** Whether the call may be undone once accepted, by removing the step it creates: not a divert, nor a send that drops a step. */
  readonly undoable: boolean
  /** The asset a tap sent and let go of: a refusal highlights it again, so the operator can tap another target. */
  readonly rehighlight: string | null
}
/** A tap on open ground with an asset highlighted: the point waits for "Move here", to do now or, after +, to add to the end of the chain. */
interface PendingMove { readonly unitId: string; readonly point: GeoJsonPoint; readonly queue: boolean }
/** An accepted send or queue, undoable until `untilMs` (wall time) once the Run shows the steps it created. */
interface Undo { readonly marks: ReadonlyArray<UndoMark>; readonly steps: ReadonlyArray<CreatedStep> | null; readonly untilMs: number }

/** What a commit asks before it sends: to confirm what it drops (a divert), or Do now or Add to end (a unit holding steps). */
type Ask = Omit<Confirmation, 'call'>

type Commitment =
  | { readonly kind: 'call'; readonly call: CallDraft; readonly etaText: string | null; readonly ask: Ask | null; readonly undoable: boolean }
  | { readonly kind: 'none'; readonly state: 'preparing' | 'none'; readonly text: string }

export interface BoardController {
  /** Applies one event and returns the effects the panel must perform, in order. */
  readonly dispatch: (event: BoardEvent) => ReadonlyArray<BoardEffect>
  /** The view at the last event's wall time. */
  readonly view: () => BoardView
  /**
   * What a map target tap for the unit would do, for the hover: the verb,
   * target and ETA from the cached recommendation, what a release drops, or
   * why nothing would be sent. Null when there is nothing to say. It answers
   * the surface's `previewMapTarget`.
   */
  readonly preview: (controllerId: ObjectId, target: MapTarget) => TargetPreview | null
  /** Whether the Board handles a key: what the panel's `onKey` returns, before it dispatches the key. */
  readonly handlesKey: (key: BoardKey) => boolean
}

const operatorInput = (event: BoardEventBody): boolean => event.kind === 'key' || event.kind === 'click' || event.kind === 'selection' || event.kind === 'map-target'

/** The Run time a snapshot holds at, in ms; a timestamp that does not parse is a fault of the panel's clock, never read as 0. */
const runTimeMs = (currentTime: IsoTimestamp): number => {
  const ms = Date.parse(currentTime)
  if (!Number.isFinite(ms)) throw new Error(`The Board was given a Run time that is not a time: ${currentTime}`)
  return ms
}

const issueText = (issues: ReadonlyArray<{ readonly path: ReadonlyArray<PropertyKey>; readonly message: string }>): string =>
  issues.slice(0, 3).map(issue => `${issue.path.map(String).join('.') || 'answer'}: ${issue.message}`).join('; ')

export const createBoardController = (options: {
  readonly config: EinsatzConfig
  readonly viewer: PictureViewer
  /** The roles the Run declares, with their labels, so a unit the screen cannot order names who can; none in a Run without roles. */
  readonly declaredRoles: ReadonlyArray<DeclaredRole>
  /** The sides the Run declares, whose labels name each side's tracks on a screen holding several; none in a Run that declares none. */
  readonly sides: ReadonlyArray<SideLabel>
}): BoardController => {
  let records: BoardRecords | null = null
  const rules = createBoardRules(options.config, options.viewer, boardGroupUnitTypes(() => records))
  const recommendations = createRecommendations(rules)

  let nowMs = 0
  let wallMs = 0
  let focus: BoardList = 'work'
  let selection: Selection | null = null
  let numbering: Numbering | null = null
  let chosen: number | null = null
  let confirmation: Confirmation | null = null
  let armedMove: string | null = null
  let pendingMove: PendingMove | null = null
  /** The asset whose + was tapped: its next target tap joins the end of its chain. */
  let adding: string | null = null
  let guardUntilMs = Number.NEGATIVE_INFINITY
  /** Sent, with no result yet. */
  const inFlight = new Map<string, Call>()
  /** Accepted, but not yet shown by the Run. */
  const unseen = new Map<string, Call>()
  /** The Calls commit after whose showing the selection moves on; navigation cancels it. */
  let advanceCallId: string | null = null
  let feedback: Feedback | null = null
  /** The last accepted send or queue that may be undone. */
  let undo: Undo | null = null
  let log: LogEntry[] = []
  const freshUntil = new Map<string, number>()
  let keysActive = true
  /** What a commit would have sent when keys went inactive. */
  let blurKey: string | null = null
  let soundOn = false
  let serial = 0
  let effects: BoardEffect[] = []
  /** The Board's own `select` effects the map has not echoed yet, oldest first, with the wall time each was made. */
  let echoes: Array<{ readonly objectId: string | null; readonly wallMs: number }> = []

  /** Each Calls row's place in the list, and the wall time it last took a new place without operator input. */
  let rowPlaces = new Map<string, number>()
  const movedAtMs = new Map<string, number>()

  let entriesOf: { readonly records: BoardRecords; readonly entries: ReadonlyArray<WorkEntry> } | null = null
  const entries = (): ReadonlyArray<WorkEntry> => {
    if (records === null) return []
    if (entriesOf?.records !== records) entriesOf = { records, entries: workEntries(rules, records) }
    return entriesOf.entries
  }
  /** The roles the screen shows, by its See boxes; null in open mode. */
  let seen: ReadonlyArray<string> | null = null
  /** Assets: the units the screen commands that can move, but those of groups it chose not to see. */
  const units = (): ReadonlyArray<BoardUnit> => records === null ? [] : boardUnits(rules, records).filter(unit => !groupUnseen(unit.group, seen ?? undefined))
  /** A unit's label, naming its group when the screen chose not to see that group: Calls may still offer it, drawn nowhere else. */
  const shownLabel = (unitId: string, label: string): string => {
    const group = records?.units.get(unitId)?.group
    if (!groupUnseen(group, seen ?? undefined)) return label
    const declared = rules.config.groups.find(entry => entry.id === group)
    if (declared === undefined) throw new Error(`${unitId} names group ${group}, which the configuration does not declare`)
    return `${label} (${declared.label} hidden)`
  }
  /** A task's recommendation as this screen offers it: proposed and alternative units of a group it does not see are named with their group. */
  const answerOf = (taskId: string): Recommendation | undefined => {
    const answer = recommendations.answer(taskId)
    if (answer === undefined || seen === null) return answer
    const mark = <T extends { readonly unitId: string; readonly label: string }>(entry: T): T => ({ ...entry, label: shownLabel(entry.unitId, entry.label) })
    return { ...answer, proposal: { ...answer.proposal, units: answer.proposal.units.map(mark) }, alternatives: answer.alternatives.map(mark) }
  }

  const info = (text: string): void => { feedback = { text, tone: 'info' } }
  const guardActive = (): boolean => wallMs < guardUntilMs
  const armGuard = (): void => { guardUntilMs = wallMs + guardMs }

  const selectedTask = (): BoardTask | undefined => {
    if (selection?.kind !== 'task' || records === null) return undefined
    const task = records.tasks.get(selection.id)
    return task !== undefined && task.closedAtMs === undefined && rules.queues(task) ? task : undefined
  }
  /** The highlighted asset. */
  const selectedUnit = (): BoardUnit | undefined => {
    if (selection?.kind !== 'unit' || records === null) return undefined
    const unit = records.units.get(selection.id)
    return unit !== undefined && units().includes(unit) ? unit : undefined
  }

  /** Numbers the selected row's alternatives as first shown; later ones are appended, none is renumbered. */
  const updateNumbering = (): void => {
    const task = selectedTask()
    const answer = task === undefined ? undefined : recommendations.answer(task.id)
    if (task === undefined || answer === undefined) return
    const offered = answer.alternatives.map(unit => ({ unitId: unit.unitId, label: unit.label }))
    const kept = numbering?.taskId === task.id ? numbering.entries : []
    const numbered = new Set(kept.map(entry => entry.unitId))
    numbering = { taskId: task.id, entries: [...kept, ...offered.filter(entry => !numbered.has(entry.unitId))].slice(0, alternativesShown) }
  }

  /** Selects a row; `mirror` tells the map. Numbering and a chosen alternative belong to the selected row. */
  const select = (next: Selection | null, mirror: boolean): void => {
    const same = next !== null && selection?.kind === next.kind && selection.id === next.id
    selection = next
    chosen = null
    if (!same) numbering = null
    updateNumbering()
    if (mirror && !same) {
      const objectId = (next?.id ?? null) as ObjectId | null
      effects.push({ kind: 'select', objectId })
      echoes.push({ objectId, wallMs })
    }
  }

  /** Operator navigation: it cancels a confirmation, a move armed or waiting, and a pending auto-advance, and ends the guard. A call's lock stays. */
  const navigate = (): void => {
    confirmation = null
    armedMove = null
    pendingMove = null
    adding = null
    advanceCallId = null
    guardUntilMs = Number.NEGATIVE_INFINITY
  }

  /** The call on its way to the task, or accepted and not yet shown: it locks the task against a second commit. */
  const lockOf = (taskId: string): Call | undefined =>
    [...inFlight.values(), ...unseen.values()].find(call => call.taskId === taskId)
  const busy = (): boolean => selection?.kind === 'task' && lockOf(selection.id) !== undefined
  /** The feedback line for a call that is still on its way, or accepted and not yet shown. */
  const callLine = (call: Call): Feedback => inFlight.has(call.callId) ? { text: `${call.text}…`, tone: 'pending' } : { text: `✓ ${call.text}`, tone: 'done' }

  const taskCommitment = (task: BoardTask): Commitment => {
    if (rules.isReport(task)) return { kind: 'call', call: closeCall(rules, task, 'work-list'), etaText: null, ask: null, undoable: false }
    const answer = answerOf(task.id)
    if (answer === undefined) {
      const failure = recommendations.failure(task.id)
      return failure === undefined
        ? { kind: 'none', state: 'preparing', text: boardWords.preparing }
        : { kind: 'none', state: 'none', text: noRecommendationText(failure) }
    }
    let sent: ReadonlyArray<Candidate> = answer.proposal.units
    if (chosen !== null) {
      const entry = numbering?.entries[chosen - 1]
      const candidate = entry === undefined ? undefined : candidateIn(answer, entry.unitId)
      if (entry === undefined) return { kind: 'none', state: 'none', text: `No alternative ${chosen}` }
      if (candidate === undefined) return { kind: 'none', state: 'none', text: namedOnce(entry.label, droppedReason(answer, entry.unitId)!) }
      sent = [candidate]
    }
    if (sent.length === 0) return { kind: 'none', state: 'none', text: statusText(answer, unitId => isFreeIn(records!, unitId), couldBecomeEligible(rules, records!)) ?? boardWords.nothingToSend }
    const diverts = sent.filter(unit => unit.divertFrom !== undefined)
    // A unit holding job-chain steps drops its active one when sent now: as when it is tapped first, it asks Do now or Add to end.
    const holding = sent.filter(unit => unit.divertFrom === undefined && unit.steps !== undefined)
    const latest = [...sent].sort((a, b) => completeSeconds([b]) - completeSeconds([a]))[0]!
    const released = (unit: Candidate): string =>
      releaseText(rules, records!, { id: unit.unitId, label: unit.label }, { taskId: unit.divertFrom!.taskId, label: unit.divertFrom!.label, code: unit.divertFrom!.rank.code })
    const stopped = (unit: Candidate): string => {
      const record = records!.units.get(unit.unitId)
      if (record === undefined) return `${unit.label} holds ${unit.steps} ${unit.steps === 1 ? 'step' : 'steps'}`
      return dropText(records!, record) ?? holdingText(rules, record)
    }
    // Add to end gives one unit a step: a send of several asks only Do now.
    const queued = holding.length === 1 && sent.length === 1 ? records!.units.get(holding[0]!.unitId) : undefined
    const ask: Ask | null = diverts.length === 0 && holding.length === 0 ? null : {
      kind: holding.length === 0 ? 'confirm' : 'choice',
      detail: [...diverts.map(released), ...holding.map(stopped)].join(' · '),
      queue: queued === undefined ? null : queueCall(records!, queued, { taskId: task.id }),
    }
    return {
      kind: 'call',
      call: sendToTask(rules, task, sent, 'work-list'),
      etaText: etaText(latest.eta),
      ask,
      undoable: ask === null && sent.every(unit => {
        const record = records!.units.get(unit.unitId)
        return record !== undefined && undoRestores(record, false)
      }),
    }
  }

  const commitment = (): Commitment => {
    const task = selectedTask()
    if (task !== undefined) return taskCommitment(task)
    return { kind: 'none', state: 'none', text: `Tap a row in ${word(rules, 'workList')} or ${word(rules, 'unitBoard')}` }
  }

  /** What a commit would send now; null when nothing can be committed. */
  const commitmentKey = (): string | null => {
    if (confirmation !== null) return `confirm ${callKey(confirmation.call)}`
    if (busy()) return null
    const current = commitment()
    return current.kind === 'call' ? callKey(current.call) : null
  }

  const send = (call: CallDraft, undoable: boolean, rehighlight: string | null = null): void => {
    serial += 1
    const callId = `board-${serial}`
    const knownOrderMs = new Map(call.unitIds.map(id => [id, records?.units.get(id)?.lastAction?.atMs ?? Number.NEGATIVE_INFINITY]))
    const marks = records === null ? [] : undoMarks(records, call)
    inFlight.set(callId, { ...call, callId, knownOrderMs, marks, undoable, rehighlight })
    if (call.origin === 'work-list') advanceCallId = callId
    undo = null
    feedback = { text: `${call.text}…`, tone: 'pending' }
    effects.push({ kind: 'invoke', callId, capabilityId: call.capabilityId, input: call.input })
  }

  /** The guard's hint, naming the selected row the next commit acts on. */
  const guardText = (): string | null => {
    const label = selectedTask()?.label ?? selectedUnit()?.label
    return label === undefined ? null : `Confirm next: ${label}`
  }
  const guardRefusal = (prefix: string): void => info([prefix, guardText()].filter(part => part !== null).join(' · '))

  const commit = (): void => {
    if (confirmation !== null) {
      if (guardActive()) return guardRefusal('Not sent yet')
      const { call } = confirmation
      confirmation = null
      return send(call, false)
    }
    if (pendingMove !== null) return moveHere()
    if (busy()) return
    const current = commitment()
    if (current.kind === 'none') return info(current.text)
    if (guardActive()) return guardRefusal('Not sent: the list changed')
    if (current.ask !== null) {
      confirmation = { ...current.ask, call: current.call }
      armGuard()
      return
    }
    send(current.call, current.undoable)
  }

  /**
   * Whether the Run shows a call's effect: its units on the task, the task
   * closed, or a newer order for one of its units (the call took effect and
   * was overtaken). A unit gone from the picture can show nothing more.
   */
  const visible = (call: Call): boolean => {
    if (records === null) return false
    const current = records
    const overtaken = call.unitIds.some(id => {
      const unit = current.units.get(id)
      return unit === undefined || (unit.lastAction?.atMs ?? Number.NEGATIVE_INFINITY) > call.knownOrderMs.get(id)!
    }) || call.marks.some(mark => (current.units.get(mark.unitId)?.stepSerial ?? 0) > mark.serial)
    if (overtaken || call.taskId === undefined) return true
    const task = current.tasks.get(call.taskId)
    if (task === undefined || task.closedAtMs !== undefined) return true
    return call.capabilityId !== boardCommandIds.taskClose && call.unitIds.every(id => current.units.get(id)!.taskId === call.taskId)
  }

  /** After an own Calls commit shows in the Run, select the most urgent unserved row, which the operator has not seen yet; with none, clear the served row. */
  const tryAdvance = (): void => {
    if (advanceCallId === null || inFlight.has(advanceCallId) || unseen.has(advanceCallId)) return
    advanceCallId = null
    // The operator is in the middle of another order: the selection stays.
    if (confirmation !== null || armedMove !== null || pendingMove !== null) return
    const next = entries().find(isUnserved)
    focus = 'work'
    if (next === undefined) {
      if (selection?.kind === 'task') select(null, true)
      return
    }
    select({ kind: 'task', id: next.task.id, byOperator: false }, true)
  }

  const step = (delta: number): void => {
    const list: ReadonlyArray<Selection> = focus === 'work'
      ? entries().map(entry => ({ kind: 'task', id: entry.task.id, byOperator: true }))
      : units().map(unit => ({ kind: 'unit', id: unit.id, byOperator: true }))
    if (list.length === 0) return info(word(rules, focus === 'work' ? 'noWork' : 'noUnits'))
    const index = list.findIndex(entry => entry.kind === selection?.kind && entry.id === selection.id)
    const next = index < 0 ? (delta > 0 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, index + delta))
    select(list[next]!, true)
  }

  const urgent = (): void => {
    focus = 'work'
    const first = entries().find(isUnserved)
    if (first === undefined) return info(word(rules, 'noWork'))
    select({ kind: 'task', id: first.task.id, byOperator: true }, true)
  }

  /** Switches the focused list; Assets opens on a unit of the selected task, Calls on its first row. */
  const switchList = (): void => {
    if (focus === 'work') {
      focus = 'units'
      if (selection?.kind === 'unit') return
      const task = selectedTask()
      const related = units().find(unit => task !== undefined && unit.taskId === task.id) ?? units()[0]
      if (related !== undefined) select({ kind: 'unit', id: related.id, byOperator: true }, true)
      return
    }
    focus = 'work'
    if (selection?.kind === 'task') return
    const first = entries()[0]
    if (first !== undefined) select({ kind: 'task', id: first.task.id, byOperator: true }, true)
  }

  /** Chooses a numbered alternative of the selected call; one no longer offered says why, naming its unit once. */
  const choose = (number: number): boolean => {
    const task = selectedTask()
    const entry = task === undefined || numbering?.taskId !== task.id ? undefined : numbering.entries[number - 1]
    if (task === undefined || entry === undefined) {
      info(`No alternative ${number}`)
      return false
    }
    const reason = droppedReason(recommendations.answer(task.id)!, entry.unitId)
    if (reason !== null) {
      info(namedOnce(entry.label, reason))
      return false
    }
    chosen = number
    return true
  }

  const confirmFirst = (): boolean => {
    if (confirmation === null) return false
    info(boardWords.confirmFirst)
    return true
  }

  /** Highlights an asset, or clears the highlight when it is the highlighted one. */
  const toggleAsset = (unitId: string, mirror: boolean): void => {
    navigate()
    focus = 'units'
    if (selection?.kind === 'unit' && selection.id === unitId) return select(null, true)
    select({ kind: 'unit', id: unitId, byOperator: true }, mirror)
  }

  const unitVerb = (verb: UnitVerb): void => {
    if (confirmFirst()) return
    const unit = selectedUnit()
    if (unit === undefined) return info(`Tap one of ${word(rules, 'unitBoard')} first`)
    if (verb === 'move') {
      pendingMove = null
      armedMove = unit.id
      return info(`Tap the map to move ${unit.label}`)
    }
    if (verb === 'add') {
      pendingMove = null
      adding = unit.id
      return info(`Tap a target to add to ${unit.label}`)
    }
    // A second press while a call naming the unit is on its way sends nothing: the line keeps showing that call.
    const pending = [...inFlight.values()].find(call => call.unitIds.includes(unit.id))
    if (pending !== undefined) {
      feedback = callLine(pending)
      return
    }
    send(verb === 'recall' ? recallCall(rules, unit) : verb === 'hold' ? holdCall(rules, unit) : chainVerbCall(unit, verb), false)
  }

  /** A step's × on the highlighted asset's chain: the step leaves it, as the engine judges. */
  const removeStep = (unitId: string, stepId: string): void => {
    if (confirmFirst()) return
    const unit = selectedUnit()
    if (unit === undefined || unit.id !== unitId) return info(`Tap one of ${word(rules, 'unitBoard')} first`)
    const step = unit.orders.find(entry => entry.id === stepId)
    if (step === undefined) return info(`${unit.label} holds that step no longer`)
    navigate()
    const call = stepRemoveCall(records!, unit, step)
    // The active step of a committed unit releases its call: like a divert, it names what it drops and asks first.
    if (step.state === 'active' && step.kind === 'serve' && unit.taskId !== undefined) {
      const from = records!.tasks.get(unit.taskId)
      if (from === undefined) throw new Error(`${unit.id} is committed to ${unit.taskId}, which is not in the picture`)
      confirmation = { kind: 'confirm', call, detail: releaseText(rules, records!, unit, { taskId: from.id, label: from.label, code: classCode(rules, from.rank) }), queue: null }
      armGuard()
      return
    }
    send(call, false)
  }

  const closeSelected = (): void => {
    if (confirmFirst()) return
    const task = selectedTask()
    if (task === undefined) return info(`Tap one of ${word(rules, 'workList')} first`)
    const lock = lockOf(task.id)
    if (lock !== undefined) {
      feedback = callLine(lock)
      return
    }
    if (guardActive()) return guardRefusal('Not sent: the list changed')
    const call = closeCall(rules, task, 'work-list')
    const dropped = closeDropText(rules, task)
    if (dropped === null) return send(call, false)
    confirmation = { kind: 'confirm', call, detail: dropped, queue: null }
    armGuard()
  }

  const cancel = (): void => {
    if (confirmation !== null) {
      confirmation = null
      return info('Cancelled')
    }
    if (armedMove !== null || pendingMove !== null) {
      armedMove = null
      pendingMove = null
      return info('Move cancelled')
    }
    if (adding !== null) {
      adding = null
      return info('Cancelled')
    }
    if (chosen !== null) {
      chosen = null
      return
    }
    if (selection?.kind === 'unit') select(null, true)
  }

  const act = (intent: BoardIntent): void => {
    switch (intent.kind) {
      case 'up': case 'down':
        navigate()
        return step(intent.kind === 'up' ? -1 : 1)
      case 'urgent':
        navigate()
        return urgent()
      case 'switch':
        navigate()
        return switchList()
      case 'alternative':
        navigate()
        choose(intent.number)
        return
      case 'commit': return commit()
      case 'recall': case 'hold': case 'move': return unitVerb(intent.kind)
      case 'close': return closeSelected()
      case 'cancel': return cancel()
    }
  }

  /** What a target tap names for the unit (taps.ts). */
  const mapOrder = (unitId: string, target: MapTarget): MapOrder =>
    mapOrderFor({ rules, records, declaredRoles: options.declaredRoles, pending: [...inFlight.values(), ...unseen.values()] }, unitId, target)
  /** Why an order is refused before it is sent: a report, a call the asset serves nothing of, or one whose recommendation finds it not eligible. */
  const refusalOf = (order: Extract<MapOrder, { kind: 'order' }>): string | null =>
    orderRefusal(rules, order, recommendations.answer, taskId => records!.tasks.get(taskId)!)

  /** Adds an order to the end of its asset's chain, undoable for a few seconds where that restores it; the asset stays highlighted for its next target. */
  const queueOrder = (order: Extract<MapOrder, { kind: 'order' }>): void => {
    navigate()
    send(order.queue, undoRestores(order.unit, true))
  }

  /** Sends an order: a free asset at once, undoable for a few seconds where that restores it, and the highlight clears; a busy one asks what to do, in its target's row. */
  const placeOrder = (order: Extract<MapOrder, { kind: 'order' }>): void => {
    armedMove = null
    pendingMove = null
    adding = null
    advanceCallId = null
    if (!order.busy) {
      // The highlight lets go before the call leaves, so a refusal can highlight the asset again.
      if (selection?.kind === 'unit' && selection.id === order.unit.id) select(null, true)
      send(order.call, undoRestores(order.unit, false), order.unit.id)
      return
    }
    const task = 'taskId' in order.target ? records!.tasks.get(order.target.taskId) : undefined
    const inWorkList = task !== undefined && rules.queues(task)
    focus = inWorkList ? 'work' : 'units'
    select(inWorkList ? { kind: 'task', id: task.id, byOperator: true } : { kind: 'unit', id: order.unit.id, byOperator: true }, true)
    confirmation = { kind: 'choice', call: order.call, detail: order.release ?? holdingText(rules, order.unit), queue: order.queue }
    armGuard()
  }

  /** A target tap for a highlighted asset, on the map or in Calls. A tap on open ground asks "Move here" first, unless M armed the move. */
  const targetTap = (unitId: string, target: MapTarget): void => {
    if (confirmFirst()) return
    if (target.kind === 'object' && target.objectId === unitId) return toggleAsset(unitId, true)
    const order = mapOrder(unitId, target)
    if (order.kind !== 'order') return info(order.text)
    // What the Board can tell is refused is not sent: the tap says why, and the asset stays highlighted.
    const refusal = refusalOf(order)
    if (refusal !== null) return info(refusal)
    const queue = adding === unitId
    if (target.kind === 'point' && armedMove !== unitId) {
      navigate()
      if (selection?.kind !== 'unit' || selection.id !== unitId) select({ kind: 'unit', id: unitId, byOperator: true }, false)
      pendingMove = { unitId, point: target.point, queue }
      return
    }
    if (queue) return queueOrder(order)
    placeOrder(order)
  }

  const moveHere = (): void => {
    if (confirmFirst()) return
    const pending = pendingMove
    if (pending === null) return info('Nothing to move')
    const order = mapOrder(pending.unitId, { kind: 'point', point: pending.point })
    if (order.kind !== 'order') {
      pendingMove = null
      return info(order.text)
    }
    if (pending.queue) return queueOrder(order)
    placeOrder(order)
  }

  const option = (chosenOption: ChoiceOption): void => {
    if (confirmation?.kind !== 'choice') return info(boardWords.nothingToSend)
    switch (chosenOption) {
      case 'do-now': return commit()
      case 'add-to-end': {
        if (guardActive()) return guardRefusal('Not sent yet')
        const { queue } = confirmation
        confirmation = null
        if (queue === null) throw new Error('A busy asset\'s choice holds no "Add to end"')
        return send(queue, queue.unitIds.every(id => {
          const unit = records?.units.get(id)
          return unit !== undefined && undoRestores(unit, true)
        }))
      }
    }
  }

  /** The steps an accepted send or queue created, once the Run shows them; Undo goes when another order came between. */
  const resolveUndo = (): void => {
    if (undo === null || undo.steps !== null || records === null) return
    const created = createdSteps(records, undo.marks)
    if (created === 'gone') undo = null
    else if (created !== 'pending') undo = { ...undo, steps: created }
  }
  const undoShown = (): boolean => undo !== null && undo.steps !== null && wallMs < undo.untilMs

  /** Undo removes each step the last send or queue created, as the units' last orders named them. */
  const undoLast = (): void => {
    if (confirmFirst()) return
    if (undo === null || !undoShown()) {
      undo = null
      return info('Nothing to undo')
    }
    const steps = undo.steps!
    undo = null
    for (const created of steps) send(stepRemoveCall(records!, created.unit, created.step, boardWords.undo), false)
  }

  const click = (target: ClickTarget): void => {
    switch (target.kind) {
      case 'row': {
        // A row tap during a confirmation or a choice cancels it, then acts (§9.1); a map tap only says to confirm or cancel first.
        if (confirmation !== null) {
          confirmation = null
          info('Cancelled')
        }
        if (target.list === 'units') return toggleAsset(target.id, true)
        const asset = selectedUnit()
        if (asset !== undefined) {
          // The row may have moved under the finger: the tap was aimed at what was there before.
          if (wallMs - (movedAtMs.get(target.id) ?? Number.NEGATIVE_INFINITY) < guardMs) return info('Not sent: the list changed')
          return targetTap(asset.id, { kind: 'object', objectId: target.id as ObjectId })
        }
        navigate()
        focus = 'work'
        return select({ kind: 'task', id: target.id, byOperator: true }, true)
      }
      case 'alternative':
        // One tap sends the alternative; a divert asks to confirm. Like the big button, it waits out a guard.
        if (guardActive()) return guardRefusal('Not sent: the list changed')
        navigate()
        if (choose(target.number)) commit()
        return
      case 'commit': return commit()
      case 'option': return option(target.option)
      case 'move-here': return moveHere()
      case 'undo': return undoLast()
      case 'cancel': return cancel()
      case 'remove-step': return removeStep(target.unitId, target.stepId)
      case 'verb':
        if (confirmFirst()) return
        // A second + on the asset that waits for its target lets the + go.
        if (target.verb === 'add' && adding === target.id) {
          adding = null
          return info('Cancelled')
        }
        navigate()
        if (target.verb === 'close') {
          focus = 'work'
          select({ kind: 'task', id: target.id, byOperator: true }, true)
          return closeSelected()
        }
        focus = 'units'
        select({ kind: 'unit', id: target.id, byOperator: true }, true)
        return unitVerb(target.verb)
      case 'enable-sound':
        soundOn = true
    }
  }

  /**
   * The shared selection changed. The echo of one of the Board's own `select`
   * effects is no operator input, nor is the map reporting what the Board
   * already selects; anything else is the operator's tap on the map: an own
   * asset highlights it, a call selects it, a unit the screen cannot order
   * says why, and a receiving site says to tap an asset first.
   */
  const mapSelect = (objectId: string | null): void => {
    echoes = echoes.filter(echo => wallMs - echo.wallMs <= echoWindowMs)
    const echoed = echoes.findIndex(echo => echo.objectId === objectId)
    if (echoed >= 0) {
      echoes = echoes.slice(echoed + 1)
      return
    }
    echoes = []
    if (objectId === (selection?.id ?? null)) return
    if (confirmFirst()) return
    navigate()
    const unit = objectId === null ? undefined : records?.units.get(objectId)
    const task = objectId === null ? undefined : records?.tasks.get(objectId)
    if (unit !== undefined && units().includes(unit)) {
      focus = 'units'
      return select({ kind: 'unit', id: unit.id, byOperator: true }, false)
    }
    if (task !== undefined && task.closedAtMs === undefined && rules.queues(task)) {
      focus = 'work'
      return select({ kind: 'task', id: task.id, byOperator: true }, false)
    }
    // A unit that does not move is a site: a target for an asset, never one to order.
    if (unit !== undefined && rules.typeOf(unit).components.mobility === undefined) {
      info(`Tap one of ${word(rules, 'unitBoard')} first, then ${unit.label}`)
      return select(null, true)
    }
    if (unit !== undefined && rules.typeOf(unit).components.mobility !== undefined) {
      info(notOrderedText(rules, options.declaredRoles, unit))
      return select(null, true)
    }
    select(null, false)
  }

  const preview = (controllerId: ObjectId, target: MapTarget): TargetPreview | null => {
    const unitId: string = controllerId
    if (records === null) return null
    if (confirmation !== null) return { text: boardWords.confirmFirst, refused: true }
    if (target.kind === 'object' && target.objectId === unitId) return null
    const order = mapOrder(unitId, target)
    if (order.kind === 'elsewhere') return null
    if (order.kind === 'refused') return { text: order.text, refused: true }
    // After +, the tap adds the target to the end of the chain, which drops nothing.
    const shown = adding === unitId ? { ...order, call: order.queue, release: null } : order
    return orderPreview(shown, 'taskId' in order.target ? recommendations.answer(order.target.taskId) : undefined, refusalOf(order))
  }

  /** Why a snapshot dropped the selected row: its task closed, or it left Calls or Assets. */
  const droppedText = (dropped: Selection, previous: BoardRecords | null): string => {
    if (dropped.kind === 'task') {
      const task = records?.tasks.get(dropped.id)
      const label = task?.label ?? previous?.tasks.get(dropped.id)?.label ?? dropped.id
      return task?.closedAtMs !== undefined ? `${label} closed` : `${label} left ${word(rules, 'workList')}`
    }
    const label = records?.units.get(dropped.id)?.label ?? previous?.units.get(dropped.id)?.label ?? dropped.id
    return `${label} left ${word(rules, 'unitBoard')}`
  }

  const snapshot = (objects: Parameters<typeof readBoardRecords>[0], at: number): void => {
    const all = readBoardRecords(objects)
    const next: BoardRecords = {
      units: new Map([...all.units].filter(([, unit]) => rules.inPicture(unit))),
      tasks: new Map([...all.tasks].filter(([, task]) => rules.inPicture(task))),
      tracks: new Map([...all.tracks].filter(([, track]) => audienceVisibleTo(track.audience, rules.viewer.sees))),
    }
    nowMs = at
    const previous = records
    if (previous !== null) {
      const change = logChange(rules, previous, next)
      log = [...[...change.entries].reverse(), ...log].slice(0, logLimit)
      for (const id of change.newTasks) freshUntil.set(id, wallMs + freshMs)
      const queuedWork = change.newWork.some(id => {
        const task = next.tasks.get(id)
        return task !== undefined && task.closedAtMs === undefined && rules.queues(task)
      })
      if (queuedWork && soundOn) effects.push({ kind: 'sound', tone: 'new-work' })
    }
    records = next
    // Rows that took a new place, or are new, since the last snapshot; the first one sets the places.
    const places = new Map(entries().map((entry, index) => [entry.task.id, index]))
    if (previous !== null) for (const [id, place] of places) if (rowPlaces.get(id) !== place) movedAtMs.set(id, wallMs)
    for (const id of movedAtMs.keys()) if (!places.has(id)) movedAtMs.delete(id)
    rowPlaces = places
    for (const id of freshUntil.keys()) {
      const task = next.tasks.get(id)
      if (task === undefined || task.closedAtMs !== undefined) freshUntil.delete(id)
    }
    for (const [callId, call] of unseen) if (visible(call)) unseen.delete(callId)
    resolveUndo()
    dropStale(previous)
    tryAdvance()
  }

  /** A selected row the records or the See boxes no longer show lets go, cancelling what waited on it. */
  const dropStale = (previous: BoardRecords | null): void => {
    if (selection === null || (selection.kind === 'task' ? selectedTask() : selectedUnit()) !== undefined) return
    const cancelled = confirmation !== null ? 'confirmation cancelled' : armedMove !== null || pendingMove !== null ? 'move cancelled' : adding !== null ? 'cancelled' : null
    if (cancelled !== null) info(`${droppedText(selection, previous)} · ${cancelled}`)
    confirmation = null
    armedMove = null
    pendingMove = null
    adding = null
    select(null, true)
  }

  const result = (callId: string, outcome: CallResult): void => {
    const call = inFlight.get(callId)
    if (call === undefined) throw new Error(`The Board made no call ${callId}`)
    inFlight.delete(callId)
    if (!outcome.ok) {
      if (advanceCallId === callId) advanceCallId = null
      feedback = { text: `✗ ${reasonText(outcome.reason)}`, tone: 'refused' }
      // The asset a tap let go of is highlighted again, unless the operator has picked something since.
      const asset = call.rehighlight === null ? undefined : records?.units.get(call.rehighlight)
      if (selection === null && asset !== undefined && units().includes(asset)) {
        focus = 'units'
        select({ kind: 'unit', id: asset.id, byOperator: true }, true)
      }
      return
    }
    feedback = { text: `✓ ${call.text}`, tone: 'done' }
    if (call.undoable) {
      undo = { marks: call.marks, steps: null, untilMs: wallMs + undoMs }
      resolveUndo()
    }
    if (!visible(call)) unseen.set(callId, call)
    tryAdvance()
  }

  const recommendation = (taskId: string, key: string, answer: unknown): void => {
    const parsed = recommendationSchema.safeParse(answer)
    if (!parsed.success) return recommendations.fail(nowMs, taskId, key, `the answer does not parse (${issueText(parsed.error.issues)})`)
    if (parsed.data.taskId !== taskId) return recommendations.fail(nowMs, taskId, key, `the answer is for ${parsed.data.taskId}`)
    if (records !== null) recommendations.receive(records, nowMs, taskId, key, parsed.data)
  }

  const handle = (event: BoardEvent): void => {
    switch (event.kind) {
      case 'snapshot': return snapshot(event.objects, runTimeMs(event.currentTime))
      case 'recommendation': return recommendation(event.taskId, event.key, event.answer)
      case 'recommendation-failed': return recommendations.fail(nowMs, event.taskId, event.key, event.reason)
      case 'result': return result(event.callId, event.result)
      case 'key': {
        if (!keysActive) return
        const intent = intentOf(event.key, event.shift)
        if (intent !== undefined) act(intent)
        return
      }
      case 'click': return click(event.target)
      case 'selection': return mapSelect(event.objectId)
      case 'map-target': return targetTap(event.controllerId, event.target)
      case 'focus': {
        if (event.active === keysActive) return
        if (!event.active) {
          blurKey = commitmentKey()
          keysActive = false
          return
        }
        keysActive = true
        // Meanwhile keys could not reach the Board: a commitment that changed since is new to the operator.
        const shown = commitmentKey()
        if (shown !== null && shown !== blurKey) armGuard()
        return
      }
      case 'tick':
        if (undo !== null && wallMs >= undo.untilMs) undo = null
        return
      case 'seen':
        seen = event.roleIds
        return dropStale(records)
    }
  }

  /** The selected row and the top unserved rows want a recommendation. */
  const wanted = (): ReadonlySet<string> => new Set([
    ...(selectedTask() === undefined ? [] : [selectedTask()!.id]),
    ...entries().filter(isUnserved).slice(0, prefetchRows).map(entry => entry.task.id),
  ])

  const dispatch = (event: BoardEvent): ReadonlyArray<BoardEffect> => {
    effects = []
    wallMs = event.wallMs
    const before = commitmentKey()
    handle(event)
    if (records !== null) effects.push(...recommendations.sync(records, nowMs, wanted()))
    updateNumbering()
    if (!operatorInput(event)) {
      const after = commitmentKey()
      if (after !== null && after !== before && (before !== null || selection?.byOperator === false)) armGuard()
    }
    return effects
  }

  /**
   * The highlighted asset's verbs: Stop (the type's word for holding in
   * place), which pauses any living unit, or Resume while it is paused;
   * Clear while it holds steps and carries no load, whose delivery the
   * engine keeps; and recall.
   */
  const assetVerbs = (unit: BoardUnit): CommitElement['verbs'] => {
    if (unit.integrity === 'destroyed') return [{ verb: 'recall', label: word(rules, 'recall'), id: unit.id }]
    const pause = unit.paused === true
      ? { verb: 'resume' as const, label: boardWords.resume, id: unit.id }
      : { verb: 'hold' as const, label: wordFor(rules.config.lexicon, 'hold', rules.typeOf(unit).lexicon), id: unit.id }
    return [
      pause,
      ...(unit.orders.length > 0 && !hasLoad(unit) ? [{ verb: 'clear' as const, label: boardWords.clear, id: unit.id }] : []),
      { verb: 'recall', label: word(rules, 'recall'), id: unit.id },
    ]
  }

  const commitElement = (): CommitElement => {
    const bar = (fields: Partial<CommitElement> & Pick<CommitElement, 'state' | 'text'>): CommitElement =>
      ({ detail: null, button: null, options: [], verbs: [], enabled: false, hint: null, cancel: null, ...fields })
    const guarded = guardActive()
    const hint = guarded ? guardText() : null
    if (confirmation !== null) {
      return confirmation.kind === 'confirm'
        ? bar({ state: 'confirm', text: confirmation.call.short, detail: confirmation.detail, button: boardWords.confirm, enabled: !guarded, hint, cancel: boardWords.cancel })
        : bar({
          state: 'choice',
          text: confirmation.call.short,
          detail: confirmation.detail,
          options: [{ option: 'do-now', label: boardWords.doNow }, ...(confirmation.queue === null ? [] : [{ option: 'add-to-end' as const, label: boardWords.addToEnd }])],
          enabled: !guarded,
          hint,
          cancel: boardWords.cancel,
        })
    }
    if (pendingMove !== null) {
      const prompt = mapPromptOf(pendingMove)
      return prompt === null ? bar({ state: 'none', text: boardWords.nothingToSend }) : bar({ state: 'move', text: prompt.label, button: prompt.label, enabled: true, cancel: boardWords.cancel })
    }
    const asset = selectedUnit()
    if (asset !== undefined) {
      const text = armedMove === asset.id
        ? `Tap the map to move ${asset.label}`
        : adding === asset.id ? `${boardWords.addToEnd}: tap a call, a site or the map for ${asset.label}` : `${asset.label} · tap a call, a site or the map`
      return bar({ state: 'asset', text, verbs: assetVerbs(asset), enabled: true, cancel: boardWords.cancel })
    }
    const task = selectedTask()
    const lock = task === undefined ? undefined : lockOf(task.id)
    if (lock !== undefined) return bar({ state: 'sending', text: callLine(lock).text })
    const current = commitment()
    const closeVerb: CommitElement['verbs'] = task === undefined || rules.isReport(task) ? [] : [{ verb: 'close', label: word(rules, 'close'), id: task.id }]
    const cancelable = chosen !== null || armedMove !== null ? boardWords.cancel : null
    if (current.kind === 'none') return bar({ state: current.state, text: current.text, verbs: closeVerb, cancel: cancelable })
    const text = `${current.call.text}${current.etaText === null ? '' : ` · ${current.etaText}`}`
    return bar({ state: 'ready', text, button: text, verbs: closeVerb, enabled: !guarded, hint, cancel: cancelable })
  }

  /** The "Move here" prompt for a waiting move, while its asset is still in Assets. */
  const mapPromptOf = (pending: PendingMove): BoardMapPrompt | null => {
    const unit = records?.units.get(pending.unitId)
    if (unit === undefined || !units().includes(unit)) return null
    const label = `${word(rules, 'move')} ${unit.label} here`
    return { unitId: unit.id, point: pending.point, label: pending.queue ? `${boardWords.addToEnd}: ${label}` : label }
  }

  /** Every standing alert in the picture, after the asked rows whose recommendation says no unit could ever serve them. */
  const headerAlerts = (): ReadonlyArray<HeaderAlert> => {
    if (records === null) return []
    const couldServe = couldBecomeEligible(rules, records)
    const unservable = entries().flatMap(entry => {
      const answer = recommendations.answer(entry.task.id)
      const message = answer === undefined ? null : unservableText(answer, couldServe)
      return message === null ? [] : [{ recordId: entry.task.id, label: entry.task.label, code: 'no_unit_can_serve', message, sinceMs: entry.task.createdAtMs }]
    })
    return [...unservable, ...recordAlerts(records)]
  }

  const selectedView = (): BoardView['selected'] => {
    const task = selectedTask()
    if (task === undefined) return selectedUnit() === undefined ? null : { kind: 'unit', id: selection!.id }
    const answer = answerOf(task.id)
    const entry = entries().find(item => item.task.id === task.id)!
    const remainder = answer?.proposal.remainder ?? remainderFor(rules, task, entry.view)
    return {
      kind: 'task',
      id: task.id,
      proposal: answer === undefined ? [] : proposalUnits(answer),
      // Only units still offered are shown; a dropped one keeps its number for the digit keys.
      alternatives: answer === undefined || numbering?.taskId !== task.id ? [] : alternativeRows(answer, numbering.entries, chosen).map(row => ({ ...row, label: shownLabel(row.unitId, row.label) })),
      ineligible: answer?.ineligible.map(item => item.reasons.map(reason => namedOnce(item.label, reason)).join(' · ')) ?? [],
      remainder,
      remainderText: remainder.length === 0 ? null : `${boardWords.remainder} ${remainder.join(', ')}`,
    }
  }

  const view = (): BoardView => {
    const workRows = records === null ? [] : entries().map(entry => workRow(rules, records!, entry, {
      answer: answerOf(entry.task.id),
      failure: recommendations.failure(entry.task.id),
      nowMs,
      fresh: (freshUntil.get(entry.task.id) ?? Number.NEGATIVE_INFINITY) > wallMs,
      selected: selection?.kind === 'task' && selection.id === entry.task.id,
    }))
    const unitRows = records === null ? [] : units().map(unit => unitRow(rules, records!, unit, {
      nowMs,
      selected: selection?.kind === 'unit' && selection.id === unit.id,
      moveArmed: armedMove === unit.id,
      adding: adding === unit.id,
    }))
    return {
      headings: { workList: word(rules, 'workList'), unitBoard: word(rules, 'unitBoard'), alerts: boardWords.alerts, log: boardWords.log },
      arrangement: rules.arrangement,
      focus,
      keysActive,
      sound: { on: soundOn, text: soundOn ? boardWords.soundOn : boardWords.soundOff },
      alerts: headerAlerts(),
      workList: { rows: workRows, empty: workRows.some(row => !row.served) ? null : word(rules, 'noWork') },
      unitBoard: { rows: unitRows, empty: unitRows.length === 0 ? word(rules, 'noUnits') : null },
      contacts: rules.arrangement.contacts && records !== null ? contactsView(rules, records, nowMs, options.sides) : null,
      selected: selectedView(),
      commit: commitElement(),
      feedback,
      undo: undoShown() ? boardWords.undo : null,
      mapPrompt: pendingMove === null ? null : mapPromptOf(pendingMove),
      log,
    }
  }

  return { dispatch, view, preview, handlesKey: key => intentOf(key.key, key.shift) !== undefined }
}
