# Leitbild Agent Instructions

## Project Guardrails

- Use TypeScript for all source code.
- Exception: the explicitly authorized offline numerical kernel in `native/process-plant` uses Rust and a narrow inspected C++ property bridge. Keep application/runtime orchestration and admission scripts in TypeScript; do not expand this exception into other Packs or install LD-01 without construction approval.
- Do not create JavaScript files unless the user explicitly approves.
- Use Bun 1.4.0 for package management, scripts, tests, and local/production runtime.
- Maintain exactly one main HTTP server at `src/core/api/server.ts`.
- Keep runtime mechanics conceptually separate from Leitbild core. Local runtimes must use the same adapter boundary as remote runtimes.
- Validate external input at trust boundaries: HTTP, WebSocket, runtime feeds, file imports, AI-generated dashboard specs, and generated code.
- Scope real-time broadcasts by simulation run. Never broadcast events globally unless the event is explicitly global.
- Avoid silent fallbacks, silent skips, empty catches, or unexplained defaulting when failure should be visible.

## No Mock Or Dummy Functionality

- Never add mock, dummy, placeholder, fake, stubbed, or simulated production functionality as a shortcut.
- Test doubles are allowed only in tests, and must be clearly confined to test files.
- Production paths must either be real, deliberately minimal but functional, or absent.
- If a capability is not ready, expose it as unsupported with an explicit error or leave it out of the product surface.
- Do not add TODO-driven placeholder implementations that future work must replace.

## Architecture Preferences

