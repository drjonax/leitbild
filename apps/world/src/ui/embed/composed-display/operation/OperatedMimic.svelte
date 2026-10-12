<script lang="ts">
  import { untrack } from 'svelte'
  import type { CompiledMimic, MimicDrawnItem } from '../../../../packs/process-plant/displays/mimic/mimic-model.ts'
  import type { MimicQuickLooks } from '../../../../packs/process-plant/displays/mimic/quick-look.ts'
  import type { DisplayAnnunciation } from '../../../../packs/process-plant/displays/annunciators.ts'
  import type { ProcessVariableValue, VariablePath } from '../../../../packs/process-plant/graph/index.ts'
  import type { ProcessPlantProposal, ProposalReview as Review } from '../../../../packs/process-plant/operations/proposals.ts'
  import type { ComposedDisplaySample } from '../composed-display-client.ts'
  import MimicPanel from '../mimic/MimicPanel.svelte'
  import type { MimicPopoverContext, MimicPopoverSection } from '../mimic/popover.ts'
  import type { MimicQuickLookSource } from '../mimic/quick-look-source.ts'
  import ControlSection from './ControlSection.svelte'
  import type { DisplayOperation, OperationOutcome } from './operation-client.ts'
  import { itemBadges, itemControlView, operationNow, shownProposal, type ItemBadges, type ListedItem, type OperationNow } from './operation-presenter.ts'
  import ProposalReview from './ProposalReview.svelte'

  // A drawing operated in the process display window (plan §4.2-§4.4, §12):
  // the popover a press on an item's dot opens adds its PROPOSAL (order 10)
  // and CONTROL (order 15) sections above its quick look, and its symbol
  // carries its operation badges. Hovering a dot shows the quick look only,
  // never a command. Pinned as an overlay, the controls fold away until a
  // person opens them. World derives what may be operated and where it
  // stands (controls.list, read with every sample); a command goes through
  // World's one validated queued write path as this screen's actor
  // (control.write), a decision on a proposal through control.decide. Never
  // drawn in a chat: there the drawing has no controls.
  let { mimic, latest, stale, open, highlight = null, annunciation, quickLook, operation }: {
    mimic: CompiledMimic
    latest: ComposedDisplaySample | undefined
    stale: boolean
    open: ((item: MimicDrawnItem) => void) | undefined
    highlight?: ReadonlySet<string> | null
    annunciation: DisplayAnnunciation
    quickLook: { readonly source: MimicQuickLookSource; readonly looks: MimicQuickLooks } | undefined
    operation: DisplayOperation
  } = $props()

  type Write = { readonly path: VariablePath; readonly value: ProcessVariableValue }

  let listed = $state.raw<ReadonlyMap<string, ListedItem> | null>(null)
  let units = $state.raw<ReadonlyMap<string, string>>(new Map())
  let reviews = $state.raw<ReadonlyMap<string, Review>>(new Map())
  let failure = $state<string | null>(null)
  // The commands this screen issued: another screen's travelling command locks an item; its own does not.
  let ownCommands = $state.raw<ReadonlySet<string>>(new Set())
  // The item whose command is selected: its symbol shows activated.
  let selected = $state<string | null>(null)
  // A proposal used as a draft: CONTROL opens with its command selected, as this person's own.
  let draft = $state.raw<{ readonly item: string; readonly write: Write; readonly at: number } | null>(null)
  let pin = $state.raw<{ readonly item: string } | null>(null)

  const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)
  /**
   * The ids World names a drawn item's equipment by (display.compose, controls.list): a bundled device as
   * "<host>.<device>", a component by its id, each member of a group by its own.
   */
  const composeIds = (item: MimicDrawnItem): ReadonlyArray<string> =>
    item.binding.item.kind === 'device' ? [`${item.components[0]}.${item.binding.item.device}`] : item.components

  /**
   * Which drawn item stands for each of World's operable items here: its own symbol, or, for a device its host bundles
   * that this drawing does not draw on its own (a pressurizer's relief and block valves on a unit overview), its host's
   * symbol, so every operable item on the drawing can be reached from a dot (QA-7). Read once from controls.list.
   */
  let owners = $state.raw<ReadonlyMap<string, string> | null>(null)
  let ownersDrawn: CompiledMimic | null = null
  const ownersOf = (items: ReadonlyArray<ListedItem>): ReadonlyMap<string, string> => {
    const owned = new Map<string, string>()
    for (const item of mimic.items) for (const id of composeIds(item)) owned.set(id, item.id)
    for (const entry of items) {
      if (owned.has(entry.id) || entry.components.length !== 1 || entry.id === entry.components[0]) continue
      const host = mimic.items.find(item => item.binding.item.kind === 'component' && item.components.length === 1 && item.components[0] === entry.components[0])
        ?? mimic.items.find(item => item.binding.item.kind === 'component' && item.components.includes(entry.components[0]!))
      if (host !== undefined) owned.set(entry.id, host.id)
    }
    return owned
  }
  const ownerOf = (id: string): MimicDrawnItem | undefined => {
    const drawn = owners?.get(id)
    return drawn === undefined ? undefined : mimic.items.find(item => item.id === drawn)
  }
  const proposals = $derived<ReadonlyArray<ProcessPlantProposal>>(stale ? [] : latest?.operations?.proposals ?? [])
  const controlPaths = (items: Iterable<ListedItem>): ReadonlyArray<string> =>
    [...new Set([...items].flatMap(item => item.offered.flatMap(entry => [String(entry.control.path), ...(entry.control.state === undefined ? [] : [String(entry.control.state)])])))]

  // What each drawn item offers, where its rules stand, and the units its values and its proposals' readings are written in,
  // read again with every sample; one reading at a time.
  let reading = false
  const refresh = async (): Promise<void> => {
    if (reading) return
    reading = true
    try {
      // Once per drawing: a display opened in place draws another.
      const drawing = mimic
      const known = owners !== null && ownersDrawn === drawing ? owners : ownersOf((await operation.client.controls(operation.runId, operation.plantId, null)).items)
      owners = known
      ownersDrawn = drawing
      const result = await operation.client.controls(operation.runId, operation.plantId, [...known.keys()])
      const next = new Map(result.items.map(item => [item.id, item]))
      const paths = controlPaths(next.values())
      operation.sampled(paths)
      const cited = proposals.flatMap(proposal => proposal.evidence.map(entry => String(entry.path)))
      const missing = [...new Set([...paths, ...cited])].filter(path => !units.has(path))
      if (missing.length > 0) units = new Map([...units, ...await operation.client.units(operation.runId, operation.plantId, missing as ReadonlyArray<VariablePath>)])
      // World's review of each pending proposal drawn here: whether the I&C allows it now, how its readings moved.
      reviews = proposals.some(proposal => proposal.status === 'pending')
        ? new Map((await operation.client.proposals(operation.runId, operation.plantId)).proposals.flatMap(entry => entry.review === undefined ? [] : [[entry.proposal.id, entry.review] as const]))
        : new Map()
      listed = next
      failure = null
    } catch (error) {
      failure = `Controls cannot be read: ${messageOf(error)}`
    } finally {
      reading = false
    }
  }
  $effect(() => {
    if (latest === undefined) return
    untrack(() => { void refresh() })
  })

  // The Plant as the latest sample reads it, once every value it writes has its unit.
  const now = $derived.by((): OperationNow | null => {
    if (latest === undefined || listed === null) return null
    const needed = [...controlPaths(listed.values()), ...proposals.flatMap(proposal => proposal.evidence.map(entry => String(entry.path)))]
    return needed.every(path => units.has(path)) ? operationNow(latest, units) : null
  })

  /** What a drawn item offers: its equipment's controls, a group's members' and its undrawn bundled devices' together. */
  const listedOf = (item: MimicDrawnItem): ListedItem | undefined => {
    if (listed === null || owners === null) return undefined
    const members = [...listed.values()].filter(entry => owners!.get(entry.id) === item.id)
    if (members.length <= 1) return members[0]
    return {
      id: members.map(member => member.id).join('+'),
      label: item.binding.label,
      components: [...new Set(members.flatMap(member => member.components))],
      offered: members.flatMap(member => member.offered),
      withheld: members.flatMap(member => member.withheld),
    }
  }

  const badges = $derived.by((): ReadonlyMap<string, ItemBadges> | undefined => {
    if (stale || now === null || listed === null || latest?.operations === undefined) return undefined
    const operations = latest.operations
    const carried = new Map<string, ItemBadges>()
    for (const item of mimic.items) {
      const entry = listedOf(item)
      if (entry === undefined || entry.offered.length === 0) continue
      // A proposal names one piece of equipment; on a symbol that stands for several it is one of theirs.
      const shown = itemBadges(entry, { operations: operations.log, proposals: operations.proposals.filter(proposal => owners?.get(proposal.item) === item.id).map(proposal => ({ ...proposal, item: entry.id })), ownCommands, now })
      if (shown.progress !== null || shown.attribution !== null || shown.proposal !== null || shown.interlock !== null || shown.commandLocked !== null) carried.set(item.id, shown)
    }
    return carried
  })

  // Opened on equipment, the display pins the popover of a pending proposal it draws, the one that lapses first; once
  // each time the window shows it, never while the person works on it (QA-10).
  let armed: string | null = null
  $effect(() => {
    const opening = operation.review
    if (opening === null || opening === armed || now === null || listed === null || latest === undefined) return
    // Not before the samples read the controls' paths: only then do they carry the proposals on them.
    const sampled = new Set(latest.values.map(entry => entry.path))
    if (!controlPaths(listed.values()).every(path => sampled.has(path))) return
    armed = opening
    const drawn = (proposal: ProcessPlantProposal): MimicDrawnItem | undefined => ownerOf(proposal.item)
    const pending = untrack(() => proposals)
      .filter(proposal => proposal.status === 'pending' && drawn(proposal) !== undefined)
      .sort((left, right) => left.expiresAtElapsedMs - right.expiresAtElapsedMs)[0]
    pin = pending === undefined ? null : { item: drawn(pending)!.id }
  })

  const execute = async (write: Write): Promise<OperationOutcome> => {
    const outcome = await operation.client.write(operation.runId, operation.plantId, write)
    if (outcome.ok) ownCommands = new Set([...ownCommands, outcome.commandId])
    return outcome
  }
  const validate = (write: Write) => operation.client.validate(operation.runId, operation.plantId, write)
  const decide = async (proposal: ProcessPlantProposal, decision: 'approve' | 'reject' | 'extend', reason: string | null = null): Promise<OperationOutcome> => {
    const outcome = await operation.client.decide(operation.runId, operation.plantId, proposal.id, decision, reason)
    // The approval's command executes the stored write: it travels as this screen's own.
    if (outcome.ok) ownCommands = new Set([...ownCommands, outcome.commandId])
    return outcome
  }

  /** The proposal a drawn item's popover shows: a pending one on its equipment first, else the one that closed last. */
  const proposalOf = (item: MimicDrawnItem): ProcessPlantProposal | undefined => {
    if (now === null || listedOf(item) === undefined || owners === null) return undefined
    const shown = [...owners].filter(([, drawn]) => drawn === item.id).flatMap(([id]) => shownProposal(id, proposals, now!) ?? [])
    return shown.find(proposal => proposal.status === 'pending') ?? shown.sort((left, right) => (right.closed?.atElapsedMs ?? 0) - (left.closed?.atElapsedMs ?? 0))[0]
  }
  const lookPens = $derived(quickLook === undefined ? undefined : { source: quickLook.source, pens: quickLook.looks.pens, sparklineMs: quickLook.looks.sparklineMs })

  const sections = $derived<ReadonlyArray<MimicPopoverSection>>([
    { id: 'proposal', title: 'Proposal', order: 10, modes: ['operate'], applies: item => proposalOf(item) !== undefined, body: proposalBody },
    {
      id: 'control',
      title: 'Control',
      // Above the quick look's rows, in the popover a press opens (vessel-design §C); a hover shows the rows only.
      order: 15,
      modes: ['operate'],
      applies: item => {
        const entry = listedOf(item)
        return now !== null && entry !== undefined && (entry.offered.length > 0 || entry.withheld.length > 0)
      },
      body: controlBody,
    },
  ])
