// Reads weather observables at the object's sample time (N5). A value takes the priority of its most urgent
// active advisory (R42, T05); without one it is not coloured.
import { priorityLevels, refObjectId } from '../../../core/model/alerts.ts'
import { defineObservationCapability, observationShapes } from '../../../core/observation/capabilities.ts'
import type { Observation } from '../../../core/observation/model.ts'
import { weatherQuantities } from '../quantities.ts'
import { weatherObjectData, type WeatherObjects } from './declarations.ts'

/** The values after the advised ones, by their declared lead rank. */
const leadOrder = weatherQuantities.filter(quantity => quantity.lead !== undefined).sort((left, right) => left.lead! - right.lead!).map(quantity => quantity.id)

const observe = (objects: WeatherObjects, objectId: string, quantityId: string): Observation | undefined => {
  const quantity = weatherQuantities.find(candidate => candidate.id === quantityId)
  if (quantity === undefined || !objects.has(objectId)) return undefined
  const { sample } = weatherObjectData(objects, objectId)
  const ref = `${objectId}#${quantity.id}`
  const priority = objects.get(objectId)!.alerts.flatMap(alert => (alert.observable === ref && alert.priority !== undefined ? [alert.priority] : []))
    .reduce<Observation['priority']>((worst, next) => (priorityLevels.indexOf(next) > priorityLevels.indexOf(worst) ? next : worst), 'none')
  return { ref, value: quantity.value(sample.state), quality: 'good', priority, at: sample.quality.validAt, clock: 'simulation' }
}

export const weatherObservationRead = {
  capability: defineObservationCapability('read', {
    id: 'world.weather.observation.read', title: 'Read weather observations', description: 'World-internal: weather values by ref, and a probe\'s or area\'s lead values.',
  }),
  answer: (rawInput: unknown, objects: WeatherObjects) => {
    const input = observationShapes.read.input.parse(rawInput)
    const answers = input.refs.map(ref => ({ ref, observation: observe(objects, refObjectId(ref), ref.slice(ref.indexOf('#') + 1)) }))
    const observations = answers.flatMap(answer => answer.observation ?? [])
    // The lead in the same call: the advised values, then the rest by declared rank; those not already read appended.
    const led = input.lead === undefined ? undefined : (() => {
      const { objectId, count } = input.lead
      weatherObjectData(objects, objectId)
      const advised = weatherQuantities.filter(quantity => observe(objects, objectId, quantity.id)?.priority !== 'none').map(quantity => quantity.id)
      return [...new Set([...advised, ...leadOrder])].slice(0, count).map(id => observe(objects, objectId, id)!)
    })()
    const asked = new Set(observations.map(observation => observation.ref))
    return {
      observations: [...observations, ...(led ?? []).filter(observation => !asked.has(observation.ref))],
      unknown: answers.filter(answer => answer.observation === undefined).map(answer => answer.ref),
      ...(led === undefined ? {} : { lead: led.map(observation => observation.ref) }),
    }
  },
}
