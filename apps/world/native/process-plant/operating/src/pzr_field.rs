//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#finite-surge-and-pzr-connection-equations
//! Actual ten-region PZR constitutive/source field under decisions 0011/0012.
//! The caller supplies SAME-current phase properties, separate face mass flows
//! and radial/axial velocities. This is not a pressure/kinematic/inertial
//! stencil, an active-layout solver, or an admitted index-1 PZR realization.
//! Thermal sources use h only; mechanical conversion losses remain diagnostics
//! and are never stacked onto paid shaft heat or phase-volume pressure work.

use crate::thermal::{Saturation, Scalar, WaterPoint};
pub type Result<T> = std::result::Result<T, &'static str>;
pub const REGIONS: usize = 10;
pub const FACES: usize = 13;
const G: f64 = 9.80665;
fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}
fn finite(v: Scalar) -> Result<()> {
    if v.value.is_finite() && v.direction.is_finite() {
        Ok(())
    } else {
        Err("nonfinite PZR field value/direction")
    }
}
fn positive(v: Scalar) -> Result<()> {
    finite(v)?;
    if v.value > 0. {
        Ok(())
    } else {
        Err("unavailable PZR positive constitutive property")
    }
}
fn pow(v: Scalar, p: f64) -> Scalar {
    Scalar::new(
        v.value.powf(p),
        if v.value == 0. && v.direction == 0. {
            0.
        } else {
            p * v.value.powf(p - 1.) * v.direction
        },
    )
}
fn dot(a: [Scalar; 2], b: [Scalar; 2]) -> Scalar {
    a[0] * b[0] + a[1] * b[1]
}
fn norm(a: [Scalar; 2]) -> Scalar {
    let v = a[0].value.hypot(a[1].value);
    if v == 0. {
        s(0.)
    } else {
        Scalar::new(
            v,
            (a[0].value * a[0].direction + a[1].value * a[1].direction) / v,
        )
    }
}
fn sub(a: [Scalar; 2], b: [Scalar; 2]) -> [Scalar; 2] {
    [a[0] - b[0], a[1] - b[1]]
}
fn phase_contrast(from: [Scalar; 2], to: [Scalar; 2]) -> Scalar {
    // On each rigid-volume complement row this is alpha_l(from)-alpha_l(to),
    // including its tangent direction. Unlike subtracting two dominant
    // fractions, it retains a tiny positive minority value and its direction.
    // Off the volume rows it is the selected signed Newton residual extension;
    // do not normalize, clip, or override its recipient from a derivative.
    from[0] * to[1] - to[0] * from[1]
}
fn water(w: WaterPoint) -> Result<()> {
    for v in [w.density, w.viscosity, w.conductivity, w.cp] {
        positive(v)?;
    }
    finite(w.expansion)?;
    finite(w.enthalpy)
}

