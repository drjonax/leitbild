<script lang="ts">
  import { untrack } from 'svelte'
  import type { ComposedDisplayPen } from '../../../../packs/process-plant/displays/compose.ts'
  import { shownReading } from '../../../../packs/process-plant/quantity-text.ts'
  import { rateWindowMs, trendReading } from '../../../../packs/process-plant/displays/trend-reading.ts'
  import type { ProcessPlantProposal, ProposalReview } from '../../../../packs/process-plant/operations/proposals.ts'
  import { sampledGates } from '../panel-presenters.ts'
  import type { MimicQuickLookSource, QuickLookState } from '../mimic/quick-look-source.ts'
  import { evidenceMargin, proposalCard, type EvidenceMargin, type ListedItem, type OperationNow } from './operation-presenter.ts'
  import ProposalSection from './ProposalSection.svelte'

  // A proposal's card on its item, pinned (plan §4.4, QA-9). Each cited
  // reading the display draws with its limits (a lead value's pen) is read
  // while the card is open, as its quick look reads it: its sparkline, and
  // World's margin to the limit it heads for, which ranks the card and the
  // window's list; never any urgency the proposer gave.

  type Outcome = { readonly ok: true } | { readonly ok: false; readonly reason: string }

  let { proposal, review, item, now, stale = false, looks, approve, reject, extend, useAsDraft }: {
    proposal: ProcessPlantProposal
    /** The page's samples are stale: its decisions are disabled. */
    stale?: boolean
    review: ProposalReview | null
    item: ListedItem
    now: OperationNow
    /** The display's lead-value pens and the Run to read them from; undefined where it has none (an answer's display). */
    looks: { readonly source: MimicQuickLookSource; readonly pens: ReadonlyArray<ComposedDisplayPen>; readonly sparklineMs: number } | undefined
    approve: () => Promise<Outcome>
    reject: (reason: string | null) => Promise<Outcome>
    extend: () => Promise<Outcome>
    useAsDraft: () => void
  } = $props()

  const cited = $derived(looks === undefined ? [] : proposal.evidence.flatMap(entry => {
    const pen = looks.pens.find(candidate => String(candidate.path) === String(entry.path))
    return pen === undefined ? [] : [{ tagId: String(entry.tagId), pen }]
  }))
  // Read while the card is open; opened again only when the readings it cites change.
  const citedKey = $derived(cited.map(entry => String(entry.pen.path)).join('|'))
  let shown = $state.raw<QuickLookState>({ kind: 'loading' })
  $effect(() => {
    void citedKey
    const open = untrack(() => ({ looks, pens: cited.map(entry => entry.pen) }))
    if (open.looks === undefined || open.pens.length === 0) return
    return open.looks.source.open({ pens: open.pens, sparklineMs: open.looks.sparklineMs }, next => { shown = next })
  })

  const latest = $derived(shown.kind === 'shown' ? shown.latest : undefined)
  const pointsOf = (pen: ComposedDisplayPen) => (shown.kind === 'shown' ? shown.history.series.get(String(pen.path)) ?? [] : []).map(point => ({ t: point.t, v: shownReading(point.v, pen.resolution) }))
  const valueOf = (pen: ComposedDisplayPen): number | undefined => {
    const value = latest?.values.find(entry => entry.path === String(pen.path))?.value
    return typeof value === 'number' ? shownReading(value, pen.resolution) : undefined
  }
  // The margin reads no alarm state: only which limits act now (mode and gates) and where the reading heads.
  const margins = $derived(looks === undefined ? [] : cited.flatMap(({ tagId, pen }): ReadonlyArray<EvidenceMargin> => {
    const value = valueOf(pen)
    if (value === undefined) return []
    const reading = trendReading({
      value,
      points: pen.recorded ? pointsOf(pen) : null,
      windowMs: rateWindowMs(looks.sparklineMs),
      unit: pen.unit,
      thresholds: pen.thresholds,
      mode: latest?.mode,
      gates: sampledGates(latest),
      activeRuleIds: new Set(),
      resolution: pen.resolution,
      ...(pen.limits?.instrumentSpan === undefined ? {} : { span: pen.limits.instrumentSpan }),
    })
    const margin = evidenceMargin(tagId, reading, pen.unit, pen.resolution)
    return margin === null ? [] : [margin]
  }))
  const histories = $derived(looks === undefined || latest === undefined ? {} : Object.fromEntries(cited
    .filter(entry => entry.pen.recorded && entry.pen.valueKind === 'number')
    .map(entry => [entry.tagId, { pen: entry.pen, points: pointsOf(entry.pen), windowMs: looks.sparklineMs, now: Date.parse(latest.simulationTime) }])))
  const card = $derived(proposalCard(proposal, review, item, margins, now))
</script>

<ProposalSection {card} {histories} {stale} {approve} {reject} {extend} {useAsDraft} />
