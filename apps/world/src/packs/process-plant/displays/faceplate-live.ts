// A compiled faceplate and how it reads live (faceplate.ts derives and
// compiles it from the Plant). Everything here is plain data resolved to
// variable paths, and a pure function of it and of what a display's sample
// carries (values, the mode, the annunciated alarms, the safety functions'
// statuses), so World and the view read a faceplate alike without the
// Plant's model.

/** Where a row comes from: (1) protection, (2) safety functions, (3) port circuits, (4) programs, (5) the end's instruments and lead values, (6) loop channels. */
export type FaceplateSource = 'protection' | 'safetyFunction' | 'circuit' | 'program' | 'equipment' | 'channel' | 'lead'

type Operator = '<' | '<=' | '>' | '>=' | '==' | '!='

/** A condition of the Plant's I&C or of a safety function, its signals resolved to paths. */
export type FaceplateCondition =
  | { readonly type: 'comparison'; readonly path: string; readonly operator: Operator; readonly value: number | boolean }
  | { readonly type: 'total'; readonly paths: ReadonlyArray<string>; readonly operator: Operator; readonly value: number }
  | { readonly type: 'difference'; readonly path: string; readonly minus: string; readonly operator: Operator; readonly value: number }
  | { readonly type: 'all' | 'any'; readonly conditions: ReadonlyArray<FaceplateCondition> }
  | { readonly type: 'not'; readonly condition: FaceplateCondition }
  | { readonly type: 'vote'; readonly required: number; readonly conditions: ReadonlyArray<FaceplateCondition> }

/** A command an automatic action writes, and the value it writes. */
export interface FaceplateWrite {
  readonly path: string
  readonly value: number | boolean
}

/** A rule as a faceplate reads it: its trip's title, the modes it acts in (all where absent), what sets it off and what only arms it. */
export interface FaceplateRule {
  readonly id: string
  readonly title: string
  readonly modes?: ReadonlyArray<string>
  readonly triggers: ReadonlyArray<FaceplateCondition>
  readonly gates: ReadonlyArray<FaceplateCondition>
}

/** What heads a column, with the words it is headed by. */
export type FaceplateHead =
  /** A first-out group ("RX TRIP"). */
  | { readonly kind: 'group'; readonly group: string; readonly title: string }
  /** A critical safety function's chip ("CORE COOL"). */
  | { readonly kind: 'safetyFunction'; readonly id: string; readonly title: string }
  /** A port circuit, named as the port's kind names it ("Steam inlet"), with the equipment its line reaches as a sub-line. */
  | { readonly kind: 'circuit'; readonly port: string; readonly title: string; readonly equipment: ReadonlyArray<string> }
  /** The end itself. */
  | { readonly kind: 'equipment'; readonly title: string }
  /** What the end's control holds to programs. */
  | { readonly kind: 'programs'; readonly title: string }

/** Parallel loops, one row each; a column's cells may hold two values (two margins its protection judges). */
export interface FaceplateLoopColumn {
  readonly cells: ReadonlyArray<ReadonlyArray<string>>
  /** Values that measure something only while a flag reads true (delta-T power with forced flow), each with its flag. */
  readonly qualifiers?: ReadonlyArray<{ readonly path: string; readonly flag: string }>
  readonly source: FaceplateSource
  /** The modes each rule that judges the column acts in (null for every mode); none where no rule judges it. */
  readonly judgedIn: ReadonlyArray<ReadonlyArray<string> | null>
}