#[derive(Clone, Copy, Debug)]
pub struct Region {
    pub volume_m3: f64,
    pub axial_area_m2: f64,
    pub height_m: f64,
    pub solid_perimeter_m: f64,
    pub elevation_m: f64,
}
#[derive(Clone, Copy, Debug)]
pub struct Face {
    pub from: usize,
    pub to: usize,
    pub area_m2: f64,
    /// Explicit coarse-gradient centre distance, not a physical wall length.
    pub distance_m: f64,
    pub normal: [f64; 2],
}
#[derive(Clone, Copy, Debug)]
pub struct Phase {
    pub mass: Scalar,
    pub volume: Scalar,
    pub temperature: Scalar,
    /// Dissolved liquid tracer only; retained dry residue remains caller-owned.
    pub water: WaterPoint,
    pub velocity: [Scalar; 2],
    pub boron_mass: Scalar,
}
pub struct Input<'a> {
    pub pressure: &'a [Scalar; REGIONS],
    pub saturation: &'a [Saturation; REGIONS],
    /// Saturation at the mechanically reconstructed physical interface p.
    /// Never substitute one shared vessel p for nonuniform local pressures.
    pub face_saturation: &'a [Saturation; FACES],
    /// Liquid then vapor. None has no temperature, velocity or property query.
    pub phase: &'a [[Option<Phase>; 2]; REGIONS],
    pub face_mass_flow: &'a [[Scalar; 2]; FACES],
}
fn validate_charts(x: &Input<'_>) -> Result<()> {
    for p in x.pressure {
        positive(*p)?;
    }
    for sat in x.saturation.iter().chain(x.face_saturation) {
        positive(sat.temperature)?;
        water(sat.liquid)?;
        water(sat.vapor)?;
        positive(sat.vapor.enthalpy - sat.liquid.enthalpy)?;
    }
    Ok(())
}
#[derive(Clone, Copy, Debug, Default)]
pub struct Sources {
    pub mass: Scalar,
    pub enthalpy: Scalar,
    pub momentum: [Scalar; 2],
    pub boron: Scalar,
}
impl Sources {
    pub fn add(&mut self, b: Self, sign: f64) {
        self.mass = self.mass + s(sign) * b.mass;
        self.enthalpy = self.enthalpy + s(sign) * b.enthalpy;
        self.boron = self.boron + s(sign) * b.boron;
        for i in 0..2 {
            self.momentum[i] = self.momentum[i] + s(sign) * b.momentum[i];
        }
    }
    pub fn check(self) -> Result<()> {
        for v in [
            self.mass,
            self.enthalpy,
            self.boron,
            self.momentum[0],
            self.momentum[1],
        ] {
            finite(v)?;
        }
        Ok(())
    }
}
#[derive(Debug)]
pub struct Work {
    pub sources: [[Sources; 2]; REGIONS],
    /// Responsible net receipt into a currently absent phase; no epsilon birth.
    pub birth_receipts: [[Sources; 2]; REGIONS],
    pub wall_loss_w: [[Scalar; 2]; REGIONS],
    pub molecular_loss_w: [[Scalar; 2]; REGIONS],
    pub conversion_mixing_loss_w: [[Scalar; 2]; REGIONS],
    pub slip_loss_w: [Scalar; REGIONS],
    pub gravity_power_w: [[Scalar; 2]; REGIONS],
    pub volume_defect_m3: [Scalar; REGIONS],
    pub mass_defect_kg: [[Scalar; 2]; REGIONS],
    /// Unchanged Nu value, but zero enhancement slope is an INEXACT Newton
    /// coefficient at |slip|=0; the physical function is not differentiable.
    pub zero_slip_inexact_contacts: usize,
    pub selected_branch_direction: bool,
}
impl Default for Work {
    fn default() -> Self {
        Self {
            sources: [[Sources::default(); 2]; REGIONS],
            birth_receipts: [[Sources::default(); 2]; REGIONS],
            wall_loss_w: [[s(0.); 2]; REGIONS],
            molecular_loss_w: [[s(0.); 2]; REGIONS],
            conversion_mixing_loss_w: [[s(0.); 2]; REGIONS],
            slip_loss_w: [s(0.); REGIONS],
            gravity_power_w: [[s(0.); 2]; REGIONS],
            volume_defect_m3: [s(0.); REGIONS],
            mass_defect_kg: [[s(0.); 2]; REGIONS],
            zero_slip_inexact_contacts: 0,
            selected_branch_direction: false,
        }
    }
}
#[derive(Debug)]
pub struct Model {
    regions: [Region; REGIONS],
    faces: [Face; FACES],
    interfacial_length_m: f64,
    roughness_m: f64,
    contrast_factor: f64,
}
impl Model {
    pub fn new(
        regions: [Region; REGIONS],
        faces: [Face; FACES],
        interfacial_length_m: f64,
        roughness_m: f64,
        contrast_factor: f64,
    ) -> Result<Self> {
        if !interfacial_length_m.is_finite()
            || interfacial_length_m <= 0.
            || !roughness_m.is_finite()
            || roughness_m < 0.
            || !contrast_factor.is_finite()
            || contrast_factor < 0.
        {
            return Err("invalid PZR field coefficients");
        }
        for r in regions {
            if [r.volume_m3, r.axial_area_m2, r.height_m]
                .iter()
                .any(|v| !v.is_finite() || *v <= 0.)
                || !r.elevation_m.is_finite()
                || !r.solid_perimeter_m.is_finite()
                || r.solid_perimeter_m < 0.
            {
                return Err("invalid actual PZR region geometry");
            }
        }
        for (i, f) in faces.iter().enumerate() {
            if f.from >= REGIONS
                || f.to >= REGIONS
                || f.from == f.to
                || [f.area_m2, f.distance_m]
                    .iter()
                    .any(|v| !v.is_finite() || *v <= 0.)
                || !f.normal.iter().all(|v| v.is_finite())
                || (f.normal[0] * f.normal[0] + f.normal[1] * f.normal[1] - 1.).abs() > 1e-14
                || faces[..i].iter().any(|g| {
                    (g.from == f.from && g.to == f.to) || (g.from == f.to && g.to == f.from)
                })
            {
                return Err("invalid actual PZR face geometry/incidence");
            }
        }
        let mut reached = [false; REGIONS];
        reached[0] = true;
        for _ in 0..REGIONS {
            for f in faces {
                if reached[f.from] || reached[f.to] {
                    reached[f.from] = true;
                    reached[f.to] = true;
                }
            }
        }
        if reached.iter().any(|v| !*v) {
            return Err("disconnected actual PZR field");
        }
        Ok(Self {
            regions,
            faces,
            interfacial_length_m,
            roughness_m,
            contrast_factor,
        })
    }
    pub fn regions(&self) -> &[Region; REGIONS] {
        &self.regions
    }
    pub fn faces(&self) -> &[Face; FACES] {
        &self.faces
    }

