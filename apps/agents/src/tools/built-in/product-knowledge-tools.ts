import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { loadKnowledge, knowledgeSnapshotPath, type Knowledge } from '@leitbild/knowledge'
import type { Tool } from '../../core/types/tool.ts'
import {
  MAX_PRODUCT_SOURCE_BYTES,
  listProductSourcePaths,
  productDocumentAuthority,
  productDocumentKind,
  readProductRevision,
  type ProductDocumentAuthority,
  type ProductDocumentKind,
} from '@leitbild/knowledge/source'

const MAX_CORPUS_BYTES = 32_000_000
const MAX_READ_LINES = 200

interface ProductDocument {
  readonly revision?: string
  readonly path: string
  readonly kind: ProductDocumentKind
  readonly authority: ProductDocumentAuthority
  readonly content: string
  readonly lines: ReadonlyArray<string>
}

interface ProductCorpus {
  readonly revision: string
  readonly documents: ReadonlyArray<ProductDocument>
}

const searchInputSchema = z.object({
  query: z.string().trim().min(1).max(256),
  kind: z.enum(['all', 'documentation', 'source']).default('all'),
  limit: z.number().int().min(1).max(20).default(8),
  offset: z.number().int().nonnegative().default(0),
  includeQuality: z.boolean().default(false),
}).strict()

const readInputSchema = z.object({
  path: z.string().trim().min(1).max(1_024),
  startLine: z.number().int().min(1).optional(),
  lineCount: z.number().int().min(1).max(MAX_READ_LINES).default(80),
  revision: z.string().optional(),
  section: z.string().optional(),
}).strict()

const loadCorpus = async (root: string): Promise<ProductCorpus> => {
  const documents: ProductDocument[] = []
  let totalBytes = 0
  for (const path of await listProductSourcePaths(root)) {
    const absolutePath = resolve(root, path)
    const file = await stat(absolutePath)
    if (file.size > MAX_PRODUCT_SOURCE_BYTES) continue
    totalBytes += file.size
    if (totalBytes > MAX_CORPUS_BYTES) throw new Error(`Product knowledge corpus exceeds ${MAX_CORPUS_BYTES} bytes`)
    const content = await readFile(absolutePath, 'utf8')
    documents.push({ path, kind: productDocumentKind(path), authority: productDocumentAuthority(path), content, lines: content.split(/\r?\n/) })
  }
  return { revision: await readProductRevision(root), documents }
}

const STOP_TERMS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'i', 'in', 'is', 'it', 'me', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'what', 'where', 'with'])
const normalizeTerms = (query: string): ReadonlyArray<string> => {
  const meaningful = [...new Set(query.toLocaleLowerCase().split(/[^\p{L}\p{N}_.-]+/u).filter(term => term.length > 1 && !STOP_TERMS.has(term)))]
  return meaningful.length > 0 ? meaningful : [query.toLocaleLowerCase()]
}

