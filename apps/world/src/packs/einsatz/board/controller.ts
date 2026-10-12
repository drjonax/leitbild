import { audienceVisibleTo, type IsoTimestamp, type ObjectId } from '../../../core/model/index.ts'
import type { EinsatzConfig } from '../config-schema.ts'
import type { PictureViewer } from '../picture.ts'
import { recommendationSchema } from '../recommendation-schema.ts'
import { boardCommandIds, callKey, closeCall, closeDropText, holdCall, recallCall, releaseText, sendFromMap, sendToTask, type CallDraft, type SendTarget } from './calls.ts'
import { intentOf, type BoardIntent } from './keymap.ts'
import { logChange, recordAlerts } from './log.ts'
import { alternativeRows, candidateIn, createRecommendations, droppedReason, proposalUnits, type Candidate } from './recommendations.ts'
import { readBoardRecords, type BoardRecords, type BoardTask, type BoardUnit } from './records.ts'
import { createBoardRules } from './rules.ts'
import { classCode, etaText, reasonText, unitWord, word } from './text.ts'
import type { BoardEffect, BoardEvent, BoardEventBody, BoardKey, BoardList, BoardView, CallResult, ClickTarget, CommitElement, Feedback, HeaderAlert, LogEntry, MapTarget, TargetPreview } from './types.ts'
import { boardUnits, unitRow } from './unit-board.ts'
import { completeSeconds, isUnserved, noRecommendationText, remainderFor, statusText, unservableText, workEntries, workRow, type WorkEntry } from './work-list.ts'

/**
 * The Einsatz Board controller: the dispatcher's work list, unit board,
 * commit element, feedback line and event log as one framework-free state
 * machine. It takes snapshots of the Run's objects, recommendation answers,
 * command results and operator input, and returns the Capability calls and
 * queries to make. Confirmations and the commit guard are states here, never
 * modals.
 *
 * - What is shown is exactly what commits: the commit element and the call
 *   it sends are built from the same draft.
 * - Recommendations are asked for the selected row and the top unserved rows
 *   and kept stable (`recommendations.ts`).
 * - The guard: when the selected row's commitment changes without operator
 *   input, commits are refused for 500 ms; navigation ends it.
 * - A call stays locked from sending until the Run shows it: a task with a
 *   call on its way, or accepted but not yet shown, takes no second commit.
 * - After an own commit from the work list, once the Run shows it, the
 *   selection moves to the most urgent unserved row, unless the operator
 *   moved on meanwhile.
 */

const guardMs = 500
const prefetchRows = 5
const freshMs = 5_000
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
interface Confirmation { readonly call: CallDraft; readonly text: string }
interface Call extends CallDraft {
  readonly callId: string
  /** The Run time of each named unit's last order as the Board knew it at sending; a newer order shows the call took effect or was overtaken. */
  readonly knownOrderMs: ReadonlyMap<string, number>
}

type Commitment =
  | { readonly kind: 'call'; readonly call: CallDraft; readonly etaText: string | null; readonly confirm: string | null }
  | { readonly kind: 'none'; readonly state: 'preparing' | 'none'; readonly text: string }

/** What a map target click would do for a unit: send (confirming a release first), nothing and why, or nothing to say. */
type MapOrder =
  | { readonly kind: 'order'; readonly unit: BoardUnit; readonly target: SendTarget; readonly call: CallDraft; readonly release: string | null }
  | { readonly kind: 'refused'; readonly text: string }
  /** The object is no Einsatz record in the picture: a click says so, a hover shows nothing. */
  | { readonly kind: 'elsewhere'; readonly text: string }

