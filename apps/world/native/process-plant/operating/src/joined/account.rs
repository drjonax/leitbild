//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#joined-spine-at-power
//! spec: world/packs/process-plant/reference-designs/ld-01/model/build-readiness.md#s2-declaration-joined-hot-spine-at-power
//! The unit's conservation account of one joined evaluation: the S2
//! identities, the boundary terms the IDAS ledgers integrate, and the
//! inventories those ledgers are judged against. Read-only: nothing here
//! changes a coordinate, a row or an owner's mode.
//!
//! Every stored quantity's rate is read from its own row as the residual
//! states it: a differential row is `y' - rhs/scale`, so `rhs = (y' -
//! row) scale` (the network's convention, which every block follows). The
//! identities therefore close on the residual's own receipts at any state,
//! accepted or not, and test that every internal transfer leaves one owner
//! exactly as it enters another; the ledgers test the integrator.
//!
//! - **Unit energy.** The network's fluid receipts (cells and the stratified
//!   PZR cell) and rotor rate, the solids' fuel, clad, helium, passive and SG
//!   metal energies, the nuclear history reservoirs, the SG secondaries'
//!   internal energies and the rod bodies' kinetic and potential energy
//!   change by the fission and capture event energy, the motor work and the
//!   SG boundary enthalpy flows (feed in, steam and relief out), less the
//!   bearing loss.
//! - **Primary mass and boron.** The network's receipts summed over every
//!   cell: internal faces and the guide passages cancel, leaving the
//!   primary's boundary (none until the PZR relief composes).
//! - **Each SG's mass and energy.** Its rows' receipts against its feed,
//!   steam and relief and the metal heat its rows used.
//! - **Handovers.** The metal heat the secondary received against the heat
//!   the solids delivered, and the nuclear event energy against the heat
//!   released plus the reservoirs' rate.
//!
//! Each identity closes when `|defect| <= bound (1 + sum |terms|)`, the
//! terms being every store's rate and every boundary term (S1's bound form).
use super::{
    block::{Class, Coordinates, OwnerAccount},
    operator::Joined,
};
use crate::{
    network::{Failure, Properties, Tolerances},
    thermal::{Scalar, WaterProperties},
};
use serde::Serialize;
use serde_json::{Value, json};

fn fatal(reason: impl Into<String>) -> Failure {
    Failure::Fatal(format!("joined account: {}", reason.into()))
}

/// One conservation identity at one evaluation: `defect = stores - boundary`.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Identity {
    pub name: String,
    /// Stores' rates less the boundary terms (W, kg/s or kg_eq/s).
    pub defect: f64,
    /// Sum of the absolute value of every store rate and boundary term.
    pub terms_abs: f64,
    /// Named subtotals, stores positive and boundary terms negative, so they
    /// sum to the defect: the attribution of a miss.
    pub terms: Vec<(String, f64)>,
}

impl Identity {
    fn new(name: &str) -> Self {
        Self {
            name: name.into(),
            ..Self::default()
        }
    }
    /// A store's rate (`abs` the sum of its parts' absolute values).
    fn store(&mut self, name: &str, rate: f64, abs: f64) {
        self.defect += rate;
        self.terms_abs += abs;
        self.terms.push((name.into(), rate));
    }
    /// A boundary term, entering positive.
    fn boundary(&mut self, name: &str, rate: f64) {
        self.defect -= rate;
        self.terms_abs += rate.abs();
        self.terms.push((name.into(), -rate));
    }
    /// `|defect| / (1 + sum |terms|)`.
    pub fn relative(&self) -> f64 {
        self.defect.abs() / (1. + self.terms_abs)
    }
    /// Closes within `bound (1 + sum |terms|)`; a NaN never closes.
    pub fn closes(&self, bound: f64) -> bool {
        self.defect.abs() <= bound * (1. + self.terms_abs)
    }
    pub fn json(&self) -> Value {
        json!({"defect": self.defect, "terms_abs": self.terms_abs, "relative": self.relative(),
            "terms": self.terms.iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>()})
    }
}

