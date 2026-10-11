//! Shared helpers of the opt-in SG secondary checks. NOT S2 evidence.
//!
//! The `secondary` section and the probe section are compiled from the wiki
//! by `reference-design-operating-sg.ts` and named by
//! `LD01_OPERATING_SG_SECTION` and `LD01_OPERATING_SG_PROBE`; nothing is
//! defaulted. `Standalone` composes the secondary block with the SG metal and
//! both films of the held SG primary cell, in the joined spine's evaluation
//! order (views, metal heat, secondary rows), plus integrator-consistent
//! receipt ledgers. It stands in for the joined solids only in isolated
//! probes; the joined operator owns that metal.
#![allow(dead_code)]
use leitbild_operating_plant::{
    joined::{
        block::{Coordinates, Secondary, SecondaryView},
        packet::SecondaryStock,
    },
    network::{self, BandReport, ConsistentSystem, Failure, MetastableBand, Water},
    sg::{
        PrimaryPort, Secondaries, Segment, Tube,
        packet::{Probe, Section},
    },
    sparse::{self, Coloring, Pattern},
    thermal::{self, Saturation, Scalar, WaterPoint, WaterProperties},
};
use leitbild_operating_water::{CaloricLinearization, If97};
use std::cell::Cell;

pub fn section() -> Section {
    let path = std::env::var("LD01_OPERATING_SG_SECTION").expect("LD01_OPERATING_SG_SECTION");
    serde_json::from_str(&std::fs::read_to_string(path).expect("section")).expect("section shape")
}
pub fn probe() -> Probe {
    let path = std::env::var("LD01_OPERATING_SG_PROBE").expect("LD01_OPERATING_SG_PROBE");
    serde_json::from_str(&std::fs::read_to_string(path).expect("probe")).expect("probe shape")
}

#[repr(C)]
struct Timespec {
    seconds: i64,
    nanoseconds: i64,
}
unsafe extern "C" {
    fn clock_gettime(clock: i32, out: *mut Timespec) -> i32;
}
/// Thread CPU seconds (CLOCK_THREAD_CPUTIME_ID: 16 on macOS, 3 on Linux).
pub fn cpu() -> f64 {
    let id = if cfg!(target_os = "macos") { 16 } else { 3 };
    let mut t = Timespec {
        seconds: 0,
        nanoseconds: 0,
    };
    // SAFETY: one live stack Timespec in the C layout; nothing retained.
    let status = unsafe { clock_gettime(id, &mut t) };
    assert_eq!(status, 0, "thread CPU clock unavailable");
    t.seconds as f64 + t.nanoseconds as f64 * 1e-9
}

/// Delegates every query to the maintained IF97 adapter and counts it.
#[derive(Clone, Default)]
pub struct Counted {
    pub saturation: Cell<u64>,
    pub liquid: Cell<u64>,
    pub vapor: Cell<u64>,
    pub saturated_vapor_density: Cell<u64>,
    pub forward: Cell<u64>,
    pub caloric: Cell<u64>,
    pub direction: Cell<u64>,
}
fn bump(c: &Cell<u64>) {
    c.set(c.get() + 1);
}
impl Counted {
    pub fn total(&self) -> u64 {
        [
            &self.saturation,
            &self.liquid,
            &self.vapor,
            &self.saturated_vapor_density,
            &self.forward,
            &self.caloric,
            &self.direction,
        ]
        .iter()
        .map(|c| c.get())
        .sum()
    }
    pub fn json(&self) -> serde_json::Value {
        serde_json::json!({"saturation":self.saturation.get(),"liquid":self.liquid.get(),"vapor":self.vapor.get(),
            "saturatedVaporDensity":self.saturated_vapor_density.get(),"forward":self.forward.get(),
            "caloricInverse":self.caloric.get(),"caloricDirection":self.direction.get()})
    }
    pub fn reset(&self) {
        for c in [
            &self.saturation,
            &self.liquid,
            &self.vapor,
            &self.saturated_vapor_density,
            &self.forward,
            &self.caloric,
            &self.direction,
        ] {
            c.set(0);
        }
    }
}
impl WaterProperties for Counted {
    fn liquid(&self, p: Scalar, t: Scalar) -> thermal::Result<WaterPoint> {
        bump(&self.liquid);
        If97.liquid(p, t)
    }
    fn vapor(&self, p: Scalar, t: Scalar) -> thermal::Result<WaterPoint> {
        bump(&self.vapor);
        If97.vapor(p, t)
    }
    fn saturation(&self, p: Scalar) -> thermal::Result<Saturation> {
        bump(&self.saturation);
        WaterProperties::saturation(&If97, p)
    }
    fn saturated_vapor_density(&self, t: Scalar) -> thermal::Result<Scalar> {
        bump(&self.saturated_vapor_density);
        If97.saturated_vapor_density(t)
    }
}
impl network::Properties for Counted {
    type Caloric = CaloricLinearization;
    fn forward(&self, vapor: bool, p: f64, t: f64) -> Result<Water, String> {
        bump(&self.forward);
        If97.forward(vapor, p, t)
    }
    fn caloric(
        &self,
        vapor: bool,
        p: f64,
        target: f64,
        enthalpy: bool,
    ) -> Result<CaloricLinearization, String> {
        bump(&self.caloric);
        If97.caloric(vapor, p, target, enthalpy)
    }
    fn values(&self, point: &CaloricLinearization) -> Water {
        If97.values(point)
    }
    fn direction(&self, point: &CaloricLinearization, dp: f64, dt: f64) -> Result<Water, String> {
        bump(&self.direction);
        If97.direction(point, dp, dt)
    }
    fn saturation(&self, p: Scalar) -> Result<Saturation, String> {
        bump(&self.saturation);
        network::Properties::saturation(&If97, p)
    }
    fn metastable_band(&self) -> Result<MetastableBand, String> {
        If97.metastable_band()
    }
    fn band(&self, point: &CaloricLinearization) -> BandReport {
        If97.band(point)
    }
}

