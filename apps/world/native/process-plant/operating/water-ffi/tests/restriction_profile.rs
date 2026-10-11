//! spec: world/packs/process-plant/reference-designs/ld-01/model/build-readiness.md#cost-premise-risk-not-a-decision
//! The equilibrium-nozzle restriction (`stratified::restriction_flux` and
//! `restriction_partials`, used by the PZR relief device and the S2 SG
//! reliefs) on its caloric saturation tuples and thermodynamics-only
//! inverses, against the same law on complete tuples: an identity sweep over
//! SG and PZR relief donors, bit for bit, and a cost and query profile. The
//! complete reference is a delegating wrapper that keeps every default of
//! the property boundary, with its partials restated as three independent
//! passes: exactly the restriction's earlier computation. A measurement and
//! identity check, not a production path.
use leitbild_operating_plant::{
    network::{
        BandReport, MetastableBand, Properties, Water,
        stratified::{self, Flux, HeldFlux},
    },
    thermal::{Saturation, Scalar},
};
use leitbild_operating_water::{CaloricLinearization, If97};
use serde_json::{Value, json};
use std::{cell::RefCell, hint::black_box, time::Instant};

/// The maintained adapter with the boundary's complete defaults only:
/// `caloric_for` inverts completely and `saturation_caloric` is the
/// complete tuple.
struct Complete;
impl Properties for Complete {
    type Caloric = CaloricLinearization;
    fn forward(&self, vapor: bool, p: f64, t: f64) -> Result<Water, String> {
        If97.forward(vapor, p, t)
    }
    fn caloric(
        &self,
        vapor: bool,
        p: f64,
        target: f64,
        enthalpy: bool,
    ) -> Result<CaloricLinearization, String> {
        If97.caloric(vapor, p, target, enthalpy)
    }
    fn values(&self, point: &CaloricLinearization) -> Water {
        If97.values(point)
    }
    fn direction(&self, point: &CaloricLinearization, dp: f64, de: f64) -> Result<Water, String> {
        If97.direction(point, dp, de)
    }
    fn saturation(&self, pressure: Scalar) -> Result<Saturation, String> {
        Properties::saturation(&If97, pressure)
    }
    fn metastable_band(&self) -> Result<MetastableBand, String> {
        If97.metastable_band()
    }
    fn band(&self, point: &CaloricLinearization) -> BandReport {
        If97.band(point)
    }
}

/// Counts and times every query of a delegated implementation by kind.
struct Counted<'a, P: Properties> {
    inner: &'a P,
    /// [inverse, direction, completion, saturation value, saturation
    /// direction] as (calls, wall seconds).
    tally: RefCell<[(usize, f64); 5]>,
}
impl<P: Properties> Counted<'_, P> {
    fn time<T>(&self, kind: usize, f: impl FnOnce() -> T) -> T {
        let started = Instant::now();
        let result = f();
        let mut t = self.tally.borrow_mut();
        t[kind].0 += 1;
        t[kind].1 += started.elapsed().as_secs_f64();
        result
    }
    fn json(&self) -> Value {
        let t = self.tally.borrow();
        let names = [
            "inverse",
            "direction",
            "completion",
            "saturation_value",
            "saturation_direction",
        ];
        Value::Object(
            names
                .iter()
                .zip(t.iter())
                .filter(|(_, (n, _))| *n > 0)
                .map(|(name, (n, s))| {
                    (
                        name.to_string(),
                        json!({"calls": n, "mean_us": 1e6 * s / *n as f64}),
                    )
                })
                .collect(),
        )
    }
}
impl<P: Properties> Properties for Counted<'_, P> {
    type Caloric = P::Caloric;
    fn forward(&self, vapor: bool, p: f64, t: f64) -> Result<Water, String> {
        self.inner.forward(vapor, p, t)
    }
    fn caloric(
        &self,
        vapor: bool,
        p: f64,
        target: f64,
        enthalpy: bool,
    ) -> Result<P::Caloric, String> {
        self.time(0, || self.inner.caloric(vapor, p, target, enthalpy))
    }
    fn caloric_for(
        &self,
        vapor: bool,
        p: f64,
        target: f64,
        enthalpy: bool,
        need: leitbild_operating_plant::network::properties::Need,
    ) -> Result<P::Caloric, String> {
        self.time(0, || {
            self.inner.caloric_for(vapor, p, target, enthalpy, need)
        })
    }
    fn complete(&self, point: &P::Caloric) -> Result<P::Caloric, String> {
        self.time(2, || self.inner.complete(point))
    }
    fn values(&self, point: &P::Caloric) -> Water {
        self.inner.values(point)
    }
    fn direction(&self, point: &P::Caloric, dp: f64, de: f64) -> Result<Water, String> {
        self.time(1, || self.inner.direction(point, dp, de))
    }
    fn saturation(&self, pressure: Scalar) -> Result<Saturation, String> {
        let kind = if pressure.direction == 0. { 3 } else { 4 };
        self.time(kind, || self.inner.saturation(pressure))
    }
    fn saturation_caloric(&self, pressure: Scalar) -> Result<Saturation, String> {
        let kind = if pressure.direction == 0. { 3 } else { 4 };
        self.time(kind, || self.inner.saturation_caloric(pressure))
    }
    fn metastable_band(&self) -> Result<MetastableBand, String> {
        self.inner.metastable_band()
    }
    fn band(&self, point: &P::Caloric) -> BandReport {
        self.inner.band(point)
    }
}