/// The account of one evaluation.
#[derive(Clone, Debug, Default)]
pub struct Account {
    pub unit_energy: Identity,
    pub primary_mass: Identity,
    pub primary_boron: Identity,
    /// Per SG.
    pub sg_mass: Vec<Identity>,
    pub sg_energy: Vec<Identity>,
    /// The metal heat per SG as the secondary received it against the
    /// solids' delivery, and the nuclear event energy split.
    pub handovers: Vec<Identity>,
    /// The boundary rates the ledgers integrate, in [`Plan::ledger_names`]
    /// order, entering positive.
    pub boundary: Vec<f64>,
}

impl Account {
    /// Every identity, the unit's first.
    pub fn identities(&self) -> impl Iterator<Item = &Identity> {
        [&self.unit_energy, &self.primary_mass, &self.primary_boron]
            .into_iter()
            .chain(&self.sg_mass)
            .chain(&self.sg_energy)
            .chain(&self.handovers)
    }
    /// The identity with the largest relative defect.
    pub fn worst(&self) -> &Identity {
        self.identities()
            .max_by(|a, b| a.relative().total_cmp(&b.relative()))
            .expect("the unit identity")
    }
    /// Every identity closes within `bound`.
    pub fn closes(&self, bound: f64) -> bool {
        self.identities().all(|i| i.closes(bound))
    }
    pub fn json(&self) -> Value {
        let named: serde_json::Map<String, Value> = self
            .identities()
            .map(|i| (i.name.clone(), i.json()))
            .collect();
        Value::Object(named)
    }
}

/// One inventory quantity and its local tolerance unit, the sum over the
/// coordinates it is made of of `rtol |y| + atol` in physical units.
#[derive(Clone, Debug, Serialize)]
pub struct Held {
    pub name: String,
    pub value: f64,
    pub tolerance: f64,
}

/// One ledger closure: an inventory's change against the integrated
/// boundary, in its local tolerance units.
#[derive(Clone, Debug, Serialize)]
pub struct Closure {
    pub name: String,
    pub inventory_change: f64,
    pub ledger: f64,
    pub closure: f64,
    pub tolerance: f64,
    /// `|closure| / tolerance`.
    pub units: f64,
}

/// The account's layout, compiled once from the composed operator.
#[derive(Clone, Debug)]
pub struct Plan {
    dimension: usize,
    network: usize,
    rods: std::ops::Range<usize>,
    scales: Vec<f64>,
    row_scales: Vec<f64>,
    /// Network coordinates by kind (labels' categories).
    net_mass: Vec<usize>,
    net_energy: Vec<usize>,
    net_boron: Vec<usize>,
    rotors: Vec<usize>,
    /// Differential solid energies and history reservoirs (global).
    solid_energy: Vec<usize>,
    histories: Vec<usize>,
    /// Per SG, its mass and internal energy coordinates (global).
    sg_mass: Vec<usize>,
    sg_energy: Vec<usize>,
    sg_names: Vec<String>,
}

