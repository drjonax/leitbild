//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-phase-properties.md#one-maintained-water-implementation
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#actual-local-pressure-pilot-and-step-work-blocker
//! Maintained-IF97 implementation of the composed network's property
//! boundary, and the narrow adapter that hands the network to stock IDA.
use crate::{Branch, CaloricLinearization, If97, MetastableBand as Compiled, WaterPoint, point};
use leitbild_operating_plant::{
    network::{
        Band, BandReport, MetastableBand, Properties, Water,
        properties::{Need, Partials, ThermodynamicDirection, ThermodynamicPartials},
    },
    thermal::{Saturation, Scalar, WaterProperties},
};

fn branch(vapor: bool) -> Branch {
    if vapor { Branch::Vapor } else { Branch::Liquid }
}
fn water(q: WaterPoint) -> Water {
    Water {
        pressure_pa: q.pressure_pa,
        temperature_k: q.temperature_k,
        density_kg_m3: q.density_kg_m3,
        internal_energy_j_kg: q.internal_energy_j_kg,
        enthalpy_j_kg: q.enthalpy_j_kg,
        cp_j_kg_k: q.cp_j_kg_k,
        expansion_per_k: q.expansion_per_k,
        compressibility_per_pa: q.compressibility_per_pa,
        viscosity_pa_s: q.viscosity_pa_s,
        conductivity_w_m_k: q.conductivity_w_m_k,
    }
}

impl Properties for If97 {
    type Caloric = CaloricLinearization;
    fn forward(&self, vapor: bool, pressure_pa: f64, temperature_k: f64) -> Result<Water, String> {
        point(branch(vapor), pressure_pa, temperature_k)
            .map(water)
            .map_err(|e| e.to_string())
    }
    fn caloric(
        &self,
        vapor: bool,
        pressure_pa: f64,
        target: f64,
        enthalpy: bool,
    ) -> Result<CaloricLinearization, String> {
        if enthalpy {
            CaloricLinearization::enthalpy(branch(vapor), pressure_pa, target)
        } else {
            CaloricLinearization::internal_energy(branch(vapor), pressure_pa, target)
        }
        .map_err(|e| e.to_string())
    }
    /// The thermodynamics-only inverse leaves cv, conductivity and the
    /// saturation slope unevaluated (NaN); its other fields are bit for bit
    /// the complete inverse's.
    fn caloric_for(
        &self,
        vapor: bool,
        pressure_pa: f64,
        target: f64,
        enthalpy: bool,
        need: Need,
    ) -> Result<CaloricLinearization, String> {
        match need {
            Need::Complete => self.caloric(vapor, pressure_pa, target, enthalpy),
            Need::Thermodynamic => {
                CaloricLinearization::thermodynamic(branch(vapor), pressure_pa, target, enthalpy)
                    .map_err(|e| e.to_string())
            }
        }
    }
    fn complete(&self, point: &CaloricLinearization) -> Result<CaloricLinearization, String> {
        point.completed().map_err(|e| e.to_string())
    }
    fn values(&self, point: &CaloricLinearization) -> Water {
        water(point.point())
    }
    /// The two direction maps from the point completed once.
    fn partials(&self, point: &CaloricLinearization) -> Result<Partials, String> {
        let held = point.completed().map_err(|e| e.to_string())?;
        Ok(Partials {
            pressure: self.direction(&held, 1., 0.)?,
            target: self.direction(&held, 0., 1.)?,
        })
    }
    /// Probe-free: the exact part of each direction map only.
    fn thermodynamic_partials(
        &self,
        point: &CaloricLinearization,
    ) -> Result<ThermodynamicPartials, String> {
        let exact = |dp: f64, dt: f64| {
            point
                .exact_directional(dp, dt)
                .map(|[t, rho, u, h]| ThermodynamicDirection {
                    temperature_k: t,
                    density_kg_m3: rho,
                    internal_energy_j_kg: u,
                    enthalpy_j_kg: h,
                })
                .map_err(|e| e.to_string())
        };
        Ok(ThermodynamicPartials {
            pressure: exact(1., 0.)?,
            target: exact(0., 1.)?,
        })
    }
    fn direction(
        &self,
        point: &CaloricLinearization,
        dp: f64,
        dtarget: f64,
    ) -> Result<Water, String> {
        point
            .directional(dp, dtarget)
            .map(water)
            .map_err(|e| e.to_string())
    }
    fn saturation(&self, pressure: Scalar) -> Result<Saturation, String> {
        WaterProperties::saturation(self, pressure).map_err(|e| e.to_string())
    }
    /// Both endpoints' caloric states and exact directions only: no
    /// transport, surface tension or coefficient probe.
    fn saturation_caloric(&self, pressure: Scalar) -> Result<Saturation, String> {
        let [(l, dl), (g, dg)] = crate::saturation_caloric(pressure.value, pressure.direction)
            .map_err(|e| format!("maintained IF97 caloric saturation: {e}"))?;
        let none = Scalar::new(f64::NAN, f64::NAN);
        let endpoint =
            |q: WaterPoint, d: WaterPoint| leitbild_operating_plant::thermal::WaterPoint {
                density: Scalar::new(q.density_kg_m3, d.density_kg_m3),
                viscosity: none,
                conductivity: none,
                cp: none,
                expansion: none,
                enthalpy: Scalar::new(q.enthalpy_j_kg, d.enthalpy_j_kg),
            };
        Ok(Saturation {
            temperature: Scalar::new(l.temperature_k, dl.temperature_k),
            liquid: endpoint(l, dl),
            vapor: endpoint(g, dg),
            surface_tension: none,
        })
    }
    fn metastable_band(&self) -> Result<MetastableBand, String> {
        let b = Compiled::compiled();
        let lower_bound_exclusive = match b.lower_bound_exclusive {
            0 => false,
            1 => true,
            other => return Err(format!("compiled band lower-bound flag {other}")),
        };
        Ok(MetastableBand {
            pressure_range_pa: [b.pressure_low_pa, b.pressure_high_pa],
            lower_bound_exclusive,
            liquid_superheat_max_k: b.liquid_superheat_max_k,
            vapor_subcooling_max_k: b.vapor_subcooling_max_k,
            trial_max_k: b.trial_max_k,
            credited_max_k: b.credited_max_k,
            liquid_temperature_max_k: b.liquid_temperature_max_k,
            liquid_pressure_ceiling_pa: b.liquid_pressure_ceiling_pa,
            vapor_pressure_ceiling_pa: b.vapor_pressure_ceiling_pa,
        })
    }
    fn band(&self, point: &CaloricLinearization) -> BandReport {
        let report = point.band();
        BandReport {
            departure_k: report.departure_k,
            band: match report.band {
                crate::Band::Stable => Band::Stable,
                crate::Band::Admitted { credited } => Band::Admitted { credited },
                crate::Band::Exceeded => Band::Exceeded,
            },
        }
    }
}

