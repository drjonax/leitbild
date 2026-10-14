//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#exact-consistent-start-of-the-joined-residual
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#initialization-and-pressure-projection-have-limited-roles
//! Machine-enforced solver prohibitions (LD-01 resume plan P5).
//!
//! The operating crates integrate with stock SUNDIALS IDA and factor with
//! stock KLU only. This test reads every Rust and C source of both operating
//! crates (`src`, `tests`, `water-ffi/{src,tests,build.rs}`, binaries
//! included; comments and string contents are blanked first, so prose never
//! matches) and refuses the shapes custom nonlinear-solver code takes:
//!
//! | Rule | Shape it refuses |
//! | --- | --- |
//! | `iteration` | A loop that re-evaluates something at an iterate it updates and stops on convergence: a variable declared before the loop (or a `&mut`/`mut` parameter) is assigned in the loop and read back into a call, a `let` or another update in the same loop, and the loop either stops on a comparison against a tolerance (`*tol*`, `*eps*`, `*converg*`, `*bound*`, `*thresh*`, a negative-exponent literal, `next_down`/`next_up`) or a `residual`/`defect`/`correction` (a `while` head, or an `if` guarding `break` or a non-`Err` `return`, directly or through a flag bound in the loop), or brackets the iterate by a midpoint `0.5 * (a + b)`, `(a + b) / 2` or `.midpoint(`. Newton, secant, bisection, regula falsi and fixed-point (Picard) loops all have this shape. |
//! | `damping` | A variable declared before a loop and shrunk in it by a constant factor (`x *= 0.5`, `x /= 2.`, `x = 0.5 * x`): backtracking, step halving, damping. A `damp*`/`relax*`/`omega` identifier inside an update in a loop (relaxation of a solver update). A binding named after a globalisation device (`backtrack`, `line_search`, `armijo`, `wolfe`, `trust_region`, `under_relax`, `over_relax`). |
//! | `tolerance-ladder` | A loop over tolerances (`for tol in …`), or a tolerance variable rescaled inside a loop. |
//! | `step-cap-evasion` | A failure arm inside a loop (`Err(..) =>`, `if let Err(..)`, `.is_err()`) that changes an integrator control (`set_max_step`, `remove_max_step`, `set_init_step`, `set_max_order`, `set_delta_cj_lsetup`, `set_nonlinear_convergence_coefficient`, `set_linear_solution_scaling`, `constrain_nonnegative`, `stop_at`), a tolerance, or a cap/limit/budget variable; a cap/limit/budget/deadline/max-steps variable raised inside a loop. |
//! | `solver-api` | A SUNDIALS, KINSOL or SuiteSparse identifier in C glue or Rust that is not on the pinned list of what the stock IDA/KLU wrappers use (`ida.c`, `ida.rs`, `klu.rs`), or any identifier of KINSOL (`KIN*`), a custom `SUNNonlinSol*`, `IDASetNonlinearSolver`, or IDA's algebraic-error suppression (`IDASetSuppressAlg`), anywhere. |
//! | `dependency` | A crate dependency beyond `serde`, `serde_json` and the operating crate itself (a solver crate would arrive this way). |
//!
//! Iterations that existed and were reviewed before this guard are listed in
//! [`ALLOWED`] by file, function and rule with the exact number of findings,
//! and each names why it is not a solver of the plant equations: scalar
//! constitutive inverses bracketed to machine precision, the declared exact
//! consistent start (Newton on `g(y) = 0` with `dg/dy_a`, never on the DAE),
//! the declared preparations and the startup surface initializer. A new
//! finding, a changed count, or a listed entry that no longer occurs fails
//! the test and prints the file, function, rule and line. Adding an entry is
//! a lead decision: the plan's rule is "stock SUNDIALS IDA/KLU only".
//!
//! `planted_*` tests feed known solver shapes (the paused G18 per-assembly
//! damped Newton among them) through the same analysis and require each to
//! be caught, and legitimate shapes (accumulations, searches, time loops,
//! event restarts) not to be.
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

// ---------------------------------------------------------------- allowlist

/// `(file relative to operating/, function, rule, findings, why)`.
const ALLOWED: &[(&str, &str, &str, usize, &str)] = &[
    // Scalar constitutive inverses: one unknown, bracketed, to machine
    // precision, inside a property or closure evaluation. None advances or
    // settles the plant state.
    (
        "water-ffi/src/lib.rs",
        "newton",
        "iteration",
        1,
        "IF97 caloric inverse T(p, u|h): safeguarded Newton in one bracket to 2e-12 (water-ffi IF97 boundary)",
    ),
    (
        "src/thermal.rs",
        "fuel_temperature",
        "iteration",
        1,
        "UO2 caloric inverse T(u): safeguarded scalar Newton in 290-2000 K to 2e-12",
    ),
    (
        "src/hydraulics.rs",
        "pipe_darcy",
        "iteration",
        1,
        "Colebrook friction factor x = 1/sqrt(f): monotone scalar iteration to 4 eps",
    ),
    (
        "src/network/stratified.rs",
        "terminal_velocity",
        "iteration",
        1,
        "bubble terminal velocity Re(Ar): monotone scalar Newton from the Stokes value to 4 eps",
    ),
    (
        "src/network/heaters.rs",
        "minimum_film_endpoint",
        "iteration",
        1,
        "heater minimum-film endpoint Tm: bisection of a bracketed scalar to machine precision",
    ),
    (
        "src/sg/tube.rs",
        "stationary",
        "iteration",
        1,
        "SG tube stationary wall temperature: bracketed scalar Newton to 1e-12 (zero-time preparation diagnostic)",
    ),
    (
        "src/rods/mod.rs",
        "passage_current",
        "iteration",
        3,
        "rod guide passage current: bracket expansion (two loops) and bracketed scalar Newton on a monotone balance to 1e-12 of its row scale",
    ),
    // The declared exact consistent start (operating-hot-spine.md, "Exact
    // consistent start"): Newton on the algebraic constraints g(y) = 0 with
    // the system's own dg/dy_a, differential coordinates bitwise fixed, the
    // correction's WRMS at most 1; never on the DAE residual.
    (
        "src/network/jacobian.rs",
        "project_constraints",
        "iteration",
        1,
        "declared exact consistent start: constraint projection (decision 0013 exit)",
    ),
    // The declared preparations (operating-hot-spine.md, "Composed state at
    // the hot reference"): EOS-consistent hydrostatic pressures by passes to
    // the declared pressure tolerance, before any time is advanced.
    (
        "src/network/prepare.rs",
        "prepare",
        "iteration",
        1,
        "declared hydrostatic preparation: pressure passes to settings.pressure_tolerance_pa",
    ),
    (
        "src/network/stratified.rs",
        "prepare",
        "iteration",
        1,
        "stratified PZR cell hydrostatic preparation: pressure passes to pressure_tolerance_pa",
    ),
    // The declared flowing preparation: each face's impulse I(rho) Q and the
    // pressures integrated along the hydrostatic spanning tree, by passes to
    // the declared pressure tolerance.
    (
        "src/network/prepare.rs",
        "compose_flows",
        "iteration",
        1,
        "declared flowing preparation: tree pressure passes to the declared tolerance",
    ),
    (
        "water-ffi/src/joined.rs",
        "consistent_start_exempting",
        "iteration",
        2,
        "declared exact consistent start of the joined residual: KLU constraint projection passes and rate passes (lead decision S2-D21: up to 12 passes after an owner transaction)",
    ),
    (
        "water-ffi/src/lib.rs",
        "from_stable_end",
        "iteration",
        1,
        "caloric inverse first guess from the stable end (lead decision S2-D5): Newton on one scalar temperature inside the branch bracket, None falls back to the full bracketed inverse",
    ),
    (
        "src/thermal.rs",
        "liquid_wall_current",
        "iteration",
        1,
        "wet/film turnover temperature of the wall law: bisection of a bracketed scalar (memoised)",
    ),
    // The startup surface initializer (operating-hot-spine.md,
    // "Initialization and pressure projection have limited roles"): three
    // massless surfaces per half at fixed finite stocks, a 2x2 + 1 Newton
    // with residual-decrease backtracking. It predates this guard; it is the
    // one damped iteration in the tree and is reported to the lead.
    (
        "src/initialization.rs",
        "initialize_fuel_surfaces",
        "iteration",
        2,
        "startup fixed-stock surface initializer (three massless surfaces only) and its backtracking loop",
    ),
    (
        "src/initialization.rs",
        "initialize_fuel_surfaces",
        "damping",
        1,
        "its residual-decrease backtracking (damping *= 0.5)",
    ),
    (
        "src/initialization.rs",
        "<item>",
        "damping",
        1,
        "SurfacePolicy::maximum_backtracks, the initializer's backtracking bound",
    ),
    // Test oracles and probe helpers: scalar root-finds that compute a
    // reference value to compare against, never a plant state.
    (
        "water-ffi/tests/metastable.rs",
        "saturated_vapor_at_8_to_9_mpa_is_representable_by_the_inverse",
        "iteration",
        1,
        "test oracle: (u, v) -> p by scalar Newton to show the inverse's representability",
    ),
    (
        "water-ffi/tests/perf_profile.rs",
        "iterations",
        "iteration",
        1,
        "PERF measurement: replays the IF97 inverse to count its iterations",
    ),
    (
        "water-ffi/tests/thermo_identity.rs",
        "full_point_inverse",
        "iteration",
        1,
        "PERF identity oracle: the IF97 inverse's reference copy for bitwise comparison",
    ),
    (
        "water-ffi/tests/sg_z2.rs",
        "root",
        "iteration",
        1,
        "Z2 probe: SG duty-balance pressure by bisection to 1e-4 Pa (a reported sweep)",
    ),
    (
        "water-ffi/tests/s2_rods_z4.rs",
        "terminal",
        "iteration",
        1,
        "Z4 probe: rod terminal velocity by bisection (a reported force balance)",
    ),
    (
        "water-ffi/tests/s2_rods_z4.rs",
        "z4_zero_time_rod_force_balance",
        "iteration",
        1,
        "Z4 probe: analytic oscillator crossing time by bisection",
    ),
    (
        "water-ffi/tests/heater_rods.rs",
        "boundary",
        "iteration",
        1,
        "test oracle: adjacent floats on either side of a boiling-mode boundary",
    ),
];

