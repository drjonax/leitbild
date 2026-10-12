import { roeWords, wordFor } from '../lexicon.ts'
import { maxSteps } from '../steps.ts'
import { stepText } from './calls.ts'
import type { BoardRecords, BoardUnit } from './records.ts'
import { hasLoad, isFree, usableSite, type BoardRules } from './rules.ts'
import { boardWords, clockText, loadText, propertyText, unitWord, word } from './text.ts'
import type { ChainStepRow, SiteRow, UnitRow } from './types.ts'

/**
 * The unit board: the units the viewer commands that can move, free first,
 * then in id order. Places that only receive or stand (sites, depots) are
 * targets, not rows.
 */

export const boardUnits = (rules: BoardRules, records: BoardRecords): ReadonlyArray<BoardUnit> =>
  [...records.units.values()]
    .filter(unit => rules.commands(unit) && rules.typeOf(unit).components.mobility !== undefined)
    .sort((a, b) => Number(isFree(b)) - Number(isFree(a)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

/**
 * The places the screen's assets can be sent to, in id order: the living
 * units in the picture that do not move, and of those another side's only
 * where its type is public, as the engine allows (`linksToSite`). A site no
 * asset of the screen could use, such as another side's post in open mode
 * or for the Controller, is left out.
 */
export const boardSites = (rules: BoardRules, records: BoardRecords, assets: ReadonlyArray<BoardUnit>): ReadonlyArray<BoardUnit> =>
  [...records.units.values()]
    .filter(unit => rules.typeOf(unit).components.mobility === undefined && unit.integrity !== 'destroyed')
    .filter(site => assets.some(asset => usableSite(rules, asset, site)))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

export const siteRow = (rules: BoardRules, unit: BoardUnit): SiteRow => {
  const type = rules.typeOf(unit)
  return { id: unit.id, label: unit.label, typeLabel: type.label, icon: type.icon }
}

/** The properties a highlighted row adds to those its detail line shows already, on one line; null when it adds none. */
const rest = (texts: ReadonlyArray<string>): string | null => texts.length === 0 ? null : texts.join(' · ')

/** The track a unit fired on, by its label in the screen's picture. */
const targetLabel = (records: BoardRecords, trackId: string): string | null => {
  const track = records.tracks.get(trackId)
  return track === undefined ? null : `→ ${track.label}`
}

/**
 * How visible a unit that can be fired on stands (a signature and
 * durability): revealed for a while after it fired; standing still,
 * counting down to concealment; concealed once it has stood still long
 * enough. A moving or destroyed unit shows nothing, nor does one that no
 * fire can harm, for which concealment decides nothing on the Board.
 */
const postureText = (rules: BoardRules, unit: BoardUnit, nowMs: number): string | null => {
  const { signature, durability } = rules.typeOf(unit).components
  if (signature === undefined || durability === undefined || unit.integrity === 'destroyed') return null
  if (unit.revealed === true) return 'Revealed'
  if (unit.stillSinceMs === undefined) return null
  const left = signature.concealAfterS - (nowMs - unit.stillSinceMs) / 1_000
  return left > 0 ? `Halting ${clockText(left)}` : 'Concealed'
}

/**
 * A unit's job chain as its row shows it, the active step first. A step's ×
 * is offered except on the delivery of the load the unit carries now, the
 * first step to a site, which the engine keeps; a removal the engine judges
 * on load the unit will only pick up on the way is refused with its reason.
 */
export const chainRows = (records: BoardRecords, unit: BoardUnit): ReadonlyArray<ChainStepRow> => {
  const delivery = hasLoad(unit) ? unit.orders.find(step => 'siteId' in step.target)?.id : undefined
  return unit.orders.map(step => {
    const active = step.state === 'active'
    return { stepId: step.id, text: active ? stepText(records, step) : `${boardWords.next}: ${stepText(records, step)}`, active, removable: step.id !== delivery }
  })
}

export const unitRow = (rules: BoardRules, records: BoardRecords, unit: BoardUnit, context: {
  readonly nowMs: number
  readonly selected: boolean
  readonly moveArmed: boolean
  readonly adding: boolean
}): UnitRow => {
  const type = rules.typeOf(unit)
  const task = unit.taskId === undefined ? undefined : records.tasks.get(unit.taskId)
  const site = unit.siteId === undefined ? undefined : records.units.get(unit.siteId)
  const load = loadText(rules, unit.load)
  return {
    id: unit.id,
    label: unit.label,
    typeLabel: type.label,
    icon: type.icon,
    recallLabel: word(rules, 'recall'),
    holdLabel: wordFor(rules.config.lexicon, 'hold', type.lexicon),
    moveLabel: word(rules, 'move'),
    phaseText: unitWord(rules, unit, unit.phase),
    phaseAgeText: clockText((context.nowMs - unit.phaseSinceMs) / 1_000),
    taskText: task?.label ?? site?.label ?? null,
    etaText: unit.etaSeconds === undefined ? null : `${boardWords.eta} ${clockText(unit.etaSeconds)}`,
    loadText: load === '' ? null : load,
    properties: type.properties.filter(property => property.board).map(property => ({ label: property.label, value: propertyText(property, unit.properties[property.id]) })),
    propertiesText: rest(type.properties.filter(property => !property.board).map(property => `${property.label}: ${propertyText(property, unit.properties[property.id])}`)),
    integrityText: unit.integrity === 'healthy' ? null : unit.integrity === 'destroyed' ? unitWord(rules, unit, 'destroyed') : 'damaged',
    roeText: unit.roe === undefined ? null : roeWords[unit.roe],
    targetText: unit.target === undefined ? null : targetLabel(records, unit.target),
    postureText: postureText(rules, unit, context.nowMs),
    alerts: unit.alerts.map(alert => alert.message),
    free: isFree(unit),
    destroyed: unit.integrity === 'destroyed',
    selected: context.selected,
    moveArmed: context.moveArmed,
    chain: chainRows(records, unit),
    pausedText: unit.paused === true ? boardWords.paused : null,
    canAdd: unit.integrity !== 'destroyed' && unit.orders.length < maxSteps,
    adding: context.adding,
  }
}
