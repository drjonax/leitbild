<script lang="ts">
  import type { OperationalObject } from '../core/model/index.ts'
  import type { StartingRailView } from '../core/model/index.ts'
  import type { PackCreateObjectType, PackMapLayerGroup, PackObjectPresentation } from '../core/packs/protocol.ts'
  import type { PackMapLegend } from '../core/packs/reference-style.ts'
  import RailLayerGroupSection from './RailLayerGroupSection.svelte'
  import { PanelRightOpen, X } from 'lucide-svelte'
  import CategorySection from './CategorySection.svelte'
  import IconButton from './components/IconButton.svelte'
  import type { ProcessPlantArtifactKind } from './process-display/process-display-client.ts'
  import type { ProcedureRunSummary, ProcedureRunSummaryGroup } from './procedures/procedure-run-selectors.ts'
  import { runOnMount } from './svelte-lifecycle.svelte.ts'
  import type { CategoryRow } from './types.ts'
  import {
    buildPresentedCategoryRows,
    type FieldVisibilityState,
  } from './control-rail-presenter.ts'
  import {
    collapsedCategoryIdsForStartingView,
    startingViewKey,
    visibleFieldsForStartingView,
  } from './starting-view.ts'
  import SystemFooter from './SystemFooter.svelte'
  import type { StatusTone } from './components/StatusDot.svelte'

  const processPlantCategoryId = 'process-plants'
  const proceduresFieldKey = 'procedures'
  const procedureFieldOption = { key: proceduresFieldKey, label: 'Procedures' } as const
  const emptyProcedureRunSummaries: ProcedureRunSummaryGroup = { active: [], completed: [] }

  interface Props {
    readonly status: string
    readonly systemStatusTone: StatusTone
    readonly appVersion: string
    readonly footerVisible: boolean
    readonly collapsed: boolean
    readonly categoryRows: ReadonlyArray<CategoryRow>
    readonly railConfig: StartingRailView
    readonly placementMode: PackCreateObjectType | null
    readonly selectedControllerId: string | null
    readonly categoryMapVisibility?: Readonly<Record<string, boolean>>
    readonly deferObjectRows?: boolean
    readonly presentationFor: (object: OperationalObject) => PackObjectPresentation
    readonly detailPresentationFor?: (object: OperationalObject) => PackObjectPresentation | Promise<PackObjectPresentation>
    readonly hasNewInfo: (object: OperationalObject) => boolean
    readonly markSeen: (object: OperationalObject) => void
    readonly selectObject: (object: OperationalObject) => void
    readonly deleteObject: (object: OperationalObject) => Promise<void>
    readonly openProcessDisplay?: (object: OperationalObject) => void
    readonly openProcedureSystem?: (object: OperationalObject) => void
    readonly openProcedureSystemAt?: (object: OperationalObject, summary?: ProcedureRunSummary) => void
    readonly openProcessPlantArtifact?: (object: OperationalObject, artifact: ProcessPlantArtifactKind) => void
    readonly openProcessPlantCatalog?: (object: OperationalObject) => void
    readonly openProcessPlantCredibility?: (object: OperationalObject) => void
    readonly openDroneControl?: (object: OperationalObject) => void
    readonly openDroneProfileEditor?: (object: OperationalObject) => void
    readonly procedureSummariesForObject?: (object: OperationalObject) => ProcedureRunSummaryGroup
    readonly beginPlacement: (type: PackCreateObjectType) => void
    readonly cancelPlacement: () => void
    readonly openStatusModal: () => void
    readonly openSettings: () => void
    readonly toggleCategoryMapVisibility?: (categoryId: string) => void
    readonly mapLayerGroups?: ReadonlyArray<PackMapLayerGroup>
    readonly mapLegends?: ReadonlyArray<PackMapLegend>
    readonly mapLayerGroupVisibility?: Readonly<Record<string, boolean>>
    readonly onMapLayerGroupToggle?: (groupId: string) => void
    readonly surfacePanels?: ReadonlyArray<{ readonly id: string; readonly label: string; readonly open: boolean }>
    readonly toggleSurfacePanel?: (panelId: string) => void
  }

  let {
    status,
    systemStatusTone,
    appVersion,
    footerVisible,
    collapsed,
    categoryRows,
    railConfig,
    placementMode,
    selectedControllerId,
    categoryMapVisibility = {},
    deferObjectRows = false,
    presentationFor,
    detailPresentationFor,
    hasNewInfo,
    markSeen,
    selectObject,
    deleteObject,
    openProcessDisplay,
    openProcedureSystem,
    openProcedureSystemAt,
    openProcessPlantArtifact,
    openProcessPlantCatalog,
    openProcessPlantCredibility,
    openDroneControl,
    openDroneProfileEditor,
    procedureSummariesForObject = () => emptyProcedureRunSummaries,
    beginPlacement,
    cancelPlacement,
    openStatusModal,
    openSettings,
    toggleCategoryMapVisibility = () => undefined,
    mapLayerGroups = [],
    mapLegends = [],
    mapLayerGroupVisibility = {},
    onMapLayerGroupToggle = () => undefined,
    surfacePanels = [],
    toggleSurfacePanel = () => undefined,
  }: Props = $props()

  let collapsedCategoryIds = $state<Record<string, boolean>>({})
  let openFieldCategoryId = $state<string | null>(null)
  let visibleFieldsByCategory = $state<FieldVisibilityState>({})
  let appliedSurfaceConfigKey = $state('')

  const placementText = (): string => {
    if (!placementMode) return ''
    const placementKind = placementMode.placementKind ?? 'point'
    if (placementKind === 'route') return `Click start and end points for new ${placementMode.label.toLowerCase()}`
    if (placementKind === 'polygon') return `Click area vertices; press Enter to finish`
    return `Click map to place new ${placementMode.label.toLowerCase()}`
  }

  const categoryCollapsed = (categoryId: string): boolean =>
    collapsedCategoryIds[categoryId] === true

  const toggleCategory = (categoryId: string): void => {
    collapsedCategoryIds = { ...collapsedCategoryIds, [categoryId]: !categoryCollapsed(categoryId) }
  }

  const visibleFieldsFor = (categoryId: string): ReadonlyArray<string> =>
    visibleFieldsByCategory[categoryId] ?? []

  const fieldVisible = (categoryId: string, field: string): boolean =>
    visibleFieldsFor(categoryId).includes(field)

  const toggleField = (categoryId: string, field: string): void => {
    const current = visibleFieldsFor(categoryId)
    const next = current.includes(field)
      ? current.filter(candidate => candidate !== field)
      : [...current, field]
    visibleFieldsByCategory = { ...visibleFieldsByCategory, [categoryId]: next }
  }

  const handleOutsideFieldMenuClick = (event: MouseEvent): void => {
    if (!openFieldCategoryId) return
    const target = event.target
    if (!(target instanceof Element)) return
    if (target.closest('.field-menu-wrap')) return
    openFieldCategoryId = null
  }

  runOnMount(() => {
    window.addEventListener('click', handleOutsideFieldMenuClick, { capture: true })
    return () => {
      window.removeEventListener('click', handleOutsideFieldMenuClick, { capture: true })
    }
  })

  $effect(() => {
    const nextKey = startingViewKey(railConfig)
    if (appliedSurfaceConfigKey === nextKey) return
    collapsedCategoryIds = collapsedCategoryIdsForStartingView(railConfig)
    visibleFieldsByCategory = visibleFieldsForStartingView(railConfig)
    openFieldCategoryId = null
    appliedSurfaceConfigKey = nextKey
  })

  const presentedCategoryRows = $derived(buildPresentedCategoryRows({
    categoryRows,
    collapsedCategoryIds,
    openFieldCategoryId,
    visibleFieldsByCategory,
    includeRows: !deferObjectRows,
    presentationFor,
    hasNewInfo,
    additionalFieldOptionsForCategory: row => row.category.id === processPlantCategoryId ? [procedureFieldOption] : [],
  }))
