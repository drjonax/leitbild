/**
 * Reads Pack observation content as the caller (architecture A1), the way
 * procedure observations do: every call runs the Pack's system-audience
 * Capability through the Run's gates, so the caller's restrictions, role and
 * viewer apply. The Run's output parse is the core schema itself (assembly
 * accepts only those instances). Validated declarations and topology are
 * cached per Run by revision; a warm call still passes the gates and the Pack
 * answers `unchanged`.
 */
import type { z } from 'zod'
import { refObjectId } from '../../../core/model/alerts.ts'
import type { ObjectId, OperationalObject } from '../../../core/model/index.ts'
import type { ObservationDeclaration, observationShapes } from '../../../core/observation/capabilities.ts'
import type { Observation } from '../../../core/observation/model.ts'
import type { TopologyGraph } from '../../../core/observation/topology.ts'
import type { PackObservationContribution, WorldPack } from '../../../core/packs/protocol.ts'
import { isRoleGateRefusal } from '../../../core/simulation-runs/role-gates.ts'

/** `unknown_object`, `not_observed`, `agent_access_restricted`, or the Run's role-gate code (e.g. `ai_role_run_unsupported`, `role_view_not_supported`). */
export interface ObservationRefusal {
  readonly objectId: ObjectId
  readonly refused: { readonly code: string; readonly message: string }
}
export interface ObservationReadResult {
  readonly observations: ReadonlyArray<Observation>
  readonly unknown: ReadonlyArray<string>
  readonly refused: ReadonlyArray<ObservationRefusal>
}
export type ObservationReadRequest = { readonly refs: ReadonlyArray<string> } | { readonly lead: { readonly objectId: ObjectId; readonly count: number } }

export interface ObservationPort {
  /** One entry per requested object, in order. */
  readonly declarations: (objectIds: ReadonlyArray<ObjectId>, elementIds?: ReadonlyArray<string>) => Promise<ReadonlyArray<ObservationDeclaration | ObservationRefusal>>
  readonly read: (request: ObservationReadRequest) => Promise<ObservationReadResult>
  readonly topology: (objectId: ObjectId) => Promise<TopologyGraph | ObservationRefusal>
}

/** The Pack's observation contribution for an object in one of its declared categories. */
export const observationProviderFor = (packs: ReadonlyArray<WorldPack>) => (object: OperationalObject): PackObservationContribution | undefined => {
  const pack = packs.find(candidate => candidate.descriptor.id === object.packId)
  const observation = pack?.observation
  if (!observation) return undefined
  return pack.presentation.categories.some(category => observation.categories.includes(category.id) && category.matches(object)) ? observation : undefined
}

const cacheLimit = 256
export interface ObservationCache {
  readonly declarations: Map<string, ObservationDeclaration>
  readonly topology: Map<ObjectId, TopologyGraph>
}
export const createObservationCache = (): ObservationCache => ({ declarations: new Map(), topology: new Map() })
const remember = <K, V>(cache: Map<K, V>, key: K, value: V): V => {
  cache.delete(key)
  cache.set(key, value)
  if (cache.size > cacheLimit) cache.delete(cache.keys().next().value as K)
  return value
}

type Output<K extends keyof typeof observationShapes> = z.output<(typeof observationShapes)[K]['output']>
const isRefusal = (value: unknown): value is ObservationRefusal => typeof value === 'object' && value !== null && 'refused' in value

