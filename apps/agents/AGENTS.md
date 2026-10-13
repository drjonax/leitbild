# AGENTS.md

Rules for working in this repo. Architecture overview is in [README.md](README.md); everything below is non-discoverable — invariants and tripwires you'd miss by reading the code.

## Workflow and commands

- **Version**: the root `package.json` is the platform version. Module descriptor versions describe their own runtime contracts; do not present them as separate product releases.
- **Workflow**: commit each logical change as its own commit. Production deploys from a clean checkout of `main` through the platform deployer (see "Concurrent agents" in the root `AGENTS.md`).
- **Commands**:
  - `bun run check` — typecheck and dependency boundaries (`.dependency-cruiser.cjs`; errors fail, warnings don't) (always run after non-trivial edits)
  - `bun test` / `bun run test:unit` — full deterministic suite, including Ollama adapter/fallback fixtures; external Ollama integration and soaks are explicitly skipped unless enabled
  - `bun run test:ollama` — opts into real Ollama integration (`OLLAMA_INTEGRATION=1`); requires the configured endpoint and `llama3.2:latest`
  - `bun test path/to/file.test.ts` — one file; `bun test -t "pattern"` filters by name
  - `bun run start` / `dev` / `headless` (MCP only) / `dev:remote` (`OLLAMA_URL=http://192.168.0.222:11434`)
  - `bun run health` — strict typecheck, type coverage, and dependency-boundary audit
- **Runtime**: Bun 1.4.0 is pinned locally and in production. Some code uses `Bun.serve`, `Bun.file`, `bun:test`; do not assume Node.
- **TypeScript toolchain**: `@typescript/native` supplies the TypeScript 7 `tsc` used by `bun run check`. Standard `typescript` supplies the TypeScript 6 compiler API required by analysis tools. Keep both until those tools support the native compiler API.

## Stable invariants (would not be obvious from reading the code)

- **One HTTP server** at `src/api/server.ts`, one MCP stdio server at `src/integrations/mcp/server.ts`. New routes go in `src/api/routes/`; new WS commands in `src/api/ws-commands/`. Never new servers.
- **`System.llm` is the `ProviderRouter`, always.** All agent spawn / eval / `callSystemLLM` calls go through `system.llm.chat(...)`. `System.ollama` is `LLMGateway | undefined` — present only when ollama is in the order; used by the Ollama dashboard UI.
- **Provider stack assembly canonically lives in `src/boot/provider-stack.ts`** — `buildProviderStack()` orders load → env-merge → providerKeys → setup → DeploymentRuntime. The `src/llm/providers-*.ts` files are pieces; preserve this assembly order.
- **Two delivery modes**: `broadcast` and `manual` (`src/core/rooms/delivery-modes.ts`). Plug new behavior into the mode switch; do not branch around it. Multi-agent orchestration belongs to the script engine, not the room.
- **Module state is strict and independently owned.** Agents has one marker. Room and Agent Profile data use separate strict documents beneath `workspaces/{workspaceId}/agents`; obsolete shapes fail without migrations or compatibility parsers.
- **Types import from the specific submodule** (`src/core/types/room.ts`, etc.), not a barrel.
- **Functional style only.** Factory functions + object literals + composition. No classes. Test doubles stay under test-only paths and never ship in production.
- **Tests live next to source** (`foo.ts` + `foo.test.ts`).

## Rejected refactors (do not re-propose without significant new evidence)

These have been evaluated and rejected as motion-without-progress. Re-propose only if you can demonstrate a *significant* new benefit absent at the time of rejection — a bug traced to the pattern, a second-consumer use case, a measurable correctness/performance gain.

- **Replacing the `setOn*` late-bound callback slots in `workspace-runtime.ts` with an event bus.** The typed callback slots are intentional: parallel, independent, compile-time typed, and localized.

- **Extracting `createAgentsWorkspaceRuntime` into arbitrary boot-phase sub-functions.** Prefer targeted extraction of self-contained subsystems rather than scattering factory wiring.

- **MCP-vs-REST tool-surface "parity".** Different audiences, intentional divergence. REST/built-in is the agent-facing surface (in-process AI agent: `list_rooms`, `pass`, `geo_lookup`, `install_pack`, `write_skill`). MCP is the host-facing surface (external Codex: `create_agent`, `update_agent_persona`, `wait_for_idle`, `export_room`, `reset_system`). Each side has tools the other doesn't, by design.

- **Reviving a second artifact or workspace abstraction.** Agents handles workflows conversationally or through the script engine; Mermaid and maps render inline. If a workflow genuinely needs persistent shared objects, establish the specific second consumer before adding another abstraction.

When in doubt: ugly ≠ broken. Move on.

## Anti-pattern tripwires (each has bitten this codebase)

- **No silent skips on optional dependencies.** `if (x) doX()` patterns hide latent bugs when `x` is sometimes-undefined due to ordering and invariants drift. Either: (a) annotate why "skip" is correct (`// evicted-during-event drop is intentional`), (b) assert `x` is present and throw, or (c) make `x` non-optional in the type. The bug fixed in `5d73a8e` (broadcast wiring silently skipped for lazily loaded Workspaces) was three unannotated `if`s lined up.

- **Boot-once cache of derived state with external inputs.** The wiki bug fixed in `b660b3e`: `wikiRegistry.setWikis(merge(stored, discovered))` was called once at boot; CRUD endpoints re-synced but the GET handler didn't; `discovered` (GitHub org listing) changed externally → GET showed wikis the registry didn't know about. Lesson: if `X = compute(A, B)` is cached, invalidate when *either* input can change, or derive `X` fresh on each read (usually cheap). Pattern to watch: `setX(computeX())` at boot followed by reads that assume currency.

- **Silent fallbacks** (`catch {}`, `?? null`, `?? []`, early-return-on-undefined): require explicit justification of why the failure should not be loud. Would a thrown error or warning surface this to an operator? If yes, prefer that.

- **Persistence captures the wrong abstraction.** For each new persisted field: if you rename or restructure the referenced concept later, will the persisted value still mean the right thing? If no, flag it.

- **Silently-ANDed permission gates with no single error path.** Two gates returning the same "not available" with no way to tell which fired produced the 2026-05-12 tool-loop incident. Each new access-control gate's failure path must carry a structured reason.

- **Era-stale magic numbers.** `maxN: 10`, `timeoutMs: 5000` etc.: sized for current reality or copy-pasted from an older era? `historyLimit: 10` cutting off gpt-5.4 context (commit `1c0651e`) was the cost.

- **Cross-cutting concerns need end-to-end tests, not just unit tests.** When a feature touches >3 layers (e.g. eval → late-binding → wsManager → broadcastToInstance → WS → UI dispatch), one integration test of the full chain is worth more than five unit tests of layers. Unit tests of any single layer pass while the chain is broken. Existing examples: `src/api/broadcast-wiring.test.ts`, `src/llm/system-wiring.test.ts`.

## Plan reviews and stress-tests — extra checks for this repo

When running `Codex-toolbox:stress-test` (or any plan review) on a plan touching this codebase, ADD these on top of the skill's default axes:

- **New fallback** the plan introduces (silent `catch {}`, `?? null` without recovery, early-return-on-undefined): require explicit justification (cross-reference "Silent fallbacks" above).
- **New persisted field**: snapshot-shape question (cross-reference "Persistence captures the wrong abstraction" above).
- **New access-control gate**: must have a structured failure reason distinguishing it from existing gates.
- **New magic number**: justified by current constraint or stale copy?

## Knowledge

Use the unified Leitbild wiki for current explanations and the source for exact contracts. Do not recreate a parallel `docs/` collection here. Executable skills remain in `skills/`; their text is inspectable, not copied into the wiki.
