import { z } from 'zod'
import { idSchema } from './ids.ts'
import type { RoleSees, ScenarioSide } from './roles.ts'

/**
 * Whose picture holds an object in a Run that declares sides: every side
 * ('public'), truth roles only ([]), or the named sides. Core requires it on
 * every object of a sided Run and never lets it change; a Run without sides
 * ignores it entirely.
 */
export type ObjectAudience = 'public' | ReadonlyArray<string>

export const objectAudienceSchema = z.union([
  z.literal('public'),
  z.array(idSchema).superRefine((sideIds, ctx) => {
    const seen = new Set<string>()
    sideIds.forEach((sideId, index) => {
      if (seen.has(sideId)) ctx.addIssue({ code: 'custom', path: [index], message: `audience names a side twice: ${sideId}` })
      seen.add(sideId)
    })
  }),
])

/** Whether a view that sees this sees an object of this audience. An object without one reaches truth views only. */
export const audienceVisibleTo = (audience: ObjectAudience | undefined, sees: RoleSees): boolean => {
  if (sees === 'all') return true
  if (audience === undefined) return false
  if (audience === 'public') return true
  return audience.some(sideId => sees.includes(sideId))
}

export const sameAudience = (left: ObjectAudience | undefined, right: ObjectAudience | undefined): boolean => {
  if (left === undefined || right === undefined || left === 'public' || right === 'public') return left === right
  return left.length === right.length && left.every(sideId => right.includes(sideId))
}

export const audienceRefusalCodes = ['audience_required', 'audience_undeclared_side', 'audience_changed'] as const
export type AudienceRefusalCode = typeof audienceRefusalCodes[number]

export interface AudienceIssue {
  readonly code: AudienceRefusalCode
  /** Names the code and the Pack, never the object: a refusal may reach a view that does not see it. */
  readonly message: string
  /** For the server log and authoring paths only. */
  readonly objectId: string
}

/**
 * Why a sided Run refuses this object, or null when it may be committed: it
 * must carry an audience, name only declared sides, and keep the audience its
 * earlier revision had.
 */
export const sidedObjectAudienceIssue = (
  object: { readonly id: string; readonly packId: string; readonly audience?: ObjectAudience | undefined },
  previous: { readonly audience?: ObjectAudience | undefined } | undefined,
  sides: ReadonlyArray<ScenarioSide>,
): AudienceIssue | null => {
  const issue = (code: AudienceRefusalCode, message: string): AudienceIssue => ({ code, message: `${code}: ${message}`, objectId: object.id })
  if (object.audience === undefined) {
    return issue('audience_required', `a ${object.packId} object has no audience; every object of a Run that declares sides says whose picture it belongs to`)
  }
  if (object.audience !== 'public') {
    const undeclared = object.audience.filter(sideId => !sides.some(side => side.id === sideId))
    if (undeclared.length > 0) return issue('audience_undeclared_side', `a ${object.packId} object names sides this Run does not declare: ${undeclared.join(', ')}`)
  }
  if (previous !== undefined && !sameAudience(previous.audience, object.audience)) {
    return issue('audience_changed', `a ${object.packId} object cannot change its audience`)
  }
  return null
}
