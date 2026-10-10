# LD-01 operating equations

This is the standalone Rust equation kernel selected by the approved
[computational review](https://leitbild.app/wiki?path=world%2Fpacks%2Fprocess-plant%2Freference-designs%2Fld-01%2Fmodel%2Fcomputational-design-review.md).
It is **offline preconstruction work**, not the live PWR Pack, a second runtime,
or a whole-plant simulation. The parent `leitbild-plant-numerics` crate retains
fine-model research evidence; it is not a dependency, fallback or preparation
requirement of this operating kernel.

## Implemented boundary

- Coupled regional kinetics with six delayed-neutron groups, arbitrary explicit
  regional topology and a common extensive population normalization. One
  material-owned precursor bank follows fuel; current emission shares feed the
  regions or explicit outside export. There is no second regional bank.
- Event-fed decay energy reservoirs with separate fission/capture feeds and
  non-overlapping prompt/stored energy budgets.
- I-135/Xe-135 and Pm-149/Sm-149 inventory equations with direct production and
  actual capture coefficients.
- Finite capture targets with shared target-loss, product and binding-energy
  receipts from the same actual exposure, not a fixed ratio to fissions.
- Analytic equation directions including constitutive input directions, with
  explicitly disclosed inexact property-coefficient and nonsmooth branches.
  A frozen-input derivative is not the complete coupled plant Jacobian.
- Additive fixed-input sparse kinetics Jacobian assembly in linear work, without
  evaluating the whole block once per column. Sum repeated diagonal entries;
  apply constitutive chain rules and the solver's mass shift separately.
- Nonlinear fuel/clad calorics, two-node fuel conduction, one finite helium
  store per assembly, three algebraic surfaces per material half and reciprocal
  core/guide/fitting/plenum/SG heat laws with current property directions.
- Pure-water separated liquid/steam and equilibrium SG charts, exact absence,
  Stefan conversion and opposite phase-volume work. Local elimination supplies
  pressure/phase-volume rates from actual retained stocks and heat receipts;
  this is not itself an event integrator or a qualified connected phase event.
- Current-material pump, friction and gravity force/work ports on the actual
  circulation graph. The selected bounded low-Mach thermal convention does not
  claim exact coolant kinetic/gravitational feedback into thermal stocks.
- Finite liquid surge-line mass/energy storage and reciprocal current-donor mass, thermal
  enthalpy and boron receipts, with independent inlet/outlet currents and its
  own thermodynamic pressure.
- Ten-region PZR phase-specific advection, bulk/contrast thermal conversion,
  interphase/solid drag and partial molecular face transport. Gravity belongs
  once to the local face mechanics, not to a second nodal force source.
  Exact zero-slip heat-transfer values retain their physical square-root cusp;
  the explicitly flagged coefficient direction there is inexact, not smoothed.
  Finite phase-receipt arithmetic exposes volume defects and cannot replace
  event roots, post-event EOS recovery or active-row consistency.
- Coarse local-pressure mechanics on the actual 38 volumes and 48 connections:
  finite retained M/U, local EOS constraints, physical section/radial inertia
  integrals, well-balanced pressure/gravity and current-donor phase transport.
  Generalized hydraulic impulse is not length times upwind mass current. Nodal
  velocity and nonpressure force use the same virtual-work projection, without
  a duplicate nodal momentum bank. Constituent checks are not advancement.

Compile immutable coefficients/topology once; evaluate into caller-owned
buffers without stage allocation. Signed finite Newton trials are distinct
from physical admission. Call the accepted-state **and accepted-input**
validators before admitting a converged result; do not clip a negative value
to manufacture success. On any evaluation error, discard the result/output
buffer. Physical mappings, uncertainty domains and error scales remain the
caller/engineering owner's responsibility.

Kinetics inputs include actual material fission conversion, current emission and
outside fractions, regional gain/source and directed coupling. The same actual
fission receipts feed energy and poison inventories. Geometry is not production
physics. The TypeScript source/energy/fluid compilers now consume actual wiki
coefficients, geometry, finite donor/history and caloric/property preparation.
The strict `prepare_hot` binary evaluates that same package through this kernel.
This is quantitative hot-reference preparation, not empirical plant calibration.
The static fuel compiler still does not supply moving topology admission or
pose derivatives.
The [state allocation](https://leitbild.app/wiki?path=world%2Fpacks%2Fprocess-plant%2Freference-designs%2Fld-01%2Fmodel%2Foperating-equations.md)
counts regional populations plus six histories per material carrier (`R+6A`),
not the first module's replaced `7R` regional inventory. It also records the
uniform two-metre emission approximation and unqualified physical domains.

There are no default plant coefficients, prescribed successful outcomes,
replacement water-property formulation or live Pack installation here.
Core tests use explicit synthetic equation fixtures; separate opt-in checks
consume the actual owner-generated package. Neither qualifies a connected LD-01.

## Actual hot preparation

The [hot-reference owner](https://leitbild.app/wiki?path=world%2Fpacks%2Fprocess-plant%2Freference-designs%2Fld-01%2Fmodel%2Foperating-hot-reference.md)
documents the quantitative source, finite 30-day material history and 2,710
finite solid/helium/SG-metal caloric stores. Its original 26 primary water owners
were replaced by the disjoint HOT.A carving: 27 primary owners, one finite SURGE
and ten PZR regions in the current 38-volume mechanics packet. Maintained
IF97 supplies preparation properties through the existing narrow adapter;
neither the parent fine crate nor its solver/checkpoint is used.

Build explicitly in this directory, then run the composer from the app root:

```sh
cargo build --release --locked --bin prepare_hot
```

```sh
bun apps/world/scripts/reference-design-operating-hot.ts /path/to/Leitbild-wiki /path/to/pinned-IF97 /path/to/operating/target/release/prepare_hot /path/to/private-receipt.json
```

The native boundary uses pinned maintained Serde/JSON decoding once during
preparation, never per stage. It rejects unknown fields, duplicate identities,
invalid finite donors, missing recipients and inconsistent energy/continuity
receipts. The source-off stationary comparator is separate from actual finite
precursor history and external source. A partial pressure check receives only
direct coolant deposition; it does not bypass fuel/clad energy storage.

This binary advances **no simulated time**. Actual mechanical/thermal law blocks
now exist. The [connected current-state subset](https://leitbild.app/wiki?path=world%2Fpacks%2Fprocess-plant%2Freference-designs%2Fld-01%2Fmodel%2Foperating-hot-spine.md)
composes current source, material/history, finite thermal and primary continuity
equations, with fixed-stock surface initialization and current input directions.
It is not complete unit `F(t,y,ydot)`: the separate local-pressure mechanical
pilot now composes inventory/PZR mechanics through stock IDA/KLU, but that
advancing assembly does not yet include this nuclear/thermal operator. Full
phase-event qualification, real actuation/acquisition and Grid remain joins—not
hidden fixtures, imposed successful outcomes or measured whole-plant throughput.
SG fluid charts are checked by the preparation helper/tests; the native package
currently consumes SG metal, not connected SG fluid evolution.

## Actual water and thermal equations (opt-in)

The separate `water-ffi` package links one narrow C ABI to the same pinned,
maintained IF97 source. The core remains unsafe-forbidden and does not depend on
this package or the parent research crate. Build in a trusted local artifact
directory; Cargo requires the archive and receipt but does not cryptographically
attest an independently substituted binary.

From the app root, then the package directory respectively:

```sh
bun apps/world/scripts/reference-design-operating-water.ts /path/to/pinned-IF97 /path/to/Leitbild-wiki /path/to/water-artifact
```

```sh
LD01_OPERATING_WATER_LIB_DIR=/path/to/water-artifact cargo test --locked
LD01_OPERATING_WATER_LIB_DIR=/path/to/water-artifact cargo test --locked --no-run --test actual_thermal
```

The latter prints the exact test executable. Supply that executable to the
actual owner-package test from the app root:

```sh
LD01_WIKI_ROOT=/path/to/Leitbild-wiki LD01_IF97_DIRECTORY=/path/to/pinned-IF97 LD01_OPERATING_THERMAL_TEST=/path/to/actual_thermal-executable bun test apps/world/scripts/reference-design-operating-thermal.test.ts
```

The harness compiles actual current owners, writes a temporary package, runs
the native real-property test and removes that temporary artifact. It checks
all 2,710 finite solid/helium/metal calorics, actual contact incidence, reciprocal
heat and an actual SG correlation/property direction. It reports the initial
zero-flow surface-seed defects and checks the separate fixed-stock surface
initializer; neither solving massless surfaces nor preserving the nonsteady
finite-metal discharge establishes a consistent whole-unit initial condition.
This is no elapsed-time result or production allocation benchmark.

The package's source/heat/temperature values describe one prepared point, not
mission forcing. `hot_spine` recomputes event/history heat and its directions
from the same current nuclear/material trial and exposes finite-energy caloric
constraints using these same thermal laws. Prepared cp cannot become a constant
mission capacity. Actual IF97 thermodynamic first partials are exact;
transport/cp/expansion coefficient directions use disclosed local inexact probes.

The owner-approved [energy reduction](https://leitbild.app/wiki?path=world%2Fpacks%2Fprocess-plant%2Freference-designs%2Fengineering%2Fdevelopment%2Fdecisions%2F0012-bounded-low-mach-energy.md)
pays delivered shaft power once into finite pump water, without a second friction
heater. Diagnostic fluid K and omitted mechanical feedback require local output
budgets before A3. [Decision 0013](https://leitbild.app/wiki?path=world%2Fpacks%2Fprocess-plant%2Freference-designs%2Fengineering%2Fdevelopment%2Fdecisions%2F0013-coarse-local-pressure.md)
replaces the unadmitted common-pressure mechanics with this same 38-volume
local-pressure network. It does not guarantee precise PZR regulation or admit
connected advancement before the phase and performance gates pass. No finer
acoustic mesh or acoustic research campaign is required.

The optional `water-ffi` feature `ida` adds original narrow ABI glue to explicitly
selected, unmodified SUNDIALS 7.5.0 IDA/KLU. Set
`LD01_OPERATING_SUNDIALS_PREFIX` to the verified absolute installation prefix.
It checks the double/64-bit-index ABI and runtime version, contains callback
panics, and fail-stops on fatal callbacks or failed solver operations. Observation
requests do not force integration steps; `stop_at` names an actual final/event
boundary. It does not import the parent research driver or its solver patches.
The opt-in `actual_local_flow` test is a mechanical pilot, not the full
nuclear/thermal/SG trajectory or whole-plant throughput evidence.

The pilot retains 328 coordinates: 38 local pressures, 76 phase masses,
76 phase energies, 38 liquid tracer amounts, 96 phase-path impulses and four
rotor momenta. All use the actual 38-volume/48-connection packet. Its current
two-second advancement gate is **failing**, not skipped into success: stock
IDA exhausts its per-call step allowance at 0.05504 simulated seconds.
The wiki readiness owner records the measured recurring cost and pressure-error
diagnosis. Do not raise that allowance or expand plant scope to hide the failure.

Property inversion values are reused only within one Jacobian build, keyed by
the exact current pressure, caloric target and phase. Current directions are
still evaluated; no value survives into another trial or matrix. Physical
absence remains zero M/U. The pilot retains and reports tiny raw zero-mass
energy defects against the existing numerical error scales, without clipping,
seeding mass or querying absent-phase properties. Significant defects fail.

Read-only IDA history/error getters do not change steps or solver settings.
Requested-time output may differ from the retained internal endpoint; inspect
the latter through `IDAGetDky(tn,0/1)` into independent buffers, not aliased
`IDAGetCurrentY/Yp` output storage. These observations are diagnostics, not
permission to suppress pressure error control without physical qualification.

Native property/package tests are opt-in through `LD01_WIKI_ROOT`,
`LD01_IF97_DIRECTORY` and `LD01_OPERATING_PREPARATION`. Ordinary Bun/application
checks do not require a Rust compiler, property installation or native build.

## Checks

Run from this directory to use the pinned Rust toolchain:

```sh
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
cargo fmt --all -- --check
bun run tests/build-boundary.ts
```

The build-boundary check examines Cargo's actual dependency graph. Core tests
must work without the parent crate's property backend, private SUNDIALS patch
or fine-model preparation. The solver join uses maintained stock IDA/KLU through
this narrow FFI, not the previous fine research driver. Boundary tests do not
qualify the composed plant residual or its sparse Jacobian.

## Progress and change control

The wiki's [batch progress ledger](https://leitbild.app/wiki?path=world%2Fpacks%2Fprocess-plant%2Freference-designs%2Fld-01%2Fmodel%2Fbuild-readiness.md#approved-plan-and-batch-progress)
is authoritative. Generic equation tests do not establish physical calibration,
hot-spine feasibility, real-time throughput or construction readiness.

Stop dependent work and return to the owner if a finding changes a promised
physical claim, selected state/coupling/solver architecture, or the agreed
feasibility/cost premise. Ordinary implementation defects should be fixed
within this plan. Do not silently reopen a microscopic simulation campaign,
extend an expensive experiment, or count unrelated test passes as plant closure.
