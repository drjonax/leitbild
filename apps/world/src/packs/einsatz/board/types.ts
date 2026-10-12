import type { GeoJsonPoint, IsoTimestamp, ObjectId, OperationalObject } from '../../../core/model/index.ts'
import type { PackMapTarget, PackTargetPreview } from '../../../core/packs/protocol.ts'
import type { PanelKey } from '../../../ui/keys/panel-key.ts'
import type { EinsatzCommandId } from '../capabilities.ts'

/**
 * The Board controller's contract. The panel feeds it events, each stamped
 * with the browser's wall-clock time, performs the effects it returns and
 * renders its view. The controller never reads a clock, the DOM or the
 * network itself, so Bun tests drive it exactly as the panel does.
 *
 * The panel (`ui/BoardPanel.svelte`, running the controller through
 * `ui/board-session.ts`) is a World surface panel (`SurfacePanelProps` in
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
 *   a second) so guards, flashes and Undo expire. Keys are hidden desktop
 *   accelerators; a tap acts whether or not keys reach the World.
 * - `onMapPrompt`: the view's `mapPrompt` whenever it changes, null when it
 *   goes; a tap on the prompt dispatches the `move-here` click.
 * - `seenRoleIds`: `seen` on every change of the prop, before the first
 *   snapshot: Assets leaves out the units of groups the screen chose not to
 *   see, as the map does (`groupUnseen`, picture.ts).
 *
 * The Pack's `targeting.isController(object, context)` is `ordersOnMap`
 * (picture.ts) for the screen's viewer: an Einsatz unit record it commands
 * whose type has `mobility`. A receiving site has none, so with a unit
 * selected a tap on a site reaches `onMapTarget` as that unit's target
 * instead of selecting the site. A second tap on the selected unit also
 * reaches `onMapTarget`, naming the unit itself, and lets it go. Its
 * `targeting.mutedOnMap` mutes the units in the picture the screen does not
 * command; a tap on one selects it on the map, which the Board answers by
 * saying who commands it and letting the selection go.
 */

export type BoardList = 'work' | 'units'

/**
 * What a map click names for the selected unit, as the World surface hands
 * it over: an object, or a point on open ground. The Board decides whether an
 * object is a task, a site, a track or no target at all.
 */
export type MapTarget = PackMapTarget

/** A hover preview of a map target click: verb, target and ETA, or why nothing would be sent. */
export type TargetPreview = PackTargetPreview

/** A key the World key router delivers: `KeyboardEvent.key` and `code`, and Shift. */
export type BoardKey = PanelKey

/**
 * What a busy asset may do with a new target: "Do now" replaces the step it
 * carries out (`world.einsatz.unit.send`); "Add to end" puts the target at
 * the end of its job chain (`world.einsatz.unit.queue`).
 */
export type ChoiceOption = 'do-now' | 'add-to-end'

/** The verbs an asset offers: recall; hold (the Stop of its chain) or, while paused, resume; clear its chain; add a target (+); move (the M key). */
export type UnitVerb = 'recall' | 'hold' | 'resume' | 'clear' | 'add' | 'move'

/**
 * What a tap or click hit on the Board.
 * - A row in Assets highlights its asset, or clears the highlight when it is
 *   the highlighted one. A row in Calls selects the call; with an asset
 *   highlighted, the action bar then offers to send it there. It never sends.
 * - An alternative sends that unit at once (a divert asks to confirm).
 * - The commit button sends what the action bar says, or confirms it.
 */
