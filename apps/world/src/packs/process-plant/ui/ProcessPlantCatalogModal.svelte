<script lang="ts">
  import { Copy, Search, X } from 'lucide-svelte'
  import type { SimulationRunId } from '../../../core/model/index.ts'
  import {
    readProcessPlantCatalog,
    type ProcessPlantCatalog,
    type ProcessPlantCatalogEntry,
    type ProcessPlantActionCatalogEntry,
  } from './plant-client.ts'

  interface Props {
    readonly simulationRunId: SimulationRunId
    readonly close: () => void
  }

  interface CatalogSection {
    readonly id: string
    readonly title: string
    readonly rows: ReadonlyArray<CatalogEntry>
  }

  type CatalogEntry = ProcessPlantCatalogEntry | ProcessPlantActionCatalogEntry

  let { simulationRunId, close }: Props = $props()
  let loading = $state(true)
  let error = $state<string | null>(null)
  let catalog = $state<ProcessPlantCatalog | null>(null)
  let query = $state('')
  let copyStatus = $state<string | null>(null)
  let expandedEntryKey = $state<string | null>(null)

  const sections = $derived<CatalogSection[]>(catalog === null ? [] : [
    { id: 'models', title: 'Plant models', rows: catalog.models },
    { id: 'operating-points', title: 'Operating points', rows: catalog.operatingPoints },
    { id: 'automations', title: 'Automations', rows: catalog.automations },
    { id: 'actions', title: 'Actions', rows: catalog.actions },
    { id: 'assessments', title: 'Assessments', rows: catalog.assessments },
    { id: 'recording-profiles', title: 'Recording profiles', rows: catalog.recordingProfiles },
    { id: 'credibility', title: 'Credibility evidence', rows: catalog.credibilityEvidence },
  ])
  const normalizedQuery = $derived(query.trim().toLowerCase())
  const visibleSections = $derived(normalizedQuery.length === 0
    ? sections
    : sections.map(section => ({
      ...section,
      rows: section.rows.filter(row =>
        row.id.toLowerCase().includes(normalizedQuery)
        || row.title.toLowerCase().includes(normalizedQuery)
        || (row.description?.toLowerCase().includes(normalizedQuery) ?? false)),
    })).filter(section => section.rows.length > 0))
  const entryCount = $derived(sections.reduce((count, section) => count + section.rows.length, 0))

  const entryKey = (section: CatalogSection, row: CatalogEntry): string => `${section.id}:${row.id}`

  const toggleEntry = (section: CatalogSection, row: CatalogEntry): void => {
    const key = entryKey(section, row)
    expandedEntryKey = expandedEntryKey === key ? null : key
  }

  const entryMetadata = (row: CatalogEntry): Readonly<Record<string, unknown>> | null => {
    const metadata = {
      ...(row.compatibleModelRefs === undefined ? {} : { compatibleModelRefs: row.compatibleModelRefs }),
      ...(row.parameters === undefined ? {} : { parameters: row.parameters }),
      ...('inputSchema' in row ? { inputSchema: row.inputSchema } : {}),
    }
    return Object.keys(metadata).length === 0 ? null : metadata
  }

  const copyValue = async (value: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      copyStatus = 'Copied'
    } catch (err) {
      copyStatus = err instanceof Error ? err.message : String(err)
    }
  }

  $effect(() => {
    const runId = simulationRunId
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        loading = true
        error = null
        catalog = await readProcessPlantCatalog(runId)
      } catch (err) {
        if (!cancelled) error = err instanceof Error ? err.message : String(err)
      } finally {
        if (!cancelled) loading = false
      }
    }
    void load()
    return () => { cancelled = true }
  })
</script>

<div class="process-artifact-backdrop" role="presentation">
  <section class="process-artifact-modal process-catalog-modal" aria-label="Process plant catalog">
    <header class="process-artifact-header">
      <div>
        <strong>Process plant catalog</strong>
        {#if catalog}<span>{entryCount} discoverable capabilities</span>{/if}
      </div>
      <div class="process-artifact-actions">
        <label class="process-artifact-search">
          <Search size={14} aria-hidden="true" />
          <input type="search" placeholder="Search catalog" value={query} oninput={(event) => { query = event.currentTarget.value }} />
        </label>
        <button type="button" aria-label="Close catalog" onclick={close}><X size={17} aria-hidden="true" /></button>
      </div>
    </header>
    {#if copyStatus}<div class="process-artifact-copy-status">{copyStatus}</div>{/if}
    <div class="process-artifact-body process-catalog-body">
      {#if loading}
        <div class="process-display-message">Loading process plant catalog...</div>
      {:else if error}
        <div class="process-display-error">{error}</div>
      {:else if visibleSections.length === 0}
        <div class="process-display-message">No capabilities match.</div>
      {:else}
        <div class="process-catalog-sections">
          {#each visibleSections as section (section.id)}
            <section class="process-catalog-section" aria-label={section.title}>
              <header><strong>{section.title}</strong><span>{section.rows.length}</span></header>
              <div class="process-catalog-rows">
                {#each section.rows as row (row.id)}
                  {@const expanded = expandedEntryKey === entryKey(section, row)}
                  <div class="process-catalog-row" class:expanded>
                    <button
                      type="button"
                      class="process-catalog-row-main"
                      aria-expanded={expanded}
                      aria-label="Inspect {row.title}"
                      onclick={() => toggleEntry(section, row)}
                    >
                      <code>{row.id}</code>
                      <strong>{row.title}</strong>
                      {#if row.description}<span>{row.description}</span>{/if}
                    </button>
                    <button class="process-catalog-copy-button" type="button" aria-label="Copy {row.id}" title="Copy" onclick={() => void copyValue(row.id)}>
                      <Copy size={15} aria-hidden="true" />
                    </button>
                    {#if expanded}
                      {@const metadata = entryMetadata(row)}
                      <div class="process-catalog-row-detail">
                        <div>
                          <strong>{section.title}</strong>
                          <code>{row.id}</code>
                        </div>
                        {#if row.description}<p>{row.description}</p>{/if}
                        {#if metadata}
                          <pre><code>{JSON.stringify(metadata, null, 2)}</code></pre>
                        {:else}
                          <p>No additional configuration is declared for this capability.</p>
                        {/if}
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
            </section>
          {/each}
        </div>
      {/if}
    </div>
  </section>
</div>
