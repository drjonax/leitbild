import { describe, expect, test } from 'bun:test'
import {
  capabilityIdSchema,
  moduleIdSchema,
  newWorkspaceId,
  workspaceDefinitionRevisionReferenceSchema,
  workspaceResourceReferenceSchema,
  type WorkspaceRoomScope,
} from '@leitbild/contracts'
import { createContextPublisherLookup, createViewPublisherLookup, createWorkspaceCapabilityTools, workspaceCallResultForModel } from './workspace-capability-tools.ts'
import { toolsToDefinitions } from '../../llm/tool-capability.ts'

const workspaceId = newWorkspaceId()
const moduleId = moduleIdSchema.parse('world')
const readId = capabilityIdSchema.parse('world.simulation-run.read')
const writeId = capabilityIdSchema.parse('world.simulation-run.write')
const inspectDefinitionId = capabilityIdSchema.parse('world.scenario.inspect')
const run = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId, type: 'world.simulation-run', id: 'run-01' })
const otherRun = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId, type: 'world.simulation-run', id: 'run-02' })
const family = workspaceResourceReferenceSchema.parse({ workspaceId, moduleId, type: 'world.run-family', id: 'family-01' })
const definition = workspaceDefinitionRevisionReferenceSchema.parse({
  workspaceId, moduleId, type: 'world.scenario', id: 'scenario-01', revisionId: 'revision-01',
})
const runTarget = { kind: 'resource' as const, ref: run }
const now = new Date().toISOString()

const catalogFetch = (requests: Request[]): typeof fetch => (async (input, init) => {
  const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
  requests.push(request)
  const pathname = new URL(request.url).pathname
  if (pathname.endsWith('/resources')) return Response.json({
    workspaceId,
    modules: [{ moduleId, status: 'ready' }],
    resources: [
      { ref: run, title: 'Run 01', capabilityIds: [readId, writeId], links: [{ rel: 'member-of', ref: family }], summary: [], observedAt: now },
      { ref: otherRun, title: 'Run 02', capabilityIds: [readId], links: [{ rel: 'member-of', ref: family }], summary: [], observedAt: now },
      { ref: family, title: 'Run family', capabilityIds: [], links: [{ rel: 'contains', ref: run }, { rel: 'contains', ref: otherRun }], summary: [], observedAt: now },
    ],
  })
  if (pathname.endsWith('/definitions')) return Response.json({
    workspaceId,
    modules: [{ moduleId, status: 'ready' }],
    definitions: [{
      ref: { workspaceId, moduleId, type: definition.type, id: definition.id },
      title: 'Scenario 01', currentRevisionId: definition.revisionId,
      capabilityIds: [inspectDefinitionId], inspectionCapabilityId: inspectDefinitionId,
    }],
  })
  if (pathname.endsWith('/capabilities')) return Response.json({
    workspaceId,
    modules: [{ moduleId, status: 'ready' }],
    capabilities: [
      { id: readId, moduleId, kind: 'query', scope: { kind: 'resource', resourceType: run.type }, title: 'Read run', description: 'Read current live simulation state and time.', searchTerms: ['status report sitrep'], risk: 'read', idempotent: true, inputSchema: { type: 'object' }, outputSchema: { type: 'object' } },
      { id: writeId, moduleId, kind: 'command', scope: { kind: 'resource', resourceType: run.type }, title: 'Change run', description: 'Change the live simulation.', searchTerms: ['trip reactor coolant pumps RCPs'], risk: 'write', idempotent: false, acceptsIdempotencyKey: true, inputSchema: { type: 'object' }, outputSchema: { type: 'object' } },
      { id: inspectDefinitionId, moduleId, kind: 'query', scope: { kind: 'definition', definitionType: definition.type }, title: 'Inspect scenario', description: 'Read a scenario definition.', risk: 'read', idempotent: true, inputSchema: { type: 'object' }, outputSchema: { type: 'object' } },
    ],
  })
  return Response.json({ result: { state: 'running' } })
}) as typeof fetch

const makeTools = (scope: WorkspaceRoomScope, requests: Request[] = []) => createWorkspaceCapabilityTools({
  workspaceId,
  hostBaseUrl: 'https://host.test',
  getRoomScope: roomId => roomId === 'room' ? scope : undefined,
  fetchImpl: catalogFetch(requests),
})

const context = { callerId: 'agent', callerName: 'Analyst', roomId: 'room' }
const comparisonKey = (ref: { workspaceId: string; moduleId: string; type: string; id: string }) => `${ref.workspaceId}:${ref.moduleId}:${ref.type}:${ref.id}`
const comparisonContext = {
  ...context,
  comparison: { resourceKeys: [comparisonKey(run)], definitionKeys: [comparisonKey(definition)], messageIds: [], turnIds: [] },
}

