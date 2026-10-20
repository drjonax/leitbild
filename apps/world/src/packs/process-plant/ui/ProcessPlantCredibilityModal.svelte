<script lang="ts">
  import { Copy, FileJson2, Image, ShieldCheck, X } from 'lucide-svelte'
  import type { SimulationRunId } from '../../../core/model/index.ts'
  import {
    listProcessPlantCredibilityEvidence,
    readProcessPlantCredibilityArtifact,
    type ProcessPlantCredibilityArtifact,
    type ProcessPlantCredibilityEvidence,
  } from '../../../ui/process-display/process-display-client.ts'

  interface Props {
    readonly simulationRunId: SimulationRunId
    readonly plantId: string
    readonly close: () => void
  }

  interface SummaryCaseResult {
    readonly caseId: string
    readonly title: string
    readonly targetCount: number
    readonly passedTargetCount: number
    readonly failedGateTargetCount: number
    readonly failedWatchTargetCount: number
  }

  interface SummaryView {
    readonly generatedAt: string
    readonly caseCount: number
    readonly targetCount: number
    readonly failedGateTargetCount: number
    readonly failedWatchTargetCount: number
    readonly realtimeFactor: number
    readonly caseResults: ReadonlyArray<SummaryCaseResult>
  }

  let { simulationRunId, plantId, close }: Props = $props()

  let loading = $state(true)
  let error = $state<string | null>(null)
  let evidence = $state<ReadonlyArray<ProcessPlantCredibilityEvidence>>([])
  let selectedEvidenceId = $state<string | null>(null)
  let selectedArtifactId = $state<string | null>(null)
  let artifactLoading = $state(false)
  let artifactError = $state<string | null>(null)
  let artifactData = $state<ProcessPlantCredibilityArtifact | null>(null)
  let copyStatus = $state<string | null>(null)

  const selectedEvidence = $derived(evidence.find(entry => entry.id === selectedEvidenceId) ?? evidence[0] ?? null)
  const selectedArtifact = $derived(selectedEvidence?.artifacts.find(artifact => artifact.id === selectedArtifactId) ?? selectedEvidence?.artifacts[0] ?? null)

  const numberField = (record: Record<string, unknown>, key: string): number => {
    const value = record[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
  }

  const stringField = (record: Record<string, unknown>, key: string): string => {
    const value = record[key]
    return typeof value === 'string' ? value : ''
  }

  const parseSummaryView = (content: string): SummaryView | null => {
    try {
      const parsed = JSON.parse(content)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
      const record = parsed as Record<string, unknown>
      const caseResults = Array.isArray(record.caseResults)
        ? record.caseResults.flatMap(item => {
            if (typeof item !== 'object' || item === null || Array.isArray(item)) return []
            const caseRecord = item as Record<string, unknown>
            return [{
              caseId: stringField(caseRecord, 'caseId'),
              title: stringField(caseRecord, 'title'),
              targetCount: numberField(caseRecord, 'targetCount'),
              passedTargetCount: numberField(caseRecord, 'passedTargetCount'),
              failedGateTargetCount: numberField(caseRecord, 'failedGateTargetCount'),
              failedWatchTargetCount: numberField(caseRecord, 'failedWatchTargetCount'),
            }]
          })
        : []
      return {
        generatedAt: stringField(record, 'generatedAt'),
        caseCount: numberField(record, 'caseCount'),
        targetCount: numberField(record, 'targetCount'),
        failedGateTargetCount: numberField(record, 'failedGateTargetCount'),
        failedWatchTargetCount: numberField(record, 'failedWatchTargetCount'),
        realtimeFactor: numberField(record, 'realtimeFactor'),
        caseResults,
      }
    } catch (err) {
      console.warn('process plant credibility summary parse failed', err)
      return null
    }
  }

  const summaryView = $derived(artifactData?.artifact.language === 'json'
    ? parseSummaryView(artifactData.content)
    : null)

  const selectEvidence = (entry: ProcessPlantCredibilityEvidence): void => {
    selectedEvidenceId = entry.id
    selectedArtifactId = entry.artifacts[0]?.id ?? null
    copyStatus = null
  }

  const copyContent = async (): Promise<void> => {
    if (!artifactData) return
    try {
      await navigator.clipboard.writeText(artifactData.content)
      copyStatus = 'Copied'
    } catch (err) {
      copyStatus = err instanceof Error ? err.message : String(err)
    }
  }

  $effect(() => {
    const runId = simulationRunId
    const selectedPlantId = plantId
    let cancelled = false

    const load = async (): Promise<void> => {
      try {
        loading = true
        error = null
        evidence = []
        artifactData = null
        copyStatus = null
        const next = await listProcessPlantCredibilityEvidence(runId, selectedPlantId)
        if (cancelled) return
        evidence = next.evidence
        selectedEvidenceId = next.evidence[0]?.id ?? null
        selectedArtifactId = next.evidence[0]?.artifacts[0]?.id ?? null
      } catch (err) {
        if (!cancelled) error = err instanceof Error ? err.message : String(err)
      } finally {
        if (!cancelled) loading = false
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  })

  $effect(() => {
    const runId = simulationRunId
    const selectedPlantId = plantId
    const evidenceId = selectedEvidenceId
    const artifactId = selectedArtifactId
    let cancelled = false

    if (!evidenceId || !artifactId) {
      artifactData = null
      return () => {
        cancelled = true
      }
    }

    const load = async (): Promise<void> => {
      try {
        artifactLoading = true
        artifactError = null
        artifactData = null
        copyStatus = null
        const next = await readProcessPlantCredibilityArtifact(runId, selectedPlantId, evidenceId, artifactId)
        if (!cancelled) artifactData = next
      } catch (err) {
        if (!cancelled) artifactError = err instanceof Error ? err.message : String(err)
      } finally {
        if (!cancelled) artifactLoading = false
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  })
</script>

<div class="process-artifact-backdrop" role="presentation">
  <section class="process-artifact-modal process-credibility-modal" aria-label="Process plant credibility evidence">
    <header class="process-artifact-header">
      <div>
        <strong>Process plant credibility</strong>
        {#if evidence.length > 0}
          <span>{evidence.length} evidence set{evidence.length === 1 ? '' : 's'}</span>
        {/if}
      </div>
      <div class="process-artifact-actions">
        <button type="button" aria-label="Copy credibility artifact" onclick={copyContent} disabled={!artifactData}>
          <Copy size={16} aria-hidden="true" />
        </button>
        <button type="button" aria-label="Close credibility evidence" onclick={close}>
          <X size={17} aria-hidden="true" />
        </button>
      </div>
    </header>
    {#if copyStatus}
      <div class="process-artifact-copy-status">{copyStatus}</div>
    {/if}
    <div class="process-artifact-body process-credibility-body">
      {#if loading}
        <div class="process-display-message">Loading credibility evidence...</div>
      {:else if error}
        <div class="process-display-error">{error}</div>
      {:else if evidence.length === 0}
        <div class="process-display-message">No credibility evidence is registered for this Plant.</div>
      {:else}
        <div class="process-credibility-layout">
          <aside class="process-credibility-list" aria-label="Credibility evidence sets">
            {#each evidence as entry (entry.id)}
              <button
                type="button"
                class:active={selectedEvidence?.id === entry.id}
                onclick={() => selectEvidence(entry)}
              >
                <ShieldCheck size={15} aria-hidden="true" />
                <span>
                  <strong>{entry.title}</strong>
                  <small>{entry.scope}</small>
                </span>
              </button>
            {/each}
          </aside>
          <section class="process-credibility-panel" aria-label="Credibility artifact">
            {#if selectedEvidence}
              <div class="process-credibility-evidence-header">
                <div>
                  <strong>{selectedEvidence.title}</strong>
                  <span>{selectedEvidence.description}</span>
                  <code>{selectedEvidence.generatedFromCommand}</code>
                </div>
                <div class="process-credibility-artifact-tabs">
                  {#each selectedEvidence.artifacts as artifact (artifact.id)}
                    <button
                      type="button"
                      class:active={selectedArtifact?.id === artifact.id}
                      onclick={() => {
                        selectedArtifactId = artifact.id
                        copyStatus = null
                      }}
                    >
                      {#if artifact.language === 'json'}
                        <FileJson2 size={14} aria-hidden="true" />
                      {:else}
                        <Image size={14} aria-hidden="true" />
                      {/if}
                      <span>{artifact.title}</span>
                    </button>
                  {/each}
                </div>
              </div>
            {/if}
            {#if artifactLoading}
              <div class="process-display-message">Loading credibility artifact...</div>
            {:else if artifactError}
              <div class="process-display-error">{artifactError}</div>
            {:else if artifactData?.artifact.language === 'svg'}
              <div class="process-credibility-svg">
                {@html artifactData.content}
              </div>
            {:else if artifactData?.artifact.language === 'json'}
              {#if summaryView}
                <div class="process-credibility-summary">
                  <div class="process-credibility-metrics">
                    <div><span>Cases</span><strong>{summaryView.caseCount}</strong></div>
                    <div><span>Targets</span><strong>{summaryView.targetCount}</strong></div>
                    <div><span>Gate misses</span><strong>{summaryView.failedGateTargetCount}</strong></div>
                    <div><span>Watch misses</span><strong>{summaryView.failedWatchTargetCount}</strong></div>
                    <div><span>Realtime</span><strong>{summaryView.realtimeFactor.toFixed(0)}x</strong></div>
                  </div>
                  <div class="process-credibility-cases">
                    {#each summaryView.caseResults as result (result.caseId)}
                      <div class="process-credibility-case-row">
                        <span>{result.title}</span>
                        <strong>{result.passedTargetCount}/{result.targetCount}</strong>
                        <small>{result.failedGateTargetCount} gate · {result.failedWatchTargetCount} watch</small>
                      </div>
                    {/each}
                  </div>
                </div>
              {/if}
              <pre><code>{artifactData.content}</code></pre>
            {:else}
              <div class="process-display-message">Select a credibility artifact.</div>
            {/if}
          </section>
        </div>
      {/if}
    </div>
  </section>
</div>
