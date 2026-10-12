import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { workspaceIdSchema, type WorkspaceId } from '@leitbild/contracts'

const revisionIdSchema = z.string().regex(/^revision-[a-f0-9]{32}$/)

const definitionRecordSchema = z.object({
  id: z.string().min(1).max(128),
  title: z.string().min(1).max(256),
  description: z.string().min(1).max(4096).optional(),
  category: z.string().min(1).max(128).optional(),
  currentRevisionId: revisionIdSchema,
  seedRevisionId: revisionIdSchema.optional(),
  revisionIds: z.array(revisionIdSchema).min(1),
}).strict()

const definitionIndexSchema = z.object({
  workspaceId: workspaceIdSchema,
  definitions: z.array(definitionRecordSchema),
}).strict().superRefine((index, ctx) => {
  const ids = new Set<string>()
  index.definitions.forEach((definition, definitionIndex) => {
    if (ids.has(definition.id)) {
      ctx.addIssue({ code: 'custom', path: ['definitions', definitionIndex, 'id'], message: `duplicate Definition: ${definition.id}` })
    }
    ids.add(definition.id)
    if (!definition.revisionIds.includes(definition.currentRevisionId)) {
      ctx.addIssue({ code: 'custom', path: ['definitions', definitionIndex, 'currentRevisionId'], message: 'current revision is absent from revision history' })
    }
    if (definition.seedRevisionId !== undefined && !definition.revisionIds.includes(definition.seedRevisionId)) {
      ctx.addIssue({ code: 'custom', path: ['definitions', definitionIndex, 'seedRevisionId'], message: 'seed revision is absent from revision history' })
    }
  })
})

const deletedDefinitionsSchema = z.object({
  definitionIds: z.array(z.string().min(1).max(128)),
}).strict()

export type DefinitionRecord = z.infer<typeof definitionRecordSchema>

export interface DefinitionMetadata {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly category?: string
}

export interface DefinitionRevision<TDocument> {
  readonly id: string
  readonly workspaceId: WorkspaceId
  readonly definitionId: string
  readonly digest: string
  readonly createdAt: string
  readonly document: TDocument
}

export interface RevisionedDefinitionStore<TDocument> {
  readonly seed: (documents: ReadonlyArray<TDocument>) => Promise<void>
  readonly create: (document: TDocument) => Promise<DefinitionRevision<TDocument>>
  readonly update: (document: TDocument, expectedRevisionId: string) => Promise<DefinitionRevision<TDocument>>
  readonly list: () => Promise<ReadonlyArray<DefinitionRecord>>
  readonly get: (definitionId: string) => Promise<DefinitionRecord | undefined>
  readonly currentRevision: (definitionId: string) => Promise<DefinitionRevision<TDocument> | undefined>
  readonly getRevision: (revisionId: string) => Promise<DefinitionRevision<TDocument> | undefined>
  readonly delete: (definitionId: string, expectedRevisionId: string) => Promise<boolean>
}

// Keys sort by UTF-16 code unit, not localeCompare: a revision id must not
// depend on the process locale that happened to compute it.
export const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

const definitionDigest = (document: unknown): string => createHash('sha256').update(stableJson(document)).digest('hex')
const revisionIdForDigest = (digest: string): string => `revision-${digest.slice(0, 32)}`

/**
 * The revision id a Definition Store assigns to this document: a hash of the
 * document as the store's schema parses it, independent of any Workspace. A
 * Module can name the exact revision of a bundled Definition with it before
 * any Workspace has seeded that Definition.
 */
export const definitionRevisionIdFor = <TDocument>(documentSchema: z.ZodType<TDocument>, document: TDocument): string =>
  revisionIdForDigest(definitionDigest(documentSchema.parse(document)))

const atomicWrite = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, path)
  } finally { await rm(temporaryPath, { force: true }) }
}

