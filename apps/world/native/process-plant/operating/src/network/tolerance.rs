//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#prospective-accuracy-contract
//! spec: world/packs/process-plant/reference-designs/engineering/development/decisions/0013-coarse-local-pressure.md#numerical-treatment-of-uncredited-lumped-modes
//! Per-class solver error weights for the composed network.
//!
//! IDA takes one scalar relative tolerance and a vector of absolute ones.
//! Classes are therefore expressed per coordinate. The algebraic pressure of
//! a rigid volume is a local function of its retained mass and energy, so its
//! weight follows from the same relative tolerance through the isentropic
//! compressibility: holding pressure tighter than the inventories that fix it
//! only measures Newton slack. The stratified PZR cell's roof pressure is
//! weighted the same way through the cell's effective isentropic
//! compressibility; its volumes are scaled like the volume rows and its
//! stocks take the stock classes. No value of a particular plant lives here.
use super::{
    Failure, Network, PZR_ENERGY, PZR_MASS, PZR_TRACER, PZR_VOLUME, Properties, not_integrated,
};

/// Declared absolute tolerances; all fields are required, none defaulted.
#[derive(Clone, Copy, Debug)]
pub struct ToleranceClasses {
    pub relative: f64,
    /// Scaled (dimensionless) floors for retained stocks and rotor momentum.
    pub stock_scaled: f64,
    pub tracer_scaled: f64,
    pub rotor_scaled: f64,
    /// Physical volume-flow floor for phase-path impulses, m3/s.
    pub volume_flow_m3_s: f64,
}

impl<P: Properties> Network<P> {
    /// Absolute tolerances in solver scaling at the accepted state `y`.
    pub fn absolute_tolerances(
        &self,
        y: &[f64],
        classes: ToleranceClasses,
    ) -> Result<Vec<f64>, Failure> {
        let positive = [
            classes.relative,
            classes.stock_scaled,
            classes.tracer_scaled,
            classes.rotor_scaled,
            classes.volume_flow_m3_s,
        ];
        if positive.iter().any(|v| !v.is_finite() || *v <= 0.) {
            return Err(Failure::Fatal("tolerance classes must be positive".into()));
        }
        let mut atol = vec![0.; self.scales.len()];
        for (node, l) in self.cell_layout.iter().enumerate() {
            let k = l.phase;
            let (mi, ui) = self.stock_indices(node, k);
            let p = y[l.base] * self.scales[l.base];
            let mass = y[mi] * self.scales[mi];
            let energy = y[ui] * self.scales[ui];
            if mass <= 0. {
                return Err(Failure::Fatal(format!(
                    "pressure weight needs the compiled present phase in region {node}"
                )));
            }
            let point = self
                .properties
                .caloric(k == 1, p, energy / mass, false)
                .map_err(Failure::Fatal)?;
            let q = self.properties.values(&point);
            let isentropic = q.compressibility_per_pa
                - q.temperature_k * q.expansion_per_k.powi(2) / (q.density_kg_m3 * q.cp_j_kg_k);
            if !isentropic.is_finite() || isentropic <= 0. {
                return Err(Failure::Fatal(format!(
                    "nonpositive isentropic compressibility in region {node}"
                )));
            }
            atol[l.base] = classes.relative / (isentropic * self.scales[l.base]);
            for k in 0..2 {
                atol[l.mass[k]] = classes.stock_scaled;
                atol[l.energy[k]] = classes.stock_scaled;
            }
            atol[l.boron] = classes.tracer_scaled;
        }
        self.stratified_tolerances(y, classes, &mut atol)?;
        for l in &self.face_layout {
            atol[l.index] = classes.volume_flow_m3_s;
        }
        for index in &self.rotor_index {
            atol[*index] = classes.rotor_scaled;
        }
        Ok(atol)
    }

    /// The PZR block: zone and transit volumes (scaled by the cell volume)
    /// and the eleven stocks take the stock and tracer classes; the roof
    /// pressure takes `relative / (kappa_eff * scale)` with the cell's
    /// effective isentropic compressibility `kappa_eff = sum(V_k kappa_s,k)/V`
    /// from the stratified column at `y`.
    fn stratified_tolerances(
        &self,
        _y: &[f64],
        classes: ToleranceClasses,
        atol: &mut [f64],
    ) -> Result<(), Failure> {
        let base = self.pzr.base;
        for offset in PZR_VOLUME.iter().chain(&PZR_MASS).chain(&PZR_ENERGY) {
            atol[base + offset] = classes.stock_scaled;
        }
        for offset in PZR_TRACER {
            atol[base + offset] = classes.tracer_scaled;
        }
        Err(not_integrated(
            "the roof-pressure weight from the cell's effective isentropic compressibility",
        ))
    }
}
