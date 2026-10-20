import { z } from 'zod'
import { commandResultSchema, objectIdSchema } from '../../core/model/index.ts'
import {
  defineSimulationCommandCapability,
  defineSimulationQueryCapability,
} from '../../simulation/capabilities.ts'
import {
  processPlantActionInvokeCommandKind,
  processPlantActionInvokePayloadSchema,
  processPlantActuationResetCommandKind,
  processPlantActuationResetPayloadSchema,
  processPlantControlDecideCommandKind,
  processPlantControlDecidePayloadSchema,
  processPlantControlProposeCommandKind,
  processPlantControlProposePayloadSchema,
  processPlantControlRampCommandKind,
  processPlantControlRampPayloadSchema,
  processPlantControlWriteCommandKind,
  processPlantControlWritePayloadSchema,
  processPlantIcLifecycleCommandKind,
  processPlantIcLifecyclePayloadSchema,
} from './commands.ts'
import { processPlantIcCatalogQuerySchema, processPlantIcQueryKinds } from './ic-query.ts'
import { operationRecordSchema, resetRecordSchema } from './operations/plant-operations.ts'
import { processPlantProposalSchema } from './operations/proposals.ts'
import { operationConsequenceSchema } from './operations/consequence.ts'
import { processPlantRampSchema } from './runtime/index.ts'
import { processPlantQueryKinds } from './query.ts'
import { processPlantActions } from './actions.ts'
import { processPlantActionsSearchInputSchema, processPlantCatalogInputSchema } from './queries/catalog-query.ts'
import {
  assessmentsEvaluateQuerySchema,
  conditionsEvaluateQuerySchema,
  controlProposalsQuerySchema,
  controlsListQuerySchema,
  procedureConditionEvaluateQuerySchema,
} from './queries/control-query.ts'
import {
  credibilityListPayloadSchema,
  credibilityReadPayloadSchema,
} from './queries/credibility-query.ts'
import { embeddedViewContentSchema, embeddedViewPublicationSchema } from '@leitbild/contracts'
import {
  displayComposeQuerySchema,
  displayOverviewQuerySchema,
  displaySampleQuerySchema,
  displayViewQuerySchema,
} from './queries/composed-display-query.ts'
import { artifactReadQuerySchema, componentsSearchQuerySchema } from './queries/graph-query.ts'
import { graphReadQuerySchema, graphReadResultSchema } from './queries/graph-read.ts'
import { plantQuerySchema } from './queries/common.ts'
import {
  procedureTagsValidateQuerySchema,
  signalsReadQuerySchema,
  signalsResolveQuerySchema,
  signalsSearchQuerySchema,
} from './queries/signal-query.ts'
import { variablesReadQuerySchema, variablesSearchQuerySchema } from './queries/variable-query.ts'

const recordSchema = z.record(z.string(), z.json())
const recordArraySchema = z.array(recordSchema)
const plantIdSchema = z.string().min(1)
const pagedPlantRecordsSchema = (collectionField: string, itemField: string) => z.object({
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  [collectionField]: z.array(z.object({ plantId: plantIdSchema, [itemField]: recordSchema }).strict()),
}).strict()

const selectiveArtifactShape = {
  plantId: plantIdSchema,
  artifact: z.enum(['authored-spec', 'compiled-graph-mermaid']),
  metadata: recordSchema,
  coverage: z.string(),
}