/// The heat the secondaries receive in a probe.
#[derive(Clone, Debug)]
pub enum Heat {
    /// Four metal segments per SG against the held SG primary cell.
    Tube(Vec<PrimaryPort>),
    /// A declared piecewise-constant heat per SG: (start time s, W per SG).
    Schedule(Vec<(f64, Vec<f64>)>),
}

/// Last evaluation's diagnostics in physical units.
#[derive(Clone, Debug, Default)]
pub struct Observed {
    pub views: Vec<(f64, f64, f64)>,
    pub heat_w: Vec<f64>,
    pub primary_w: Vec<f64>,
    pub metal_k: Vec<Vec<f64>>,
}

/// Secondary block + (tube) metal + ledgers as one square system in solver
/// scaling: rows divided by their row scales.
pub struct Standalone<P> {
    pub props: P,
    pub secondary: Secondaries,
    pub tube: Option<Tube>,
    pub segments: Vec<Segment>,
    pub heat: Heat,
    /// [secondary | metal | ledgers].
    pub scales: Vec<f64>,
    pub row_scales: Vec<f64>,
    pub ids: Vec<f64>,
    pub secondary_len: usize,
    pub metal_len: usize,
    /// Ledgers per SG: mass, secondary energy, and metal energy (tube only).
    pub ledgers_per_sg: usize,
    pub rows: Vec<Scalar>,
    views: Vec<SecondaryView>,
    sec_rows: Vec<Scalar>,
    pub observed: Observed,
    pub pattern: Pattern,
    pub coloring: Coloring,
    pub evaluations: u64,
}

fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}

