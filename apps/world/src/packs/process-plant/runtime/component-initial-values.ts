import type { CompiledComponent, VariablePath } from '../graph/index.ts'
import type { ProcessPlantValue } from './model.ts'
import { balanceOfPlantInitialValueDefinitions } from './initializers/balance-of-plant-initializers.ts'
import { electricalInitialValueDefinitions } from './initializers/electrical-initializers.ts'
import { instrumentationInitialValueDefinitions } from './initializers/instrumentation-initializers.ts'
import { junctionInitialValueDefinitions } from './initializers/junction-initializers.ts'
import type { ComponentInitialValueDefinition } from './initializers/model.ts'
import { pressurizerInitialValueDefinitions } from './initializers/pressurizer-initializers.ts'
import { reactorInitialValueDefinitions } from './initializers/reactor-initializers.ts'
import { steamGeneratorInitialValueDefinitions } from './initializers/steam-generator-initializers.ts'
import { supportSystemInitialValueDefinitions } from './initializers/support-system-initializers.ts'

export const componentInitialValueDefinitions: ReadonlyArray<ComponentInitialValueDefinition> = [
  ...reactorInitialValueDefinitions,
  ...steamGeneratorInitialValueDefinitions,
  ...pressurizerInitialValueDefinitions,
  ...junctionInitialValueDefinitions,
  ...balanceOfPlantInitialValueDefinitions,
  ...supportSystemInitialValueDefinitions,
  ...electricalInitialValueDefinitions,
  ...instrumentationInitialValueDefinitions,
]

const definitionByComponentKind = new Map(componentInitialValueDefinitions.map(definition => [definition.componentKind, definition]))

export const initialComponentValueFor = (component: CompiledComponent, path: VariablePath): ProcessPlantValue => {
  const localPath = String(path).slice(String(component.id).length + 1)
  const definition = definitionByComponentKind.get(String(component.kind))
  if (!definition) throw new Error(`component ${component.id} kind ${component.kind} has no runtime initializer`)
  const value = definition.initialValueFor(component, localPath, path)
  if (value === undefined) throw new Error(`component ${component.id} has no runtime initializer for variable ${path}`)
  return value
}