</script>

<aside class="control-rail" aria-hidden={collapsed} inert={collapsed}>
  {#if placementMode}
      <div class="placement-banner">
        {placementText()}
      <IconButton label="Cancel placement" icon={X} onClick={cancelPlacement} />
    </div>
  {/if}

  {#each presentedCategoryRows as entry (entry.row.category.id)}
    <CategorySection
      row={entry.row}
      headerIcon={entry.headerIcon}
      collapsed={entry.collapsed}
      fieldMenuOpen={entry.fieldMenuOpen}
      fieldOptions={entry.fieldOptions}
      presentedRows={entry.presentedRows}
      {selectedControllerId}
      categoryMapVisible={categoryMapVisibility[entry.row.category.id] ?? true}
      isFieldVisible={fieldVisible}
      {toggleField}
      toggleFieldMenu={(categoryId) => openFieldCategoryId = openFieldCategoryId === categoryId ? null : categoryId}
      {toggleCategoryMapVisibility}
      {toggleCategory}
      {beginPlacement}
      {markSeen}
      {selectObject}
      {deleteObject}
      {detailPresentationFor}
      {openProcessDisplay}
      {openProcedureSystem}
      {openProcedureSystemAt}
      {openProcessPlantArtifact}
      {openProcessPlantCatalog}
      {openProcessPlantCredibility}
      {openDroneControl}
      {openDroneProfileEditor}
      {procedureSummariesForObject}
      proceduresVisible={fieldVisible(entry.row.category.id, proceduresFieldKey)}
    />
  {/each}

  <RailLayerGroupSection
    groups={mapLayerGroups}
    legends={mapLegends}
    visibility={mapLayerGroupVisibility}
    onToggle={onMapLayerGroupToggle}
  />

  {#if surfacePanels.length > 0}
    <section class="pack-tools">
      <h2>Tools</h2>
      {#each surfacePanels as panel}
        <button type="button" class:active={panel.open} onclick={() => toggleSurfacePanel(panel.id)}>
          <PanelRightOpen size={14} />
          <span>{panel.label}</span>
        </button>
      {/each}
    </section>
  {/if}

  {#if footerVisible}
    <SystemFooter
      {status}
      {systemStatusTone}
      {appVersion}
      {openStatusModal}
      {openSettings}
    />
  {/if}
</aside>

<style>
  .pack-tools { display: flex; flex-direction: column; gap: 5px; padding: 10px 12px; border-top: 1px solid var(--border-subtle, rgba(148, 163, 184, .25)); }
  .pack-tools h2 { margin: 0 0 2px; color: var(--text-muted, #64748b); text-transform: uppercase; font-size: 10px; letter-spacing: .06em; }
  .pack-tools button { display: flex; align-items: center; gap: 7px; width: 100%; padding: 7px 8px; color: inherit; text-align: left; border: 1px solid transparent; border-radius: 5px; background: transparent; cursor: pointer; font: inherit; font-size: 12px; }
  .pack-tools button:hover { background: rgba(148, 163, 184, .1); }
  .pack-tools button.active { border-color: rgba(59, 130, 246, .45); background: rgba(59, 130, 246, .1); }
</style>
