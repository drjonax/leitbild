//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#exact-consistent-start-of-the-joined-residual
//! The joined residual's exact consistent start on direct KLU, and the
//! joined operator as one stock-IDA system.
//!
//! The start is decision 0013's exit, the network's `consistent_start`, on
//! the joined sparse pattern: the algebraic coordinates are projected onto
//! their constraints by Newton with `dg/dy_a` (every differential coordinate
//! held bitwise, the correction's WRMS with the integrator's weights at most
//! 1), then the rates solve one linear system whose differential rows are
//! `dF/dy'` and whose algebraic rows are `dg/dy`, exact in one pass. The
//! matrices come from JAC's block assembly at `cj = 0` and `cj = 1` on its
//! element-exact pattern (lead decision S2-D4); stock KLU's symbolic
//! analyses of that pattern and of the projection's algebraic submatrix are
//! made once and reused by later starts, and every start factors afresh.
//! The colored assemblies on the structural pattern remain the reference
//! the block start is checked against. No IDACalcIC, no iteration of the
//! rates, no tolerance is loosened: a missed bound refuses, naming the row.
//! No solver algorithm lives here.
use crate::klu::SparseLu;
use leitbild_operating_plant::{
    joined::{
        blocks::{Classes, JoinedJacobian, jacobian_blocks},
        operator::Joined,
    },
    network::{Failure, Properties},
    sparse::Pattern,
    thermal::WaterProperties,
};

use std::time::Instant;

fn fatal(reason: impl Into<String>) -> Failure {
    Failure::Fatal(format!("joined consistent start: {}", reason.into()))
}

/// Largest magnitude of one class of rows and the first row carrying it.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Largest {
    pub value: f64,
    pub row: usize,
}
fn largest(values: impl Iterator<Item = (usize, f64)>) -> Largest {
    values.fold(Largest::default(), |best, (row, v)| {
        let v = v.abs();
        if !best.value.is_nan() && (v.is_nan() || v > best.value) {
            Largest { value: v, row }
        } else {
            best
        }
    })
}

/// What the start did, with its timings.
#[derive(Clone, Debug, Default)]
pub struct Report {
    pub constraint_before: Largest,
    pub constraint_after: Largest,
    pub projection_passes: usize,
    /// Largest scaled change of an algebraic coordinate.
    pub correction: Largest,
    pub correction_wrms: f64,
    /// Every row of `F(t, y, y')` after the rate solve.
    pub residual: Largest,
    /// `dg/dy y'` over the algebraic rows.
    pub constraint_rate: Largest,
    /// Passes of the rate solve on the one factorization (the first exact,
    /// later ones removing round-off only).
    pub rate_passes: usize,
    pub bound: f64,
    /// `"blocks"` or `"colored"`.
    pub assembly: &'static str,
    pub nonzeros: usize,
    /// Colors of the structural pattern (colored assembly only).
    pub colors: usize,
    /// Stock KLU symbolic analyses this start made: the rate system's and
    /// the projection's. A block start reusing its cached analyses makes
    /// none.
    pub analyses: [usize; 2],
    pub jacobian_s: Vec<f64>,
    pub analyze_s: Vec<f64>,
    pub factor_s: Vec<f64>,
    pub solve_s: Vec<f64>,
}

fn csc_i64(pointers: &[usize], indices: &[usize]) -> (Vec<i64>, Vec<i64>) {
    (
        pointers.iter().map(|p| *p as i64).collect(),
        indices.iter().map(|r| *r as i64).collect(),
    )
}

