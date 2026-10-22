import { z } from 'zod'
import { processVariableValueSchema, variablePathSchema } from '../graph/index.ts'
import {
  expireProposals,
  operationOriginSchema,
  processPlantProposalSchema,
  supersedeByCommand,
  type ProcessPlantProposalBook,
  type ProposalClock,
  type ProposalTransition,
} from './proposals.ts'

// What people and AI agents did to a Plant, and what they propose: the
// commands they issued that it accepted (who, when, what it wrote, and the
// proposal an approval executed), and its proposal book. This is the Pack's
// runtime-private index for displays (the operations log view, the element
// pop-over's PROPOSAL section); the Run's durable events stay the record. It
// persists with the Plant's runtime state as an optional field, written only
// while it holds something (plan-final O-D4): a state without it has none.

/** Accepted commands the log keeps, newest last. */
export const OPERATIONS_KEPT = 64

export const operationRecordSchema = z.object({
  commandId: z.string().min(1),
  path: variablePathSchema,
  value: processVariableValueSchema,
  origin: operationOriginSchema,
  actorId: z.string().min(1),
  /** Plant time it was accepted at. */
  elapsedMs: z.number().finite().nonnegative(),
  /** A write, a ramp (to its target), or a person's approval that executed a proposal's write. */
  kind: z.enum(['write', 'ramp', 'approval']),
  proposalId: z.string().min(1).optional(),
  /**
   * The standing protection actuations it throttles: they drove its demand
   * to an end of its span and it sets a value between (command-guard.ts
   * throttledUnder); absent for any other command.
   */
  throttledUnder: z.array(z.object({ ruleId: z.string().min(1), label: z.string().min(1), action: z.string().min(1) }).strict()).min(1).optional(),
}).strict()

export type OperationRecord = z.infer<typeof operationRecordSchema>

/** A person's reset of a latched actuation (actuation-reset.ts), as they executed it or approved it from a proposal. */
export const resetRecordSchema = z.object({
  commandId: z.string().min(1),
  kind: z.literal('reset'),
  ruleId: z.string().min(1),
  label: z.string().min(1),
  /** The commands its effects wrote, whose QA-2 hold the reset lifted. */
  holds: z.array(variablePathSchema),
  origin: operationOriginSchema,
  actorId: z.string().min(1),
  elapsedMs: z.number().finite().nonnegative(),
  proposalId: z.string().min(1).optional(),
}).strict()

export type ResetRecord = z.infer<typeof resetRecordSchema>

export const plantOperationsStateSchema = z.object({
  log: z.array(operationRecordSchema).max(OPERATIONS_KEPT),
  proposals: z.array(processPlantProposalSchema),
  /** The actuation resets people executed, newest last; absent while there are none. */
  resets: z.array(resetRecordSchema).max(OPERATIONS_KEPT).optional(),
}).strict()
export type PlantOperationsState = z.infer<typeof plantOperationsStateSchema>

export interface PlantOperations {
  readonly log: () => ReadonlyArray<OperationRecord>
  readonly resets: () => ReadonlyArray<ResetRecord>
  readonly book: () => ProcessPlantProposalBook
  /** Takes the book a proposal transition left (proposals.ts). */
  readonly setBook: (book: ProcessPlantProposalBook) => void
  /**
   * Logs an accepted command of a person's or an AI agent's. A write or ramp
   * supersedes what was proposed for the same equipment; an approval already
   * closed its proposal and the others on it.
   */
  readonly record: (record: OperationRecord, at: ProposalClock) => ReadonlyArray<ProposalTransition>
  /** Logs a person's actuation reset; executed directly, it supersedes what was proposed for the same actuation. */
  readonly recordReset: (record: ResetRecord, at: ProposalClock) => ReadonlyArray<ProposalTransition>
  /** Lapses the proposals whose time is up. */
  readonly expire: (at: ProposalClock) => ReadonlyArray<ProposalTransition>
  /** What to persist; undefined while it holds nothing. */
  readonly snapshot: () => PlantOperationsState | undefined
}

export const createPlantOperations = (restored?: PlantOperationsState): PlantOperations => {
  const parsed = restored === undefined ? undefined : plantOperationsStateSchema.parse(restored)
  let log: ReadonlyArray<OperationRecord> = parsed?.log ?? []
  let resets: ReadonlyArray<ResetRecord> = parsed?.resets ?? []
  let book: ProcessPlantProposalBook = { proposals: parsed?.proposals ?? [] }
  return {
    log: () => log,
    resets: () => resets,
    book: () => book,
    setBook: next => { book = next },
    record: (record, at) => {
      log = [...log, operationRecordSchema.parse(record)].slice(-OPERATIONS_KEPT)
      if (record.kind === 'approval') return []
      const step = supersedeByCommand(book, { path: record.path, commandId: record.commandId, actorId: record.actorId, at })
      book = step.book
      return step.transitions
    },
    recordReset: (record, at) => {
      resets = [...resets, resetRecordSchema.parse(record)].slice(-OPERATIONS_KEPT)
      if (record.proposalId !== undefined) return []
      const step = supersedeByCommand(book, { ruleId: record.ruleId, commandId: record.commandId, actorId: record.actorId, at })
      book = step.book
      return step.transitions
    },
    expire: at => {
      const step = expireProposals(book, at)
      book = step.book
      return step.transitions
    },
    snapshot: () => log.length === 0 && book.proposals.length === 0 && resets.length === 0 ? undefined
      : { log: [...log], proposals: [...book.proposals], ...(resets.length === 0 ? {} : { resets: [...resets] }) },
  }
}