impl<P: leitbild_operating_plant::sg::Properties> Standalone<P> {
    /// Compose from the section, stocks and heat; tube heat also needs the
    /// probe's tube law, segments and the prepared metal temperature.
    pub fn new(
        props: P,
        section: &Section,
        stocks: &[SecondaryStock],
        heat: Heat,
        probe: &Probe,
    ) -> Result<(Self, Vec<f64>), Failure> {
        let secondary = Secondaries::new(section, stocks, &props)?;
        let layout = Secondary::<P>::layout(&secondary).clone();
        let n_sg = Secondary::<P>::generators(&secondary);
        let prepared = Secondary::<P>::prepared(&secondary);
        let mut scales = layout.scales.clone();
        let mut row_scales = layout.row_scales.clone();
        let mut ids = layout.ids();
        let mut y: Vec<f64> = prepared.iter().zip(&scales).map(|(v, s)| v / s).collect();
        let (tube, segments): (Option<Tube>, Vec<Segment>) = match heat {
            Heat::Tube(_) => (
                Some(Tube::new(&section.contact, probe.tube.thermal_diameter_m)?),
                probe.segments.iter().map(Segment::from).collect(),
            ),
            Heat::Schedule(_) => (None, Vec::new()),
        };
        let metal_k = tube.map(|_| {
            let sat =
                WaterProperties::saturation(&props, s(probe.preparation.secondary_pressure_pa))
                    .expect("prepared saturation");
            0.5 * (probe.preparation.metal_cold_temperature_k + sat.temperature.value)
        });
        let mut metal_len = 0;
        if let Some(t) = metal_k {
            for _ in 0..n_sg {
                for g in &segments {
                    let e = g.capacity_j_k * (t - 273.15);
                    scales.push(e);
                    row_scales.push(e);
                    ids.push(1.);
                    y.push(1.);
                    metal_len += 1;
                }
            }
        }
        let ledgers_per_sg = if tube.is_some() { 3 } else { 2 };
        for k in 0..n_sg {
            let b = secondary.steam_generators()[k].base;
            let metal_total: f64 = (0..segments.len())
                .map(|i| scales[layout.len() + k * segments.len() + i])
                .sum();
            let list = [scales[b], scales[b + 1], metal_total];
            for v in &list[..ledgers_per_sg] {
                scales.push(*v);
                row_scales.push(*v);
                ids.push(1.);
                y.push(0.);
            }
        }
        let n = scales.len();
        let mut me = Self {
            props,
            secondary,
            tube,
            segments,
            heat,
            scales,
            row_scales,
            ids,
            secondary_len: layout.len(),
            metal_len,
            ledgers_per_sg,
            rows: vec![s(0.); n],
            views: vec![
                SecondaryView {
                    pressure: s(0.),
                    saturation_temperature: s(0.),
                    liquid_volume: s(0.),
                    steam_present: true,
                };
                n_sg
            ],
            sec_rows: vec![s(0.); layout.len()],
            observed: Observed::default(),
            pattern: Pattern::new(1, vec![0, 0], vec![]).expect("placeholder"),
            coloring: Coloring::greedy(&Pattern::new(1, vec![0, 0], vec![]).expect("placeholder")),
            evaluations: 0,
        };
        me.pattern = Pattern::from_rows(n, &me.dependencies()).map_err(Failure::Fatal)?;
        me.coloring = Coloring::greedy(&me.pattern);
        me.coloring.verify(&me.pattern).map_err(Failure::Fatal)?;
        Ok((me, y))
    }

    pub fn n(&self) -> usize {
        self.scales.len()
    }
    fn metal_index(&self, k: usize, i: usize) -> usize {
        self.secondary_len + k * self.segments.len() + i
    }
    fn ledger_index(&self, k: usize, j: usize) -> usize {
        self.secondary_len + self.metal_len + k * self.ledgers_per_sg + j
    }

    /// Row-wise structural dependencies of the composed system, from the
    /// block's declared structure and the metal and ledger composition.
    pub fn dependencies(&self) -> Vec<Vec<usize>> {
        let st = Secondary::<P>::structure(&self.secondary);
        let n_sg = self.secondary.steam_generators().len();
        let mut rows: Vec<Vec<usize>> = vec![Vec::new(); self.n()];
        let metal_of = |k: usize| (0..self.segments.len()).map(move |i| (k, i));
        for (r, own) in st.own.iter().enumerate() {
            rows[r] = own.clone();
            for &k in &st.heat[r] {
                // The heat reads the metal of SG k and its view.
                rows[r].extend(st.outputs[k].iter().copied());
                rows[r].extend(metal_of(k).map(|(k, i)| self.metal_index(k, i)));
            }
        }
        for k in 0..n_sg {
            let g = &self.secondary.steam_generators()[k];
            for i in 0..self.segments.len() {
                let m = self.metal_index(k, i);
                rows[m] = st.outputs[k].clone();
                rows[m].push(m);
            }
            // Ledgers: mass (exactly zero receipt), secondary energy receipt
            // (the energy row less U'), metal net heat.
            let lm = self.ledger_index(k, 0);
            rows[lm] = vec![lm];
            let lu = self.ledger_index(k, 1);
            rows[lu] = rows[g.base + 1]
                .iter()
                .copied()
                .filter(|c| *c != g.base + 1)
                .collect();
            rows[lu].push(lu);
            if self.ledgers_per_sg == 3 {
                let le = self.ledger_index(k, 2);
                rows[le] = st.outputs[k].clone();
                rows[le].extend(metal_of(k).map(|(k, i)| self.metal_index(k, i)));
                rows[le].push(le);
            }
        }
        for r in &mut rows {
            r.sort_unstable();
            r.dedup();
        }
        rows
    }