    /// Physical input admission is separate from signed trial evaluation.
    /// Coherence rows are returned rather than hidden behind a private tolerance.
    pub fn validate_accepted(&self, x: &Input<'_>) -> Result<()> {
        validate_charts(x)?;
        for q in x.face_mass_flow.iter().flatten() {
            finite(*q)?;
        }
        for (i, node) in x.phase.iter().enumerate() {
            if node.iter().all(Option::is_none) {
                return Err("PZR region has no physical fluid phase");
            }
            for (k, p) in node.iter().enumerate() {
                if let Some(p) = p {
                    for v in [
                        p.mass,
                        p.volume,
                        p.temperature,
                        p.velocity[0],
                        p.velocity[1],
                        p.boron_mass,
                    ] {
                        finite(v)?;
                    }
                    positive(p.temperature)?;
                    water(p.water)?;
                    if p.mass.value <= 0.
                        || p.volume.value <= 0.
                        || p.volume.value > self.regions[i].volume_m3
                        || p.boron_mass.value < 0.
                    {
                        return Err("inadmissible accepted PZR phase mass/volume/tracer");
                    }
                    if k == 1 && (p.boron_mass.value != 0. || p.boron_mass.direction != 0.) {
                        return Err("PZR vapor does not own dissolved boron");
                    }
                    if (k == 0 && p.temperature.value > x.saturation[i].temperature.value)
                        || (k == 1 && p.temperature.value < x.saturation[i].temperature.value)
                    {
                        return Err("PZR stable phase boundary requires active conversion");
                    }
                }
            }
        }
        Ok(())
    }

