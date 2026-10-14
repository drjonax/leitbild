//! The S2 comparisons on credited series: the accuracy contract's run
//! against reference comparison (E0), located-event timing, the settling
//! measure (E), the settle-cap fit (critic H4) and the hold's drift.
//!
//! Every judgement filters with the declared zero-phase 4th-order
//! Butterworth at the credited band (`ld01-accuracy-contract`
//! `uncreditedAbove_Hz`) and reads its budgets and thresholds from the
//! declaration ([`Budgets::from`], [`settling_quantities`]); nothing is
//! hard-coded here.
//!
//! - **Comparison (E0):** the difference run − reference of each credited
//!   output, sampled on the observation grid, is low-passed; roof bias is the
//!   mean |filtered difference|, roof noise the standard deviation of the
//!   filtered error's change between output-interval samples, every other
//!   output the largest |filtered difference| over its instances. Core power
//!   is relative to the declared power basis (`powerBasis.basis_W`).
//! - **Located events:** each rod cluster's times to the declared insertion
//!   fractions (linear interpolation of its observed travel) and its seat
//!   (the seat restart's time) are compared by time difference against
//!   `thresholdTiming_s`; an event reached in one run only is a miss.
//! - **Settling (E, critic M2):** for each settling quantity the range
//!   (max − min) of its filtered output over each trailing window; settled
//!   when every quantity's last-window range is within its threshold
//!   (relative quantities: range over the window's mean |value|).
//! - **Settle-cap fit (H4):** one exponential `r(t) = A exp(−k (t − t_a))`
//!   per settling quantity, fitted by least squares on `ln r` over the last
//!   50 % of the run; `t_q` is where the fit meets the quantity's threshold,
//!   `t_fit` the latest `t_q`; the cap is `2 t_fit` simulated seconds and
//!   2 × the run's CPU to `t_fit`. Every fit's inputs are returned.
//! - **Drift (hold):** each filtered output's largest departure from its
//!   value at `measuredFrom_s`, against its ceiling.
use crate::filter::{DECLARED_FILTER, deviation, larger, max_abs, mean, zero_phase_lowpass};
use crate::gates::Declaration;
use serde_json::{Value, json};
use std::collections::{BTreeMap, VecDeque};

/// Credited output keys, as the runner records them.
pub mod key {
    pub const CORE_POWER_W: &str = "core_power_w";
    pub const REGIONAL_FRACTION: &str = "regional_fraction";
    pub const FUEL_DOPPLER_K: &str = "fuel_doppler_k";
    pub const CORE_CELL_K: &str = "core_cell_k";
    pub const AVERAGE_COOLANT_K: &str = "average_coolant_k";
    pub const PZR_ROOF_PA: &str = "pzr_roof_pa";
    pub const PZR_LEVEL_M: &str = "pzr_level_m";
    pub const CORE_DP_PA: &str = "core_dp_pa";
    pub const LOOP_FLOW_KG_S: &str = "loop_flow_kg_s";
    pub const SG_PRESSURE_PA: &str = "sg_pressure_pa";
    pub const SG_LIQUID_M3: &str = "sg_liquid_m3";
    pub const ROD_TRAVEL_M: &str = "rod_travel_m";
}

/// Credited outputs on one time axis: per key, per instance, the samples.
#[derive(Clone, Debug, Default)]
pub struct Credited {
    pub t: Vec<f64>,
    pub outputs: BTreeMap<String, Vec<Vec<f64>>>,
}

