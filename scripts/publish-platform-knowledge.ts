import { publishKnowledge } from '../packages/knowledge/src/publish.ts'
import { createKnowledge, type KnowledgeSnapshot } from '../packages/knowledge/src/index.ts'
import { worldPacks } from '../apps/world/src/app-assembly.ts'

/** Build-time composition only: validate the links contributed by installed Packs
 * against the exact publication, without a second list of canonical wiki paths. */
export const validateContributedKnowledgeLinks = (
  snapshot: KnowledgeSnapshot,
  contributions: ReadonlyArray<{ readonly owner: string; readonly url: string }>,
): void => {
  const knowledge = createKnowledge(snapshot)
  for (const contribution of contributions) {
    // External references remain supported; this gate proves only the local
    // publication, not availability or contents of third-party documentation.
    if (/^https?:\/\//i.test(contribution.url)) continue
    const url = new URL(contribution.url, 'https://leitbild.invalid')
    if (!contribution.url.startsWith('/wiki?') || url.pathname !== '/wiki') {
      throw new Error(`Invalid local wiki contribution from ${contribution.owner}: ${contribution.url}`)
    }
    const path = url.searchParams.get('path')
    if (!path) throw new Error(`Missing wiki path from ${contribution.owner}`)
    try {
      knowledge.read(path, url.hash ? { section: decodeURIComponent(url.hash.slice(1)) } : {})
    } catch (error) {
      throw new Error(`Invalid wiki contribution from ${contribution.owner}: ${contribution.url}`, { cause: error })
    }
  }
}

export const publishPlatformKnowledge = async (root: string, sourceRoot: string): Promise<KnowledgeSnapshot> => {
  const snapshot = await publishKnowledge(root, sourceRoot)
  validateContributedKnowledgeLinks(snapshot, worldPacks.flatMap(pack =>
    (pack.knowledge?.wikiRefs ?? []).map(ref => ({ owner: pack.descriptor.id, url: ref.url }))))
  return snapshot
}
