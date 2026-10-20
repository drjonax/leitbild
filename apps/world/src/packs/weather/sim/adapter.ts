import type {
  CommandEnvelope,
  CommandResult,
  IsoTimestamp,
  OperationalObject,
  PackRuntimeRecordingBatch,
  SimulationClockState,
} from '../../../core/model/index.ts'
import { commandResultSchema,geoPointFromLonLat,nowIso,recordingSeriesIdFor } from '../../../core/model/index.ts'
import { createSimulationClock } from '../../../core/model/time.ts'
import { hexCellsForPolygon,hexResolution } from '../../../core/spatial/index.ts'
import { defineSimulationCommandCapability } from '../../../simulation/capabilities.ts'
import type {
  PackRuntimeAdapter,
  PackRuntimeConnection,
  PackRuntimeEvent,
  PackRuntimeEventHandler,
  PackRuntimeHealth,
} from '../../../simulation/protocol.ts'
import {
  advanceWeather,
  checkpointWeatherField,
  createWeatherField,
  interveneGround,
  sampleWeather,
  setWeatherObjects,
  type WeatherField,
} from '../cell-field.ts'
import { weatherCommandSchemas } from '../commands.ts'
import { frameAt } from '../influence.ts'
import { weatherItemSchema,weatherPackConfigSchema,weatherPackDataSchema } from '../model.ts'
import { weatherQuantities,weatherRecordingProfiles } from '../quantities.ts'
import { answerWeatherQuery,weatherQueryCapabilities } from '../query.ts'
import { weatherObservationDeclarations } from '../observation/declarations.ts'
import { weatherObservationRead } from '../observation/read.ts'
import { createWeatherObject } from '../scenario.ts'
import { weatherSimRuntimeId } from './constants.ts'