    fn heat_schedule(&self, t: f64) -> Vec<f64> {
        match &self.heat {
            Heat::Schedule(steps) => {
                let mut current = steps[0].1.clone();
                for (start, w) in steps {
                    if t >= *start {
                        current = w.clone();
                    }
                }
                current
            }
            Heat::Tube(_) => unreachable!(),
        }
    }
    /// Time events of a heat schedule after `t`.
    pub fn schedule_times(&self) -> Vec<f64> {
        match &self.heat {
            Heat::Schedule(steps) => steps.iter().skip(1).map(|(t, _)| *t).collect(),
            Heat::Tube(_) => Vec::new(),
        }
    }

    /// Evaluate every scaled row at (t, y, y') along `seed`.
    pub fn evaluate(
        &mut self,
        t: f64,
        y: &[f64],
        yp: &[f64],
        seed: Option<&[f64]>,
        cj: f64,
    ) -> Result<(), Failure> {
        self.evaluations += 1;
        let ns = self.secondary_len;
        let x = Coordinates::new(
            &y[..ns],
            &yp[..ns],
            seed.map(|d| &d[..ns]),
            cj,
            &self.scales[..ns],
        )?;
        let full = Coordinates::new(y, yp, seed, cj, &self.scales)?;
        Secondary::<P>::views(&mut self.secondary, &self.props, x, &mut self.views)?;
        let n_sg = self.views.len();
        let mut heat = vec![s(0.); n_sg];
        self.observed.views = self
            .views
            .iter()
            .map(|v| {
                (
                    v.pressure.value,
                    v.saturation_temperature.value,
                    v.liquid_volume.value,
                )
            })
            .collect();
        self.observed.primary_w = vec![0.; n_sg];
        self.observed.metal_k = vec![Vec::new(); n_sg];
        let mut net_metal = vec![s(0.); n_sg];
        match &self.heat {
            Heat::Tube(ports) => {
                let tube = self.tube.expect("tube law");
                for k in 0..n_sg {
                    for (i, g) in self.segments.iter().enumerate() {
                        let m = self.metal_index(k, i);
                        let wall = s(273.15) + full.value(m) / s(g.capacity_j_k);
                        let (qp, qs) =
                            tube.segment_heat(&self.props, &ports[k], &self.views[k], wall, g)?;
                        self.rows[m] = (full.rate(m) - (qp - qs)) / s(self.row_scales[m]);
                        heat[k] = heat[k] + qs;
                        net_metal[k] = net_metal[k] + (qp - qs);
                        self.observed.primary_w[k] += qp.value;
                        self.observed.metal_k[k].push(wall.value);
                    }
                }
            }
            Heat::Schedule(_) => {
                for (h, w) in heat.iter_mut().zip(self.heat_schedule(t)) {
                    *h = s(w);
                }
            }
        }
        self.observed.heat_w = heat.iter().map(|h| h.value).collect();
        Secondary::<P>::rows(
            &mut self.secondary,
            &self.props,
            t,
            x,
            &heat,
            &mut self.sec_rows,
        )?;
        for i in 0..ns {
            self.rows[i] = self.sec_rows[i] / s(self.row_scales[i]);
        }
        for (k, b) in self.secondary.boundaries().to_vec().iter().enumerate() {
            let lm = self.ledger_index(k, 0);
            self.rows[lm] = (full.rate(lm) - b.mass_receipt_kg_s) / s(self.row_scales[lm]);
            let lu = self.ledger_index(k, 1);
            self.rows[lu] = (full.rate(lu) - b.energy_receipt_w) / s(self.row_scales[lu]);
            if self.ledgers_per_sg == 3 {
                let le = self.ledger_index(k, 2);
                self.rows[le] = (full.rate(le) - net_metal[k]) / s(self.row_scales[le]);
            }
        }
        Ok(())
    }

    pub fn values(&mut self, t: f64, y: &[f64], yp: &[f64]) -> Result<Vec<f64>, Failure> {
        self.evaluate(t, y, yp, None, 0.)?;
        Ok(self.rows.iter().map(|r| r.value).collect())
    }

    /// Dense seeded `dF/dy + cj dF/dy'`, column-major.
    pub fn dense(&mut self, t: f64, cj: f64, y: &[f64], yp: &[f64]) -> Result<Vec<f64>, Failure> {
        let n = self.n();
        let mut out = vec![0.; n * n];
        let mut seed = vec![0.; n];
        for j in 0..n {
            seed[j] = 1.;
            let r = self.evaluate(t, y, yp, Some(&seed), cj);
            seed[j] = 0.;
            r?;
            for i in 0..n {
                out[j * n + i] = self.rows[i].direction;
            }
        }
        Ok(out)
    }