export type FaceplateRowSpec =
  /** A first-out group's rules, each with the id of its trip there; `banner` where the trip banner leads with the group's first out; `does` what every rule of it writes. */
  | { readonly kind: 'rules'; readonly group: string; readonly banner: boolean; readonly does: ReadonlyArray<FaceplateWrite>; readonly rules: ReadonlyArray<FaceplateRule & { readonly lifecycle: string }> }
  /** A rule of another group acting on a state the column's group moves, with its action's words and every command it writes; shown only while it can act. */
  | { readonly kind: 'consequence'; readonly rule: FaceplateRule; readonly action: string; readonly writes: ReadonlyArray<FaceplateWrite> }
  /**
   * Values on one line; with `flag`, the first, the rest shown only while it
   * reads true; `criteria` a safety function's criterion for each, its
   * reference once the end has stopped; `strip`, one quantity of parallel
   * equipment read side by side (the rod banks), a bar each; `held`, what the
   * controller of the equipment whose flow and position these are holds, and
   * to what (the steam dumps' header pressure), its only mode modelled.
   */
  | { readonly kind: 'values'; readonly source: FaceplateSource; readonly paths: ReadonlyArray<string>; readonly flag?: string; readonly criteria: ReadonlyArray<FaceplateCriterion>; readonly strip?: true; readonly held?: FaceplateHeld }
  /** A safety function's checks; each shown while it applies, folded while all pass. */
  | { readonly kind: 'checks'; readonly safetyFunction: string; readonly title: string; readonly checks: ReadonlyArray<{ readonly label: string; readonly when?: FaceplateCondition; readonly condition: FaceplateCondition }> }
  /**
   * Where the circuit feeding an inlet (`from`, its service: "Main steam")
   * sends its flow besides the end, each outlet named by its branch's first
   * equipment; those whose branch publishes no flow by name only (`unmeasured`).
   */
  | { readonly kind: 'flows'; readonly from: string; readonly branches: ReadonlyArray<{ readonly path: string; readonly destination: string }>; readonly unmeasured?: ReadonlyArray<string> }
  | { readonly kind: 'loops'; readonly loops: ReadonlyArray<string>; readonly columns: ReadonlyArray<FaceplateLoopColumn> }

/** What a valve's controller holds and to what: the valve's short name (its flow's name in the row), the quantity it measures ("pressure"), its set point in display units. */
export interface FaceplateHeld {
  readonly name: string
  readonly quantity: string
  readonly setpoint: number
  readonly unit: string
}

/** A safety function's criterion of a reading, as its tree asks it. */
export interface FaceplateCriterion {
  readonly path: string
  readonly safetyFunction: string
  readonly operator: Operator
  readonly value: number | boolean
}

export interface FaceplateColumnSpec {
  readonly heads: ReadonlyArray<FaceplateHead>
  readonly rows: ReadonlyArray<FaceplateRowSpec>
}

/** A faceplate compiled for one energy end, for the Plant's mode and the readings that measure nothing as it was opened. */
export interface CompiledFaceplate {
  /** The end's id. */
  readonly end: string
  readonly columns: ReadonlyArray<FaceplateColumnSpec>
  /** What the end's first protection group commands: once all of it reads so, the end has stopped. */
  readonly stoppedWhen: ReadonlyArray<FaceplateWrite>
  /** Every path its live rows read: values, conditions, commands. A display samples them all. */
  readonly paths: ReadonlyArray<string>
  /**
   * Compacted to fit under a drawing it would not fit under whole: each
   * function's checks fold into one line, which names those not met.
   */
  readonly compact?: true
}