    /// No property calls or allocations. External sources already have actual
    /// finite donors; they are added once, not interpreted as fixed boundaries.
    pub fn evaluate(
        &self,
        x: Input<'_>,
        external: &[[Sources; 2]; REGIONS],
        w: &mut Work,
    ) -> Result<()> {
        validate_charts(&x)?;
        *w = Work::default();
        w.sources = *external;
        for (i, node) in x.phase.iter().enumerate() {
            let mut volume = s(0.);
            for (k, phase) in node.iter().enumerate() {
                external[i][k].check()?;
                if let Some(p) = phase {
                    for v in [
                        p.mass,
                        p.volume,
                        p.temperature,
                        p.velocity[0],
                        p.velocity[1],
                        p.boron_mass,
                    ] {
                        finite(v)?;
                    }
                    positive(p.temperature)?;
                    water(p.water)?;
                    volume = volume + p.volume;
                    w.mass_defect_kg[i][k] = p.mass - p.volume * p.water.density;
                    if k == 1 && (p.boron_mass.value != 0. || p.boron_mass.direction != 0.) {
                        return Err("PZR vapor does not own dissolved boron");
                    }
                    let alpha = p.volume / s(self.regions[i].volume_m3);
                    let (force, tie) = solid_force(self.regions[i], *p, alpha, self.roughness_m)?;
                    w.selected_branch_direction |= tie;
                    for (j, f) in force.iter().enumerate() {
                        w.sources[i][k].momentum[j] = w.sources[i][k].momentum[j] + *f;
                    }
                    w.wall_loss_w[i][k] = -dot(force, p.velocity);
                    // Gravity is owned by the well-balanced face pressure
                    // equation. Return constitutive/advective forces only.
                    w.gravity_power_w[i][k] = -s(G) * p.mass * p.velocity[1];
                }
            }
            w.volume_defect_m3[i] = volume - s(self.regions[i].volume_m3);
            if let [Some(l), Some(g)] = node {
                let al = l.volume / s(self.regions[i].volume_m3);
                let ag = g.volume / s(self.regions[i].volume_m3);
                let slip = sub(g.velocity, l.velocity);
                let speed = norm(slip);
                let mu = al * l.water.viscosity + ag * g.water.viscosity;
                let rho = al * l.water.density + ag * g.water.density;
                positive(mu)?;
                positive(rho)?;
                let re = rho * speed * s(self.interfacial_length_m) / mu;
                let (cdre, tie) = interphase_drag_factor(re);
                w.selected_branch_direction |= tie;
                let scale = s(0.75 * self.regions[i].volume_m3 / self.interfacial_length_m.powi(2))
                    * cdre
                    * mu
                    * al
                    * ag;
                let force = [scale * slip[0], scale * slip[1]];
                for (j, f) in force.iter().enumerate() {
                    w.sources[i][0].momentum[j] = w.sources[i][0].momentum[j] + *f;
                    w.sources[i][1].momentum[j] = w.sources[i][1].momentum[j] - *f;
                }
                w.slip_loss_w[i] = dot(force, slip);
                let area = s(6. * self.regions[i].volume_m3 / self.interfacial_length_m) * al * ag;
                if area.value != 0. || area.direction != 0. {
                    self.exchange(i, i, *l, *g, area, x.saturation[i], w)?;
                }
            }
        }
        for (j, f) in self.faces.iter().enumerate() {
            for k in 0..2 {
                let q = x.face_mass_flow[j][k];
                finite(q)?;
                if q.value != 0. || q.direction != 0. {
                    let forward = q.value > 0. || (q.value == 0. && q.direction > 0.);
                    if q.value == 0. {
                        w.selected_branch_direction = true;
                    }
                    let donor = if forward { f.from } else { f.to };
                    let p =
                        x.phase[donor][k].ok_or("PZR face cannot withdraw absent donor phase")?;
                    if p.mass.value == 0. {
                        return Err("PZR donor concentration unavailable at zero mass");
                    }
                    let receipt = Sources {
                        mass: q,
                        enthalpy: q * p.water.enthalpy,
                        momentum: [q * p.velocity[0], q * p.velocity[1]],
                        boron: if k == 0 {
                            q * p.boron_mass / p.mass
                        } else {
                            s(0.)
                        },
                    };
                    w.sources[f.from][k].add(receipt, -1.);
                    w.sources[f.to][k].add(receipt, 1.);
                }
                if let (Some(a), Some(b)) = (x.phase[f.from][k], x.phase[f.to][k]) {
                    let aa = a.volume / s(self.regions[f.from].volume_m3);
                    let ab = b.volume / s(self.regions[f.to].volume_m3);
                    let fraction = if aa.value <= ab.value { aa } else { ab };
                    if aa.value == ab.value {
                        w.selected_branch_direction = true;
                    }
                    let kh = s(2.) * a.water.conductivity * b.water.conductivity
                        / (a.water.conductivity + b.water.conductivity);
                    let heat = s(f.area_m2 / f.distance_m)
                        * fraction
                        * kh
                        * (b.temperature - a.temperature);
                    w.sources[f.from][k].enthalpy = w.sources[f.from][k].enthalpy + heat;
                    w.sources[f.to][k].enthalpy = w.sources[f.to][k].enthalpy - heat;
                    // Shared normal-gradient Newtonian face traction. Complete
                    // axisymmetric hoop/boundary gradients belong to the still
                    // unselected mechanical stencil, not an invented shroud.
                    let mu = s(2.) * a.water.viscosity * b.water.viscosity
                        / (a.water.viscosity + b.water.viscosity);
                    let du = sub(b.velocity, a.velocity);
                    let normal = du[0] * s(f.normal[0]) + du[1] * s(f.normal[1]);
                    let scale = s(f.area_m2 / f.distance_m) * fraction * mu;
                    let traction =
                        std::array::from_fn(|d| scale * (du[d] + s(f.normal[d] / 3.) * normal));
                    for (d, t) in traction.iter().enumerate() {
                        w.sources[f.from][k].momentum[d] = w.sources[f.from][k].momentum[d] + *t;
                        w.sources[f.to][k].momentum[d] = w.sources[f.to][k].momentum[d] - *t;
                    }
                    let loss = dot(traction, du) * s(0.5);
                    w.molecular_loss_w[f.from][k] = w.molecular_loss_w[f.from][k] + loss;
                    w.molecular_loss_w[f.to][k] = w.molecular_loss_w[f.to][k] + loss;
                }
            }
            let fractions = |i: usize| {
                std::array::from_fn(|k| {
                    x.phase[i][k].map_or(s(0.), |p| p.volume / s(self.regions[i].volume_m3))
                })
            };
            let contrast = phase_contrast(fractions(f.from), fractions(f.to));
            if contrast.value != 0. || contrast.direction != 0. {
                let forward =
                    contrast.value > 0. || (contrast.value == 0. && contrast.direction > 0.);
                if contrast.value == 0. {
                    w.selected_branch_direction = true;
                }
                let (li, gi) = if forward {
                    (f.from, f.to)
                } else {
                    (f.to, f.from)
                };
                let liquid = x.phase[li][0].ok_or("contrast PZR liquid recipient unavailable")?;
                let gas = x.phase[gi][1].ok_or("contrast PZR vapor recipient unavailable")?;
                let area = s(f.area_m2 * self.contrast_factor)
                    * if forward { contrast } else { -contrast };
                if area.value != 0. || area.direction != 0. {
                    self.exchange(li, gi, liquid, gas, area, x.face_saturation[j], w)?;
                }
            }
        }
        for (i, node) in x.phase.iter().enumerate() {
            for (k, p) in node.iter().enumerate() {
                w.sources[i][k].check()?;
                if k == 1
                    && (w.sources[i][k].boron.value != 0. || w.sources[i][k].boron.direction != 0.)
                {
                    return Err("PZR vapor receipt cannot carry dissolved boron");
                }
                if p.is_none() {
                    let receipt = w.sources[i][k];
                    if receipt.mass.value < 0.
                        || (receipt.mass.value == 0. && receipt.mass.direction < 0.)
                    {
                        return Err("PZR source withdraws absent phase");
                    }
                    if receipt.mass.value == 0.
                        && [
                            receipt.enthalpy,
                            receipt.momentum[0],
                            receipt.momentum[1],
                            receipt.boron,
                        ]
                        .iter()
                        .any(|v| {
                            v.value != 0. || (receipt.mass.direction == 0. && v.direction != 0.)
                        })
                    {
                        return Err(
                            "PZR absent phase has no independent energy/momentum/tracer receiver",
                        );
                    }
                    w.birth_receipts[i][k] = receipt;
                }
            }
        }
        for row in w
            .wall_loss_w
            .iter()
            .chain(&w.molecular_loss_w)
            .chain(&w.conversion_mixing_loss_w)
            .chain(&w.gravity_power_w)
        {
            for v in row {
                finite(*v)?;
            }
        }
        for v in w
            .slip_loss_w
            .iter()
            .chain(&w.volume_defect_m3)
            .chain(w.mass_defect_kg.iter().flatten())
        {
            finite(*v)?;
        }
        Ok(())
    }
    #[allow(clippy::too_many_arguments)]
    fn exchange(
        &self,
        li: usize,
        gi: usize,
        l: Phase,
        g: Phase,
        area: Scalar,
        sat: Saturation,
        w: &mut Work,
    ) -> Result<()> {
        let slip = sub(g.velocity, l.velocity);
        let speed = norm(slip);
        let zero = speed.value == 0.;
        if zero
            && (l.temperature.value != sat.temperature.value
                || g.temperature.value != sat.temperature.value)
        {
            w.zero_slip_inexact_contacts += 1;
        }
        let h = |p: Phase| {
            let re = p.water.density * speed * s(self.interfacial_length_m) / p.water.viscosity;
            let pr = p.water.cp * p.water.viscosity / p.water.conductivity;
            // Explicit approved INEXACT coefficient slope at zero slip. Nu's
            // physical value stays exactly 2; there is no epsilon or smoothing.
            let root = if zero { s(0.) } else { pow(re, 0.5) };
            p.water.conductivity / s(self.interfacial_length_m)
                * (s(2.) + s(0.6) * root * pow(pr, 1. / 3.))
        };
        let ql = area * h(l) * (l.temperature - sat.temperature);
        let qg = area * h(g) * (g.temperature - sat.temperature);
        let gamma = (ql + qg) / (sat.vapor.enthalpy - sat.liquid.enthalpy);
        let evaporation = gamma.value > 0. || (gamma.value == 0. && gamma.direction >= 0.);
        let donor = if evaporation { l } else { g };
        if gamma.value == 0. && gamma.direction != 0. {
            w.selected_branch_direction = true;
        }
        let transfer = Sources {
            mass: gamma,
            enthalpy: s(0.),
            momentum: [gamma * donor.velocity[0], gamma * donor.velocity[1]],
            boron: s(0.),
        };
        w.sources[li][0].add(transfer, -1.);
        w.sources[gi][1].add(transfer, 1.);
        w.sources[li][0].enthalpy = w.sources[li][0].enthalpy - gamma * sat.liquid.enthalpy - ql;
        w.sources[gi][1].enthalpy = w.sources[gi][1].enthalpy + gamma * sat.vapor.enthalpy - qg;
        let receiver = if evaporation { g } else { l };
        let magnitude = if evaporation { gamma } else { -gamma };
        let delta = sub(donor.velocity, receiver.velocity);
        let loss = s(0.5) * magnitude * dot(delta, delta);
        let (i, k) = if evaporation { (gi, 1) } else { (li, 0) };
        w.conversion_mixing_loss_w[i][k] = w.conversion_mixing_loss_w[i][k] + loss;
        Ok(())
    }
}