/// Stock KLU's symbolic analyses for the block start on one compiled
/// structure, made once and reused: the rate system's (the whole
/// element-exact pattern) and the projection's (its algebraic submatrix,
/// with the submatrix's positions in the pattern's stored order, analyzed
/// again only when the algebraic set changes, as at a grip release). Only
/// KLU's ordering and symbolic structure are reused: every start factors
/// afresh with KLU's pivoting `factor`. A cache made on another pattern
/// refuses.
#[derive(Default)]
pub struct Analyses {
    rates: Option<Rates>,
    projection: Option<Projection>,
    /// Symbolic analyses made so far: rate system, projection.
    made: [usize; 2],
}
struct Rates {
    pointers: Vec<i64>,
    rows: Vec<i64>,
    lu: SparseLu,
}
struct Projection {
    algebraic: Vec<bool>,
    positions: Vec<usize>,
    lu: SparseLu,
}
impl Analyses {
    /// Symbolic analyses made so far: rate system, projection.
    pub fn made(&self) -> [usize; 2] {
        self.made
    }
}

/// The algebraic submatrix of `pattern` (algebraic rows, algebraic
/// columns): its local CSC pattern and each entry's position in the
/// pattern's stored order.
fn submatrix(pattern: &Pattern, algebraic: &[bool]) -> (usize, Vec<i64>, Vec<i64>, Vec<usize>) {
    let (pointers, indices) = (pattern.pointers(), pattern.indices());
    let mut k = 0;
    let local: Vec<Option<usize>> = algebraic
        .iter()
        .map(|a| {
            a.then(|| {
                k += 1;
                k - 1
            })
        })
        .collect();
    let mut sub_pointers = vec![0i64];
    let mut sub_rows = Vec::new();
    let mut positions = Vec::new();
    for (j, a) in algebraic.iter().enumerate() {
        if !a {
            continue;
        }
        for position in pointers[j]..pointers[j + 1] {
            if let Some(r) = local[indices[position]] {
                sub_rows.push(r as i64);
                positions.push(position);
            }
        }
        sub_pointers.push(sub_rows.len() as i64);
    }
    (k, sub_pointers, sub_rows, positions)
}

/// Where the start's matrices come from.
pub enum Matrices<'a> {
    /// JAC's block assembly on its element-exact pattern, with the cached
    /// symbolic analyses: the start's own matrices (lead decision S2-D4).
    Blocks {
        structure: &'a JoinedJacobian,
        analyses: &'a mut Analyses,
    },
    /// The colored assemblies on the operator's structural pattern,
    /// analyzed afresh: the reference the block start is checked against.
    Colored,
}

/// One assembly of `dF/dy + cj dF/dy'` at `(t, y, 0)` into `values`, in the
/// stored order of the matrices' pattern.
fn assemble<P: Properties + WaterProperties>(
    joined: &mut Joined<P>,
    matrices: &Matrices<'_>,
    t: f64,
    cj: f64,
    y: &[f64],
    values: &mut [f64],
    report: &mut Report,
) -> Result<(), Failure> {
    let zero = vec![0.; y.len()];
    let started = Instant::now();
    match matrices {
        // The block assembly makes its own unseeded evaluation at (t, y, 0)
        // before the operator's local coupler reads it.
        Matrices::Blocks { structure, .. } => {
            jacobian_blocks(joined, structure, t, cj, y, &zero, values, Classes::ALL)?
        }
        Matrices::Colored => joined.jacobian(t, cj, y, &zero, values)?,
    }
    report.jacobian_s.push(started.elapsed().as_secs_f64());
    Ok(())
}