- Prefer functional modules, factory functions, explicit interfaces, and immutable configuration.
- Avoid classes unless there is a strong technical reason.
- Use async/await instead of `.then()` or `.catch()` chains.
- Keep files and functions small enough to remain navigable.
- Add abstractions only when they protect a real boundary or remove real complexity.
- Keep pack-specific logic in `src/packs/*`; keep `core` use-case agnostic.
- Generic UI modules must consume pack presentation and creation protocols instead of importing pack-specific models, runtimes, geometry helpers, or condition calculators.
- Shared spatial indexing belongs in `src/core/spatial/*`. The `h3-js` dependency may only be imported by the core spatial wrapper; packs and UI must consume Leitbild spatial interfaces instead of depending on H3 directly.
- Weather field computation belongs inside the weather Pack. UI may request runtime-projected map features through the published Simulation Capability, but must not import weather models, weather cell math, or weather condition calculators.
- Pack map-feature animation metadata is presentation-only. It can smooth rendered geometry and attached symbol anchors between runtime query refreshes, but it must not become a simulation update path or a substitute for runtime-owned truth.
- New Simulation Runs must start from a validated Scenario Definition Revision resolved through the Scenario Library. Do not add pack seed factories, hidden runtime defaults, pack-owned scenario files, or parallel startup formats.
- Scenario Definitions group each Pack's authored items, runtime choice, and Pack-owned configuration beneath one Pack Selection. Do not reintroduce parallel Pack-id arrays or maps.
- Scenario Definitions may own a small Starting View, but browser layout, rails, footers, and Pack panels are derived UI. Do not persist the current screen composition as scenario truth.
- Built-in scenarios should be authored as compact declarative JSON Scenario Definitions, then expanded through pack-owned scenario codecs into exact Compiled Scenarios. Do not put reusable object-construction logic inside individual scenario files.
- Scenario Definition compilation must stay deterministic and ordered. Do not parallelize Item/action expansion when later specs may reference earlier created objects.
- Scenario scripts must stay declarative and must emit ordered Simulation Run events through the Simulation Run runtime. Do not add browser-only scenario/tutorial state, runtime-private scenario timers, or arbitrary scenario code execution.
- Restored Simulation Runs must start from persisted snapshots/history, not by replaying or reapplying Scenario Definitions.
- Treat Simulation Run Projected State as canonical current Leitbild truth. UI, API, AI agents, metrics, and interaction handlers must read shared operational state from the Simulation Run projection. Readers that hold a role in a Run that declares sides receive their role's view of the one projection: objects and events filtered by audience, scenario state redacted, and runtime realtime messages limited to `pack.data.changed`. Pack runtimes, interaction handlers, persistence and the journal keep complete truth. A role-aware Pack writes an audience on every object it upserts, answers queries and refusals only within the stamped viewer's picture, keeps sided ids out of public objects, and emits side-visible realtime messages only for public authoring changes.
- Treat the Durable Journal as meaningful accepted history, not as full current state and not as a high-frequency motion trace.
- Pack runtimes may keep private mechanics and runtime-local projections, but those are not canonical shared object state. Runtimes must rehydrate private mechanics from canonical objects on connect; do not make the UI infer or drive runtime motion.
- Use the Runtime Hub for multiple pack runtimes in one Simulation Run. Do not merge a new pack runtime into an existing pack runtime just to get a short-term demo.
- Pack runtimes must declare accepted command kinds; do not rely on broad command broadcast as the long-term command-routing model.
- Runtime-owned read models must be exposed as typed Simulation Capabilities. Do not add a private Pack-query envelope or Pack-specific HTTP endpoint families such as `/api/weather/*` or `/api/ambulance/*` without a new ADR.
- Query Capabilities must be read-only. They must not issue commands, mutate runtime state, emit events, or commit canonical changes.
- The observation contract in `src/core/observation/` is a World-internal protocol, like recording and procedures, not a universal Pack runtime. World Packs declare observables, thresholds, alerts and topology through exact Capabilities whose outputs World core validates against its own core schemas; World core runs no Pack code generically, owns no Pack state, offers no Pack-defined extension points, and no other Module implements or imports the contract. Dashboard sections are stored by value: no templates or cross-Module fragments.
- Process-control Packs such as `process-plant` must keep continuous physics inside the Pack-owned runtime. Use validated component graphs, typed ports, compiled runtime indices, typed query Capabilities, and discrete Simulation Run events; do not turn internal process variables into `OperationalObject`s or use event messages as the continuous physics solver.
- Process-plant signal bindings are graph-owned metadata. Use `tagId` plus explicit `plantId`; do not reintroduce `sensorId`, `actuatorId`, implicit current-Plant lookup, fleet-wide aliases, or separate binding catalogs without an ADR.
- Process-plant variable capabilities and limits belong on variable descriptors and compiled signal bindings. Derive defaults from `writable`, `publish`, and `tagId`; add explicit overrides only when they carry operational value. Do not add arbitrary hard ranges to generic variables.
- Process-plant control/protection rules must be typed declarative data evaluated by the pack runtime. Treat this as a simplified plant I&C substrate above continuous physics: instrumentation signals, normal controllers, protection functions, alarms, structured annunciator metadata, mode-qualified rules, permissives, interlocks, and validated actions. Do not add arbitrary expression languages, generated procedure code, global mode stores, or mid-solver mutation.
- Process-plant I&C lifecycle actions are alarm/trip lifecycle state operations only. They must not mutate process variables, execute emergency procedures, or become a hidden control path.
- Procedure documents belong to the unified knowledge publication; the generic World procedure system owns their execution and exact source retention. Operators and AI agents may query signal values and issue validated commands, but process-plant must not become an embedded emergency procedure engine.
- Process-plant alarms are persistent current state plus transition events. Do not model alarms only as transient interaction events or clear them merely because they were acknowledged.
- Process-plant automatic actions from normal control or protection must flow through the same validated queued write path as operator, scenario, and AI commands. Do not create a privileged mutation path that bypasses writability, limits, type checks, or solver phase boundaries.
- A Plant selects a process-plant-owned Plant Model inside its Scenario Pack Selection. Keep reusable component definitions and solver behavior in code, but do not make hardcoded TypeScript graphs the canonical runtime source of truth or expose Plant Model schemas from World core.
- Keep `packData` and `context` conceptually separate: `packData` is pack-owned operational truth, while `context` is structured, perspective-bearing awareness for assets, operators, system processes, and AI agents.
- Do not store generated prompts, raw full event logs, or unbounded memory dumps in object `context`; derive bounded agent context views instead.
- Model cross-object and cross-runtime interaction through scoped interaction signals and registered handlers. Objects may be the source or subject of signals/events, but objects are data, not active executable actors.
- Interaction handlers must return constrained effects for the simulation-run runtime to validate, order, persist, and broadcast. Handlers must not directly mutate shared state or call other objects.
- Pack runtimes observe committed Simulation Run events; do not add second authoritative mutation paths that mirror canonical object state into a runtime as if the runtime owned shared truth.
- Route impacts must be canonical and visible. Do not silently reroute a mobile asset without an explicit command or declared automation policy.
- Treat AI outputs as untrusted input: AI agents may issue commands or emit interaction signals, but only validated handlers and committed Simulation Run events can change canonical state.
- Treat the self-hosted vector map artifact as contextual data, not operational truth. Pack runtimes and UI surfaces must discover map-context capabilities through `/map/capabilities.json` instead of hard-coding tile assumptions.
- Do not reintroduce raster OSM base maps or raster fallback paths. Leitbild's base map is vector-only.

