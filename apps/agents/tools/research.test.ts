import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import type { Tool } from '../src/core/types/tool.ts'
import tools, { createResearchTools } from './research.ts'

const ctx = { callerId: 'test-id', callerName: 'TestAgent' }

const ARXIV_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>ArXiv Query: search_query=all:quantum computing</title>
  <entry>
    <id>http://arxiv.org/abs/2101.00001v1</id>
    <published>2021-01-01T00:00:00Z</published>
    <title>Quantum   computing
      for beginners</title>
    <summary>  An introduction
      to qubits.  </summary>
    <author><name>Ada Lovelace</name></author>
    <author><name>Alan Turing</name></author>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2101.00002v1</id>
    <published>2021-01-02T00:00:00Z</published>
    <title>Error correction</title>
    <summary>Surface codes.</summary>
    <author><name>Grace Hopper</name></author>
  </entry>
</feed>`

const CROSSREF_WORK = {
  message: {
    title: ['On the Dangers of Stochastic Parrots'],
    author: [{ family: 'Bender', given: 'Emily M.' }, { family: 'Gebru', given: 'Timnit' }],
    published: { 'date-parts': [[2021, 3, 1]] },
    'container-title': ['Proceedings of the 2021 ACM Conference on Fairness, Accountability, and Transparency'],
    DOI: '10.1145/3442188.3445922',
  },
}

const S2_SEARCH = {
  data: [
    {
      title: 'Attention Is All You Need',
      authors: [{ name: 'Ashish Vaswani' }, { name: '' }, { name: 'Noam Shazeer' }],
      year: 2017,
      abstract: 'The dominant sequence transduction models.',
      citationCount: 100,
      tldr: { text: 'A new architecture based on attention.' },
      externalIds: { DOI: '10.48550/arXiv.1706.03762' },
    },
    { title: 'Untitled draft' },
  ],
}

describe('research tools', () => {
  // Exercise the real HTTP clients against fixed responses instead of the public APIs.
  let server: ReturnType<typeof Bun.serve>
  let toolMap: Record<string, Tool>
  let unavailableMap: Record<string, Tool>
  let lastRequest: URL | undefined

  beforeAll(() => {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        lastRequest = url
        if (url.pathname.startsWith('/unavailable/')) {
          return new Response('Unavailable', { status: 503, statusText: 'Service Unavailable' })
        }
        if (url.pathname === '/arxiv/query') {
          return new Response(ARXIV_FEED, { headers: { 'Content-Type': 'application/atom+xml' } })
        }
        if (url.pathname === '/crossref/works/10.1145%2F3442188.3445922') return Response.json(CROSSREF_WORK)
        if (url.pathname === '/s2/paper/search') return Response.json(S2_SEARCH)
        return new Response('Not Found', { status: 404, statusText: 'Not Found' })
      },
    })
    const endpoint = (path: string): string => new URL(path, server.url).href
    toolMap = Object.fromEntries(createResearchTools({
      arxiv: endpoint('/arxiv/query'),
      crossref: endpoint('/crossref/works'),
      semanticScholar: endpoint('/s2/paper/search'),
    }).map(t => [t.name, t]))
    unavailableMap = Object.fromEntries(createResearchTools({
      arxiv: endpoint('/unavailable/arxiv'),
      crossref: endpoint('/unavailable/crossref'),
      semanticScholar: endpoint('/unavailable/s2'),
    }).map(t => [t.name, t]))
  })

  afterAll(() => { server.stop(true) })

  test('the loaded module exposes the three research tools', () => {
    expect(tools.map(t => t.name)).toEqual(['arxiv_search', 'doi_lookup', 'semantic_scholar'])
  })

  describe('arxiv_search', () => {
    test('queries arXiv and parses each Atom entry', async () => {
      const result = await toolMap['arxiv_search']!.execute({ query: 'quantum computing', max_results: 3 }, ctx)
      expect(result.success).toBe(true)
      expect(lastRequest?.searchParams.get('search_query')).toBe('all:quantum computing')
      expect(lastRequest?.searchParams.get('max_results')).toBe('3')
      expect(lastRequest?.searchParams.get('sortBy')).toBe('relevance')
      expect(result.data).toEqual([
        {
          title: 'Quantum computing for beginners',
          summary: 'An introduction to qubits.',
          authors: ['Ada Lovelace', 'Alan Turing'],
          url: 'http://arxiv.org/abs/2101.00001v1',
          published: '2021-01-01T00:00:00Z',
        },
        {
          title: 'Error correction',
          summary: 'Surface codes.',
          authors: ['Grace Hopper'],
          url: 'http://arxiv.org/abs/2101.00002v1',
          published: '2021-01-02T00:00:00Z',
        },
      ])
    })

    test('reports an unsuccessful HTTP response', async () => {
      const result = await unavailableMap['arxiv_search']!.execute({ query: 'quantum computing' }, ctx)
      expect(result.success).toBe(false)
      expect(result.error).toBe('arXiv API error: 503 Service Unavailable')
    })

    test('returns error for missing query', async () => {
      const result = await toolMap['arxiv_search']!.execute({}, ctx)
      expect(result.success).toBe(false)
    })
  })

  describe('doi_lookup', () => {
    test('resolves a DOI to citation metadata', async () => {
      const result = await toolMap['doi_lookup']!.execute({ doi: '10.1145/3442188.3445922' }, ctx)
      expect(result.success).toBe(true)
      expect(result.data).toEqual({
        title: 'On the Dangers of Stochastic Parrots',
        authors: [{ family: 'Bender', given: 'Emily M.' }, { family: 'Gebru', given: 'Timnit' }],
        published: '2021-3-1',
        journal: 'Proceedings of the 2021 ACM Conference on Fairness, Accountability, and Transparency',
        doi: '10.1145/3442188.3445922',
      })
    })

    test('reports an unsuccessful HTTP response', async () => {
      const result = await unavailableMap['doi_lookup']!.execute({ doi: '10.1145/3442188.3445922' }, ctx)
      expect(result.success).toBe(false)
      expect(result.error).toBe('Crossref API error: 503 Service Unavailable')
    })

    test('returns error for missing doi parameter', async () => {
      const result = await toolMap['doi_lookup']!.execute({}, ctx)
      expect(result.success).toBe(false)
    })
  })

  describe('semantic_scholar', () => {
    test('searches papers and maps citation counts and summaries', async () => {
      const result = await toolMap['semantic_scholar']!.execute({ query: 'transformer neural network', limit: 3 }, ctx)
      expect(result.success).toBe(true)
      expect(lastRequest?.searchParams.get('query')).toBe('transformer neural network')
      expect(lastRequest?.searchParams.get('limit')).toBe('3')
      expect(lastRequest?.searchParams.get('fields')).toBe('title,authors,year,abstract,citationCount,tldr,externalIds')
      expect(result.data).toEqual([
        {
          title: 'Attention Is All You Need',
          authors: ['Ashish Vaswani', 'Noam Shazeer'],
          year: 2017,
          abstract: 'The dominant sequence transduction models.',
          citationCount: 100,
          tldr: 'A new architecture based on attention.',
          doi: '10.48550/arXiv.1706.03762',
        },
        {
          title: 'Untitled draft',
          authors: [],
          year: null,
          abstract: null,
          citationCount: 0,
          tldr: null,
          doi: null,
        },
      ])
    })

    test('reports an unsuccessful HTTP response', async () => {
      const result = await unavailableMap['semantic_scholar']!.execute({ query: 'transformer neural network' }, ctx)
      expect(result.success).toBe(false)
      expect(result.error).toBe('Semantic Scholar API error: 503 Service Unavailable')
    })

    test('returns error for missing query parameter', async () => {
      const result = await toolMap['semantic_scholar']!.execute({}, ctx)
      expect(result.success).toBe(false)
    })
  })
})