    /// Colored seeded assembly on the declared pattern; refuses an omitted
    /// dependency through `sparse::scatter`.
    pub fn colored(
        &mut self,
        t: f64,
        cj: f64,
        y: &[f64],
        yp: &[f64],
        values: &mut [f64],
    ) -> Result<(), Failure> {
        let n = self.n();
        let signs = vec![1.; n];
        let mut seed = vec![0.; n];
        let mut directions = vec![0.; n];
        for color in 0..self.coloring.count() {
            self.coloring
                .seed_into(color, &signs, &mut seed)
                .map_err(Failure::Fatal)?;
            self.evaluate(t, y, yp, Some(&seed), cj)?;
            for (d, r) in directions.iter_mut().zip(&self.rows) {
                *d = r.direction;
            }
            sparse::scatter(
                &self.pattern,
                &self.coloring,
                color,
                &directions,
                &signs,
                values,
            )
            .map_err(Failure::Fatal)?;
        }
        Ok(())
    }

    /// Colored forward differences of the value rows on the same pattern.
    pub fn colored_differences(
        &mut self,
        t: f64,
        cj: f64,
        y: &[f64],
        yp: &[f64],
        values: &mut [f64],
    ) -> Result<(), Failure> {
        let n = self.n();
        let base = self.values(t, y, yp)?;
        let step = f64::EPSILON.sqrt();
        let (mut yd, mut ypd) = (y.to_vec(), yp.to_vec());
        let mut delta = vec![0.; n];
        for color in 0..self.coloring.count() {
            let columns = self
                .coloring
                .columns(color)
                .map_err(Failure::Fatal)?
                .to_vec();
            let mut claimed = vec![usize::MAX; n];
            for &j in &columns {
                delta[j] = step * y[j].abs().max(1.);
                yd[j] = y[j] + delta[j];
                ypd[j] = yp[j] + cj * delta[j];
                for &r in self.pattern.column(j) {
                    claimed[r] = j;
                }
            }
            let perturbed = self.values(t, &yd, &ypd);
            yd.copy_from_slice(y);
            ypd.copy_from_slice(yp);
            let perturbed = perturbed?;
            for row in 0..n {
                let change = perturbed[row] - base[row];
                match claimed[row] {
                    usize::MAX if change != 0. => {
                        return Err(Failure::Fatal(format!(
                            "difference changed unclaimed row {row} by {change} in color {color}"
                        )));
                    }
                    usize::MAX => {}
                    j => {
                        let position = self.pattern.position(row, j).expect("stored entry");
                        values[position] = change / delta[j];
                    }
                }
            }
        }
        Ok(())
    }

    /// The prepared state's IDA error weights for a declared tolerance pair.
    pub fn weights(&self, y: &[f64], rtol: f64, atol: f64) -> Vec<f64> {
        y.iter().map(|v| 1. / (rtol * v.abs() + atol)).collect()
    }
}

impl<P: leitbild_operating_plant::sg::Properties> ConsistentSystem for Standalone<P> {
    fn system_dimension(&self) -> usize {
        self.n()
    }
    fn rows_at(&mut self, t: f64, y: &[f64], yp: &[f64]) -> Result<Vec<f64>, Failure> {
        self.values(t, y, yp)
    }
    fn pencil_at(
        &mut self,
        t: f64,
        y: &[f64],
        yp: &[f64],
    ) -> Result<(Vec<f64>, Vec<f64>), Failure> {
        let a = self.dense(t, 0., y, yp)?;
        let ab = self.dense(t, 1., y, yp)?;
        Ok((a.clone(), ab.iter().zip(&a).map(|(x, y)| x - y).collect()))
    }
}

/// Held SG primary ports of the probe, per SG.
pub fn held_ports<P: WaterProperties>(props: &P, probe: &Probe) -> Vec<PrimaryPort> {
    let q = &probe.primary;
    q.mass_flow_kg_s
        .iter()
        .map(|m| {
            PrimaryPort::held(props, q.pressure_pa, q.temperature_k, m / q.flow_area_m2)
                .expect("held primary")
        })
        .collect()
}