export type ClickTarget =
  | { readonly kind: 'row'; readonly list: BoardList; readonly id: string }
  | { readonly kind: 'alternative'; readonly number: number }
  /** The action bar's button: send the shown proposal, or confirm a pending confirmation. */
  | { readonly kind: 'commit' }
  /** The offered asset's button: send it to the selected call. */
  | { readonly kind: 'offer' }
  /** One of a busy asset's options. */
  | { readonly kind: 'option'; readonly option: ChoiceOption }
  /** The "Move here" prompt, on the map or in the action bar. */
  | { readonly kind: 'move-here' }
  | { readonly kind: 'undo' }
  | { readonly kind: 'cancel' }
  /**
   * A verb button: recall, stop (hold), resume or clear an asset, close the
   * selected call; move arms a move (the M key); add (an asset row's +)
   * highlights the asset for its next target tap to join the end of its
   * job chain.
   */
  | { readonly kind: 'verb'; readonly verb: UnitVerb | 'close'; readonly id: string }
  /** A step's × on the highlighted asset's job chain. */
  | { readonly kind: 'remove-step'; readonly unitId: string; readonly stepId: string }
  /** A site under Assets: the highlighted asset's target, as a tap on it on the map. */
  | { readonly kind: 'site'; readonly id: string }
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
  /** The roles the screen shows (the role dialog's See boxes, `seenRoleIds`); null in open mode. */
  | { readonly kind: 'seen'; readonly roleIds: ReadonlyArray<string> | null }

export type BoardEvent = BoardEventBody & { readonly wallMs: number }

export type BoardEffect =
  /** Invoke an Einsatz command through the run-scoped World invoke, then feed back `result` with this call id. */
  | { readonly kind: 'invoke'; readonly callId: string; readonly capabilityId: EinsatzCommandId; readonly input: unknown }
  /** Query `world.einsatz.recommend` for the task, then feed back `recommendation` or `recommendation-failed` with this key. */
  | { readonly kind: 'recommend'; readonly taskId: string; readonly key: string }
  /**
   * Mirror the Board's selection on the map (`onSelectObject`). `reveal`: the
   * operator picked it from a list, so the map brings it into view beside the
   * Board; a selection the Board makes itself (the next call after a commit,
   * an asset highlighted again after a refusal) moves no camera.
   */
  | { readonly kind: 'select'; readonly objectId: ObjectId | null; readonly reveal: boolean }
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
  /** Units holding the task queued in their job chains, which count towards nothing yet: "A3 next, 2 steps ahead". */
  readonly nextText: string | null
  /**
   * Why no unit is proposed, or a divert: "Divert A2 from C-9 (P3) · 3:10";
   * "No eligible unit · Unit 2 · Payload 300 kg · needs ≥ 500 kg" when a free
   * unit fails a condition; "No free unit · 3 busy" when every unit that could
   * come is busy; "No unit can serve: needs …" only when no unit could ever
   * serve it; or "No recommendation: …".
   */
  readonly statusText: string | null
  readonly alerts: ReadonlyArray<string>
  /** The configuration's verb for closing a task. */
  readonly closeLabel: string
  /** Flashes for a few seconds after the row appeared. */
  readonly fresh: boolean
  readonly selected: boolean
}

/** A unit still offered for the selected call besides its proposal; a tap sends it. */
export interface AlternativeRow {
  /** Stable while the row stays selected (the digit key's number); a candidate that drops out is no longer shown. */
  readonly number: number
  readonly unitId: string
  readonly label: string
  readonly etaText: string | null
  /** "divert from C-9 (P3)" for a divert candidate. */
  readonly divertText: string | null
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
  /** Units that cannot count towards it, each naming the unit once: "Unit 2 · Payload 300 kg · needs ≥ 500 kg". */
  readonly ineligible: ReadonlyArray<string>
  /** What the task still needs after the shown proposal, in configuration words. */
  readonly remainder: ReadonlyArray<string>
  /** The remainder as the row says it: "Still needs 2 more guards, P3×1"; null when nothing remains. */
  readonly remainderText: string | null
}

