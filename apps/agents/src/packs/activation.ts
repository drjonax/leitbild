// Pack activation resolver — single source of truth for "which packs are
// active in room X."
//
// room.activePacks is the complete, explicit list. Installing a Pack does
// not activate it, and no synthetic or implicit Packs are added at read time.

import { z } from 'zod'

export const roomPacksInputSchema = z.object({ activePacks: z.array(z.string().min(1)) }).strict()

export type RoomPacksResult =
  | { readonly ok: true; readonly activePacks: ReadonlyArray<string> }
  | { readonly ok: false; readonly code: 'room_not_found' | 'unknown_pack'; readonly message: string }

export interface RoomActivation {
  readonly getActivePacks: () => ReadonlyArray<string>
}

// Effective active packs for a room — exactly what the room reports.
// Kept as a wrapper (rather than inlining room.getActivePacks() at call
// sites) so that any future indirection (e.g. tenant-level overrides)
// has a single hook to extend.
//
// NOTE: this list is an ALLOWLIST for tool/skill/script visibility per room.
// It does NOT govern resolution order for collisions. Pack-owned geodata
// category metadata (see src/geo/pack-source.ts:reload) is built once at
// boot across ALL installed packs in filesystem-scan order — first-feature-
// wins per category id, regardless of which packs are active in a given
// room. Pack authors must namespace their category ids to avoid collisions.
export const effectiveActivePacks = (room: RoomActivation): ReadonlyArray<string> =>
  room.getActivePacks()

// Set membership form for hot-path filters (e.g. tool surface filter on
// every agent spawn).
export const effectiveActivePackSet = (room: RoomActivation): ReadonlySet<string> =>
  new Set(effectiveActivePacks(room))

// True if a pack identified by `packId` is active in the room.
// Tools without a Pack owner are outside this gate.
export const isPackActiveInRoom = (
  room: RoomActivation,
  packId: string,
): boolean => effectiveActivePackSet(room).has(packId)