/// The probe's prepared stocks on the runtime chart.
pub fn prepared_stocks<P: leitbild_operating_plant::sg::Properties>(
    props: &P,
    section: &Section,
    probe: &Probe,
) -> Vec<SecondaryStock> {
    Secondaries::stocks_at(
        section,
        props,
        probe.preparation.secondary_pressure_pa,
        probe.preparation.liquid_volume_m3,
    )
    .expect("prepared stocks")
}

#[cfg(feature = "ida")]
pub mod integrate {
    //! Stock IDA/KLU over the standalone composition, with the exact
    //! consistent start at t = 0 and after every event (never IDACalcIC).
    use super::Standalone;
    use leitbild_operating_plant::{
        joined::block::{Command, Coordinates, Secondary},
        network::{self, Failure as NetFailure},
        sg::{Properties, Valve},
    };
    use leitbild_operating_water::ida::{Advance, Failure, Ida, Initial, System};
    use serde_json::{Value, json};

    fn ida_failure(f: NetFailure) -> Failure {
        match f {
            NetFailure::Recoverable(r) => Failure::Recoverable(r),
            NetFailure::Fatal(r) => Failure::Fatal(r),
        }
    }

    pub struct Integrated<P> {
        pub sys: Standalone<P>,
        pointers: Vec<i64>,
        indices: Vec<i64>,
        values: Vec<f64>,
        pub residuals: u64,
        pub jacobians: u64,
        pub jacobian_cpu_s: f64,
        pub residual_cpu_s: f64,
    }
    impl<P: Properties> Integrated<P> {
        pub fn new(sys: Standalone<P>) -> Self {
            let (pointers, indices) = sys.pattern.to_i64().expect("pattern i64");
            let values = vec![0.; sys.pattern.nonzeros()];
            Self {
                sys,
                pointers,
                indices,
                values,
                residuals: 0,
                jacobians: 0,
                jacobian_cpu_s: 0.,
                residual_cpu_s: 0.,
            }
        }
    }
    impl<P: Properties> System for Integrated<P> {
        fn dimension(&self) -> usize {
            self.sys.n()
        }
        fn nonzeros(&self) -> usize {
            self.sys.pattern.nonzeros()
        }
        fn root_count(&self) -> usize {
            Secondary::<P>::root_count(&self.sys.secondary)
        }
        fn residual(
            &mut self,
            t: f64,
            y: &[f64],
            yp: &[f64],
            out: &mut [f64],
        ) -> Result<(), Failure> {
            let started = super::cpu();
            let rows = self.sys.values(t, y, yp).map_err(ida_failure)?;
            out.copy_from_slice(&rows);
            self.residuals += 1;
            self.residual_cpu_s += super::cpu() - started;
            Ok(())
        }
        fn jacobian(
            &mut self,
            t: f64,
            cj: f64,
            y: &[f64],
            yp: &[f64],
            data: &mut [f64],
            rows: &mut [i64],
            pointers: &mut [i64],
        ) -> Result<(), Failure> {
            let started = super::cpu();
            self.sys
                .colored(t, cj, y, yp, &mut self.values)
                .map_err(ida_failure)?;
            data.copy_from_slice(&self.values);
            rows.copy_from_slice(&self.indices);
            pointers.copy_from_slice(&self.pointers);
            self.jacobians += 1;
            self.jacobian_cpu_s += super::cpu() - started;
            Ok(())
        }
        fn roots(&mut self, t: f64, y: &[f64], yp: &[f64], out: &mut [f64]) -> Result<(), Failure> {
            let ns = self.sys.secondary_len;
            let x = Coordinates::new(&y[..ns], &yp[..ns], None, 0., &self.sys.scales[..ns])
                .map_err(ida_failure)?;
            Secondary::<P>::roots(&mut self.sys.secondary, &self.sys.props, t, x, out)
                .map_err(ida_failure)
        }
    }

    pub struct Spec {
        pub t_end: f64,
        pub rtol: f64,
        pub atol: f64,
        pub output_s: f64,
        pub commands: Vec<(f64, Command)>,
        pub consistent_bound: f64,
    }

