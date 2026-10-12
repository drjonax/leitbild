import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { workspaceIdSchema } from '@leitbild/contracts'
import { createRevisionedDefinitionStore, definitionRevisionIdFor, stableJson } from './revision-store.ts'

const workspaceId = workspaceIdSchema.parse('11111111-1111-4111-8111-111111111111')
const documentSchema = z.object({
  id: z.string(),
  title: z.string(),
  value: z.number(),
}).strict()

describe('revisioned definition store', () => {
  let rootDir = ''
  afterEach(async () => {
    if (rootDir !== '') await rm(rootDir, { recursive: true, force: true })
  })

  const store = async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'leitbild-definition-store-'))
    return createRevisionedDefinitionStore({
      workspaceId,
      rootDir,
      documentSchema,
      metadata: document => ({ id: document.id, title: document.title }),
    })
  }

  test('refreshes untouched seeds and never overwrites an authored current revision', async () => {
    const definitions = await store()
    await definitions.seed([{ id: 'example', title: 'Example', value: 1 }])
    const firstSeed = await definitions.currentRevision('example')
    expect(firstSeed?.document.value).toBe(1)

    await definitions.seed([{ id: 'example', title: 'Refreshed seed', value: 3 }])
    const refreshedSeed = await definitions.currentRevision('example')
    expect(refreshedSeed?.document.value).toBe(3)
    expect((await definitions.get('example'))?.seedRevisionId).toBe(refreshedSeed?.id)

    const updated = await definitions.update(
      { id: 'example', title: 'Edited', value: 2 },
      refreshedSeed!.id,
    )
    await definitions.seed([{ id: 'example', title: 'Changed seed', value: 4 }])

    expect((await definitions.currentRevision('example'))?.id).toBe(updated.id)
    expect((await definitions.currentRevision('example'))?.document.value).toBe(2)
    expect((await definitions.get('example'))?.seedRevisionId).not.toBe(updated.id)
  })

  test('does not claim or replace an authored definition that shares a seed id', async () => {
    const definitions = await store()
    const authored = await definitions.create({ id: 'example', title: 'Authored', value: 7 })
    await definitions.seed([{ id: 'example', title: 'Seed', value: 1 }])

    expect((await definitions.currentRevision('example'))?.id).toBe(authored.id)
    expect((await definitions.currentRevision('example'))?.document.value).toBe(7)
    expect((await definitions.get('example'))?.seedRevisionId).toBeUndefined()
  })

  test('removes retired untouched seeds from the catalog but preserves authored revisions', async () => {
    const definitions = await store()
    await definitions.seed([
      { id: 'retired', title: 'Retired seed', value: 1 },
      { id: 'edited', title: 'Edited seed', value: 1 },
    ])
    const retiredRevision = await definitions.currentRevision('retired')
    const editedSeed = await definitions.currentRevision('edited')
    const authored = await definitions.update({ id: 'edited', title: 'Authored', value: 2 }, editedSeed!.id)

    await definitions.seed([])

    expect(await definitions.get('retired')).toBeUndefined()
    expect((await definitions.getRevision(retiredRevision!.id))?.document.value).toBe(1)
    expect((await definitions.currentRevision('edited'))?.id).toBe(authored.id)
  })

  test('retains immutable revisions and uses optimistic current-revision checks', async () => {
    const definitions = await store()
    const first = await definitions.create({ id: 'custom', title: 'Custom', value: 1 })
    const second = await definitions.update({ id: 'custom', title: 'Custom', value: 2 }, first.id)

    expect((await definitions.getRevision(first.id))?.document.value).toBe(1)
    expect((await definitions.currentRevision('custom'))?.id).toBe(second.id)
    await expect(definitions.update({ id: 'custom', title: 'Stale', value: 3 }, first.id))
      .rejects.toThrow('Definition Revision changed: custom')
  })

  test('deletion tombstones seed identities without deleting pinned revisions', async () => {
    const definitions = await store()
    await definitions.seed([{ id: 'example', title: 'Example', value: 1 }])
    const revision = await definitions.currentRevision('example')
    expect(await definitions.delete('example', revision!.id)).toBe(true)
    await definitions.seed([{ id: 'example', title: 'Example', value: 2 }])

    expect(await definitions.get('example')).toBeUndefined()
    expect((await definitions.getRevision(revision!.id))?.document.value).toBe(1)
    expect(JSON.parse(await readFile(join(rootDir, 'deleted-definitions.json'), 'utf8')))
      .toEqual({ definitionIds: ['example'] })
  })

  test('names the seeded revision of a bundled document without a Workspace', async () => {
    const definitions = await store()
    const bundled = { id: 'example', title: 'Example', value: 1 }
    await definitions.seed([bundled])

    expect(definitionRevisionIdFor(documentSchema, bundled)).toBe((await definitions.get('example'))!.currentRevisionId)
    expect(definitionRevisionIdFor(documentSchema, { title: 'Example', value: 1, id: 'example' }))
      .toBe(definitionRevisionIdFor(documentSchema, bundled))
    expect(() => definitionRevisionIdFor(documentSchema, { ...bundled, extra: true } as never)).toThrow()
  })
})

describe('stable JSON', () => {
  test('orders keys by code unit whatever the process locale', () => {
    expect(stableJson({ b: 1, B: 2, a: { z: 3, Z: 4 }, _: 5, aa: 6, 'å': 7 }))
      .toBe('{"B":2,"_":5,"a":{"Z":4,"z":3},"aa":6,"b":1,"å":7}')
  })
})
