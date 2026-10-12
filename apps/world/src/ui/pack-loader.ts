import { createActivePackViews, type ActivePackViews } from '../core/packs/active-views.ts'
import type { WorldPackView } from '../core/packs/protocol.ts'

type PackLoader = () => Promise<WorldPackView>

const packLoaders = {
  ambulance: async () => (await import('../packs/ambulance/ui-pack.ts')).ambulancePackView,
  einsatz: async () => (await import('../packs/einsatz/ui-pack.ts')).einsatzPackView,
  weather: async () => (await import('../packs/weather/pack.ts')).weatherPack,
  'situation-monitor': async () => (await import('../packs/situation-monitor/ui-pack.ts')).situationMonitorPackView,
  drone: async () => (await import('../packs/drone/ui-pack.ts')).dronePackView,
  'process-plant': async () => (await import('../packs/process-plant/ui-pack.ts')).processPlantPackView,
  'electric-grid': async () => (await import('../packs/electric-grid/ui-pack.ts')).electricGridPackView,
} satisfies Record<string, PackLoader>

type KnownUiPackId = keyof typeof packLoaders

/** Reviewed browser entry points. A parity test keeps this boundary aligned with the server assembly. */
export const knownUiPackIds: ReadonlyArray<string> = Object.keys(packLoaders).sort()

const loadedPacks = new Map<string, WorldPackView>()

const isKnownUiPackId = (packId: string): packId is KnownUiPackId =>
  Object.hasOwn(packLoaders, packId)

export const loadUiPack = async (packId: string): Promise<WorldPackView> => {
  const loaded = loadedPacks.get(packId)
  if (loaded) return loaded
  if (!isKnownUiPackId(packId)) throw new Error(`scenario references unknown UI pack: ${packId}`)
  const pack = await packLoaders[packId]()
  if (pack.descriptor.id !== packId) throw new Error(`UI pack loader for ${packId} returned ${pack.descriptor.id}`)
  loadedPacks.set(packId, pack)
  return pack
}

export const loadActivePackViews = async (
  packIds: ReadonlyArray<string>,
): Promise<ActivePackViews> => {
  if (packIds.length === 0) throw new Error('scenario declares no active packs')
  const uniquePackIds = new Set(packIds)
  if (uniquePackIds.size !== packIds.length) {
    const duplicates = packIds.filter((packId, index) => packIds.indexOf(packId) !== index)
    throw new Error(`scenario declares duplicate packs: ${[...new Set(duplicates)].join(', ')}`)
  }
  const packs = await Promise.all(packIds.map(loadUiPack))
  return createActivePackViews(packs)
}
