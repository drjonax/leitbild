import { z } from 'zod'
import type { OperationalObject } from '../../core/model/index.ts'
import { createWorldPackDescriptor, type PackObjectField, type PackObjectPresentation, type PackObjectPresentationContext, type PackObjectStatusPresentation, type WorldPackView } from '../../core/packs/protocol.ts'
import { packField } from '../../core/packs/presentation.ts'
import { contactIcon } from './board/contacts.ts'
import { clockText } from './board/text.ts'
import { plannedPathFeatures } from './chain-path.ts'
import { einsatzColors } from './colors.ts'
import { einsatzPackId, einsatzRuntimeId, groupRoleId } from './ids.ts'
import { neutralLexicon, unitPhases, type UnitPhase } from './lexicon.ts'
import { boardMapOrders } from './ui/map-orders.ts'

/**
 * The browser-safe Einsatz view. It reads only the presentation each object
 * carries and imports no engine, configuration validation or map catalogue.
 *
 * Every Einsatz object draws its catalogue icon natively: a unit or site its
 * type's, a task its template's, a track its identified type's or, as a
 * contact, a neutral one. A track shows only what its side knows. A contact
 * has a neutral icon and colour and no type, side or weapon range; an
 * identified track shows the type's icon and label, the side and the range;
 * a destroyed track keeps what it had and is muted. A side's track index,
 * which names the unit each track follows, reaches truth roles only and is
 * never drawn on the map.
 *
 * Each unit's job chain shows as its planned path: its route, then a
 * straight segment to each queued step's target (`chain-path.ts`).
 *
 * In a role Run a screen chooses which roles it sees (the role dialog's See
 * boxes, `seenRoleIds`): a unit of a group whose role it does not see is not
 * drawn on the map, nor is its planned path. That is a display filter of
 * this tab only; what a side sees at all stays the Run's, per side.
 *
 * Map labels: a unit shows its callsign and a short code of its phase, and
 * whether it is damaged; a receiving site, its name and whether it is
 * closed; a task, its label; a track, its serial and the age of its last
 * detection. A unit's status tone says whether it is free, committed or out
 * of action.
 *
 * The Board is the Pack's one surface panel and its only unit and task list,
 * so no category takes a rail section. Open by default, it takes every
 * map target click of an Einsatz unit and the World's keys, switches off the
 * map gestures its keys and clicks would collide with, and starts the
 * surface with the rail collapsed. Which units the map selects for orders is
 * `ordersOnMap` over the configuration the Board fetched (`ui/map-orders.ts`).
 */

/** The Board's panel id: its first segment names the Pack whose data revisions reach it. */
export const einsatzBoardPanelId = 'einsatz.board'

const unitsCategory = 'einsatz-units'
const tasksCategory = 'einsatz-tasks'
const tracksCategory = 'einsatz-tracks'
const trackIndexesCategory = 'einsatz-track-indexes'
const { unit: unitColor, task: taskColor, identified: identifiedColor, contact: contactColor } = einsatzColors
const trackIndexIcon = 'network'

/** Short neutral codes of the closed phase set for map labels; the Board words each phase from the configuration. */
const phaseCodes: Readonly<Record<UnitPhase, string>> = {
  available: 'AV',
  mobilizing: 'MOB',
  'en-route': 'ER',
  'on-task': 'OT',
  transporting: 'TR',
  'at-site': 'AS',
  returning: 'RT',
  holding: 'HD',
  destroyed: 'X',
}

const presentationSchema = z.object({ icon: z.string().min(1), typeLabel: z.string().min(1) }).strict()
const counts = z.record(z.string(), z.number())

const einsatzObjectSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('unit'),
    presentation: presentationSchema,
    phase: z.enum(unitPhases),
    integrity: z.enum(['healthy', 'damaged', 'destroyed']),
    taskId: z.string().min(1).optional(),
    group: z.string().min(1).optional(),
    load: counts,
    /** Present on a receiving site only. */
    accepting: z.boolean().optional(),
  }).loose(),
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
type UnitData = Extract<EinsatzObjectData, { type: 'unit' }>
type TrackData = Extract<EinsatzObjectData, { type: 'track' }>

const dataOf = (object: OperationalObject): EinsatzObjectData => einsatzObjectSchema.parse(object.packData)
const typeOf = (object: OperationalObject): EinsatzObjectData['type'] | null => object.packId === einsatzPackId ? dataOf(object).type : null

/** Whether the screen chose not to see the role of this unit's group. */
const groupUnseen = (group: string | undefined, seenRoleIds: ReadonlyArray<string> | undefined): boolean =>
  group !== undefined && seenRoleIds !== undefined && !seenRoleIds.includes(groupRoleId(group))

/** An Einsatz unit of a group whose role the screen chose not to see. */
const unitUnseen = (object: OperationalObject, seenRoleIds: ReadonlyArray<string> | undefined): boolean => {
  if (object.packId !== einsatzPackId) return false
  const data = dataOf(object)
  return data.type === 'unit' && groupUnseen(data.group, seenRoleIds)
}

const tierWord = (tier: TrackData['tier']): string =>
  tier === 'contact' ? neutralLexicon.contact : tier === 'identified' ? neutralLexicon.identified : neutralLexicon.destroyed