/// Receipts of one liquid/vapor interface exchange. Liquid and vapor receive
/// opposite mass and momentum; neither carries dissolved boron.
#[derive(Clone, Copy, Debug)]
pub struct Exchange {
    pub liquid: Sources,
    pub vapor: Sources,
    /// Kinetic mixing loss of the converted mass, owned by its receiver, W.
    pub conversion_loss_w: Scalar,
    /// The net conversion evaporates liquid; false condenses vapor.
    pub evaporation: bool,
    /// Zero slip away from saturation: the zero Nusselt slope is an inexact
    /// Newton coefficient (the physical function has a square-root cusp).
    pub zero_slip_inexact: bool,
    /// The conversion sign was selected from its direction at exact zero.
    pub selected_branch_direction: bool,
}

/// Interface exchange between liquid `l` and vapor `g` over `area` at the
/// interface saturation `sat`: Ranz-Marshall film coefficients on each side
/// over `interfacial_length_m`, net latent conversion `(ql+qg)/hfg`.
pub fn exchange(
    interfacial_length_m: f64,
    l: Phase,
    g: Phase,
    area: Scalar,
    sat: Saturation,
) -> Exchange {
    let slip = sub(g.velocity, l.velocity);
    let speed = norm(slip);
    let zero = speed.value == 0.;
    let zero_slip_inexact = zero
        && (l.temperature.value != sat.temperature.value
            || g.temperature.value != sat.temperature.value);
    let h = |p: Phase| {
        let re = p.water.density * speed * s(interfacial_length_m) / p.water.viscosity;
        let pr = p.water.cp * p.water.viscosity / p.water.conductivity;
        // Explicit approved INEXACT coefficient slope at zero slip. Nu's
        // physical value stays exactly 2; there is no epsilon or smoothing.
        let root = if zero { s(0.) } else { pow(re, 0.5) };
        p.water.conductivity / s(interfacial_length_m) * (s(2.) + s(0.6) * root * pow(pr, 1. / 3.))
    };
    let ql = area * h(l) * (l.temperature - sat.temperature);
    let qg = area * h(g) * (g.temperature - sat.temperature);
    let gamma = (ql + qg) / (sat.vapor.enthalpy - sat.liquid.enthalpy);
    let evaporation = gamma.value > 0. || (gamma.value == 0. && gamma.direction >= 0.);
    let donor = if evaporation { l } else { g };
    let receiver = if evaporation { g } else { l };
    let momentum = [gamma * donor.velocity[0], gamma * donor.velocity[1]];
    let magnitude = if evaporation { gamma } else { -gamma };
    let delta = sub(donor.velocity, receiver.velocity);
    Exchange {
        liquid: Sources {
            mass: -gamma,
            enthalpy: -gamma * sat.liquid.enthalpy - ql,
            momentum: [-momentum[0], -momentum[1]],
            boron: s(0.),
        },
        vapor: Sources {
            mass: gamma,
            enthalpy: gamma * sat.vapor.enthalpy - qg,
            momentum,
            boron: s(0.),
        },
        conversion_loss_w: s(0.5) * magnitude * dot(delta, delta),
        evaporation,
        zero_slip_inexact,
        selected_branch_direction: gamma.value == 0. && gamma.direction != 0.,
    }
}