    /// One accepted sample in physical units.
    pub fn sample<P: Properties>(
        sys: &mut Standalone<P>,
        t: f64,
        y: &[f64],
        yp: &[f64],
        y0: &[f64],
    ) -> Result<Value, NetFailure> {
        sys.evaluate(t, y, yp, None, 0.)?;
        let n_sg = sys.secondary.steam_generators().len();
        let mut sgs = Vec::new();
        for k in 0..n_sg {
            let g = sys.secondary.steam_generators()[k].clone();
            let b = sys.secondary.boundaries()[k].clone();
            let v = |i: usize| y[i] * sys.scales[i];
            let lm = sys.secondary_len + sys.metal_len + k * sys.ledgers_per_sg;
            let metal: f64 = (0..sys.segments.len())
                .map(|i| v(sys.secondary_len + k * sys.segments.len() + i))
                .sum();
            let metal0: f64 = (0..sys.segments.len())
                .map(|i| {
                    y0[sys.secondary_len + k * sys.segments.len() + i]
                        * sys.scales[sys.secondary_len + k * sys.segments.len() + i]
                })
                .sum();
            let energy_defect =
                (v(g.base + 1) - y0[g.base + 1] * sys.scales[g.base + 1]) - v(lm + 1);
            let metal_defect = if sys.ledgers_per_sg == 3 {
                (metal - metal0) - v(lm + 2)
            } else {
                0.
            };
            sgs.push(json!({"id":g.id,"p_Pa":v(g.base + 2),"Vl_m3":v(g.base + 3),"M_kg":v(g.base),"U_J":v(g.base + 1),
                "Tsat_K":sys.observed.views[k].1,"lifts":(0..g.valves.len()).map(|j| v(g.base + 4 + j)).collect::<Vec<_>>(),
                "valves":(0..g.valves.len()).map(|j| sys.secondary.valve(k, j)).collect::<Vec<Valve>>(),
                "steam_kg_s":b.steam_kg_s.value,"relief_kg_s":b.relief_kg_s.iter().map(|m| m.value).collect::<Vec<_>>(),
                "feed_kg_s":b.feed_kg_s.value,"heat_W":b.heat_w.value,"primary_W":sys.observed.primary_w[k],
                "metal_K":sys.observed.metal_k[k],"massDefect_kg":(v(g.base) - y0[g.base] * sys.scales[g.base]) - v(lm),
                "energyLedgerDefect_J":energy_defect,"metalLedgerDefect_J":metal_defect}));
        }
        Ok(json!({"t_s":t,"sgs":sgs}))
    }

    pub struct Outcome {
        pub y: Vec<f64>,
        pub yp: Vec<f64>,
        pub samples: Vec<Value>,
        pub events: Vec<Value>,
        pub stopped: Option<String>,
        pub counts: Value,
        pub cpu_s: f64,
    }

