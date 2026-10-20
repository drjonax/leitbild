// Writes expected.json from the drawings as the code draws them now:
// `bun tests/fixtures/diagram-parity/write-expected.ts` in apps/world. Only a
// commit that changes drawings on purpose rewrites it, and says which and why.
import { writeFileSync } from 'node:fs'
import { parityCases } from './cases.ts'

const records = parityCases().map(entry => [entry.key, entry.record()] as const)
const lines = records.map(([key, record], index) => `  ${JSON.stringify(key)}: ${JSON.stringify(record)}${index < records.length - 1 ? ',' : ''}`)
writeFileSync(new URL('./expected.json', import.meta.url), `{\n${lines.join('\n')}\n}\n`)
console.log(`${records.length} drawings recorded`)
