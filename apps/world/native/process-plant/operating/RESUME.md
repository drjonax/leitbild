# LD-01 native plant: pause record and resume brief

The owner paused LD-01 development on **11 October 2026**, to prioritise other work. This file is the starting point for whoever resumes it. The engineering record stays in the wiki: `ld-01/model/build-readiness.md`, under "Planning status", "Completion plan" and the 11 October decision records. This file holds the operational state: commits, branches, worktrees, environment, the resume order and the pitfalls.

## Starting prompt for the resuming agent

You are resuming LD-01 native-physics engineering as accountable lead.

- **Goal.** A credible operational PWR covering normal, abnormal and emergency operation. Four units plus World must run in real time on a 6–8 core Hetzner server.
- **Model.** A compact native Rust kernel, one index-1 DAE per unit, on stock SUNDIALS IDA/KLU and IF97, under decisions 0011–0015.
- **Prohibited:**
  - fakes, mocks or prescribed outcomes;
  - tolerance ladders, artificial damping or algebraic-error suppression;
  - step-cap evasion;
  - custom nonlinear solvers.
- **Change control.** Fix ordinary defects directly. A change to physical claims, state/coupling/solver architecture or a feasibility premise needs the owner.
- **Live LD-01 construction is NOT authorized.**

Before any work:
1. Read the root `AGENTS.md` and `apps/world/native/process-plant/operating/AGENTS.md`.
2. Read build-readiness's "Planning status", "Completion plan" and every section dated 11 October.
3. Read this file and the hand-off notes listed below.
4. Re-check the git and worktree state and the other live sessions. Several Claude sessions share this checkout and the wiki.
5. Ask the owner two things before acting on them:
   - **Delegation.** On 11 October the owner delegated representation, coupling and solver decisions to the lead ("proceed with your best judgement"). Does that still hold?
   - **Deploy rule.** Before the pause the rule was "no LD-01 deploy until the plant is finished". The owner then asked for a deploy at the pause. Which applies now?
6. Then give the owner a short assessment of the critical path and the first batch, and do not start long runs while writing it.

## State at the pause

**Plan steps:**
- **S1** (A2 hydraulics): **GREEN**.
  - Run 5 at app `0034a2fe`, wiki `d814f49`, packet row 8 `29f20849`.
  - An S1 run-6 pre-check on the integrated code passed every declared gate, with CPU provisional because of load.
  - The formal run 6 (G16) is still owed at the final packet, before any S2 gate run.
- **P2 PZR verification:**
  - gates 4–8 pass (seventh run, 493.9 of 1,200 CPU-s);
  - gate 2 (MIT) is a disclosed limit;
  - gate 3 (PACTEL) is designed but not implemented.
- **S2** (A2 joined spine): **IN PROGRESS, on the critical path.** The S2 declaration is unpublished: revision 6 has three critic blockers.
- **S3–S8:** not started.

**S2, what exists (landed):**
- The joined operator: 18,603 coordinates, with an exact consistent start on KLU and Z1 at 1e-12.
- The SG block, with an emergent p_s of 6.363 MPa (Z2) and relief seat transactions.
- 52 rod clusters with guide passages and moving volumes, and the R3 blend.
- Time events, and the ordered `discrete_restart` (restart residual 2.9e-14).
- The settling harness, with stock dcj 0.1 and coefficient 0.33, and a 1e-4 s first step.
- The block-analytic Jacobian: 43 ms against 892 ms colored. Its oracle matches to 5.8e-15 and G10 passes.
- The element-exact pattern (207,723 nnz) with KLU AMD: refactor about 4.2 ms.
- The reactivity-term split and the decomposition probe.