/// The narrow FFI surface (crate rule: "maintained stock IDA/KLU and a
/// narrow property/solver FFI remain selected; changes require owner
/// review"): every SUNDIALS, KINSOL or SuiteSparse identifier of the C glue
/// and every foreign function `water-ffi/src` declares. A new name is a new
/// solver control or boundary and fails until it is reviewed and pinned.
const SOLVER_API: &[&str] = &[
    // Stock IDA/IDAS (ida.c).
    "IDACalcIC",
    "IDACreate",
    "IDAFree",
    "IDAGetConsistentIC",
    "IDAGetCurrentOrder",
    "IDAGetCurrentStep",
    "IDAGetCurrentTime",
    "IDAGetDky",
    "IDAGetErrWeights",
    "IDAGetEstLocalErrors",
    "IDAGetLastOrder",
    "IDAGetLastStep",
    "IDAGetNumErrTestFails",
    "IDAGetNumGEvals",
    "IDAGetNumJacEvals",
    "IDAGetNumLinSolvSetups",
    "IDAGetNumNonlinSolvConvFails",
    "IDAGetNumNonlinSolvIters",
    "IDAGetNumResEvals",
    "IDAGetNumSteps",
    "IDAGetQuad",
    "IDAGetQuadDky",
    "IDAGetRootInfo",
    "IDAInit",
    "IDAQuadInit",
    "IDAQuadReInit",
    "IDAReInit",
    "IDARootInit",
    "IDASVtolerances",
    "IDASetConstraints",
    "IDASetDeltaCjLSetup",
    "IDASetId",
    "IDASetInitStep",
    "IDASetJacFn",
    "IDASetLinearSolutionScaling",
    "IDASetLinearSolver",
    "IDASetMaxOrd",
    "IDASetMaxStep",
    "IDASetNonlinConvCoef",
    "IDASetQuadErrCon",
    "IDASetStopTime",
    "IDASetUserData",
    "IDASolve",
    "IDA_ILL_INPUT",
    "IDA_MEM_FAIL",
    "IDA_NORMAL",
    "IDA_ONE_STEP",
    "IDA_YA_YDP_INIT",
    // Stock N_Vector, SUNContext, SUNMatrix and SUNLinSol_KLU (ida.c).
    "N_VClone",
    "N_VDestroy",
    "N_VGetArrayPointer",
    "N_VGetLength",
    "N_VNew_Serial",
    "N_Vector",
    "SUNContext",
    "SUNContext_Create",
    "SUNContext_Free",
    "SUNDIALSGetVersionNumber",
    "SUNDIALS_VERSION_MAJOR",
    "SUNDIALS_VERSION_MINOR",
    "SUNDIALS_VERSION_PATCH",
    "SUNFALSE",
    "SUNLinSolFree",
    "SUNLinSol_KLU",
    "SUNLinSol_KLUSetOrdering",
    "SUNLinearSolver",
    "SUNMatDestroy",
    "SUNMatrix",
    "SUNSparseMatrix",
    "SUNSparseMatrix_Data",
    "SUNSparseMatrix_IndexPointers",
    "SUNSparseMatrix_IndexValues",
    "SUNTRUE",
    "SUN_COMM_NULL",
    // Stock KLU of SuiteSparse 7.12.3 (ida.c's direct SparseLu).
    "klu_l_analyze",
    "klu_l_common",
    "klu_l_defaults",
    "klu_l_factor",
    "klu_l_free_numeric",
    "klu_l_free_symbolic",
    "klu_l_numeric",
    "klu_l_rcond",
    "klu_l_refactor",
    "klu_l_solve",
    "klu_l_symbolic",
    "klu_version",
    // The wrappers' own C ABI (ida.rs, klu.rs extern blocks over ida.c).
    "operating_ida_advance",
    "operating_ida_create",
    "operating_ida_current_state",
    "operating_ida_current_time",
    "operating_ida_delta_cj",
    "operating_ida_dense",
    "operating_ida_differential",
    "operating_ida_error_diagnostics",
    "operating_ida_free",
    "operating_ida_init_step",
    "operating_ida_initialize",
    "operating_ida_klu_ordering",
    "operating_ida_max_order",
    "operating_ida_max_step",
    "operating_ida_newton_coefficient",
    "operating_ida_nonnegative",
    "operating_ida_quadrature",
    "operating_ida_quadrature_at",
    "operating_ida_quadrature_init",
    "operating_ida_quadrature_reinit",
    "operating_ida_quadratures_linked",
    "operating_ida_reinitialize",
    "operating_ida_root_directions",
    "operating_ida_solution_scaling",
    "operating_ida_stats",
    "operating_ida_step",
    "operating_ida_stop_at",
    "operating_klu_analyze",
    "operating_klu_factor",
    "operating_klu_free",
    "operating_klu_rcond",
    "operating_klu_refactor",
    "operating_klu_solve",
    // The maintained IF97 adapter's C ABI (lib.rs).
    "ld01_water_bracket",
    "ld01_water_caloric",
    "ld01_water_complete",
    "ld01_water_direction",
    "ld01_water_direction_exact",
    "ld01_water_direction_held",
    "ld01_water_fields",
    "ld01_water_metastable_band",
    "ld01_water_point",
    "ld01_water_surface",
    "ld01_water_vapor_sat_density",
    // LAPACK's generalized eigenproblem for the zero-time spectrum (spectrum.rs;
    // Accelerate on macOS). Not a solver of F(y) = 0.
    "dggev",
    "ilaver",
];