impl Plan {
    pub fn new<P: Properties + WaterProperties>(joined: &Joined<P>) -> Result<Self, Failure> {
        if !joined.integrable() {
            return Err(fatal("a prepared port has no owner account"));
        }
        let o = joined.offsets();
        let mut plan = Self {
            dimension: o.end,
            network: o.nuclear,
            rods: o.rods..o.end,
            scales: Vec::with_capacity(o.end),
            row_scales: Vec::with_capacity(o.end),
            net_mass: Vec::new(),
            net_energy: Vec::new(),
            net_boron: Vec::new(),
            rotors: joined.network.rotor_index.clone(),
            solid_energy: Vec::new(),
            histories: Vec::new(),
            sg_mass: Vec::new(),
            sg_energy: Vec::new(),
            sg_names: Vec::new(),
        };
        for (i, (category, _)) in joined.network.labels().iter().enumerate() {
            match *category {
                "M" => plan.net_mass.push(i),
                "U" => plan.net_energy.push(i),
                "B" => plan.net_boron.push(i),
                _ => {}
            }
        }
        let mut k = 0;
        for (owner, layout) in joined.layouts() {
            for i in 0..layout.len() {
                let global = k + i;
                match (owner, layout.classes[i]) {
                    (
                        "solids",
                        Class::FuelEnergy
                        | Class::CladEnergy
                        | Class::HeliumEnergy
                        | Class::PassiveEnergy
                        | Class::MetalEnergy,
                    ) => plan.solid_energy.push(global),
                    ("nuclear", Class::FissionHistory | Class::CaptureHistory) => {
                        plan.histories.push(global)
                    }
                    ("secondary", Class::SecondaryStock) => {
                        let label = &layout.labels[i];
                        if let Some(id) = label
                            .strip_prefix("SG.")
                            .and_then(|l| l.strip_suffix(".M_s"))
                        {
                            plan.sg_mass.push(global);
                            plan.sg_names.push(id.to_string());
                        } else if label.ends_with(".U_s") {
                            plan.sg_energy.push(global);
                        } else {
                            return Err(fatal(format!(
                                "secondary stock {label} is neither M_s nor U_s"
                            )));
                        }
                    }
                    _ => {}
                }
            }
            plan.scales.extend(&layout.scales);
            plan.row_scales.extend(&layout.row_scales);
            k += layout.len();
        }
        let generators = joined
            .secondary()
            .map(|s| s.generators())
            .ok_or_else(|| fatal("no secondary owner"))?;
        if plan.sg_mass.len() != generators || plan.sg_energy.len() != generators {
            return Err(fatal(format!(
                "{} SG mass and {} SG energy stocks for {generators} SGs",
                plan.sg_mass.len(),
                plan.sg_energy.len()
            )));
        }
        // A store's rate is read from its row only where the row is the
        // rate defect of the coordinate itself.
        let differential = joined.differential(&vec![1.; o.nuclear]);
        for &i in plan
            .solid_energy
            .iter()
            .chain(&plan.histories)
            .chain(&plan.sg_mass)
            .chain(&plan.sg_energy)
        {
            if differential[i] != 1. || plan.scales[i] != plan.row_scales[i] {
                return Err(fatal(format!(
                    "store {i} is not a differential coordinate on its own scale"
                )));
            }
        }
        if plan.scales.len() != o.end {
            return Err(fatal("layout length"));
        }
        Ok(plan)
    }

    /// Each SG's mass and internal-energy coordinates (global), in the
    /// secondary's order.
    pub fn sg_stocks(&self) -> (&[usize], &[usize]) {
        (&self.sg_mass, &self.sg_energy)
    }
    /// The SG ids, in the secondary's order.
    pub fn generators(&self) -> &[String] {
        &self.sg_names
    }

    /// The ledger integrands' names, in [`Account::boundary`] order: the
    /// primary's net mass and boron receipts, each SG's feed, steam and
    /// relief mass then energy, and the unit's event energy, motor work and
    /// bearing loss (entering positive).
    pub fn ledger_names(&self) -> Vec<String> {
        let mut names = vec![
            "primary_mass_kg".to_string(),
            "primary_boron_kg_eq".to_string(),
        ];
        for id in &self.sg_names {
            for port in ["feed", "steam", "relief"] {
                names.push(format!("SG.{id}.{port}_kg"));
            }
        }
        for id in &self.sg_names {
            for port in ["feed", "steam", "relief"] {
                names.push(format!("SG.{id}.{port}_j"));
            }
        }
        names.extend(["event_j", "motor_work_j", "bearing_loss_j"].map(String::from));
        names
    }

    /// The store rate `(y' - row) scale` of a differential coordinate.
    fn rate(&self, rows: &[Scalar], yp: &[f64], i: usize) -> f64 {
        (yp[i] - rows[i].value) * self.scales[i]
    }
    fn rates(&self, rows: &[Scalar], yp: &[f64], indices: &[usize]) -> (f64, f64) {
        indices.iter().fold((0., 0.), |(sum, abs), &i| {
            let r = self.rate(rows, yp, i);
            (sum + r, abs + r.abs())
        })
    }