const descriptions: Record<keyof typeof weatherCommandSchemas, [string, string]> = {
  'world.weather.create': [
    'Create weather area or probe',
    'Uses the same complete item definition as scenario authoring. Area keyframes start at current simulation time; no ground state is reset.',
  ],
  'world.weather.update': [
    'Update weather area or probe',
    'Replace an item definition with revision checking. Identity and type are stable; keyframes retain their original start time.',
  ],
  'world.weather.set-enabled': [
    'Enable or disable weather area',
    'Sets atmospheric forcing on or off without replacing other item fields. Existing ground conditions remain and continue evolving.',
  ],
  'world.weather.intervene-ground': [
    'Set ground conditions in an area',
    'One-shot explicit ground intervention at the configured H3 resolution. Excludes holes and rejects unresolvable or excessive coverage.',
  ],
}
export const createLocalWeatherPackRuntimeAdapter = (): PackRuntimeAdapter => ({
  id: weatherSimRuntimeId,
  version: '1.0.0',
  packId: 'weather',
  clock: 'simulation',
  capabilities: [
    ...Object.entries(weatherCommandSchemas).map(([id, input]) =>
      defineSimulationCommandCapability({
        id,
        title: descriptions[id as keyof typeof weatherCommandSchemas][0],
        description: descriptions[id as keyof typeof weatherCommandSchemas][1],
        input,
        output: commandResultSchema,
        idempotent: id === 'world.weather.set-enabled',
        // Revision-guarded replacements need a current revision, which is not
        // knowable when a future cue is authored. Keep their CAS protection.
        schedulable: id !== 'world.weather.update',
        buildCommand: (raw) => {
          const parsed = input.parse(raw)
          const targets = 'objectId' in parsed ? [parsed.objectId] : 'item' in parsed ? [parsed.item.id] : []
          return { targetObjectIds: targets, payload: parsed }
        },
      }),
    ),
    ...weatherQueryCapabilities,
    weatherObservationDeclarations.capability,
    weatherObservationRead.capability,
  ],
  connect: async (config) => {
    const settings = weatherPackConfigSchema.parse(config.scenario.runtimeConfig)
    const objects = new Map<string, OperationalObject>()
    for (const object of config.initialObjects ?? config.scenario.initialObjects) {
      if (object.packId !== 'weather') continue
      weatherPackDataSchema.parse(object.packData)
      objects.set(object.id, object)
    }
    const restored = await config.runtimeStateStore?.load()
    if (config.initialObjects && config.runtimeStateStore && !restored) {
      throw new Error(
        'Weather ground checkpoint is missing. Create a new run; existing ground history cannot be reconstructed.',
      )
    }
    let field = createWeatherField(settings, config.scenario.world.startsAt, restored)
    setWeatherObjects(field, [...objects.values()])
    const handlers = new Set<PackRuntimeEventHandler>()
    let clock: SimulationClockState = { currentTime: field.at, updatedAt: nowIso(), paused: false }
    clock = config.runClock?.read() ?? clock
    const localClock = config.runClock ? null : createSimulationClock(clock)
    const runClock = config.runClock ?? localClock!
    let lastSaved = 0
    let lastRecorded = -Infinity
    const profile = config.recording
      ? weatherRecordingProfiles.find((p) => p.id === config.recording!.profileId)
      : undefined
    if (
      config.recording &&
      (!profile || (config.recording.intervalMs ?? profile.defaultIntervalMs) < profile.minimumIntervalMs)
    )
      throw new Error('Invalid Weather recording selection')
    let saving: Promise<void> = Promise.resolve()
    let health: PackRuntimeHealth = {
      runtimeId: weatherSimRuntimeId,
      state: 'ready',
      failureCount: 0,
      lastSuccessfulInteractionAt: nowIso(),
    }
    const fail = (operation: string, error: unknown): void => {
      health = {
        ...health,
        state: 'degraded',
        failureCount: health.failureCount + 1,
        lastFailure: { operation, at: nowIso(), message: error instanceof Error ? error.message : String(error) },
      }
    }
    const save = async (): Promise<void> => {
      if (!config.runtimeStateStore) return
      const checkpoint = structuredClone(checkpointWeatherField(field))
      saving = saving.catch(() => {}).then(() => config.runtimeStateStore!.save(checkpoint))
      await saving
      lastSaved = Date.now()
    }
    const recording = (): PackRuntimeRecordingBatch | undefined => {
      if (!config.recording) return
      const profile = weatherRecordingProfiles.find((p) => p.id === config.recording!.profileId)
      if (!profile) throw new Error('Unknown Weather recording profile')
      const interval = config.recording.intervalMs ?? profile.defaultIntervalMs
      if (interval < profile.minimumIntervalMs) throw new Error('Weather recording interval is below minimum')
      const time = Date.parse(field.at)
      if (time - lastRecorded < interval) return
      lastRecorded = time
      const descriptors: PackRuntimeRecordingBatch['descriptors'] = []
      const samples: PackRuntimeRecordingBatch['samples'] = []
      for (const [signalId, value] of [
        ['cell-count', field.cells.size],
        ['influence-count', field.influences.length],
      ] as const) {
        const id = recordingSeriesIdFor(weatherSimRuntimeId, signalId)
        descriptors.push({
          id,
          subjectId: weatherSimRuntimeId,
          signalId,
          title: signalId,
          valueType: 'number',
          unit: 'count',
        })
        samples.push({ seriesId: id, value, quality: 'good', observedAt: nowIso(), simulationTime: field.at })
      }
      for (const object of objects.values()) {
        const data = weatherPackDataSchema.parse(object.packData)
        if (data.definition.type !== 'weather_probe') continue
        for (const quantity of weatherQuantities) {
          const value = quantity.value(data.sample.state)
          const id = recordingSeriesIdFor(object.id, quantity.id)
          descriptors.push({
            id,
            subjectId: object.id,
            signalId: quantity.id,
            title: quantity.title,
            unit: quantity.unit,
            valueType: typeof value === 'number' ? 'number' : 'string',
          })
          samples.push({
            seriesId: id,
            value,
            quality: 'good',
            observedAt: nowIso(),
            simulationTime: field.at,
            elapsedMs: Math.max(0, time - Date.parse(field.epoch)),
          })
        }
      }
      return { descriptors, samples }
    }
    const project = (recordIds = new Set<string>(), emit = true): void => {
      const events: PackRuntimeEvent[] = []
      for (const object of objects.values()) {
        const data = weatherPackDataSchema.parse(object.packData)
        const coordinates =
          data.definition.type === 'weather_probe'
            ? data.definition.point
            : frameAt(
                { objectId: object.id, label: object.label, area: data.definition, startsAt: data.startsAt },
                field.at,
              ).center
        const point = geoPointFromLonLat(...coordinates)
        const sample = sampleWeather(field, point)
        if (JSON.stringify(data.sample) === JSON.stringify(sample) && !recordIds.has(object.id)) continue
        const updated: OperationalObject = {
          ...object,
          revision: object.revision + 1,
          spatial: { ...object.spatial, position: { point, observedAt: nowIso(), staleAfterMs: 600000 } },
          timestamps: { ...object.timestamps, updatedAt: nowIso() },
          packData: { ...data, sample },
        }
        objects.set(object.id, updated)
        events.push({
          type: 'object.upserted',
          object: updated,
          at: nowIso(),
          provenance: updated.provenance,
          history: recordIds.has(object.id) ? 'record' : 'snapshot-only',
        })
      }
      if (!emit) return
      const batch = recording()
      if (events.length || batch?.samples.length)
        for (const handler of handlers)
          handler({
            type: 'event.emission',
            runtimeId: weatherSimRuntimeId,
            emittedAt: nowIso(),
            events,
            ...(batch ? { recording: batch } : {}),
          })
    }
    project(new Set(), false)
    // Save a fresh field before the run can become restorable.
    if (!restored) await save()
    const targetNow = (): IsoTimestamp => runClock.read().currentTime
    const tick = (): void => {
      if (clock.paused || health.state === 'degraded') return
      try {
        advanceWeather(field, targetNow())
        project()
        if (Date.now() - lastSaved >= 10_000) void save().catch((error) => fail('checkpoint', error))
      } catch (error) {
        fail('advance', error)
      }
    }
    const interval = setInterval(tick, 1000)
    let prepared: { time: string; revision: number; field: WeatherField } | undefined
    const prepareClock = (next: SimulationClockState): WeatherField => {
      if (prepared?.time === next.currentTime && prepared.revision === field.revision) return prepared.field
      const staged = { ...field, cells: new Map(field.cells) }
      advanceWeather(staged, next.currentTime)
      prepared = { time: next.currentTime, revision: field.revision, field: staged }
      return staged
    }
    const sendCommand = async (command: CommandEnvelope): Promise<CommandResult> => {
      const at = nowIso()
      try {
        const schema = weatherCommandSchemas[command.kind as keyof typeof weatherCommandSchemas]
        if (!schema) throw new Error('Unknown Weather command: ' + command.kind)
        schema.parse(command.payload)
        advanceWeather(field, runClock.read().currentTime)
        const candidates = new Map(objects)
        const recordIds = new Set<string>()
        if (command.kind === 'world.weather.intervene-ground') {
          const payload = weatherCommandSchemas['world.weather.intervene-ground'].parse(command.payload)
          const ids = hexCellsForPolygon(payload.area, hexResolution(settings.gridResolution))
          if (!ids.length) throw new Error('Intervention has no resolved ground cell centers')
          interveneGround(field, ids, payload.surface)
        } else if (command.kind === 'world.weather.create') {
          const item = weatherItemSchema.parse(command.payload)
          if (objects.has(item.id)) throw new Error('Weather object already exists: ' + item.id)
          candidates.set(item.id, createWeatherObject(item, field.at, settings, at))
          recordIds.add(item.id)
        } else {
          const payload =
            command.kind === 'world.weather.update'
              ? weatherCommandSchemas['world.weather.update'].parse(command.payload)
              : weatherCommandSchemas['world.weather.set-enabled'].parse(command.payload)
          const id = 'item' in payload ? payload.item.id : payload.objectId
          const object = objects.get(id)
          if (!object) throw new Error('Weather object not found: ' + id)
          if ('item' in payload && object.revision !== payload.expectedRevision)
            throw new Error('Weather revision conflict; inspect the object and retry')
          const data = weatherPackDataSchema.parse(object.packData)
          if (!('item' in payload) && data.definition.type !== 'weather_area')
            throw new Error('Only weather areas can be enabled')
          const definition = 'item' in payload ? payload.item : { ...data.definition, enabled: payload.enabled }
          if (definition.type !== data.definition.type) throw new Error('Weather item type cannot be changed')
          candidates.set(id, {
            ...object,
            label: definition.label,
            packData: { ...data, definition: weatherItemSchema.parse(definition) },
          })
          recordIds.add(id)
        }
        setWeatherObjects(field, [...candidates.values()])
        objects.clear()
        for (const [id, object] of candidates) objects.set(id, object)
        field.revision++
        prepared = undefined
        project(recordIds)
        return { ok: true, commandId: command.id, acceptedAt: at }
      } catch (error) {
        return {
          ok: false,
          commandId: command.id,
          rejectedAt: at,
          reason: error instanceof Error ? error.message : String(error),
        }
      }
    }
    const connection: PackRuntimeConnection = {
      getSnapshot: async () => ({
        simulationRunId: config.simulationRunId,
        objects: [...objects.values()],
        capturedAt: nowIso(),
      }),
      subscribe: (handler) => {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
      sendCommand,
      invokeQuery: async (request) => {
        if (health.state === 'degraded' && request.capabilityId !== 'world.weather.field-stats' && request.capabilityId !== 'world.weather.describe') {
          throw new Error('Weather runtime is degraded: ' + health.lastFailure?.message)
        }
        if (request.capabilityId === weatherObservationDeclarations.capability.id) return weatherObservationDeclarations.answer(request.input, objects, config.recording)
        if (request.capabilityId === weatherObservationRead.capability.id) return weatherObservationRead.answer(request.input, objects)
        return answerWeatherQuery(field, request)
      },
      observeCommittedEvents: async (events) => {
        let changed = false
        for (const event of events) {
          if (event.type === 'object.deleted') changed = objects.delete(event.objectId) || changed
          if (event.type === 'object.upserted' && event.object.packId === 'weather') {
            const previous = objects.get(event.object.id)
            // Ignore echoes of our own projections and stale events.
            if (previous && previous.revision >= event.object.revision) continue
            weatherPackDataSchema.parse(event.object.packData)
            objects.set(event.object.id, event.object)
            changed = true
          }
        }
        if (changed) {
          setWeatherObjects(field, [...objects.values()])
          field.revision++
          prepared = undefined
          project()
        }
      },
      validateClock: async (next) => {
        prepareClock(next)
      },
      setClock: async (next) => {
        field = prepareClock(next)
        prepared = undefined
        clock = next
        localClock?.set(next)
        health = { ...health, state: 'ready', lastSuccessfulInteractionAt: nowIso() }
        project()
      },
      advanceTo: async (next) => {
        field = prepareClock(next)
        prepared = undefined
        clock = next
        localClock?.set(next)
        project()
      },
      checkpoint: save,
      health: () => [health],
      close: async () => {
        clearInterval(interval)
        handlers.clear()
        await save()
      },
    }
    return connection
  },
})