**S2, decided and not implemented.** Records are in build-readiness under "S2 hot-reference consistency":
- **G18.** Every solid store of each assembly is prepared at the steady state of the solids laws, with per-carrier Doppler references. The authored fuel, clad and helium temperatures are removed from `reference-operating-hot`.
  - Why: the 850 K Doppler reference against the 923.8 K settled fuel left p_s at about 5.7 MPa instead of 6.36.
  - **Method still open.** The binary written for it uses a per-assembly Newton, which three rules forbid (the operating crate's AGENTS.md, hot-spine page around :626, S1 deliverable 4). The critic's route: settle the solids sub-residual with **stock IDA** at frozen coolant and carrier power, as in S1 step (A), with a receipt. Otherwise take it to the owner.
- **G17 basis.** 2,992.5 MW, Z2's duty less RCP heat. If the re-settle misses 2e-3, re-base once.
- **G19.** The −2.35 pcm reference-pressure offset is disclosed. Follow-up: a design-flow preparation of the commissioned setpoint, 14.864187 MPa.
- **G6.** The PZR shell, heads, heater metal and relief in S2. Only the port acceptance exists, as WIP.

**Performance at the pause** (thread CPU; load was high all day, so use ratios):

| Item | Value |
| --- | --- |
| S2 residual | 1.32 ms before PERF. About 0.82–0.85 ms with PERF, best of several runs: this includes the WIP first guess and was not re-measured without it. The median is 0.9–1.2 ms under load. S1 residual is about 150 µs, down from 456 |
| Joined Jacobian | 43 ms |
| Refactor | 4.2 ms |
| Projected step today | about 15 ms (target 8; about 7.8 ms after JAC's ranked plan, with a Jacobian every 4 steps) |
| S2 quiet settling | about 0.006 CPU-s/s [E] |
| Trip-window gate (≤0.35 average) | decided by restart cost (below) |

- **Restart cost.** The critic's basis is the solid-limit case: about 11 Jacobians and 14 steps per restart. The window breaks even at about 14 restarts today and about 27 on JAC's path.
- **DONOR's candidates:**
  - The bounded cj-linear refresh cuts assemblies about 5×, but Newton failures rise (P2: 4 → 9). This is a resume-time decision.
  - The first step at min(h_pre, cap) is rejected for accuracy.
- **Still owed:** the count of distinct restart instants in an S2 trip probe.

## Where the code is

- **`main`:** `76d69d90` carries every finished LD-01 commit. It is the integration branch `claude/ld01-integ-2` (team landable commits plus `origin/main`) with this file on top. The LD-01 kernel stays unregistered and inert in production.
- **Unfinished work** is on these branches, pushed to GitHub. WIP commits sit on top of the landed commits.

| Branch | Landed up to | WIP on top |
| --- | --- | --- |
| `claude/ld01-s2-join` | `711c5372` | `2be5793b` G18 binary (forbidden Newton, kept for reference); `af833b8e` G18 TS stocks (incomplete, breaks the compilers); `60619a23` G6 port acceptance |
| `claude/ld01-cases-r4` | `1e8576cf` | `f15e7891`: per-instance tap sets and face rule; not yet reproduced bit for bit |
| `claude/ld01-perf` | `97cebc6d` | `530c47b4`: stable-end first guess. Inverses about 2× faster, but not bitwise identical. Landing it needs re-recorded digests, BUBBLE's bound re-qualified and S1 re-admitted |
| `claude/ld01-jac` | `9f4b0dee` | none |
| `claude/ld01-donor-firststep` | not for landing | env-gated first-step probe |

- **Older diagnostic branches,** pushed as history: `claude/ld01-donor`, `claude/ld01-p2-core`, `claude/ld01-p2-s1`, `claude/ld01-p2-s1diag`.
- **Wiki.** `claude/ld01-wiki` is merged into wiki `main` and published. Keep unpublished on `claude/ld01-s2join-wiki` until G18 lands with them:
  - `62a04bf`, `b33c212`, `c12edd8` (the kinetics.md re-base ×2,992.5/2,928.922009) and `f34572c`.
  - These are the G17, G18 and G19 owner-page drafts.
- **The wiki repository (`../Leitbild-wiki`) has no git remote.** A bundle of every branch is in the pause archive.

## Hand-off notes and evidence

All research paths are under `../Leitbild-research/reference-designs/property-candidates/`. That directory is not git: never overwrite a receipt.

- `operating-joined-spine-s2/handoff/s2-join.md`: S2-JOIN's next steps, G18 method, G6 plan and pitfalls.
- `operating-joined-spine-s2/handoff/jac.md`: costs, the ranked Jacobian plan and pitfalls.
- `operating-joined-spine-s2/handoff/perf.md`: PERF's bitwise evidence, the non-bitwise first guess and the ranked residual plan.
- `operating-joined-spine-s2/handoff/pm-stage5-review.md`: the critic's stage-5 findings on S2 revision 6. These are the input to revision 7.
- `operating-joined-spine-s2/handoff/donor.md`: restart-cost candidates.
- `operating-pzr-p2/handoff/cases.md`: the P2 gate status, K7 in code, and PACTEL's implementation steps.
- `operating-joined-spine-s2/s2-declaration-draft.md`: SPEC's S2 declaration, revision 6.
- `operating-joined-spine-s2/zero-time/`: S2 receipts. These are not evidence; S2 is not declared:
  - Z1, Z2, Z4, Z5, Z7;
  - packet `joined-packet-9eb6e37d.json`;
  - `settling-probe-4-receipt.json`;
  - `reactivity-decomposition-1-receipt.json`;
  - `settled-state-600s-1.json`, for Z3.
- `operating-pzr-p2/`:
  - the S1 run-5 receipt and packet row 8;
  - `cases/`, the seventh run at top level;
  - `diagnostics/`, DONOR, JAC and CASES probes.
- `../Leitbild-ld01-pause-2026-10-11/`, the pause archive:
  - a wiki git bundle with every branch;
  - research receipts and evidence as tar.gz, without build output;
  - a copy of this file.
  - Copy it off-machine.

## Resume order

1. **Environment.**
   - Cargo build output was deleted at the pause, so the first builds take minutes.
   - Recreate `LD01_WIKI_ROOT` from a `git archive` of the wiki commit.
   - Set `LD01_OPERATING_SUNDIALS_PREFIX=$R/ida-klu.0A9pxf/prefix`.
   - For IDAS ledger builds, use `$R/idas-klu-7.5.0/prefix` with `--features quadratures`.
   - Set `LD01_OPERATING_WATER_LIB_DIR`. Water builds are not byte-reproducible, and each receipt names its build:
     - `operating-water-band`: S1 run 5;
     - `water-04da004`: P2;
     - `operating-water-integ-<commit>`: the integrated code.
   - Rebuild the water library when PERF's or the water-ffi sources change.
   - Run JAC's `joined_blocks_profile` first, so Z5 is current after the exact pattern.
   - The integrated code's water library is `operating-water-integ-76d69d90`.
2. **G18 by an allowed method,** following s2-join.md steps 1–2.
   - Compile the packet twice and `cmp` the two.
   - Report the role-F spread, the node spread and the solid rates.
   - Check Z1 at 1e-12.
   - Publish the G17, G18 and G19 wiki drafts with it.
3. **G6.**
   - Add the network PZR boundary hook and the joined PZR block, with heaters per P4.
   - Pass the boundary through to JAC's `pzr_rows`, which hardcodes it closed.
4. **One re-settle** with G6, G17 and G18.
   - Report p_s against 6.36 MPa, the primary against 563/593 K, power against the 2e-3 ceiling, the approach fits and the prepared decomposition.
   - Propose the settling cap against the critic's thresholds, each at most half its hold ceiling: PT1 and SG pressure ≤345 Pa, average coolant ≤3.4 mK, PZR level ≤0.7 mm and SG liquid ≤3.4e-3 m³, all per 20 s.
5. **Z3 at the settled state,** plus G10's spectrum. D3 (a)'s margin shrinks by about 145–150 pcm.
6. **S2 declaration revision 7** (SPEC), fixing pm-stage5-review.md:
   - fold in G18;
   - the settling thresholds;
   - restart projection and caps from the solid-limit basis, counted from actual trip roots;
   - stock IDA for the steady solve;
   - root-return attribution;
   - one Z7 scheme.
   Then the critic re-reviews it, then publish.
7. **Cost path, in parallel:**
   - JAC's ranked plan: rods per affected cluster about −14 ms, property reuse, compiled scopes, CSC positions, the PERF memo, remaining zeros;
   - PERF's plan;
   - S2-JOIN wraps its solids' properties in `thermal::Shared` (bitwise; PERF's item 1);
   - the decision on PERF's first guess (WIP `530c47b4`);
   - the restart-cost decision (bounded refresh);
   - the count of distinct trip restart instants.
8. **Quiet window.** Run S1 run 6 at the final packet, then the S2 gate run, with the other teams paused.
9. **P2, in parallel:**
   - put K7 in the ledger code;
   - reproduce `f15e7891` bit for bit and promote it;
   - PACTEL steps 3–7 in cases.md.

## Disclosed limits and open fidelity questions

- **G19:** the reference coolant is at 15.2 MPa against the composed 15.02 MPa, giving −2.35 pcm.
- **Fuel references:** two at-power fuel references sit about 95 K apart: the operating one at about 925 K and the distributed handoff's at 832.64 K.
- **SG metal:** it pushes 7.45 GW into the secondary at t = 0 against 3.0 GW of demand, so the impulsive start remains in part.
- **Gap accommodation** is evaluated at a fixed 650 K, which is about 0.2–0.4 pcm.
- **Decision 0013 AMD:** used on S2 only. S1 and P2 stay on COLAMD.
- **Carried from before:**
  - MIT is a limit (G1 (b));
  - the S6 Schiller–Naumann jump;
  - the R3 band current, about 6.6e-3 kg/s over all clusters.

## Ways of working that held up

- One team per stream, each in its own worktree under `../Leitbild-native-*` on a `claude/ld01-*` branch. Teams merge `main` often.
- An integration lane (`claude/ld01-integ*`) finds conflicts and regressions early.
- An independent critic reviews every owner request, declaration and delegated decision before it is published. It caught real errors each time.
- Receipts are new files with provenance (app, wiki, packet and water hashes). Check each receipt's rate fields against `reached_s`.
- CPU gates are judged only in a quiet window. Under load, CPU figures are provisional, and counts are what matter.
- At milestones, update the tracker, "LD-01 Build Tracker": https://claude.ai/artifact/7vrMbS9KRBZdjM4tbRqWbf.

## Pitfalls

- **Exact pattern and COLAMD.** COLAMD with the exact pattern takes 242 ms. Every joined `System` wrapper must forward `klu_ordering()`.
- **Phase presence.** The exact pattern assumes the phase presence at compile time. A vapor birth refuses loudly, so S3 must recompile per mode.
- **`joined_spine.rs`** builds only with `--features ida`.
- **Rebuilding during a probe.** Don't rebuild water-ffi tests while a probe binary runs. Use another `CARGO_TARGET_DIR`.
- **The P2 harness** reads strict blocks from the **HEAD** of `LD01_WIKI_ROOT`, not from its working tree.
- **Formatting.** Use `rustfmt --edition 2024 <files>`, never `cargo fmt --all`, in shared crates.
- **Bun tests and LD-01 variables.** Run `bun run test` without the LD01 environment variables. Exporting `LD01_WIKI_ROOT` without `LD01_IF97_DIRECTORY` makes four World tests refuse the half-set state.
- **Deploys.**
  - The deployer packages working-tree files, including untracked ones. Deploy only from a clean, detached deploy worktree (`../Leitbild-claude-deploy`), with `LEITBILD_KNOWLEDGE_REPOSITORY` pointing at a clean checkout of wiki `main`.
  - Before deploying: no other deploy is running, and production `DEPLOYMENT.json` reports `dirty: false` with a `baseCommit` that is an ancestor of the commit being deployed.