    /// The owners' accounts at `(y, y')` and `rows`.
    fn owners<P: Properties + WaterProperties>(
        &self,
        joined: &Joined<P>,
        y: &[f64],
        yp: &[f64],
        rows: &[Scalar],
    ) -> Result<(OwnerAccount, OwnerAccount), Failure> {
        let secondary = joined
            .secondary()
            .ok_or_else(|| fatal("no secondary owner"))?
            .account();
        let r = self.rods.clone();
        let x = Coordinates::new(
            &y[r.clone()],
            &yp[r.clone()],
            None,
            0.,
            &self.scales[r.clone()],
        )?;
        let physical: Vec<Scalar> = rows[r.clone()]
            .iter()
            .zip(&self.row_scales[r])
            .map(|(row, s)| Scalar::constant(row.value * s))
            .collect();
        let rods = joined
            .rods()
            .ok_or_else(|| fatal("no rod owner"))?
            .account(x, &physical)?;
        Ok((secondary, rods))
    }

    /// The account of the operator's last evaluation, which must be at
    /// `(y, y')` (the caller evaluates; the account reads its rows, heats
    /// and the owners' last boundary).
    pub fn read<P: Properties + WaterProperties>(
        &self,
        joined: &Joined<P>,
        y: &[f64],
        yp: &[f64],
    ) -> Result<Account, Failure> {
        self.read_rows(joined, y, yp, joined.rows())
    }

    /// As [`Plan::read`], with the joined rows given: the operator's own,
    /// or a mutated copy that tests the identities' discrimination (the
    /// network's part is always read from the network's own rows).
    pub fn read_rows<P: Properties + WaterProperties>(
        &self,
        joined: &Joined<P>,
        y: &[f64],
        yp: &[f64],
        rows: &[Scalar],
    ) -> Result<Account, Failure> {
        if y.len() != self.dimension || yp.len() != self.dimension || rows.len() != self.dimension {
            return Err(fatal("state length"));
        }
        let n = self.network;
        let budget = joined.network.current_budget(&y[..n], &yp[..n]);
        let b = |k: &str| {
            budget[k]
                .as_f64()
                .ok_or_else(|| fatal(format!("network budget has no {k}")))
        };
        let heats = joined.heats();
        let (secondary, rods) = self.owners(joined, y, yp, rows)?;
        let mut account = Account::default();

        // Unit energy.
        let mut e = Identity::new("unit_energy");
        e.store(
            "network fluid receipts",
            b("fluid_energy_receipt_sum_w")?,
            b("fluid_energy_receipt_abs_sum_w")?,
        );
        let rotor = b("rotor_energy_rate_w")?;
        e.store("network rotors", rotor, rotor.abs());
        let (solids, solids_abs) = self.rates(rows, yp, &self.solid_energy);
        e.store("solid energies", solids, solids_abs);
        let (histories, histories_abs) = self.rates(rows, yp, &self.histories);
        e.store("history reservoirs", histories, histories_abs);
        let (sg_u, sg_u_abs) = self.rates(rows, yp, &self.sg_energy);
        e.store("SG secondary energies", sg_u, sg_u_abs);
        e.store(
            "rod bodies kinetic and potential",
            rods.mechanical_rate_w,
            rods.mechanical_rate_w.abs(),
        );
        e.boundary(
            "fission and capture event energy",
            heats.nuclear.event_w.value,
        );
        e.boundary("motor work", b("motor_work_w")?);
        e.boundary("bearing loss", -b("bearing_loss_w")?);
        for c in secondary.crossings.iter().chain(&rods.crossings) {
            e.boundary(&c.port, c.energy_w);
        }
        account.unit_energy = e;

        // Primary mass and boron: the network's receipts over every cell.
        let mut m = Identity::new("primary_mass");
        m.store(
            "network mass receipts",
            b("mass_receipt_sum_kg_s")?,
            b("mass_receipt_abs_sum_kg_s")?,
        );
        account.primary_mass = m;
        let mut bo = Identity::new("primary_boron");
        bo.store(
            "network boron receipts",
            b("boron_receipt_sum_kg_eq_s")?,
            b("boron_receipt_abs_sum_kg_eq_s")?,
        );
        account.primary_boron = bo;

        // Each SG, and the metal heat handed to it.
        if secondary.received_heat_w.len() != self.sg_names.len()
            || heats.solids.secondary_w.len() != self.sg_names.len()
        {
            return Err(fatal("SG heat layout"));
        }
        for (k, id) in self.sg_names.iter().enumerate() {
            let ports = || secondary.crossings.iter().filter(move |c| c.volume == k);
            let mut sm = Identity::new(&format!("SG.{id}.mass"));
            let r = self.rate(rows, yp, self.sg_mass[k]);
            sm.store("M_s receipts", r, r.abs());
            for c in ports() {
                sm.boundary(&c.port, c.mass_kg_s);
            }
            account.sg_mass.push(sm);
            let mut se = Identity::new(&format!("SG.{id}.energy"));
            let r = self.rate(rows, yp, self.sg_energy[k]);
            se.store("U_s receipts", r, r.abs());
            se.boundary("metal heat received", secondary.received_heat_w[k]);
            for c in ports() {
                se.boundary(&c.port, c.energy_w);
            }
            account.sg_energy.push(se);
            let mut h = Identity::new(&format!("SG.{id}.metal_heat_handover"));
            h.store(
                "received by the secondary",
                secondary.received_heat_w[k],
                secondary.received_heat_w[k].abs(),
            );
            h.boundary(
                "delivered by the SG metal",
                heats.solids.secondary_w[k].value,
            );
            account.handovers.push(h);
        }
        let mut nh = Identity::new("nuclear_event_split");
        let event = heats.nuclear.event_w.value;
        nh.store("event energy", event, event.abs());
        nh.boundary(
            "released to fuel and coolant",
            heats.nuclear.released_w.value,
        );
        nh.boundary(
            "history reservoirs' rate",
            heats.nuclear.stored_rate_w.value,
        );
        account.handovers.push(nh);

        // The ledgers' integrands, in `ledger_names` order.
        let mut q = vec![b("mass_receipt_sum_kg_s")?, b("boron_receipt_sum_kg_eq_s")?];
        let port = |id: &str, name: &str| {
            secondary
                .crossings
                .iter()
                .find(|c| c.port == format!("SG.{id}.{name}"))
                .ok_or_else(|| fatal(format!("no crossing SG.{id}.{name}")))
        };
        for id in &self.sg_names {
            for name in ["feed", "steam", "relief"] {
                q.push(port(id, name)?.mass_kg_s);
            }
        }
        for id in &self.sg_names {
            for name in ["feed", "steam", "relief"] {
                q.push(port(id, name)?.energy_w);
            }
        }
        q.extend([event, b("motor_work_w")?, -b("bearing_loss_w")?]);
        account.boundary = q;
        Ok(account)
    }

