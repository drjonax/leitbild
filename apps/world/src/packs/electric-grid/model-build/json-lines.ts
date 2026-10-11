// Serialises generated JSON with one array element per line: compact files whose diffs show one
// changed asset per line. Object keys keep their insertion order, so output is deterministic.

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const render = (value: unknown, indent: string, depth: number): string => {
  if (depth === 0 && Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return `[\n${value.map(item => `${indent}  ${JSON.stringify(item)}`).join(',\n')}\n${indent}]`
  }
  if (depth > 0 && isPlainObject(value)) {
    const entries = Object.entries(value).filter(([, entry]) => entry !== undefined)
    if (entries.length === 0) return '{}'
    return `{\n${entries.map(([key, entry]) => `${indent}  ${JSON.stringify(key)}: ${render(entry, `${indent}  `, depth - 1)}`).join(',\n')}\n${indent}}`
  }
  if (depth > 0 && Array.isArray(value)) return render(value, indent, 0)
  return JSON.stringify(value)
}

/** `depth` object levels are expanded; arrays at the last level print one element per line. */
export const jsonLines = (value: unknown, depth = 1): string => `${render(value, '', depth)}\n`