impl Credited {
    /// Append one sample; the first sample fixes each key's instance count.
    pub fn push(&mut self, t: f64, sample: &[(&str, Vec<f64>)]) -> Result<(), String> {
        if let Some(last) = self.t.last()
            && t <= *last
        {
            return Err(format!("credited sample at {t} s after {last} s"));
        }
        for (k, values) in sample {
            let series = self
                .outputs
                .entry(k.to_string())
                .or_insert_with(|| vec![Vec::new(); values.len()]);
            if series.len() != values.len() || series.iter().any(|s| s.len() != self.t.len()) {
                return Err(format!("credited output {k} changed shape at {t} s"));
            }
            for (s, v) in series.iter_mut().zip(values) {
                s.push(*v);
            }
        }
        self.t.push(t);
        Ok(())
    }
    pub fn len(&self) -> usize {
        self.t.len()
    }
    pub fn is_empty(&self) -> bool {
        self.t.is_empty()
    }
    /// Instances of `key`, refused when absent.
    pub fn output(&self, key: &str) -> Result<&Vec<Vec<f64>>, String> {
        self.outputs
            .get(key)
            .ok_or_else(|| format!("no credited output {key}"))
    }
    /// The samples on the grid `origin + j dt` over `[from, to]` (seconds
    /// from `origin`), every grid point present: their index range.
    pub fn grid(
        &self,
        origin: f64,
        from: f64,
        to: f64,
        dt: f64,
    ) -> Result<std::ops::Range<usize>, String> {
        let at = |s: f64| origin + s;
        let first = self
            .t
            .iter()
            .position(|t| *t >= at(from) - 1e-9 * dt)
            .ok_or_else(|| format!("no sample from {from} s"))?;
        let n = ((to - from) / dt).round() as usize;
        let range = first..first + n + 1;
        let Some(times) = self.t.get(range.clone()) else {
            return Err(format!(
                "{} of {} grid samples over [{from}, {to}] s",
                self.t.len() - first,
                n + 1
            ));
        };
        let off = times
            .iter()
            .enumerate()
            .map(|(j, t)| (t - at(from) - j as f64 * dt).abs())
            .fold(0., larger);
        if off > 1e-9 * dt.max(1.) {
            return Err(format!("samples leave the {dt} s grid by {off} s"));
        }
        Ok(range)
    }
}

/// The contract's budgets and the comparison's declared settings.
#[derive(Clone, Debug)]
pub struct Budgets {
    pub roof_bias_pa: f64,
    pub roof_noise_pa: f64,
    pub level_m: f64,
    pub core_dp_pa: f64,
    pub loop_flow_kg_s: f64,
    pub core_power_relative: f64,
    pub power_basis_w: f64,
    pub regional_fraction: f64,
    pub fuel_doppler_k: f64,
    pub core_cell_k: f64,
    pub sg_pressure_pa: f64,
    pub sg_liquid_m3: f64,
    pub timing_s: f64,
    pub insertion_fractions: Vec<f64>,
    pub rod_travel_reported_m: f64,
    pub cutoff_hz: f64,
    pub observation_s: f64,
    pub output_s: f64,
}

