import type { Recommendation } from '../recommendation-schema.ts'
import type { BoardRecords } from './records.ts'
import type { BoardRules } from './rules.ts'
import { etaText } from './text.ts'
import type { AlternativeRow, BoardEffect, ProposalUnit } from './types.ts'
import { completeSeconds, divertFromText, recommendationKey } from './work-list.ts'

/**
 * Recommendation stability. An answer is asked for each wanted task (the
 * selected row and the top unserved rows) and kept with the key it was asked
 * for: rank, load, coverage and how each unit stands for dispatch, never
 * positions. A new key replaces the shown set. With the same key, every 10 s
 * of Run time a re-rank asks again, and only a set at least 30 s faster
 * replaces the shown one; otherwise the shown set stays with fresh ETAs.
 */

const rerankMs = 10_000
const fasterByS = 30

export type Candidate = Recommendation['proposal']['units'][number]

export const candidateIn = (answer: Recommendation, unitId: string): Candidate | undefined =>
  answer.proposal.units.find(unit => unit.unitId === unitId) ?? answer.alternatives.find(unit => unit.unitId === unitId)

/** Why a numbered alternative is no longer offered, in the recommendation's words; null while it is. */
export const droppedReason = (answer: Recommendation, unitId: string): string | null => {
  if (candidateIn(answer, unitId) !== undefined) return null
  return answer.committed.find(entry => entry.unitId === unitId)?.reason
    ?? answer.ineligible.find(entry => entry.unitId === unitId)?.reasons[0]
    ?? 'no longer offered'
}

/** The shown set kept, with each unit's ETA from a newer answer. */
const withNewEtas = (shown: Recommendation, latest: Recommendation): Recommendation => {
  const refresh = (unit: Candidate): Candidate => ({ ...unit, eta: candidateIn(latest, unit.unitId)?.eta ?? unit.eta })
  return { ...shown, proposal: { ...shown.proposal, units: shown.proposal.units.map(refresh) }, alternatives: shown.alternatives.map(refresh) }
}

export interface Recommendations {
  readonly answer: (taskId: string) => Recommendation | undefined
  /** Why the last ask for the task failed, while its key holds. */
  readonly failure: (taskId: string) => string | undefined
  /** Forgets tasks that closed or left the picture, drops answers for unwanted tasks whose key changed, and asks for what is missing or due. */
  readonly sync: (records: BoardRecords, nowMs: number, wanted: ReadonlySet<string>) => ReadonlyArray<BoardEffect>
  readonly receive: (records: BoardRecords, nowMs: number, taskId: string, key: string, answer: Recommendation) => void
  readonly fail: (nowMs: number, taskId: string, key: string, reason: string) => void
}

export const createRecommendations = (rules: BoardRules): Recommendations => {
  const shown = new Map<string, { readonly key: string; readonly answer: Recommendation; readonly atMs: number }>()
  const requested = new Map<string, string>()
  const failed = new Map<string, { readonly key: string; readonly reason: string; readonly atMs: number }>()
  const settled = (taskId: string, key: string): void => { if (requested.get(taskId) === key) requested.delete(taskId) }

  return {
    answer: taskId => shown.get(taskId)?.answer,
    failure: taskId => failed.get(taskId)?.reason,
    sync: (records, nowMs, wanted) => {
      const keyOf = (taskId: string): string | undefined => {
        const task = records.tasks.get(taskId)
        return task === undefined || task.closedAtMs !== undefined ? undefined : recommendationKey(rules, records, task)
      }
      for (const map of [shown, requested, failed]) for (const taskId of map.keys()) if (keyOf(taskId) === undefined) map.delete(taskId)
      for (const [taskId, current] of shown) if (!wanted.has(taskId) && keyOf(taskId) !== current.key) shown.delete(taskId)
      const effects: BoardEffect[] = []
      for (const taskId of wanted) {
        const key = keyOf(taskId)
        if (key === undefined || rules.isReport(records.tasks.get(taskId)!) || requested.get(taskId) === key) continue
        const current = shown.get(taskId)
        const failure = failed.get(taskId)
        if (current?.key === key && nowMs - current.atMs < rerankMs) continue
        if (failure?.key === key && nowMs - failure.atMs < rerankMs) continue
        requested.set(taskId, key)
        effects.push({ kind: 'recommend', taskId, key })
      }
      return effects
    },
    receive: (records, nowMs, taskId, key, answer) => {
      settled(taskId, key)
      const task = records.tasks.get(taskId)
      // A newer state was asked about meanwhile; that answer replaces this one.
      if (task === undefined || task.closedAtMs !== undefined || recommendationKey(rules, records, task) !== key) return
      const previous = shown.get(taskId)
      const replace = previous === undefined || previous.key !== key
        || completeSeconds(answer.proposal.units) <= completeSeconds(previous.answer.proposal.units) - fasterByS
      shown.set(taskId, { key, answer: replace ? answer : withNewEtas(previous.answer, answer), atMs: nowMs })
      failed.delete(taskId)
    },
    fail: (nowMs, taskId, key, reason) => {
      settled(taskId, key)
      failed.set(taskId, { key, reason, atMs: nowMs })
    },
  }
}

const divertText = (candidate: Candidate): string | null =>
  candidate.divertFrom === undefined ? null : `divert from ${divertFromText(candidate.divertFrom)}`

export const proposalUnits = (answer: Recommendation): ReadonlyArray<ProposalUnit> => answer.proposal.units.map(unit => ({
  unitId: unit.unitId,
  label: unit.label,
  etaText: etaText(unit.eta),
  divertText: divertText(unit),
}))

/**
 * The numbered alternatives still offered for the selected row, by the
 * number each was first shown with. One that dropped out is no longer shown
 * (its digit key says why), so nothing stale or greyed lingers after a send;
 * nor is one the proposal has come to send, which its button names.
 */
export const alternativeRows = (answer: Recommendation, numbered: ReadonlyArray<{ readonly unitId: string; readonly label: string }>, chosen: number | null, proposalOnButton = true): ReadonlyArray<AlternativeRow> =>
  numbered.flatMap((entry, index) => {
    const candidate = candidateIn(answer, entry.unitId)
    // A unit the proposal now sends is on the big button already, unless the operator chose it by its number, or the call shows no such button.
    const proposed = proposalOnButton && chosen !== index + 1 && answer.proposal.units.some(unit => unit.unitId === entry.unitId)
    return candidate === undefined || proposed ? [] : [{
      number: index + 1,
      unitId: entry.unitId,
      label: entry.label,
      etaText: etaText(candidate.eta),
      divertText: divertText(candidate),
      chosen: chosen === index + 1,
    }]
  })