describe('Workspace progressive-discovery tools', () => {
  test('comparison discovery and invocation stay inside the captured read-only target set', async () => {
    const requests: Request[] = []
    const [explore, call] = makeTools({ kind: 'workspace' }, requests)
    const discovered = await explore!.execute({ view: 'scope' }, comparisonContext)
    expect(discovered).toMatchObject({ success: true, data: { resources: [{ target: runTarget, operationCount: 1, links: [] }] } })
    expect(JSON.stringify(discovered)).not.toContain('Run 02')
    expect(await explore!.execute({ view: 'operations', operationIds: [readId, writeId] }, comparisonContext))
      .toMatchObject({ success: true, data: { operations: [{ operationId: readId }] } })
    expect(await call!.execute({ calls: [{ key: 'r', operationId: readId, target: runTarget, input: {} }] }, comparisonContext))
      .toMatchObject({ success: true, data: { results: [{ success: true }] } })
    const writes = await call!.execute({ calls: [{ key: 'w', operationId: writeId, target: runTarget, input: {} }] }, comparisonContext)
    expect(writes).toMatchObject({ success: true, data: { results: [{ success: false }] } })
    const outside = await call!.execute({ calls: [{ key: 'outside', operationId: readId, target: { kind: 'resource', ref: otherRun }, input: {} }] }, comparisonContext)
    expect(outside).toMatchObject({ success: true, data: { results: [{ success: false }] } })
    const invoked = requests.filter(request => new URL(request.url).pathname.endsWith('/invoke'))
    expect(invoked).toHaveLength(1)
    expect(invoked[0]!.url).toContain(readId)
  })

  test('comparison family membership cannot grow with a later copy', async () => {
    const [explore, call] = makeTools({ kind: 'collection', collection: family, members: { mode: 'all', except: [] } })
    const captured = { ...comparisonContext, comparison: { ...comparisonContext.comparison, resourceKeys: [comparisonKey(family), comparisonKey(run)], definitionKeys: [] } }
    const discovered = await explore!.execute({ view: 'scope', resourceType: run.type }, captured)
    expect(discovered).toMatchObject({ success: true, data: { resources: [{ target: runTarget }] } })
    expect(JSON.stringify(discovered)).not.toContain('Run 02')
    const familyResult = await explore!.execute({ view: 'scope', resourceType: family.type }, captured)
    expect(JSON.stringify(familyResult)).not.toContain('run-02')
    expect(await call!.execute({ calls: [{ key: 'late', operationId: readId, target: { kind: 'resource', ref: otherRun }, input: {} }] }, captured))
      .toMatchObject({ success: true, data: { results: [{ success: false }] } })
  })

  test('comparison fails explicitly when captured access is revoked', async () => {
    const [explore, call] = makeTools({ kind: 'resource', resource: otherRun })
    const found = await explore!.execute({ view: 'scope' }, comparisonContext)
    expect(found).toMatchObject({ success: false })
    expect(JSON.stringify(found)).toContain('comparison_scope_changed')
    expect(await call!.execute({ calls: [{ key: 'r', operationId: readId, target: runTarget, input: {} }] }, comparisonContext))
      .toMatchObject({ success: false })
  })

  test('comparison detects deleted targets even when the Room still holds their references', async () => {
    const base = catalogFetch([])
    const [explore] = createWorkspaceCapabilityTools({
      workspaceId, hostBaseUrl: 'https://host.test', getRoomScope: () => ({ kind: 'resource', resource: run }),
      fetchImpl: (async (input, init) => {
        const response = await base(input, init)
        if (!String(input).endsWith('/resources')) return response
        const body = await response.json() as { resources: Array<{ ref: { id: string } }> }
        body.resources = body.resources.filter(resource => resource.ref.id !== run.id)
        return Response.json(body)
      }) as typeof fetch,
    })
    const result = await explore!.execute({}, { ...comparisonContext, comparison: { ...comparisonContext.comparison, definitionKeys: [] } })
    expect(result).toMatchObject({ success: false })
    expect(result.error).toContain('comparison_scope_changed')
  })

  test('comparison-withheld read operations cannot be discovered or invoked', async () => {
    const requests: Request[] = []
    const base = catalogFetch(requests)
    const [explore, call] = createWorkspaceCapabilityTools({
      workspaceId, hostBaseUrl: 'https://host.test', getRoomScope: () => ({ kind: 'workspace' }),
      fetchImpl: (async (input, init) => {
        const response = await base(input, init)
        if (!String(input).endsWith('/capabilities')) return response
        const body = await response.json() as { capabilities: Array<{ id: string; comparisonUnavailableReason?: string }> }
        body.capabilities.find(operation => operation.id === readId)!.comparisonUnavailableReason = 'Contains conversation data outside the captured history.'
        return Response.json(body)
      }) as typeof fetch,
    })
    expect(await explore!.execute({ view: 'operations', operationIds: [readId] }, comparisonContext))
      .toMatchObject({ success: true, data: { operations: [] } })
    expect(await call!.execute({ calls: [{ key: 'r', operationId: readId, target: runTarget, input: {} }] }, comparisonContext))
      .toMatchObject({ success: true, data: { results: [{ success: false }] } })
    expect(requests.some(request => new URL(request.url).pathname.endsWith('/invoke'))).toBe(false)
    expect(await call!.execute({ calls: [{ key: 'r', operationId: readId, target: runTarget, input: {} }] }, context))
      .toMatchObject({ success: true, data: { results: [{ success: true }] } })
  })

  test('revalidates cached operations and replaces them when catalog content changes', async () => {
    const base=catalogFetch([])
    let version=1
    const statuses:number[]=[]
    const tools=createWorkspaceCapabilityTools({workspaceId,hostBaseUrl:'https://host.test',getRoomScope:()=>({kind:'workspace'}),
      fetchImpl:(async(input,init)=>{
        const request=new Request(String(input),init)
        if(!request.url.endsWith('/capabilities'))return base(input,init)
        const etag='"'+version+'"'
        if(request.headers.get('if-none-match')===etag){statuses.push(304);return new Response(null,{status:304})}
        const response=await base(input,init)
        const body=await response.json() as {capabilities:Array<{id:string}>}
        if(version===2)body.capabilities=body.capabilities.filter(c=>c.id!==readId)
        statuses.push(200)
        return Response.json(body,{headers:{etag}})
      }) as typeof fetch})
    const query=()=>tools[0]!.execute({view:'operations',operationIds:[readId]},context)
    expect(await query()).toMatchObject({success:true,data:{operations:[{operationId:readId}]}})
    await query()
    version=2
    expect(await query()).toMatchObject({success:true,data:{operations:[]}})
    expect(statuses).toEqual([200,304,200])
  })
  test('filters all result kinds and operations consistently', async () => {
    const [explore] = makeTools({kind:'workspace'})
    expect(await explore!.execute({view:'operations',definitionType:definition.type},context)).toMatchObject({
      success:true,data:{resources:[],operations:[{operationId:inspectDefinitionId}]},
    })
    expect(await explore!.execute({view:'operations',resourceType:run.type,operationIds:[inspectDefinitionId]},context))
      .toMatchObject({success:true,data:{operations:[]}})
  })

  test('pins source revisions while leaving revision existence to the owning Module', async () => {
    const requests: Request[]=[]
    const base=catalogFetch(requests)
    const tools=createWorkspaceCapabilityTools({
      workspaceId,hostBaseUrl:'https://host.test',getRoomScope:()=>({kind:'resource',resource:run}),
      fetchImpl:(async(input,init)=>{
        const response=await base(input,init)
        const url=String(input)
        if(url.endsWith('/resources')){
          const body=await response.json() as {resources:Array<{sourceDefinition?:typeof definition}>}
          body.resources[0]!.sourceDefinition=definition
          return Response.json(body)
        }
        if(url.endsWith('/definitions')){
          const body=await response.json() as {definitions:Array<{currentRevisionId:string}>}
          body.definitions[0]!.currentRevisionId='revision-new'
          return Response.json(body)
        }
        return response
      }) as typeof fetch,
    })
    expect(await tools[0]!.execute({},context)).toMatchObject({success:true,data:{
      definitions:[{target:{ref:definition}}],
    }})
    const invoke=(revisionId:string)=>tools[1]!.execute({calls:[{key:'source',operationId:inspectDefinitionId,
      target:{kind:'definition',ref:{...definition,revisionId}},input:{}}]},context)
    expect(await invoke(definition.revisionId)).toMatchObject({success:true,data:{results:[{success:true}]}})
    expect(await invoke('revision-new')).toMatchObject({success:true,data:{results:[{success:false,error:expect.stringContaining('target_out_of_scope')}]}})
  })

  test('rejects duplicate batch keys before executing', async () => {
    const requests:Request[]=[]
    const [,call]=makeTools({kind:'workspace'},requests)
    expect(await call!.execute({calls:[1,2].map(()=>({key:'same',operationId:readId,target:runTarget,input:{}}))},context))
      .toMatchObject({success:false,error:expect.stringContaining('unique')})
    expect(requests).toHaveLength(0)
  })
  test('exposes only the two generic tools', () => {
    expect(makeTools({ kind: 'workspace' }).map(tool => tool.name)).toEqual(['workspace_explore', 'workspace_call'])
  })

  test('explores compact Resources and exact operation schemas inside Room Scope', async () => {
    const [explore] = makeTools({ kind: 'resource', resource: run })
    const scope = await explore!.execute({ view: 'scope' }, context)
    expect(scope).toMatchObject({ success: true, data: {
      scope: { kind: 'resource', resource: run }, total: 1,
      resources: [{ target: runTarget, operationCount: 2 }],
    } })

    const operations = await explore!.execute({
      view: 'operations', target: runTarget, operationIds: [readId], includeInputSchema: true,
    }, context)
    expect(operations).toMatchObject({ success: true, data: {
      operations: [{ operationId: readId, inputSchema: { type: 'object' } }],
    } })
  })

  test('finds Pack-owned vocabulary without exposing search metadata as authority', async () => {
    const [explore] = makeTools({ kind: 'resource', resource: run })
    const result = await explore!.execute({
      view: 'operations', target: runTarget, queries: ['trip unit 2 RCPs'],
    }, context)
    expect(result).toMatchObject({ success: true, data: {
      operations: [{ operationId: writeId, matchedTerms: ['trip', 'rcps'] }],
    } })
    expect((result.data as { operations: Array<Record<string, unknown>> }).operations[0]).not.toHaveProperty('searchTerms')
  })

  test('keeps browsing compact and returns requested schemas directly with a focused search', async () => {
    const [explore] = makeTools({ kind: 'resource', resource: run })
    const broad = await explore!.execute({
      view: 'operations', queries: ['simulation'],
    }, context)
    for (const operation of (broad.data as { operations: Array<Record<string, unknown>> }).operations) {
      expect(operation).not.toHaveProperty('inputSchema')
      expect(operation).not.toHaveProperty('outputSchema')
    }

    const focused = await explore!.execute({
      view: 'operations', queries: ['sitrep'], includeInputSchema: true,
    }, context)
    expect(focused).toMatchObject({ success: true, data: {
      total: 1, operations: [{ operationId: readId, inputSchema: { type: 'object' } }],
    } })
    expect(focused.data).not.toHaveProperty('schemaGuidance')
    expect((focused.data as { operations: unknown[] }).operations[0]).not.toHaveProperty('outputSchema')

    const exact = await explore!.execute({
      view: 'operations', operationIds: [readId], includeInputSchema: true, includeOutputSchema: true,
    }, context)
    expect(exact).toMatchObject({ success: true, data: {
      operations: [{ operationId: readId, inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }],
    } })
  })

  test('operation pagination is independent of large Resource inventories', async () => {
    const base = catalogFetch([])
    const [explore] = createWorkspaceCapabilityTools({
      workspaceId, hostBaseUrl: 'https://host.test', getRoomScope: () => ({ kind: 'workspace' }),
      fetchImpl: (async (input, init) => {
        const response = await base(input, init)
        if (!String(input).endsWith('/resources')) return response
        const body = await response.json() as { resources: Array<{ ref: typeof run }> }
        const original = body.resources[0]!
        body.resources = Array.from({ length: 60 }, (_, index) => ({ ...original, ref: workspaceResourceReferenceSchema.parse({ ...run, id: `run-${index}` }) }))
        return Response.json(body)
      }) as typeof fetch,
    })
    expect(await explore!.execute({ view: 'scope' }, context)).toMatchObject({ success: true, data: { returned: 30, hasMore: true } })
    expect(await explore!.execute({ view: 'operations', queries: ['simulation'], limit: 1, includeInputSchema: true }, context))
      .toMatchObject({ success: true, data: { total: 2, returned: 1, hasMore: true, resources: [], definitions: [], operations: [{ inputSchema: { type: 'object' } }] } })
    expect(await explore!.execute({ view: 'operations', queries: ['simulation'], offset: 1, limit: 1 }, context))
      .toMatchObject({ success: true, data: { total: 2, returned: 1, hasMore: false } })
    expect(await explore!.execute({ view: 'all' }, context)).toMatchObject({ success: false, error: expect.stringContaining('invalid_tool_input') })
  })

  // A Pack's many operations share the words of its namespace: World's
  // process-plant ids all read world, process, plant.
  const packCatalogTools = () => {
    const nouns = ['plants', 'signals', 'alarms', 'controls', 'components', 'actions', 'credibility', 'catalog', 'graph', 'display', 'assessments', 'conditions']
    const verbs = ['list', 'search', 'read', 'evaluate', 'compose', 'view', 'propose']
    const packOperations = nouns.flatMap(noun => verbs.map(verb => ({
      id: capabilityIdSchema.parse(`world.process-plant.${noun}.${verb}`), moduleId, kind: 'query' as const,
      scope: { kind: 'resource' as const, resourceType: run.type },
      title: `${noun} · ${verb}`, description: `Process Plant ${noun}: ${verb} them for one Plant of the Run.`,
      risk: 'read' as const, idempotent: true,
      inputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { plantId: { type: 'string' } } },
      outputSchema: { type: 'object' },
    })))
    const base = catalogFetch([])
    return createWorkspaceCapabilityTools({
      workspaceId, hostBaseUrl: 'https://host.test', getRoomScope: () => ({ kind: 'resource', resource: run }),
      fetchImpl: (async (input, init) => {
        const response = await base(input, init)
        const path = new URL(String(input)).pathname
        if (path.endsWith('/capabilities')) {
          const body = await response.json() as { capabilities: unknown[] }
          body.capabilities.push(...packOperations)
          return Response.json(body)
        }
        if (path.endsWith('/resources')) {
          const body = await response.json() as { resources: Array<{ ref: typeof run; capabilityIds: string[] }> }
          body.resources[0]!.capabilityIds.push(...packOperations.map(operation => operation.id))
          return Response.json(body)
        }
        return response
      }) as typeof fetch,
    })
  }
  const operationIdsOf = (result: Awaited<ReturnType<NonNullable<ReturnType<typeof makeTools>[0]>['execute']>>) =>
    (result.data as { operations: Array<{ operationId: string }> }).operations.map(operation => operation.operationId)

  test('an operation id passed as a query is that exact operation, never its namespace words matched against every operation', async () => {
    const [explore] = packCatalogTools()
    const ids = ['world.process-plant.plants.list', 'world.process-plant.signals.search', 'world.process-plant.signals.read', 'world.process-plant.display.compose', 'world.process-plant.assessments.evaluate']
    const result = await explore!.execute({ view: 'operations', queries: ids, includeInputSchema: true }, context)
    expect(result).toMatchObject({ success: true, data: { total: 5, returned: 5, hasMore: false } })
    expect(operationIdsOf(result).sort()).toEqual([...ids].sort())
    expect(result.data).not.toHaveProperty('unavailableOperationIds')
    // The same as asking for them by operationIds.
    expect(await explore!.execute({ view: 'operations', operationIds: ids, includeInputSchema: true }, context)).toEqual(result)
  })

  test('an exact id this Room cannot reach is named, not answered with a word search', async () => {
    const [explore] = packCatalogTools()
    const result = await explore!.execute({ view: 'operations', queries: ['world.process-plant.plant.list', 'world.process-plant.signals.read'] }, context)
    expect(result).toMatchObject({ success: true, data: { total: 1, unavailableOperationIds: ['world.process-plant.plant.list'] } })
    expect(operationIdsOf(result)).toEqual(['world.process-plant.signals.read'])
  })

  test('each plain-language query gets its best match first, by the words that tell operations apart', async () => {
    const [explore] = packCatalogTools()
    // Namespace words every operation shares rank nothing; the page takes
    // every query's best match before any query's second best.
    const result = await explore!.execute({ view: 'operations', queries: ['world process plant plants list', 'world process plant signals search', 'process plant display compose'], limit: 3 }, context)
    expect(operationIdsOf(result)).toEqual(['world.process-plant.plants.list', 'world.process-plant.signals.search', 'world.process-plant.display.compose'])
    expect(result).toMatchObject({ success: true, data: { hasMore: true } })
  })

  test('a page carrying schemas holds a focused search by default, and always every exact id asked for', async () => {
    const [explore] = packCatalogTools()
    const focused = await explore!.execute({ view: 'operations', queries: ['process plant signals'], includeInputSchema: true }, context)
    expect(focused).toMatchObject({ success: true, data: { returned: 5, hasMore: true } })
    const compact = await explore!.execute({ view: 'operations', queries: ['process plant signals'] }, context)
    expect(compact).toMatchObject({ success: true, data: { returned: 30, hasMore: true } })
    const verbs = ['list', 'search', 'read', 'evaluate', 'compose', 'view', 'propose'].map(verb => `world.process-plant.signals.${verb}`)
    const exact = await explore!.execute({ view: 'operations', operationIds: verbs, queries: ['alarms'], includeInputSchema: true }, context)
    expect(exact).toMatchObject({ success: true, data: { returned: 7, hasMore: true } })
    expect(operationIdsOf(exact).sort()).toEqual([...verbs].sort())
    // The schema the model reads keeps every constraint, without the dialect URI.
    expect((exact.data as { operations: Array<{ inputSchema: unknown }> }).operations[0]!.inputSchema).toEqual({ type: 'object', properties: { plantId: { type: 'string' } } })
  })

  test('a Room reaches the display publishers its Scope holds, as their Module marks them, never by id', async () => {
    const compose = capabilityIdSchema.parse('world.process-plant.display.compose')
    const base = catalogFetch([])
    const lookup = (scope: WorkspaceRoomScope, publishes: boolean) => createViewPublisherLookup({
      workspaceId, hostBaseUrl: 'https://host.test', getRoomScope: roomId => roomId === 'room' ? scope : undefined,
      fetchImpl: (async (input, init) => {
        const response = await base(input, init)
        const path = new URL(String(input)).pathname
        if (path.endsWith('/capabilities')) {
          const body = await response.json() as { capabilities: unknown[] }
          body.capabilities.push({ id: compose, moduleId, kind: 'query', scope: { kind: 'resource', resourceType: run.type }, title: 'display · compose', description: 'Compose a display.', risk: 'read', idempotent: true, ...(publishes ? { publishes: ['embedded-view'] } : {}), inputSchema: { type: 'object' }, outputSchema: { type: 'object' } })
          return Response.json(body)
        }
        if (path.endsWith('/resources')) {
          // Only Run 01 offers the display operation.
          const body = await response.json() as { resources: Array<{ ref: typeof run; capabilityIds: string[] }> }
          body.resources.find(resource => resource.ref.id === run.id)!.capabilityIds.push(compose)
          return Response.json(body)
        }
        return response
      }) as typeof fetch,
    })
    expect(await lookup({ kind: 'workspace' }, true)('room')).toEqual([compose])
    expect(await lookup({ kind: 'resource', resource: run }, true)('room')).toEqual([compose])
    expect(await lookup({ kind: 'resource', resource: otherRun }, true)('room')).toEqual([])
    expect(await lookup({ kind: 'workspace' }, false)('room')).toEqual([])
    expect(lookup({ kind: 'workspace' }, true)('missing')).rejects.toThrow('has no valid scope')
  })

  test('a Room\'s context publishers are the Resources in its Scope whose operation is marked context, read as the Agent', async () => {
    const contextId = capabilityIdSchema.parse('world.simulation-run.context')
    const base = catalogFetch([])
    const invoked: Array<{ path: string; body: Record<string, unknown> }> = []
    const lookup = (scope: WorkspaceRoomScope) => createContextPublisherLookup({
      workspaceId, hostBaseUrl: 'https://host.test', getRoomScope: roomId => roomId === 'room' ? scope : undefined,
      fetchImpl: (async (input, init) => {
        const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
        const path = new URL(request.url).pathname
        if (path.endsWith('/invoke')) {
          invoked.push({ path, body: await request.json() as Record<string, unknown> })
          return Response.json({ result: { context: { text: 'Run 01 · PAUSED', at: now, clock: 'simulation' } } })
        }
        const response = await base(input, init)
        if (path.endsWith('/capabilities')) {
          const body = await response.json() as { capabilities: unknown[] }
          body.capabilities.push({ id: contextId, moduleId, kind: 'query', scope: { kind: 'resource', resourceType: run.type }, title: 'context', description: 'Run context.', risk: 'read', idempotent: true, publishes: ['context'], inputSchema: { type: 'object' }, outputSchema: { type: 'object' } })
          return Response.json(body)
        }
        if (path.endsWith('/resources')) {
          const body = await response.json() as { resources: Array<{ ref: typeof run; capabilityIds: string[] }> }
          for (const resource of body.resources) if (resource.ref.type === run.type) resource.capabilityIds.push(contextId)
          return Response.json(body)
        }
        return response
      }) as typeof fetch,
    })
    expect(await lookup({ kind: 'workspace' }).publishers('room')).toEqual([{ operationId: contextId, resource: run }, { operationId: contextId, resource: otherRun }])
    expect(await lookup({ kind: 'resource', resource: otherRun }).publishers('room')).toEqual([{ operationId: contextId, resource: otherRun }])
    expect(await lookup({ kind: 'resource', resource: family }).publishers('room')).toEqual([])
    const read = await lookup({ kind: 'workspace' }).read({ operationId: contextId, resource: run }, { id: 'agent-1', name: 'Assistant' })
    expect(read).toEqual({ ok: true, context: { text: 'Run 01 · PAUSED', at: now, clock: 'simulation' } })
    expect(invoked[0]).toEqual({ path: `/api/workspaces/${workspaceId}/capabilities/${contextId}/invoke`, body: { resource: run, input: {}, actor: { kind: 'ai', id: 'agent-1', displayName: 'Assistant' } } })
  })

  test('essential discovery and action semantics reach the actual native model schema', () => {
    const [explore, call] = toolsToDefinitions(makeTools({ kind: 'workspace' }))
    const properties = explore!.function.parameters.properties as Record<string, { description?: string }>
    expect(properties.queries!.description).toContain('not asset names or live state')
    expect(properties.includeInputSchema!.description).toContain('focused search')
    const calls = (call!.function.parameters.properties as Record<string, { description?: string }>).calls!
    expect(calls.description).toContain('not an atomic snapshot')
  })

  test('resolves collection membership live and honors exclusions', async () => {
    const [explore] = makeTools({
      kind: 'collection', collection: family, members: { mode: 'all', except: [otherRun] },
    })
    const result = await explore!.execute({ view: 'scope' }, context)
    const ids = ((result.data as { resources: Array<{ target: { ref: { id: string } } }> }).resources)
      .map(resource => resource.target.ref.id)
    expect(ids).toEqual(['run-01', 'family-01'])
  })

  test('calls reads and changes through one shape while enforcing Room Scope', async () => {
    const [, call] = makeTools({ kind: 'resource', resource: run })
    expect(await call!.execute({ calls: [{ key: 'inferred', operationId: readId, input: {} }] }, context))
      .toMatchObject({ success: true, data: { results: [{ key: 'inferred', success: true, data: { state: 'running' } }] } })
    expect(await call!.execute({ calls: [{ key: 'state', operationId: readId, target: runTarget, input: {} }] }, context))
      .toMatchObject({ success: true, data: { results: [{ key: 'state', operationId: readId, success: true, data: { state: 'running' } }] } })

    expect(await call!.execute({ calls: [{ key: 'other', operationId: readId, target: { kind: 'resource', ref: otherRun }, input: {} }] }, context))
      .toMatchObject({ success: true, data: { results: [{ success: false, error: expect.stringContaining('target_out_of_scope') }] } })

    const [, ambiguousCall] = makeTools({ kind: 'collection', collection: family, members: { mode: 'all', except: [] } })
    expect(await ambiguousCall!.execute({ calls: [{ key: 'ambiguous', operationId: readId, input: {} }] }, context))
      .toMatchObject({ success: true, data: { results: [{ success: false, error: expect.stringContaining('target_required') }] } })
  })

  test('completes a published view with the invoked Resource and offers it by reference only', async () => {
    const view = { viewType: 'process-plant.display', title: 'Pressure', height: 340, state: '{"composition":{}}' }
    const viewFetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
      if (new URL(request.url).pathname.endsWith('/invoke')) return Response.json({ result: { view, shows: ['trend'] } })
      return catalogFetch([])(input, init)
    }) as typeof fetch
    const [, call] = createWorkspaceCapabilityTools({ workspaceId, hostBaseUrl: 'https://host.test', getRoomScope: () => ({ kind: 'resource', resource: run }), fetchImpl: viewFetch })
    const recorded = await call!.execute({ calls: [{ key: 'pressure display', operationId: readId, input: {} }] }, { ...context, executionCallId: 'call_2_0' })
    expect(recorded).toMatchObject({ success: true, data: { results: [{
      key: 'pressure display',
      viewRef: 'call_2_0/pressure%20display',
      embeddedView: { ...view, moduleId: 'world', subject: run },
    }] } })
    const standalone = await call!.execute({ calls: [{ key: 'p', operationId: readId, input: {} }] }, context)
    expect(standalone).toMatchObject({ success: true, data: { results: [{ viewError: expect.stringContaining('no execution evidence') }] } })
  })

  test('the model reads a view by reference: its opaque state and envelope stay in the execution evidence', async () => {
    const state = JSON.stringify({ composition: { title: 'Pressure', panels: [{ kind: 'trend', signals: ['PZR-P'] }] }, issuedAt: now })
    const view = { viewType: 'process-plant.display', title: 'Pressure', height: 340, state }
    const viewContent = { items: [{ names: ['PZR-P'], values: [{ value: 15.5, unit: 'MPa' }], limits: [], history: true }], span: null, lead: null }
    const viewFetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
      if (!new URL(request.url).pathname.endsWith('/invoke')) return catalogFetch([])(input, init)
      const { input: asked } = await request.json() as { input: { display?: true } }
      return Response.json({ result: asked.display === true ? { view, shows: ['trend'], viewContent } : { state: 'running' } })
    }) as typeof fetch
    const [, call] = createWorkspaceCapabilityTools({ workspaceId, hostBaseUrl: 'https://host.test', getRoomScope: () => ({ kind: 'resource', resource: run }), fetchImpl: viewFetch })
    const raw = await call!.execute({ calls: [
      { key: 'display', operationId: readId, input: { display: true } },
      { key: 'plain', operationId: readId, input: {} },
      { key: 'refused', operationId: readId, target: { kind: 'resource', ref: otherRun }, input: {} },
    ] }, { ...context, executionCallId: 'call_0_0' })
    const before = JSON.stringify(raw)
    const shown = workspaceCallResultForModel(raw)
    // The raw result, which the execution store and every check read, keeps the view.
    expect(JSON.stringify(raw)).toBe(before)
    expect((raw.data as { results: ReadonlyArray<unknown> }).results[0]).toMatchObject({ embeddedView: { state }, data: { view: { state } } })
    const [display, plain, refused] = (shown.data as { results: ReadonlyArray<Record<string, unknown>> }).results
    expect(display).toEqual({
      key: 'display', operationId: readId, target: runTarget, success: true, viewRef: 'call_0_0/display',
      data: { view: { viewType: 'process-plant.display', title: 'Pressure', height: 340 }, shows: ['trend'], viewContent },
    })
    expect(JSON.stringify(shown)).not.toContain('composition')
    const [, rawPlain, rawRefused] = (raw.data as { results: ReadonlyArray<Record<string, unknown>> }).results
    expect(plain).toBe(rawPlain)
    expect(refused).toBe(rawRefused)
    const failed = { success: false, error: 'invalid_tool_input: Batch keys must be unique', data: { code: 'invalid_tool_input' } }
    expect(workspaceCallResultForModel(failed)).toBe(failed)
  })

  test('a refusal of input that does not match the schema carries the schema, within a bound', async () => {
    const largeSchema = { type: 'object', properties: Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`field${index}`, { type: 'string', description: 'x'.repeat(20) }])) }
    const refusingFetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
      const pathname = new URL(request.url).pathname
      if (pathname.endsWith('/capabilities')) {
        const catalog = await (await catalogFetch([])(input, init)).json() as { capabilities: Array<{ id: string; inputSchema: unknown }> }
        return Response.json({ ...catalog, capabilities: catalog.capabilities.map(operation => operation.id === writeId
          ? { ...operation, inputSchema: largeSchema }
          : { ...operation, inputSchema: { type: 'object', required: ['plantId'], properties: { plantId: { type: 'string' } } } }) })
      }
      if (!pathname.endsWith('/invoke')) return catalogFetch([])(input, init)
      const { input: asked } = await request.json() as { input: { refuse: string } }
      return Response.json({ error: { code: asked.refuse, message: 'plantId: Required' } }, { status: 400 })
    }) as typeof fetch
    const [, call] = createWorkspaceCapabilityTools({ workspaceId, hostBaseUrl: 'https://host.test', getRoomScope: () => ({ kind: 'resource', resource: run }), fetchImpl: refusingFetch })
    const refusal = async (operationId: string, refuse: string) =>
      ((await call!.execute({ calls: [{ key: 'k', operationId, target: runTarget, input: { refuse } }] }, context)).data as { results: ReadonlyArray<Record<string, unknown>> }).results[0]!

    expect(await refusal(readId, 'invalid_request')).toMatchObject({
      success: false,
      error: 'invalid_request: plantId: Required',
      inputSchema: { type: 'object', required: ['plantId'], properties: { plantId: { type: 'string' } } },
    })
    // A schema over the bound is named for an explicit read, not carried.
    const large = await refusal(writeId, 'invalid_request')
    expect(JSON.stringify(largeSchema).length).toBeGreaterThan(4096)
    expect(large.inputSchema).toBeUndefined()
    expect(large.inputSchemaOmitted).toMatch(new RegExp(`^\\d+ bytes; read it with workspace_explore view=operations, operationIds \\["${writeId.replaceAll('.', '\\.')}"\\], includeInputSchema true$`))
    // A Module's own refusal of a valid-shaped input names its fixes; it carries no schema.
    const rejected = await refusal(readId, 'capability_input_rejected')
    expect(rejected).toMatchObject({ success: false, error: 'capability_input_rejected: plantId: Required' })
    expect(Object.keys(rejected)).not.toContain('inputSchema')
  })

  test('batches independent reads but rejects a batch containing a change', async () => {
    const requests: Request[] = []
    const [, call] = makeTools({ kind: 'resource', resource: run }, requests)
    expect(await call!.execute({ calls: [
      { key: 'one', operationId: readId, target: runTarget, input: {} },
      { key: 'two', operationId: readId, target: runTarget, input: {} },
    ] }, context)).toMatchObject({ success: true, data: { results: [{ key: 'one', success: true }, { key: 'two', success: true }] } })

    const before = requests.filter(request => request.url.includes('/invoke')).length
    expect(await call!.execute({ calls: [
      { key: 'read', operationId: readId, target: runTarget, input: {} },
      { key: 'write', operationId: writeId, target: runTarget, input: {} },
    ] }, context)).toMatchObject({ success: false, error: expect.stringContaining('batch_requires_read_operations') })
    expect(requests.filter(request => request.url.includes('/invoke'))).toHaveLength(before)
  })

  test('preflights caller retry keys against discovered operation metadata', async () => {
    const requests: Request[] = []
    const [, call] = makeTools({ kind: 'resource', resource: run }, requests)
    expect(await call!.execute({ calls: [{
      key: 'read', operationId: readId, target: runTarget, input: {}, idempotencyKey: 'unsupported',
    }] }, context)).toMatchObject({
      success: true,
      data: { results: [{ success: false, error: expect.stringContaining('idempotency_not_supported') }] },
    })
    expect(requests.filter(request => request.url.includes('/invoke'))).toHaveLength(0)

    expect(await call!.execute({ calls: [{
      key: 'write', operationId: writeId, target: runTarget, input: {}, idempotencyKey: 'supported',
    }] }, context)).toMatchObject({ success: true, data: { results: [{ success: true }] } })
    const invoked = requests.find(request => request.url.includes('/invoke'))!
    expect(await invoked.json()).toMatchObject({ idempotencyKey: 'supported' })
  })

  test('a change that succeeds returns its say line for the person; a refused change returns none', async () => {
    const requests: Request[] = []
    const base = catalogFetch(requests)
    const refusingFetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
      if (!new URL(request.url).pathname.endsWith('/invoke')) return base(request)
      const { input: asked } = await request.clone().json() as { input: { refuse?: true } }
      if (asked.refuse) return Response.json({ error: { code: 'simulation_command_rejected', message: 'a person drives this Run' } }, { status: 409 })
      return base(request)
    }) as typeof fetch
    const [, call] = createWorkspaceCapabilityTools({ workspaceId, hostBaseUrl: 'https://host.test', getRoomScope: () => ({ kind: 'resource', resource: run }), fetchImpl: refusingFetch })
    const line = 'E-0 step 3 · Verified: BUS-A-EMERG 4.16 kV, BUS-B-EMERG 4.16 kV at 10:02:14 → step 4'

    // No execution evidence is needed: a scripted or standalone executor gets the line too.
    const done = await call!.execute({ calls: [{ key: 'step', operationId: writeId, input: {}, say: `  ${line} ` }] }, context)
    expect(done).toMatchObject({ success: true, data: { results: [{ key: 'step', success: true }] }, progress: [line] })
    // The line is for the person: the Module never receives it, and the model's reading of the result does not repeat it.
    const invoked = requests.filter(request => request.url.includes('/invoke'))
    expect(invoked).toHaveLength(1)
    expect(await invoked[0]!.json()).not.toHaveProperty('say')
    expect(JSON.stringify(workspaceCallResultForModel(done).data)).not.toContain('BUS-A-EMERG')

    const refused = await call!.execute({ calls: [{ key: 'step', operationId: writeId, input: { refuse: true }, say: line }] }, context)
    expect(refused).toMatchObject({ success: true, data: { results: [{ success: false, error: expect.stringContaining('simulation_command_rejected') }] } })
    expect(refused).not.toHaveProperty('progress')
    // A line is one short chat line.
    expect(await call!.execute({ calls: [{ key: 'long', operationId: writeId, input: {}, say: 'x'.repeat(301) }] }, context))
      .toMatchObject({ success: false, error: expect.stringContaining('invalid_tool_input') })
    expect(await call!.execute({ calls: [{ key: 'blank', operationId: writeId, input: {}, say: '   ' }] }, context))
      .toMatchObject({ success: false, error: expect.stringContaining('invalid_tool_input') })
  })

  test('a read carrying say is refused before invocation while the other reads of its batch run', async () => {
    const requests: Request[] = []
    const [, call] = makeTools({ kind: 'resource', resource: run }, requests)
    const result = await call!.execute({ calls: [
      { key: 'said', operationId: readId, target: runTarget, input: {}, say: 'Read the run' },
      { key: 'plain', operationId: readId, target: runTarget, input: {} },
    ] }, context)
    expect(result).toMatchObject({ success: true, data: { results: [
      { key: 'said', success: false, error: expect.stringContaining('say_not_for_reads') },
      { key: 'plain', success: true, data: { state: 'running' } },
    ] } })
    expect(result).not.toHaveProperty('progress')
    expect(requests.filter(request => request.url.includes('/invoke'))).toHaveLength(1)
  })

  test('the model learns say from the native schema: a change\'s short line, never a read\'s', () => {
    const [, call] = toolsToDefinitions(makeTools({ kind: 'workspace' }))
    const calls = (call!.function.parameters.properties as Record<string, { items: { properties: Record<string, { description?: string; maxLength?: number }> } }>).calls!
    const say = calls.items.properties.say!
    expect(say.description).toContain('posted to this conversation as your own message once this call succeeds')
    expect(say.description).toContain('Never for reads')
    expect(say.maxLength).toBe(300)
  })

  test('never discovers or invokes the Agents People Capabilities, which serve humans through the Host UI', async () => {
    const agents = moduleIdSchema.parse('agents')
    const peopleSend = capabilityIdSchema.parse('agents.people.message.send')
    const packsList = capabilityIdSchema.parse('agents.packs.list')
    const requests: Request[] = []
    const base = catalogFetch(requests)
    const [explore, call] = createWorkspaceCapabilityTools({
      workspaceId, hostBaseUrl: 'https://host.test', getRoomScope: () => ({ kind: 'workspace' }),
      fetchImpl: (async (input, init) => {
        const response = await base(input, init)
        if (!new Request(String(input), init).url.endsWith('/capabilities')) return response
        const body = await response.json() as { modules: unknown[]; capabilities: unknown[] }
        body.modules.push({ moduleId: agents, status: 'ready' })
        body.capabilities.push(
          { id: peopleSend, moduleId: agents, kind: 'command', scope: { kind: 'workspace' }, title: 'Send a direct message', description: 'Sends a text message to another Person.', risk: 'write', idempotent: false, acceptsIdempotencyKey: true, inputSchema: { type: 'object' }, outputSchema: { type: 'object' } },
          { id: packsList, moduleId: agents, kind: 'query', scope: { kind: 'workspace' }, title: 'List installed Agent Packs', description: 'Lists Packs.', risk: 'read', idempotent: true, inputSchema: { type: 'object' }, outputSchema: { type: 'object' } },
        )
        return Response.json(body)
      }) as typeof fetch,
    })
    const browsed = await explore!.execute({ view: 'operations', moduleId: 'agents', limit: 100 }, context)
    expect(browsed).toMatchObject({ success: true, data: { operations: [{ operationId: packsList }] } })
    expect(JSON.stringify(browsed)).not.toContain('agents.people.')
    expect(await explore!.execute({ view: 'operations', operationIds: [peopleSend], queries: ['send direct message person'] }, context))
      .toMatchObject({ success: true, data: { operations: [] } })
    expect(await call!.execute({ calls: [{ key: 'dm', operationId: peopleSend, input: { token: 't', to: 'p', text: 'hi' }, idempotencyKey: 'k' }] }, context))
      .toMatchObject({ success: true, data: { results: [{ success: false, error: expect.stringContaining('operation_not_advertised') }] } })
    expect(requests.filter(request => request.url.includes('/invoke'))).toHaveLength(0)
  })

  test('requires a Room with an explicit Scope', async () => {
    const [, call] = makeTools({ kind: 'workspace' })
    expect(await call!.execute({ calls: [{ key: 'state', operationId: readId, target: runTarget, input: {} }] }, {
      callerId: 'agent', callerName: 'Analyst', roomId: 'missing',
    })).toMatchObject({ success: false, error: expect.stringContaining('room_scope_unavailable') })
  })
})