## Svelte UI Rules

- Use Svelte 5 runes for new and actively migrated UI code.
- Use `$props` for component inputs, `$state` for local mutable UI state, `$derived` for derived UI state, and `$effect` only for synchronization with external systems, timers, browser APIs, network connections, or imperative libraries.
- Do not add new `export let`, `$:`, `on:`, deprecated `context="module"`, `<svelte:component>`, or slot-based APIs in migrated UI code unless there is a clear written reason.
- Use modern event attributes such as `onclick` in migrated components.
- Prefer snippets over slots for shared modal/composition components.
- Svelte state is client-local UI state only. Do not duplicate Simulation Run Projected State into a second canonical UI store.
- Do not use raw `$effect` as an `onMount` substitute. Use `runOnMount` from `src/ui/svelte-lifecycle.svelte.ts` for mount-only browser listeners, intervals, map construction, WebSocket startup orchestration, and similar one-time external lifecycle setup.
- Keep MapLibre as an imperative boundary. Use Svelte effects to synchronize inputs to the map, not to make the map lifecycle itself a reactive data model.
- MapLibre resize is owned by observed map container geometry. Do not use rail state, modal state, startup state, arbitrary revision counters, or delayed activation frames to wake or resize the map.
- Pure TypeScript UI presenters/selectors are allowed when they concentrate real derivation logic and are tested. Delete them if they become pass-through wrappers.
- Current architectural explanations live in the unified wiki; preserve these executable UI constraints rather than recreating historical ADR files.

## Map Rendering Rules

- Use MapLibre as Leitbild's base geospatial rendering engine.
- Use self-hosted PMTiles vector tiles as the only base map source. The base map style loads from `/map/style.json`; discover overview/regional tile templates and their actual coverage through `/map/capabilities.json`. Do not imply that worldwide overview includes global street detail or routing.
- Render geospatial truth with native MapLibre sources/layers: entity positions, routes, trails, zones, uncertainty geometry, alert areas, selection halos, and large-fleet views.
- Do not use MapLibre DOM markers for core object rendering; DOM marker anchoring can drift from the true projected coordinate across zoom levels.
- Use Lucide-style SVG artwork only as MapLibre-native registered images/symbols, not as free-floating marker DOM.
- Use Svelte/HTML overlays for rich operational UI: hover cards, selected object panels, ECG/vitals mini-trends, command menus, adaptive UI widgets, and pinned callouts.
- Object-attached rich overlays must be positioned by a controlled overlay manager using object id, object lon/lat, and `map.project([lon, lat])`; update overlays on object changes, map move/zoom/resize, and cull when off-screen or too dense.
- Keep rich overlays sparse: selected, hovered, pinned, high-priority, or scenario-condition-specific objects. Native layers carry the fleet.
- Maintain explicit map layer ordering: base map, routes/trails/zones, object halos, object icons, new-info indicators, then popups/HTML overlays.