/// The exact consistent start of the joined residual at `t`: `y` holds the
/// projected state on success, and the consistent rates are returned.
#[allow(clippy::too_many_arguments)] // The state, its identity and weights, and the start's controls.
pub fn consistent_start<P: Properties + WaterProperties>(
    joined: &mut Joined<P>,
    mut matrices: Matrices<'_>,
    t: f64,
    y: &mut [f64],
    differential: &[f64],
    weights: &[f64],
    bound: f64,
    passes: usize,
) -> Result<(Vec<f64>, Report), Failure> {
    let n = joined.dimension();
    if y.len() != n
        || differential.len() != n
        || weights.len() != n
        || !(bound.is_finite() && bound > 0.)
        || passes == 0
    {
        return Err(fatal("layout, bound or passes"));
    }
    let colored: Pattern;
    let (pattern, colors, assembly): (&Pattern, usize, &'static str) = match &matrices {
        Matrices::Blocks { structure, .. } => (&structure.pattern, 0, "blocks"),
        Matrices::Colored => {
            let (pattern, coloring) = joined
                .structure()
                .ok_or_else(|| fatal("the joined operator has no structure"))?;
            let count = coloring.count();
            colored = pattern.clone();
            (&colored, count, "colored")
        }
    };
    if pattern.rows() != n || pattern.columns() != n {
        return Err(fatal("the matrices' pattern is not the operator's"));
    }
    let (pointers, indices) = (pattern.pointers(), pattern.indices());
    let nnz = indices.len();
    let mut report = Report {
        bound,
        assembly,
        nonzeros: nnz,
        colors,
        ..Report::default()
    };
    // A colored start analyzes afresh into its own cache; a block start
    // uses the structure's.
    let mut fresh = Analyses::default();
    let algebraic: Vec<bool> = differential.iter().map(|d| *d == 0.).collect();
    let zero = vec![0.; n];
    let rows_at = |joined: &mut Joined<P>, y: &[f64], yp: &[f64]| -> Result<Vec<f64>, Failure> {
        joined.evaluate(t, y, yp, None, 0., None)?;
        Ok(joined.rows().iter().map(|r| r.value).collect())
    };
    let constraint = |rows: &[f64]| {
        largest(
            rows.iter()
                .enumerate()
                .filter(|(i, _)| algebraic[*i])
                .map(|(i, r)| (i, *r)),
        )
    };
    let start = y.to_vec();
    let mut rows = rows_at(joined, y, &zero)?;
    report.constraint_before = constraint(&rows);
    report.constraint_after = report.constraint_before;
    let mut values = vec![0.; nnz];
    // 1. Projection of the algebraic coordinates, differential ones held,
    // on the algebraic submatrix of this pattern.
    while (report.constraint_after.value.is_nan() || report.constraint_after.value > bound)
        && report.projection_passes < passes
    {
        report.projection_passes += 1;
        assemble(joined, &matrices, t, 0., y, &mut values, &mut report)?;
        let analyses = match &mut matrices {
            Matrices::Blocks { analyses, .. } => &mut **analyses,
            Matrices::Colored => &mut fresh,
        };
        if analyses
            .projection
            .as_ref()
            .is_some_and(|p| p.algebraic != algebraic)
        {
            analyses.projection = None;
        }
        let projection = match analyses.projection.as_mut() {
            Some(p) => p,
            None => {
                let (m, sub_pointers, sub_rows, positions) = submatrix(pattern, &algebraic);
                let started = Instant::now();
                let lu = SparseLu::analyze(m, &sub_pointers, &sub_rows)
                    .map_err(|e| fatal(format!("projection analysis: {e}")))?;
                report.analyze_s.push(started.elapsed().as_secs_f64());
                report.analyses[1] += 1;
                analyses.made[1] += 1;
                analyses.projection.insert(Projection {
                    algebraic: algebraic.clone(),
                    positions,
                    lu,
                })
            }
        };
        let sub: Vec<f64> = projection.positions.iter().map(|p| values[*p]).collect();
        let started = Instant::now();
        projection
            .lu
            .factor(&sub)
            .map_err(|e| fatal(format!("projection: {e}")))?;
        report.factor_s.push(started.elapsed().as_secs_f64());
        let mut rhs: Vec<f64> = (0..n).filter(|i| algebraic[*i]).map(|i| -rows[i]).collect();
        let started = Instant::now();
        projection
            .lu
            .solve(&mut rhs)
            .map_err(|e| fatal(format!("projection: {e}")))?;
        report.solve_s.push(started.elapsed().as_secs_f64());
        let mut k = 0;
        for (j, a) in algebraic.iter().enumerate() {
            if *a {
                y[j] += rhs[k];
                if rhs[k].abs() > report.correction.value {
                    report.correction = Largest {
                        value: rhs[k].abs(),
                        row: j,
                    };
                }
                k += 1;
            }
        }
        rows = rows_at(joined, y, &zero)?;
        report.constraint_after = constraint(&rows);
    }
    if report.constraint_after.value.is_nan() || report.constraint_after.value > bound {
        return Err(fatal(format!(
            "constraints miss their bound after projection: {:?}",
            report.constraint_after
        )));
    }
    let weighted: Vec<f64> = y
        .iter()
        .zip(&start)
        .zip(weights)
        .map(|((a, b), w)| (a - b) * w)
        .collect();
    report.correction_wrms = (weighted.iter().map(|v| v * v).sum::<f64>() / n as f64).sqrt();
    if report.correction_wrms.is_nan() || report.correction_wrms > 1. {
        return Err(fatal(format!(
            "the projection exceeds the solver's error scale: WRMS {}",
            report.correction_wrms
        )));
    }
    // 2. The consistent rates: differential rows dF/dy', algebraic rows dg/dy.
    let mut a = vec![0.; nnz];
    assemble(joined, &matrices, t, 0., y, &mut a, &mut report)?;
    let mut ab = vec![0.; nnz];
    assemble(joined, &matrices, t, 1., y, &mut ab, &mut report)?;
    let matrix: Vec<f64> = (0..nnz)
        .map(|p| {
            if algebraic[indices[p]] {
                a[p]
            } else {
                ab[p] - a[p]
            }
        })
        .collect();
    let analyses = match &mut matrices {
        Matrices::Blocks { analyses, .. } => &mut **analyses,
        Matrices::Colored => &mut fresh,
    };
    let lu = match analyses.rates.as_mut() {
        Some(rates) => {
            let same = rates.pointers.len() == pointers.len()
                && rates.rows.len() == nnz
                && rates
                    .pointers
                    .iter()
                    .zip(pointers)
                    .all(|(a, b)| *a == *b as i64)
                && rates.rows.iter().zip(indices).all(|(a, b)| *a == *b as i64);
            if !same {
                return Err(fatal(
                    "the cached analyses belong to another pattern; compile a structure with its own",
                ));
            }
            &mut rates.lu
        }
        None => {
            let (p, r) = csc_i64(pointers, indices);
            let started = Instant::now();
            let lu =
                SparseLu::analyze(n, &p, &r).map_err(|e| fatal(format!("rate analysis: {e}")))?;
            report.analyze_s.push(started.elapsed().as_secs_f64());
            report.analyses[0] += 1;
            analyses.made[0] += 1;
            &mut analyses
                .rates
                .insert(Rates {
                    pointers: p,
                    rows: r,
                    lu,
                })
                .lu
        }
    };
    let started = Instant::now();
    lu.factor(&matrix)
        .map_err(|e| fatal(format!("rates: {e}")))?;
    report.factor_s.push(started.elapsed().as_secs_f64());
    // The rows are linear in y', so one pass is exact; further passes, at
    // most `passes`, only remove the first solve's round-off, as the
    // network's dense consistent_rates does.
    let mut yp = vec![0.; n];
    let mut residual = rows.clone();
    let constraint_rate = |yp: &[f64]| {
        let mut rate = vec![0.; n];
        for j in 0..n {
            for position in pointers[j]..pointers[j + 1] {
                rate[indices[position]] += a[position] * yp[j];
            }
        }
        rate
    };
    for pass in 1..=passes {
        let rate = constraint_rate(&yp);
        let mut step: Vec<f64> = (0..n)
            .map(|i| if algebraic[i] { -rate[i] } else { -residual[i] })
            .collect();
        let started = Instant::now();
        lu.solve(&mut step)
            .map_err(|e| fatal(format!("rates: {e}")))?;
        report.solve_s.push(started.elapsed().as_secs_f64());
        for (v, d) in yp.iter_mut().zip(&step) {
            *v += d;
        }
        residual = rows_at(joined, y, &yp)?;
        report.residual = largest(residual.iter().copied().enumerate());
        let rate = constraint_rate(&yp);
        report.constraint_rate = largest(
            rate.iter()
                .enumerate()
                .filter(|(i, _)| algebraic[*i])
                .map(|(i, v)| (i, *v)),
        );
        report.rate_passes = pass;
        if report.residual.value <= bound && report.constraint_rate.value <= bound {
            break;
        }
    }
    if report.residual.value.is_nan()
        || report.residual.value > bound
        || report.constraint_rate.value.is_nan()
        || report.constraint_rate.value > bound
    {
        return Err(fatal(format!(
            "the consistent-rate solve missed its bound: residual {:?}, constraint rate {:?}",
            report.residual, report.constraint_rate
        )));
    }
    Ok((yp, report))
}