    /// The inventories the ledgers close on at `y`, each with its local
    /// tolerance unit at `(rtol, atol)` (the solver's per-coordinate
    /// `rtol |y| + atol`, in physical units, summed over its coordinates):
    /// the unit's energy, the primary's mass and boron, and each SG's mass.
    /// The rod bodies' energy is read through their owner at `y` (its rate
    /// part, from the last rows, is not used here).
    pub fn inventory<P: Properties + WaterProperties>(
        &self,
        joined: &Joined<P>,
        y: &[f64],
        atol: &[f64],
        rtol: f64,
    ) -> Result<Vec<Held>, Failure> {
        if y.len() != self.dimension || atol.len() != self.dimension {
            return Err(fatal("inventory length"));
        }
        let n = self.network;
        let (totals, _) = joined.network.inventory(
            &y[..n],
            Tolerances {
                relative: rtol,
                absolute: &atol[..n],
            },
        )?;
        let unit = |i: usize| rtol * (y[i] * self.scales[i]).abs() + atol[i] * self.scales[i];
        let tol = |indices: &[usize]| indices.iter().map(|&i| unit(i)).sum::<f64>();
        let sum = |indices: &[usize]| indices.iter().map(|&i| y[i] * self.scales[i]).sum::<f64>();
        let inertia = joined.network.rotor_inertia();
        // KE = L^2 / 2I: its tolerance is omega times L's.
        let rotor_tol: f64 = self
            .rotors
            .iter()
            .map(|&i| (y[i] * self.scales[i] / inertia).abs() * unit(i))
            .sum();
        let rows = joined.rows();
        let (_, rods) = self.owners(joined, y, &vec![0.; y.len()], rows)?;
        // The bodies' energy moves with travel by m g dy and with speed by
        // m v dv (+ m dv^2/2): each part read through the owner at the state
        // moved by one tolerance unit, travel alone and then speed alone
        // (with the speed's sign), so the two parts never cancel.
        let rods_tol = {
            let r = self.rods.clone();
            let moved = |velocity: bool| -> Result<f64, Failure> {
                let mut bumped = y.to_vec();
                for (j, i) in r.clone().enumerate() {
                    if (j % 3 == 1) == velocity && j % 3 != 2 {
                        let step = atol[i] + rtol * y[i].abs();
                        bumped[i] += if y[i] < 0. { -step } else { step };
                    }
                }
                let (_, high) = self.owners(joined, &bumped, &vec![0.; y.len()], rows)?;
                Ok((high.mechanical_j - rods.mechanical_j).abs())
            };
            moved(false)? + moved(true)?
        };
        let mut out = vec![Held {
            name: "unit_energy_j".into(),
            value: totals[2]
                + totals[3]
                + sum(&self.solid_energy)
                + sum(&self.histories)
                + sum(&self.sg_energy)
                + rods.mechanical_j,
            tolerance: tol(&self.net_energy)
                + rotor_tol
                + tol(&self.solid_energy)
                + tol(&self.histories)
                + tol(&self.sg_energy)
                + rods_tol,
        }];
        out.push(Held {
            name: "primary_mass_kg".into(),
            value: totals[0],
            tolerance: tol(&self.net_mass),
        });
        out.push(Held {
            name: "primary_boron_kg_eq".into(),
            value: totals[1],
            tolerance: tol(&self.net_boron),
        });
        for (k, id) in self.sg_names.iter().enumerate() {
            out.push(Held {
                name: format!("SG.{id}.mass_kg"),
                value: y[self.sg_mass[k]] * self.scales[self.sg_mass[k]],
                tolerance: unit(self.sg_mass[k]),
            });
        }
        Ok(out)
    }

