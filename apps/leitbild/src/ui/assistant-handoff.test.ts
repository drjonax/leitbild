import { describe, expect, test } from 'bun:test'
import { assistantDestination, assistantPrompt } from './assistant-handoff.ts'

describe('Wiki Assistant context', () => {
  test('includes only the visible source reference and exact publication, not document contents', () => {
    const page = { path: 'world/packs/process-plant/reference-designs/ld-01/index.md', title: 'LD-01', revision: 'published-revision' }
    expect(assistantPrompt('Which cooling paths are specified?', { kind: 'wiki', page })).toBe(
      'Which cooling paths are specified?\n\nWiki page I am viewing: LD-01\nSource: knowledge/world/packs/process-plant/reference-designs/ld-01/index.md\nKnowledge revision: published-revision',
    )
  })
  test('does not invent a source when the page has not loaded', () => {
    expect(assistantPrompt('Help me find the wiki', { kind: 'wiki', page: null })).toBe('Help me find the wiki')
  })
  test('retains the workspace header and opens only Agents, not an empty World', () => {
    expect(assistantDestination('workspace-id', 'room-id')).toBe('/workspaces/workspace-id?agents=room-id')
    const url = new URL(assistantDestination('workspace-id', 'room/id & test'), 'https://leitbild.app')
    expect(url.searchParams.get('agents')).toBe('room/id & test')
    expect(url.searchParams.has('world')).toBe(false)
  })
})
