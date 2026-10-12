import type { IsoTimestamp, ObjectId, OperationalObject } from '../../../core/model/index.ts'
import type { PackMapTarget, PackTargetPreview } from '../../../core/packs/protocol.ts'
import type { PanelKey } from '../../../ui/keys/panel-key-router.ts'
import type { EinsatzCommandId } from '../capabilities.ts'

/**
 * The Board controller's contract. The panel feeds it events, each stamped
 * with the browser's wall-clock time, performs the effects it returns and
 * renders its view. The controller never reads a clock, the DOM or the
 * network itself, so Bun tests drive it exactly as the panel does.
 *
 * The panel is a World surface panel (`SurfacePanelProps` in
 * ui/surface-panel-interaction.ts) whose contribution declares
 * `mapTargets: true` and `keymap: true`. Its obligations, prop by prop:
 * - One controller per perspective: on a role-set switch, which starts a new
 *   perspective epoch, the panel creates a new controller for the new viewer
 *   and drops every result, answer and event still meant for the old one. A
 *   controller throws on a result for a call it did not make.
 * - `objects` and `currentTime()`: `snapshot` on every change of the screen's
 *   objects (its role's view of the Run), with `currentTime()` as it reads
 *   then (it stands still while the Run is paused). Before the Run clock is
 *   known (`currentTime()` undefined) the panel feeds no snapshot.
 * - `recommendation` with the query's raw answer, unparsed: the controller
 *   validates it, and an answer that does not parse shows on its row as
 *   "No recommendation: …". A failed query is `recommendation-failed`.
 * - `result` for every `invoke`, matched by call id; a transport failure is a
 *   refusal with its reason.
 * - `connectInteraction({ onKey, onMapTarget, previewMapTarget })` on mount:
 *   `onKey(key)` returns `handlesKey(key)` and, when true, dispatches `key`
 *   with the `PanelKey` as given (the router has already swallowed repeats);
 *   `onMapTarget(controllerId, target)` dispatches `map-target` as given;
 *   `previewMapTarget` is `preview`.
 * - `selectedObjectId`: `selection` on every change of the prop, echoes of
 *   the Board's own `select` effects included; the controller tells those
 *   apart from the operator's map clicks. A `select` effect goes to
 *   `onSelectObject`.
 * - `keysActive`: `focus` whenever it changes; `tick` on a timer (a few times
 *   a second) so guards and flashes expire.
 *
 * The Pack's `targeting.isController(object, context)` is `ordersOnMap`
 * (picture.ts) for the screen's viewer: an Einsatz unit record it commands
 * whose type has `mobility`. A receiving site has none, so with a unit
 * selected a click on a site reaches `onMapTarget` as that unit's target
 * instead of selecting the site.
 */

export type BoardList = 'work' | 'units'

/**
 * What a map click names for the selected unit, as the World surface hands
 * it over: an object, or a point on open ground. The Board decides whether an
 * object is a task, a receiving site or no target at all.
 */
export type MapTarget = PackMapTarget

/** A hover preview of a map target click: verb, target and ETA, or why nothing would be sent. */
export type TargetPreview = PackTargetPreview

/** A key the World key router delivers: `KeyboardEvent.key` and `code`, and Shift. */
export type BoardKey = PanelKey

/** What a pointer click hit on the Board. */
export type ClickTarget =
  | { readonly kind: 'row'; readonly list: BoardList; readonly id: string }
  | { readonly kind: 'alternative'; readonly number: number }
  /** The one commit element: dispatch, or confirm a pending confirmation. */
  | { readonly kind: 'commit' }
  | { readonly kind: 'cancel' }
  /** A verb button on a row: recall, hold or move on a unit row; close on a task row. */
  | { readonly kind: 'verb'; readonly verb: 'recall' | 'hold' | 'move' | 'close'; readonly id: string }
  | { readonly kind: 'enable-sound' }

/** A command's outcome as the Run answered this screen; a transport failure is a refusal with its reason. */
export type CallResult = { readonly ok: true } | { readonly ok: false; readonly reason: string }

export type BoardEventBody =
  /** The Run's objects as this screen's role sees them, and the Run time `currentTime()` gives (frozen while paused). */
  | { readonly kind: 'snapshot'; readonly objects: ReadonlyArray<OperationalObject>; readonly currentTime: IsoTimestamp }
  /** A `world.einsatz.recommend` answer for a `recommend` effect, with that effect's key, as received: the controller validates it. */
  | { readonly kind: 'recommendation'; readonly taskId: string; readonly key: string; readonly answer: unknown }
  | { readonly kind: 'recommendation-failed'; readonly taskId: string; readonly key: string; readonly reason: string }
  /** The result of an `invoke` effect, by its call id. */
  | { readonly kind: 'result'; readonly callId: string; readonly result: CallResult }
  /** A key the World key router delivered to `onKey` and `handlesKey` accepted; never a repeat, which the router swallows. */
  | ({ readonly kind: 'key' } & BoardKey)
  | { readonly kind: 'click'; readonly target: ClickTarget }
  /** The selection shared with the map changed (`selectedObjectId`): an operator's map click, or the echo of the Board's own `select`. */
  | { readonly kind: 'selection'; readonly objectId: ObjectId | null }
  /** The map's target click for a controller (`onMapTarget`). */
  | { readonly kind: 'map-target'; readonly controllerId: ObjectId; readonly target: MapTarget }
  /** The World frame gained or lost keyboard focus. */
  | { readonly kind: 'focus'; readonly active: boolean }
  /** Wall time passed: guards expire and fresh rows stop flashing. */
  | { readonly kind: 'tick' }

export type BoardEvent = BoardEventBody & { readonly wallMs: number }