impl Budgets {
    /// Every budget from its owning block: the S1 contract
    /// (`ld01-accuracy-contract`), the S2 extension (`ld01-s2-accuracy`),
    /// the power basis and output interval (`ld01-s2-gates`) and the
    /// observation interval (`ld01-s1-gates`).
    pub fn from(d: &Declaration) -> Result<Self, String> {
        let filter = d.shared.text("/comparison/filter");
        if filter != DECLARED_FILTER {
            return Err(format!(
                "the declared filter is {filter}; the harness implements {DECLARED_FILTER}"
            ));
        }
        let observation_s = d.shared.number("/comparison/observation_s");
        let declared = d.gates.number("/observationInterval_s");
        if declared != observation_s {
            return Err(format!(
                "ld01-s2-gates observes every {declared} s, ld01-s1-gates every {observation_s} s"
            ));
        }
        let c = &d.contract;
        let a = &d.accuracy;
        Ok(Self {
            roof_bias_pa: c.number("/pzrRoofPressureBias_Pa"),
            roof_noise_pa: c.number("/pzrRoofPressureSampleNoise_Pa"),
            level_m: c.number("/pzrLevel_m"),
            core_dp_pa: c.number("/coreDifferentialPressure_Pa"),
            loop_flow_kg_s: c.number("/loopFlow_kg_s"),
            timing_s: c.number("/thresholdTiming_s"),
            cutoff_hz: c.number("/uncreditedAbove_Hz"),
            core_power_relative: a.number("/corePowerRelative"),
            power_basis_w: d.gates.number("/powerBasis/basis_W"),
            regional_fraction: a.number("/regionalPowerFraction"),
            fuel_doppler_k: a.number("/fuelDopplerTemperature_K"),
            core_cell_k: a.number("/coreCellTemperature_K"),
            sg_pressure_pa: a.number("/sgPressure_Pa"),
            sg_liquid_m3: a.number("/sgLiquidVolume_m3"),
            insertion_fractions: a.numbers("/rodInsertionFractions"),
            rod_travel_reported_m: a.number("/reportedOnly/rodTravel_m"),
            observation_s,
            output_s: d.gates.number("/outputInterval_s"),
        })
    }
    /// Each compared output's metric, the scale its difference is divided
    /// by (1 unless relative) and its budget; the roof's two metrics are
    /// computed separately ([`compare`]).
    pub fn metrics(&self) -> Vec<(&'static str, &'static str, f64, f64)> {
        vec![
            ("pzr_level_m", key::PZR_LEVEL_M, 1., self.level_m),
            ("core_dp_pa", key::CORE_DP_PA, 1., self.core_dp_pa),
            (
                "loop_flow_kg_s",
                key::LOOP_FLOW_KG_S,
                1.,
                self.loop_flow_kg_s,
            ),
            (
                "core_power_relative",
                key::CORE_POWER_W,
                self.power_basis_w,
                self.core_power_relative,
            ),
            (
                "regional_fraction",
                key::REGIONAL_FRACTION,
                1.,
                self.regional_fraction,
            ),
            (
                "fuel_doppler_k",
                key::FUEL_DOPPLER_K,
                1.,
                self.fuel_doppler_k,
            ),
            ("core_cell_k", key::CORE_CELL_K, 1., self.core_cell_k),
            (
                "sg_pressure_pa",
                key::SG_PRESSURE_PA,
                1.,
                self.sg_pressure_pa,
            ),
            ("sg_liquid_m3", key::SG_LIQUID_M3, 1., self.sg_liquid_m3),
        ]
    }
}

/// The comparison rule as receipts state it.
pub const COMPARISON_RULE: &str = "E0: each credited output's difference run - reference on the observation grid, low-passed by the declared zero-phase 4th-order Butterworth at the credited band; pzr_roof_bias_pa = mean |filtered difference|; pzr_roof_sample_noise_pa = population standard deviation of the filtered difference's change between output-interval samples; every other metric = max over instances and samples of |filtered difference| / scale (core power: the declared power basis; otherwise 1); within = evaluable and every metric at or below its budget";