export const createObservationPort = (config: {
  readonly object: (objectId: ObjectId) => OperationalObject | undefined
  readonly provider: (object: OperationalObject) => PackObservationContribution | undefined
  /** Invokes a system-audience Capability as the caller, through the Run's gates. */
  readonly query: (capabilityId: string, input: unknown) => Promise<unknown>
  readonly cache: ObservationCache
}): ObservationPort => {
  const refusal = (objectId: ObjectId, code: string, message: string): ObservationRefusal => ({ objectId, refused: { code, message } })
  const observed = (objectId: ObjectId): { readonly object: OperationalObject; readonly provider: PackObservationContribution } | ObservationRefusal => {
    const object = config.object(objectId)
    if (!object) return refusal(objectId, 'unknown_object', `No object ${objectId} in this Run`)
    const provider = config.provider(object)
    return provider ? { object, provider } : refusal(objectId, 'not_observed', `${object.label} declares no observations`)
  }
  // An access refusal from the gates answers for this object; any other failure stays visible.
  const asCaller = async <T>(objectId: ObjectId, capabilityId: string, input: unknown): Promise<T | ObservationRefusal> => {
    try { return await config.query(capabilityId, input) as T }
    catch (error) {
      const code = (error as { readonly code?: unknown }).code
      if (isRoleGateRefusal(error) || code === 'agent_access_restricted') return refusal(objectId, String(code), (error as Error).message)
      throw error
    }
  }

  const declarationOf = async (objectId: ObjectId, elementIds: ReadonlyArray<string> | undefined): Promise<ObservationDeclaration | ObservationRefusal> => {
    const target = observed(objectId)
    if (isRefusal(target)) return target
    const key = JSON.stringify([objectId, elementIds ?? null])
    const cached = config.cache.declarations.get(key)
    const outcome = await asCaller<Output<'declarations'>>(objectId, target.provider.declarations, {
      objectIds: [objectId], ...(elementIds === undefined ? {} : { elementIds }), ...(cached === undefined ? {} : { known: { [objectId]: cached.revision } }),
    })
    if (isRefusal(outcome)) return outcome
    const entry = outcome.declarations.length === 1 ? outcome.declarations[0] : undefined
    if (entry?.objectId !== objectId) throw new Error(`${target.provider.declarations} did not declare exactly ${objectId}`)
    if (!('unchanged' in entry)) return remember(config.cache.declarations, key, entry)
    if (cached?.revision !== entry.revision) throw new Error(`${target.provider.declarations} answered unchanged for a revision World does not hold: ${objectId} ${entry.revision}`)
    return cached
  }

  const readOne = async (objectId: ObjectId, input: { readonly refs: ReadonlyArray<string> } | { readonly lead: { readonly objectId: ObjectId; readonly count: number } }): Promise<Output<'read'> | ObservationRefusal> => {
    const target = observed(objectId)
    if (isRefusal(target)) return target
    const outcome = await asCaller<Output<'read'>>(objectId, target.provider.read, input)
    if (isRefusal(outcome)) return outcome
    const asked = 'refs' in input ? new Set(input.refs) : null
    const strays = [...outcome.observations.map(observation => observation.ref), ...outcome.unknown]
      .filter(ref => asked === null ? refObjectId(ref) !== objectId : !asked.has(ref))
    if (strays.length > 0 || ('lead' in input && outcome.observations.length > input.lead.count)) {
      throw new Error(`${target.provider.read} answered beyond its request: ${strays.join(', ') || 'too many lead values'}`)
    }
    return outcome
  }

  return {
    declarations: async (objectIds, elementIds) => {
      const answers: Array<ObservationDeclaration | ObservationRefusal> = []
      for (const objectId of objectIds) answers.push(await declarationOf(objectId, elementIds))
      return answers
    },
    read: async request => {
      const groups = new Map<ObjectId, string[]>()
      if ('refs' in request) for (const ref of request.refs) groups.set(refObjectId(ref), [...groups.get(refObjectId(ref)) ?? [], ref])
      const observations: Observation[] = []
      const unknown: string[] = []
      const refused: ObservationRefusal[] = []
      const calls = 'lead' in request ? [[request.lead.objectId, request] as const]
        : [...groups].flatMap(([objectId, refs]) => Array.from({ length: Math.ceil(refs.length / 64) }, (_, index) => [objectId, { refs: refs.slice(index * 64, index * 64 + 64) }] as const))
      for (const [objectId, input] of calls) {
        const outcome = await readOne(objectId, input)
        if (isRefusal(outcome)) refused.push(outcome)
        else { observations.push(...outcome.observations); unknown.push(...outcome.unknown) }
      }
      return { observations, unknown, refused }
    },
    topology: async objectId => {
      const target = observed(objectId)
      if (isRefusal(target)) return target
      const topology = target.provider.topology
      if (!topology) return refusal(objectId, 'not_observed', `${target.object.label} declares no topology`)
      const cached = config.cache.topology.get(objectId)
      const outcome = await asCaller<Output<'topology'>>(objectId, topology.capability, { objectId, ...(cached === undefined ? {} : { known: cached.revision }) })
      if (isRefusal(outcome)) return outcome
      if (outcome.objectId !== objectId) throw new Error(`${topology.capability} answered for ${outcome.objectId}, not ${objectId}`)
      if ('unchanged' in outcome) {
        if (cached?.revision !== outcome.revision) throw new Error(`${topology.capability} answered unchanged for a revision World does not hold: ${objectId} ${outcome.revision}`)
        return cached
      }
      if (outcome.family !== topology.family) throw new Error(`${topology.capability} drew a ${outcome.family} graph; the Pack declares ${topology.family}`)
      return remember(config.cache.topology, objectId, outcome)
    },
  }
}

/**
 * The port one request reads through (a sample, a compose, one Capability call): it asks the Packs for each
 * declaration, topology, lead and value once, so every view of the request sees one answer, read at one instant, and
 * each Pack query, which reads the Run where it stands, is made once (R1 perf: a lead request reads its object's
 * declaration, lead and own values before the sample reads its views).
 */
export const requestPort = (port: ObservationPort): ObservationPort => {
  const declarations = new Map<string, Promise<ObservationDeclaration | ObservationRefusal>>()
  const topologies = new Map<ObjectId, Promise<TopologyGraph | ObservationRefusal>>()
  const leads = new Map<string, Promise<ObservationReadResult>>()
  const readings = new Map<string, Observation>()
  const unread = new Set<string>()
  const once = <K, V>(asked: Map<K, Promise<V>>, key: K, ask: () => Promise<V>): Promise<V> => {
    const known = asked.get(key) ?? ask()
    asked.set(key, known)
    return known
  }
  return {
    declarations: async (objectIds, elementIds) => {
      const answers: Array<ObservationDeclaration | ObservationRefusal> = []
      for (const objectId of objectIds) {
        answers.push(await once(declarations, JSON.stringify([objectId, elementIds ?? null]), async () => (await port.declarations([objectId], elementIds))[0]!))
      }
      return answers
    },
    read: async request => {
      if ('lead' in request) {
        return once(leads, JSON.stringify(request.lead), async () => {
          const answer = await port.read(request)
          for (const observation of answer.observations) readings.set(observation.ref, observation)
          return answer
        })
      }
      // Only what the request has not read yet goes to the Packs; the answer keeps the order asked.
      const asked = [...new Set(request.refs)]
      const fresh = asked.filter(ref => !readings.has(ref) && !unread.has(ref))
      const answer = fresh.length === 0 ? { observations: [], unknown: [], refused: [] } : await port.read({ refs: fresh })
      for (const observation of answer.observations) readings.set(observation.ref, observation)
      for (const ref of answer.unknown) unread.add(ref)
      return { observations: asked.flatMap(ref => readings.get(ref) ?? []), unknown: asked.filter(ref => unread.has(ref)), refused: answer.refused }
    },
    topology: objectId => once(topologies, objectId, () => port.topology(objectId)),
  }
}
