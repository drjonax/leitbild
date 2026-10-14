import type { OperationalObject } from '../../core/model/index.ts'
import { packField, packStatus } from '../../core/packs/presentation.ts'
import type { PackObjectPresentation, PackPresentationContribution } from '../../core/packs/protocol.ts'
import {
  emptyProcessPlantProjection,
  processPlantUnitPackDataSchema,
  type ProcessPlantUnitPackData,
  type ProcessPlantUnitProjection,
} from './model.ts'

// A Plant whose runtime is pending is drawn grey, as an object the Pack does not know is.
const colorByTone: Readonly<Record<ProcessPlantUnitProjection['statusTone'], string>> = {
  error: '#c7352b',
  working: '#c77d13',
  ready: '#22845d',
  idle: '#667085',
}

const parseUnitData = (object: OperationalObject): ProcessPlantUnitPackData | null => {
  const parsed = processPlantUnitPackDataSchema.safeParse(object.packData)
  return parsed.success ? parsed.data : null
}

// What the Plant's card leads with: its status and the operating mode it is
// in, then the energy its sources put in and its sinks take out. A Plant whose
// runtime is pending has no energy to state yet.
const glanceOf = (projection: ProcessPlantUnitProjection): ReadonlyArray<string> => projection.statusTone === 'idle'
  ? [projection.statusLabel]
  : [projection.modeLabel === undefined ? projection.statusLabel : `${projection.statusLabel} · ${projection.modeLabel}`, projection.summary]

const presentationForUnit = (object: OperationalObject, data: ProcessPlantUnitPackData): PackObjectPresentation => {
  const projection = data.projection ?? emptyProcessPlantProjection(object.timestamps.updatedAt)
  return {
    categoryId: 'process-plants',
    icon: 'factory',
    color: colorByTone[projection.statusTone],
    summary: projection.summary,
    status: packStatus(projection.statusTone, projection.statusLabel),
    glance: glanceOf(projection),
    fields: [
      packField('model', 'Model', data.model.ref),
      packField('operating-point', 'Operating point', data.operatingPoint.ref),
      ...(data.clusterId === undefined ? [] : [packField('cluster', 'Cluster', data.clusterId)]),
      ...(data.coolingWater === undefined ? [] : [packField('cooling-water', 'Cooling water', data.coolingWater)]),
      ...projection.fields,
    ],
    noteworthyUpdates: projection.statusTone !== 'ready',
  }
}

export const processPlantPresentation: PackPresentationContribution = {
  categories: [{
    id: 'process-plants', label: 'Process plants', emptyLabel: 'No process plants',
    matches: (object): boolean => parseUnitData(object) !== null,
  }],
  presentObject: (object: OperationalObject): PackObjectPresentation => {
    const data = parseUnitData(object)
    if (data) return presentationForUnit(object, data)
    return {
      categoryId: 'unknown', icon: 'circle-question-mark', color: colorByTone.idle, summary: object.operational.status,
      status: packStatus('idle', object.operational.status),
      fields: [packField('warning', 'Warning', 'Object is outside the process-plant Pack vocabulary')],
    }
  },
}