/// E0 of `run` against `reference` over `[from, to]` seconds from their
/// common `origin`.
pub fn compare(
    run: &Credited,
    reference: &Credited,
    origin: f64,
    from: f64,
    to: f64,
    b: &Budgets,
) -> Value {
    let dt = b.observation_s;
    let (ra, rb) = match (
        run.grid(origin, from, to, dt),
        reference.grid(origin, from, to, dt),
    ) {
        (Ok(a), Ok(b)) => (a, b),
        (ea, eb) => {
            return json!({"from_s": from, "to_s": to, "evaluable": false, "run": ea.err(), "reference": eb.err(), "within": false});
        }
    };
    let filtered = |key: &str| -> Result<Vec<Vec<f64>>, String> {
        let (a, r) = (run.output(key)?, reference.output(key)?);
        if a.len() != r.len() {
            return Err(format!("{key}: {} against {} instances", a.len(), r.len()));
        }
        Ok(a.iter()
            .zip(r)
            .map(|(x, y)| {
                let raw: Vec<f64> = x[ra.clone()]
                    .iter()
                    .zip(&y[rb.clone()])
                    .map(|(p, q)| p - q)
                    .collect();
                zero_phase_lowpass(&raw, b.cutoff_hz, dt)
            })
            .collect())
    };
    let mut metrics = serde_json::Map::new();
    let mut within = true;
    let mut missing = Vec::new();
    match filtered(key::PZR_ROOF_PA) {
        Ok(roof) => {
            let roof = &roof[0];
            let per_output = (b.output_s / dt).round() as usize;
            let at_outputs: Vec<f64> = roof.iter().step_by(per_output).copied().collect();
            let changes: Vec<f64> = at_outputs.windows(2).map(|w| w[1] - w[0]).collect();
            let bias = mean(&roof.iter().map(|x| x.abs()).collect::<Vec<_>>());
            let noise = deviation(&changes);
            within &= bias <= b.roof_bias_pa && noise <= b.roof_noise_pa;
            metrics.insert(
                "pzr_roof_bias_pa".into(),
                json!({"value": bias, "budget": b.roof_bias_pa}),
            );
            metrics.insert(
                "pzr_roof_sample_noise_pa".into(),
                json!({"value": noise, "budget": b.roof_noise_pa}),
            );
        }
        Err(e) => missing.push(e),
    }
    for (name, k, scale, budget) in b.metrics() {
        match filtered(k) {
            Ok(series) => {
                let by: Vec<f64> = series.iter().map(|s| max_abs(s) / scale).collect();
                let value = by.iter().copied().fold(0., larger);
                within &= value <= budget;
                // Where the largest difference lies (s from the origin): a
                // maximum within the filter's padding of a window end that
                // cuts a fast transient is the zero-phase filter's edge.
                let at = series
                    .iter()
                    .flat_map(|s| s.iter().enumerate())
                    .max_by(|a, b| a.1.abs().total_cmp(&b.1.abs()))
                    .map(|(j, _)| from + j as f64 * dt);
                metrics.insert(
                    name.into(),
                    json!({"value": value, "budget": budget, "scale": scale, "at_s": at, "by_instance": by}),
                );
            }
            Err(e) => missing.push(e),
        }
    }
    let evaluable = missing.is_empty();
    json!({"from_s": from, "to_s": to, "evaluable": evaluable, "missing": missing,
        "observations": ra.len(), "observation_s": dt, "output_s": b.output_s, "cutoff_hz": b.cutoff_hz,
        "filter": DECLARED_FILTER, "rule": COMPARISON_RULE, "metrics": metrics,
        "within": evaluable && within})
}

/// Each cluster's first time (s from `origin`) at which its insertion
/// fraction `1 − travel/reference_travel` reaches each of `fractions` below
/// 1, by linear interpolation between observed samples; the seat (fraction
/// 1) is the located seat time given in `seats`.
pub fn insertion_times(
    run: &Credited,
    origin: f64,
    reference_travel_m: f64,
    fractions: &[f64],
    seats: &BTreeMap<usize, f64>,
) -> Result<Vec<Vec<Option<f64>>>, String> {
    let travel = run.output(key::ROD_TRAVEL_M)?;
    Ok(travel
        .iter()
        .enumerate()
        .map(|(c, y)| {
            fractions
                .iter()
                .map(|f| {
                    if *f >= 1. {
                        return seats.get(&c).map(|t| t - origin);
                    }
                    let inserted = |v: f64| 1. - v / reference_travel_m;
                    y.windows(2)
                        .zip(run.t.windows(2))
                        .find(|(v, _)| inserted(v[0]) < *f && inserted(v[1]) >= *f)
                        .map(|(v, t)| {
                            let (a, b) = (inserted(v[0]), inserted(v[1]));
                            t[0] + (t[1] - t[0]) * (f - a) / (b - a) - origin
                        })
                })
                .collect()
        })
        .collect())
}

/// Located-event timing of the rods: each cluster's times to each declared
/// fraction in both runs, against `thresholdTiming_s`; an event reached in
/// one run only is a miss. The travel itself is reported only.
pub fn compare_timing(
    run: &[Vec<Option<f64>>],
    reference: &[Vec<Option<f64>>],
    b: &Budgets,
) -> Value {
    let mut worst = 0_f64;
    let mut misses = Vec::new();
    let mut by_fraction = vec![0_f64; b.insertion_fractions.len()];
    for (c, (x, y)) in run.iter().zip(reference).enumerate() {
        for (k, (p, q)) in x.iter().zip(y).enumerate() {
            match (p, q) {
                (Some(p), Some(q)) => {
                    let d = (p - q).abs();
                    worst = larger(worst, d);
                    by_fraction[k] = larger(by_fraction[k], d);
                }
                (None, None) => {}
                _ => misses.push(json!({"cluster": c, "fraction": b.insertion_fractions[k], "run_s": p, "reference_s": q})),
            }
        }
    }
    let evaluable = run.len() == reference.len() && !run.is_empty();
    json!({"fractions": b.insertion_fractions, "max_abs_s": worst, "by_fraction_max_abs_s": by_fraction,
        "budget_s": b.timing_s, "misses": misses,
        "within": evaluable && misses.is_empty() && worst <= b.timing_s})
}

