/** What a composed display carries, and whether it carries a scenario's
 * decisive evidence: semantic (a key names a quantity by any of its tags or
 * paths, resolved to one signal) and mimic-aware (a mimic that draws the
 * component a signal is measured on carries it). Each hit says who put it
 * there: the agent's own composition, World (with its evidence kind), the
 * mimic, or only the answer's words. */
import type { EvidenceKey } from './scenarios.ts'
import type { PlantCatalog } from './plant-catalog.ts'

/** One display.compose call of a turn, as the probe reads it from execution evidence. */
export interface ComposeRecord {
  readonly input: any
  readonly result: any
}

export interface ShownSignal { readonly path: string; readonly tagId?: string; readonly name?: string }
export interface AddedEvidence { readonly path: string; readonly kind: string; readonly reason?: string }

export interface DisplayEvidence {
  /** Every signal name the agent wrote into its panels or subjects. */
  readonly agentNames: ReadonlySet<string>
  /** Equipment the agent named in mimic intents or subjects. */
  readonly agentEquipment: ReadonlySet<string>
  /** Every signal the display shows (the compose result's signals). */
  readonly shown: ReadonlyArray<ShownSignal>
  /** Values World added, with why (the view state's evidence). */
  readonly added: ReadonlyArray<AddedEvidence>
  /** Equipment a mimic draws (the compose result's equipment). */
  readonly drawn: ReadonlySet<string>
  readonly panels: ReadonlyArray<string>
  /** Each shown value as the display writes it (its viewContent value at its precision), by every name of the item. */
  readonly shownValues: ReadonlyMap<string, ReadonlyArray<string>>
  /** A World vignette's full refs (objectId#signal) and the objects it shows, so a key naming either is carried. */
  readonly refs?: ReadonlySet<string>
  readonly objects?: ReadonlySet<string>
}

const MIMIC_EQUIPMENT_FIELDS = ['from', 'to', 'around', 'exclude'] as const

/** The display an accepted compose call produced. */
export const displayEvidenceOf = (record: ComposeRecord): DisplayEvidence => {
  const panels = (record.input?.panels ?? []) as ReadonlyArray<Record<string, any>>
  const agentNames = new Set<string>()
  const agentEquipment = new Set<string>()
  for (const panel of panels) {
    for (const entry of panel.signals ?? []) if (typeof entry?.ref === 'string') agentNames.add(entry.ref)
    if (panel.kind === 'mimic') for (const field of MIMIC_EQUIPMENT_FIELDS) for (const name of panel[field] ?? []) if (typeof name === 'string') agentEquipment.add(name)
  }
  for (const subject of record.input?.subjects ?? []) if (typeof subject === 'string') { agentNames.add(subject); agentEquipment.add(subject) }
  const data = record.result?.data ?? {}
  const shown = ((data.signals ?? []) as ReadonlyArray<any>).map(entry => ({
    path: String(entry.path),
    ...(typeof entry.tagId === 'string' ? { tagId: entry.tagId } : {}),
    ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
  }))
  const state = typeof data.view?.state === 'string' ? JSON.parse(data.view.state) : {}
  const added = ((state.evidence ?? []) as ReadonlyArray<any>).map(entry => ({
    path: String(entry.path), kind: String(entry.kind), ...(typeof entry.reason === 'string' ? { reason: entry.reason } : {}),
  }))
  const drawn = new Set(((data.equipment ?? []) as ReadonlyArray<any>).map(entry => String(entry.id)))
  const shownValues = new Map<string, ReadonlyArray<string>>()
  for (const item of (data.viewContent?.items ?? []) as ReadonlyArray<any>) {
    const written = ((item.values ?? []) as ReadonlyArray<any>).flatMap(entry => typeof entry.value === 'number' && Number.isInteger(entry.decimals) ? [entry.value.toFixed(entry.decimals)] : [])
    if (written.length > 0) for (const name of item.names ?? []) if (typeof name === 'string') shownValues.set(name, written)
  }
  return { agentNames, agentEquipment, shown, added, drawn, panels: panels.map(panel => String(panel.kind)), shownValues }
}