fn flux_bits(f: &Result<Flux, String>) -> Vec<u64> {
    match f {
        Ok(f) => vec![
            0,
            f.mass_flux.value.to_bits(),
            f.mass_flux.direction.to_bits(),
            f.throat_pressure_pa.value.to_bits(),
            f.throat_pressure_pa.direction.to_bits(),
            u64::from(f.choked),
            f.saturation_calls as u64,
            f.inversions as u64,
        ],
        Err(_) => vec![1],
    }
}
fn held_bits(f: &Result<HeldFlux, String>) -> Vec<u64> {
    match f {
        Ok(h) => {
            let mut v = vec![
                0,
                h.mass_flux.to_bits(),
                h.throat_pressure_pa.to_bits(),
                u64::from(h.choked),
                h.saturation_calls as u64,
                h.inversions as u64,
            ];
            v.extend(h.mass_flux_partials.iter().map(|x| x.to_bits()));
            v.extend(h.throat_partials.iter().map(|x| x.to_bits()));
            v
        }
        Err(_) => vec![1],
    }
}
fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}

/// `restriction_partials`' earlier computation, restated: three independent
/// unit-seed passes of `restriction_flux` on the given properties, with no
/// shared property boundary.
fn unshared_partials<P: Properties>(
    properties: &P,
    vapor: bool,
    p0: f64,
    h0: f64,
    p_back: f64,
) -> Result<HeldFlux, String> {
    let mut held: Option<HeldFlux> = None;
    for k in 0..3 {
        let unit = |j: usize, v: f64| Scalar::new(v, if j == k { 1. } else { 0. });
        let f = stratified::restriction_flux(
            properties,
            vapor,
            unit(0, p0),
            unit(1, h0),
            unit(2, p_back),
        )
        .map_err(|e| format!("{e:?}"))?;
        let h = held.get_or_insert(HeldFlux {
            mass_flux: f.mass_flux.value,
            mass_flux_partials: [0.; 3],
            throat_pressure_pa: f.throat_pressure_pa.value,
            throat_partials: [0.; 3],
            choked: f.choked,
            saturation_calls: 0,
            inversions: 0,
        });
        if h.mass_flux.to_bits() != f.mass_flux.value.to_bits() || h.choked != f.choked {
            return Err("restriction value depends on its direction".into());
        }
        h.mass_flux_partials[k] = f.mass_flux.direction;
        h.throat_partials[k] = f.throat_pressure_pa.direction;
        h.saturation_calls += f.saturation_calls;
        h.inversions += f.inversions;
    }
    held.ok_or_else(|| "no pass".into())
}

/// Relief donors: SG reliefs (saturated and slightly superheated vapor at
/// 6-8 MPa) and the PZR relief (vapor at 14-16 MPa, and subcooled or
/// saturated liquid at 14-16 MPa), each against an atmospheric, a
/// relief-tank and a near-inlet back pressure. Donors stay at or below the
/// 16 MPa vapor ceiling, where both saturation endpoints exist.
fn donors() -> Vec<(bool, f64, f64, f64)> {
    let mut cases = Vec::new();
    let sat = |p: f64| Properties::saturation(&If97, s(p)).unwrap();
    for i in 0..=8 {
        let p0 = 6e6 + 0.25e6 * f64::from(i);
        let hg = sat(p0).vapor.enthalpy.value;
        for dh in [0., 1e3, 2e4] {
            for back in [101325., 0.5e6, 0.9 * p0, 0.995 * p0] {
                cases.push((true, p0, hg + dh, back));
            }
        }
    }
    for i in 0..=8 {
        let p0 = 14e6 + 0.25e6 * f64::from(i);
        let t = sat(p0);
        for dh in [0., 1e3, 2e4] {
            for back in [101325., 0.3e6, 0.9 * p0] {
                cases.push((true, p0, t.vapor.enthalpy.value + dh, back));
            }
        }
    }
    for i in 0..=8 {
        let p0 = 14e6 + 0.25e6 * f64::from(i);
        let hf = sat(p0).liquid.enthalpy.value;
        for dh in [0., -1e3, -5e4] {
            for back in [101325., 0.3e6, 0.95 * p0] {
                cases.push((false, p0, hf + dh, back));
            }
        }
    }
    cases
}