/** A faceplate row as it reads now. */
export type FaceplateRow =
  /** An active rule of the column's group, by its trip's title there, with what set it off and still holds; first out marked. */
  | { readonly kind: 'rule'; readonly rule: string; readonly title: string; readonly firstOut: boolean; readonly deciding: ReadonlyArray<FaceplateComparison> }
  /** Active rules not listed by name. */
  | { readonly kind: 'acting'; readonly count: number }
  /** Rules of the group not active that act in the mode with what arms them holding, while what the group does can still be done. */
  | { readonly kind: 'armed'; readonly count: number }
  /** A rule elsewhere acting on what the group moved: armed, or idle with what it waits for. */
  | { readonly kind: 'consequence'; readonly rule: string; readonly title: string; readonly action: string; readonly status: 'armed' | 'idle'; readonly deciding: ReadonlyArray<FaceplateComparison> }
  /** Values on one line, those that measure something now; `criteria` where a safety function's criterion is their reference; `strip` and `held` as compiled. */
  | { readonly kind: 'values'; readonly source: FaceplateSource; readonly paths: ReadonlyArray<string>; readonly criteria: ReadonlyArray<FaceplateCriterion>; readonly strip?: true; readonly held?: FaceplateHeld }
  /** A check that applies and is not met, by name: neutral, not an alarm. */
  | { readonly kind: 'check'; readonly safetyFunction: string; readonly label: string; readonly met: 'no' | 'unknown' }
  /** Checks that apply, folded: their common name, how many of how many are met; in a compact faceplate, those not met by name. */
  | { readonly kind: 'checks'; readonly safetyFunction: string; readonly label: string; readonly met: number; readonly of: number; readonly notMet?: ReadonlyArray<string> }
  | { readonly kind: 'flows'; readonly from: string; readonly branches: ReadonlyArray<{ readonly path: string; readonly destination: string }>; readonly unmeasured?: ReadonlyArray<string> }
  /**
   * The loop table; an `idle` column (its rules do not act in the mode) is
   * drawn faint and names no margin; a `blank` value measures nothing now and
   * reads "—" in its place (delta-T power without forced flow).
   */
  | { readonly kind: 'loops'; readonly loops: ReadonlyArray<string>; readonly columns: ReadonlyArray<{ readonly cells: ReadonlyArray<ReadonlyArray<string>>; readonly idle: boolean; readonly blank: ReadonlyArray<string> }> }

/** One comparison a row is decided on, as it reads now. */
export interface FaceplateComparison {
  readonly path: string
  readonly operator: Operator
  readonly value: number | boolean
  readonly holds: boolean | null
  /** Where it is one channel of a vote: how many must hold, of how many, and how many do now. */
  readonly vote?: { readonly required: number; readonly of: number; readonly holding: number }
}

export interface FaceplateColumn {
  /** Its heads; a group's carries when its first out came in (Run elapsed ms), where one has. */
  readonly heads: ReadonlyArray<FaceplateHead & { readonly firstOutSinceMs?: number }>
  readonly rows: ReadonlyArray<FaceplateRow>
}

export interface Faceplate {
  readonly end: string
  readonly columns: ReadonlyArray<FaceplateColumn>
}

/** What a faceplate reads live, as a display's sample carries it: values, the mode, the annunciated alarms and trips, each safety function's status. */
export interface FaceplateLive {
  readonly mode: string | null
  readonly read: (path: string) => unknown
  readonly alarms: ReadonlyArray<{ readonly id: string; readonly ruleId: string; readonly active: boolean; readonly firstOut: boolean; readonly firstActiveElapsedMs?: number | undefined }>
  readonly functions: ReadonlyArray<{ readonly id: string; readonly status: string }>
}

/** Active rules a group lists by name before it counts the rest. */
export const FACEPLATE_ACTIVE_RULE_ROWS = 4

/** The lines a column takes under its head: one per row, a loop table its head line and a line per loop, a held value the line naming its mode. */
export const faceplateLines = (column: Pick<FaceplateColumn, 'rows'>): number =>
  column.rows.reduce((lines, row) => lines + (row.kind === 'loops' ? 1 + row.loops.length : row.kind === 'values' && row.held !== undefined ? 2 : 1), 0)

/** The most lines a column of a compiled faceplate can take: every row it may show, checks unfolded (folded where `compact`), at most its active rule rows. */
export const faceplateMostLines = (column: FaceplateColumnSpec, compact = false): number => column.rows.reduce((lines, row) => lines + (
  row.kind === 'loops' ? 1 + row.loops.length
    : row.kind === 'checks' ? (compact ? 1 : row.checks.length)
      : row.kind === 'rules' ? (row.banner ? 0 : Math.min(FACEPLATE_ACTIVE_RULE_ROWS, row.rules.length)) + 2
        : row.kind === 'values' && row.held !== undefined ? 2
          : 1), 0)