const queryOutputById: Readonly<Record<string, z.ZodType>> = {
  'world.process-plant.catalog.list': z.object({
    models: recordArraySchema,
    operatingPoints: recordArraySchema,
    automations: recordArraySchema,
    actions: recordArraySchema,
    assessments: recordArraySchema,
    recordingProfiles: recordArraySchema,
    credibilityEvidence: recordArraySchema,
  }).strict(),
  'world.process-plant.actions.search': z.object({
    total: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative(),
    hasMore: z.boolean(),
    actions: recordArraySchema,
  }).strict(),
  'world.process-plant.credibility.list': z.object({ plantId: plantIdSchema, evidence: recordArraySchema }).strict(),
  'world.process-plant.credibility.read': z.object({
    plantId: plantIdSchema,
    evidence: recordSchema,
    artifact: recordSchema,
    content: z.string(),
  }).strict(),
  'world.process-plant.plants.list': z.object({
    plants: z.array(z.object({
      id: plantIdSchema,
      label: z.string().min(1),
      model: z.object({ id: z.string().min(1), title: z.string().min(1) }).strict(),
      modelRef: z.string().min(1),
      modelDigest: z.string().regex(/^[a-f0-9]{64}$/),
      componentCount: z.number().int().nonnegative(),
      linkCount: z.number().int().nonnegative(),
      variableCount: z.number().int().nonnegative(),
      services: z.array(z.string().min(1)),
      loops: z.array(z.string().min(1)),
      elapsedMs: z.number().nonnegative(),
    }).strict()),
  }).strict(),
  'world.process-plant.graph.read': graphReadResultSchema,
  'world.process-plant.components.search': z.object({
    plantId: plantIdSchema,
    specification: recordSchema,
    totalComponents: z.number().int().nonnegative(),
    matchedComponents: z.number().int().nonnegative(),
    byKind: z.record(z.string(), z.number().int().nonnegative()),
    components: recordArraySchema,
  }).strict(),
  'world.process-plant.artifact.read': z.union([z.object({
    plantId: plantIdSchema,
    artifact: z.enum(['authored-spec', 'compiled-graph-mermaid']),
    title: z.string(),
    language: z.enum(['json', 'mermaid']),
    content: z.string(),
    components: recordArraySchema,
    sourceFiles: recordArraySchema,
    metadata: recordSchema,
  }).strict(),
  z.object({
    ...selectiveArtifactShape, mode: z.literal('index'),
    total: z.number().int().nonnegative(), offset: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative(), hasMore: z.boolean(),
    components: recordArraySchema, sourceFiles: recordArraySchema,
  }).strict(),
  z.object({ ...selectiveArtifactShape, mode: z.literal('component'), component: recordSchema, authoredComponent: recordSchema }).strict(),
  z.object({
    ...selectiveArtifactShape, mode: z.literal('source'), sourcePath: z.string(), sha256: z.string(),
    totalLines: z.number().int().nonnegative(), byteCount: z.number().int().nonnegative(),
    startLine: z.number().int().positive(), endLine: z.number().int().nonnegative(),
    returnedLines: z.number().int().nonnegative(), content: z.string(), hasMore: z.boolean(),
    nextRead: recordSchema.nullable(),
  }).strict()]),
  'world.process-plant.variables.read': z.object({ variables: recordArraySchema }).strict(),
  'world.process-plant.variables.search': pagedPlantRecordsSchema('variables', 'variable'),
  'world.process-plant.signals.resolve': z.object({ plantId: plantIdSchema, signals: recordArraySchema }).strict(),
  'world.process-plant.signals.read': z.object({ plantId: plantIdSchema, signals: recordArraySchema }).strict(),
  'world.process-plant.signals.search': pagedPlantRecordsSchema('signals', 'signal'),
  'world.process-plant.procedure-tags.validate': z.object({ plantId: plantIdSchema, tags: recordArraySchema }).strict(),
  'world.process-plant.conditions.evaluate': z.object({ plantId: plantIdSchema, matches: z.boolean(), signalsRead: recordArraySchema }).strict(),
  'world.process-plant.procedure-condition.evaluate': z.object({
    targetObjectId: objectIdSchema,
    status: z.enum(['satisfied', 'challenged', 'unknown']),
    reason: z.string().optional(),
    modelRef: z.string().min(1),
    modelDigest: z.string().regex(/^[a-f0-9]{64}$/),
    simTimeMs: z.number().nonnegative(),
    basis: recordSchema,
    automaticCsfQualified: z.literal(false),
    evidence: recordArraySchema,
  }).strict(),
  'world.process-plant.assessments.evaluate': z.object({ plantId: plantIdSchema, assessments: recordArraySchema }).strict(),
  'world.process-plant.control.validate': z.object({
    accepted: z.boolean(),
    reason: z.string().optional(),
    signal: recordSchema,
    targetPath: z.string(),
    currentValue: z.union([z.number(), z.boolean()]),
  }).strict(),
  'world.process-plant.control.proposals': z.object({
    plantId: plantIdSchema,
    plantElapsedMs: z.number(),
    proposals: z.array(z.object({
      proposal: processPlantProposalSchema,
      review: z.object({
        permitted: z.boolean(),
        refusal: z.string().optional(),
        evidence: z.array(z.object({ tagId: z.string(), then: z.union([z.number(), z.boolean()]), now: z.union([z.number(), z.boolean()]) }).strict()),
        changed: z.boolean(),
      }).strict().optional(),
    }).strict()),
  }).strict(),
  'world.process-plant.controls.list': z.object({ plantId: plantIdSchema, plantElapsedMs: z.number(), items: recordArraySchema, resets: recordArraySchema }).strict(),
  'world.process-plant.runtime.status': z.object({
    active: z.boolean(),
    plantCount: z.number().int().nonnegative(),
    plants: recordArraySchema,
  }).strict(),
  'world.process-plant.transient.diagnostics': z.object({ plantId: plantIdSchema, diagnostics: recordSchema, ic: recordSchema }).strict(),
  'world.process-plant.ic.status': z.object({ plantId: plantIdSchema, ic: recordSchema }).strict(),
  'world.process-plant.ic.catalog': z.object({
    plantId: plantIdSchema,
    ruleCount: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative(),
    hasMore: z.boolean(),
    rules: recordArraySchema,
  }).strict(),
  'world.process-plant.alarms.status': z.object({ plantId: plantIdSchema, alarms: recordArraySchema, trips: recordArraySchema, summary: recordSchema }).strict(),
  'world.process-plant.alarms.summary': z.object({ plantId: plantIdSchema, summary: recordSchema }).strict(),
  'world.process-plant.alarms.history': z.object({ plantId: plantIdSchema, history: recordArraySchema }).strict(),
  'world.process-plant.display.compose': z.object({
    plantId: plantIdSchema,
    issuedAt: z.string(),
    simulationClock: z.string(),
    view: embeddedViewPublicationSchema,
    signals: z.array(z.object({ ref: z.string(), tagId: z.string().optional(), path: z.string(), label: z.string(), name: z.string(), unit: z.string() }).strict()),
    shows: z.array(z.string()),
    margins: z.array(z.string()),
    warnings: z.array(z.string()),
    equipment: z.array(z.object({ id: z.string(), label: z.string(), state: z.string() }).strict()),
    viewContent: embeddedViewContentSchema,
  }).strict(),
  'world.process-plant.display.overview': z.object({
    plantId: plantIdSchema,
    view: embeddedViewPublicationSchema,
    simulationClock: z.string(),
    shows: z.array(z.string()),
    equipment: z.array(z.object({ id: z.string(), label: z.string(), state: z.string() }).strict()),
  }).strict(),
  'world.process-plant.display.view': z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('advice'),
      plantId: plantIdSchema,
      plantLabel: z.string().nullable(),
      issuedAt: z.string(),
      simulationTime: z.string(),
      modelChanged: z.boolean(),
      drawingChanged: z.boolean(),
      display: recordSchema,
    }).strict(),
    z.object({
      kind: z.literal('overview'),
      plantId: plantIdSchema,
      plantLabel: z.string().nullable(),
      simulationTime: z.string(),
      display: recordSchema,
    }).strict(),
    z.object({
      kind: z.literal('detail'),
      plantId: plantIdSchema,
      plantLabel: z.string().nullable(),
      simulationTime: z.string(),
      display: recordSchema,
    }).strict(),
  ]),
  'world.process-plant.display.sample': z.object({
    plantId: plantIdSchema,
    simulationTime: z.string(),
    plantElapsedMs: z.number(),
    mode: z.object({ id: z.string(), label: z.string() }).strict().nullable().optional(),
    safetyFunctions: z.array(z.object({
      id: z.string(),
      label: z.string(),
      shortLabel: z.string(),
      status: z.enum(['green', 'yellow', 'orange', 'red', 'unknown', 'not-monitored']),
      procedure: z.string().optional(),
      text: z.string(),
      opens: z.array(z.string()).min(1).optional(),
    }).strict()).optional(),
    alarms: z.array(z.object({
      id: z.string(),
      ruleId: z.string(),
      kind: z.enum(['alarm', 'trip']),
      title: z.string(),
      severity: z.enum(['info', 'notice', 'warning', 'critical']),
      active: z.boolean(),
      acknowledged: z.boolean(),
      latched: z.boolean(), conditionActive: z.boolean(),
      firstOut: z.boolean(),
      firstActiveElapsedMs: z.number().optional(),
    }).strict()).optional(),
    operations: z.object({
      log: z.array(operationRecordSchema),
      ramps: z.array(processPlantRampSchema),
      proposals: z.array(processPlantProposalSchema),
      resets: z.array(resetRecordSchema),
    }).strict().optional(),
    values: z.array(z.object({
      path: z.string(),
      value: z.union([z.number(), z.boolean()]),
      quality: z.enum(['good', 'outside-hard-range']),
    }).strict()),
  }).strict(),
}