/// libc CPU clocks a source may declare for its own measurements (a
/// binary's stderr timing): not solver API, accepted outside the pin.
const MEASUREMENT_CLOCKS: &[&str] = &["clock_gettime", "getrusage"];

/// Crate dependencies of both operating crates.
const DEPENDENCIES: &[&str] = &["leitbild-operating-plant", "serde", "serde_json"];

// ------------------------------------------------------------------- lexer

#[derive(Clone, Copy, Debug, PartialEq)]
enum Kind {
    Ident,
    Number,
    Punct,
    Literal,
    Lifetime,
}
#[derive(Clone, Debug)]
struct Token {
    kind: Kind,
    text: String,
    line: usize,
}

/// Rust (and C) tokens with comments dropped and string and character
/// contents reduced to an empty `Literal`.
fn lex(source: &str) -> Vec<Token> {
    let c: Vec<char> = source.chars().collect();
    let n = c.len();
    let (mut i, mut line, mut out) = (0, 1, Vec::new());
    let ident_start = |x: char| x.is_alphabetic() || x == '_';
    let ident_char = |x: char| x.is_alphanumeric() || x == '_';
    let push =
        |out: &mut Vec<Token>, kind, text: String, line| out.push(Token { kind, text, line });
    while i < n {
        let x = c[i];
        if x == '\n' {
            line += 1;
            i += 1;
        } else if x.is_whitespace() {
            i += 1;
        } else if x == '/' && c.get(i + 1) == Some(&'/') {
            while i < n && c[i] != '\n' {
                i += 1;
            }
        } else if x == '/' && c.get(i + 1) == Some(&'*') {
            let mut depth = 0;
            while i < n {
                if c[i] == '/' && c.get(i + 1) == Some(&'*') {
                    depth += 1;
                    i += 2;
                } else if c[i] == '*' && c.get(i + 1) == Some(&'/') {
                    depth -= 1;
                    i += 2;
                    if depth == 0 {
                        break;
                    }
                } else {
                    if c[i] == '\n' {
                        line += 1;
                    }
                    i += 1;
                }
            }
        } else if x == '"' {
            let start = line;
            i += 1;
            while i < n && c[i] != '"' {
                if c[i] == '\\' {
                    i += 1;
                }
                if i < n && c[i] == '\n' {
                    line += 1;
                }
                i += 1;
            }
            i += 1;
            push(&mut out, Kind::Literal, String::new(), start);
        } else if x == '\'' {
            // A character literal, or a lifetime or label.
            if c.get(i + 1) == Some(&'\\') {
                i += 2;
                while i < n && c[i] != '\'' {
                    i += 1;
                }
                i += 1;
                push(&mut out, Kind::Literal, String::new(), line);
            } else if c.get(i + 2) == Some(&'\'') {
                i += 3;
                push(&mut out, Kind::Literal, String::new(), line);
            } else {
                let start = i;
                i += 1;
                while i < n && ident_char(c[i]) {
                    i += 1;
                }
                push(&mut out, Kind::Lifetime, c[start..i].iter().collect(), line);
            }
        } else if ident_start(x) {
            let start = i;
            while i < n && ident_char(c[i]) {
                i += 1;
            }
            let word: String = c[start..i].iter().collect();
            // Raw, byte and C strings: r"..", r#".."#, b"..", br"..", c"..".
            let raw = matches!(word.as_str(), "r" | "br" | "cr");
            let prefixed = matches!(word.as_str(), "b" | "c");
            if (raw || prefixed) && i < n && (c[i] == '"' || (raw && c[i] == '#')) {
                let start_line = line;
                let mut hashes = 0;
                while i < n && c[i] == '#' {
                    hashes += 1;
                    i += 1;
                }
                i += 1; // opening quote
                loop {
                    if i >= n {
                        break;
                    }
                    if c[i] == '\n' {
                        line += 1;
                    }
                    if !raw && c[i] == '\\' {
                        i += 2;
                        continue;
                    }
                    if c[i] == '"' && (0..hashes).all(|k| c.get(i + 1 + k) == Some(&'#')) {
                        i += 1 + hashes;
                        break;
                    }
                    i += 1;
                }
                push(&mut out, Kind::Literal, String::new(), start_line);
            } else {
                push(&mut out, Kind::Ident, word, line);
            }
        } else if x.is_ascii_digit() {
            let start = i;
            while i < n && (c[i].is_ascii_alphanumeric() || c[i] == '_') {
                // An exponent's sign belongs to the number.
                if (c[i] == 'e' || c[i] == 'E')
                    && !c[start..i]
                        .iter()
                        .any(|d| *d == 'x' || *d == 'b' || *d == 'o')
                    && matches!(c.get(i + 1), Some('+') | Some('-'))
                {
                    i += 1;
                }
                i += 1;
                if i < n && c[i] == '.' {
                    let next = c.get(i + 1).copied().unwrap_or(' ');
                    let fraction = next.is_ascii_digit();
                    if fraction || !(next == '.' || ident_start(next)) {
                        i += 1;
                    }
                }
            }
            push(&mut out, Kind::Number, c[start..i].iter().collect(), line);
        } else {
            const OPERATORS: [&str; 22] = [
                "<<=", ">>=", "...", "..=", "::", "->", "=>", "==", "!=", "<=", ">=", "&&", "||",
                "+=", "-=", "*=", "/=", "%=", "^=", "&=", "|=", "..",
            ];
            let rest: String = c[i..(i + 3).min(n)].iter().collect();
            let op = OPERATORS
                .iter()
                .find(|o| rest.starts_with(**o))
                .map_or_else(|| x.to_string(), |o| o.to_string());
            i += op.chars().count();
            push(&mut out, Kind::Punct, op, line);
        }
    }
    out
}

// ---------------------------------------------------------------- analysis

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Finding {
    function: String,
    rule: &'static str,
    line: usize,
    what: String,
}

const KEYWORDS: [&str; 16] = [
    "if", "while", "match", "return", "in", "for", "let", "loop", "else", "as", "mut", "ref",
    "move", "break", "continue", "where",
];
const ASSIGN: [&str; 5] = ["=", "+=", "-=", "*=", "/="];
const COMPARE: [&str; 4] = ["<", ">", "<=", ">="];
const CONTROLS: [&str; 9] = [
    "set_max_step",
    "remove_max_step",
    "set_init_step",
    "set_max_order",
    "set_delta_cj_lsetup",
    "set_nonlinear_convergence_coefficient",
    "set_linear_solution_scaling",
    "constrain_nonnegative",
    "stop_at",
];