#[cfg(feature = "ida")]
pub use integrated::{Assembly, Integrated, ResidualMemo};

#[cfg(feature = "ida")]
mod integrated {
    use crate::ida::{Failure, System};
    use leitbild_operating_plant::network::{
        self, BlockJacobian, CscOut, DensePattern, Network, Properties, Reuse, SparseJacobian,
        properties::Need,
    };

    /// Nothing outside the integrated network reads its cells' phase points,
    /// so every regular cell is inverted for the network rows' own need.
    fn own_rows_only<P: Properties>(network: &mut Network<P>) {
        for cell in 0..network.cell_layout.len() {
            network.set_cell_need(cell, Need::Thermodynamic);
        }
    }

    fn failure(f: network::Failure) -> Failure {
        match f {
            network::Failure::Recoverable(reason) => Failure::Recoverable(reason),
            network::Failure::Fatal(reason) => Failure::Fatal(reason),
        }
    }

    /// Stage-Jacobian assembly selected for one integration.
    pub enum Assembly {
        /// Complete n*n structure; only for equivalence checks.
        Dense,
        /// Compiled structural pattern with one evaluation per color.
        Colored {
            structure: SparseJacobian,
            rows: Vec<i64>,
            pointers: Vec<i64>,
        },
        /// The same pattern, each column evaluated on the elements that
        /// read it (`Network::jacobian_blocks`).
        Blocks {
            structure: BlockJacobian,
            rows: Vec<i64>,
            pointers: Vec<i64>,
        },
    }

    /// The property points of the last residual, held with the exact bits
    /// of the `(t, y, y')` it was evaluated at: a single-entry memo for the
    /// Jacobian assembly IDA requests at that same state. Pure memoization:
    /// every held point is also keyed by its exact inputs, a miss recomputes,
    /// and it is never state (never copied, restored or serialized).
    pub struct ResidualMemo<C> {
        key: Option<(u64, Vec<u64>, Vec<u64>)>,
        reuse: Reuse<C>,
    }
    impl<C: Copy> ResidualMemo<C> {
        fn matches(&self, time: f64, y: &[f64], yp: &[f64]) -> bool {
            let bits = |v: &[f64], held: &[u64]| {
                v.len() == held.len() && v.iter().zip(held).all(|(a, b)| a.to_bits() == *b)
            };
            matches!(&self.key, Some((t, hy, hyp)) if *t == time.to_bits() && bits(y, hy) && bits(yp, hyp))
        }
    }