const queryInputById: Readonly<Record<string, z.ZodType>> = {
  'world.process-plant.catalog.list': processPlantCatalogInputSchema,
  'world.process-plant.actions.search': processPlantActionsSearchInputSchema,
  'world.process-plant.credibility.list': credibilityListPayloadSchema,
  'world.process-plant.credibility.read': credibilityReadPayloadSchema,
  'world.process-plant.plants.list': processPlantCatalogInputSchema,
  'world.process-plant.graph.read': graphReadQuerySchema,
  'world.process-plant.components.search': componentsSearchQuerySchema,
  'world.process-plant.artifact.read': artifactReadQuerySchema,
  'world.process-plant.variables.read': variablesReadQuerySchema,
  'world.process-plant.variables.search': variablesSearchQuerySchema,
  'world.process-plant.signals.resolve': signalsResolveQuerySchema,
  'world.process-plant.signals.read': signalsReadQuerySchema,
  'world.process-plant.signals.search': signalsSearchQuerySchema,
  'world.process-plant.procedure-tags.validate': procedureTagsValidateQuerySchema,
  'world.process-plant.conditions.evaluate': conditionsEvaluateQuerySchema,
  'world.process-plant.procedure-condition.evaluate': procedureConditionEvaluateQuerySchema,
  'world.process-plant.assessments.evaluate': assessmentsEvaluateQuerySchema,
  'world.process-plant.control.validate': processPlantControlWritePayloadSchema,
  'world.process-plant.control.proposals': controlProposalsQuerySchema,
  'world.process-plant.controls.list': controlsListQuerySchema,
  'world.process-plant.runtime.status': processPlantCatalogInputSchema,
  'world.process-plant.transient.diagnostics': plantQuerySchema,
  ...Object.fromEntries(processPlantIcQueryKinds.map(id => [id, id === 'world.process-plant.ic.catalog' ? processPlantIcCatalogQuerySchema : plantQuerySchema])),
  'world.process-plant.display.compose': displayComposeQuerySchema,
  'world.process-plant.display.overview': displayOverviewQuerySchema,
  'world.process-plant.display.view': displayViewQuerySchema,
  'world.process-plant.display.sample': displaySampleQuerySchema,
}