/// The largest |travel difference| over clusters and the window, reported
/// only (`reportedOnly.rodTravel_m`).
pub fn travel_difference(
    run: &Credited,
    reference: &Credited,
    origin: f64,
    from: f64,
    to: f64,
    b: &Budgets,
) -> Value {
    let dt = b.observation_s;
    match (
        run.grid(origin, from, to, dt),
        reference.grid(origin, from, to, dt),
        run.output(key::ROD_TRAVEL_M),
        reference.output(key::ROD_TRAVEL_M),
    ) {
        (Ok(ra), Ok(rb), Ok(x), Ok(y)) => {
            let worst = x
                .iter()
                .zip(y)
                .map(|(p, q)| {
                    p[ra.clone()]
                        .iter()
                        .zip(&q[rb.clone()])
                        .map(|(a, b)| (a - b).abs())
                        .fold(0., larger)
                })
                .fold(0., larger);
            json!({"max_abs_m": worst, "reported_only_m": b.rod_travel_reported_m})
        }
        _ => json!({"evaluable": false}),
    }
}

// ---------------------------------------------------------------- settling

/// One settling quantity: an output key, its threshold per window and
/// whether it is relative to the output's mean |value| over the window.
#[derive(Clone, Debug)]
pub struct Quantity {
    pub name: &'static str,
    pub key: &'static str,
    pub threshold: f64,
    pub relative: bool,
}

/// The settling quantities of `ld01-s2-gates` (E), in declaration order.
pub fn settling_quantities(d: &Declaration) -> Vec<Quantity> {
    let g = &d.gates;
    let q = |name, key, pointer: &str, relative| Quantity {
        name,
        key,
        threshold: g.number(pointer),
        relative,
    };
    vec![
        q(
            "core power",
            key::CORE_POWER_W,
            "/settling/corePowerRelative",
            true,
        ),
        q(
            "average coolant",
            key::AVERAGE_COOLANT_K,
            "/settling/averageCoolant_K",
            false,
        ),
        q(
            "core cell liquid temperature",
            key::CORE_CELL_K,
            "/settling/cellTemperature_K",
            false,
        ),
        q(
            "PT1 roof pressure",
            key::PZR_ROOF_PA,
            "/settling/pzrRoofPressure_Pa",
            false,
        ),
        q(
            "SG pressure",
            key::SG_PRESSURE_PA,
            "/settling/sgPressure_Pa",
            false,
        ),
        q("PZR level", key::PZR_LEVEL_M, "/settling/pzrLevel_m", false),
        q(
            "SG liquid volume",
            key::SG_LIQUID_M3,
            "/settling/sgLiquidVolume_m3",
            false,
        ),
        q(
            "loop flow",
            key::LOOP_FLOW_KG_S,
            "/settling/loopFlowRelativeChange",
            true,
        ),
    ]
}

/// The settling measure as receipts state it.
pub const SETTLING_RULE: &str = "range (max - min) of the 2 Hz zero-phase Butterworth filtered credited output over each trailing window of window_s (window_s/dt + 1 samples); a relative quantity divides it by the mean |filtered value| over the same window; settled when every quantity instance's last-window range is at or below its threshold";

