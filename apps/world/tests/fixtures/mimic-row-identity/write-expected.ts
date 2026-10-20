// Writes expected.json from what the code binds and writes now:
// `bun tests/fixtures/mimic-row-identity/write-expected.ts` in apps/world. Only
// a commit that changes rows on purpose rewrites it, and says which and why.
import { writeFileSync } from 'node:fs'
import { rowCases } from './cases.ts'

const records = rowCases().map(entry => [entry.key, entry.record()] as const)
const lines = records.map(([key, record], index) => `  ${JSON.stringify(key)}: ${JSON.stringify(record)}${index < records.length - 1 ? ',' : ''}`)
writeFileSync(new URL('./expected.json', import.meta.url), `{\n${lines.join('\n')}\n}\n`)
console.log(`${records.length} cases recorded`)