const compare = (left: unknown, operator: Operator, right: number | boolean): boolean | null => {
  if (operator === '==') return left === right
  if (operator === '!=') return left !== right
  if (typeof left !== 'number' || typeof right !== 'number') return null
  return operator === '<' ? left < right : operator === '<=' ? left <= right : operator === '>' ? left > right : left >= right
}

/** Whether a condition holds on the values read; null where a value it needs is not a number or state. */
export const faceplateHolds = (condition: FaceplateCondition, read: (path: string) => unknown): boolean | null => {
  if (condition.type === 'comparison') return compare(read(condition.path), condition.operator, condition.value)
  if (condition.type === 'total' || condition.type === 'difference') {
    const values = (condition.type === 'total' ? condition.paths : [condition.path, condition.minus]).map(read)
    if (values.some(value => typeof value !== 'number')) return null
    const numbers = values as ReadonlyArray<number>
    return compare(condition.type === 'total' ? numbers.reduce((sum, value) => sum + value, 0) : numbers[0]! - numbers[1]!, condition.operator, condition.value)
  }
  if (condition.type === 'not') {
    const inner = faceplateHolds(condition.condition, read)
    return inner === null ? null : !inner
  }
  const answers = condition.conditions.map(child => faceplateHolds(child, read))
  if (condition.type === 'vote') return answers.filter(answer => answer === true).length >= condition.required ? true : answers.some(answer => answer === null) ? null : false
  if (condition.type === 'any') return answers.includes(true) ? true : answers.includes(null) ? null : false
  return answers.includes(false) ? false : answers.includes(null) ? null : true
}

const negated = { '<': '>=', '<=': '>', '>': '<=', '>=': '<', '==': '!=', '!=': '==' } as const

/** How far a comparison is from holding, relative to its limit: negative once it holds; for a state, −1 or 1. */
const distance = (comparison: FaceplateComparison, read: (path: string) => unknown): number => {
  const value = read(comparison.path)
  if (comparison.holds === null) return Number.POSITIVE_INFINITY
  if (typeof value !== 'number' || typeof comparison.value !== 'number' || comparison.operator === '==' || comparison.operator === '!=') return comparison.holds ? -1 : 1
  const below = comparison.operator === '<' || comparison.operator === '<='
  return (below ? value - comparison.value : comparison.value - value) / Math.max(Math.abs(comparison.value), 1)
}

/**
 * The comparisons a condition is decided on now: a comparison itself; of
 * alternatives, the one that holds or else the nearest; of conditions
 * required together, those that do not hold (all where they all do); of a
 * vote, its nearest channel with the count.
 */
const deciding = (condition: FaceplateCondition, read: (path: string) => unknown, invert = false): ReadonlyArray<FaceplateComparison> => {
  if (condition.type === 'comparison') {
    const operator = invert ? negated[condition.operator] : condition.operator
    return [{ path: condition.path, operator, value: condition.value, holds: compare(read(condition.path), operator, condition.value) }]
  }
  if (condition.type === 'total' || condition.type === 'difference') return []
  if (condition.type === 'not') return deciding(condition.condition, read, !invert)
  const children = condition.conditions.map(child => deciding(child, read, invert))
  const nearest = (candidates: ReadonlyArray<ReadonlyArray<FaceplateComparison>>) => [...candidates]
    .sort((left, right) => Math.min(...left.map(entry => distance(entry, read))) - Math.min(...right.map(entry => distance(entry, read))))[0] ?? []
  if (condition.type === 'vote' && !invert) {
    const holding = condition.conditions.filter(child => faceplateHolds(child, read) === true).length
    return nearest(children).slice(0, 1).map(entry => ({ ...entry, vote: { required: condition.required, of: condition.conditions.length, holding } }))
  }
  if ((condition.type === 'any') !== invert) return nearest(children)
  const open = children.filter(entries => entries.some(entry => entry.holds !== true))
  return (open.length === 0 ? children : open).flat()
}

/**
 * What holds now in a condition that set a rule off: each comparison that
 * holds, a vote by its first channel that holds with the count, so an active
 * row names its cause (the pumps stopped), not the branch it no longer needs.
 */
