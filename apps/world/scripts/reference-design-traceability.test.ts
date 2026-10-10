import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateKnowledgeSources } from '@leitbild/knowledge/publish'
import { checkTraceability, nativeSourceLinks, provenanceEntries } from './reference-design-traceability'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const tree = async (files: Readonly<Record<string, string>>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'leitbild-traceability-'))
  roots.push(root)
  await Promise.all(Object.entries(files).map(([path, content]) => Bun.write(join(root, path), content)))
  return root
}

const OPERATING = 'apps/world/native/process-plant/operating'
const ALPHA = `${OPERATING}/src/alpha.rs`
const BOUNDARY = `${OPERATING}/water-ffi/src/lib.rs`
const equations = ['# Equations', '',
  '## Alpha law', `The [alpha block](source:${ALPHA}) implements it.`, '',
  '## Laws', 'Stated without a code link.', '',
  '## Laws', '### Boundary detail', `The [boundary](source:${BOUNDARY}#L1 "Boundary") calls it.`, ''].join('\n')
const cleanApp = {
  [ALPHA]: '//! spec: model/equations.md#alpha-law\n//! Alpha.\npub fn alpha() {}\n',
  [BOUNDARY]: '//! spec: model/equations.md#laws-1\n//! Boundary.\n',
}
const cleanWiki = { 'index.md': '# Wiki\n', 'model/equations.md': equations }

test('projects module spec lines and wiki source links onto the same sections', async () => {
  const report = await checkTraceability({ appRoot: await tree(cleanApp), wikiRoot: await tree(cleanWiki) })
  expect(report.ok).toBe(true)
  expect(report.modules).toEqual({
    [ALPHA]: { spec: ['model/equations.md#alpha-law'], linkedFrom: ['model/equations.md#alpha-law'] },
    // A repeated heading takes the publication's `-1` slug; its section includes subsections.
    [BOUNDARY]: { spec: ['model/equations.md#laws-1'], linkedFrom: ['model/equations.md#boundary-detail'] },
  })
  expect(report.specPages).toEqual({ 'model/equations.md': [ALPHA, BOUNDARY] })
  expect(report.sourceLinksChecked).toBe(2)
})

test('reports modules without spec lines and every broken native source link', async () => {
  const ledger = `# Ledger\n\n[Beta](source:${OPERATING}/src/beta.rs), [gone](source:${OPERATING}/src/gone.rs), `
    + `![figure](source:${OPERATING}/src/figure.rs) and [range](source:${ALPHA}#L99).\n`
  const report = await checkTraceability({
    appRoot: await tree({ ...cleanApp, [`${OPERATING}/src/beta.rs`]: '//! Beta has no owner yet.\n' }),
    wikiRoot: await tree({ ...cleanWiki, 'ledger.md': ledger }),
  })
  expect(report.ok).toBe(false)
  expect(report.missingSpecLines).toEqual([`${OPERATING}/src/beta.rs`])
  expect(report.modules[`${OPERATING}/src/beta.rs`]).toEqual({ spec: [], linkedFrom: ['ledger.md#ledger'] })
  expect(report.brokenSourceLinks.map(link => [link.page, link.line, link.href])).toEqual([
    ['ledger.md', 3, `source:${OPERATING}/src/gone.rs`], ['ledger.md', 3, `source:${ALPHA}#L99`]])
  expect(report.brokenSourceLinks[0]!.problem).toContain('unavailable')
  expect(report.brokenSourceLinks[1]!.problem).toContain('line range')
  expect(report.sourceLinksChecked).toBe(5)
})

test('spec lines must lead, be well formed, name a published heading and be linked back', async () => {
  const alpha = ['//! spec: model/missing.md#law', '//! spec: AGENTS.md#rules', '//! spec: model/equations.md#no-such-heading',
    '//! spec: model/equations.md#laws', '//! spec: model/equations.md', '//! Alpha.', '//! spec: model/equations.md#alpha-law', ''].join('\n')
  const report = await checkTraceability({
    appRoot: await tree({ ...cleanApp, [ALPHA]: alpha }),
    wikiRoot: await tree({ ...cleanWiki, 'AGENTS.md': '# Rules\n' }),
  })
  expect(report.ok).toBe(false)
  expect(report.brokenSpecLines.map(broken => [broken.module, broken.line, broken.problem])).toEqual([
    [ALPHA, 1, 'no published wiki page model/missing.md'],
    [ALPHA, 2, 'no published wiki page AGENTS.md'],
    [ALPHA, 3, 'no heading #no-such-heading in model/equations.md'],
    [ALPHA, 4, `model/equations.md#laws has no source: link back to ${ALPHA}`],
    [ALPHA, 5, 'expected `//! spec: <wiki path>#<heading slug>`'],
    [ALPHA, 7, 'spec line outside the leading block'],
  ])
  expect(report.missingSpecLines).toEqual([])
})