export const createRevisionedDefinitionStore = <TDocument>(config: {
  readonly workspaceId: WorkspaceId
  readonly rootDir: string
  readonly documentSchema: z.ZodType<TDocument>
  readonly metadata: (document: TDocument) => DefinitionMetadata
}): RevisionedDefinitionStore<TDocument> => {
  const indexPath = join(config.rootDir, 'catalog.json')
  const revisionsDir = join(config.rootDir, 'revisions')
  const deletionsPath = join(config.rootDir, 'deleted-definitions.json')
  const revisionSchema = z.object({
    id: revisionIdSchema,
    workspaceId: workspaceIdSchema,
    definitionId: z.string().min(1).max(128),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.string().datetime({ offset: true }),
    document: config.documentSchema,
  }).strict()
  let mutationQueue: Promise<void> = Promise.resolve()

  const emptyIndex = (): z.infer<typeof definitionIndexSchema> => ({
    workspaceId: config.workspaceId,
    definitions: [],
  })

  const loadIndex = async (): Promise<z.infer<typeof definitionIndexSchema>> => {
    try {
      const index = definitionIndexSchema.parse(JSON.parse(await readFile(indexPath, 'utf8')) as unknown)
      if (index.workspaceId !== config.workspaceId) throw new Error(`Definition Store Workspace mismatch: ${index.workspaceId}`)
      return index
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyIndex()
      throw error
    }
  }

  const loadDeleted = async (): Promise<ReadonlySet<string>> => {
    try {
      const stored = deletedDefinitionsSchema.parse(JSON.parse(await readFile(deletionsPath, 'utf8')) as unknown)
      return new Set(stored.definitionIds)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
      throw error
    }
  }

  const revisionPath = (revisionId: string): string => join(revisionsDir, `${revisionId}.json`)

  const loadRevision = async (revisionId: string): Promise<DefinitionRevision<TDocument> | undefined> => {
    revisionIdSchema.parse(revisionId)
    try {
      const revision = revisionSchema.parse(JSON.parse(await readFile(revisionPath(revisionId), 'utf8')) as unknown)
      if (revision.workspaceId !== config.workspaceId) throw new Error(`Definition Revision Workspace mismatch: ${revision.workspaceId}`)
      return revision
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  const revisionFor = (rawDocument: TDocument): DefinitionRevision<TDocument> => {
    const document = config.documentSchema.parse(rawDocument)
    const metadata = config.metadata(document)
    const digest = definitionDigest(document)
    return revisionSchema.parse({
      id: revisionIdForDigest(digest),
      workspaceId: config.workspaceId,
      definitionId: metadata.id,
      digest,
      createdAt: new Date().toISOString(),
      document,
    })
  }

  const writeRevision = async (revision: DefinitionRevision<TDocument>): Promise<void> => {
    const existing = await loadRevision(revision.id)
    if (existing !== undefined) {
      if (existing.digest !== revision.digest || stableJson(existing.document) !== stableJson(revision.document)) {
        throw new Error(`Definition Revision digest collision: ${revision.id}`)
      }
      return
    }
    await atomicWrite(revisionPath(revision.id), revision)
  }

  const recordFor = (
    metadata: DefinitionMetadata,
    revision: DefinitionRevision<TDocument>,
    previous?: DefinitionRecord,
    seedRevisionId = previous?.seedRevisionId,
  ): DefinitionRecord => definitionRecordSchema.parse({
    id: metadata.id,
    title: metadata.title,
    ...(metadata.description === undefined ? {} : { description: metadata.description }),
    ...(metadata.category === undefined ? {} : { category: metadata.category }),
    currentRevisionId: revision.id,
    ...(seedRevisionId === undefined ? {} : { seedRevisionId }),
    revisionIds: previous?.revisionIds.includes(revision.id)
      ? previous.revisionIds
      : [...(previous?.revisionIds ?? []), revision.id],
  })

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationQueue.then(operation)
    mutationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  return {
    seed: documents => enqueue(async () => {
      const parsed = documents.map(document => config.documentSchema.parse(document))
      const metadata = parsed.map(config.metadata)
      const ids = new Set<string>()
      for (const item of metadata) {
        if (ids.has(item.id)) throw new Error(`duplicate seeded Definition: ${item.id}`)
        ids.add(item.id)
      }
      const index = await loadIndex()
      const deleted = await loadDeleted()
      const records = new Map(index.definitions.map(record => [record.id, record]))
      for (const [documentIndex, document] of parsed.entries()) {
        const item = metadata[documentIndex]!
        if (deleted.has(item.id)) continue
        const revision = revisionFor(document)
        const current = records.get(item.id)
        if (current !== undefined && current.seedRevisionId === undefined) continue
        await writeRevision(revision)
        if (current === undefined || current.currentRevisionId === current.seedRevisionId) {
          records.set(item.id, recordFor(item, revision, current, revision.id))
          continue
        }
        records.set(item.id, definitionRecordSchema.parse({
          ...current,
          seedRevisionId: revision.id,
          revisionIds: current.revisionIds.includes(revision.id)
            ? current.revisionIds
            : [...current.revisionIds, revision.id],
        }))
      }
      // A removed bundled Definition disappears from the current catalog when
      // the Workspace never edited it. Its immutable revision file remains so
      // existing Resources pinned to that revision stay inspectable.
      for (const [id, record] of records) {
        if (!ids.has(id) && record.seedRevisionId !== undefined && record.currentRevisionId === record.seedRevisionId) records.delete(id)
      }
      const nextIndex = definitionIndexSchema.parse({
        workspaceId: config.workspaceId,
        definitions: [...records.values()].sort((left, right) => left.id.localeCompare(right.id)),
      })
      if (stableJson(nextIndex) !== stableJson(index)) await atomicWrite(indexPath, nextIndex)
    }),
    create: document => enqueue(async () => {
      const revision = revisionFor(document)
      const metadata = config.metadata(revision.document)
      const index = await loadIndex()
      if (index.definitions.some(definition => definition.id === metadata.id)) {
        throw new Error(`Definition already exists: ${metadata.id}`)
      }
      await writeRevision(revision)
      await atomicWrite(indexPath, definitionIndexSchema.parse({
        ...index,
        definitions: [...index.definitions, recordFor(metadata, revision)]
          .sort((left, right) => left.id.localeCompare(right.id)),
      }))
      return revision
    }),
    update: (document, expectedRevisionId) => enqueue(async () => {
      revisionIdSchema.parse(expectedRevisionId)
      const revision = revisionFor(document)
      const metadata = config.metadata(revision.document)
      const index = await loadIndex()
      const current = index.definitions.find(definition => definition.id === metadata.id)
      if (current === undefined) throw new Error(`Definition not found: ${metadata.id}`)
      if (current.currentRevisionId !== expectedRevisionId) throw new Error(`Definition Revision changed: ${metadata.id}`)
      await writeRevision(revision)
      await atomicWrite(indexPath, definitionIndexSchema.parse({
        ...index,
        definitions: index.definitions.map(definition =>
          definition.id === metadata.id ? recordFor(metadata, revision, definition) : definition),
      }))
      return revision
    }),
    list: async () => (await loadIndex()).definitions,
    get: async definitionId => (await loadIndex()).definitions.find(definition => definition.id === definitionId),
    currentRevision: async definitionId => {
      const record = (await loadIndex()).definitions.find(definition => definition.id === definitionId)
      return record === undefined ? undefined : await loadRevision(record.currentRevisionId)
    },
    getRevision: loadRevision,
    delete: (definitionId, expectedRevisionId) => enqueue(async () => {
      revisionIdSchema.parse(expectedRevisionId)
      const index = await loadIndex()
      const current = index.definitions.find(definition => definition.id === definitionId)
      if (current === undefined || current.currentRevisionId !== expectedRevisionId) return false
      const deleted = new Set(await loadDeleted())
      deleted.add(definitionId)
      await atomicWrite(deletionsPath, deletedDefinitionsSchema.parse({ definitionIds: [...deleted].sort() }))
      await atomicWrite(indexPath, definitionIndexSchema.parse({
        ...index,
        definitions: index.definitions.filter(definition => definition.id !== definitionId),
      }))
      return true
    }),
  }
}
