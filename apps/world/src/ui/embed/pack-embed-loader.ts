// The Packs' embed-only contributions (ruling Q19): panels drawn with
// OpenBridge, which no chunk the World application loads may reach, so only
// the embed bundle imports this file. It is the one embed file that names
// Packs: each one's packs/<pack>/ui/embed.ts, whose default export is its
// PackEmbedContribution. The vignette itself names none.
import type { PackEmbedContribution } from '../../core/packs/protocol.ts'

const embedLoaders: Readonly<Record<string, () => Promise<{ readonly default: PackEmbedContribution }>>> = {}

/** A Pack's embed contribution; null for a Pack that contributes none. */
export const loadEmbedPack = async (packId: string): Promise<PackEmbedContribution | null> =>
  Object.hasOwn(embedLoaders, packId) ? (await embedLoaders[packId]!()).default : null
