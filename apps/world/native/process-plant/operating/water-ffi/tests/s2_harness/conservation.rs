//! One run's conservation record (G8, P5, K2): the identities at every
//! accepted sample and the IDAS ledger closures at every output, with the
//! trapezoid of the sampled boundary reported beside the gated ledger. It
//! fills the run record's `identities` and `ledger` sections
//! ([`super::receipt::RUN_SCHEMA`]).
//!
//! The runner feeds it, in time order:
//! - [`Conservation::sample`] at every accepted sample (each output, each
//!   observation, and both sides of every restart), with the account of
//!   that state: the identities are judged and the boundary is trapezoided;
//! - [`Conservation::output`] at every output, with the inventories and the
//!   IDAS ledger read there (`joined_ledger::ledger_at`): the gated closure;
//! - [`Conservation::restarted`] at every discrete restart, after the
//!   ledger was carried (`joined_ledger::restart_ledger`).
//!
//! The bounds are the declaration's: `identityRelative` and
//! `ledger.boundLocalToleranceUnits`.
use super::gates::Block;
use leitbild_operating_plant::joined::account::{Account, Held, Plan};
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// The worst sample of one identity.
#[derive(Clone, Debug)]
struct WorstIdentity {
    relative: f64,
    at_t_s: f64,
    defect: f64,
    terms: Value,
    samples: usize,
}

/// The worst output of one ledger closure, gated and trapezoid.
#[derive(Clone, Debug, Default)]
struct WorstClosure {
    units: f64,
    at_t_s: f64,
    closure: f64,
    tolerance: f64,
    trapezoid_units: f64,
}

pub struct Conservation {
    bound_relative: f64,
    units_bound: f64,
    gate: String,
    plan: Plan,
    held0: Vec<Held>,
    q0: Vec<f64>,
    identities: BTreeMap<String, WorstIdentity>,
    closures: BTreeMap<String, WorstClosure>,
    /// The trapezoid of the sampled boundary since the run's start.
    trapezoid: Vec<f64>,
    last: Option<(f64, Vec<f64>)>,
    reinitialised_at: Vec<f64>,
    over_time: Vec<Value>,
    last_output: Option<Value>,
}

impl Conservation {
    /// At the run's start: the inventories `held0` and the ledger `q0` there.
    pub fn new(gates: &Block, plan: Plan, held0: Vec<Held>, q0: Vec<f64>) -> Self {
        let names = plan.ledger_names().len();
        assert_eq!(q0.len(), names, "the ledger has {names} quadratures");
        Self {
            bound_relative: gates.number("/identityRelative"),
            units_bound: gates.number("/ledger/boundLocalToleranceUnits"),
            gate: gates.text("/ledger/gate"),
            plan,
            held0,
            q0,
            identities: BTreeMap::new(),
            closures: BTreeMap::new(),
            trapezoid: vec![0.; names],
            last: None,
            reinitialised_at: Vec::new(),
            over_time: Vec::new(),
            last_output: None,
        }
    }

    /// An accepted sample at `t`: every identity judged, the boundary
    /// trapezoided from the previous sample.
    pub fn sample(&mut self, t: f64, account: &Account) {
        for i in account.identities() {
            let r = i.relative();
            let e = self
                .identities
                .entry(i.name.clone())
                .or_insert(WorstIdentity {
                    relative: -1.,
                    at_t_s: t,
                    defect: 0.,
                    terms: Value::Null,
                    samples: 0,
                });
            e.samples += 1;
            if r.is_nan() || r > e.relative {
                *e = WorstIdentity {
                    relative: r,
                    at_t_s: t,
                    defect: i.defect,
                    terms: i.json()["terms"].clone(),
                    samples: e.samples,
                };
            }
        }
        if let Some((t0, b0)) = &self.last {
            let dt = t - t0;
            assert!(
                dt >= 0.,
                "conservation samples out of time order: {t0} then {t}"
            );
            for ((q, a), b) in self.trapezoid.iter_mut().zip(&account.boundary).zip(b0) {
                *q += 0.5 * dt * (a + b);
            }
        }
        self.last = Some((t, account.boundary.clone()));
    }