    /// The network as one stock-IDA system; no solver logic lives here.
    pub struct Integrated<P: Properties> {
        pub network: Network<P>,
        assembly: Assembly,
        memo: ResidualMemo<P::Caloric>,
    }
    impl<P: Properties> Integrated<P> {
        pub fn dense(mut network: Network<P>) -> Self {
            own_rows_only(&mut network);
            let reuse = network.reuse();
            Self {
                network,
                assembly: Assembly::Dense,
                memo: ResidualMemo { key: None, reuse },
            }
        }
        pub fn colored(mut network: Network<P>) -> Result<Self, String> {
            own_rows_only(&mut network);
            let structure = network.sparse_jacobian().map_err(|e| format!("{e:?}"))?;
            let (pointers, rows) = structure.pattern.to_i64()?;
            let reuse = network.reuse();
            Ok(Self {
                network,
                assembly: Assembly::Colored {
                    structure,
                    rows,
                    pointers,
                },
                memo: ResidualMemo { key: None, reuse },
            })
        }
        pub fn blocks(mut network: Network<P>) -> Result<Self, String> {
            own_rows_only(&mut network);
            let structure = network.block_jacobian().map_err(|e| format!("{e:?}"))?;
            let (pointers, rows) = structure.pattern.to_i64()?;
            let reuse = network.reuse();
            Ok(Self {
                network,
                assembly: Assembly::Blocks {
                    structure,
                    rows,
                    pointers,
                },
                memo: ResidualMemo { key: None, reuse },
            })
        }
        pub fn assembly(&self) -> &Assembly {
            &self.assembly
        }
        /// The last residual's held points if it was evaluated at exactly
        /// `(time, y, yp)`, moved out for one Jacobian assembly (which then
        /// inverts nothing its base evaluation repeats); `None` on any
        /// difference, after which the assembly recomputes.
        pub fn take_memo(&mut self, time: f64, y: &[f64], yp: &[f64]) -> Option<Reuse<P::Caloric>> {
            if !self.memo.matches(time, y, yp) {
                return None;
            }
            self.memo.key = None;
            let fresh = self.network.reuse();
            Some(std::mem::replace(&mut self.memo.reuse, fresh))
        }
    }
    impl<P: Properties> System for Integrated<P> {
        fn dimension(&self) -> usize {
            self.network.dimension()
        }
        fn nonzeros(&self) -> usize {
            match &self.assembly {
                Assembly::Dense => DensePattern::nonzeros(self.network.dimension()),
                Assembly::Colored { structure, .. } => structure.pattern.nonzeros(),
                Assembly::Blocks { structure, .. } => structure.pattern.nonzeros(),
            }
        }
        /// S1 declares no physical event roots yet.
        fn root_count(&self) -> usize {
            0
        }
        /// Evaluating zero root functions fills nothing; any requested root
        /// value contradicts the declared count and is refused.
        fn roots(&mut self, _: f64, _: &[f64], _: &[f64], out: &mut [f64]) -> Result<(), Failure> {
            if out.is_empty() {
                Ok(())
            } else {
                Err(Failure::Fatal(format!(
                    "the network declares no root functions, not {}",
                    out.len()
                )))
            }
        }
        fn residual(
            &mut self,
            time: f64,
            y: &[f64],
            yp: &[f64],
            out: &mut [f64],
        ) -> Result<(), Failure> {
            // The residual records its points for the memo: with zero seeds
            // a held point gives exactly the values of an unheld one.
            self.memo.key = None;
            self.memo.reuse.clear();
            self.network
                .evaluate(time, y, yp, None, 0., Some(&mut self.memo.reuse))
                .map_err(failure)?;
            self.memo.key = Some((
                time.to_bits(),
                y.iter().map(|v| v.to_bits()).collect(),
                yp.iter().map(|v| v.to_bits()).collect(),
            ));
            for (r, v) in out.iter_mut().zip(self.network.rows()) {
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
            match &self.assembly {
                Assembly::Dense => self
                    .network
                    .jacobian_dense(
                        time,
                        cj,
                        y,
                        yp,
                        CscOut {
                            data,
                            rows,
                            pointers,
                        },
                    )
                    .map_err(failure),
                Assembly::Colored {
                    structure,
                    rows: compiled_rows,
                    pointers: compiled_pointers,
                } => {
                    rows.copy_from_slice(compiled_rows);
                    pointers.copy_from_slice(compiled_pointers);
                    self.network
                        .jacobian_colored(time, cj, y, yp, structure, data)
                        .map_err(failure)
                }
                Assembly::Blocks {
                    structure,
                    rows: compiled_rows,
                    pointers: compiled_pointers,
                } => {
                    rows.copy_from_slice(compiled_rows);
                    pointers.copy_from_slice(compiled_pointers);
                    self.network
                        .jacobian_blocks(time, cj, y, yp, structure, data)
                        .map_err(failure)
                }
            }
        }
    }
}