const titleFor = (id: string): string => id
  .slice('world.process-plant.'.length)
  .split('.')
  .map(part => part.replaceAll('-', ' '))
  .join(' · ')

const queryDescriptionById: Readonly<Record<string, string>> = {
  'world.process-plant.catalog.list': 'Discover authored Process Plant model, operating-point, automation, control, assessment, recording, display, and credibility options. This is configuration, not a list of live Plant instances.',
  'world.process-plant.actions.search': 'Search Pack-declared Process Plant actions, including their exact actionId values, descriptions, parameters, and input schemas. The selected Plant validates applicability when an action is invoked.',
  'world.process-plant.credibility.list': 'List engineering credibility evidence available for one Plant.',
  'world.process-plant.credibility.read': 'Read one engineering evidence artifact and its provenance for one Plant.',
  'world.process-plant.plants.list': 'Discover live active Plant units and their exact plantId values, model library, graph size, variable count, the services and loops a display can name, and elapsed simulation time. Use these identities for Plant-specific reads.',
  'world.process-plant.graph.read': 'Read how Plant equipment is connected: what feeds or supplies a component (water, steam or power) and where its flow or power goes. Default mode connections returns compact links (kind, service, from and to component ids and ports, loop) and the components at their ends. With componentIds (exact ids from components.search), their own links, direction upstream, downstream or both (default), followed reach links (default 1) the way flow or power travels through each component\'s circuit; continues names where the connection goes on beyond reach and what comes next. Without componentIds, every link of the Plant. services (as plants.list names them, or a link kind such as thermalContact) narrows either; results are paginated. mode full explicitly exports the complete compiled graph with every component\'s parameters, ports and variables: about 200k tokens for a 4-loop PWR, so only for a complete engineering export.',
  'world.process-plant.components.search': 'Discover Plant components by identity, kind, or text. Returns compact summaries by default and parameters only when requested.',
  'world.process-plant.artifact.read': 'Inspect Plant configuration and implementation evidence. Default mode index returns paged component identities and source-file paths, sizes and hashes, without source content. mode component selects one exact componentId and its authored configuration/source links. mode source reads bounded lines from an indexed sourcePath; copy nextRead to continue with the same content hash. mode full explicitly exports the complete authored Plant configuration or compiled graph and existing source bundle (large). The implementation bundle covers behavior files and direct named imports, not the complete Pack or application; absence is not proof of no implementation. Not a live-state read.',
  'world.process-plant.variables.read': 'Read current values and metadata for exact Plant variable paths returned by variables.search or another discovery view; do not guess paths.',
  'world.process-plant.variables.search': 'Search current Plant variables by text, discipline, quantity, publication state, and Plant; results are paginated.',
  'world.process-plant.signals.resolve': 'Resolve exact signal references to canonical Plant signal bindings.',
  'world.process-plant.signals.read': 'Read live values, metadata, and quality for exact Plant signal references. Optional requestedUnit adds a valueView; native values are unchanged, and unavailable conversions retain actual units with a reason. valueView status describes conversion, not sensor quality. Quality good means only not outside a declared hard range; it does not establish calibrated instrumentation or model validity.',
  'world.process-plant.signals.search': 'Search Plant signal bindings by tag, equipment, discipline, quantity, writability, procedure relevance, and text; results are paginated. Default summary includes identities, descriptions, units and writability. Request detail full, or use signals.resolve for exact references, to inspect capabilities, limits, ownership and external references. Filtering always uses all metadata. Use signals.read for live values and quality.',
  'world.process-plant.procedure-tags.validate': 'Validate a set of procedure tags against one Plant and report missing or mismatched bindings.',
  'world.process-plant.conditions.evaluate': 'Evaluate declared operating conditions against current Plant signals. Comparison values must use the resolved signal\'s native unit and value type. Requested-unit views do not change condition thresholds; no procedure-unit conversion is performed.',
  'world.process-plant.assessments.evaluate': 'Judge each critical safety function the Plant\'s I&C declares by its status tree, now: per function the status (green, yellow, orange, red; unknown where a signal a branch needs is not published or readable; not-monitored where it is judged only after a reactor trip), the function restoration procedure its colour sends operators to, what it means, the branch path with every value read against its threshold, the further checks that apply (such as natural circulation with no coolant pump running, or makeup at its maximum at power) and the trends the tree treats as expected. Omit assessmentIds for every function; catalog.list names them. Judge the plant by these, not by one value off its normal: a trend the tree expects is no challenge. The trees are reference-model criteria after the generic Westinghouse ERG status trees, not qualified plant procedures; values are runtime model evidence that do not establish instrument validity or safety-function adequacy at a real plant.',
  'world.process-plant.procedure-condition.evaluate': 'Read-only evaluation of an authored, model-digest-pinned condition with explicit native units. Returns satisfied, challenged or unknown and every comparison observation at one simulation time. Values are runtime model evidence, not qualified instrumentation or automatic CSF restoration; authored source citations are retained, not independently verified. No equipment command, protection change or procedure transition is performed.',
  'world.process-plant.control.validate': 'Validate a proposed Process Plant control write without applying it.',
  'world.process-plant.control.proposals': 'Read a Plant\'s operation proposals: pending ones with World\'s review now (whether the I&C allows the stored write, and how each cited reading moved since it was proposed), and the last closed ones with who closed them, when and why (approved, rejected, expired, superseded, withdrawn). Read it before saying what became of a proposal.',
  'world.process-plant.controls.list': 'List what a person may operate on a Plant\'s drawn items, derived from its model: each offered control with its options (words, values written, the state each leads to), the trips each option would set going and the automation writing against it, where those stand now (armed; acted; a protection actuation holding it, which refuses the option), and how long the equipment takes to follow; what each option that stops, shuts or disconnects takes away now (the flow, where it goes, its share, the mode, the protection that may actuate); a modulating valve\'s demand with the span and step it is set in (OPEN to or THROTTLE to any setting there), where it stands now, and the floor a standing actuation lets it be throttled to; each valve\'s position; and each withheld command with why (held by its controller as AUTO, a demand or set point, an isolation input, declared not offered); and, under resets, every latched actuation standing with its RESET, offered or why not. Name items by the ids display.compose reports, or omit them for all.',
  'world.process-plant.runtime.status': 'Summarize active Process Plant runtime health, elapsed time, and variable publication counts.',
  'world.process-plant.transient.diagnostics': 'Read detailed transient, performance, and instrumentation diagnostics for one Plant.',
  'world.process-plant.ic.status': 'Read the complete current I&C snapshot for one Plant, including inactive alarm and trip lifecycle state.',
  'world.process-plant.ic.catalog': 'Discover one Plant\'s configured I&C rules (alarms, trips, protection and control): each rule\'s class, the modes it acts in, its effects and command gates, and the signals it watches by tagId, label and unit; signals.read gives their readings. Filter by text (words in the rule, its effects or its signals, e.g. "safety injection"), ruleClass or ruleIds. Returns a page of 25 rules by default (limit up to 100; continue from offset + returned while hasMore), with ruleCount, the Plant\'s total.',
  'world.process-plant.alarms.status': 'Read active alarms and trips plus a compact current lifecycle summary for one Plant. Use ic.status only when inactive lifecycle records are needed.',
  'world.process-plant.alarms.summary': 'Read a compact current alarm and trip summary for one Plant.',
  'world.process-plant.alarms.history': 'Read alarm and trip lifecycle transitions recorded for one Plant.',
  'world.process-plant.display.compose': 'Compose a small live operator display for one Plant, presented with your answer. State the operator question, need and subjects (1-4 equipment, signals, services or loops it is about; each must be shown), then choose 1-3 panels: one trend (history of 1-6 numeric signals; each measurement gets its own strip on one time axis, parallel equipment sharing one, at most 4 strips of 4; unrecorded signals show current values), comparison (2-6 parallel signals of one unit, e.g. the loops), mimic (a live equipment drawing World generates from the Plant model: "from" and/or "to" name one component per entry by id, a tag on it or its label, and draw every route between them, or what lies downstream of "from" or upstream of "to" alone; "around" draws both for its items; "reach" (1-3) limits the links one end or around follows; "services" with optional "loops" (as plants.list names them) draws whole systems or narrows a route; "exclude" leaves equipment out; e.g. {"kind":"mimic","to":["<component id>"],"services":["<service>"]}; World picks symbols, state signals and layout, draws actual states, disagreeing commands and unknowns as such, and frames alarms), readouts (1-6 current values or on/off states with margins, not already trended or drawn) and alarms (of the displayed signals and equipment, or the whole Plant). Give every signal a role (primary, context, counter-evidence) and use exact tagIds or paths from your evidence. Most answers need one trend, e.g. {"plantId":"<plantId>","title":"<what it shows>","question":"<the question it answers>","need":"<the decision it supports>","subjects":["<tagId>"],"panels":[{"kind":"trend","horizon":"10m","signals":[{"ref":"<tagId>","role":"primary"}]}]}. Read-only. Returns the view, the display clock, what it shows, each drawn item\'s state (equipment), each value as its legend states it: direction, rate, limit ahead and time to it (margins; the first is the display\'s lead), and warnings; or rejects with every issue, did-you-mean names and fixes known to fit.',
  'world.process-plant.display.overview': 'Open the live unit overview World generates for one Plant from its model: the principal circuits its heat flows through (drawn with OpenBridge, actual equipment states, alarmed equipment framed, safety and auxiliary services as stubs where they join), a status chip per critical safety function, the values it leads with in the mode it is in (at power, what protection can still trip on, then the energy source and sink; after a trip, subcooling margin, reactor outlet temperature and auxiliary feed flow, then PZR pressure and level), and the active alarms. Use when the operator wants the whole unit at a glance on a display; for a question about part of the Plant, compose a display. Read-only: stores nothing. Returns the view, the display clock, what it shows (each critical safety function\'s status too) and each drawn item with its current state (equipment). Present the view only when the operator wants a display, never for a request for text only: answer that in words from what you read.',
  'world.process-plant.display.view': 'Compile a display state for a live display view: an agent\'s composed display (kind advice), a Plant\'s unit overview (kind overview), or equipment opened from it (kind detail); the last two are drawn for the view size sent with them. Display views use this; to create a display, use display.compose or display.overview.',
  'world.process-plant.display.sample': 'Read current values and hard-range quality for up to 256 exact signal paths, the operating mode the Plant is in where it declares modes, the status of each critical safety function it declares with its tree path in words, and optionally the alarms and trips to annunciate (active ones, and cleared ones not yet acknowledged; not shelved, suppressed or out of service) and the operations on those paths (commands people and AI agents issued, running ramps, proposals), at the current Simulation Run time. Live display views use this for polling.',
}