fn is(t: &Token, text: &str) -> bool {
    t.text == text && t.kind != Kind::Literal
}
fn lower(t: &Token) -> String {
    t.text.to_ascii_lowercase()
}
/// Index of the bracket closing the one opened at `open`.
fn close(t: &[Token], open: usize) -> usize {
    let (o, c) = match t[open].text.as_str() {
        "(" => ("(", ")"),
        "[" => ("[", "]"),
        _ => ("{", "}"),
    };
    let mut depth = 0;
    for (k, x) in t.iter().enumerate().skip(open) {
        if is(x, o) {
            depth += 1;
        } else if is(x, c) {
            depth -= 1;
            if depth == 0 {
                return k;
            }
        }
    }
    t.len() - 1
}
/// First `{` at bracket depth zero from `from`, unless a `;` comes first.
fn body_open(t: &[Token], from: usize) -> Option<usize> {
    let mut depth = 0i32;
    for (k, x) in t.iter().enumerate().skip(from) {
        match x.text.as_str() {
            "(" | "[" if x.kind == Kind::Punct => depth += 1,
            ")" | "]" if x.kind == Kind::Punct => depth -= 1,
            ";" if x.kind == Kind::Punct && depth <= 0 => return None,
            "{" if x.kind == Kind::Punct && depth <= 0 => return Some(k),
            _ => {}
        }
    }
    None
}
/// End of the statement or expression starting at `from`: a `;` or `,` at
/// depth zero, or the bracket closing an enclosing one.
fn statement_end(t: &[Token], from: usize, limit: usize) -> usize {
    let mut depth = 0i32;
    for (k, x) in t.iter().enumerate().take(limit).skip(from) {
        if x.kind != Kind::Punct {
            continue;
        }
        match x.text.as_str() {
            "(" | "[" | "{" => depth += 1,
            ")" | "]" | "}" => {
                if depth == 0 {
                    return k;
                }
                depth -= 1;
            }
            ";" | "," if depth == 0 => return k,
            _ => {}
        }
    }
    limit
}

struct Function {
    name: String,
    signature: usize,
    open: usize,
    close: usize,
}
fn functions(t: &[Token]) -> Vec<Function> {
    let mut out = Vec::new();
    for k in 0..t.len().saturating_sub(1) {
        if is(&t[k], "fn")
            && t[k + 1].kind == Kind::Ident
            && let Some(open) = body_open(t, k + 2)
        {
            out.push(Function {
                name: t[k + 1].text.clone(),
                signature: k,
                open,
                close: close(t, open),
            });
        }
    }
    out
}
fn enclosing(functions: &[Function], at: usize) -> Option<&Function> {
    functions
        .iter()
        .filter(|f| f.open <= at && at <= f.close)
        .max_by_key(|f| f.open)
}

struct Loop {
    keyword: usize,
    open: usize,
    close: usize,
}
fn loops(t: &[Token]) -> Vec<Loop> {
    let mut out = Vec::new();
    for (k, x) in t.iter().enumerate() {
        if x.kind != Kind::Ident || !matches!(x.text.as_str(), "loop" | "while" | "for") {
            continue;
        }
        let Some(open) = body_open(t, k + 1) else {
            continue;
        };
        // `impl Trait for Type {` and `for<'a>` are not loops.
        if x.text == "for" && !t[k + 1..open].iter().any(|y| is(y, "in")) {
            continue;
        }
        out.push(Loop {
            keyword: k,
            open,
            close: close(t, open),
        });
    }
    out
}

/// A tolerance-like operand: a name, a negative-exponent literal or a
/// machine-precision bracket test.
fn tolerance_marker(x: &Token) -> bool {
    let w = lower(x);
    match x.kind {
        Kind::Number => w.contains("e-"),
        Kind::Ident => {
            [
                "tol",
                "eps",
                "converg",
                "bound",
                "thresh",
                "residual",
                "defect",
                "correction",
            ]
            .iter()
            .any(|m| w.contains(m))
                || w == "next_down"
                || w == "next_up"
        }
        _ => false,
    }
}
fn convergence_test(cond: &[Token], flags: &BTreeSet<String>) -> bool {
    (cond.iter().any(|x| COMPARE.iter().any(|c| is(x, c))) && cond.iter().any(tolerance_marker))
        || cond.iter().any(|x| {
            x.kind == Kind::Ident && (flags.contains(&x.text) || lower(x).contains("converg"))
        })
}
fn literal(x: &Token) -> Option<f64> {
    (x.kind == Kind::Number)
        .then(|| {
            x.text
                .trim_end_matches("_f64")
                .trim_end_matches("f64")
                .replace('_', "")
        })
        .and_then(|s| s.parse().ok())
}

/// Names bound mutably before `before` in `f` (`let mut x`, `(mut a, mut
/// b)`, `mut p: T`) and `&mut` parameters.
fn carried(t: &[Token], f: &Function, before: usize) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    for k in f.signature..before {
        if is(&t[k], "mut") && t[k + 1].kind == Kind::Ident && t[k + 1].text != "self" {
            names.insert(t[k + 1].text.clone());
        }
    }
    // `name: &mut T` and `name: &'a mut T` in the signature.
    for k in f.signature..f.open {
        if t[k].kind == Kind::Ident
            && is(&t[k + 1], ":")
            && is(&t[k + 2], "&")
            && (is(&t[k + 3], "mut") || (t[k + 3].kind == Kind::Lifetime && is(&t[k + 4], "mut")))
        {
            names.insert(t[k].text.clone());
        }
    }
    names
}

struct Update {
    name: String,
    /// Assigned through an index or a field (`x[i] = ..`, `x.f = ..`).
    element: bool,
    op: String,
    at: usize,
    rhs: (usize, usize),
}
/// Assignments in `t[from..to]` to any of `names`: `x = ..`, `x op= ..`,
/// `x[i] op= ..`, `x.field op= ..`, `*x op= ..`; never `let x = ..`.
fn updates(t: &[Token], from: usize, to: usize, names: &BTreeSet<String>) -> Vec<Update> {
    let mut out = Vec::new();
    for k in from..to {
        if t[k].kind != Kind::Ident || !names.contains(&t[k].text) {
            continue;
        }
        if k > 0
            && [".", "let", "mut", "::", "fn"]
                .iter()
                .any(|p| is(&t[k - 1], p))
        {
            continue;
        }
        let mut j = k + 1;
        loop {
            if j < to && is(&t[j], "[") {
                j = close(t, j) + 1;
            } else if j + 2 < to
                && is(&t[j], ".")
                && (t[j + 1].kind == Kind::Ident || t[j + 1].kind == Kind::Number)
                && !is(&t[j + 2], "(")
            {
                j += 2;
            } else {
                break;
            }
        }
        if j < to && ASSIGN.iter().any(|a| is(&t[j], a)) {
            out.push(Update {
                name: t[k].text.clone(),
                element: j > k + 1,
                op: t[j].text.clone(),
                at: k,
                rhs: (j + 1, statement_end(t, j + 1, to)),
            });
        }
    }
    out
}

/// `let PATTERN = EXPR;` statements in `t[from..to]`: bound names and the
/// expression's token range.
fn lets(t: &[Token], from: usize, to: usize) -> Vec<(Vec<String>, (usize, usize))> {
    let mut out = Vec::new();
    for k in from..to {
        if !is(&t[k], "let") {
            continue;
        }
        let Some(eq) = (k + 1..to).find(|j| is(&t[*j], "=") || is(&t[*j], ";")) else {
            continue;
        };
        if !is(&t[eq], "=") {
            continue;
        }
        // Names in the pattern, without a type ascription's names.
        let pattern_end = (k + 1..eq).find(|j| is(&t[*j], ":")).unwrap_or(eq);
        let bound = t[k + 1..pattern_end]
            .iter()
            .filter(|x| x.kind == Kind::Ident && !matches!(x.text.as_str(), "mut" | "ref" | "_"))
            .map(|x| x.text.clone())
            .collect();
        out.push((bound, (eq + 1, statement_end(t, eq + 1, to))));
    }
    out
}