## OpenBridge Rules

The owner adopted this policy on 21 Oct 2026 for every operator display, in the embed page and in the main app's OpenBridge-free hosts. The wiki's design-system page states it and mirrors the register.

- In the embed, an OpenBridge component draws whatever it carries the meaning of: equipment symbols, connectors (pipes, lines, buses, flow marks, ends), instruments (readouts, bars, indicators, badges), alert indications and controls. Set it only through its manifest: properties, attributes, slots and enums. Plain HTML is fine for layout, text, tables and token-styled chips.
- Colour, type and spacing come from OpenBridge tokens, directly or through the `embed.css` aliases. No colour literals. Alert tokens mean alert severity only (D-32).
- A custom shape needs one of four reasons, with evidence: A, no component carries the meaning; B, a licence twin for an OpenBridge-free host; C, a measured defect in the component; D, measured density or speed, with figures. "Simpler" or "looks better" is no reason. Extending a component (a slot, a second layer) beats replacing it.
- A custom shape is drawn from model data for a kind, never one Plant, in OpenBridge tokens and its nearest building block's geometry, as a tested pure function. A twin copies no OpenBridge path data, CSS or code; it lives once, in `src/ui/displays/`, and matches OpenBridge's shape class and colour per palette.
- Each custom shape has one entry in `tests/openbridge-register.ts`: its file, what it draws, the OpenBridge component it stands in for (or none), its reason and evidence, the decision, and the phase it ends in. A new entry needs the owner's approval, as D-19 did. A shape goes once OpenBridge carries its meaning.
- OpenBridge (AGPL-3.0-only) reaches only the embed page, which loads in an iframe. The main app, Agents and the Host load no `@oicl` module at run time. Every embed chunk with OpenBridge code carries the AGPL notice, and deploys are built only from committed, public source. When a pinned version reaches its Apache-2.0 date (2.0.0: about 28 March 2027), using it in the main app is an owner decision; upgrading restarts the clock.
- Both `@oicl` packages are pinned exactly in `package.json` and `bun.lock`; NOTICE.md and the wiki name those versions. No patches, aliases or forks. An upgrade is one commit that regenerates the text metrics, runs the OpenBridge tests, compares the reference displays in the browser in day and dusk, re-checks `openBridgeDevice` and the register, and updates the notice and the wiki.
- A file that draws an OpenBridge element imports its module bare (`import '@oicl/…/x.js'`), itself or through its surface's one loader (`composed-display/openbridge.ts`, `faceplate-openbridge.ts`, `openbridge-mimic.ts` or `vignette/openbridge.ts`). A type or enum import never registers an element; an `import type` stands beside the bare import, never instead of it. Shadow roots, CSS parts and component properties outside the manifest are used only where the register lists them.
- The tests: `openbridge-usage.test.ts` (manifest properties and enums; drawn tags defined in source), `built-ui-scan.test.ts` (drawn tags defined in the built embed), `alert-strip-host.test.ts` (T28: the main app loads no OpenBridge), `openbridge-notice.test.ts` (AGPL notice), `display-colour.test.ts` (T04a: twins match OpenBridge), `openbridge-tokens.test.ts` (tokens resolve, no colour literals, listed internals exist), `openbridge-register.test.ts` (every SVG or drawing canvas registered, no stale entry) and `openbridge-pins.test.ts` (exact pins, NOTICE.md names the installed versions).

## Commands

- `bun test` runs tests.
- `bun run check` runs TypeScript checking.
- `bun run health` runs World checks, tests and UI build.
- From the repository root, `bun run deploy -- --yes` validates all modules, packages, and deploys one immutable code-only release. `--dry-run` validates and packages without contacting production. It never publishes map/reference/OSRM artifacts.

## Delivery Rule

- After completing code changes, deploy from the local worktree to `leitbild.app` unless the user explicitly says not to. Commit logical changes locally; push `main` to GitHub at useful backup/milestone points rather than as a deployment prerequisite.