export interface BoardController {
  /** Applies one event and returns the effects the panel must perform, in order. */
  readonly dispatch: (event: BoardEvent) => ReadonlyArray<BoardEffect>
  /** The view at the last event's wall time. */
  readonly view: () => BoardView
  /**
   * What a map target click for the unit would do, for the hover: the verb,
   * target and ETA from the cached recommendation, the confirmation a release
   * asks for, or why nothing would be sent. Null when there is nothing to say.
   * It answers the surface's `previewMapTarget`.
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

export const createBoardController = (options: { readonly config: EinsatzConfig; readonly viewer: PictureViewer }): BoardController => {
  const rules = createBoardRules(options.config, options.viewer)
  const recommendations = createRecommendations(rules)

  let records: BoardRecords | null = null
  let nowMs = 0
  let wallMs = 0
  let focus: BoardList = 'work'
  let selection: Selection | null = null
  let numbering: Numbering | null = null
  let chosen: number | null = null
  let confirmation: Confirmation | null = null
  let armedMove: string | null = null
  let guardUntilMs = Number.NEGATIVE_INFINITY
  /** Sent, with no result yet. */
  const inFlight = new Map<string, Call>()
  /** Accepted, but not yet shown by the Run. */
  const unseen = new Map<string, Call>()
  /** The work-list call after whose showing the selection moves on; navigation cancels it. */
  let advanceCallId: string | null = null
  let feedback: Feedback | null = null
  let log: LogEntry[] = []
  const freshUntil = new Map<string, number>()
  let keysActive = true
  /** What Enter would have committed when keys went inactive. */
  let blurKey: string | null = null
  let soundOn = false
  let serial = 0
  let effects: BoardEffect[] = []
  /** The Board's own `select` effects the map has not echoed yet, oldest first, with the wall time each was made. */
  let echoes: Array<{ readonly objectId: string | null; readonly wallMs: number }> = []

  let entriesOf: { readonly records: BoardRecords; readonly entries: ReadonlyArray<WorkEntry> } | null = null
  const entries = (): ReadonlyArray<WorkEntry> => {
    if (records === null) return []
    if (entriesOf?.records !== records) entriesOf = { records, entries: workEntries(rules, records) }
    return entriesOf.entries
  }
  const units = (): ReadonlyArray<BoardUnit> => records === null ? [] : boardUnits(rules, records)

  const info = (text: string): void => { feedback = { text, tone: 'info' } }
  const guardActive = (): boolean => wallMs < guardUntilMs
  const armGuard = (): void => { guardUntilMs = wallMs + guardMs }