/// Names that appear inside the argument list of a function or method call
/// in `t[from..to]` (macros excluded).
fn call_arguments(t: &[Token], from: usize, to: usize) -> BTreeSet<String> {
    let mut stack: Vec<bool> = Vec::new();
    let mut names = BTreeSet::new();
    for k in from..to {
        let x = &t[k];
        if is(x, "(") {
            let p = &t[k - 1];
            let call = (p.kind == Kind::Ident && !KEYWORDS.contains(&p.text.as_str()))
                || is(p, ">")
                || is(p, ")");
            stack.push(call);
        } else if is(x, ")") {
            stack.pop();
        } else if x.kind == Kind::Ident && stack.iter().any(|c| *c) {
            names.insert(x.text.clone());
        }
    }
    names
}
fn mentions(t: &[Token], range: (usize, usize), names: &BTreeSet<String>) -> bool {
    t[range.0..range.1]
        .iter()
        .any(|x| x.kind == Kind::Ident && names.contains(&x.text))
}
/// `0.5 * (a + b)`, `(a + b) * 0.5`, `(a + b) / 2` or `.midpoint(` over
/// one of `names`.
fn midpoint(t: &[Token], from: usize, to: usize, names: &BTreeSet<String>) -> bool {
    for k in from..to {
        if is(&t[k], "midpoint") {
            return true;
        }
        if !is(&t[k], "(") {
            continue;
        }
        let end = close(t, k);
        if end >= to || !t[k + 1..end].iter().any(|x| is(x, "+")) {
            continue;
        }
        if !mentions(t, (k + 1, end), names) {
            continue;
        }
        let half = |x: &Token| literal(x) == Some(0.5);
        let two = |x: &Token| literal(x) == Some(2.);
        let before = k >= 2 && is(&t[k - 1], "*") && half(&t[k - 2]);
        let after = end + 2 < t.len()
            && ((is(&t[end + 1], "*") && half(&t[end + 2]))
                || (is(&t[end + 1], "/") && two(&t[end + 2])));
        if before || after {
            return true;
        }
    }
    false
}
/// Blocks guarded by `if COND {` in `t[from..to]`: (condition, block).
fn ifs(t: &[Token], from: usize, to: usize) -> Vec<((usize, usize), (usize, usize))> {
    let mut out = Vec::new();
    for k in from..to {
        if is(&t[k], "if")
            && let Some(open) = body_open(t, k + 1)
            && open < to
        {
            out.push(((k + 1, open), (open, close(t, open))));
        }
    }
    out
}
fn exits(t: &[Token], block: (usize, usize)) -> bool {
    (block.0..block.1).any(|k| is(&t[k], "break") || (is(&t[k], "return") && !is(&t[k + 1], "Err")))
}

const GLOBALISATION: [&str; 9] = [
    "backtrack",
    "line_search",
    "linesearch",
    "armijo",
    "wolfe",
    "trust_region",
    "under_relax",
    "over_relax",
    "underrelax",
];

/// Token ranges of the unit-test items of a crate source: an item under
/// exactly `#[test]` or `#[cfg(test)]` (with any further attributes), to the
/// end of its body or its `;`. Such code is compiled only into the crate's
/// test harness, never into the library or a binary.
fn unit_test_items(t: &[Token]) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    for k in 0..t.len().saturating_sub(6) {
        if !(is(&t[k], "#") && is(&t[k + 1], "[")) {
            continue;
        }
        let end = close(t, k + 1);
        let inner: Vec<&str> = t[k + 2..end].iter().map(|x| x.text.as_str()).collect();
        if inner != ["test"] && inner != ["cfg", "(", "test", ")"] {
            continue;
        }
        // Skip any further attributes, then the item to its body or `;`.
        let mut j = end + 1;
        while j + 1 < t.len() && is(&t[j], "#") && is(&t[j + 1], "[") {
            j = close(t, j + 1) + 1;
        }
        let stop = match body_open(t, j) {
            Some(open) => close(t, open),
            None => (j..t.len())
                .find(|q| is(&t[*q], ";"))
                .unwrap_or(t.len() - 1),
        };
        ranges.push((k, stop));
    }
    ranges
}

/// Every finding of the rules above in one Rust source of a test target
/// (`tests/`): nothing is exempt, since harness code makes receipts.
fn analyse(source: &str) -> Vec<Finding> {
    analyse_source(source, false)
}

