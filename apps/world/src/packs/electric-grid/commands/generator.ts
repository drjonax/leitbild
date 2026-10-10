import { z } from 'zod'
import type { SimulationCapability } from '../../../simulation/protocol.ts'
import { assetPayload, gridCommandCapability } from './capability.ts'

export const gridDispatchGeneratorCommandKind = 'world.electric-grid.dispatch-generator'
export const gridTripGeneratorCommandKind = 'world.electric-grid.trip-generator'
export const gridSetGeneratorAvailabilityCommandKind = 'world.electric-grid.set-generator-availability'
export const gridResetGeneratorTripCommandKind = 'world.electric-grid.reset-generator-trip'
export const gridStartGeneratorCommandKind = 'world.electric-grid.start-generator'
export const gridStopGeneratorCommandKind = 'world.electric-grid.stop-generator'

export const gridDispatchGeneratorPayloadSchema = assetPayload.extend({ targetMw: z.number().finite().nonnegative() }).strict()
export const gridTripGeneratorPayloadSchema = assetPayload
export const gridSetGeneratorAvailabilityPayloadSchema = assetPayload.extend({ availableMw: z.number().finite().nonnegative() }).strict()
export const gridResetGeneratorTripPayloadSchema = assetPayload
export const gridStartGeneratorPayloadSchema = assetPayload
export const gridStopGeneratorPayloadSchema = assetPayload

const generatorTerms = ['generator', 'unit', 'power plant', 'kraftverk', 'aggregat', 'produksjon', 'generation']

export const gridGeneratorCommandCapabilities: ReadonlyArray<SimulationCapability> = [
  gridCommandCapability({
    id: gridDispatchGeneratorCommandKind,
    title: 'Dispatch generator',
    description: 'Sets the active-power dispatch target (MW) of an online generator. The target must lie between the unit\'s minimum stable generation and its available capacity; the unit ramps to it at its ramp rate and primary frequency response acts around it.',
    payloadSchema: gridDispatchGeneratorPayloadSchema,
    risk: 'write',
    searchTerms: [...generatorTerms, 'dispatch', 'redispatch', 'set-point', 'setpoint', 'balancing', 'settpunkt', 'kjøreplan', 'regulering', 'oppregulering', 'nedregulering', 'balansering'],
  }),
  gridCommandCapability({
    id: gridTripGeneratorCommandKind,
    title: 'Trip generator',
    description: 'Trips a starting, online, or stopping generator: its breaker opens at once, its output and reserve drop to 0 MW, and it stays tripped until reset-generator-trip.',
    payloadSchema: gridTripGeneratorPayloadSchema,
    risk: 'destructive',
    searchTerms: [...generatorTerms, 'trip', 'unit trip', 'forced outage', 'loss of generation', 'frequency event', 'utfall', 'aggregatutfall', 'produksjonsutfall', 'utkobling', 'effektbryter', 'frekvens'],
  }),
  gridCommandCapability({
    id: gridSetGeneratorAvailabilityCommandKind,
    title: 'Set generator availability',
    description: 'Sets the available capacity (MW, 0 to installed capacity) without changing the lifecycle state. A starting or online unit must keep at least its minimum stable generation; lowering availability below the dispatch target lowers the target to the new availability.',
    payloadSchema: gridSetGeneratorAvailabilityPayloadSchema,
    risk: 'write',
    searchTerms: [...generatorTerms, 'availability', 'derate', 'capacity', 'partial outage', 'tilgjengelighet', 'tilgjengelig effekt', 'kapasitet', 'begrensning'],
  }),
  gridCommandCapability({
    id: gridResetGeneratorTripCommandKind,
    title: 'Reset generator trip',
    description: 'Resets a tripped generator to offline so it can be started again. It does not start the unit.',
    payloadSchema: gridResetGeneratorTripPayloadSchema,
    risk: 'write',
    searchTerms: [...generatorTerms, 'reset', 'trip reset', 'restoration', 'tilbakestill', 'kvitter', 'gjenoppretting'],
  }),
  gridCommandCapability({
    id: gridStartGeneratorCommandKind,
    title: 'Start generator',
    description: 'Starts an offline generator. It synchronises after the start-up time of its kind, then loads at its ramp rate to its minimum stable generation; raise it further with dispatch-generator. Requires available capacity of at least the minimum stable generation.',
    payloadSchema: gridStartGeneratorPayloadSchema,
    risk: 'write',
    searchTerms: [...generatorTerms, 'start', 'start-up', 'unit commitment', 'synchronise', 'reserve', 'mFRR', 'restoration', 'oppstart', 'start aggregat', 'synkronisering', 'innfasing', 'gjenoppretting'],
  }),
  gridCommandCapability({
    id: gridStopGeneratorCommandKind,
    title: 'Stop generator',
    description: 'Stops a generator in a controlled way: an online unit unloads at its ramp rate and goes offline at 0 MW; a starting unit abandons its start and goes offline.',
    payloadSchema: gridStopGeneratorPayloadSchema,
    risk: 'write',
    searchTerms: [...generatorTerms, 'stop', 'shutdown', 'decommit', 'unload', 'stans', 'stopp', 'nedkjøring', 'utfasing'],
  }),
]