export interface UnitRow {
  readonly id: string
  readonly label: string
  readonly typeLabel: string
  readonly icon: string
  /** The configuration's verb for recalling a unit: the R key's label. */
  readonly recallLabel: string
  /** The type's word for halting in place, as a heading: the H verb's label. */
  readonly holdLabel: string
  /** The configuration's verb for moving a unit to a point: the M key's label. */
  readonly moveLabel: string
  readonly phaseText: string
  /** Time in the current phase. */
  readonly phaseAgeText: string
  readonly taskText: string | null
  /** Time still needed on the current leg: "ETA 3:10". */
  readonly etaText: string | null
  readonly loadText: string | null
  /** At most two properties the type shows on the board. */
  readonly properties: ReadonlyArray<{ readonly label: string; readonly value: string }>
  /** The unit's other properties, shown on the highlighted row besides those in `properties`: "Payload: 300 kg · Crew: 4"; null when it has none. */
  readonly propertiesText: string | null
  readonly integrityText: string | null
  /** The rules of engagement of a unit with an effector: "weapons free". */
  readonly roeText: string | null
  /** The track it fired on in the last engagement step: "→ T-7". */
  readonly targetText: string | null
  /** A unit others can detect, standing still or having fired: "Halting 0:12", "Concealed", "Revealed". */
  readonly postureText: string | null
  readonly alerts: ReadonlyArray<string>
  readonly free: boolean
  readonly destroyed: boolean
  /** The highlighted asset: a tap on a target sends it. */
  readonly selected: boolean
  /** Move is armed for this unit: the next map click moves it. */
  readonly moveArmed: boolean
  /** Its job chain: the active step, then the queued ones as "next". */
  readonly chain: ReadonlyArray<ChainStepRow>
  /** Paused by Stop: it starts no further step until Resume or a new order. */
  readonly pausedText: string | null
  /** Whether its + is offered: a living unit whose chain has room. */
  readonly canAdd: boolean
  /** The + was tapped: the next target tap joins the end of its chain. */
  readonly adding: boolean
}

/**
 * A place an asset can be sent to, listed under Assets: a unit in the
 * picture that does not move (a receiving site, a depot, a post). A tap on it with
 * an asset highlighted is a tap on its target, even where units parked on it
 * cover it on the map.
 */
export interface SiteRow {
  readonly id: string
  readonly label: string
  readonly typeLabel: string
  readonly icon: string
}

/** One step of an asset's job chain, as its row shows it. */
export interface ChainStepRow {
  readonly stepId: string
  /** The active step as it is, "C-1" or "to S1"; a queued one as "next: deliver to H1", "next: to a map point", "next: engage T-3". */
  readonly text: string
  readonly active: boolean
  /** Whether its × is offered: not the delivery of the load the unit carries, which the engine keeps. */
  readonly removable: boolean
}

/** A track in the Contacts list, in its side's knowledge only. */
export interface ContactRow {
  readonly id: string
  /** The side's own serial: "T-14". */
  readonly label: string
  /** The tier in the configuration's words: contact, identified or destroyed. */
  readonly tierText: string
  /** What the side identified: the type's label; null for a contact. */
  readonly typeLabel: string | null
  /** The identified type's icon, or a neutral one for a contact. */
  readonly icon: string
  /** Since the last detection. */
  readonly ageText: string | null
  /** From the nearest of the viewer's units on the track's side. */
  readonly distanceText: string | null
  /** "No fire-control fix: contact report only" while the track holds no fix. */
  readonly fixText: string | null
  /** "engaged by 2": own units that fired on it in the last engagement step. */
  readonly engagedText: string | null
  readonly destroyed: boolean
}

/** One group of the Contacts list, nearest first, in the configuration's words. */
export interface ContactGroup {
  readonly heading: string
  readonly rows: ReadonlyArray<ContactRow>
  /** What the group says while it holds no track; null while it holds one. */
  readonly empty: string | null
}

/** The tracks one side's picture holds, in their two groups. */
export interface ContactSide {
  /** The side's label as the Run declares it, when the screen holds more than one side's tracks; null when it holds one side's only. */
  readonly label: string | null
  /** Tracks one of the viewer's armed units of that side could fire on now, its rules of engagement aside. */
  readonly engageable: ContactGroup
  readonly other: ContactGroup
}

/**
 * The Contacts list, nothing collapsed. A side's serials are its own, so a
 * screen holding several sides' tracks (a truth role, a role set across
 * opposing sides) lists them side by side, in declared side order.
 */
export interface ContactsView {
  readonly heading: string
  readonly sides: ReadonlyArray<ContactSide>
}