test('locates exactly the source links the publication validates', async () => {
  const appRoot = await tree({ 'apps/world/native/a.rs': 'a\nb\n', 'apps/world/native/b.rs': 'b\n', 'apps/world/native/c.rs': 'c\n' })
  const content = '# Page\n[a](source:apps/world/native/a.rs) [b](source:apps/world/native/b.rs "Title")\n'
    + '![c](source:apps/world/native/c.rs) [range](source:apps/world/native/a.rs#L1-L2)\n'
  const links = await nativeSourceLinks('page.md', content, appRoot)
  expect(links.map(link => [link.line, link.section, link.target, link.problem])).toEqual([
    [2, 'page.md#page', 'apps/world/native/a.rs', undefined],
    [2, 'page.md#page', 'apps/world/native/b.rs', undefined],
    [3, 'page.md#page', 'apps/world/native/a.rs', undefined]])
  expect([...new Set(links.map(link => link.target))].sort()).toEqual(
    [...await validateKnowledgeSources({ revision: 'a'.repeat(40), documents: [{ path: 'page.md', content }] }, appRoot)])
})

test('packet provenance names one current page; stale hashes fail only when strict', async () => {
  const page = 'world/packs/process-plant/reference-designs/ld-01/systems/x.md'
  const current = createHash('sha256').update('# X\n').digest('hex')
  const appRoot = await tree(cleanApp)
  const wikiRoot = await tree({ ...cleanWiki, [page]: '# X\n', 'world/index.md': '# World\n' })
  const packets = await tree({
    'stale.json': JSON.stringify({ provenance: { hot: [{ name: page, sha256: current }],
      consumed: [{ name: 'systems/x.md', sha256: '0'.repeat(64) }], helpers: [{ name: 'compiler.ts', sha256: 'f'.repeat(64) }] } }),
    'unresolved.json': JSON.stringify({ owners: [{ name: 'index.md' }, { name: 'missing.md', sha256: current }] }),
  })
  const stale = await checkTraceability({ appRoot, wikiRoot, packets: [join(packets, 'stale.json')] })
  expect(stale.ok).toBe(true)
  expect(stale.packets[0]).toMatchObject({ entries: 2, missing: [], ambiguous: [],
    stale: [{ at: '/provenance/consumed/0', name: 'systems/x.md', page, recorded: '0'.repeat(64), current }] })
  expect((await checkTraceability({ appRoot, wikiRoot, packets: [join(packets, 'stale.json')], strict: true })).ok).toBe(false)
  const unresolved = await checkTraceability({ appRoot, wikiRoot, packets: [join(packets, 'unresolved.json')] })
  expect(unresolved.ok).toBe(false)
  expect(unresolved.packets[0]).toMatchObject({ entries: 2, stale: [],
    ambiguous: [{ at: '/owners/0', name: 'index.md', candidates: ['index.md', 'world/index.md'] }],
    missing: [{ at: '/owners/1', name: 'missing.md' }] })
  expect(provenanceEntries({ 'a/b~c': { name: 'p.md' } })).toEqual([{ at: '/a~1b~0c', name: 'p.md', sha256: undefined }])
})

test('command prints a summary and the JSON report, exiting nonzero on failure', async () => {
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'reference-design-traceability.ts'), ...args], { stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    return { code, report: JSON.parse(stdout) as { ok: boolean }, stderr }
  }
  const appRoot = await tree(cleanApp)
  const passing = await run(appRoot, await tree(cleanWiki))
  expect([passing.code, passing.report.ok, passing.stderr.trim().split('\n').at(-1)]).toEqual([0, true, 'PASS'])
  const failing = await run(appRoot, await tree({ 'index.md': '# Wiki\n' }))
  expect([failing.code, failing.report.ok]).toEqual([1, false])
  expect(failing.stderr).toContain('no published wiki page model/equations.md')
})