/// Same-phase conduction into `a` from `b` through a face of geometric
/// conductance `area_per_distance_m` (open area over centre distance, times
/// the shared phase fraction): harmonic-mean conductivity times `T_b - T_a`.
pub fn conduction(a: Phase, b: Phase, area_per_distance_m: Scalar) -> Scalar {
    let kh = s(2.) * a.water.conductivity * b.water.conductivity
        / (a.water.conductivity + b.water.conductivity);
    area_per_distance_m * kh * (b.temperature - a.temperature)
}

fn colebrook(re: Scalar, relative_roughness: f64) -> Result<Scalar> {
    let a = relative_roughness / 3.7;
    let c = 2. / std::f64::consts::LN_10;
    let mut y = 7.;
    for _ in 0..12 {
        let b = a + 2.51 * y / re.value;
        if b <= 0. {
            return Err("unavailable PZR Colebrook logarithm");
        }
        let residual = y + c * b.ln();
        y -= residual / (1. + c * 2.51 / (re.value * b));
    }
    let b = a + 2.51 * y / re.value;
    if !y.is_finite() || y <= 0. || (y + c * b.ln()).abs() > 1e-11 {
        return Err("PZR constitutive Colebrook failed");
    }
    let dy =
        c * 2.51 * y / (re.value * re.value * b) / (1. + c * 2.51 / (re.value * b)) * re.direction;
    Ok(Scalar::new(1. / (y * y), -2. * dy / (y * y * y)))
}
/// Schiller-Naumann `Cd*Re` below Re=1000 and Newton `0.44*Re` above; the
/// flag marks an exact tie at the selected transition (no smoothing).
pub fn interphase_drag_factor(re: Scalar) -> (Scalar, bool) {
    (
        if re.value < 1000. {
            s(24.) * (s(1.) + s(0.15) * pow(re, 0.687))
        } else {
            s(0.44) * re
        },
        re.value == 1000.,
    )
}
fn solid_force(r: Region, p: Phase, alpha: Scalar, roughness: f64) -> Result<([Scalar; 2], bool)> {
    if r.solid_perimeter_m == 0. {
        return Ok(([s(0.); 2], false));
    }
    let d = 4. * r.axial_area_m2 / r.solid_perimeter_m;
    let speed = norm(p.velocity);
    let re = p.water.density * speed * s(d) / p.water.viscosity;
    let scale = if re.value <= 2300. {
        // Analytic zero-speed laminar vector limit; no 64/0 or hidden floor.
        -alpha * s(r.solid_perimeter_m * r.height_m * 8. / d) * p.water.viscosity
    } else {
        let turbulent = colebrook(re, roughness / d)?;
        let f = if re.value >= 4000. {
            turbulent
        } else {
            let weight = (re - s(2300.)) / s(1700.);
            (s(1.) - weight) * s(64.) / re + weight * turbulent
        };
        -alpha * s(r.solid_perimeter_m * r.height_m / 8.) * f * p.water.density * speed
    };
    let force = [scale * p.velocity[0], scale * p.velocity[1]];
    finite(force[0])?;
    finite(force[1])?;
    Ok((force, re.value == 2300. || re.value == 4000.))
}