    /// An output at `t`: each inventory's change against the IDAS ledger
    /// (gated) and against the trapezoid (reported).
    pub fn output(&mut self, t: f64, held: &[Held], q: &[f64]) {
        let gated = self.plan.closures(&self.held0, held, &self.q0, q);
        let zero = vec![0.; self.trapezoid.len()];
        let trapezoid = self
            .plan
            .closures(&self.held0, held, &zero, &self.trapezoid);
        let mut row = serde_json::Map::new();
        for (c, tr) in gated.iter().zip(&trapezoid) {
            let w = self.closures.entry(c.name.clone()).or_default();
            if c.units.is_nan() || c.units >= w.units {
                w.units = c.units;
                w.at_t_s = t;
                w.closure = c.closure;
                w.tolerance = c.tolerance;
            }
            w.trapezoid_units = w.trapezoid_units.max(tr.units);
            row.insert(
                c.name.clone(),
                json!({"units": c.units, "closure": c.closure, "trapezoid_units": tr.units}),
            );
        }
        let entry = json!({"t_s": t, "closures": row});
        self.last_output = Some(json!({"t_s": t, "closures": gated, "trapezoid": trapezoid}));
        self.over_time.push(entry);
    }

    /// A discrete restart at `t` carried the ledger into the next segment.
    pub fn restarted(&mut self, t: f64) {
        self.reinitialised_at.push(t);
    }

    /// Every identity closed at every sample.
    pub fn identities_pass(&self) -> bool {
        !self.identities.is_empty()
            && self
                .identities
                .values()
                .all(|w| w.relative <= self.bound_relative)
    }
    /// Every ledger closed at every output.
    pub fn ledger_pass(&self) -> bool {
        !self.closures.is_empty() && self.closures.values().all(|w| w.units <= self.units_bound)
    }

    fn identity_json(&self, name: &str) -> Value {
        match self.identities.get(name) {
            Some(w) => json!({"max_relative": w.relative, "at_t_s": w.at_t_s, "defect": w.defect,
                "pass": w.relative <= self.bound_relative, "samples": w.samples, "terms_at_worst": w.terms}),
            None => Value::Null,
        }
    }
    /// The run record's `identities` section.
    pub fn identities_json(&self) -> Value {
        let ids = self.plan.generators();
        let per_sg = |what: &str| -> Value {
            ids.iter()
                .map(|id| self.identity_json(&format!("SG.{id}.{what}")))
                .collect::<Vec<_>>()
                .into()
        };
        json!({"bound_relative": self.bound_relative, "pass": self.identities_pass(),
            "unit_energy": self.identity_json("unit_energy"),
            "primary_mass": self.identity_json("primary_mass"),
            "primary_boron": self.identity_json("primary_boron"),
            "sg_mass": per_sg("mass"), "sg_energy": per_sg("energy"),
            "kinetics_source_balance": self.identity_json("kinetics_source_balance"),
            "handovers": {"metal_heat": per_sg("metal_heat_handover"), "nuclear_event_split": self.identity_json("nuclear_event_split")}})
    }
    /// The run record's `ledger` section.
    pub fn ledger_json(&self) -> Value {
        let closures: serde_json::Map<String, Value> = self
            .closures
            .iter()
            .map(|(k, w)| {
                (
                    k.clone(),
                    json!({"max_units": w.units, "at_t_s": w.at_t_s, "closure_at_max": w.closure,
                    "tolerance_at_max": w.tolerance, "pass": w.units <= self.units_bound}),
                )
            })
            .collect();
        let trapezoid: serde_json::Map<String, Value> = self
            .closures
            .iter()
            .map(|(k, w)| (k.clone(), json!({"max_units": w.trapezoid_units})))
            .collect();
        json!({"gate": self.gate, "bound_local_tolerance_units": self.units_bound, "pass": self.ledger_pass(),
            "names": self.plan.ledger_names(), "closures": closures, "reinitialised_at_s": self.reinitialised_at,
            "trapezoid": {"reported_only": true, "method": "trapezoid of the account's boundary over every accepted sample (outputs, observations, both sides of each restart)", "closures": trapezoid},
            "final": self.last_output, "over_time": self.over_time})
    }
}
