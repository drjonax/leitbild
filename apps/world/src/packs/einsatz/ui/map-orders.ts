import { z } from 'zod'
import type { OperationalObject } from '../../../core/model/index.ts'
import type { PackTargetContext } from '../../../core/packs/protocol.ts'
import { configIdSchema, type EinsatzConfig } from '../config-schema.ts'
import { einsatzPackId } from '../ids.ts'
import { ordersOnMap, type PictureRole, type PictureTypes } from '../picture.ts'
import { pictureViewerOf } from './screen-viewer.ts'

/**
 * Which Einsatz units the map selects to give orders: the Pack's
 * `targeting.isController`. It is `ordersOnMap` (picture.ts) for the role
 * view core gives the screen, read against the configuration the Board
 * fetched, so the map and the Board apply one rule over one configuration.
 *
 * The Board connects its configuration and the Run's declared roles once it
 * has them and releases them when it unmounts. Until then no unit is a map
 * controller: a click on one only selects it, which the Board then shows,
 * and no map order can reach a Board that is not ready to take it.
 *
 * This state is not reactive, so the surface cannot see it change. The Board
 * therefore connects here first and lends the surface its map targets
 * (`connectInteraction`) right after; the surface's selected controller
 * depends on the lent handlers, so lending them makes it ask `isController`
 * again, and a unit selected while the configuration was on its way becomes
 * the controller without another click. Releasing works the same way round.
 * Passing the configuration and declared roles through `PackTargetContext`
 * instead (a core protocol change) is the coordinator's open decision; until
 * then this Pack-local connection is the one path.
 */

export interface MapOrderSource {
  readonly config: EinsatzConfig
  /** The roles the Run declares; none in a Run without roles. */
  readonly roles: ReadonlyArray<PictureRole>
}

export interface MapOrders {
  /** Lends the Board's configuration and the declared roles; returns their release. */
  readonly connect: (source: MapOrderSource) => () => void
  readonly isController: (object: OperationalObject, context: PackTargetContext) => boolean
}

const recordTypeSchema = z.object({ type: z.string().min(1) }).loose()
const unitSchema = z.object({ type: z.literal('unit'), unitType: configIdSchema, side: configIdSchema.optional() }).loose()

const pictureTypesOf = (config: EinsatzConfig): PictureTypes => {
  const types = new Map(config.unitTypes.map(type => [type.id, type]))
  return {
    authority: config.authority,
    unitType: unitTypeId => {
      const type = types.get(unitTypeId)
      if (type === undefined) throw new Error(`Unit type ${unitTypeId} is not declared`)
      return type
    },
  }
}

export const createMapOrders = (): MapOrders => {
  let connected: { readonly source: MapOrderSource; readonly types: PictureTypes } | null = null
  return {
    connect: source => {
      const entry = { source, types: pictureTypesOf(source.config) }
      connected = entry
      return () => {
        if (connected === entry) connected = null
      }
    },
    isController: (object, context) => {
      if (object.packId !== einsatzPackId || connected === null) return false
      // A task, a track or a track index is never a controller; a unit record that does not parse is an error.
      if (recordTypeSchema.parse(object.packData).type !== 'unit') return false
      return ordersOnMap(connected.types, pictureViewerOf(connected.source.roles, context.viewer), unitSchema.parse(object.packData))
    },
  }
}

/** The one Board of this screen connects here; the Einsatz Pack view's targeting reads it. */
export const boardMapOrders: MapOrders = createMapOrders()