</script>

{#snippet controlBody(context: MimicPopoverContext)}
  {@const entry = listedOf(context.item)}
  {#if entry !== undefined && now !== null}
    {@const view = itemControlView(entry, now)}
    {@const drafted = draft !== null && draft.item === entry.id ? draft : null}
    {#if context.pinned}
      <!-- A pinned overlay monitors: its controls fold away above its rows until a person opens them. -->
      <details class="folded" open={drafted !== null}>
        <summary>{view.controls.length === 0 ? 'Not operated here' : view.controls.map(control => control.target).join(' · ')}</summary>
        {#key `${entry.id}|${drafted?.at ?? ''}`}
          <ControlSection {view} {now} {validate} {execute} draft={drafted?.write ?? null} onSelected={path => { selected = path === null ? null : entry.id }} acceptedAt={commandId => latest?.operations?.log.find(record => record.commandId === commandId)?.elapsedMs} />
        {/key}
      </details>
    {:else}
      {#key `${entry.id}|${drafted?.at ?? ''}`}
        <ControlSection {view} {now} {validate} {execute} draft={drafted?.write ?? null} onSelected={path => { selected = path === null ? null : entry.id }} acceptedAt={commandId => latest?.operations?.log.find(record => record.commandId === commandId)?.elapsedMs} />
      {/key}
    {/if}
  {/if}
{/snippet}

{#snippet proposalBody(context: MimicPopoverContext)}
  {@const entry = listedOf(context.item)}
  {@const proposal = proposalOf(context.item)}
  {#if entry !== undefined && proposal !== undefined && now !== null}
    <ProposalReview
      {proposal}
      review={reviews.get(proposal.id) ?? null}
      item={entry}
      {now}
      looks={lookPens}
      approve={() => decide(proposal, 'approve')}
      reject={reason => decide(proposal, 'reject', reason)}
      extend={() => decide(proposal, 'extend')}
      useAsDraft={() => { draft = { item: entry.id, write: proposal.write, at: Date.now() } }}
    />
  {/if}
{/snippet}

<MimicPanel {mimic} {latest} {stale} {open} {highlight} {annunciation} {quickLook} {sections} {badges} {selected} {pin} />
{#if failure !== null}<p class="failure" role="status">{failure}</p>{/if}

<style>
  .folded summary { cursor: pointer; font-size: 11.5px; color: var(--element-neutral-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .failure { margin: 2px 0 0; font-size: 11.5px; color: var(--element-active-color); }
</style>
