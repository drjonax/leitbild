<script lang="ts">
  import type { PackElementActionsProps } from '../../../../../core/packs/protocol.ts'
  import type { ProcessVariableValue, VariablePath } from '../../../graph/index.ts'
  import type { ProcessPlantProposal, ProposalReview } from '../../../operations/proposals.ts'
  import { runOnMount } from '../../../../../ui/svelte-lifecycle.svelte.ts'
  import ControlSection from './ControlSection.svelte'
  import ProposalSection from './ProposalSection.svelte'
  import { operationClient, type OperationOutcome, type PlantRead } from './operation-client.ts'
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
      read = paths.length === 0 ? null : await client.read(runId, objectId, paths)
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
  runOnMount(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, READ_EVERY_MS)
    return () => clearInterval(timer)
  })

  const stale = $derived(failure !== null)
  const now = $derived.by((): OperationNow | null => read === null ? null : operationNow(read.sample, read.units))
  const proposal = $derived(now === null ? undefined : shownProposal(elementId, proposals, now))
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