#[cfg(test)]
mod branch_tests {
    use super::*;
    #[test]
    fn contrast_retains_tiny_minority_value_and_direction_in_both_phase_regimes() {
        let minority = Scalar::new(1e-33, -3e-33);
        let relative = |actual: f64, expected: f64| {
            assert_ne!(actual, 0.);
            assert_eq!(actual.is_sign_positive(), expected.is_sign_positive());
            assert!((actual - expected).abs() <= 1e-14 * expected.abs());
        };
        for k in 0..2 {
            let mut pure = [s(0.); 2];
            pure[k] = s(1.);
            let mut mixed = pure;
            mixed[1 - k] = minority;
            mixed[k] = s(1.) - minority;
            // The dominant value has rounded to one while its direction has
            // not vanished: the actual pilot's failed liquid subtraction.
            assert_eq!(mixed[k].value, 1.);
            assert_ne!(mixed[k].direction, 0.);
            let expected = if k == 0 { minority } else { -minority };
            for (from, to, sign) in [(pure, mixed, 1.), (mixed, pure, -1.)] {
                let actual = phase_contrast(from, to);
                relative(actual.value, sign * expected.value);
                relative(actual.direction, sign * expected.direction);
            }
        }
    }

    #[test]
    fn contrast_matches_complement_rows_and_current_tangent_without_a_branch_switch() {
        for (a, b, ad, bd) in [
            (0.8, 0.2, 0.03, -0.04),
            (0.2, 0.8, -0.03, 0.04),
            (0.75, 0.75, 0.03, -0.04),
            (1., 0., -0.03, 0.04),
        ] {
            let a = Scalar::new(a, ad);
            let b = Scalar::new(b, bd);
            let actual = phase_contrast([a, s(1.) - a], [b, s(1.) - b]);
            let expected = a - b;
            assert!((actual.value - expected.value).abs() < 2e-16);
            assert!((actual.direction - expected.direction).abs() < 2e-16);
            let step = 1e-5;
            let at = |h: f64| {
                let av = s(a.value + h * a.direction);
                let bv = s(b.value + h * b.direction);
                phase_contrast([av, s(1.) - av], [bv, s(1.) - bv]).value
            };
            let fd = (at(step) - at(-step)) / (2. * step);
            assert!((actual.direction - fd).abs() < 1e-11);
        }
    }