pub use integrated::{Assembly, Discrete, Integrated, Restart, Restarted, discrete_restart};

mod integrated {
    use super::{Analyses, Matrices, Report};
    use crate::ida::{Failure, Ida, KluOrdering, System};
    use leitbild_operating_plant::{
        joined::{
            block::{Command, Transaction},
            blocks::{Classes, JoinedJacobian, jacobian_blocks},
            operator::Joined,
        },
        network::{self, Properties},
        thermal::WaterProperties,
    };

    fn failure(f: network::Failure) -> Failure {
        match f {
            network::Failure::Recoverable(reason) => Failure::Recoverable(reason),
            network::Failure::Fatal(reason) => Failure::Fatal(reason),
        }
    }

    /// S2's segment configuration, set explicitly at every start and
    /// restart because stock IDAReInit retains it: the Newton coefficient
    /// and the linear-setup cj bound (claude/ld01-wiki c968921: 0.33 and
    /// 0.1), G13's first step (1e-4 s), the exact consistent start's bound
    /// and rate passes, and the largest roundoff violation of a nonnegative
    /// stock a restart places on its bound, in solver scaling
    /// (claude/ld01-wiki 014676f: 1e-12).
    #[derive(Clone, Copy, Debug)]
    pub struct Restart {
        pub newton_coefficient: f64,
        pub delta_cj_lsetup: f64,
        pub first_step_s: f64,
        pub start_bound: f64,
        pub start_passes: usize,
        pub bound_placement: f64,
    }