/// Every finding in one Rust source; in a crate source (`src/`) the unit
/// tests are not searched.
fn analyse_source(source: &str, crate_source: bool) -> Vec<Finding> {
    let t = lex(source);
    let fns = functions(&t);
    let name_at = |k: usize| enclosing(&fns, k).map_or("<item>".to_string(), |f| f.name.clone());
    let exempt = if crate_source {
        unit_test_items(&t)
    } else {
        Vec::new()
    };
    let mut out = Vec::new();
    let mut found = |k: usize, rule: &'static str, what: String| {
        if exempt.iter().any(|(a, b)| *a <= k && k <= *b) {
            return;
        }
        out.push(Finding {
            function: name_at(k),
            rule,
            line: t[k].line,
            what,
        });
    };

    for l in loops(&t) {
        let Some(f) = enclosing(&fns, l.keyword) else {
            continue;
        };
        let (from, to) = (l.open + 1, l.close);
        let carried = carried(&t, f, l.keyword);
        let updates = updates(&t, from, to, &carried);
        let updated: BTreeSet<String> = updates.iter().map(|u| u.name.clone()).collect();
        let lets = lets(&t, from, to);

        // Read back: a call argument, a `let` expression, or another
        // variable's update, through `let` temporaries.
        let mut read = call_arguments(&t, from, to);
        for _ in 0..3 {
            for (bound, rhs) in &lets {
                if bound.iter().any(|b| read.contains(b)) {
                    for x in &t[rhs.0..rhs.1] {
                        if x.kind == Kind::Ident {
                            read.insert(x.text.clone());
                        }
                    }
                }
            }
        }
        for (_, rhs) in &lets {
            for x in &t[rhs.0..rhs.1] {
                if x.kind == Kind::Ident {
                    read.insert(x.text.clone());
                }
            }
        }
        for u in &updates {
            for x in &t[u.rhs.0..u.rhs.1] {
                if x.kind == Kind::Ident && x.text != u.name {
                    read.insert(x.text.clone());
                }
            }
        }
        let iterates: BTreeSet<String> = updated.intersection(&read).cloned().collect();

        // Stop on convergence.
        let flags: BTreeSet<String> = lets
            .iter()
            .filter(|(_, rhs)| convergence_test(&t[rhs.0..rhs.1], &BTreeSet::new()))
            .flat_map(|(b, _)| b.clone())
            .collect();
        let head = &t[l.keyword + 1..l.open];
        let converges = (is(&t[l.keyword], "while") && convergence_test(head, &flags))
            || ifs(&t, from, to)
                .into_iter()
                .any(|(c, b)| convergence_test(&t[c.0..c.1], &flags) && exits(&t, b))
            || midpoint(&t, from, to, &updated);
        // A loop that advances stock IDA iterates in time, not on F(x) = 0.
        let integrates =
            (from..to).any(|k| is(&t[k], "advance") && is(&t[k - 1], ".") && is(&t[k + 1], "("));
        let iteration = !iterates.is_empty() && converges && !integrates;
        if iteration {
            found(
                l.keyword,
                "iteration",
                format!("`{}` loop iterating {:?}", t[l.keyword].text, iterates),
            );
        }

        for u in &updates {
            let rhs = &t[u.rhs.0..u.rhs.1];
            // Shrink by a constant factor.
            let single = rhs.len() == 1;
            let shrink =
                (u.op == "*=" && single && literal(&rhs[0]).is_some_and(|v| v > 0. && v < 1.))
                    || (u.op == "/=" && single && literal(&rhs[0]).is_some_and(|v| v > 1.))
                    || (u.op == "="
                        && rhs.len() == 3
                        && is(&rhs[1], "*")
                        && ((rhs[0].text == u.name
                            && literal(&rhs[2]).is_some_and(|v| v > 0. && v < 1.))
                            || (rhs[2].text == u.name
                                && literal(&rhs[0]).is_some_and(|v| v > 0. && v < 1.))));
            if shrink {
                found(
                    u.at,
                    "damping",
                    format!("`{}` shrunk by a constant in a loop", u.name),
                );
            }
            // Relaxation of an iterate's update.
            if iteration
                && iterates.contains(&u.name)
                && rhs.iter().any(|x| {
                    let w = lower(x);
                    x.kind == Kind::Ident
                        && (w.starts_with("damp") || w.starts_with("relax") || w == "omega")
                })
            {
                found(
                    u.at,
                    "damping",
                    format!("`{}` updated through a damping/relaxation factor", u.name),
                );
            }
            // A tolerance rescaled in a loop (not one filled element by
            // element).
            let w = u.name.to_ascii_lowercase();
            let rescaled = u.op != "=" || rhs.iter().any(|x| x.text == u.name);
            if w.contains("tol") && !u.element && rescaled {
                found(
                    u.at,
                    "tolerance-ladder",
                    format!("tolerance `{}` rescaled in a loop", u.name),
                );
            }
            // A cap multiplied up in a loop.
            let cap = w
                .split('_')
                .any(|m| matches!(m, "cap" | "caps" | "limit" | "budget" | "deadline" | "max"));
            let raised = (u.op == "*=" && single && literal(&rhs[0]).is_some_and(|v| v > 1.))
                || (u.op == "="
                    && rhs.len() == 3
                    && is(&rhs[1], "*")
                    && ((rhs[0].text == u.name && literal(&rhs[2]).is_some_and(|v| v > 1.))
                        || (rhs[2].text == u.name && literal(&rhs[0]).is_some_and(|v| v > 1.))));
            if cap && raised {
                found(
                    u.at,
                    "step-cap-evasion",
                    format!("cap `{}` multiplied up in a loop", u.name),
                );
            }
        }

        // A loop over tolerances.
        if is(&t[l.keyword], "for") {
            let pattern_end = (l.keyword + 1..l.open)
                .find(|k| is(&t[*k], "in"))
                .unwrap_or(l.open);
            if t[l.keyword + 1..pattern_end].iter().any(|x| {
                let w = lower(x);
                x.kind == Kind::Ident && w.contains("tol")
            }) {
                found(l.keyword, "tolerance-ladder", "loop over tolerances".into());
            }
        }

        // Failure arms that change integrator controls, tolerances or caps.
        for k in from..to {
            let arm = if is(&t[k], "Err") && is(&t[k + 1], "(") {
                let after = close(&t, k + 1) + 1;
                if after < to && is(&t[after], "=>") {
                    if is(&t[after + 1], "{") {
                        Some((after + 1, close(&t, after + 1)))
                    } else {
                        Some((after + 1, statement_end(&t, after + 1, to)))
                    }
                } else if k >= 2 && is(&t[k - 1], "let") && is(&t[k - 2], "if") {
                    body_open(&t, after).map(|o| (o, close(&t, o)))
                } else {
                    None
                }
            } else if is(&t[k], "is_err") && is(&t[k + 1], "(") {
                body_open(&t, k + 2)
                    .filter(|o| *o < to)
                    .map(|o| (o, close(&t, o)))
            } else {
                None
            };
            let Some((a, b)) = arm else {
                continue;
            };
            let control =
                (a..b).find(|j| CONTROLS.iter().any(|c| is(&t[*j], c)) && is(&t[j + 1], "("));
            let retuned = (a..b).find(|j| {
                let w = lower(&t[*j]);
                t[*j].kind == Kind::Ident
                    && ["tol", "cap", "limit", "budget", "max_step"]
                        .iter()
                        .any(|m| w.contains(m))
                    && j + 1 < b
                    && ASSIGN.iter().any(|op| is(&t[j + 1], op))
            });
            if let Some(j) = control.or(retuned) {
                found(
                    j,
                    "step-cap-evasion",
                    format!("`{}` changed in a failure arm", t[j].text),
                );
            }
        }
    }

    // Bindings named after globalisation devices.
    for k in 1..t.len() {
        let x = &t[k];
        if x.kind != Kind::Ident {
            continue;
        }
        let w = lower(x);
        let binding = [
            "let", "mut", "fn", "const", "static", "struct", "enum", "type",
        ]
        .iter()
        .any(|p| is(&t[k - 1], p))
            || (is(&t[k - 1], "pub") && k + 1 < t.len() && is(&t[k + 1], ":"));
        if binding && GLOBALISATION.iter().any(|g| w.contains(g)) {
            found(k, "damping", format!("binding `{}`", x.text));
        }
    }
    out.sort();
    out
}

/// Identifiers of the SUNDIALS, KINSOL and SuiteSparse families.
fn solver_family(w: &str) -> bool {
    [
        "IDA", "SUN", "KIN", "CV", "ARK", "N_V", "klu_", "amd_", "colamd_", "btf_",
    ]
    .iter()
    .any(|p| w.starts_with(p) && w.len() > p.len())
}
/// Every solver-family identifier of a C source, or the functions a Rust
/// source declares in `extern` blocks.
fn foreign_identifiers(path: &str, source: &str) -> Vec<(String, usize)> {
    let t = lex(source);
    if !path.ends_with(".rs") {
        return t
            .into_iter()
            .filter(|x| x.kind == Kind::Ident && solver_family(&x.text))
            .map(|x| (x.text, x.line))
            .collect();
    }
    let mut out = Vec::new();
    for k in 0..t.len().saturating_sub(2) {
        if is(&t[k], "extern") && t[k + 1].kind == Kind::Literal && is(&t[k + 2], "{") {
            for j in k + 2..close(&t, k + 2) {
                if is(&t[j], "fn") {
                    out.push((t[j + 1].text.clone(), t[j + 1].line));
                }
            }
        }
    }
    out
}
fn forbidden_api(name: &str) -> bool {
    (name.starts_with("KIN") && name[3..].starts_with(|c: char| c.is_ascii_uppercase()))
        || name.starts_with("SUNNonlinSol")
        || name == "IDASetNonlinearSolver"
        || name == "IDASetSuppressAlg"
}

// ------------------------------------------------------------------ sources

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}
fn files(directory: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    let mut entries: Vec<_> = entries
        .map(|e| e.expect("directory entry").path())
        .collect();
    entries.sort();
    for p in entries {
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if p.is_dir() {
            if name != "target" {
                files(&p, out);
            }
        } else if [".rs", ".c", ".h", ".cc", ".cpp"]
            .iter()
            .any(|e| name.ends_with(e))
        {
            out.push(p);
        }
    }
}
fn sources() -> Vec<(String, String)> {
    let root = root();
    let mut paths = Vec::new();
    for d in ["src", "tests", "water-ffi/src", "water-ffi/tests"] {
        files(&root.join(d), &mut paths);
    }
    paths.push(root.join("water-ffi/build.rs"));
    paths
        .into_iter()
        .map(|p| {
            let relative = p
                .strip_prefix(&root)
                .expect("under the crate")
                .to_string_lossy()
                .replace('\\', "/");
            (relative, fs::read_to_string(&p).expect("readable source"))
        })
        .filter(|(r, _)| r != "tests/solver_prohibitions.rs")
        .collect()
}

// -------------------------------------------------------------------- tests

