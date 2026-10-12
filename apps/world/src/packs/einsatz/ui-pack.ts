import { z } from 'zod'
import type { OperationalObject } from '../../core/model/index.ts'
import { createWorldPackDescriptor, type PackObjectField, type PackObjectPresentation, type WorldPackView } from '../../core/packs/protocol.ts'
import { packField } from '../../core/packs/presentation.ts'
import { einsatzPackId, einsatzRuntimeId } from './ids.ts'
import { neutralLexicon } from './lexicon.ts'

/**
 * The browser-safe Einsatz view. It reads only the presentation each object
 * carries and imports no engine, configuration validation or map catalogue.
 *
 * A track shows only what its side knows. A contact has a neutral icon and
 * colour and no type, side or weapon range; an identified track shows the
 * type's icon and label, the side and the range; a destroyed track keeps
 * what it had and is muted. A side's track index, which names the unit each
 * track follows, reaches truth roles only and is never drawn on the map.
 */

const unitsCategory = 'einsatz-units'
const tasksCategory = 'einsatz-tasks'
const tracksCategory = 'einsatz-tracks'
const trackIndexesCategory = 'einsatz-track-indexes'
const unitColor = '#2f6f9f'
const taskColor = '#b45309'
const identifiedColor = '#7c3aed'
const contactColor = '#6b7280'
/** A catalogue and atlas icon that says nothing of what was seen. */
const contactIcon = 'circle-question-mark'
const trackIndexIcon = 'network'

const presentationSchema = z.object({ icon: z.string().min(1), typeLabel: z.string().min(1) }).strict()

const einsatzObjectSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('unit'), presentation: presentationSchema }).loose(),
  z.object({ type: z.literal('task'), presentation: presentationSchema }).loose(),
  z.object({
    type: z.literal('track'),
    tier: z.enum(['contact', 'identified', 'destroyed']),
    fix: z.boolean(),
    identity: z.object({ typeLabel: z.string().min(1), icon: z.string().min(1), side: z.string().min(1), rangeM: z.number().positive().optional() }).strict().optional(),
  }).strict(),
  z.object({ type: z.literal('track-index'), side: z.string().min(1), next: z.number().int().positive(), subjects: z.record(z.string(), z.string()) }).strict(),
])
type EinsatzObjectData = z.output<typeof einsatzObjectSchema>
type TrackData = Extract<EinsatzObjectData, { type: 'track' }>

const dataOf = (object: OperationalObject): EinsatzObjectData => einsatzObjectSchema.parse(object.packData)
const typeOf = (object: OperationalObject): EinsatzObjectData['type'] | null => object.packId === einsatzPackId ? dataOf(object).type : null

const tierWord = (tier: TrackData['tier']): string =>
  tier === 'contact' ? neutralLexicon.contact : tier === 'identified' ? neutralLexicon.identified : neutralLexicon.destroyed

const presentTrack = (object: OperationalObject, data: TrackData): PackObjectPresentation => {
  const identity = data.identity
  const fields: PackObjectField[] = [
    packField('tier', 'Tier', tierWord(data.tier)),
    packField('fix', 'Fire-control fix', data.fix ? 'Yes' : 'No'),
    ...(identity === undefined ? [] : [
      packField('type', 'Type', identity.typeLabel),
      packField('side', 'Side', identity.side),
      ...(identity.rangeM === undefined ? [] : [packField('range', 'Weapon range', `${(identity.rangeM / 1_000).toFixed(1)} km`)]),
    ]),
  ]
  return {
    categoryId: tracksCategory,
    icon: identity?.icon ?? contactIcon,
    color: identity === undefined ? contactColor : identifiedColor,
    summary: identity === undefined ? tierWord(data.tier) : `${tierWord(data.tier)} · ${identity.typeLabel}`,
    muted: data.tier === 'destroyed' || object.lifecycle !== 'active',
    fields,
  }
}

const presentEinsatzObject = (object: OperationalObject): PackObjectPresentation => {
  const data = dataOf(object)
  switch (data.type) {
    case 'unit':
    case 'task':
      return {
        categoryId: data.type === 'unit' ? unitsCategory : tasksCategory,
        icon: data.presentation.icon,
        color: data.type === 'unit' ? unitColor : taskColor,
        summary: data.presentation.typeLabel,
        muted: object.lifecycle !== 'active',
        fields: [],
      }
    case 'track':
      return presentTrack(object, data)
    case 'track-index':
      return {
        categoryId: trackIndexesCategory,
        icon: trackIndexIcon,
        color: contactColor,
        summary: `${Object.keys(data.subjects).length} ${neutralLexicon.tracks.toLowerCase()} · ${data.side}`,
        mapIconVisible: false,
        fields: [packField('side', 'Side', data.side)],
      }
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
      { id: unitsCategory, label: neutralLexicon.unitBoard, emptyLabel: `No ${neutralLexicon.unitBoard.toLowerCase()}`, matches: object => typeOf(object) === 'unit' },
      { id: tasksCategory, label: neutralLexicon.workList, emptyLabel: `No ${neutralLexicon.workList.toLowerCase()}`, matches: object => typeOf(object) === 'task' },
      { id: tracksCategory, label: neutralLexicon.tracks, emptyLabel: `No ${neutralLexicon.tracks.toLowerCase()}`, matches: object => typeOf(object) === 'track' },
      { id: trackIndexesCategory, label: 'Track indexes', emptyLabel: 'No track indexes', matches: object => typeOf(object) === 'track-index' },
    ],
    presentObject: object => presentEinsatzObject(object),
  },
} satisfies WorldPackView
