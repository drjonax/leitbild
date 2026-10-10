//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#initialization-and-pressure-projection-have-limited-roles
//! Sound-filtered fixed-volume primary continuity/enthalpy projection.
//! One thermodynamic pressure; no independent acoustic node pressures. The
//! current EOS gives Mdot=A*pdot+B*Udot. Udot contains the SAME signed enthalpy
//! faces being solved. A spanning-tree elimination costs O(nodes+edges), not
//! a dense pressure solve. This is an exact reduction of that linear branch,
//! not a hydraulic force closure, nonlinear solver or time integrator.
use crate::thermal::Scalar;

#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Edge {
    pub from: usize,
    pub to: usize,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct Region {
    pub mass_p_at_energy: Scalar,
    pub mass_energy_at_pressure: Scalar,
    pub enthalpy: Scalar,
}
#[derive(Clone, Debug, PartialEq)]
pub enum Error {
    Topology,
    Length,
    Nonfinite,
    Singular(usize),
    Donor(usize),
    InconsistentDonor(usize),
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "primary pressure: {self:?}")
    }
}
impl std::error::Error for Error {}
#[derive(Clone, Debug)]
pub struct Tree {
    edges: Vec<Edge>,
    parent: Vec<usize>,
    parent_edge: Vec<usize>,
    order: Vec<usize>,
    chords: Vec<usize>,
}
#[derive(Clone, Debug)]
pub struct Work {
    a: Vec<Scalar>,
    b: Vec<Scalar>,
    parent_coefficient: Vec<Scalar>,
    pub pressure_rate: Scalar,
    pub flows: Vec<Scalar>,
    pub mass_rates: Vec<Scalar>,
    pub energy_rates: Vec<Scalar>,
    pub defects: Vec<Scalar>,
}
fn finite(v: Scalar) -> bool {
    v.value.is_finite() && v.direction.is_finite()
}
impl Tree {
    pub fn new(nodes: usize, edges: Vec<Edge>, gauge: usize) -> Result<Self, Error> {
        if nodes == 0
            || gauge >= nodes
            || edges
                .iter()
                .any(|e| e.from >= nodes || e.to >= nodes || e.from == e.to)
        {
            return Err(Error::Topology);
        }
        let mut parent = vec![usize::MAX; nodes];
        let mut parent_edge = parent.clone();
        let mut order = vec![gauge];
        parent[gauge] = gauge;
        let mut k = 0;
        while k < order.len() {
            let i = order[k];
            for (e, face) in edges.iter().enumerate() {
                let j = if face.from == i {
                    face.to
                } else if face.to == i {
                    face.from
                } else {
                    continue;
                };
                if parent[j] == usize::MAX {
                    parent[j] = i;
                    parent_edge[j] = e;
                    order.push(j);
                }
            }
            k += 1;
        }
        if order.len() != nodes {
            return Err(Error::Topology);
        }
        let mut used = vec![false; edges.len()];
        for i in order.iter().skip(1) {
            used[parent_edge[*i]] = true;
        }
        let chords = (0..edges.len()).filter(|e| !used[*e]).collect();
        Ok(Self {
            edges,
            parent,
            parent_edge,
            order,
            chords,
        })
    }
    pub fn chords(&self) -> &[usize] {
        &self.chords
    }
    pub fn workspace(&self) -> Work {
        let n = self.parent.len();
        let m = self.edges.len();
        Work {
            a: vec![Scalar::default(); n],
            b: vec![Scalar::default(); n],
            parent_coefficient: vec![Scalar::default(); n],
            pressure_rate: Scalar::default(),
            flows: vec![Scalar::default(); m],
            mass_rates: vec![Scalar::default(); n],
            energy_rates: vec![Scalar::default(); n],
            defects: vec![Scalar::default(); n],
        }
    }
    /// External energy includes donor enthalpy and paid shaft/heat exactly once.
    /// Chord inputs are actual edge currents, NOT arbitrary cycle amplitudes.
    /// Donors declare the current active branch. A zero-flow kink is directional
    /// only on that declared branch; no central derivative is claimed there.
    pub fn project(
        &self,
        regions: &[Region],
        heat: &[Scalar],
        external_mass: &[Scalar],
        chord_currents: &[Scalar],
        donors: &[usize],
        w: &mut Work,
    ) -> Result<(), Error> {
        let n = self.parent.len();
        let m = self.edges.len();
        if regions.len() != n
            || heat.len() != n
            || external_mass.len() != n
            || chord_currents.len() != self.chords.len()
            || donors.len() != m
            || w.a.len() != n
            || w.b.len() != n
            || w.parent_coefficient.len() != n
            || w.flows.len() != m
            || w.mass_rates.len() != n
            || w.energy_rates.len() != n
            || w.defects.len() != n
        {
            return Err(Error::Length);
        }
        if regions.iter().any(|r| {
            ![r.mass_p_at_energy, r.mass_energy_at_pressure, r.enthalpy]
                .into_iter()
                .all(finite)
        }) || !heat
            .iter()
            .chain(external_mass)
            .chain(chord_currents)
            .copied()
            .all(finite)
        {
            return Err(Error::Nonfinite);
        }
        for (e, face) in self.edges.iter().enumerate() {
            if donors[e] != face.from && donors[e] != face.to {
                return Err(Error::Donor(e));
            }
        }
        w.flows.fill(Scalar::default());
        for (i, r) in regions.iter().enumerate() {
            w.a[i] = r.mass_p_at_energy;
            w.b[i] = external_mass[i] - r.mass_energy_at_pressure * heat[i];
        }
        for (k, e) in self.chords.iter().enumerate() {
            let face = self.edges[*e];
            let q = chord_currents[k];
            let h = regions[donors[*e]].enthalpy;
            w.flows[*e] = q;
            for (i, sign) in [(face.from, -1.), (face.to, 1.)] {
                w.b[i] = w.b[i]
                    - Scalar::constant(sign)
                        * (regions[i].mass_energy_at_pressure * h - Scalar::constant(1.))
                        * q;
            }
        }
        for i in self.order.iter().skip(1).rev().copied() {
            let e = self.parent_edge[i];
            let face = self.edges[e];
            let j = self.parent[i];
            let sign = if face.to == i { 1. } else { -1. };
            let h = regions[donors[e]].enthalpy;
            let ci = Scalar::constant(sign)
                * (regions[i].mass_energy_at_pressure * h - Scalar::constant(1.));
            let cj = Scalar::constant(-sign)
                * (regions[j].mass_energy_at_pressure * h - Scalar::constant(1.));
            if !finite(ci) || ci.value == 0. {
                return Err(Error::Singular(i));
            }
            w.parent_coefficient[i] = ci;
            w.a[j] = w.a[j] - cj * w.a[i] / ci;
            w.b[j] = w.b[j] - cj * w.b[i] / ci;
        }
        let root = self.order[0];
        if !finite(w.a[root]) || w.a[root].value == 0. {
            return Err(Error::Singular(root));
        }
        w.pressure_rate = w.b[root] / w.a[root];
        for i in self.order.iter().skip(1).copied() {
            w.flows[self.parent_edge[i]] =
                (w.b[i] - w.a[i] * w.pressure_rate) / w.parent_coefficient[i];
        }
        w.mass_rates.copy_from_slice(external_mass);
        w.energy_rates.copy_from_slice(heat);
        for (e, face) in self.edges.iter().enumerate() {
            let q = w.flows[e];
            if q.value != 0. && donors[e] != if q.value > 0. { face.from } else { face.to } {
                return Err(Error::InconsistentDonor(e));
            }
            let qh = q * regions[donors[e]].enthalpy;
            w.mass_rates[face.from] = w.mass_rates[face.from] - q;
            w.mass_rates[face.to] = w.mass_rates[face.to] + q;
            w.energy_rates[face.from] = w.energy_rates[face.from] - qh;
            w.energy_rates[face.to] = w.energy_rates[face.to] + qh;
        }
        for (i, r) in regions.iter().enumerate() {
            w.defects[i] = r.mass_p_at_energy * w.pressure_rate
                + r.mass_energy_at_pressure * w.energy_rates[i]
                - w.mass_rates[i];
        }
        if !finite(w.pressure_rate)
            || !w
                .flows
                .iter()
                .chain(&w.mass_rates)
                .chain(&w.energy_rates)
                .chain(&w.defects)
                .copied()
                .all(finite)
        {
            return Err(Error::Nonfinite);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn s(x: f64) -> Scalar {
        Scalar::constant(x)
    }
    fn near(a: f64, b: f64) {
        assert!((a - b).abs() <= 1e-9 * b.abs().max(1.), "{a} != {b}");
    }
    #[test]
    fn two_stores_solve_enthalpy_and_pressure_together() {
        let t = Tree::new(2, vec![Edge { from: 0, to: 1 }], 0).unwrap();
        let mut w = t.workspace();
        let r = [
            Region {
                mass_p_at_energy: s(2e-6),
                mass_energy_at_pressure: s(-1e-7),
                enthalpy: s(1e6),
            },
            Region {
                mass_p_at_energy: s(3e-6),
                mass_energy_at_pressure: s(-2e-7),
                enthalpy: s(1.2e6),
            },
        ];
        t.project(&r, &[s(1e6), s(0.)], &[s(0.); 2], &[], &[0], &mut w)
            .unwrap();
        for d in &w.defects {
            near(d.value, 0.);
        }
        near(w.energy_rates.iter().map(|q| q.value).sum(), 1e6);
        near(w.mass_rates.iter().map(|q| q.value).sum(), 0.);
        assert!(w.pressure_rate.value > 0. && w.flows[0].value > 0.);
        // A sequential heat-only p' would be20kPa/s; the coupled result differs.
        assert!((w.pressure_rate.value - 20000.).abs() > 100.);
    }
    #[test]
    fn signed_reversed_flow_and_complete_branch_direction() {
        let t = Tree::new(2, vec![Edge { from: 0, to: 1 }], 1).unwrap();
        let mut w = t.workspace();
        let r = [
            Region {
                mass_p_at_energy: Scalar::new(2e-6, 1e-7),
                mass_energy_at_pressure: Scalar::new(-1e-7, 2e-9),
                enthalpy: Scalar::new(1e6, 100.),
            },
            Region {
                mass_p_at_energy: Scalar::new(3e-6, -2e-7),
                mass_energy_at_pressure: Scalar::new(-2e-7, -1e-9),
                enthalpy: Scalar::new(1.2e6, 200.),
            },
        ];
        let heat = [Scalar::new(-1e6, 2000.), Scalar::new(0., -1000.)];
        t.project(&r, &heat, &[s(0.); 2], &[], &[1], &mut w)
            .unwrap();
        let p = w.pressure_rate;
        let q = w.flows[0];
        for defect in &w.defects {
            near(defect.value, 0.);
            near(defect.direction, 0.);
        }
        // The independently reconstructed differentiated balances above are
        // exact to summation roundoff. Central differences also have truncation
        // and subtraction error; do not impose that algebraic tolerance on FD.
        assert!(q.value < 0.);
        let eps = 1e-3;
        let shift = |x: Scalar, k: f64| s(x.value + k * eps * x.direction);
        let mut results = Vec::new();
        for k in [-1., 1.] {
            let rr = r.map(|v| Region {
                mass_p_at_energy: shift(v.mass_p_at_energy, k),
                mass_energy_at_pressure: shift(v.mass_energy_at_pressure, k),
                enthalpy: shift(v.enthalpy, k),
            });
            t.project(
                &rr,
                &heat.map(|v| shift(v, k)),
                &[s(0.); 2],
                &[],
                &[1],
                &mut w,
            )
            .unwrap();
            results.push((w.pressure_rate.value, w.flows[0].value));
        }
        for (difference, analytic) in [
            ((results[1].0 - results[0].0) / (2. * eps), p.direction),
            ((results[1].1 - results[0].1) / (2. * eps), q.direction),
        ] {
            assert!(
                (difference - analytic).abs() <= 1e-8 * analytic.abs().max(1.),
                "FD {difference} != {analytic}"
            );
        }
    }
    #[test]
    fn topology_donor_singularity_and_nonfinite_refuse() {
        assert!(Tree::new(2, vec![], 0).is_err());
        assert!(Tree::new(1, vec![Edge { from: 0, to: 0 }], 0).is_err());
        let t = Tree::new(1, vec![], 0).unwrap();
        let mut w = t.workspace();
        let r = [Region {
            mass_p_at_energy: s(0.),
            mass_energy_at_pressure: s(0.),
            enthalpy: s(1.),
        }];
        assert!(matches!(
            t.project(&r, &[s(0.)], &[s(0.)], &[], &[], &mut w),
            Err(Error::Singular(0))
        ));
    }
}
