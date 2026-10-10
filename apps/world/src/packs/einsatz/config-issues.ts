import type { EinsatzConfig } from './config-schema.ts'
import type { ConfigurationRefusalCode } from './refusal.ts'

export type ConfigPath = ReadonlyArray<string | number>

/** One reason a configuration cannot run as written, at its path from the config root. */
export interface ConfigIssue {
  readonly path: ConfigPath
  readonly code: ConfigurationRefusalCode
  readonly message: string
}

/** A check reports every issue it finds; it never stops at the first. */
export type ConfigCheck = (config: EinsatzConfig) => ReadonlyArray<ConfigIssue>

export const configIssue = (path: ConfigPath, code: ConfigurationRefusalCode, message: string): ConfigIssue => ({ path, code, message })

export const listItem = (base: ConfigPath) => (index: number): ConfigPath => [...base, index]

/** Each repeat of a value after its first occurrence. */
export const repeatedValues = (
  values: ReadonlyArray<string>,
  pathOf: (index: number) => ConfigPath,
  what: string,
  code: ConfigurationRefusalCode = 'duplicate_id',
): ConfigIssue[] => {
  const seen = new Set<string>()
  return values.flatMap((value, index) => {
    if (!seen.has(value)) {
      seen.add(value)
      return []
    }
    return [configIssue(pathOf(index), code, `${what} "${value}" appears more than once`)]
  })
}

/** Each value missing from the declared set. */
export const undeclaredValues = (
  values: ReadonlyArray<string>,
  declared: ReadonlySet<string>,
  base: ConfigPath,
  code: ConfigurationRefusalCode,
  message: (value: string) => string,
): ConfigIssue[] => values.flatMap((value, index) => declared.has(value) ? [] : [configIssue([...base, index], code, message(value))])
