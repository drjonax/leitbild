import { readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gridAutomationSchema, type GridAutomation } from './schemas/grid-automation.ts'

export const gridAutomationPresetIdPrefix = 'electric-grid.frequency.'

const directory = join(dirname(fileURLToPath(import.meta.url)), 'automations')

/** Frequency-control Automation presets, one validated JSON file per preset named after its id. */
export const gridAutomationPresets: ReadonlyMap<string, GridAutomation> = new Map(readdirSync(directory)
  .filter(name => name.endsWith('.json')).sort()
  .map(name => {
    const preset = gridAutomationSchema.parse(JSON.parse(readFileSync(join(directory, name), 'utf8')) as unknown)
    const expectedId = `${gridAutomationPresetIdPrefix}${basename(name, '.json')}`
    if (preset.id !== expectedId) throw new Error(`Automation preset ${name} must have id ${expectedId}, found ${preset.id}`)
    return [preset.id, preset] as const
  }))

export const gridAutomationPreset = (id: string): GridAutomation => {
  const preset = gridAutomationPresets.get(id)
  if (!preset) throw new Error(`unknown grid Automation preset ${id}`)
  return preset
}