    /// What one discrete restart did.
    #[derive(Debug)]
    pub struct Restarted {
        pub transactions: Vec<Transaction>,
        /// Nonnegative stocks placed on their bound, each reported.
        pub placements: Vec<network::Placement>,
        pub yp: Vec<f64>,
        pub report: Report,
    }
    impl Restart {
        /// Configure a segment start (after construction or a restart).
        pub fn configure<P: Properties + WaterProperties>(
            &self,
            ida: &mut Ida<Integrated<P>>,
        ) -> Result<(), String> {
            ida.set_nonlinear_convergence_coefficient(self.newton_coefficient)?;
            ida.set_delta_cj_lsetup(self.delta_cj_lsetup)?;
            ida.set_init_step(self.first_step_s)
        }
    }

    /// What stopped a segment at `t`.
    #[derive(Clone, Copy, Debug)]
    pub enum Discrete<'a> {
        /// Located roots, `directions` per root as IDAGetRootInfo.
        Roots(&'a [i32]),
        /// A stop at the owners' [`Joined::next_time_event`].
        TimeEvent,
        /// A declared command at `t`.
        Command(Command),
    }

    /// One discrete event and its restart at `t`, in order:
    /// 1. the owners' transactions write their changed coordinates into `y`
    ///    (roots: `transact`; a command: `command`), then every time event
    ///    due at `t` is transacted, so a root that is exactly zero at the
    ///    restart is never missed and root and time event never both fire;
    /// 2. a nonnegative network stock below zero by less than the declared
    ///    roundoff is placed on its bound and reported; a larger violation
    ///    refuses;
    /// 3. the differential identity is recomputed from the owners' modes;
    /// 4. the exact consistent start at the transacted `y` (the projection
    ///    may change algebraic coordinates only), on the system's own
    ///    assembly: on blocks with the system's cached symbolic analyses,
    ///    on colored (the reference) afresh;
    /// 5. IDAReInit with the consistent rates and the segment configuration.
    #[allow(clippy::too_many_arguments)] // One restart: event, state, identity and tolerances.
    pub fn discrete_restart<P: Properties + WaterProperties>(
        ida: &mut Ida<Integrated<P>>,
        t: f64,
        discrete: Discrete<'_>,
        y: &mut [f64],
        network_ids: &[f64],
        absolute: &[f64],
        relative: f64,
        restart: &Restart,
    ) -> Result<Restarted, String> {
        let Integrated {
            joined,
            assembly,
            analyses,
            ..
        } = ida.system_mut();
        if absolute.len() != y.len() {
            return Err("restart tolerances layout".into());
        }
        let message = |f: network::Failure| match f {
            network::Failure::Recoverable(r) | network::Failure::Fatal(r) => r,
        };
        let mut done = match discrete {
            Discrete::Roots(directions) => joined.transact(t, directions, y).map_err(message)?,
            Discrete::TimeEvent => Vec::new(),
            Discrete::Command(c) => joined.command(t, y, c).map_err(message)?,
        };
        done.extend(joined.time_events(t, y).map_err(message)?);
        let nonnegative = joined.network.nonnegative_stocks();
        let placements = network::place_on_bounds(t, y, &nonnegative, restart.bound_placement)
            .map_err(message)?;
        let ids = joined.differential(network_ids);
        let weights: Vec<f64> = y
            .iter()
            .zip(absolute)
            .map(|(v, a)| 1. / (relative * v.abs() + a))
            .collect();
        let matrices = match assembly {
            Assembly::Blocks(structure) => Matrices::Blocks {
                structure,
                analyses,
            },
            Assembly::Colored => Matrices::Colored,
        };
        let (yp, report) = super::consistent_start(
            joined,
            matrices,
            t,
            y,
            &ids,
            &weights,
            restart.start_bound,
            restart.start_passes,
        )
        .map_err(message)?;
        ida.reinitialize(t, y, &yp)?;
        ida.set_differential(&ids)?;
        restart.configure(ida)?;
        Ok(Restarted {
            transactions: done,
            placements,
            yp,
            report,
        })
    }

