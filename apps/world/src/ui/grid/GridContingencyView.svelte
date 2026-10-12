<script lang="ts">
  import { LocateFixed, Play, Plus, X } from 'lucide-svelte'
  import { untrack } from 'svelte'
  import type { SimulationRunId } from '../../core/model/index.ts'
  import type { GridContingencyScreenResult, GridRemedialEvaluationResult } from '../../packs/electric-grid/queries/contingency.ts'
  import {
    gridBranchOutageOptions,
    gridCandidateAction,
    gridCandidateActionText,
    gridCandidateKinds,
    gridContingencyRows,
    gridDefaultScreening,
    gridFlowModelSummary,
    gridRatingBasisLabel,
    gridRemedialComparison,
    type GridBranchOutage,
    type GridCandidateAction,
    type GridCandidateKind,
  } from '../../packs/electric-grid/ui/operator-contingency.ts'
  import { querySimulationRunCapability } from '../simulation-run-client.ts'

  interface Props {
    readonly simulationRunId: SimulationRunId
    readonly gridId: string
    /** The Grid object's revision: shown against the screened one, never a trigger to rescreen. */
    readonly revision: number
    /** The asset selected on the map or in Assets; candidate actions act on it. */
    readonly selectedAssetId: string | null
    readonly onLocate: (assetId: string) => void
  }

  const { simulationRunId, gridId, revision, selectedAssetId, onLocate }: Props = $props()

  let ratingBasis = $state<'normal' | 'emergency'>(gridDefaultScreening.ratingBasis)
  let branchOutage = $state<GridBranchOutage>(gridDefaultScreening.branchOutage)
  let screening = $state<GridContingencyScreenResult | null>(null)
  let screenedRevision = $state<number | null>(null)
  let screeningError = $state<string | null>(null)
  let running = $state(false)
  let expanded = $state<string | null>(null)

  let selected = $state<{ readonly id: string; readonly label: string; readonly kind: string } | null>(null)
  let candidateKind = $state<GridCandidateKind>('open-branch')
  let candidateValue = $state('')
  let candidateEmergency = $state(false)
  let candidates = $state<ReadonlyArray<{ readonly action: GridCandidateAction; readonly label: string }>>([])
  let candidateError = $state<string | null>(null)
  let evaluation = $state<GridRemedialEvaluationResult | null>(null)
  let evaluationError = $state<string | null>(null)
  let evaluating = $state(false)

  const rows = $derived(screening === null ? [] : gridContingencyRows(screening))
  const afterRows = $derived(evaluation === null ? [] : gridContingencyRows(evaluation))
  const comparison = $derived(evaluation === null ? [] : gridRemedialComparison(evaluation))
  const candidateSpec = $derived(gridCandidateKinds.find(spec => spec.kind === candidateKind)!)
  const request = $derived({ gridId, contingencies: gridDefaultScreening.contingencies, branchOutage, ratingBasis, limit: gridDefaultScreening.limit })

  const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

  const screen = async (): Promise<void> => {
    running = true
    const atRevision = revision
    try {
      screening = await querySimulationRunCapability<GridContingencyScreenResult>(simulationRunId, 'world.electric-grid.contingency.screen', request)
      screenedRevision = atRevision
      screeningError = null
    } catch (error) {
      screeningError = message(error)
    } finally {
      running = false
    }
  }

  const addCandidate = (): void => {
    const built = gridCandidateAction({ kind: candidateKind, assetId: selected?.id ?? '', assetKind: selected?.kind ?? null, value: candidateValue, emergency: candidateEmergency })
    if ('error' in built) {
      candidateError = built.error
      return
    }
    if (candidates.some(candidate => candidate.action.assetId === built.action.assetId)) {
      candidateError = `${selected!.label} already has a candidate action; remove it first.`
      return
    }
    candidates = [...candidates, { action: built.action, label: selected!.label }]
    candidateError = null
    evaluation = null
  }

  const removeCandidate = (assetId: string): void => {
    candidates = candidates.filter(candidate => candidate.action.assetId !== assetId)
    evaluation = null
    evaluationError = null
  }

  const evaluate = async (): Promise<void> => {
    evaluating = true
    try {
      evaluation = await querySimulationRunCapability<GridRemedialEvaluationResult>(simulationRunId, 'world.electric-grid.remedial-actions.evaluate', {
        ...request,
        actions: candidates.map(candidate => candidate.action),
      })
      evaluationError = null
    } catch (error) {
      evaluation = null
      evaluationError = `Rejected: ${message(error)}`
    } finally {
      evaluating = false
    }
  }

  // The selected asset names the candidate's target; its kind picks a fitting action.
  $effect(() => {
    const assetId = selectedAssetId
    untrack(() => {
      if (assetId === null) {
        selected = null
        return
      }
      void (async () => {
        try {
          const result = await querySimulationRunCapability<{ readonly asset: { readonly id: string; readonly label: string; readonly kind: string } }>(
            simulationRunId, 'world.electric-grid.asset.get', { gridId, assetId },
          )
          if (selectedAssetId !== assetId) return
          selected = { id: result.asset.id, label: result.asset.label, kind: result.asset.kind }
          const fitting = gridCandidateKinds.find(spec => spec.assetKind === result.asset.kind && spec.kind === candidateKind)
            ?? gridCandidateKinds.find(spec => spec.assetKind === result.asset.kind)
          if (fitting !== undefined) candidateKind = fitting.kind
        } catch (error) {
          candidateError = message(error)
        }
      })()
    })
  })
