/**
 * The Run as the Assistant sees it before it calls anything (plan v3.1 §2.4,
 * architecture A4): a header, up to 8 asset lines (objects that declare
 * observations, worst declared alert priority first, then Run order) with the
 * refs of their lead values, one line per presentation category for every
 * other object, one per record-only Pack, the dashboards line, each Pack's
 * fenced guidance, and how many objects the caller may not see. Words come
 * from presentation, alerts from the core slot, refs from the Pack's lead
 * read; never a presentation summary or field, so no number has two sources.
 */
import { priorityLevels, type AlertState } from '../../../core/model/alerts.ts'
import type { OperationalObject, SimulationClockState } from '../../../core/model/index.ts'
import type { WorldPack } from '../../../core/packs/protocol.ts'
import { observationProviderFor, type ObservationPort } from '../observation/port.ts'
import { presentObjects } from '../observation/search.ts'

const maxAssets = 8
const maxLines = 40
const maxChars = 8_000
const maxLineChars = 400

const rankOf = (alert: AlertState): number => alert.priority === undefined ? 0 : priorityLevels.indexOf(alert.priority)
const worstOf = (object: OperationalObject): AlertState | undefined => [...object.alerts].sort((left, right) => rankOf(right) - rankOf(left))[0]
const worstWord = (alert: AlertState): string => alert.priority ?? `${alert.severity} (priority not declared)`
const line = (text: string): string => text.length <= maxLineChars ? text : `${text.slice(0, maxLineChars - 1)}…`
/**
 * A line within its cap that never cuts an id or a ref: its free words give
 * way first at a word boundary (never its leading part), then whole items
 * leave from the end and are counted, so a reader knows to ask for them.
 */
const fitted = (head: ReadonlyArray<string>, items: ReadonlyArray<string>, render: (kept: ReadonlyArray<string>, dropped: number) => string): string => {
  const tail = (count: number): string => render(items.slice(0, count), items.length - count)
  const joined = (words: string, count: number): string => tail(count) === '' ? words : `${words} · ${tail(count)}`
  let words = head.join(' · ')
  const room = maxLineChars - (tail(0) === '' ? 0 : tail(0).length + 3)
  if (words.length > room) words = `${words.slice(0, Math.max(words.lastIndexOf(' ', room - 2), head[0]!.length))}…`
  for (let count = items.length; count > 0; count -= 1) if (joined(words, count).length <= maxLineChars) return joined(words, count)
  return joined(words, 0)
}

