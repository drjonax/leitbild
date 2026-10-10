import rawPwrReferenceTemplate from './pwr-reference-template.graph.json'
import { plantGraphSpecSchema } from '../graph/index.ts'

// A link variable the template leaves unlabelled is named, the same way for
// every link, by what operators call the link's two ends and what the
// variable measures: "Safety Accumulator A to cold leg A boron concentration",
// never by the link's id. An end at a reactor loop leg is named by the leg,
// any other by its component's label (not its presentation short label, which
// is no part of the Plant's identity).

const measuredBy: Readonly<Record<string, string>> = {
  flowKgPerS: 'flow',
  temperatureC: 'temperature',
  pressureMPa: 'pressure',
  pressureDropMPa: 'pressure drop',
  'leak.areaFraction': 'leak area',
  leakFlowKgPerS: 'leak flow',
  // The reference PWR's coolant solute is its boron.
  soluteConcentrationPpm: 'boron concentration',
}

const loopLegPort = /^(hot|cold)Leg([A-Z])$/u

interface RawTemplate {
  readonly components: ReadonlyArray<{ readonly id: string; readonly label?: string }>
  readonly connections: ReadonlyArray<{ readonly id: string; readonly from: string; readonly to: string; readonly variables?: ReadonlyArray<{ readonly path: string; readonly label?: string }> }>
}

const endName = (template: RawTemplate, ref: string, linkId: string): string => {
  const separator = ref.lastIndexOf('.')
  const leg = loopLegPort.exec(ref.slice(separator + 1))
  if (leg !== null) return `${leg[1]} leg ${leg[2]}`
  const label = template.components.find(component => component.id === ref.slice(0, separator))?.label
  if (label === undefined) throw new Error(`PWR template link ${linkId} ends at ${ref}, which names no labelled component`)
  return label
}

const withGeneratedLinkLabels = (template: RawTemplate): RawTemplate => ({
  ...template,
  connections: template.connections.map(connection => ({
    ...connection,
    variables: (connection.variables ?? []).map(variable => {
      if (variable.label !== undefined) return variable
      const measured = measuredBy[variable.path]
      if (measured === undefined) throw new Error(`PWR template link ${connection.id} variable ${variable.path} has no label and no generated one`)
      const name = `${endName(template, connection.from, connection.id)} to ${endName(template, connection.to, connection.id)} ${measured}`
      return { ...variable, label: `${name.charAt(0).toUpperCase()}${name.slice(1)}` }
    }),
  })),
})

export const pwrReferenceTemplate = plantGraphSpecSchema.parse(withGeneratedLinkLabels(rawPwrReferenceTemplate as RawTemplate))
