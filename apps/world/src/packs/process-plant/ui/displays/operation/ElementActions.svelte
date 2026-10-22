<script lang="ts">
  import { recordingSeriesIdFor } from '../../../../../core/model/index.ts'
  import type { PackElementActionsProps } from '../../../../../core/packs/protocol.ts'
  import { appendPoint, HOLD_GAP_MS, readHistory, sparkline, sparklineText, type TrendPoint } from '../../plant-card-sparkline.ts'
  import type { ProcessVariableValue, VariablePath } from '../../../graph/index.ts'
  import type { ProcessPlantProposal, ProposalReview } from '../../../operations/proposals.ts'
  import { runOnMount } from '../../../../../ui/svelte-lifecycle.svelte.ts'
  import ControlSection from './ControlSection.svelte'
  import ProposalSection from './ProposalSection.svelte'
  import { operationClient, type OperationOutcome, type PlantRead } from './operation-client.ts'
  import { citedMargin, ratePerMinute, type CitedReading } from './cited-reading.ts'
  import { itemControlView, operationNow, proposalCard, shownProposal, type ListedItem, type ListedReset, type OperationNow } from './operation-presenter.ts'

  // The Plant's actions on one element, in a display's element pop-over (the
  // embed contribution ui/embed.ts): the item of equipment the element is (a
  // component, or a device it bundles drawn as its own node), its
  // proposal card while one is pending or just closed, its CONTROL section
  // and the RESETs of the actuations holding it, select-check-execute as the
  // drawing's popover always offered them. World derives what may be operated
  // and where it stands (controls.list); a command goes through World's one
  // validated queued write path as this screen's actor (control.write), a
  // decision on a proposal through control.decide. It reads the Run every
  // second while open: controls.list, control.proposals, and signals.read
  // with its operations on the paths its controls and proposals write and
  // cite. A read that fails disables every control and says so, until the
  // next one succeeds.

  let { runId, objectId, elementId }: PackElementActionsProps = $props()

  type Write = { readonly path: VariablePath; readonly value: ProcessVariableValue }
  const READ_EVERY_MS = 1_000
  const client = operationClient

  // Whether the element is an item the Plant operates, once controls.list has said; null before.
  let operated = $state<boolean | null>(null)
  let item = $state.raw<ListedItem | null>(null)
  let resets = $state.raw<ReadonlyArray<ListedReset>>([])
  let proposals = $state.raw<ReadonlyArray<ProcessPlantProposal>>([])
  let reviews = $state.raw<ReadonlyMap<string, ProposalReview>>(new Map())
  let read = $state.raw<PlantRead | null>(null)
  let failure = $state<string | null>(null)
  // A proposal used as a draft: CONTROL opens with its command selected, as this person's own.
  let draft = $state.raw<{ readonly write: Write; readonly at: number } | null>(null)

  const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)
  // What its controls write and read, what it withholds, what holds it and what its proposals cite: the read names its time.
  const pathsOf = (entry: ListedItem, holding: ReadonlyArray<ListedReset>, cited: ReadonlyArray<ProcessPlantProposal>): ReadonlyArray<string> => [...new Set([
    ...entry.offered.flatMap(control => [String(control.control.path), ...(control.control.state === undefined ? [] : [String(control.control.state)])]),
    ...entry.withheld.map(control => String(control.path)),
    ...holding.flatMap(reset => reset.holds.map(String)),
    ...cited.flatMap(proposal => proposal.evidence.map(evidence => String(evidence.path))),
  ])]

  let reading = false
  const refresh = async (): Promise<void> => {
    if (reading) return
    reading = true
    try {
      operated ??= (await client.controls(runId, objectId, null)).items.some(entry => entry.id === elementId)
      if (!operated) return
      const [listed, held] = await Promise.all([client.controls(runId, objectId, [elementId]), client.proposals(runId, objectId)])
      const entry = listed.items[0]!
      const holding = listed.resets.filter(reset => reset.items.includes(elementId))
      const own = held.proposals.map(heldEntry => heldEntry.proposal).filter(proposal => proposal.item === elementId)
      const paths = pathsOf(entry, holding, own)
      read = paths.length === 0 ? null : await client.read(runId, objectId, paths, own.length > 0)
      if (read !== null) extendHistories(read, [...new Set(own.flatMap(proposal => proposal.evidence.map(evidence => String(evidence.path))))])
      item = entry
      resets = holding
      proposals = own
      reviews = new Map(held.proposals.flatMap(heldEntry => heldEntry.review === undefined ? [] : [[heldEntry.proposal.id, heldEntry.review] as const]))
      failure = null
    } catch (error) {
      failure = `Controls cannot be read: ${messageOf(error)}`
    } finally {
      reading = false
    }
  }
  // The readings a proposal cites: what the Run's historian holds of their last ten minutes, read once, then each read's value.
  const TREND_MS = 10 * 60_000
  const SPARK = { width: 72, height: 18 } as const
  let histories = $state.raw<ReadonlyMap<string, ReadonlyArray<TrendPoint>>>(new Map())
  const extendHistories = (latest: PlantRead, cited: ReadonlyArray<string>): void => {
    const at = Date.parse(latest.sample.simulationTime)
    const next = new Map(histories)
    for (const path of cited) {
      const value = latest.sample.values.find(entry => entry.path === path)?.value
      const known = next.get(path)
      if (known === undefined) {
        void readHistory(runId, recordingSeriesIdFor(objectId, path), { from: at - TREND_MS - HOLD_GAP_MS, to: at }).then(
          recorded => { histories = new Map(histories).set(path, [...recorded, ...(histories.get(path) ?? []).filter(point => point.t > (recorded.at(-1)?.t ?? -Infinity))]) },
          error => { failure = `The history of ${path} cannot be read: ${messageOf(error)}` },
        )
      }
      if (typeof value === 'number') next.set(path, appendPoint(next.get(path) ?? [], { t: at, v: value }, at - TREND_MS))
    }
    histories = next
  }
  runOnMount(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, READ_EVERY_MS)
    return () => clearInterval(timer)
  })

  const stale = $derived(failure !== null)
  const now = $derived.by((): OperationNow | null => read === null ? null : operationNow(read.sample, read.units))
  const proposal = $derived(now === null ? undefined : shownProposal(elementId, proposals, now))
  // Each cited reading's margin to its limits and its last ten minutes, by tag (World's ranking, never the proposer's urgency).
  const cited = $derived.by((): ReadonlyMap<string, CitedReading> => {
    if (proposal === undefined || read === null || now === null) return new Map()
    const at = Date.parse(read.sample.simulationTime)
    return new Map(proposal.evidence.map(evidence => {
      const path = String(evidence.path)
      const points = histories.get(path) ?? []
      const observed = read!.observed.get(path)
      const line = sparkline(points, at, TREND_MS, SPARK)
      return [String(evidence.tagId), {
        margin: observed === undefined || observed === null ? null : citedMargin({ value: now!.read(evidence.path), unit: observed.unit, quantity: observed.quantity, thresholds: observed.thresholds, ...(observed.observation?.past === undefined ? {} : { past: observed.observation.past }), ratePerMinute: ratePerMinute(points) }),
        line: line === null || observed === undefined || observed === null ? null : { ...line, text: sparklineText(line, TREND_MS, observed.unit) },
      }] as const
    }))
  })
  const shown = $derived(item !== null && (item.offered.length > 0 || item.withheld.length > 0 || resets.length > 0))

  const validate = (write: Write) => client.validate(runId, objectId, write)
  const execute = (write: Write): Promise<OperationOutcome> => client.write(runId, objectId, write)
  const reset = (ruleId: string): Promise<OperationOutcome> => client.reset(runId, objectId, ruleId)
  const decide = (decided: ProcessPlantProposal, decision: 'approve' | 'reject' | 'extend', reason: string | null = null): Promise<OperationOutcome> =>
    client.decide(runId, objectId, decided.id, decision, reason)
  const acceptedAt = (commandId: string): number | undefined => read?.log.find(record => record.commandId === commandId)?.elapsedMs
</script>

{#if item !== null && now !== null}
  {#if proposal !== undefined}
    <ProposalSection
      card={proposalCard(proposal, reviews.get(proposal.id) ?? null, item, now)}
      {cited}
      spark={SPARK}
      {stale}
      approve={() => decide(proposal, 'approve')}
      reject={reason => decide(proposal, 'reject', reason)}
      extend={() => decide(proposal, 'extend')}
      useAsDraft={() => { if (proposal.write !== undefined) draft = { write: proposal.write, at: Date.now() } }}
    />
  {/if}
  {#if shown}
    {#key `${item.id}|${draft?.at ?? ''}`}
      <ControlSection view={itemControlView(item, now, resets)} {now} {stale} {validate} {execute} {reset} draft={draft?.write ?? null} {acceptedAt} />
    {/key}
  {/if}
{/if}
{#if failure !== null}<p class="failure" role="status">{failure}</p>{/if}

<style>
  .failure { margin: 2px 0 0; font-size: 11.5px; color: var(--element-active-color); }
</style>