const holding = (condition: FaceplateCondition, read: (path: string) => unknown, invert = false): ReadonlyArray<FaceplateComparison> => {
  if (condition.type === 'comparison' || (condition.type === 'vote' && invert)) return deciding(condition, read, invert).filter(entry => entry.holds === true)
  if (condition.type === 'total' || condition.type === 'difference') return []
  if (condition.type === 'not') return holding(condition.condition, read, !invert)
  if (condition.type === 'vote') {
    const held = condition.conditions.filter(child => faceplateHolds(child, read) === true)
    return held.length === 0 ? [] : holding(held[0]!, read).slice(0, 1).map(entry => ({ ...entry, vote: { required: condition.required, of: condition.conditions.length, holding: held.length } }))
  }
  const found = condition.conditions.flatMap(child => holding(child, read, invert))
  return found.filter((entry, index) => found.findIndex(other => other.path === entry.path) === index)
}

/** As the I&C runs: a rule declared for some modes acts only while the Plant is in one of them. */
const actsIn = (modes: ReadonlyArray<string> | null | undefined, mode: string | null): boolean => modes === undefined || modes === null || (mode !== null && modes.includes(mode))

/** Whether what an action writes can still be done: some command it writes does not yet read what it would write. */
const canStillDo = (writes: ReadonlyArray<FaceplateWrite>, read: (path: string) => unknown): boolean => writes.some(write => read(write.path) !== write.value)

/** What checks that apply have in common in their names ("Natural circulation"), else the function's chip. */
const foldedName = (labels: ReadonlyArray<string>, fallback: string): string => {
  const heads = [...new Set(labels.map(label => label.includes(':') ? label.slice(0, label.indexOf(':')) : label))]
  return heads.length === 1 && labels.every(label => label.includes(':')) ? heads[0]! : fallback
}

/**
 * A faceplate as it reads now: a group's active rules by name, first out
 * first (not the banner group's first out, which the banner states), each
 * with what set it off and still holds, then the counts of others acting and
 * of those armed; each consequence only while it can still act; checks
 * folded while they all pass, a failing one by name; readings that measure
 * nothing left out of their row; once the end has stopped, the criterion its
 * safety functions judge a reading by as its reference; loop columns whose
 * rules do not act in the mode idle.
 */
