// Evaluation events — real-time visibility into agent reasoning. Leaf module.
//
// Two layers:
//
//   EvalEventCore  — emitted by evaluation.ts and ai-agent.ts internals.
//                    Does NOT carry traceId; emit sites are free of
//                    correlation plumbing.
//
//   EvalEvent      — carries traceId; this is what subscribers see via
//                    OnEvalEvent. ai-agent.ts wraps the callback once at
//                    evaluate() entry to stamp traceId onto every event
//                    before forwarding. Trace correlation is centralised;
//                    nothing else has to know about it. The Agent's outer turn
//                    owns completion, including preparation and cancellation.
//
// The diagnostics ring buffer (src/diagnostics/eval-buffer.ts) keys
// records by traceId so a single eval's events all roll up into one
// record, and so /api/diagnostics/evals/:traceId can fetch the assembled
// trace.

// Why a turn's answer was sent back to the model for one more pass
// (evaluation.ts): the turn had to present a display and presented none; it
// composed one and did not present it; a display or map block was invalid; the
// display it presents contradicts a value it cites; it claimed an execution.
export type CorrectionCause = 'required-view' | 'unpresented-view' | 'view-fence' | 'map-fence' | 'contradiction' | 'claimed-execution'

export type EvalEventCore =
  | { readonly kind: 'chunk'; readonly delta: string }
  | { readonly kind: 'thinking'; readonly delta: string }
  // callId is REQUIRED on tool_start/tool_result. Unlike traceId (optional
  // because some events are out-of-band, e.g. spawn.ts's model_fallback),
  // tool events are emitted only from evaluation.ts's tool loop — no
  // out-of-band sources exist. Making the field required is the
  // compile-error forcing function that prevents a future parallel-call
  // emit site from silently shipping without correlation.
  | { readonly kind: 'tool_start'; readonly tool: string; readonly callId: string }
  | { readonly kind: 'tool_result'; readonly tool: string; readonly callId: string; readonly success: boolean; readonly preview?: string }
  | { readonly kind: 'context_ready'; readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>; readonly model: string; readonly temperature?: number; readonly toolCount: number }
  | { readonly kind: 'warning'; readonly message: string }
  | { readonly kind: 'model_fallback'; readonly preferred: string; readonly effective: string; readonly reason: string }
  | { readonly kind: 'eval_completed'; readonly outcome: 'respond' | 'pass' | 'error' | 'cancelled' }
  // Emitted before every correction pass, with each cause and the issues the
  // correction names, so every correction turn is logged with why it ran.
  | { readonly kind: 'correction'; readonly causes: ReadonlyArray<CorrectionCause>; readonly issues: ReadonlyArray<string> }
  // Tool-iteration check-in: the agent's tool loop has used `iterations`
  // calls without finishing. It emits this event and waits for explicit
  // user input. The UI surfaces
  // [Continue] [Stop] buttons; calling the Workspace-scoped continue-tools endpoint
  // removes the threshold for this turn, cancelGeneration stops cleanly, and an abandonment
  // timeout (default 10min, env LEITBILD_TOOL_CHECKIN_ABANDON_MS) auto-
  // stops if neither happens — bounding state-machine leakage.
  | {
      readonly kind: 'tool_iteration_checkin'
      readonly iterations: number
      readonly roomId: string
      readonly recentTools: ReadonlyArray<{ readonly tool: string; readonly success: boolean }>
    }

// traceId is OPTIONAL on the public event type — most events come from
// inside an evaluate() call and carry one, but some are emitted out-of-
// band (e.g. spawn.ts emits model_fallback when the LLMService chain
// switches mid-flight, with no eval scope to inherit a traceId from).
// Subscribers that key by traceId (the diagnostics ring buffer) skip
// events that lack one.
export type EvalEvent = EvalEventCore & { readonly traceId?: string }

// Stable routing identity for one evaluation activity stream. Names remain
// presentation data; transport and diagnostics correlate by immutable ids.
// roomId is absent only for provider events emitted outside an active turn.
export interface EvalEventScope {
  readonly agentId: string
  readonly agentName: string
  readonly roomId?: string
}

export type OnEvalEvent = (scope: EvalEventScope, event: EvalEvent) => void

// Cheap, collision-resistant id for a single eval. Not cryptographic;
// just needs to be unique within a session.
export const generateTraceId = (): string => {
  const r = Math.random().toString(36).slice(2, 10)
  return `tr_${Date.now().toString(36)}_${r}`
}
