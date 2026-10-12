import type { AdapterId } from '../../core/model/index.ts'

/** The Pack id every Einsatz object carries, the local runtime's id and the adapter id its objects' provenance names. */
export const einsatzPackId = 'einsatz'
export const einsatzRuntimeId = 'einsatz.local'
export const einsatzAdapterId = 'adapter:einsatz.local' as AdapterId
