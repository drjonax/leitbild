import { sharedScreeningRecords, type ContingencySnapshot, type ScreeningRecords } from './contingency-snapshot.ts'
import { screenContingencyRange } from './contingency.ts'

/** Screens every contingency of the snapshot on the calling thread. */
export const screenRecordsInline = (snapshot: ContingencySnapshot): ScreeningRecords => {
  const records = sharedScreeningRecords(snapshot.contingencies.count)
  screenContingencyRange(snapshot, records, 0, records.count)
  return records
}
