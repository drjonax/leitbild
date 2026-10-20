import type { OperationalObject } from '../../core/model/index.ts'
import { packField, packStatus } from '../../core/packs/presentation.ts'
import type { PackMapLayerGroup, PackObjectPresentation, WorldPackView } from '../../core/packs/protocol.ts'
import { createWorldPackDescriptor } from '../../core/packs/protocol.ts'
import { asDatasetId } from '../../reference-data/types.ts'
import { electricGridPackId, parseElectricGridObjectData } from './model.ts'
import { electricGridRuntimeId } from './sim/constants.ts'
import { gridLiveLayerGroupId, gridLiveMapLayer, gridLiveStateLegend, gridOverviewPanelId } from './ui/grid-live-layer.ts'
import { gridGenerationColor, gridVoltageLegend, neutralSwatchColor } from './ui/grid-map-palette.ts'
import { gridNorwayStyle } from './ui/grid-norway-style.ts'

const mw = (value: number): string => `${Math.round(value).toLocaleString()} MW`

const referenceLayerPattern = (group: string): string => `reference:${gridNorwayStyle.datasetId}:${group}:*`

const layerGroups: ReadonlyArray<PackMapLayerGroup> = [{
  id: 'electric-grid:reference-lines',
  label: 'Power lines',
  defaultVisible: true,
  layerIdPattern: referenceLayerPattern('lines'),
  swatch: { symbol: 'line', color: neutralSwatchColor, sizePx: 3 },
}, {
  id: 'electric-grid:reference-cables',
  label: 'Power cables',
  defaultVisible: true,
  layerIdPattern: referenceLayerPattern('cables'),
  swatch: { symbol: 'dashed-line', color: neutralSwatchColor, sizePx: 3 },
}, {
  id: 'electric-grid:reference-substations',
  label: 'Substations and transformers',
  defaultVisible: true,
  layerIdPattern: referenceLayerPattern('substations'),
  swatch: { symbol: 'circle', color: neutralSwatchColor, sizePx: 9 },
}, {
  id: 'electric-grid:reference-generation',
  label: 'Power plants and generators',
  defaultVisible: true,
  layerIdPattern: referenceLayerPattern('generation'),
  swatch: { symbol: 'circle', color: gridGenerationColor, sizePx: 11 },
}, {
  id: gridLiveLayerGroupId,
  label: 'Live grid state',
  defaultVisible: true,
  layerIdPattern: `live:${gridLiveMapLayer.id}:*:*`,
  swatch: { symbol: 'line', color: gridLiveStateLegend.entries[0]!.color, sizePx: 3 },
}]

const presentationForGrid = (object: OperationalObject): PackObjectPresentation => {
  const data = parseElectricGridObjectData(object)
  if (!data) {
    return {
      categoryId: 'electric-grids',
      icon: 'network',
      color: '#6e788c',
      summary: 'Invalid Grid data',
      status: packStatus('error', 'Invalid data'),
      fields: [packField('error', 'Error', 'Invalid electric-grid Pack data')],
    }
  }
  const projection = data.projection
  return {
    categoryId: 'electric-grids',
    icon: 'network',
    // One identity colour: the status word and indicator carry the tone; alert hues are kept for alerts (plan v3.1 §2.7, D9).
    color: '#00878c',
    summary: projection.summary,
    status: packStatus(projection.statusTone, projection.statusLabel),
    fields: [
      packField('model', 'Model', data.model.ref),
      packField('operating-point', 'Operating point', data.operatingPoint.ref),
      packField('frequency', 'Grid frequency',projection.frequencyHz === null ? 'No island energised' : `${projection.frequencyHz.toFixed(2)} Hz`),
      packField('generation', 'Generation', mw(projection.totalGenerationMw)),
      packField('load', 'Served load', `${mw(projection.servedLoadMw)} / ${mw(projection.totalLoadMw)}`),
      packField('reserve', 'Reserve margin', mw(projection.reserveMarginMw)),
      packField('islands', 'Energised islands', `${projection.activeIslandCount} of ${projection.islandCount}`),
      packField('alarms', 'Active alarms', String(projection.activeAlarmCount)),
    ],
    mapIconVisible: true,
    mapIconSizePx: 18,
    noteworthyUpdates: projection.statusTone !== 'ready',
  }
}

export const electricGridPackView: WorldPackView = {
  descriptor: createWorldPackDescriptor({
    id: electricGridPackId,
    version: '1.0.0',
    name: 'Electric Grid',
    description: 'Configurable electrical networks with topology, dispatch, dynamics, protection, and live operating views.',
    contributions: ['runtime', 'recording', 'reference-data', 'scenario', 'presentation'],
  }),
  runtime: {
    runtimes: [{ id: electricGridRuntimeId, version: '1.0.0', label: 'Local electric grid runtime', kind: 'local', clock: 'simulation' }],
    defaultRuntimeId: electricGridRuntimeId,
  },
  referenceData: { datasetIds: [asDatasetId(gridNorwayStyle.datasetId)] },
  presentation: {
    mapLayerGroups: layerGroups,
    referenceStyles: [gridNorwayStyle],
    mapLegends: [gridVoltageLegend, gridLiveStateLegend],
    liveMapLayers: [gridLiveMapLayer],
    categories: [{
      id: 'electric-grids',
      label: 'Electric grids',
      emptyLabel: 'No electric grids',
      matches: object => parseElectricGridObjectData(object) !== null,
    }],
    presentObject: presentationForGrid,
  },
  ui: {
    surfacePanels: [{
      id: gridOverviewPanelId,
      label: 'Grid operations',
      defaultOpen: true,
      load: async () => await import('../../ui/grid/GridOverviewPanel.svelte'),
    }],
  },
}
