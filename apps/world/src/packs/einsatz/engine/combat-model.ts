import { z } from 'zod'
import { idSchema, type GeoJsonPoint } from '../../../core/model/index.ts'
import { configIdSchema, type UnitType } from '../config-schema.ts'
import { wordFor, type Lexicon } from '../lexicon.ts'
import type { UnitRecord } from './model.ts'

/**
 * Detection and engagement state. A track is one side's knowledge of one
 * unit of another side: its tier, whether a fire-control fix holds, and once
 * identified the type's label and icon, the unit's side and weapon range.
 * Nothing else: never integrity, phase, task, heading, speed, route,
 * properties or fire received, and its id never derives from the unit's.
 * Which unit a track follows is kept in a hidden index per observing side.
 */

export const trackTiers = ['contact', 'identified', 'destroyed'] as const
export type TrackTier = typeof trackTiers[number]

const simulationMs = z.number().finite().nonnegative()

/** What an identification adds: the type's label and icon, the unit's side and its effector range. */
export const trackIdentitySchema = z.object({
  typeLabel: z.string().min(1).max(120),
  icon: z.string().min(1).max(100),
  side: configIdSchema,
  rangeM: z.number().finite().positive().optional(),
}).strict()
export type TrackIdentity = z.output<typeof trackIdentitySchema>

/**
 * A track's `packData`. A contact carries no identity; an identified track
 * does; a destroyed track keeps what it had when the kill was observed.
 */
export const trackDataSchema = z.object({
  type: z.literal('track'),
  tier: z.enum(trackTiers),
  fix: z.boolean(),
  identity: trackIdentitySchema.optional(),
}).strict().refine(data => data.tier === 'destroyed' || (data.tier === 'identified') === (data.identity !== undefined), 'A contact carries no identity; an identified track does')
export type TrackData = z.output<typeof trackDataSchema>

/** The hidden per-side index: the next track number and which unit each of the side's tracks follows. Truth only. */
export const trackIndexDataSchema = z.object({
  type: z.literal('track-index'),
  side: configIdSchema,
  next: z.number().int().positive(),
  subjects: z.record(idSchema, idSchema),
}).strict()
export type TrackIndexData = z.output<typeof trackIndexDataSchema>

/** A track as the engine holds it: its `packData`, plus the observing side and the unit it follows, which no side-visible field carries. */
export type TrackRecord = TrackData & { readonly id: string; readonly label: string; readonly side: string; readonly subjectId: string }
export type TrackIndexRecord = TrackIndexData & { readonly id: string; readonly label: string }

/** Where a track's unit was at its last detection, when that was, and the last detection by an identifying sensor. Per cycle, never journaled. */
export interface Sighting {
  readonly point: GeoJsonPoint
  readonly observedAtMs: number
  readonly fixAtMs?: number
}

/** Per-cycle engagement values of a unit, never journaled: fire-seconds received, and when it last fired and was last hit. */
export interface UnitCombat {
  readonly fireS: number
  readonly firedAtMs?: number
  readonly hitAtMs?: number
}

export interface CombatState {
  /** The last 2 s boundary whose engagement step ran. */
  readonly cycleMs?: number
  readonly tracks: ReadonlyMap<string, TrackRecord>
  readonly sightings: ReadonlyMap<string, Sighting>
  readonly units: ReadonlyMap<string, UnitCombat>
  /** Per observing side, the number its next track takes. */
  readonly serials: ReadonlyMap<string, number>
}

export const emptyCombatState = (): CombatState => ({ tracks: new Map(), sightings: new Map(), units: new Map(), serials: new Map() })

/** The per-cycle engagement values saved with the runtime state. */
export const combatRuntimeSchema = z.object({
  cycleMs: simulationMs.optional(),
  units: z.record(idSchema, z.object({ fireS: z.number().finite().nonnegative(), firedAtMs: simulationMs.optional(), hitAtMs: simulationMs.optional() }).strict()),
  tracks: z.record(idSchema, z.object({ fixAtMs: simulationMs }).strict()),
}).strict()
export type CombatRuntime = z.output<typeof combatRuntimeSchema>

/** Ids the engine gives a side's tracks and its track index. No unit or task may take one: a track would overwrite it in the Run. */
export const trackId = (side: string, number: number): string => `track:${side}:${number}`
export const trackIndexId = (side: string): string => `tracks:${side}`
export const isTrackId = (id: string): boolean => id.startsWith('track:') || id.startsWith('tracks:')

/** A side's track index as the state holds it: its next track number and which unit each of its tracks follows. */
export const trackIndexOf = (lexicon: Lexicon, side: string, tracks: ReadonlyMap<string, TrackRecord>, serials: ReadonlyMap<string, number>): TrackIndexRecord => ({
  id: trackIndexId(side),
  label: `${wordFor(lexicon, 'tracks')} · ${side}`,
  type: 'track-index',
  side,
  next: serials.get(side) ?? 1,
  subjects: Object.fromEntries([...tracks.values()].filter(track => track.side === side).sort((a, b) => a.id < b.id ? -1 : 1).map(track => [track.id, track.subjectId])),
})

/** The sides holding tracks or having numbered one. */
export const trackingSides = (state: Pick<CombatState, 'tracks' | 'serials'>): string[] =>
  [...new Set([...state.serials.keys(), ...[...state.tracks.values()].map(track => track.side)])].sort()

/** A unit of a type with an effector starts with the type's `roe` standing order, which validation requires of every such type. */
export const initialRoe = (type: UnitType): NonNullable<UnitRecord['roe']> => {
  const roe = type.standingOrders?.roe
  if (roe === undefined) throw new Error(`${type.id}: a type with an effector has no roe standing order`)
  return roe
}

/**
 * Engagement fields a unit starts with: its rules of engagement, and, in a
 * Run with sides, where the engagement step keeps posture, standing still
 * since it was created.
 */
export const engagementFieldsAtCreate = (type: UnitType, atMs: number, sided: boolean): Pick<UnitRecord, 'roe' | 'stillSinceMs'> => ({
  ...(type.components.effector === undefined ? {} : { roe: initialRoe(type) }),
  ...(type.components.signature === undefined || !sided ? {} : { stillSinceMs: atMs }),
})