/// Range (max − min) of `x` over each trailing window of `n + 1` samples:
/// entry `k` covers samples `k − n ..= k` (`k ≥ n`), by monotone deques.
pub fn trailing_ranges(x: &[f64], n: usize) -> Vec<f64> {
    let mut hi: VecDeque<usize> = VecDeque::new();
    let mut lo: VecDeque<usize> = VecDeque::new();
    let mut out = Vec::with_capacity(x.len().saturating_sub(n));
    for (k, v) in x.iter().enumerate() {
        while hi.back().is_some_and(|j| x[*j] <= *v) {
            hi.pop_back();
        }
        hi.push_back(k);
        while lo.back().is_some_and(|j| x[*j] >= *v) {
            lo.pop_back();
        }
        lo.push_back(k);
        let first = k.saturating_sub(n);
        while hi.front().is_some_and(|j| *j < first) {
            hi.pop_front();
        }
        while lo.front().is_some_and(|j| *j < first) {
            lo.pop_front();
        }
        if k >= n {
            out.push(x[hi[0]] - x[lo[0]]);
        }
    }
    out
}

/// Trailing means of |x| over the same windows as [`trailing_ranges`].
fn trailing_mean_abs(x: &[f64], n: usize) -> Vec<f64> {
    let mut sum = 0.;
    let mut out = Vec::with_capacity(x.len().saturating_sub(n));
    for (k, v) in x.iter().enumerate() {
        sum += v.abs();
        if k > n {
            sum -= x[k - n - 1].abs();
        }
        if k >= n {
            out.push(sum / (n + 1) as f64);
        }
    }
    out
}

/// Per quantity instance: the filtered series' trailing measure (range, or
/// range over mean |value| when relative), at the sample times `t[k]`,
/// `k ≥ window samples`.
pub fn settling_measures(
    run: &Credited,
    quantities: &[Quantity],
    window_s: f64,
    dt: f64,
    cutoff_hz: f64,
) -> Result<Vec<(String, f64, Vec<f64>)>, String> {
    let n = (window_s / dt).round() as usize;
    if run.len() <= n + 1 {
        return Err(format!(
            "{} samples do not cover one {window_s} s window",
            run.len()
        ));
    }
    let mut out = Vec::new();
    for q in quantities {
        for (i, x) in run.output(q.key)?.iter().enumerate() {
            let filtered = zero_phase_lowpass(x, cutoff_hz, dt);
            let ranges = trailing_ranges(&filtered, n);
            let measure = if q.relative {
                ranges
                    .iter()
                    .zip(trailing_mean_abs(&filtered, n))
                    .map(|(r, m)| r / m)
                    .collect()
            } else {
                ranges
            };
            out.push((format!("{}[{i}]", q.name), q.threshold, measure));
        }
    }
    Ok(out)
}

/// The settled judgement at the run's last sample: each quantity
/// instance's last-window measure against its threshold.
pub fn settled(
    run: &Credited,
    quantities: &[Quantity],
    window_s: f64,
    dt: f64,
    cutoff_hz: f64,
) -> (bool, Value) {
    match settling_measures(run, quantities, window_s, dt, cutoff_hz) {
        Ok(measures) => {
            let mut all = true;
            let by: Vec<Value> = measures
                .iter()
                .map(|(name, threshold, m)| {
                    let last = *m.last().unwrap();
                    let holds = last <= *threshold;
                    all &= holds;
                    json!({"quantity": name, "measure": last, "threshold": threshold, "holds": holds})
                })
                .collect();
            (
                all,
                json!({"rule": SETTLING_RULE, "window_s": window_s, "settled": all, "quantities": by}),
            )
        }
        Err(e) => (false, json!({"evaluable": false, "reason": e})),
    }
}

/// One least-squares exponential `r(t) = A exp(−k (t − t_a))` on `ln r`.
#[derive(Clone, Debug)]
pub struct Exponential {
    pub t_a: f64,
    pub a: f64,
    pub k_per_s: f64,
    pub rms_log_residual: f64,
    pub points: usize,
}