export const faceplateNow = (faceplate: CompiledFaceplate, live: FaceplateLive): Faceplate => {
  const activeSince = new Map<string, number>()
  for (const alarm of live.alarms) {
    if (!alarm.active) continue
    const since = alarm.firstActiveElapsedMs ?? 0
    activeSince.set(alarm.ruleId, Math.min(activeSince.get(alarm.ruleId) ?? since, since))
  }
  const firstOut = new Map(live.alarms.filter(alarm => alarm.firstOut).map(alarm => [alarm.id, alarm] as const))
  const gatesHold = (rule: FaceplateRule): boolean => rule.gates.every(gate => faceplateHolds(gate, live.read) === true)
  const stopped = faceplate.stoppedWhen.length > 0 && !canStillDo(faceplate.stoppedWhen, live.read)
  const judged = new Set(live.functions.filter(entry => entry.status !== 'not-monitored').map(entry => entry.id))
  const rowsOf = (spec: FaceplateRowSpec): ReadonlyArray<FaceplateRow> => {
    if (spec.kind === 'rules') {
      const first = spec.rules.find(rule => firstOut.has(rule.lifecycle))?.id
      const active = spec.rules.filter(rule => activeSince.has(rule.id) && !(spec.banner && rule.id === first))
        .sort((left, right) => Number(right.id === first) - Number(left.id === first) || activeSince.get(left.id)! - activeSince.get(right.id)!)
      const listed = spec.banner ? [] : active.slice(0, FACEPLATE_ACTIVE_RULE_ROWS).map((rule): FaceplateRow => ({
        kind: 'rule',
        rule: rule.id,
        title: rule.title,
        firstOut: rule.id === first,
        // A latched rule whose cause has cleared names none: its title says what acted.
        deciding: rule.triggers.flatMap(trigger => holding(trigger, live.read)),
      }))
      // Armed: what the group does can still be done (a reactor trip whose breakers are open guards nothing more,
      // whatever else its causes still start), and the rule acts in the mode with what arms it holding.
      const armedCount = !canStillDo(spec.does, live.read) ? 0
        : spec.rules.filter(rule => !activeSince.has(rule.id) && actsIn(rule.modes, live.mode) && gatesHold(rule)).length
      return [
        ...listed,
        ...(active.length > listed.length ? [{ kind: 'acting', count: active.length - listed.length } as const] : []),
        ...(armedCount > 0 ? [{ kind: 'armed', count: armedCount } as const] : []),
      ]
    }
    if (spec.kind === 'consequence') {
      const rule = spec.rule
      if (activeSince.has(rule.id) || !actsIn(rule.modes, live.mode) || !canStillDo(spec.writes, live.read)) return []
      const open = rule.gates.filter(gate => faceplateHolds(gate, live.read) !== true)
      return [{
        kind: 'consequence',
        rule: rule.id,
        title: rule.title,
        action: spec.action,
        status: open.length === 0 ? 'armed' : 'idle',
        deciding: (open.length === 0 ? rule.gates : open).flatMap(gate => deciding(gate, live.read)),
      }]
    }
    if (spec.kind === 'checks') {
      const applying = spec.checks.filter(check => check.when === undefined || faceplateHolds(check.when, live.read) === true)
      if (applying.length === 0) return []
      const answers = applying.map(check => ({ check, met: faceplateHolds(check.condition, live.read) }))
      const failing = answers.filter(answer => answer.met !== true)
      const met = applying.length - failing.length
      const label = foldedName(applying.map(check => check.label), spec.title)
      if (faceplate.compact === true) return [{ kind: 'checks', safetyFunction: spec.safetyFunction, label, met, of: applying.length, ...(failing.length === 0 ? {} : { notMet: failing.map(answer => answer.check.label) }) }]
      return [
        ...failing.map((answer): FaceplateRow => ({ kind: 'check', safetyFunction: spec.safetyFunction, label: answer.check.label, met: answer.met === false ? 'no' : 'unknown' })),
        ...(met === 0 ? [] : [{ kind: 'checks', safetyFunction: spec.safetyFunction, label, met, of: applying.length } as const]),
      ]
    }
    if (spec.kind === 'values') {
      const paths = spec.flag !== undefined && live.read(spec.flag) !== true ? [spec.flag] : spec.paths
      const criteria = stopped ? spec.criteria.filter(criterion => paths.includes(criterion.path) && judged.has(criterion.safetyFunction)) : []
      return [{ kind: 'values', source: spec.source, paths, criteria, ...(spec.strip === undefined ? {} : { strip: spec.strip }), ...(spec.held === undefined ? {} : { held: spec.held }) }]
    }
    if (spec.kind === 'loops') {
      return [{
        kind: 'loops',
        loops: spec.loops,
        columns: spec.columns.map(column => ({
          cells: column.cells,
          idle: column.judgedIn.length > 0 && !column.judgedIn.some(modes => actsIn(modes, live.mode)),
          // A value measured only under a flag reads "—" in its place while the flag does not hold.
          blank: (column.qualifiers ?? []).flatMap(qualifier => live.read(qualifier.flag) === true ? [] : [qualifier.path]),
        })),
      }]
    }
    return [spec]
  }
  return {
    end: faceplate.end,
    columns: faceplate.columns.map(column => ({
      heads: column.heads.map(head => {
        if (head.kind !== 'group') return head
        const rules = column.rows.flatMap(row => row.kind === 'rules' && row.group === head.group ? row.rules : [])
        const first = live.alarms.find(alarm => alarm.firstOut && rules.some(rule => rule.lifecycle === alarm.id))
        return first?.firstActiveElapsedMs === undefined ? head : { ...head, firstOutSinceMs: first.firstActiveElapsedMs }
      }),
      rows: column.rows.flatMap(rowsOf),
    })),
  }
}
