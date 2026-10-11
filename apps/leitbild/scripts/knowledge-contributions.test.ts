import { expect, test } from 'bun:test'
import { validateContributedKnowledgeLinks } from '../../../scripts/publish-platform-knowledge.ts'

test('Pack wiki contributions resolve exact published paths and sections; no obsolete aliases', () => {
  const snapshot = { revision: 'a'.repeat(40), documents: [{ path: 'world/packs/example/index.md', content: '# Example\n\n## Operation\n\nUseful information.' }] }
  const link = (url: string) => [{ owner: 'example', url }]
  expect(() => validateContributedKnowledgeLinks(snapshot, link('/wiki?path=world%2Fpacks%2Fexample%2Findex.md#operation'))).not.toThrow()
  expect(() => validateContributedKnowledgeLinks(snapshot, link('https://elsewhere.invalid/wiki?path=example.md'))).not.toThrow()
  for (const url of ['/wiki?path=packs%2Fexample%2Findex.md', '/wiki?path=world%2Fpacks%2Fexample%2Findex.md#absent', '/wiki', 'javascript:alert(1)']) {
    expect(() => validateContributedKnowledgeLinks(snapshot, link(url))).toThrow()
  }
})