    /// How the stage Jacobian is assembled.
    pub enum Assembly {
        /// One exact seeded joined evaluation per color of the operator's
        /// structural pattern: the reference.
        Colored,
        /// JAC's block assembly on its element-exact pattern, checked
        /// against the colored matrix entry by entry.
        Blocks(Box<JoinedJacobian>),
    }

    /// The joined operator as one stock-IDA system, with its sparse
    /// Jacobian and the symbolic analyses its block restarts reuse. A
    /// partial composition (a prepared port) is refused.
    pub struct Integrated<P: Properties> {
        pub joined: Joined<P>,
        rows: Vec<i64>,
        pointers: Vec<i64>,
        assembly: Assembly,
        analyses: Analyses,
    }
    impl<P: Properties + WaterProperties> Integrated<P> {
        /// On the colored assembly.
        pub fn new(joined: Joined<P>) -> Result<Self, String> {
            if !joined.integrable() {
                return Err(
                    "a joined operator with a prepared SG or rod port cannot be integrated".into(),
                );
            }
            let (pattern, _) = joined
                .structure()
                .ok_or("the joined operator has no structure")?;
            let (pointers, rows) = pattern.to_i64()?;
            Ok(Self {
                joined,
                rows,
                pointers,
                assembly: Assembly::Colored,
                analyses: Analyses::default(),
            })
        }
        /// On the block assembly, compiled at the value state `(t, y, 0)`;
        /// its pattern holds for every state and mode.
        pub fn with_blocks(mut joined: Joined<P>, t: f64, y: &[f64]) -> Result<Self, String> {
            if !joined.integrable() {
                return Err(
                    "a joined operator with a prepared SG or rod port cannot be integrated".into(),
                );
            }
            let structure = JoinedJacobian::compile(&mut joined, t, y).map_err(|f| match f {
                network::Failure::Recoverable(r) | network::Failure::Fatal(r) => r,
            })?;
            Self::from_blocks(joined, structure, Analyses::default())
        }
        /// On a block structure already compiled for this operator, with the
        /// symbolic analyses its consistent start made (a cache made on
        /// another pattern refuses at the first restart).
        pub fn from_blocks(
            joined: Joined<P>,
            structure: JoinedJacobian,
            analyses: Analyses,
        ) -> Result<Self, String> {
            if !joined.integrable() {
                return Err(
                    "a joined operator with a prepared SG or rod port cannot be integrated".into(),
                );
            }
            if structure.pattern.rows() != joined.dimension() {
                return Err("the block structure is not this operator's".into());
            }
            let (pointers, rows) = structure.pattern.to_i64()?;
            Ok(Self {
                joined,
                rows,
                pointers,
                assembly: Assembly::Blocks(Box::new(structure)),
                analyses,
            })
        }
        pub fn assembly(&self) -> &Assembly {
            &self.assembly
        }
        /// The symbolic analyses the restarts' block starts reuse.
        pub fn analyses(&self) -> &Analyses {
            &self.analyses
        }
    }
    impl<P: Properties + WaterProperties> System for Integrated<P> {
        fn dimension(&self) -> usize {
            self.joined.dimension()
        }
        /// AMD, approved for every joined solve (decision 0013). On the
        /// joined block pattern, stock KLU refactors in about half COLAMD's
        /// time, with fewer factor entries (JAC's Z5 cost receipt).
        fn klu_ordering(&self) -> KluOrdering {
            KluOrdering::Amd
        }
        fn nonzeros(&self) -> usize {
            self.rows.len()
        }
        /// The owners' root functions, read once at construction.
        fn root_count(&self) -> usize {
            self.joined.root_count()
        }
        fn roots(
            &mut self,
            time: f64,
            y: &[f64],
            yp: &[f64],
            out: &mut [f64],
        ) -> Result<(), Failure> {
            self.joined.roots(time, y, yp, out).map_err(failure)
        }
        fn residual(
            &mut self,
            time: f64,
            y: &[f64],
            yp: &[f64],
            out: &mut [f64],
        ) -> Result<(), Failure> {
            self.joined
                .evaluate(time, y, yp, None, 0., None)
                .map_err(failure)?;
            for (r, v) in out.iter_mut().zip(self.joined.rows()) {
                *r = v.value;
            }
            Ok(())
        }
        fn jacobian(
            &mut self,
            time: f64,
            cj: f64,
            y: &[f64],
            yp: &[f64],
            data: &mut [f64],
            rows: &mut [i64],
            pointers: &mut [i64],
        ) -> Result<(), Failure> {
            rows.copy_from_slice(&self.rows);
            pointers.copy_from_slice(&self.pointers);
            match &self.assembly {
                Assembly::Colored => self.joined.jacobian(time, cj, y, yp, data),
                Assembly::Blocks(structure) => {
                    // The operator counts its colored assemblies itself.
                    let started = std::time::Instant::now();
                    let result = jacobian_blocks(
                        &mut self.joined,
                        structure,
                        time,
                        cj,
                        y,
                        yp,
                        data,
                        Classes::ALL,
                    );
                    self.joined.counters.jacobians += 1;
                    self.joined.counters.jacobian_wall_s += started.elapsed().as_secs_f64();
                    result
                }
            }
            .map_err(failure)
        }
    }
}