  const selectedTask = (): BoardTask | undefined => {
    if (selection?.kind !== 'task' || records === null) return undefined
    const task = records.tasks.get(selection.id)
    return task !== undefined && task.closedAtMs === undefined && rules.queues(task) ? task : undefined
  }
  const selectedUnit = (): BoardUnit | undefined => {
    if (selection?.kind !== 'unit' || records === null) return undefined
    const unit = records.units.get(selection.id)
    return unit !== undefined && rules.commands(unit) ? unit : undefined
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

  /** Operator navigation: it cancels a confirmation, an armed move and a pending auto-advance, and ends the guard. A call's lock stays. */
  const navigate = (): void => {
    confirmation = null
    armedMove = null
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
    if (rules.isReport(task)) return { kind: 'call', call: closeCall(task, 'work-list'), etaText: null, confirm: null }
    const answer = recommendations.answer(task.id)
    if (answer === undefined) {
      const failure = recommendations.failure(task.id)
      return failure === undefined
        ? { kind: 'none', state: 'preparing', text: 'Preparing…' }
        : { kind: 'none', state: 'none', text: noRecommendationText(failure) }
    }
    let sent: ReadonlyArray<Candidate> = answer.proposal.units
    if (chosen !== null) {
      const entry = numbering?.entries[chosen - 1]
      const candidate = entry === undefined ? undefined : candidateIn(answer, entry.unitId)
      if (entry === undefined) return { kind: 'none', state: 'none', text: `No alternative ${chosen}` }
      if (candidate === undefined) return { kind: 'none', state: 'none', text: `${chosen} · ${entry.label}: ${droppedReason(answer, entry.unitId)}` }
      sent = [candidate]
    }
    if (sent.length === 0) return { kind: 'none', state: 'none', text: statusText(answer) ?? 'Nothing to send' }
    const diverts = sent.filter(unit => unit.divertFrom !== undefined)
    const latest = [...sent].sort((a, b) => completeSeconds([b]) - completeSeconds([a]))[0]!
    const dropped = (unit: Candidate): string =>
      releaseText(rules, records!, { id: unit.unitId, label: unit.label }, { taskId: unit.divertFrom!.taskId, label: unit.divertFrom!.label, code: unit.divertFrom!.rank.code })
    return {
      kind: 'call',
      call: sendToTask(rules, task, sent, 'work-list'),
      etaText: etaText(latest.eta),
      confirm: diverts.length === 0 ? null : diverts.map(dropped).join(' · '),
    }
  }

  const commitment = (): Commitment => {
    const task = selectedTask()
    if (task !== undefined) return taskCommitment(task)
    const unit = selectedUnit()
    if (unit !== undefined) return { kind: 'none', state: 'none', text: `R recall · H ${unitWord(rules, unit, 'hold')} · M move` }
    return { kind: 'none', state: 'none', text: `N · most urgent of ${word(rules, 'workList')}` }
  }

  /** What Enter would commit now; null when nothing can be committed. */
  const commitmentKey = (): string | null => {
    if (confirmation !== null) return `confirm ${callKey(confirmation.call)}`
    if (busy()) return null
    const current = commitment()
    return current.kind === 'call' ? callKey(current.call) : null
  }

  const send = (call: CallDraft): void => {
    serial += 1
    const callId = `board-${serial}`
    const knownOrderMs = new Map(call.unitIds.map(id => [id, records?.units.get(id)?.lastAction?.atMs ?? Number.NEGATIVE_INFINITY]))
    inFlight.set(callId, { ...call, callId, knownOrderMs })
    if (call.origin === 'work-list') advanceCallId = callId
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
      return send(call)
    }
    if (busy()) return
    const current = commitment()
    if (current.kind === 'none') return info(current.text)
    if (guardActive()) return guardRefusal('Not sent: the list changed')
    if (current.confirm !== null) {
      confirmation = { call: current.call, text: current.confirm }
      armGuard()
      return
    }
    send(current.call)
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
    })
    if (overtaken || call.taskId === undefined) return true
    const task = current.tasks.get(call.taskId)
    if (task === undefined || task.closedAtMs !== undefined) return true
    return call.capabilityId !== boardCommandIds.taskClose && call.unitIds.every(id => current.units.get(id)!.taskId === call.taskId)
  }

  /** After an own work-list commit shows in the Run, select the most urgent unserved row, which the operator has not seen yet. */
  const tryAdvance = (): void => {
    if (advanceCallId === null || inFlight.has(advanceCallId) || unseen.has(advanceCallId)) return
    advanceCallId = null
    // The operator is in the middle of another order: the selection stays.
    if (confirmation !== null || armedMove !== null) return
    const next = entries().find(isUnserved)
    if (next === undefined) return
    focus = 'work'
    select({ kind: 'task', id: next.task.id, byOperator: false }, true)
  }

  const step = (delta: number): void => {
    const list: ReadonlyArray<Selection> = focus === 'work'
      ? entries().map(entry => ({ kind: 'task', id: entry.task.id, byOperator: true }))
      : units().map(unit => ({ kind: 'unit', id: unit.id, byOperator: true }))
    if (list.length === 0) return info(focus === 'work' ? word(rules, 'noWork') : `No ${word(rules, 'unitBoard').toLowerCase()}`)
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

  /** Switches the focused list; the unit board opens on a unit of the selected task, the work list on its first row. */
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

  const choose = (number: number): void => {
    const task = selectedTask()
    const entry = task === undefined || numbering?.taskId !== task.id ? undefined : numbering.entries[number - 1]
    if (task === undefined || entry === undefined) return info(`No alternative ${number}`)
    const reason = droppedReason(recommendations.answer(task.id)!, entry.unitId)
    if (reason !== null) return info(`${number} · ${entry.label}: ${reason}`)
    chosen = number
  }

  const confirmFirst = (): boolean => {
    if (confirmation === null) return false
    info('Confirm ⏎ or Esc first')
    return true
  }

  const unitVerb = (verb: 'recall' | 'hold' | 'move'): void => {
    if (confirmFirst()) return
    const unit = selectedUnit()
    if (unit === undefined) return info(`Select one of ${word(rules, 'unitBoard')} first`)
    if (verb === 'move') {
      armedMove = unit.id
      return info(`Click the map to move ${unit.label} · Esc cancels`)
    }
    // A second press while a call naming the unit is on its way sends nothing: the line keeps showing that call.
    const pending = [...inFlight.values()].find(call => call.unitIds.includes(unit.id))
    if (pending !== undefined) {
      feedback = callLine(pending)
      return
    }
    send(verb === 'recall' ? recallCall(unit) : holdCall(rules, unit))
  }

  const closeSelected = (): void => {
    if (confirmFirst()) return
    const task = selectedTask()
    if (task === undefined) return info(`Select one of ${word(rules, 'workList')} first`)
    const lock = lockOf(task.id)
    if (lock !== undefined) {
      feedback = callLine(lock)
      return
    }
    if (guardActive()) return guardRefusal('Not sent: the list changed')
    const call = closeCall(task, 'work-list')
    const dropped = closeDropText(rules, task)
    if (dropped === null) return send(call)
    confirmation = { call, text: dropped }
    armGuard()
  }

  const cancel = (): void => {
    if (confirmation !== null) {
      confirmation = null
      return info('Cancelled')
    }
    if (armedMove !== null) {
      armedMove = null
      return info('Move cancelled')
    }
    chosen = null
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
        return choose(intent.number)
      case 'commit': return commit()
      case 'recall': case 'hold': case 'move': return unitVerb(intent.kind)
      case 'close': return closeSelected()
      case 'cancel': return cancel()
    }
  }

  const click = (target: ClickTarget): void => {
    switch (target.kind) {
      case 'row':
        navigate()
        focus = target.list
        return select({ kind: target.list === 'work' ? 'task' : 'unit', id: target.id, byOperator: true }, true)
      case 'alternative':
        navigate()
        return choose(target.number)
      case 'commit':
        // While keys are inactive the commit element is disabled and shows no commitment.
        if (!keysActive) return
        return commit()
      case 'cancel': return cancel()
      case 'verb':
        if (confirmFirst()) return
        navigate()
        focus = target.verb === 'close' ? 'work' : 'units'
        select({ kind: target.verb === 'close' ? 'task' : 'unit', id: target.id, byOperator: true }, true)
        return target.verb === 'close' ? closeSelected() : unitVerb(target.verb)
      case 'enable-sound':
        soundOn = true
    }
  }

  /**
   * The shared selection changed. The echo of one of the Board's own `select`
   * effects is no operator input, nor is the map reporting what the Board
   * already selects; anything else is the operator's map click.
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
    select(null, false)
  }

  /** What a map target names for the unit: a task, a receiving site or the armed ground point; otherwise why it is no target. */
  const mapOrder = (unitId: string, target: MapTarget): MapOrder => {
    const refused = (text: string): MapOrder => ({ kind: 'refused', text })
    const shown = records
    const unit = shown?.units.get(unitId)
    if (shown === null || unit === undefined) return refused('Not in your picture')
    if (!rules.commands(unit)) return refused(`${unit.label} is not commanded by your roles`)
    if (!rules.ordersOnMap(unit)) return refused(`${unit.label} cannot move`)
    const order = (to: SendTarget): MapOrder => {
      const call = sendFromMap(rules, shown, unit, to)
      if (unit.taskId === undefined) return { kind: 'order', unit, target: to, call, release: null }
      const from = shown.tasks.get(unit.taskId)
      if (from === undefined) throw new Error(`${unit.id} is committed to ${unit.taskId}, which is not in the picture`)
      return { kind: 'order', unit, target: to, call, release: releaseText(rules, shown, unit, { taskId: from.id, label: from.label, code: classCode(rules, from.rank) }) }
    }
    if (target.kind === 'point') return armedMove === unit.id ? order({ point: target.point }) : refused(`M, then click the map to move ${unit.label}`)
    const task = shown.tasks.get(target.objectId)
    if (task !== undefined) {
      if (task.closedAtMs !== undefined) return refused(`${task.label} is closed`)
      if (unit.taskId === task.id) return refused(`${unit.label} already ${unitWord(rules, unit, unit.phase)} to ${task.label}`)
      const sent = [...inFlight.values(), ...unseen.values()].some(call => call.taskId === task.id && call.unitIds.includes(unit.id))
      if (sent) return refused(`${unit.label} already ${unitWord(rules, unit, 'en-route')} to ${task.label}`)
      return order({ taskId: task.id })
    }
    const other = shown.units.get(target.objectId)
    if (other === undefined) return { kind: 'elsewhere', text: `Not a target for ${unit.label}` }
    if (other.id !== unit.id && rules.typeOf(other).components.receiving !== undefined) return order({ siteId: other.id })
    return refused(`${other.label} is not a target for ${unit.label}`)
  }

  /** A free unit goes at once; a committed one waits for a confirmation in the target task's row, or its own row for a point, a site or a task outside the work list. */
  const mapTarget = (unitId: string, target: MapTarget): void => {
    if (confirmFirst()) return
    const order = mapOrder(unitId, target)
    if (order.kind !== 'order') return info(order.text)
    armedMove = null
    advanceCallId = null
    if (order.release === null) return send(order.call)
    const task = 'taskId' in order.target ? records!.tasks.get(order.target.taskId) : undefined
    const inWorkList = task !== undefined && rules.queues(task)
    focus = inWorkList ? 'work' : 'units'
    select(inWorkList ? { kind: 'task', id: task.id, byOperator: true } : { kind: 'unit', id: order.unit.id, byOperator: true }, true)
    confirmation = { call: order.call, text: order.release }
    armGuard()
  }

  const preview = (controllerId: ObjectId, target: MapTarget): TargetPreview | null => {
    const unitId: string = controllerId
    if (records === null) return null
    if (confirmation !== null) return { text: 'Confirm ⏎ or Esc first', refused: true }
    const order = mapOrder(unitId, target)
    if (order.kind === 'elsewhere') return null
    if (order.kind === 'refused') return { text: order.text, refused: true }
    // The cached recommendation for a target task gives the ETA, or the reasons the unit cannot count towards it. Whether a divert may go is the engine's to judge at the confirmation.
    const answer = 'taskId' in order.target ? recommendations.answer(order.target.taskId) : undefined
    const candidate = answer === undefined ? undefined : candidateIn(answer, unitId)
    const ineligible = answer?.ineligible.find(entry => entry.unitId === unitId)
    if (ineligible !== undefined) return { text: ineligible.reasons.join(' · '), refused: true }
    const parts = [order.call.text, candidate === undefined ? null : etaText(candidate.eta), order.release === null ? null : `confirm: ${order.release}`]
    return { text: parts.filter(part => part !== null).join(' · '), refused: false }
  }

  /** Why a snapshot dropped the selected row: its task closed, or it left the work list or the unit board. */
  const droppedText = (dropped: Selection, previous: BoardRecords | null): string => {
    if (dropped.kind === 'task') {
      const task = records?.tasks.get(dropped.id)
      const label = task?.label ?? previous?.tasks.get(dropped.id)?.label ?? dropped.id
      return task?.closedAtMs !== undefined ? `${label} closed` : `${label} left ${word(rules, 'workList').toLowerCase()}`
    }
    const label = records?.units.get(dropped.id)?.label ?? previous?.units.get(dropped.id)?.label ?? dropped.id
    return `${label} left ${word(rules, 'unitBoard').toLowerCase()}`
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
    for (const id of freshUntil.keys()) {
      const task = next.tasks.get(id)
      if (task === undefined || task.closedAtMs !== undefined) freshUntil.delete(id)
    }
    for (const [callId, call] of unseen) if (visible(call)) unseen.delete(callId)
    if (selection !== null && (selection.kind === 'task' ? selectedTask() : selectedUnit()) === undefined) {
      const cancelled = confirmation !== null ? 'confirmation cancelled' : armedMove !== null ? 'move cancelled' : null
      if (cancelled !== null) info(`${droppedText(selection, previous)} · ${cancelled}`)
      confirmation = null
      armedMove = null
      select(null, true)
    }
    tryAdvance()
  }

  const result = (callId: string, outcome: CallResult): void => {
    const call = inFlight.get(callId)
    if (call === undefined) throw new Error(`The Board made no call ${callId}`)
    inFlight.delete(callId)
    if (!outcome.ok) {
      if (advanceCallId === callId) advanceCallId = null
      feedback = { text: `✗ ${reasonText(outcome.reason)}`, tone: 'refused' }
      return
    }
    feedback = { text: `✓ ${call.text}`, tone: 'done' }
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
      case 'map-target': return mapTarget(event.controllerId, event.target)
      case 'focus': {
        if (event.active === keysActive) return
        if (!event.active) {
          blurKey = commitmentKey()
          keysActive = false
          return
        }
        keysActive = true
        // Meanwhile the commit element read "Keys inactive": a commitment that changed since is new to the operator.
        const shown = commitmentKey()
        if (shown !== null && shown !== blurKey) armGuard()
        return
      }
      case 'tick': return
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

  const commitElement = (): CommitElement => {
    const cancelText = 'Esc · Cancel'
    if (!keysActive) return { state: 'inactive', text: 'Keys inactive · click the Board', enabled: false, hint: null, cancel: null }
    const guarded = guardActive()
    const hint = guarded ? guardText() : null
    if (confirmation !== null) {
      return { state: 'confirm', text: `⏎ Confirm: ${confirmation.call.text} · ${confirmation.text}`, enabled: !guarded, hint, cancel: cancelText }
    }
    const lock = selection?.kind === 'task' ? lockOf(selection.id) : undefined
    if (lock !== undefined) return { state: 'sending', text: callLine(lock).text, enabled: false, hint: null, cancel: null }
    const current = commitment()
    const cancelable = chosen !== null || armedMove !== null ? cancelText : null
    if (current.kind === 'none') return { state: current.state, text: current.text, enabled: false, hint: null, cancel: cancelable }
    const eta = current.etaText === null ? '' : ` · ${current.etaText}`
    return { state: 'ready', text: `⏎ ${current.call.text}${eta}`, enabled: !guarded, hint, cancel: cancelable }
  }

  /** Every standing alert in the picture, after the asked rows whose recommendation says no unit could ever serve them. */
  const headerAlerts = (): ReadonlyArray<HeaderAlert> => {
    if (records === null) return []
    const unservable = entries().flatMap(entry => {
      const answer = recommendations.answer(entry.task.id)
      const message = answer === undefined ? null : unservableText(answer)
      return message === null ? [] : [{ recordId: entry.task.id, label: entry.task.label, code: 'no_unit_can_serve', message, sinceMs: entry.task.createdAtMs }]
    })
    return [...unservable, ...recordAlerts(records)]
  }

  const selectedView = (): BoardView['selected'] => {
    const task = selectedTask()
    if (task === undefined) return selectedUnit() === undefined ? null : { kind: 'unit', id: selection!.id }
    const answer = recommendations.answer(task.id)
    const entry = entries().find(item => item.task.id === task.id)!
    return {
      kind: 'task',
      id: task.id,
      proposal: answer === undefined ? [] : proposalUnits(answer),
      alternatives: answer === undefined || numbering?.taskId !== task.id ? [] : alternativeRows(answer, numbering.entries, chosen),
      ineligible: answer?.ineligible.map(item => ({ label: item.label, reasons: item.reasons })) ?? [],
      remainder: answer?.proposal.remainder ?? remainderFor(rules, task, entry.view),
    }
  }

  const view = (): BoardView => {
    const workRows = records === null ? [] : entries().map(entry => workRow(rules, records!, entry, {
      answer: recommendations.answer(entry.task.id),
      failure: recommendations.failure(entry.task.id),
      nowMs,
      fresh: (freshUntil.get(entry.task.id) ?? Number.NEGATIVE_INFINITY) > wallMs,
      selected: selection?.kind === 'task' && selection.id === entry.task.id,
    }))
    return {
      headings: { workList: word(rules, 'workList'), unitBoard: word(rules, 'unitBoard') },
      arrangement: rules.arrangement,
      focus,
      keysActive,
      sound: { on: soundOn, text: soundOn ? null : 'Sound off · click to enable' },
      alerts: headerAlerts(),
      workList: { rows: workRows, empty: workRows.some(row => !row.served) ? null : word(rules, 'noWork') },
      unitBoard: {
        rows: records === null ? [] : units().map(unit => unitRow(rules, records!, unit, {
          nowMs,
          selected: selection?.kind === 'unit' && selection.id === unit.id,
          moveArmed: armedMove === unit.id,
        })),
      },
      selected: selectedView(),
      commit: commitElement(),
      feedback,
      log,
    }
  }

  return { dispatch, view, preview, handlesKey: key => intentOf(key.key, key.shift) !== undefined }
}