#[test]
fn no_custom_solver_outside_the_reviewed_iterations() {
    let mut counts: BTreeMap<(String, String, &'static str), Vec<Finding>> = BTreeMap::new();
    let mut scanned = 0;
    for (path, source) in sources().iter().filter(|(p, _)| p.ends_with(".rs")) {
        scanned += 1;
        let crate_source = path.starts_with("src/") || path.starts_with("water-ffi/src/");
        for f in analyse_source(source, crate_source) {
            counts
                .entry((path.clone(), f.function.clone(), f.rule))
                .or_default()
                .push(f);
        }
    }
    assert!(scanned > 100, "only {scanned} Rust sources found");
    let mut problems = Vec::new();
    for ((path, function, rule), found) in &counts {
        let allowed = ALLOWED
            .iter()
            .find(|a| a.0 == path && a.1 == function && a.2 == *rule)
            .map_or(0, |a| a.3);
        if found.len() != allowed {
            for f in found {
                problems.push(format!(
                    "{path}:{} in `{function}`: {rule}: {} ({} found, {allowed} allowed)",
                    f.line,
                    f.what,
                    found.len()
                ));
            }
        }
    }
    for (path, function, rule, n, _) in ALLOWED {
        if !counts.contains_key(&(path.to_string(), function.to_string(), *rule)) {
            problems.push(format!(
                "stale allowance: {path} `{function}` {rule} ({n}) no longer occurs; remove it"
            ));
        }
    }
    assert!(
        problems.is_empty(),
        "custom nonlinear-solver shapes outside the reviewed iterations (stock IDA/KLU only; see the module documentation):\n{}",
        problems.join("\n")
    );
}

#[test]
fn solver_api_is_the_stock_wrappers_pinned_set() {
    let mut problems = Vec::new();
    let mut seen = BTreeSet::new();
    for (path, source) in sources() {
        for x in lex(&source)
            .iter()
            .filter(|x| x.kind == Kind::Ident && forbidden_api(&x.text))
        {
            problems.push(format!("{path}:{}: `{}` is forbidden", x.line, x.text));
        }
        // The stock wrappers' surface: C glue and `water-ffi/src` externs.
        if !(path.starts_with("water-ffi/src/") || !path.ends_with(".rs")) {
            continue;
        }
        for (name, line) in foreign_identifiers(&path, &source) {
            if MEASUREMENT_CLOCKS.contains(&name.as_str()) {
                continue;
            }
            if !SOLVER_API.contains(&name.as_str()) {
                problems.push(format!("{path}:{line}: `{name}` is not on the pinned list"));
            }
            seen.insert(name);
        }
    }
    for name in SOLVER_API {
        if !seen.contains(*name) {
            problems.push(format!("stale pin: `{name}` no longer occurs; remove it"));
        }
    }
    assert!(
        problems.is_empty(),
        "solver API outside the stock wrappers' pinned set:\n{}",
        problems.join("\n")
    );
}

#[test]
fn dependencies_are_the_pinned_set() {
    let mut problems = Vec::new();
    for manifest in ["Cargo.toml", "water-ffi/Cargo.toml"] {
        let text = fs::read_to_string(root().join(manifest)).expect("manifest");
        let mut section = String::new();
        for (n, line) in text.lines().enumerate() {
            let line = line.trim();
            if line.starts_with('[') {
                section = line.trim_matches(|c| c == '[' || c == ']').to_string();
            } else if section.ends_with("dependencies")
                && let Some((name, _)) = line.split_once('=')
            {
                let name = name.trim();
                if !name.is_empty() && !name.starts_with('#') && !DEPENDENCIES.contains(&name) {
                    problems.push(format!("{manifest}:{}: [{section}] {name}", n + 1));
                }
            } else if section.starts_with("dependencies.")
                || section.starts_with("dev-dependencies.")
                || section.starts_with("build-dependencies.")
                || section.starts_with("target.")
            {
                let name = section.rsplit('.').next().unwrap_or("");
                if section.contains("dependencies") && !DEPENDENCIES.contains(&name) {
                    problems.push(format!("{manifest}: [{section}]"));
                }
            }
        }
    }
    assert!(
        problems.is_empty(),
        "dependencies outside the pinned set (a new dependency needs the owner):\n{}",
        problems.join("\n")
    );
}

// ----------------------------------------------------------- planted cases

fn rules(source: &str) -> BTreeSet<&'static str> {
    analyse(source).into_iter().map(|f| f.rule).collect()
}

/// The paused G18 binary's per-assembly safeguarded Newton (2be5793b,
/// `water-ffi/src/bin/prepare_steady_solids.rs`), the shape the critic
/// found forbidden, reduced to its loop.
#[test]
fn planted_g18_per_assembly_damped_newton_is_caught() {
    let g18 = r#"
fn main() -> Result<(), Failure> {
    let mut y = problem.zero.clone();
    for (g, (closed, own)) in groups.iter().enumerate() {
        let m = own.len();
        let mut f = problem.rows(&y, closed, &stores, None)?;
        let mut iterations = 0;
        while norm(&f) > TOLERANCE {
            iterations += 1;
            let mut jac = vec![0.; m * m];
            for (c, &j) in own.iter().enumerate() {
                let col = problem.rows(&y, closed, &stores, Some(j))?;
                for (r, (_, v)) in col.iter().enumerate() {
                    jac[r * m + c] = v.direction;
                }
            }
            let mut step: Vec<f64> = f.iter().map(|(_, v)| -v.value).collect();
            solve(m, &mut jac, &mut step)?;
            let before = norm(&f);
            let mut lambda = 1.;
            let mut accepted = None;
            for _ in 0..BACKTRACKS {
                let mut trial = y.clone();
                for (c, &j) in own.iter().enumerate() {
                    trial[j] += lambda * step[c];
                }
                if let Ok(ft) = problem.rows(&trial, closed, &stores, None)
                    && (norm(&ft) < before || norm(&ft) <= TOLERANCE)
                {
                    accepted = Some((trial, ft));
                    break;
                }
                lambda *= 0.5;
            }
            let Some((trial, ft)) = accepted else { return Err("no decreasing step".into()); };
            y = trial;
            f = ft;
        }
    }
    Ok(())
}
"#;
    let found = analyse(g18);
    assert!(
        found
            .iter()
            .any(|f| f.rule == "iteration" && f.what.contains("while")),
        "{found:?}"
    );
    assert!(
        found
            .iter()
            .any(|f| f.rule == "damping" && f.what.contains("lambda")),
        "{found:?}"
    );
}

#[test]
fn planted_unnamed_scalar_newton_secant_and_bisection_are_caught() {
    let newton = r#"
fn invert(target: f64) -> f64 {
    let mut x = 1.0;
    for _ in 0..50 {
        let f = law(x) - target;
        x -= f / slope(x);
        if f.abs() < 1e-10 { break; }
    }
    x
}"#;
    let secant = r#"
fn secant(target: f64) -> Option<f64> {
    let (mut a, mut b) = (1.0, 2.0);
    loop {
        let c = b - (law(b) - target) * (b - a) / (law(b) - law(a));
        a = b;
        b = c;
        if (b - a).abs() <= TOL { return Some(b); }
    }
}"#;
    let bisection = r#"
fn crossing() -> f64 {
    let (mut lo, mut hi) = (0., 1.);
    for _ in 0..60 {
        let mid = (lo + hi) / 2.;
        if g(mid) > 0. { hi = mid } else { lo = mid }
    }
    lo
}"#;
    let converged_flag = r#"
fn wall(mut tw: f64) -> f64 {
    loop {
        let (f, df) = balance(tw);
        let converged = f.abs() <= 1e-12;
        if converged { return tw; }
        tw = tw - f / df;
    }
}"#;
    for (name, source) in [
        ("newton", newton),
        ("secant", secant),
        ("bisection", bisection),
        ("flag", converged_flag),
    ] {
        assert!(
            rules(source).contains("iteration"),
            "{name}: {:?}",
            analyse(source)
        );
    }
}