export type BoardEffect =
  /** Invoke an Einsatz command through the run-scoped World invoke, then feed back `result` with this call id. */
  | { readonly kind: 'invoke'; readonly callId: string; readonly capabilityId: EinsatzCommandId; readonly input: unknown }
  /** Query `world.einsatz.recommend` for the task, then feed back `recommendation` or `recommendation-failed` with this key. */
  | { readonly kind: 'recommend'; readonly taskId: string; readonly key: string }
  /** Mirror the Board's selection on the map (`onSelectObject`). */
  | { readonly kind: 'select'; readonly objectId: ObjectId | null }
  | { readonly kind: 'sound'; readonly tone: 'new-work' }

export interface WorkRow {
  readonly id: string
  readonly label: string
  /** The task template's label and icon. */
  readonly noun: string
  readonly icon: string
  /** The rank's load-class code. */
  readonly code: string
  /** On an unserved row whose need differs from its rank: "needs P3×1". */
  readonly needText: string | null
  readonly served: boolean
  readonly ageText: string
  /** "1 en route · needs 2 more", with other roles' parts read-only. */
  readonly coverageText: string
  /** The shown proposal and its complete arrival: "A3 + A5 ≈4:20". */
  readonly etaText: string | null
  /** A divert proposal, "No free unit · 4 committed", "No unit can serve: needs …" or "No recommendation: …". */
  readonly statusText: string | null
  readonly alerts: ReadonlyArray<string>
  /** Flashes for a few seconds after the row appeared. */
  readonly fresh: boolean
  readonly selected: boolean
}

export interface AlternativeRow {
  /** Stable while the row stays selected; a dropped candidate keeps its number. */
  readonly number: number
  readonly unitId: string
  readonly label: string
  readonly etaText: string | null
  /** "divert from C-9 (P3)" for a divert candidate. */
  readonly divertText: string | null
  /** Why a numbered candidate dropped out; its digit then explains instead of choosing. */
  readonly dropped: string | null
  readonly chosen: boolean
}

export interface ProposalUnit {
  readonly unitId: string
  readonly label: string
  readonly etaText: string
  readonly divertText: string | null
}

export interface SelectedTask {
  readonly kind: 'task'
  readonly id: string
  /** The shown proposal's units, what Enter sends unless an alternative is chosen. */
  readonly proposal: ReadonlyArray<ProposalUnit>
  readonly alternatives: ReadonlyArray<AlternativeRow>
  readonly ineligible: ReadonlyArray<{ readonly label: string; readonly reasons: ReadonlyArray<string> }>
  /** What the task still needs after the shown proposal, in configuration words. */
  readonly remainder: ReadonlyArray<string>
}

export interface UnitRow {
  readonly id: string
  readonly label: string
  readonly typeLabel: string
  readonly icon: string
  readonly phaseText: string
  /** Time in the current phase. */
  readonly phaseAgeText: string
  readonly taskText: string | null
  /** Time still needed on the current leg. */
  readonly etaText: string | null
  readonly loadText: string | null
  /** At most two properties the type shows on the board. */
  readonly properties: ReadonlyArray<{ readonly label: string; readonly value: string }>
  readonly integrityText: string | null
  readonly alerts: ReadonlyArray<string>
  readonly free: boolean
  readonly selected: boolean
  /** Move is armed for this unit: the next map click moves it. */
  readonly moveArmed: boolean
}

/**
 * The one commit element: its text is both the Enter hint and the button
 * label, and exactly what a commit sends. `enabled` is false while a guard
 * runs, a call is on its way, a recommendation is still being prepared or
 * keys are inactive.
 */
export interface CommitElement {
  readonly state: 'ready' | 'confirm' | 'preparing' | 'sending' | 'inactive' | 'none'
  readonly text: string
  readonly enabled: boolean
  /** Why it is disabled for now: "Confirm next: C-14" during a guard. */
  readonly hint: string | null
  /** The cancel control's label while there is something to cancel. */
  readonly cancel: string | null
}

/**
 * A standing alert in the header strip: every alert a record in the picture
 * raises, and "no unit can serve" for each row whose recommendation says so.
 * Only rows asked for a recommendation (the selected row and the top
 * unserved rows) can raise the latter.
 */
export interface HeaderAlert {
  readonly recordId: string
  readonly label: string
  readonly code: string
  readonly message: string
  readonly sinceMs: number
}

export interface LogEntry {
  readonly atMs: number
  readonly recordId: string
  readonly text: string
}

export interface Feedback {
  readonly text: string
  readonly tone: 'pending' | 'done' | 'refused' | 'info'
}

/**
 * Derived from the declarations: roles with a queue lead with the work list;
 * roles commanding only sensing or firing units lead with the map; mixed
 * roles show both. The Contacts list joins once tracks give it rows (T5).
 */
export interface Arrangement {
  readonly lead: 'work-list' | 'map'
  readonly workList: boolean
  readonly unitBoard: boolean
}

export interface BoardView {
  readonly headings: { readonly workList: string; readonly unitBoard: string }
  readonly arrangement: Arrangement
  readonly focus: BoardList
  readonly keysActive: boolean
  readonly sound: { readonly on: boolean; readonly text: string | null }
  readonly alerts: ReadonlyArray<HeaderAlert>
  readonly workList: { readonly rows: ReadonlyArray<WorkRow>; readonly empty: string | null }
  readonly unitBoard: { readonly rows: ReadonlyArray<UnitRow> }
  readonly selected: SelectedTask | { readonly kind: 'unit'; readonly id: string } | null
  readonly commit: CommitElement
  readonly feedback: Feedback | null
  readonly log: ReadonlyArray<LogEntry>
}
