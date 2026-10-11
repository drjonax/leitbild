import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createProductKnowledgeTools } from './product-knowledge-tools.ts'
import { createKnowledge } from '@leitbild/knowledge'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

const fixture = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'leitbild-product-knowledge-'))
  roots.push(root)
  await mkdir(join(root, 'docs'), { recursive: true })
  await mkdir(join(root, 'apps/world/src'), { recursive: true })
  await mkdir(join(root, 'deploy'), { recursive: true })
  await writeFile(join(root, 'README.md'), '# Leitbild\nA modular simulation system.\n')
  await writeFile(join(root, 'docs/architecture.md'), 'Simulation acceleration is controlled by the World execution capability.\n')
  await writeFile(join(root, 'apps/world/src/execution.ts'), 'export const accelerationMode = "maximum"\n')
  await writeFile(join(root, 'deploy/secret.json'), '{"token":"do-not-read"}\n')
  await writeFile(join(root, '.env'), 'SECRET=do-not-read\n')
  return root
}

describe('product knowledge tools', () => {
  test('failed source initialization leaves wiki usable and retries on the same tool instance', async () => {
    const root = await fixture()
    const missing = join(root, 'missing')
    const knowledge = createKnowledge({ revision: 'a'.repeat(40), documents: [{ path: 'index.md', content: '# Leitbild\nSimulation documentation.' }] })
    const [search, read] = createProductKnowledgeTools({ repoRoot: missing, knowledge: async () => knowledge })
    const context = { callerId: 'a', callerName: 'A' }
    const partial = await search!.execute({ query: 'simulation', kind: 'documentation' }, context)
    expect(partial.success).toBe(true)
    expect(partial.data).toMatchObject({ coverage: { partial: true, source: { unavailable: true }, knowledge: { total: 1, returned: 1 } }, matches: [{ path: 'knowledge/index.md', revision: knowledge.revision }] })
    expect(JSON.stringify(partial.data)).toContain('Deployed source unavailable')
    expect((await search!.execute({ query: 'simulation', kind: 'source' }, context)).success).toBe(false)
    const batch = await read!.execute({ requests: [{ path: 'README.md' }, { path: 'knowledge/index.md' }] }, context)
    expect(batch.data).toMatchObject({ results: [{ success: false }, { success: true }] })
    await mkdir(missing)
    await writeFile(join(missing, 'README.md'), '# Simulation\nRecovered source documentation.')
    const recovered = await search!.execute({ query: 'simulation', kind: 'documentation' }, context)
    expect(recovered.data).toMatchObject({ coverage: { partial: false, source: { total: 1, returned: 1 } } })
    expect(JSON.stringify(recovered.data)).toContain('README.md')
  })

  test('healthy source survives wiki failure; all unavailable and source-only failures are explicit', async () => {
    const root = await fixture()
    const [search] = createProductKnowledgeTools({ repoRoot: root, knowledge: async () => { throw new Error('publication offline') } })
    const context = { callerId: 'a', callerName: 'A' }
    const partial = await search!.execute({ query: 'simulation' }, context)
    expect(partial).toMatchObject({ success: true, data: { coverage: { partial: true, knowledge: { unavailable: true } } } })
    const sourceOnly = await search!.execute({ query: 'acceleration', kind: 'source' }, context)
    expect(sourceOnly).toMatchObject({ success: true, data: { coverage: { partial: false } } })
    const [unavailable] = createProductKnowledgeTools({ repoRoot: join(root, 'missing'), knowledge: async () => { throw new Error('publication offline') } })
    const failed = await unavailable!.execute({ query: 'simulation' }, context)
    expect(failed.success).toBe(false)
    expect(failed.error).toContain('Deployed source unavailable')
    expect(failed.error).toContain('Knowledge publication unavailable')
  })

  test('concurrent initialization shares a successful immutable source snapshot', async () => {
    const root = await fixture()
    const [search, read] = createProductKnowledgeTools({ repoRoot: root })
    const context = { callerId: 'a', callerName: 'A' }
    const first = await Promise.all(Array.from({ length: 8 }, () => search!.execute({ query: 'acceleration', kind: 'source' }, context)))
    expect(first.every(result => result.success)).toBe(true)
    expect(first.every(result => JSON.stringify(result) === JSON.stringify(first[0]))).toBe(true)
    await writeFile(join(root, 'apps/world/src/execution.ts'), 'changed after immutable snapshot')
    const cached = await read!.execute({ path: 'apps/world/src/execution.ts', revision: 'development' }, context)
    expect(JSON.stringify(cached)).toContain('accelerationMode')
    expect((await read!.execute({ path: 'apps/world/src/execution.ts', revision: 'wrong' }, context)).success).toBe(false)
  })

  test('a wiki search failure reports partial coverage without hiding healthy source matches', async () => {
    const root = await fixture()
    const wiki = createKnowledge({ revision: 'a'.repeat(40), documents: [{ path: 'index.md', content: '# Leitbild' }] })
    let reads = 0
    const [search] = createProductKnowledgeTools({ repoRoot: root, knowledge: async () => {
      reads++
      return { ...wiki, search: () => { throw new Error('index unavailable') } }
    } })
    const context = { callerId: 'a', callerName: 'A' }
    const partial = await search!.execute({ query: 'acceleration' }, context)
    expect(partial).toMatchObject({ success: true, data: { coverage: { partial: true, knowledge: { unavailable: true } } } })
    expect(JSON.stringify(partial)).toContain('apps/world/src/execution.ts')
    expect(JSON.stringify(partial)).toContain('index unavailable')
    await search!.execute({ query: 'acceleration', kind: 'source' }, context)
    expect(reads).toBe(1)
  })

  test('hub children are directly readable agent paths without dumping descendants', async () => {
    const root = await fixture()
    const knowledge = createKnowledge({revision:'a'.repeat(40),documents:[
      {path:'index.md',content:'# Leitbild\n\nProduct.'},
      {path:'world/index.md',content:'# World\n\nSimulation.'},
      {path:'world/runs.md',content:'# Runs\n\nTime and state.'},
    ]})
    const [,read] = createProductKnowledgeTools({repoRoot:root,knowledge:async()=>knowledge})
    const context={callerId:'a',callerName:'A'}
    const result=await read!.execute({path:'knowledge/index.md'},context)
    expect(result.data).toMatchObject({children:[{path:'knowledge/world/index.md',title:'World'}]})
    const next=await read!.execute({path:'knowledge/world/index.md'},context)
    expect(next.data).toMatchObject({parent:'knowledge/index.md',children:[{path:'knowledge/world/runs.md'}]})
  })
  test('wiki body search, batch reads and revision mismatch preserve evidence identity', async () => {
    const root = await fixture()
    const revision = 'a'.repeat(40)
    const knowledge = createKnowledge({ revision, documents: [{ path: 'index.md', content: '# Reactor\n\n## Cooling\nRecirculation explanation.' }] })
    const [search, read] = createProductKnowledgeTools({ repoRoot: root, knowledge: async () => knowledge })
    const context = { callerId: 'a', callerName: 'A' }
    const result = await search!.execute({ query: 'recirculation' }, context)
    expect(result.data).toMatchObject({ matches: [{ path: 'knowledge/index.md', revision }] })
    const batch = await read!.execute({ requests: [
      { path: 'knowledge/index.md', section: 'cooling', revision },
      { path: 'knowledge/index.md', revision: 'b'.repeat(40) },
    ] }, context)
    expect(batch.success).toBe(true)
    expect(batch.data).toMatchObject({ results: [
      { success: true, data: { revision, content: '## Cooling\nRecirculation explanation.' } },
      { success: false },
    ] })
  })
  test('searches and reads only the bounded product corpus', async () => {
    const root = await fixture()
    const [search, read] = createProductKnowledgeTools({ repoRoot: root })
    const context = { callerId: 'a', callerName: 'A' }
    const found = await search!.execute({ query: 'simulation acceleration' }, context)
    expect(found.success).toBe(true)
    expect(found.data).toMatchObject({ revision: 'development' })
    const paths = (found.data as { matches: Array<{ path: string }> }).matches.map(match => match.path)
    expect(paths).toContain('docs/architecture.md')
    expect(paths).not.toContain('deploy/secret.json')

    const excerpt = await read!.execute({ path: 'apps/world/src/execution.ts', startLine: 1, lineCount: 5 }, context)
    expect(excerpt.success).toBe(true)
    expect(JSON.stringify(excerpt.data)).toContain('accelerationMode')
    expect((await read!.execute({ path: '.env' }, context)).success).toBe(false)
    expect((await read!.execute({ path: '../outside' }, context)).success).toBe(false)
    expect((await read!.execute({ path: 'apps/world/src/execution.ts', section: 'ignored' }, context)).success).toBe(false)
  })
})