/** The vignette an accepted world.simulation-run.display.compose call produced: what its state reads and its card shows. */
export const vignetteEvidenceOf = (record: ComposeRecord): DisplayEvidence => {
  const data = record.result?.data ?? {}
  const state = typeof data.view?.state === 'string' ? JSON.parse(data.view.state) : { views: [] }
  const views = (state.views ?? []) as ReadonlyArray<Record<string, any>>
  const items = (data.card?.items ?? []) as ReadonlyArray<Record<string, any>>
  const refs = new Set<string>([...views.flatMap(view => (view.refs ?? []) as ReadonlyArray<string>), ...items.flatMap(item => typeof item.subject?.ref === 'string' ? [item.subject.ref as string] : [])])
  const objects = new Set<string>([
    ...views.flatMap(view => [...(Array.isArray(view.objectIds) ? view.objectIds : []), ...(typeof view.objectId === 'string' ? [view.objectId] : []), ...(typeof view.around === 'string' ? [view.around] : [])] as ReadonlyArray<string>),
    ...items.flatMap(item => typeof item.subject?.objectId === 'string' ? [item.subject.objectId as string] : []),
    ...[...refs].map(ref => ref.split('#')[0]!),
    // A live collection is named by its Pack and category ("of:ambulance/incidents").
    ...views.flatMap(view => view.of !== undefined ? [`of:${view.of.packId}/${view.of.categoryId}`] : []),
  ])
  const agentNames = new Set<string>()
  for (const subject of record.input?.subjects ?? []) if (typeof subject === 'string') agentNames.add(subject)
  for (const view of record.input?.views ?? []) for (const field of ['signals', 'from', 'to', 'around', 'media', 'groups']) for (const name of view?.[field] ?? []) if (typeof name === 'string') agentNames.add(name)
  // A plant signal is matched by its path (the part after '#') or its full ref.
  const shown = [...refs].map(ref => ({ path: ref.slice(ref.indexOf('#') + 1), name: ref }))
  const added = shown.filter(entry => !agentNames.has(entry.name) && !agentNames.has(entry.path)).map(entry => ({ path: entry.path, kind: 'world' }))
  const shownValues = new Map<string, ReadonlyArray<string>>()
  for (const item of items) {
    const written = ((item.numbers ?? []) as ReadonlyArray<any>).flatMap(entry => typeof entry.value === 'number' && Number.isInteger(entry.decimals) ? [entry.value.toFixed(entry.decimals)] : [])
    const ref = item.subject?.ref
    if (written.length > 0 && typeof ref === 'string') shownValues.set(ref.slice(ref.indexOf('#') + 1), written)
  }
  return { agentNames, agentEquipment: new Set(), shown, added, drawn: new Set(), panels: views.map(view => String(view.kind)), shownValues, refs, objects }
}

export type HitSource = 'agent' | 'world' | 'mimic' | 'answer'
export interface NameHit { readonly name: string; readonly by: HitSource; readonly worldKind?: string }
export interface KeyResult {
  readonly key: string
  readonly kind: EvidenceKey['kind']
  readonly use: EvidenceKey['use']
  /** null for claim and absence keys: they wait for a calibrated judge. */
  readonly hit: boolean | null
  readonly by?: HitSource
  readonly hits: ReadonlyArray<NameHit>
  /** Names the key holds that the Plant does not have (a stale key). */
  readonly unknown: ReadonlyArray<string>
}

const RANK: Readonly<Record<HitSource, number>> = { agent: 0, world: 1, mimic: 2, answer: 3 }

/** The prose of an answer without its fenced blocks. */
export const answerProse = (content: string): string => content.replace(/```[\s\S]*?(?:```|$)/g, ' ')