impl Exponential {
    /// Ordinary least squares of `ln r` on `t`; every `r` must be positive.
    pub fn fit(t: &[f64], r: &[f64]) -> Result<Self, String> {
        if t.len() != r.len() || t.len() < 3 {
            return Err(format!("{} points cannot fit an exponential", t.len()));
        }
        if let Some(k) = r.iter().position(|v| !(*v > 0. && v.is_finite())) {
            return Err(format!(
                "range {} at {} s is not positive: no logarithm",
                r[k], t[k]
            ));
        }
        let t_a = t[0];
        let x: Vec<f64> = t.iter().map(|v| v - t_a).collect();
        let l: Vec<f64> = r.iter().map(|v| v.ln()).collect();
        let (mx, ml) = (mean(&x), mean(&l));
        let sxx: f64 = x.iter().map(|v| (v - mx) * (v - mx)).sum();
        let sxl: f64 = x.iter().zip(&l).map(|(a, b)| (a - mx) * (b - ml)).sum();
        let slope = sxl / sxx;
        let intercept = ml - slope * mx;
        let residuals: Vec<f64> = x
            .iter()
            .zip(&l)
            .map(|(a, b)| b - intercept - slope * a)
            .collect();
        Ok(Self {
            t_a,
            a: intercept.exp(),
            k_per_s: -slope,
            rms_log_residual: (residuals.iter().map(|v| v * v).sum::<f64>()
                / residuals.len() as f64)
                .sqrt(),
            points: t.len(),
        })
    }
    pub fn at(&self, t: f64) -> f64 {
        self.a * (-self.k_per_s * (t - self.t_a)).exp()
    }
    /// The time the fit meets `level`; `None` unless it decays.
    pub fn reaches(&self, level: f64) -> Option<f64> {
        (self.k_per_s > 0.).then(|| self.t_a + (self.a / level).ln() / self.k_per_s)
    }
}

/// The settle-cap fit rule as receipts state it.
pub const SETTLE_CAP_RULE: &str = "critic H4 / revision 7 (E): per settling quantity instance, one exponential r(t) = A exp(-k (t - t_a)) fitted by ordinary least squares on ln r over the run's last 50 % (samples with t >= t_end/2 and a full trailing window), r the settling measure; t_q = the fit's crossing of the quantity's threshold; t_fit = max t_q; cap = 2 t_fit simulated seconds (from the run's start) and 2 x the run's process CPU to t_fit (linear interpolation of the CPU trace; beyond its end, extrapolated at the last 50 %'s mean CPU rate)";

/// H4's settle-cap fit over a settling run: `run` on its output grid from
/// `origin`, `cpu` the run's cumulative CPU at sample times `(t, cpu_s)`.
pub fn settle_cap_fit(
    run: &Credited,
    origin: f64,
    cpu: &[(f64, f64)],
    quantities: &[Quantity],
    window_s: f64,
    dt: f64,
    cutoff_hz: f64,
) -> Value {
    let measures = match settling_measures(run, quantities, window_s, dt, cutoff_hz) {
        Ok(m) => m,
        Err(e) => return json!({"rule": SETTLE_CAP_RULE, "evaluable": false, "reason": e}),
    };
    let n = (window_s / dt).round() as usize;
    let times: Vec<f64> = run.t[n..].iter().map(|t| t - origin).collect();
    let end = run.t[run.len() - 1] - origin;
    let from = times
        .iter()
        .position(|t| *t >= end / 2.)
        .unwrap_or(times.len());
    let mut fits = Vec::new();
    let mut t_fit: Option<f64> = Some(f64::NEG_INFINITY);
    let mut refusals = Vec::new();
    for (name, threshold, m) in &measures {
        let (t, r) = (&times[from..], &m[from..]);
        match Exponential::fit(t, r) {
            Ok(f) => {
                let crossing = f.reaches(*threshold);
                t_fit = t_fit.zip(crossing).map(|(a, b)| a.max(b));
                if crossing.is_none() {
                    refusals.push(format!("{name}: the fitted range does not decay"));
                }
                fits.push(json!({"quantity": name, "threshold": threshold, "points": f.points,
                    "t_a_s": f.t_a, "a": f.a, "k_per_s": f.k_per_s, "rms_log_residual": f.rms_log_residual,
                    "t_q_s": crossing, "first": [t.first(), r.first()], "last": [t.last(), r.last()],
                    "inputs_every_1s": t.iter().zip(r).step_by((1. / dt).round().max(1.) as usize).map(|(a, b)| [*a, *b]).collect::<Vec<_>>()}));
            }
            Err(e) => {
                t_fit = None;
                refusals.push(format!("{name}: {e}"));
                fits.push(json!({"quantity": name, "threshold": threshold, "refused": e}));
            }
        }
    }
    let t_fit = t_fit.filter(|t| t.is_finite());
    let cpu_at = |t: f64| -> Option<(f64, bool)> {
        let k = cpu.iter().position(|(s, _)| *s >= t);
        match k {
            Some(0) => Some((cpu[0].1, false)),
            Some(k) => {
                let ((t0, c0), (t1, c1)) = (cpu[k - 1], cpu[k]);
                Some((c0 + (c1 - c0) * (t - t0) / (t1 - t0), false))
            }
            None => {
                let half = cpu.iter().position(|(s, _)| *s >= end / 2.)?;
                let ((t0, c0), (t1, c1)) = (cpu[half], *cpu.last()?);
                (t1 > t0).then(|| (c1 + (c1 - c0) / (t1 - t0) * (t - t1), true))
            }
        }
    };
    let cpu_fit = t_fit.and_then(cpu_at);
    json!({"rule": SETTLE_CAP_RULE, "evaluable": refusals.is_empty(), "refusals": refusals,
        "window_s": window_s, "sample_s": dt, "run_end_s": end, "fit_from_s": times.get(from),
        "t_fit_s": t_fit, "cpu_to_t_fit_s": cpu_fit.map(|c| c.0), "cpu_extrapolated": cpu_fit.map(|c| c.1),
        "cap_simulated_s": t_fit.map(|t| 2. * t), "cap_cpu_s": cpu_fit.map(|c| 2. * c.0),
        "fits": fits})
}