#[test]
fn caloric_restriction_is_the_complete_restriction_bit_for_bit() {
    let seeds = [
        (0., 0., 0.),
        (1., 0., 0.),
        (0., 1., 0.),
        (0., 0., 1.),
        (1e3, -2e2, 5e2),
    ];
    let (mut values, mut partials, mut refused) = (0, 0, 0);
    for (vapor, p0, h0, back) in donors() {
        for (dp, dh, db) in seeds {
            let x = |v: f64, d: f64| Scalar::new(v, d);
            let new = stratified::restriction_flux(&If97, vapor, x(p0, dp), x(h0, dh), x(back, db))
                .map_err(|e| format!("{e:?}"));
            let old =
                stratified::restriction_flux(&Complete, vapor, x(p0, dp), x(h0, dh), x(back, db))
                    .map_err(|e| format!("{e:?}"));
            assert_eq!(
                flux_bits(&new),
                flux_bits(&old),
                "vapor={vapor} p0={p0:e} h0={h0:e} back={back:e} seed=({dp},{dh},{db})"
            );
            values += 1;
            refused += usize::from(new.is_err());
        }
        let new = stratified::restriction_partials(&If97, vapor, p0, h0, back)
            .map_err(|e| format!("{e:?}"));
        let old = unshared_partials(&Complete, vapor, p0, h0, back);
        assert_eq!(
            held_bits(&new),
            held_bits(&old),
            "partials p0={p0:e} h0={h0:e}"
        );
        // The shared boundary over complete tuples is the unshared one too.
        let shared = stratified::restriction_partials(&Complete, vapor, p0, h0, back)
            .map_err(|e| format!("{e:?}"));
        assert_eq!(held_bits(&shared), held_bits(&old), "complete p0={p0:e}");
        partials += 1;
    }
    println!(
        "{}",
        json!({"kind": "caloric-restriction-identity", "flux_evaluations": values,
            "partials": partials, "refused_alike": refused})
    );
    assert!(values > 1000);
}

fn best_us(mut f: impl FnMut(), repeats: usize) -> f64 {
    let mut best = f64::INFINITY;
    for _ in 0..7 {
        let started = Instant::now();
        for _ in 0..repeats {
            f();
        }
        best = best.min(started.elapsed().as_secs_f64() / repeats as f64);
    }
    1e6 * best
}

#[test]
#[ignore = "cost report only; run explicitly with --ignored --nocapture"]
fn restriction_cost_profile() {
    let sat = |p: f64| Properties::saturation(&If97, s(p)).unwrap();
    // The SG relief rating point (7 MPa saturated vapor to the atmosphere)
    // and a PZR relief at 15.5 MPa saturated vapor to a 0.3 MPa tank.
    let cases = [
        (
            "sg_relief_7MPa_saturated_vapor",
            true,
            7e6,
            sat(7e6).vapor.enthalpy.value,
            101325.,
        ),
        (
            "pzr_relief_15.5MPa_saturated_vapor",
            true,
            15.5e6,
            sat(15.5e6).vapor.enthalpy.value,
            0.3e6,
        ),
        (
            "pzr_relief_15.5MPa_saturated_liquid",
            false,
            15.5e6,
            sat(15.5e6).liquid.enthalpy.value,
            0.3e6,
        ),
    ];
    let mut report = Vec::new();
    for (name, vapor, p0, h0, back) in cases {
        let mut row = serde_json::Map::new();
        row.insert("case".into(), json!(name));
        for (label, complete) in [("complete_tuples", true), ("caloric_tuples", false)] {
            let (flux_us, partials_us, queries_value, queries_partials) = if complete {
                let flux_us = best_us(
                    || {
                        black_box(
                            stratified::restriction_flux(&Complete, vapor, s(p0), s(h0), s(back))
                                .unwrap(),
                        );
                    },
                    20,
                );
                let partials_us = best_us(
                    || {
                        black_box(unshared_partials(&Complete, vapor, p0, h0, back).unwrap());
                    },
                    5,
                );
                let c = Counted {
                    inner: &Complete,
                    tally: RefCell::default(),
                };
                stratified::restriction_flux(&c, vapor, s(p0), s(h0), s(back)).unwrap();
                let qv = c.json();
                let c = Counted {
                    inner: &Complete,
                    tally: RefCell::default(),
                };
                unshared_partials(&c, vapor, p0, h0, back).unwrap();
                (flux_us, partials_us, qv, c.json())
            } else {
                let flux_us = best_us(
                    || {
                        black_box(
                            stratified::restriction_flux(&If97, vapor, s(p0), s(h0), s(back))
                                .unwrap(),
                        );
                    },
                    20,
                );
                let partials_us = best_us(
                    || {
                        black_box(
                            stratified::restriction_partials(&If97, vapor, p0, h0, back).unwrap(),
                        );
                    },
                    5,
                );
                let c = Counted {
                    inner: &If97,
                    tally: RefCell::default(),
                };
                stratified::restriction_flux(&c, vapor, s(p0), s(h0), s(back)).unwrap();
                let qv = c.json();
                let c = Counted {
                    inner: &If97,
                    tally: RefCell::default(),
                };
                stratified::restriction_partials(&c, vapor, p0, h0, back).unwrap();
                (flux_us, partials_us, qv, c.json())
            };
            row.insert(
                label.into(),
                json!({"flux_value_us": flux_us, "partials_us": partials_us,
                    "queries_value": queries_value, "queries_partials": queries_partials}),
            );
        }
        report.push(Value::Object(row));
    }
    println!(
        "{}",
        json!({"kind": "restriction-cost-NOT-EVIDENCE", "clock": "wall, best of 7", "cases": report})
    );
}