    #[test]
    fn free_exchange_conserves_mass_momentum_and_energy_and_flags_zero_slip() {
        let point = |t: f64, vapor: bool| WaterPoint {
            density: s(if vapor { 80. } else { 660. }),
            viscosity: s(if vapor { 2e-5 } else { 1e-4 }),
            conductivity: s(if vapor { 0.06 } else { 0.6 }),
            cp: s(if vapor { 3000. } else { 5000. }),
            expansion: s(0.002),
            enthalpy: s(if vapor { 2.6e6 } else { 1.4e6 } + 4000. * (t - 600.)),
        };
        let phase = |t: Scalar, vapor: bool, v: [Scalar; 2]| Phase {
            mass: s(10.),
            volume: s(0.1),
            temperature: t,
            water: point(t.value, vapor),
            velocity: v,
            boron_mass: s(0.),
        };
        let sat = Saturation {
            temperature: Scalar::new(615., 0.01),
            liquid: point(615., false),
            vapor: point(615., true),
            surface_tension: s(0.025),
        };
        for (tl, tg, slip) in [(612., 618., 0.1), (616., 619., -0.2), (612., 613., 0.)] {
            let l = phase(Scalar::new(tl, 0.2), false, [s(0.), s(0.01)]);
            let g = phase(Scalar::new(tg, -0.1), true, [s(0.), s(0.01 + slip)]);
            let e = exchange(0.003, l, g, Scalar::new(2., 0.1), sat);
            assert_eq!((e.liquid.mass + e.vapor.mass).value, 0.);
            assert_eq!((e.liquid.mass + e.vapor.mass).direction, 0.);
            for d in 0..2 {
                assert_eq!((e.liquid.momentum[d] + e.vapor.momentum[d]).value, 0.);
            }
            // Net enthalpy receipt is gamma*hfg - ql - qg = 0 to rounding.
            let net = e.liquid.enthalpy + e.vapor.enthalpy;
            assert!(net.value.abs() <= 1e-9 * e.vapor.enthalpy.value.abs().max(1.));
            assert_eq!(e.evaporation, e.vapor.mass.value >= 0.);
            assert_eq!(e.zero_slip_inexact, slip == 0.);
            assert!(e.conversion_loss_w.value >= 0.);
        }
        let a = phase(Scalar::new(600., 1.), false, [s(0.); 2]);
        let b = phase(Scalar::new(610., 0.), false, [s(0.); 2]);
        let heat = conduction(a, b, s(4.));
        assert_eq!(heat.value, 4. * 0.6 * 10.);
        assert_eq!(heat.direction, -4. * 0.6);
        assert_eq!((heat + conduction(b, a, s(4.))).value, 0.);
    }

    #[test]
    fn drag_and_solid_transition_ties_are_explicit_not_smoothed() {
        let below = interphase_drag_factor(Scalar::new(1000. - 1e-6, 1.));
        let at = interphase_drag_factor(Scalar::new(1000., 1.));
        let above = interphase_drag_factor(Scalar::new(1000. + 1e-6, 1.));
        assert!(!below.1 && at.1 && !above.1);
        assert!((below.0.value - at.0.value).abs() > 1.);
        assert_eq!(at.0.value, 440.);
        assert_eq!(at.0.direction, 0.44);
        let r = Region {
            volume_m3: 1.,
            axial_area_m2: 1.,
            height_m: 1.,
            solid_perimeter_m: 4.,
            elevation_m: 0.,
        };
        let point = Phase {
            mass: s(1.),
            volume: s(1.),
            temperature: s(600.),
            water: WaterPoint {
                density: s(1.),
                viscosity: s(1.),
                conductivity: s(1.),
                cp: s(1.),
                expansion: s(1.),
                enthalpy: s(1.),
            },
            velocity: [s(0.); 2],
            boron_mass: s(0.),
        };
        for re in [2300., 4000.] {
            let mut p = point;
            p.velocity[0] = Scalar::new(re, 1.);
            assert!(solid_force(r, p, s(1.), 0.000045).unwrap().1);
            p.velocity[0].value = re - 1e-4;
            assert!(!solid_force(r, p, s(1.), 0.000045).unwrap().1);
            p.velocity[0].value = re + 1e-4;
            assert!(!solid_force(r, p, s(1.), 0.000045).unwrap().1);
        }
        let mut p = point;
        p.velocity[0].direction = 1.;
        let (force, tie) = solid_force(r, p, s(1.), 0.000045).unwrap();
        assert!(!tie);
        assert_eq!(force[0].value, 0.);
        assert_eq!(force[0].direction, -32.);
    }
}