const dot = { shape: 'dot' } as const

/** Free (no task, no load), committed, or out of action, in neutral words. */
const unitStatus = (data: UnitData): PackObjectStatusPresentation => {
  if (data.integrity === 'destroyed') return { tone: 'error', label: neutralLexicon.destroyed, indicator: dot }
  const committed = data.taskId !== undefined || Object.values(data.load).some(count => count > 0)
  return committed ? { tone: 'working', label: 'Committed', indicator: dot } : { tone: 'ready', label: 'Free', indicator: dot }
}

const unitLabel = (object: OperationalObject, data: UnitData): string => {
  const parts = [object.label, phaseCodes[data.phase], ...(data.integrity === 'damaged' ? ['DMG'] : [])]
  return parts.join(' · ')
}

/** The track's serial and, while the Run clock is known, the age of its last detection. */
const trackLabel = (object: OperationalObject, context: PackObjectPresentationContext): string => {
  const observedAt = object.spatial.position?.observedAt
  const now = context.currentTime
  if (observedAt === undefined || now === undefined) return object.label
  return `${object.label} · ${clockText((Date.parse(now) - Date.parse(observedAt)) / 1_000)}`
}

const presentTrack = (object: OperationalObject, data: TrackData, context: PackObjectPresentationContext): PackObjectPresentation => {
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
    mapLabel: trackLabel(object, context),
  }
}

const presentEinsatzObject = (object: OperationalObject, context: PackObjectPresentationContext): PackObjectPresentation => {
  const data = dataOf(object)
  switch (data.type) {
    case 'unit': {
      const site = data.accepting !== undefined
      return {
        categoryId: unitsCategory,
        icon: data.presentation.icon,
        color: unitColor,
        summary: data.presentation.typeLabel,
        muted: object.lifecycle !== 'active' || data.integrity === 'destroyed',
        ...(groupUnseen(data.group, context.seenRoleIds) ? { mapIconVisible: false } : {}),
        fields: [],
        ...(site ? { mapLabel: data.accepting === true ? object.label : `${object.label} · closed` } : { mapLabel: unitLabel(object, data), status: unitStatus(data) }),
      }
    }
    case 'task':
      return {
        categoryId: tasksCategory,
        icon: data.presentation.icon,
        color: taskColor,
        summary: data.presentation.typeLabel,
        muted: object.lifecycle !== 'active',
        fields: [],
        mapLabel: object.label,
      }
    case 'track':
      return presentTrack(object, data, context)
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
    contributions: ['runtime', 'scenario', 'presentation', 'targeting'],
  }),
  runtime: {
    runtimes: [{ id: einsatzRuntimeId, version: '1.0.0', label: 'Local Einsatz runtime', kind: 'local', clock: 'simulation' }],
    defaultRuntimeId: einsatzRuntimeId,
  },
  presentation: {
    // The Board is the only unit and task list, so no category takes a rail section.
    categories: [
      { id: unitsCategory, label: neutralLexicon.unitBoard, emptyLabel: `No ${neutralLexicon.unitBoard.toLowerCase()}`, matches: object => typeOf(object) === 'unit', rail: false },
      { id: tasksCategory, label: neutralLexicon.workList, emptyLabel: `No ${neutralLexicon.workList.toLowerCase()}`, matches: object => typeOf(object) === 'task', rail: false },
      { id: tracksCategory, label: neutralLexicon.tracks, emptyLabel: `No ${neutralLexicon.tracks.toLowerCase()}`, matches: object => typeOf(object) === 'track', rail: false },
      { id: trackIndexesCategory, label: 'Track indexes', emptyLabel: 'No track indexes', matches: object => typeOf(object) === 'track-index', rail: false },
    ],
    presentObject: (object, context) => presentEinsatzObject(object, context),
    /** Each unit's queued steps as straight segments after its route: the planned path of its job chain. */
    mapFeatures: context => {
      const unseen = new Set(context.objects.filter(object => unitUnseen(object, context.seenRoleIds)).map(object => object.id as string))
      return plannedPathFeatures(context.objects, unitsCategory, unitId => !unseen.has(unitId))
    },
    mapFeatureLayers: ['routes'],
    mapFeatureSourcePackIds: [einsatzPackId],
  },
  targeting: {
    isController: boardMapOrders.isController,
    // Another role's units are drawn muted; a tap on one says who commands it.
    mutedOnMap: boardMapOrders.mutedOnMap,
    // Every map order for an Einsatz unit goes to the open Board's `onMapTarget`; the generic surface never sends one.
    isTarget: () => false,
    buildSetTargetCommand: controller => { throw new Error(`Einsatz map orders go through the Board, never the generic map path: ${controller.id}`) },
    buildCancelTargetCommand: controller => { throw new Error(`Einsatz map orders go through the Board, never the generic map path: ${controller.id}`) },
  },
  ui: {
    surfacePanels: [{
      id: einsatzBoardPanelId,
      label: neutralLexicon.workList,
      defaultOpen: true,
      mapTargets: true,
      keymap: true,
      load: async () => await import('./ui/BoardPanel.svelte'),
    }],
    mapInteraction: { doubleClickZoom: false, keyboard: false, boxZoom: false },
    surfaceLayout: { railCollapsed: true },
  },
} satisfies WorldPackView