export const createProductKnowledgeTools = (options: { readonly repoRoot?: string; readonly knowledge?: () => Promise<Knowledge> } = {}): ReadonlyArray<Tool> => {
  const root = resolve(options.repoRoot ?? resolve(import.meta.dir, '../../../../..'))
  let corpusPromise: Promise<ProductCorpus> | undefined
  // Share successful immutable-release data and concurrent initialization, but
  // do not turn a transient filesystem failure into a deployment-long outage.
  const corpus = (): Promise<ProductCorpus> => corpusPromise ??= loadCorpus(root).catch(error => {
    corpusPromise = undefined
    throw error
  })
  const knowledge = options.knowledge ?? (() => loadKnowledge(knowledgeSnapshotPath(root)))

  const search: Tool = {
    name: 'product_search',
    description: 'Search the unified Leitbild wiki, executable skill guidance and deployed source. Knowledge explains models and assumptions; source establishes implemented behavior. Both are revision identified.',
    usage: 'Use before explaining Leitbild internals; then read the most relevant exact paths.',
    returns: 'Revision-tagged matches with path, line, and a bounded source snippet. Partial coverage explicitly identifies unavailable corpora; retry after they recover.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 256 },
        kind: { type: 'string', enum: ['all', 'documentation', 'source'], default: 'all' },
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 8, description: 'Maximum matches per corpus: knowledge and deployed source. Coverage and next offsets are returned separately.' },
        offset: { type: 'integer', minimum: 0, default: 0 },
        includeQuality: { type: 'boolean', default: false, description: 'Include quality/evaluation evidence only when that material is relevant to the question.' },
      },
      required: ['query'],
    },
    execute: async params => {
      const input = searchInputSchema.safeParse(params)
      if (!input.success) return { success: false, error: input.error.message }
      const [sourceResult, wikiResult] = await Promise.allSettled([
        corpus(), input.data.kind === 'source' ? Promise.resolve(undefined) : Promise.resolve().then(async () => {
          const wiki = await knowledge()
          return { revision: wiki.revision, found: wiki.search(input.data.query, { offset: input.data.offset, limit: input.data.limit, includeQuality: input.data.includeQuality }) }
        }),
      ])
      const loaded = sourceResult.status === 'fulfilled' ? sourceResult.value : undefined
      const warnings: string[] = []
      let knowledgeMatches: ReadonlyArray<{ path: string; revision: string; kind: string; authority: string; line: number; snippet: string; section?: string | undefined }> = []
      let knowledgeCoverage: { total: number; returned: number; nextOffset?: number } | { unavailable: true } | undefined
      if (sourceResult.status === 'rejected') warnings.push(`Deployed source unavailable: ${sourceResult.reason instanceof Error ? sourceResult.reason.message : String(sourceResult.reason)}`)
      if (wikiResult.status === 'rejected') {
        warnings.push(`Knowledge publication unavailable: ${wikiResult.reason instanceof Error ? wikiResult.reason.message : String(wikiResult.reason)}`)
        knowledgeCoverage = { unavailable: true }
      }
      if (wikiResult.status === 'fulfilled' && wikiResult.value !== undefined) {
        const { revision, found } = wikiResult.value
        knowledgeCoverage = { total: found.total, returned: found.matches.length, ...(found.nextOffset !== undefined ? { nextOffset: found.nextOffset } : {}) }
        knowledgeMatches = found.matches.map(match => ({
          ...match, path: `knowledge/${match.path}`, revision, kind: 'documentation', authority: 'documentation',
        }))
      }
      if (!loaded && (wikiResult.status === 'rejected' || wikiResult.value === undefined)) {
        return { success: false, error: warnings.join('; ') }
      }
      const terms = normalizeTerms(input.data.query)
      const rankedMatches = (loaded?.documents ?? [])
        .filter(document => input.data.kind === 'all' || document.kind === input.data.kind)
        .flatMap(document => {
          const lowerPath = document.path.toLocaleLowerCase()
          const lowerContent = document.content.toLocaleLowerCase()
          if (!terms.some(term => lowerPath.includes(term) || lowerContent.includes(term))) return []
          let bestLine = 0
          let bestLineScore = -1
          for (let index = 0; index < document.lines.length; index += 1) {
            const lowerLine = document.lines[index]!.toLocaleLowerCase()
            const score = terms.reduce((sum, term) => sum + (lowerLine.includes(term) ? 3 : 0), 0)
            if (score > bestLineScore) { bestLine = index; bestLineScore = score }
          }
          const pathScore = terms.reduce((sum, term) => sum + (lowerPath.includes(term) ? 6 : 0), 0)
          const coverage = terms.reduce((sum, term) => sum + (lowerContent.includes(term) ? 1 : 0), 0)
          const from = Math.max(0, bestLine - 1)
          const to = Math.min(document.lines.length, bestLine + 2)
          const authorityScore = document.authority === 'implementation' ? 5 : document.authority === 'decision' ? 4 : document.authority === 'domain-language' ? 3 : 0
          return [{
            score: pathScore + bestLineScore + coverage + authorityScore,
            path: document.path,
            revision: document.revision ?? loaded!.revision,
            kind: document.kind,
            authority: document.authority,
            line: bestLine + 1,
            snippet: document.lines.slice(from, to).join('\n').slice(0, 1_200),
          }]
        })
        .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
        .map(({ score: _score, ...match }) => match)
      const matches = rankedMatches.slice(input.data.offset, input.data.offset + input.data.limit)
      return { success: true, data: { ...(loaded ? { revision: loaded.revision } : {}), query: input.data.query, matches: [...knowledgeMatches, ...matches],
        coverage: { partial: warnings.length > 0, knowledge: knowledgeCoverage, source: loaded ? { total: rankedMatches.length, returned: matches.length,
          ...(input.data.offset + matches.length < rankedMatches.length ? { nextOffset: input.data.offset + matches.length } : {}) } : { unavailable: true } },
        ...(warnings.length ? { warnings } : {}) } }
    },
  }

  const read: Tool = {
    name: 'product_read',
    description: 'Read selected lines or a wiki section from exact discovered paths. Supply requests to retrieve several independent pieces together; each result reports its own revision and coverage.',
    usage: 'Use exact search-result paths. Runtime data, deployment configuration, secrets, generated output, and arbitrary filesystem paths are inaccessible.',
    returns: 'Revision-tagged numbered lines and explicit range metadata.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 1024 },
        startLine: { type: 'integer', minimum: 1, description: 'Omit to start at the selected section, or line 1 for a whole-document read. Use nextLine to continue.' },
        lineCount: { type: 'integer', minimum: 1, maximum: MAX_READ_LINES, default: 80 },
        revision: { type: 'string', description: 'Expected document revision from search; mismatch fails rather than silently reading changed text.' },
        section: { type: 'string', description: 'Knowledge heading anchor; reads that section instead of guessing line offsets.' },
        requests: { type: 'array', minItems: 1, description: 'Batch of independent reads, instead of the top-level path.', items: {
          type: 'object', additionalProperties: false, required: ['path'], properties: {
            path: { type: 'string' }, revision: { type: 'string' }, section: { type: 'string' },
            startLine: { type: 'integer', minimum: 1 }, lineCount: { type: 'integer', minimum: 1, maximum: MAX_READ_LINES },
          },
        } },
      },
    },
    execute: async (params, context) => {
      if (Array.isArray(params.requests)) {
        const batch = z.object({ requests: z.array(readInputSchema).min(1) }).strict().safeParse(params)
        if (!batch.success) return { success: false, error: batch.error.message }
        return { success: true, data: { results: await Promise.all(batch.data.requests.map(request => read.execute(request, context))) } }
      }
      const input = readInputSchema.safeParse(params)
      if (!input.success) return { success: false, error: input.error.message }
      if (input.data.path.startsWith('knowledge/')) {
        try {
          const wiki = await knowledge()
          const result = wiki.read(input.data.path.slice('knowledge/'.length), {
            ...(input.data.startLine !== undefined ? { startLine: input.data.startLine } : {}), lineCount: input.data.lineCount,
            ...(input.data.revision ? { revision: input.data.revision } : {}),
            ...(input.data.section ? { section: input.data.section } : {}),
          })
          return { success: true, data: { ...result, path: input.data.path,
            parent: result.parent === null ? null : `knowledge/${result.parent}`,
            children: result.children.map(child => ({ ...child, path: `knowledge/${child.path}`, parent: child.parent === null ? null : `knowledge/${child.parent}` })),
            kind: 'documentation', authority: 'documentation' } }
        } catch (error) { return { success: false, error: error instanceof Error ? error.message : 'Knowledge read failed' } }
      }
      let loaded: ProductCorpus
      try { loaded = await corpus() }
      catch (error) { return { success: false, error: `Deployed source unavailable: ${error instanceof Error ? error.message : String(error)}` } }
      if (input.data.section !== undefined) return { success: false, error: 'section is supported for knowledge paths only; use source line ranges.' }
      if (input.data.revision && input.data.revision !== loaded.revision) return { success: false, error: 'Source revision changed; rediscover the deployed source.' }
      const document = loaded.documents.find(candidate => candidate.path === input.data.path)
      if (!document) return { success: false, error: 'Path is not in the Leitbild product knowledge corpus; search for an allowed path first.' }
      const startLine = input.data.startLine ?? 1
      const startIndex = startLine - 1
      if (startIndex >= document.lines.length) return { success: false, error: `startLine exceeds the file's ${document.lines.length} lines` }
      const selected = document.lines.slice(startIndex, startIndex + input.data.lineCount)
      return { success: true, data: {
        revision: loaded.revision,
        path: document.path,
        kind: document.kind,
        authority: document.authority,
        startLine,
        endLine: startLine + selected.length - 1,
        totalLines: document.lines.length,
        content: selected.map((line, index) => `${startLine + index}: ${line}`).join('\n'),
      } }
    },
  }

  return [search, read]
}
