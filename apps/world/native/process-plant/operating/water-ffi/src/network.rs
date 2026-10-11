//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-phase-properties.md#one-maintained-water-implementation
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#actual-local-pressure-pilot-and-step-work-blocker
//! Maintained-IF97 implementation of the composed network's property
//! boundary, and the narrow adapter that hands the network to stock IDA.
use crate::{Branch, CaloricLinearization, If97, MetastableBand as Compiled, WaterPoint, point};
use leitbild_operating_plant::{
    network::{Band, BandReport, MetastableBand, Properties, Water},
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
    fn values(&self, point: &CaloricLinearization) -> Water {
        water(point.point())
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
pub use integrated::{Assembly, Integrated};

#[cfg(feature = "ida")]
mod integrated {
    use crate::ida::{Failure, System};
    use leitbild_operating_plant::network::{
        self, CscOut, DensePattern, Network, Properties, SparseJacobian,
    };

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
    }

    /// The network as one stock-IDA system; no solver logic lives here.
    pub struct Integrated<P: Properties> {
        pub network: Network<P>,
        assembly: Assembly,
    }
    impl<P: Properties> Integrated<P> {
        pub fn dense(network: Network<P>) -> Self {
            Self {
                network,
                assembly: Assembly::Dense,
            }
        }
        pub fn colored(network: Network<P>) -> Result<Self, String> {
            let structure = network.sparse_jacobian().map_err(|e| format!("{e:?}"))?;
            let (pointers, rows) = structure.pattern.to_i64()?;
            Ok(Self {
                network,
                assembly: Assembly::Colored {
                    structure,
                    rows,
                    pointers,
                },
            })
        }
        pub fn assembly(&self) -> &Assembly {
            &self.assembly
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
            self.network
                .evaluate(time, y, yp, None, 0., None)
                .map_err(failure)?;
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
            }
        }
    }
}
