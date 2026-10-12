import { z } from 'zod'
import type { OperationalObject } from '../../core/model/index.ts'
import { createWorldPackDescriptor, type PackObjectPresentation, type WorldPackView } from '../../core/packs/protocol.ts'
import { einsatzPackId, einsatzRuntimeId } from './ids.ts'
import { neutralLexicon } from './lexicon.ts'

/**
 * The browser-safe Einsatz view. It reads only the presentation each object
 * carries from its configuration and imports no engine, configuration
 * validation or map catalogue.
 */

const unitsCategory = 'einsatz-units'
const tasksCategory = 'einsatz-tasks'
const unitColor = '#2f6f9f'
const taskColor = '#b45309'

const presentedSchema = z.object({
  type: z.enum(['unit', 'task']),
  presentation: z.object({ icon: z.string().min(1), typeLabel: z.string().min(1) }).strict(),
}).loose()

const presentedOf = (object: OperationalObject) => object.packId === einsatzPackId ? presentedSchema.parse(object.packData) : null

const presentEinsatzObject = (object: OperationalObject): PackObjectPresentation => {
  const data = presentedSchema.parse(object.packData)
  return {
    categoryId: data.type === 'unit' ? unitsCategory : tasksCategory,
    icon: data.presentation.icon,
    color: data.type === 'unit' ? unitColor : taskColor,
    summary: data.presentation.typeLabel,
    muted: object.lifecycle !== 'active',
    fields: [],
  }
}

export const einsatzPackView = {
  descriptor: createWorldPackDescriptor({
    id: einsatzPackId,
    version: '1.0.0',
    name: 'Einsatz',
    description: 'Dispatch and command of configured units: unit types, typed properties, task templates, load classes and wording are scenario data. Units move by road or in straight lines, serve and carry counted demand to receiving sites, and follow closed standing orders.',
    contributions: ['runtime', 'scenario', 'presentation'],
  }),
  runtime: {
    runtimes: [{ id: einsatzRuntimeId, version: '1.0.0', label: 'Local Einsatz runtime', kind: 'local', clock: 'simulation' }],
    defaultRuntimeId: einsatzRuntimeId,
  },
  presentation: {
    categories: [
      { id: unitsCategory, label: neutralLexicon.unitBoard, emptyLabel: `No ${neutralLexicon.unitBoard.toLowerCase()}`, matches: object => presentedOf(object)?.type === 'unit' },
      { id: tasksCategory, label: neutralLexicon.workList, emptyLabel: `No ${neutralLexicon.workList.toLowerCase()}`, matches: object => presentedOf(object)?.type === 'task' },
    ],
    presentObject: object => presentEinsatzObject(object),
  },
} satisfies WorldPackView