const processPlantQueryCapabilities = processPlantQueryKinds.map(id => {
  const input = queryInputById[id]
  const output = queryOutputById[id]
  if (!input) throw new Error(`missing Process Plant capability input schema: ${id}`)
  if (!output) throw new Error(`missing Process Plant capability output schema: ${id}`)
  return defineSimulationQueryCapability({
    id,
    title: titleFor(id),
    description: queryDescriptionById[id] ?? `Read ${titleFor(id)} from the active Process Plant runtime.`,
    input,
    output,
    ...(['world.process-plant.catalog.list', 'world.process-plant.plants.list', 'world.process-plant.runtime.status'].includes(id)
      ? {}
      : {
          inspectObjectIds: (rawInput: unknown) => {
            const plantId = id === 'world.process-plant.procedure-condition.evaluate'
              ? (rawInput as { targetObjectId?: unknown }).targetObjectId
              : (rawInput as { plantId?: unknown }).plantId
            return typeof plantId === 'string' ? [objectIdSchema.parse(plantId)] : []
          },
        }),
  })
})

const commandCapability = <T extends { readonly plantId: string }>(config: {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly searchTerms?: ReadonlyArray<string>
  readonly input: z.ZodType<T>
  readonly risk?: 'write' | 'destructive'
  /** A command result that says more than accepted or refused; the core result where absent. */
  readonly output?: z.ZodType
}) => defineSimulationCommandCapability({
  ...config,
  risk: config.risk ?? 'write',
  idempotent: false,
  schedulable: true,
  output: config.output ?? commandResultSchema,
  buildCommand: rawInput => {
    const input = config.input.parse(rawInput)
    return {
      targetObjectIds: [objectIdSchema.parse(input.plantId)],
      payload: input,
    }
  },
})

