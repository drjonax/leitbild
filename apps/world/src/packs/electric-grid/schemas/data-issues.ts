import type { z } from 'zod'

export interface GridDataIssue {
  readonly path: ReadonlyArray<PropertyKey>
  readonly message: string
}

/** `['buses', 3, 'priceArea']` → `$.buses[3].priceArea`. */
export const formatJsonPath = (path: ReadonlyArray<PropertyKey>): string =>
  `$${path.map(segment => typeof segment === 'number' ? `[${segment}]` : `.${String(segment)}`).join('')}`

const reportedIssueLimit = 20

/** One error naming the data source and the JSON path of every issue. */
export const gridDataError = (source: string, subject: string, issues: ReadonlyArray<GridDataIssue>): Error => {
  const lines = issues.slice(0, reportedIssueLimit).map(issue => `  ${formatJsonPath(issue.path)}: ${issue.message}`)
  const more = issues.length > reportedIssueLimit ? [`  … ${issues.length - reportedIssueLimit} more`] : []
  return new Error([`${source}: invalid ${subject}`, ...lines, ...more].join('\n'))
}

export const parseGridData = <Schema extends z.ZodType>(schema: Schema, json: unknown, source: string, subject: string): z.infer<Schema> => {
  const parsed = schema.safeParse(json)
  if (!parsed.success) throw gridDataError(source, subject, parsed.error.issues)
  return parsed.data
}