    /// Integrate from (t0, y) with the declared commands, recording samples
    /// every `output_s` and every event. Ends at `t_end`, at a domain exit
    /// (reported in `stopped`) or at a solver failure (returned as error).
    pub fn run<P: Properties>(
        sys: Standalone<P>,
        t0: f64,
        y0: Vec<f64>,
        spec: &Spec,
    ) -> Result<Outcome, String> {
        let started = super::cpu();
        let n = sys.n();
        let ids = sys.ids.clone();
        let atol = vec![spec.atol; n];
        let reference = y0.clone();
        let mut y = y0;
        let weights = |y: &[f64]| {
            y.iter()
                .map(|v| 1. / (spec.rtol * v.abs() + spec.atol))
                .collect::<Vec<f64>>()
        };
        let mut sys = sys;
        let w = weights(&y);
        let (mut yp, pair) =
            network::consistent_start(&mut sys, t0, &mut y, &ids, &w, spec.consistent_bound, 4)
                .map_err(|e| format!("consistent start at {t0}: {e:?}"))?;
        let mut events = vec![json!({"t_s":t0,"event":"consistent start","pair":pair})];
        let lifts: Vec<usize> = sys
            .secondary
            .steam_generators()
            .iter()
            .flat_map(|g| (0..g.valves.len()).map(move |j| g.base + 4 + j))
            .collect();
        let mut ida = Ida::new(
            Integrated::new(sys),
            Initial {
                time: t0,
                y: &y,
                yp: &yp,
                differential: &ids,
                absolute_tolerance: &atol,
                relative_tolerance: spec.rtol,
            },
        )?;
        let configure = |ida: &mut Ida<Integrated<P>>| -> Result<(), String> {
            ida.set_max_order(2)?;
            ida.constrain_nonnegative(&lifts)
        };
        configure(&mut ida)?;
        let mut t = t0;
        let mut samples = vec![
            sample(&mut ida.system_mut().sys, t, &y, &yp, &reference)
                .map_err(|e| format!("{e:?}"))?,
        ];
        let mut next_output = t0 + spec.output_s;
        let mut commands = spec.commands.clone();
        commands.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut stopped = None;
        let (mut steps, mut error_failures, mut convergence_failures, mut restarts) =
            (0i64, 0i64, 0i64, 0usize);
        while t < spec.t_end {
            let s = &ida.system().sys;
            let mut times: Vec<f64> = commands.iter().map(|c| c.0).filter(|c| *c > t).collect();
            times.extend(s.schedule_times().into_iter().filter(|c| *c > t));
            times.extend(Secondary::<P>::next_time_event(&s.secondary, t));
            let stop = times.into_iter().fold(spec.t_end, f64::min);
            ida.stop_at(stop)?;
            let target = next_output.min(stop);
            let outcome = ida.advance(target, &mut y, &mut yp);
            let outcome = match outcome {
                Ok(o) => o,
                Err(e) => return Err(format!("IDA at t={t}: {e}")),
            };
            let mut restart = false;
            match outcome {
                Advance::Reached(tr) => {
                    t = tr;
                    if (t - next_output).abs() <= 1e-9 * t.abs().max(1.) {
                        samples.push(
                            sample(&mut ida.system_mut().sys, t, &y, &yp, &reference)
                                .map_err(|e| format!("{e:?}"))?,
                        );
                        next_output += spec.output_s;
                    }
                    if t == stop && t < spec.t_end {
                        let sys = &mut ida.system_mut().sys;
                        while let Some(c) = commands.first().copied().filter(|c| c.0 <= t) {
                            let tx = Secondary::<P>::command(&mut sys.secondary, t, c.1)
                                .map_err(|e| format!("{e:?}"))?;
                            events.push(json!({"t_s":t,"event":"command","receipt":tx.receipt}));
                            commands.remove(0);
                        }
                        events.push(json!({"t_s":t,"event":"time boundary"}));
                        restart = true;
                    }
                }
                Advance::Root { time, directions } => {
                    t = time;
                    let sys = &mut ida.system_mut().sys;
                    let ns = sys.secondary_len;
                    let mut phys: Vec<f64> = (0..ns).map(|i| y[i] * sys.scales[i]).collect();
                    match Secondary::<P>::transact(
                        &mut sys.secondary,
                        &sys.props,
                        t,
                        &directions,
                        &mut phys,
                    ) {
                        Ok(tx) => {
                            // A transaction may set own coordinates (a seat).
                            for (i, v) in phys.iter().enumerate() {
                                y[i] = v / sys.scales[i];
                            }
                            events.push(json!({"t_s":t,"event":"root","receipt":tx.receipt}))
                        }
                        Err(e) => {
                            stopped = Some(format!("{e:?}"));
                            samples.push(
                                sample(sys, t, &y, &yp, &reference)
                                    .map_err(|e| format!("{e:?}"))?,
                            );
                            break;
                        }
                    }
                    samples
                        .push(sample(sys, t, &y, &yp, &reference).map_err(|e| format!("{e:?}"))?);
                    restart = true;
                }
            }
            if restart {
                let stats = ida.stats()?;
                steps += stats.steps;
                error_failures += stats.error_failures;
                convergence_failures += stats.convergence_failures;
                restarts += 1;
                let w = weights(&y);
                let (next_yp, pair) = network::consistent_start(
                    &mut ida.system_mut().sys,
                    t,
                    &mut y,
                    &ids,
                    &w,
                    spec.consistent_bound,
                    4,
                )
                .map_err(|e| format!("consistent start at {t}: {e:?}"))?;
                yp = next_yp;
                events.push(json!({"t_s":t,"event":"exact consistent restart","pair":pair}));
                ida.reinitialize(t, &y, &yp)?;
                configure(&mut ida)?;
            }
        }
        let stats = ida.stats()?;
        steps += stats.steps;
        error_failures += stats.error_failures;
        convergence_failures += stats.convergence_failures;
        let cpu_s = super::cpu() - started;
        let integrated = ida.system();
        let _ = n;
        let counts = json!({"steps":steps,"errorTestFailures":error_failures,"convergenceFailures":convergence_failures,
            "restarts":restarts,"residuals":integrated.residuals,"jacobians":integrated.jacobians,
            "residualCpu_s":integrated.residual_cpu_s,"jacobianCpu_s":integrated.jacobian_cpu_s,"cpu_s":cpu_s});
        Ok(Outcome {
            y,
            yp,
            samples,
            events,
            stopped,
            counts,
            cpu_s,
        })
    }
}