</script>

<div class="contingency-view">
  <section class="screen-controls">
    <label>Rating basis
      <select bind:value={ratingBasis}>
        <option value="emergency">Emergency rating</option>
        <option value="normal">Continuous rating</option>
      </select>
    </label>
    <label>Branch outage
      <select bind:value={branchOutage}>
        {#each gridBranchOutageOptions as option (option.value)}<option value={option.value}>{option.label}</option>{/each}
      </select>
    </label>
    <button type="button" class="primary" disabled={running} onclick={() => void screen()}><Play size={12} />{running ? 'Screening…' : 'Screen all branch outages'}</button>
  </section>

  {#if screening}
    <p class="basis">
      {screening.screenedCount.toLocaleString('en-GB')} outages screened against the {gridRatingBasisLabel(screening.ratingBasis)}, {screening.branchOutage === 'circuit' ? 'one circuit of each multi-circuit branch' : 'every circuit of each branch at once'}, at revision {screening.revision}{screenedRevision !== null && screenedRevision !== revision ? ' (the Grid has moved on; screen again for the current state)' : ''}.
      {gridFlowModelSummary(screening)}
    </p>
    <div class="summary">
      <span class:bad={screening.violatingCount > 0}>{screening.violatingCount} with overloads</span>
      <span>{screening.islandingCount} islanding</span>
      <span>{screening.totalViolations} overloads in all</span>
      <span class:bad={screening.baseCase.overloadedCount > 0}>Base case: {screening.baseCase.overloadedCount} overloaded ({gridRatingBasisLabel(screening.ratingBasis)})</span>
    </div>
    <h4>Worst contingencies</h4>
    <ul class="results">
      {#each rows as row (row.assetId)}
        <li class={row.severity}>
          <div class="result-head">
            <button type="button" class="expand" onclick={() => { expanded = expanded === row.assetId ? null : row.assetId }} aria-expanded={expanded === row.assetId}>
              <strong>{row.label}</strong>
              <small>{row.outageText} · {row.lostText} · {row.outcome}</small>
            </button>
            <button type="button" class="locate" title="Locate the outage on the map" aria-label="Locate {row.label} on the map" onclick={() => onLocate(row.assetId)}><LocateFixed size={12} /></button>
          </div>
          {#if row.worst}
            {@const worst = row.worst}
            <div class="worst">
              <span>Worst: {worst.label}</span>
              <strong class:bad={worst.overloaded}>{worst.loadingText}</strong>
              <small>from {worst.preContingencyText} · {worst.basis}</small>
              <button type="button" class="locate" title="Locate {worst.label} on the map" aria-label="Locate {worst.label} on the map" onclick={() => onLocate(worst.assetId)}><LocateFixed size={12} /></button>
            </div>
          {/if}
          {#if expanded === row.assetId && row.overloaded.length > 0}
            <ul class="violations">
              {#each row.overloaded as branch (branch.assetId)}
                <li>
                  <span>{branch.label}</span>
                  <strong class="bad">{branch.loadingText}</strong>
                  <small>{branch.basis}</small>
                  <button type="button" class="locate" title="Locate {branch.label} on the map" aria-label="Locate {branch.label} on the map" onclick={() => onLocate(branch.assetId)}><LocateFixed size={12} /></button>
                </li>
              {/each}
            </ul>
          {/if}
        </li>
      {:else}
        <li class="empty">No outage screened.</li>
      {/each}
    </ul>
  {/if}
  {#if screeningError}<p class="error">{screeningError}</p>{/if}

  <section class="remedial">
    <h4>Remedial actions</h4>
    <p class="hint">Select an asset on the map or in Assets, choose an action and add it. The evaluation applies the actions in order to a private copy and screens again; nothing changes in the Grid.</p>
    <div class="candidate-form">
      <span class="target">{selected === null ? 'No asset selected' : `${selected.label} (${selected.kind})`}</span>
      <select bind:value={candidateKind} aria-label="Candidate action">
        {#each gridCandidateKinds as spec}<option value={spec.kind}>{spec.label}</option>{/each}
      </select>
      {#if candidateSpec.valueLabel !== null}
        <label>{candidateSpec.valueLabel}<input type="number" min="0" bind:value={candidateValue} /></label>
      {/if}
      {#if candidateKind === 'shed-load'}
        <label class="check"><input type="checkbox" bind:checked={candidateEmergency} />Emergency</label>
      {/if}
      <button type="button" onclick={addCandidate}><Plus size={12} />Add</button>
    </div>
    {#if candidateError}<p class="error">{candidateError}</p>{/if}
    {#if candidates.length > 0}
      <ol class="candidates">
        {#each candidates as candidate (candidate.action.assetId)}
          <li>
            <span>{gridCandidateActionText(candidate.action, candidate.label)}</span>
            <button type="button" class="locate" title="Remove" aria-label="Remove {candidate.label}" onclick={() => removeCandidate(candidate.action.assetId)}><X size={12} /></button>
          </li>
        {/each}
      </ol>
      <button type="button" class="primary" disabled={evaluating} onclick={() => void evaluate()}><Play size={12} />{evaluating ? 'Evaluating…' : 'Evaluate before / after'}</button>
    {/if}
    {#if evaluationError}<p class="error">{evaluationError}</p>{/if}
    {#if evaluation}
      <table class="comparison">
        <thead><tr><th></th><th>Before</th><th>After</th></tr></thead>
        <tbody>
          {#each comparison as row}
            <tr><th scope="row">{row.label}</th><td>{row.before}</td><td class:better={row.improved === true} class:worse={row.improved === false}>{row.after}</td></tr>
          {/each}
        </tbody>
      </table>
      {#each evaluation.actionBalances as part}
        <p class="hint">A part of {part.busCount} buses rebalances {part.imbalanceMw.toFixed(1)} MW by {part.balancing}{part.unservedLoadMw > 0 ? `, ${part.unservedLoadMw.toFixed(1)} MW unserved` : ''}.</p>
      {/each}
      <h4>Worst after the actions</h4>
      <ul class="results">
        {#each afterRows.slice(0, 5) as row (row.assetId)}
          <li class={row.severity}>
            <div class="result-head"><span><strong>{row.label}</strong> <small>{row.outageText} · {row.outcome}</small></span></div>
            {#if row.worst}<div class="worst"><span>Worst: {row.worst.label}</span><strong class:bad={row.worst.overloaded}>{row.worst.loadingText}</strong><small>{row.worst.basis}</small></div>{/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

<style>
  .contingency-view { display: flex; min-height: 0; flex: 1; flex-direction: column; gap: 8px; overflow: auto; font-size: 11px; }
  .screen-controls, .summary, .candidate-form { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  label { display: inline-flex; align-items: center; gap: 4px; color: #64748b; }
  select, input[type='number'] { padding: 3px 5px; color: inherit; border: 1px solid rgba(148,163,184,.45); border-radius: 4px; background: transparent; font: inherit; }
  input[type='number'] { width: 80px; }
  button { display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; color: inherit; border: 1px solid rgba(148,163,184,.4); border-radius: 999px; background: transparent; cursor: pointer; font-size: 11px; }
  button:disabled { opacity: .5; cursor: default; }
  button.primary { color: #fff; border-color: #2563eb; background: #2563eb; }
  .basis, .hint { margin: 0; color: #64748b; }
  .summary span { padding: 2px 6px; border-radius: 3px; background: rgba(148,163,184,.14); }
  .bad { color: #dc2626; }
  .summary span.bad { color: #fff; background: #dc2626; }
  h4 { margin: 6px 0 0; font-size: 11px; text-transform: uppercase; color: #475569; }
  .results, .violations, .candidates { margin: 0; padding: 0; list-style: none; }
  .results > li { padding: 6px 0 6px 8px; border-top: 1px solid rgba(148,163,184,.22); border-left: 3px solid #16a34a; }
  .results > li.violation { border-left-color: #dc2626; } .results > li.unserved { border-left-color: #d97706; } .results > li.islanding { border-left-color: #d97706; }
  .result-head, .worst, .violations li, .candidates li { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .expand { flex: 1; flex-direction: column; align-items: flex-start; gap: 1px; min-width: 0; padding: 0; border: 0; border-radius: 0; text-align: left; }
  .expand strong, .worst span, .violations span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  small { color: #64748b; }
  .worst { padding-left: 8px; }
  .worst span, .violations span { flex: 1; min-width: 0; }
  .violations { padding-left: 16px; }
  .locate { padding: 2px; border: 0; border-radius: 3px; }
  .remedial { display: flex; flex-direction: column; gap: 6px; padding-top: 6px; border-top: 1px solid rgba(148,163,184,.35); }
  .target { padding: 3px 6px; border-radius: 3px; background: rgba(59,130,246,.1); }
  .check { color: inherit; }
  .candidates { display: flex; flex-direction: column; gap: 3px; padding-left: 4px; }
  .candidates li span { flex: 1; }
  .comparison { border-collapse: collapse; }
  .comparison th, .comparison td { padding: 3px 8px; text-align: right; border-bottom: 1px solid rgba(148,163,184,.22); }
  .comparison th[scope='row'] { text-align: left; font-weight: 500; color: #64748b; }
  .comparison td.better { color: #16a34a; font-weight: 700; } .comparison td.worse { color: #dc2626; font-weight: 700; }
  .empty { padding: 6px; color: #64748b; }
  .error { margin: 0; color: #dc2626; overflow-wrap: anywhere; }
  :global(.dark) h4 { color: #94a3b8; }
  :global(.dark) label, :global(.dark) small, :global(.dark) .basis, :global(.dark) .hint { color: #94a3b8; }
</style>