    /// Each inventory's change from `held0` to `held` against the ledger's
    /// change from `q0` to `q` (both in [`Plan::ledger_names`] order): the
    /// unit's energy against every energy term, the primary's mass and
    /// boron against their net receipts, each SG's mass against its feed,
    /// steam and relief.
    pub fn closures(&self, held0: &[Held], held: &[Held], q0: &[f64], q: &[f64]) -> Vec<Closure> {
        let names = self.ledger_names();
        let d = |pick: &dyn Fn(&str) -> bool| -> f64 {
            names
                .iter()
                .zip(q.iter().zip(q0))
                .filter(|(n, _)| pick(n))
                .map(|(_, (a, b))| a - b)
                .sum()
        };
        held.iter()
            .zip(held0)
            .map(|(h, h0)| {
                let ledger = match h.name.as_str() {
                    "unit_energy_j" => d(&|n| n.ends_with("_j")),
                    "primary_mass_kg" => d(&|n| n == "primary_mass_kg"),
                    "primary_boron_kg_eq" => d(&|n| n == "primary_boron_kg_eq"),
                    other => {
                        let id = other
                            .strip_prefix("SG.")
                            .and_then(|s| s.strip_suffix(".mass_kg"))
                            .expect("an SG mass inventory");
                        d(&|n| n.starts_with(&format!("SG.{id}.")) && n.ends_with("_kg"))
                    }
                };
                let change = h.value - h0.value;
                let closure = change - ledger;
                Closure {
                    name: h.name.clone(),
                    inventory_change: change,
                    ledger,
                    closure,
                    tolerance: h.tolerance,
                    units: closure.abs() / h.tolerance,
                }
            })
            .collect()
    }
}

impl<P: Properties + WaterProperties> Joined<P> {
    /// Evaluate at `(t, y, y')` and read the unit's account there.
    pub fn account(
        &mut self,
        plan: &Plan,
        t: f64,
        y: &[f64],
        yp: &[f64],
    ) -> Result<Account, Failure> {
        self.evaluate(t, y, yp, None, 0., None)?;
        plan.read(self, y, yp)
    }
}