/**
 * The action bar: one place that says what the next tap sends, and the
 * buttons that do it. Its text is exactly what its button commits.
 * - ready: the selected call's proposal; the button sends it.
 * - confirm: a divert, or closing a call with waiting load; the detail names
 *   what is dropped, once; the button confirms.
 * - choice: a busy asset sent to a new target; the options say what it may
 *   do: "Do now" or "Add to end".
 * - move: a tap on open ground; the button moves the asset there, as does
 *   the prompt on the map.
 * - asset: an asset is highlighted; its verbs are the buttons.
 * - preparing, sending, none: nothing to send now, and why.
 * `enabled` is false while a guard runs, a call is on its way or a
 * recommendation is still being prepared.
 */
export interface CommitElement {
  readonly state: 'ready' | 'confirm' | 'choice' | 'move' | 'asset' | 'preparing' | 'sending' | 'none'
  readonly text: string
  /** What a confirmation or choice drops: "C-9 (P3) · 1 pallet returns to the queue". */
  readonly detail: string | null
  /** The primary button's label; null when the bar has no primary button. */
  readonly button: string | null
  /**
   * "Send A2 here": the asset that was highlighted when the operator tapped
   * the selected call in the list, offered as a button of its own beside the
   * call's suggestion; null when none is offered. A list tap never sends.
   */
  readonly offer: string | null
  /** A busy asset's options, each a button. */
  readonly options: ReadonlyArray<{ readonly option: ChoiceOption; readonly label: string }>
  /** The highlighted asset's verbs: Stop or Resume, Clear, recall. */
  readonly verbs: ReadonlyArray<{ readonly verb: Exclude<UnitVerb, 'add' | 'move'>; readonly label: string; readonly id: string }>
  /** The selected call's close verb ("Close call"), kept apart from the commit button; null for a report, which the commit button closes. */
  readonly close: { readonly label: string; readonly id: string } | null
  readonly enabled: boolean
  /** Why it is disabled for now: "Confirm next: C-14" during a guard. */
  readonly hint: string | null
  /** The cancel control's label while there is something to cancel. */
  readonly cancel: string | null
}

/** A one-button prompt the Board shows on the map at a point: "Move A3 here". */
export interface BoardMapPrompt {
  readonly unitId: string
  readonly point: GeoJsonPoint
  readonly label: string
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
 * roles show both. Roles commanding a sensing or firing unit get the
 * Contacts list.
 */
export interface Arrangement {
  readonly lead: 'work-list' | 'map'
  readonly workList: boolean
  readonly unitBoard: boolean
  readonly contacts: boolean
}

export interface BoardView {
  /** The lists' headings in the configuration's words; the alert strip's and the event log's names. */
  readonly headings: { readonly workList: string; readonly unitBoard: string; readonly alerts: string; readonly log: string }
  readonly arrangement: Arrangement
  readonly focus: BoardList
  readonly keysActive: boolean
  /** Whether sound is on, and what the sound control says: how to enable it, or that it is on. */
  readonly sound: { readonly on: boolean; readonly text: string }
  /** The header strip's alerts, newest first: the strip shows the first and counts the rest. */
  readonly alerts: ReadonlyArray<HeaderAlert>
  readonly workList: { readonly rows: ReadonlyArray<WorkRow>; readonly empty: string | null }
  readonly unitBoard: { readonly rows: ReadonlyArray<UnitRow>; readonly empty: string | null; readonly sitesHeading: string; readonly sites: ReadonlyArray<SiteRow> }
  /** Null unless the arrangement includes the Contacts list. */
  readonly contacts: ContactsView | null
  /** Whether Contacts folds to one line of counts: on a screen led by its work list, until a track first becomes engageable on it. */
  readonly contactsFolded: boolean
  readonly selected: SelectedTask | { readonly kind: 'unit'; readonly id: string } | null
  readonly commit: CommitElement
  readonly feedback: Feedback | null
  /** The Undo button's label for 8 s, of wall time and of Run time, after a send or a queue was accepted and the Run shows the step it created; null otherwise. */
  readonly undo: string | null
  /** The prompt to show on the map after a tap on open ground; null when there is none. */
  readonly mapPrompt: BoardMapPrompt | null
  readonly log: ReadonlyArray<LogEntry>
}