const mentions = (prose: string, name: string): boolean => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![A-Za-z0-9-])${escaped}(?![A-Za-z0-9-])`).test(prose)
}

/** The signal names a key holds: its own list, or the tags and paths written into its text. */
export const keyNames = (key: EvidenceKey, catalog: PlantCatalog): ReadonlyArray<string> => {
  if (key.signals !== undefined) return key.signals
  const found: string[] = []
  let text = key.key
  for (const name of catalog.names) {
    if (!mentions(text, name)) continue
    found.push(name)
    text = text.split(name).join(' ')
  }
  return found
}

/**
 * Scores one key against the display the answer presented (null when it
 * presented none) and the answer's prose. Only signal keys are scored.
 */
export const scoreKey = (key: EvidenceKey, display: DisplayEvidence | null, content: string, catalog: PlantCatalog): KeyResult => {
  const base = { key: key.key, kind: key.kind, use: key.use }
  if (key.kind !== 'signal') return { ...base, hit: null, hits: [], unknown: [] }
  const names = keyNames(key, catalog)
  const unknown = names.filter(name => catalog.signal(name) === undefined && !name.includes(':'))
  const prose = answerProse(content)
  const hitOf = (name: string): NameHit | null => {
    const signal = catalog.signal(name)
    // A vignette carries a key that names one of its refs or objects exactly.
    if (signal === undefined && display !== null && (display.refs?.has(name) === true || display.objects?.has(name) === true)) return { name, by: display.agentNames.has(name) ? 'agent' : 'world' }
    if (signal === undefined) return mentions(prose, name) ? { name, by: 'answer' } : null
    if (display !== null) {
      const shown = display.shown.find(entry => entry.path === signal.path)
      if (shown !== undefined) {
        const byAgent = display.agentNames.has(signal.path) || (signal.tagId !== undefined && display.agentNames.has(signal.tagId))
        if (byAgent) return { name, by: 'agent' }
        const added = display.added.find(entry => entry.path === signal.path)
        return { name, by: 'world', ...(added === undefined ? {} : { worldKind: added.kind }) }
      }
      if (display.drawn.has(signal.component)) return { name, by: 'mimic' }
    }
    if ((signal.tagId !== undefined && mentions(prose, signal.tagId)) || mentions(prose, signal.path)) return { name, by: 'answer' }
    return null
  }
  const hits = names.flatMap(name => { const hit = hitOf(name); return hit === null ? [] : [hit] })
  const hit = names.length > 0 && (key.match === 'all' ? hits.length === names.length : hits.length > 0)
  const best = hits.reduce<NameHit | undefined>((left, right) => left === undefined || RANK[right.by] < RANK[left.by] ? right : left, undefined)
  return { ...base, hit, ...(hit && best !== undefined ? { by: best.by } : {}), hits, unknown }
}

const quotesNumber = (prose: string, written: string): boolean => new RegExp(`(?<![0-9.,])${written.replace('.', '\\.')}(?![0-9])`).test(prose)

/**
 * Every World-added value of a display, by evidence kind, and whether the
 * answer uses it: names it (tag, path or shown name), or quotes its value as
 * the display writes it.
 */
export const addedEvidenceUse = (display: DisplayEvidence, content: string): ReadonlyArray<{ readonly kind: string; readonly path: string; readonly cited: boolean; readonly citedBy?: 'name' | 'value' }> => {
  const prose = answerProse(content)
  return display.added.map(entry => {
    const shown = display.shown.find(signal => signal.path === entry.path)
    const names = [entry.path, ...(shown?.tagId === undefined ? [] : [shown.tagId]), ...(shown?.name === undefined ? [] : [shown.name])]
    if (names.some(name => mentions(prose, name))) return { kind: entry.kind, path: entry.path, cited: true, citedBy: 'name' as const }
    const values = display.shownValues.get(entry.path) ?? []
    return values.some(written => quotesNumber(prose, written)) ? { kind: entry.kind, path: entry.path, cited: true, citedBy: 'value' as const } : { kind: entry.kind, path: entry.path, cited: false }
  })
}
