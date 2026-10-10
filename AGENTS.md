# Leitbild Platform Agent Instructions

These rules apply across the repository. Module-local `AGENTS.md` files may add stricter domain rules but may not weaken these platform boundaries.

- The Leitbild Host is the only public product entry point and the sole owner of Workspace identity, display metadata, and core Module provisioning state.
- A Module owns its domain state and behavior. The Host must not own Rooms, Agents, Scenarios, Simulation Runs, Pack configuration, projections, or runtime-private state.
- Modules communicate through `packages/contracts`; they never import another Module's implementation.
- The contracts package contains identifiers and validated wire schemas, not shared business logic, persistence services, runtime implementations, or UI components.
- Every Workspace provisions the World and Agents core Modules. Rooms and messaging are internal Agents domains, not another Module. Do not add Experiences, user-controlled Module installation, or alternate Workspace compositions.
- Agents discover Resources and Capabilities at runtime. Do not persist Module-specific resource ids or bindings in Agent configuration.
- A Binding is allowed only for continuous system behavior that must persist without an Agent choosing on every action.
- Packs belong to exactly one Module. Do not create a universal Pack runtime.
- Pack descriptors declare provenance and contribution identities; exact callable operations belong to the owning Module's Capability Registry. Do not derive vague Pack capabilities from contribution kinds.
- The Host launches Module Definitions only through their published Capabilities. Do not add a separate Host-owned demo catalog or hidden cross-Module launch logic.
- Definitions, Resources, and Capabilities are the common orchestration model. Modules own Definition schemas and compilation, Resource state, Capability handlers, and ongoing automation.
- Reusable composition fragments belong to one Module. Do not add a universal fragment runtime, arbitrary inheritance, merge-patch language, or cross-Module fragment.
- Workspace identity is carried in canonical URL paths. Cookies must not select or override a Workspace.
- Expensive Module runtimes remain lazy even though all core Modules are provisioned for every Workspace.
- Use Bun 1.4.0 and TypeScript. Prefer functional modules, factory functions, explicit ports, and validated boundaries.
- The owner-authorized offline Process Plant numerical kernel in `apps/world/native/process-plant` is a narrow Rust/native exception. Bun owns its admission/provenance tooling. It is not registered or installed as the live LD-01 runtime; construction remains separately gated.
- Do not add silent fallbacks, mocks in production, compatibility behavior, API versions, migrations, aliases, or legacy parsing. The explicitly requested wiki Archive is retained documentation, not a runtime compatibility layer.
- Commit each logical phase separately. Deploy only after standalone and combined validation passes.

## Concurrent agents

- Several Claude Code sessions and their subagents work in this repository concurrently and commit as the same Git user. Mark authorship with a `Co-Authored-By` trailer. OpenAI Codex no longer works on this codebase (owner, 2026-10-10); its former paths (`apps/world/native/**`, `apps/world/scripts/**`, the process-plant reference-design wiki pages) are ordinary repository code.
- Each session or subagent develops in its own worktree on its own branch and lands on `main` only by fast-forward with checked commits. Expect `main` to advance with other sessions' commits; never revert or rewrite them. In a shared worktree commit explicit paths only; never use `git add -A`, `git commit -a`, `stash`, `reset --hard` or `clean`.
- Keep edits to shared files minimal and name them in the commit message: `bun.lock`, any `package.json`, `NOTICE.md`, `AGENTS.md` files, `apps/world/src/packs/process-plant/capabilities.ts`, `apps/world/vite.config.ts`, `apps/leitbild/deploy/**`.
- Only a session that validated a commit deploys it; subagents never push or deploy. Announce a deploy to other live sessions first, and do not deploy while another session's evaluation probe runs on production.
- The deployer packages working-tree files, including untracked ones. Never leave unfinished files in production paths of a worktree you deploy from.
- Before deploying: no other deploy may be running (`pgrep -f '^\S*bun\S* .*scripts/deploy\.ts'`), and production `DEPLOYMENT.json` must report `dirty: false` with a `baseCommit` that is an ancestor of the deployed commit, so a deploy never reverts another session's live work. Deploy from a clean worktree with `LEITBILD_KNOWLEDGE_REPOSITORY` pointing at a clean checkout of the wiki's committed `HEAD`.