#[test]
fn planted_relaxed_fixed_point_on_a_mut_parameter_is_caught() {
    let picard = r#"
fn settle(y: &mut [f64]) {
    let omega = 0.3;
    loop {
        let g = map(y);
        let change = largest(&g, y);
        for i in 0..y.len() {
            y[i] = (1. - omega) * y[i] + omega * g[i];
        }
        if change < settling_tolerance { return; }
    }
}"#;
    let found = rules(picard);
    assert!(
        found.contains("iteration") && found.contains("damping"),
        "{:?}",
        analyse(picard)
    );
    let halving = r#"
fn advance_custom(mut y: Vec<f64>) {
    let mut h = 1e-3;
    while t < end {
        if trial(&y, h).is_err() { h /= 2.; continue; }
        t += h;
    }
}"#;
    assert!(rules(halving).contains("damping"), "{:?}", analyse(halving));
    let named = "fn armijo_backtracking_search() {} struct Policy { pub line_search_steps: usize }";
    assert_eq!(
        analyse(named)
            .iter()
            .filter(|f| f.rule == "damping")
            .count(),
        2,
        "{:?}",
        analyse(named)
    );
}

#[test]
fn planted_tolerance_ladders_are_caught() {
    let listed = r#"
fn run() -> Result<Run, Failure> {
    for rtol in [1e-8, 1e-6, 1e-4] {
        if let Ok(r) = integrate(rtol) { return Ok(r); }
    }
    Err(failed())
}"#;
    let loosened = r#"
fn run() -> Run {
    let mut tolerance = 1e-8;
    while integrate(tolerance).is_err() {
        tolerance *= 10.;
    }
    integrate(tolerance).unwrap()
}"#;
    assert!(
        rules(listed).contains("tolerance-ladder"),
        "{:?}",
        analyse(listed)
    );
    assert!(
        rules(loosened).contains("tolerance-ladder"),
        "{:?}",
        analyse(loosened)
    );
}

#[test]
fn planted_step_cap_evasion_is_caught() {
    let lifted = r#"
fn window(ida: &mut Ida<S>, y: &mut [f64], yp: &mut [f64]) -> Result<(), Failure> {
    loop {
        match ida.advance(end, y, yp) {
            Ok(_) => break,
            Err(Failure::Recoverable(_)) => {
                ida.remove_max_step()?;
            }
            Err(e) => return Err(e),
        }
    }
    Ok(())
}"#;
    let raised = r#"
fn window() {
    let mut max_steps = 500;
    loop {
        if run(max_steps).is_ok() { break; }
        max_steps *= 2;
    }
}"#;
    let if_let = r#"
fn window(ida: &mut Ida<S>) {
    for k in 0..3 {
        if let Err(_) = ida.advance(end, &mut y, &mut yp) {
            ida.set_init_step(1e-6).unwrap();
        }
    }
}"#;
    for (name, source) in [("lifted", lifted), ("raised", raised), ("if let", if_let)] {
        assert!(
            rules(source).contains("step-cap-evasion"),
            "{name}: {:?}",
            analyse(source)
        );
    }
}

#[test]
fn planted_kinsol_and_suppressed_algebraic_error_are_forbidden() {
    let rust = r#"unsafe extern "C" { fn KINSol(mem: *mut c_void) -> i32; }"#;
    let c = "int f(void *ida) { return IDASetSuppressAlg(ida, 1) + SUNNonlinSol_FixedPoint(y, 3, ctx) != 0; }";
    for source in [rust, c] {
        assert!(
            lex(source)
                .iter()
                .any(|x| x.kind == Kind::Ident && forbidden_api(&x.text)),
            "{source}"
        );
    }
    assert_eq!(
        foreign_identifiers("x.rs", rust),
        vec![("KINSol".to_string(), 1)]
    );
    assert!(
        foreign_identifiers("x.c", c)
            .iter()
            .any(|(n, _)| n == "IDASetSuppressAlg")
    );
}

/// Prose, strings, accumulations, searches, IDA time loops and event
/// restarts are not solver shapes.
#[test]
fn legitimate_shapes_and_prose_are_not_findings() {
    let clean = r##"
/// for _ in 0..10 { x -= f / df; if f.abs() < 1e-12 { break } }
/* while norm(&f) > TOLERANCE { lambda *= 0.5; } */
fn prose<'a>(label: &'a str) -> char {
    let _ = r#"loop { x = x - f / d; if dx.abs() < 1e-9 { break } }"#;
    let _ = "for tol in [1e-6, 1e-3] { tolerance *= 10. }";
    let _ = b"while e > eps { omega = 0.5 * omega }";
    '"'
}
fn mass(cells: &[Cell]) -> f64 {
    let mut total = 0.;
    for c in cells {
        total += c.mass / c.volume;
        if total.abs() > 1e-3 { break; }
    }
    total
}
fn find(xs: &[f64], target: f64) -> usize {
    let mut found = 0;
    for (i, x) in xs.iter().enumerate() {
        if (x - target).abs() < 1e-12 { found = i; break; }
    }
    found
}
fn integrate(ida: &mut Ida<S>, end: f64, cap: f64) -> Result<(), Failure> {
    let mut t = 0.;
    while t < end - 1e-12 {
        let target = (t + 0.1).min(end);
        match ida.advance(target, &mut y, &mut yp) {
            Ok(Advance::Root(tr)) => {
                t = tr;
                ida.reinitialize(t, &y, &yp)?;
                ida.set_max_step(cap)?;
            }
            Ok(a) => t = a.reached()?,
            Err(e) => return Err(e),
        }
        if (t - end).abs() < 1e-12 { break; }
    }
    Ok(())
}
fn tolerances(classes: &[Class]) -> Vec<f64> {
    let mut atol = vec![0.; classes.len()];
    for (i, c) in classes.iter().enumerate() {
        atol[i] = c.absolute_tolerance;
    }
    atol
}
fn physics(rotors: &[Rotor]) -> f64 {
    let mut power = 0.;
    for r in rotors {
        let omega = r.momentum / r.inertia;
        power += r.damping * omega * omega;
    }
    power
}
"##;
    assert_eq!(analyse(clean), Vec::new());
}

/// Unit tests in a crate source are not searched; the same loop in
/// production code there, under a wider `cfg`, or in a test target is.
#[test]
fn unit_tests_of_crate_sources_are_exempt_and_nothing_else() {
    let newton = "let mut x = 1.0; for _ in 0..50 { let f = law(x); x -= f / slope(x); if f.abs() < 1e-10 { break; } }";
    let unit = format!(
        "pub fn law(x: f64) -> f64 {{ x }}\n#[cfg(test)]\nmod tests {{\n    #[test]\n    fn inverse() {{ {newton} }}\n}}\n#[test]\n#[ignore]\nfn alone() {{ {newton} }}"
    );
    assert_eq!(analyse_source(&unit, true), Vec::new());
    // A test target's #[test] is searched: harnesses make receipts.
    assert!(rules(&unit).contains("iteration"));
    for production in [
        format!("pub fn inverse() {{ {newton} }}"),
        format!("#[cfg(any(test, feature = \"x\"))]\npub fn inverse() {{ {newton} }}"),
        format!("#[cfg(not(test))]\npub fn inverse() {{ {newton} }}"),
        format!("#[cfg(test)]\nmod tests;\npub fn inverse() {{ {newton} }}"),
    ] {
        assert!(
            analyse_source(&production, true)
                .iter()
                .any(|f| f.rule == "iteration"),
            "{production}"
        );
    }
}