// ------------------------------------------------------------------- drift

/// The hold's drift: each filtered output's largest |departure| from its
/// filtered value at `from` (relative outputs over that value), per
/// `(key, ceiling, relative)`, judged over `[from, end]`.
pub fn drift(
    run: &Credited,
    origin: f64,
    from: f64,
    ceilings: &[(&str, f64, bool)],
    dt: f64,
    cutoff_hz: f64,
) -> Value {
    let Some(k0) = run.t.iter().position(|t| *t >= origin + from - 1e-9 * dt) else {
        return json!({"evaluable": false, "reason": format!("no sample at {from} s"), "within": false});
    };
    let mut within = true;
    let mut out = serde_json::Map::new();
    for (k, ceiling, relative) in ceilings {
        match run.output(k) {
            Ok(series) => {
                let by: Vec<f64> = series
                    .iter()
                    .map(|x| {
                        let f = zero_phase_lowpass(x, cutoff_hz, dt);
                        let base = f[k0];
                        let d = f[k0..].iter().map(|v| (v - base).abs()).fold(0., larger);
                        if *relative { d / base.abs() } else { d }
                    })
                    .collect();
                let worst = by.iter().copied().fold(0., larger);
                within &= worst <= *ceiling;
                out.insert(
                    k.to_string(),
                    json!({"value": worst, "ceiling": ceiling, "relative": relative, "by_instance": by}),
                );
            }
            Err(e) => {
                within = false;
                out.insert(k.to_string(), json!({"evaluable": false, "reason": e}));
            }
        }
    }
    json!({"from_s": from, "outputs": out, "within": within})
}

/// The hold's drift ceilings from `hold.driftCeiling`.
pub fn drift_ceilings(d: &Declaration) -> Vec<(&'static str, f64, bool)> {
    let g = &d.gates;
    vec![
        (
            key::CORE_POWER_W,
            g.number("/hold/driftCeiling/corePowerRelative"),
            true,
        ),
        (
            key::AVERAGE_COOLANT_K,
            g.number("/hold/driftCeiling/averageCoolant_K"),
            false,
        ),
        (
            key::PZR_ROOF_PA,
            g.number("/hold/driftCeiling/pzrRoofPressure_Pa"),
            false,
        ),
        (
            key::PZR_LEVEL_M,
            g.number("/hold/driftCeiling/pzrLevel_m"),
            false,
        ),
        (
            key::SG_PRESSURE_PA,
            g.number("/hold/driftCeiling/sgPressure_Pa"),
            false,
        ),
        (
            key::SG_LIQUID_M3,
            g.number("/hold/driftCeiling/sgLiquidVolume_m3"),
            false,
        ),
    ]
}