export const assembleRunContext = async (run: {
  readonly title: string
  /** The Run's objects in Run order. */
  readonly objects: ReadonlyArray<OperationalObject>
  /** Objects the caller may not inspect: counted, never named. */
  readonly denied: ReadonlySet<string>
  readonly clock: SimulationClockState | undefined
  readonly packs: ReadonlyArray<WorldPack>
  readonly port: ObservationPort
}): Promise<{ readonly text: string; readonly at: string; readonly clock: 'simulation' | 'wall' }> => {
  const visible = run.objects.filter(object => !run.denied.has(object.id))
  const presented = presentObjects(run.packs, visible)
  const observed = observationProviderFor(run.packs)
  const statusOf = (object: OperationalObject): string => presented.get(object.id)?.status ?? object.operational.status
  const byWorst = (objects: ReadonlyArray<OperationalObject>) => objects
    .map((object, order) => ({ object, order, rank: Math.max(-1, ...object.alerts.map(rankOf)) }))
    .sort((left, right) => right.rank - left.rank || left.order - right.order).map(entry => entry.object)

  const header = run.clock === undefined
    ? `${run.title} · no simulation clock`
    : `${run.title} · simulation time ${run.clock.currentTime} · ${run.clock.paused ? 'PAUSED' : 'LIVE'}`
  const assets = byWorst(visible.filter(object => observed(object) !== undefined)).slice(0, maxAssets)
  const assetLines = await Promise.all(assets.map(async object => {
    // Each part names its worst alert's message (G1: counts without text read as handled). An advisory never asks
    // attention (R43): it counts apart as in force, never as unacknowledged; ranking still weighs it.
    const advisories = object.alerts.filter(alert => alert.advisory === true)
    const alarms = object.alerts.filter(alert => alert.advisory !== true)
    const unacknowledged = alarms.filter(alert => !alert.acknowledged && alert.standing !== true).length
    const standing = alarms.filter(alert => alert.standing === true).length
    const worst = worstOf({ ...object, alerts: alarms })
    const advised = worstOf({ ...object, alerts: advisories })
    const firstOut = [...object.alerts].filter(alert => alert.firstOut !== undefined).sort((left, right) => left.firstOut!.rank - right.firstOut!.rank)[0]
    const lead = await run.port.read({ lead: { objectId: object.id, count: 6 } })
    const refs = [...lead.observations].sort((left, right) => (left.rank ?? Infinity) - (right.rank ?? Infinity)).map(observation => observation.ref)
    const counts = [...(unacknowledged > 0 ? [`${unacknowledged} unacknowledged`] : []), ...(standing > 0 ? [`${standing} standing`] : []), `worst ${worst === undefined ? '' : worstWord(worst)}`]
    return fitted([
      `- ${object.id} · ${object.label} · ${statusOf(object)}`,
      ...(object.alerts.length === 0 ? ['no alerts'] : []),
      ...(worst === undefined ? [] : [`alerts ${alarms.length} (${counts.join(', ')}): ${worst.message}${worst === firstOut ? ' (first out)' : ''}`]),
      ...(advised === undefined ? [] : [`${advisories.length} ${advisories.length === 1 ? 'advisory' : 'advisories'} in force (worst ${worstWord(advised)}): ${advised.message}`]),
      ...(firstOut !== undefined && firstOut !== worst ? [`first out: ${firstOut.message}`] : []),
    ], lead.refused.length > 0 ? [] : refs, (kept, dropped) => lead.refused.length > 0 ? `lead values refused: ${lead.refused[0]!.refused.code}`
      : kept.length + dropped === 0 ? 'lead: none declared' : `lead: ${[...kept, ...(dropped > 0 ? [`+${dropped} refs`] : [])].join(', ')}`)
  }))

  const others = visible.filter(object => !assets.includes(object))
  const categories = new Map<string, { readonly label: string; readonly objects: OperationalObject[] }>()
  for (const object of others) {
    const shown = presented.get(object.id)
    const key = `${object.packId}\u0000${shown?.category?.id ?? ''}`
    const entry = categories.get(key) ?? { label: `${shown?.category?.label ?? 'Uncategorised'} (${object.packId})`, objects: [] }
    entry.objects.push(object)
    categories.set(key, entry)
  }
  const categoryLines = [...categories.values()].map(({ label, objects }) => {
    const words = new Map<string, number>()
    for (const object of objects) words.set(statusOf(object), (words.get(statusOf(object)) ?? 0) + 1)
    const worst = byWorst(objects.filter(object => object.alerts.length > 0)).slice(0, 3)
    return fitted([`- ${label}: ${objects.length}`, [...words].map(([word, count]) => `${word} ${count}`).join(', ')],
      worst.map(object => `${object.id} ${object.label} (${worstWord(worstOf(object)!)})`),
      (kept, dropped) => kept.length + dropped === 0 ? '' : `worst: ${[...kept, ...(dropped > 0 ? [`+${dropped}`] : [])].join('; ')}`)
  })
  const recordLines = run.packs.filter(pack => pack.presentation.categories.length === 0)
    .map(pack => line(`- ${pack.descriptor.name} (${pack.descriptor.id}): records, no operational objects`))
  const guidanceLines = run.packs.flatMap(pack => pack.knowledge?.guidance === undefined ? [] : [`\`\`\`guidance ${pack.descriptor.id}: ${pack.knowledge.guidance}\`\`\``])
  const hidden = run.objects.length - visible.length
  const tail = [
    'Dashboards: none stored (cannot change dashboards yet)',
    ...guidanceLines,
    ...(hidden > 0 ? [`${hidden} objects hidden by this Run's AI restrictions`] : []),
  ]
  // Categories give way first, named by count, so assets, guidance and the hidden count always fit.
  let kept = categoryLines.length
  const compose = (): string => {
    const dropped = categoryLines.length - kept
    return [header, ...assetLines, ...categoryLines.slice(0, kept), ...(dropped > 0 ? [`+${dropped} more categories (observables.search finds their objects)`] : []), ...recordLines, ...tail].join('\n')
  }
  while (kept > 0 && (compose().length > maxChars || compose().split('\n').length > maxLines)) kept -= 1
  return { text: compose(), at: run.clock?.currentTime ?? new Date().toISOString(), clock: run.clock === undefined ? 'wall' : 'simulation' }
}