/** A proposal's result: accepted, with the control's word and what the operation takes away now (operations/consequence.ts); or refused, with why. */
export const processPlantControlProposeResultSchema = z.discriminatedUnion('ok', [
  commandResultSchema.options[0].extend({ word: z.string().min(1), consequence: operationConsequenceSchema.optional() }),
  commandResultSchema.options[1],
])
export type ProcessPlantControlProposeResult = z.infer<typeof processPlantControlProposeResultSchema>

export const processPlantCapabilities = [
  commandCapability({
    id: processPlantControlWriteCommandKind,
    title: 'Write process control',
    description: 'Write one validated Process Plant signal or variable. An AI agent proposes instead (world.process-plant.control.propose) unless it drives an active procedure Run on the Plant or the Plant opts into direct AI operation.',
    input: processPlantControlWritePayloadSchema,
  }),
  commandCapability({
    id: processPlantControlRampCommandKind,
    title: 'Ramp process control',
    description: 'Ramp one Process Plant signal or variable to a target over simulation time. An AI agent proposes instead (world.process-plant.control.propose) unless it drives an active procedure Run on the Plant or the Plant opts into direct AI operation.',
    input: processPlantControlRampPayloadSchema,
  }),
  commandCapability({
    id: processPlantControlProposeCommandKind,
    title: 'Propose an operation',
    description: 'Propose one operation of a Plant\'s equipment for a person to approve in the display window; an AI agent operates a Plant this way unless it drives an active procedure Run on the Plant or the Plant opts into direct AI operation. Name a control\'s command (path or tagId) and one value it offers, as world.process-plant.controls.list lists them; give the reason in plain words, the procedure step where one applies, and 1-6 published tags it rests on. World records the exact write only if the control is offered, the I&C allows it now and every tag is published; otherwise it refuses with why. Nothing is executed: a person reviews it on the equipment\'s popover, with World\'s own check, the consequences and how the cited readings moved since, and approves (World executes the stored write, validated again, under that person\'s command), rejects, or lets it lapse after 2 plant minutes (a person may extend it once). Or propose a latched actuation\'s reset (reset: its ruleId from controls.list resets), offered once its condition has cleared. A newer proposal of yours for the same equipment or actuation replaces your older one. Accepted, it returns the control\'s word and its consequence: the flow it stops or throttles, where that goes, its share, the mode and the protection that may actuate; tell the person. After proposing, compose a display around the item so the person can review it there. Read world.process-plant.control.proposals before saying anything happened: until it reads approved, the operation is proposed and awaiting a person\'s decision, never done. Each decision is a durable interaction signal (type process-plant.proposal.approved, .rejected or .expired) that world.simulation-run.wait can name.',
    input: processPlantControlProposePayloadSchema,
    output: processPlantControlProposeResultSchema,
  }),
  commandCapability({
    id: processPlantControlDecideCommandKind,
    title: 'Decide on a proposal',
    description: 'A person\'s decision on a pending operation proposal: approve executes its stored write, validated again by the I&C, or its reset, under the approver\'s command; reject closes it (optional reason); extend gives it one more plant minute, once; withdraw takes back the proposer\'s own proposal. Only people approve, reject or extend.',
    input: processPlantControlDecidePayloadSchema,
  }),
  commandCapability({
    id: processPlantActuationResetCommandKind,
    title: 'Reset an actuation',
    description: 'A person resets one latched protection actuation (a reactor trip, safety injection, an AFW actuation), as world.process-plant.controls.list lists it under resets: World resets it only once its initiating condition no longer holds and the time its rule declares since it acted has passed, and refuses with why otherwise. The reset clears the latch only; equipment stays as the actuation left it, and its hold on what the actuation wrote lifts. An AI agent proposes a reset (world.process-plant.control.propose) for a person to approve; it resets one itself only while it drives an active procedure Run on the Plant.',
    input: processPlantActuationResetPayloadSchema,
  }),
  commandCapability({
    id: processPlantIcLifecycleCommandKind,
    title: 'Change alarm lifecycle',
    description: 'Acknowledge, reset, suppress, or shelve a Process Plant alarm lifecycle.',
    input: processPlantIcLifecyclePayloadSchema,
  }),
  commandCapability({
    id: processPlantActionInvokeCommandKind,
    title: 'Invoke plant action',
    description: 'Invoke a Pack-declared Process Plant action with an exact plantId and actionId. Discover those values with plants.list and actions.search.',
    searchTerms: processPlantActions.flatMap(action => [action.id, action.title, action.description]),
    input: processPlantActionInvokePayloadSchema,
    risk: 'write',
  }),
  ...processPlantQueryCapabilities,
] as const
