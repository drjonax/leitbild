//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hydraulics.md#local-pressure-and-phase-path-impulse
//! Coarse local-pressure face mechanics with finite, current material.
//!
//! One retained generalized impulse Pi (Pa s) projects physical momentum on
//! the fixed section profile u(s)=Q/A(s). Thus I=int(rho*alpha/A ds), Pi=I*Q.
//! Pi is not total linear momentum and is not L times the upwind mass flux.
//! The compiler supplies actual section/radial integrals and once-owned dual
//! supports. No pressure projection, integrator, phase floor or property query
//! lives here. Source forces and node velocities use the same virtual-work
//! projection; the caller must not retain a second node-momentum bank.
use crate::thermal::Scalar;

pub type Result<T> = std::result::Result<T, &'static str>;
const G: f64 = 9.80665;
fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}
fn finite(v: Scalar) -> Result<()> {
    if v.value.is_finite() && v.direction.is_finite() {
        Ok(())
    } else {
        Err("nonfinite local face value/direction")
    }
}

#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MomentumSupport {
    pub region: usize,
    pub path_length_m: f64,
    /// Actual integral of ds/A(s), in 1/m; radial supports use the log integral.
    pub inverse_area_length_per_m: f64,
    /// Physical dual portion, not additional stored water.
    pub volume_m3: f64,
}
#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PressureSegment {
    pub region: usize,
    /// Zero is allowed only for explicitly authored head-only reference legs.
    pub path_length_m: f64,
    pub elevation_change_m: f64,
}
#[derive(Clone, Debug)]
pub struct Face {
    pub from: usize,
    pub to: usize,
    pub flow_area_m2: f64,
    pub supports: Vec<MomentumSupport>,
    pub pressure_segments: Vec<PressureSegment>,
}
impl Face {
    pub fn validate(&self, regions: usize) -> Result<()> {
        if self.from >= regions
            || self.to >= regions
            || self.from == self.to
            || !self.flow_area_m2.is_finite()
            || self.flow_area_m2 <= 0.
            || self.supports.is_empty()
            || self.pressure_segments.is_empty()
            || self.supports.iter().any(|p| {
                p.region >= regions
                    || [p.path_length_m, p.inverse_area_length_per_m, p.volume_m3]
                        .iter()
                        .any(|v| !v.is_finite() || *v <= 0.)
            })
            || self.pressure_segments.iter().any(|p| {
                p.region >= regions
                    || !p.path_length_m.is_finite()
                    || p.path_length_m < 0.
                    || !p.elevation_change_m.is_finite()
            })
            || self
                .pressure_segments
                .iter()
                .map(|p| p.path_length_m)
                .sum::<f64>()
                <= 0.
        {
            return Err("invalid local face/support/pressure geometry");
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Phase {
    pub fraction: Scalar,
    pub density: Scalar,
    pub enthalpy: Scalar,
    /// Actual retained dissolved amount / actual retained phase mass.
    pub boron_concentration: Scalar,
}
#[derive(Clone, Copy, Debug)]
pub struct Cell {
    pub pressure: Scalar,
    /// Liquid then vapor. None never receives an independent property state.
    pub phase: [Option<Phase>; 2],
}
fn check_cell(c: Cell) -> Result<()> {
    finite(c.pressure)?;
    for p in c.phase.into_iter().flatten() {
        for v in [p.fraction, p.density, p.enthalpy, p.boron_concentration] {
            finite(v)?;
        }
        if p.density.value <= 0. {
            return Err("local face requires actual positive phase density");
        }
    }
    Ok(())
}
fn mixture(c: Cell) -> Scalar {
    c.phase
        .into_iter()
        .flatten()
        .fold(s(0.), |v, p| v + p.fraction * p.density)
}
fn pressure_path(face: &Face, cells: &[Cell]) -> Result<(f64, Scalar)> {
    let mut head = s(0.);
    let mut length = 0.;
    for p in &face.pressure_segments {
        let c = *cells.get(p.region).ok_or("local pressure segment index")?;
        check_cell(c)?;
        length += p.path_length_m;
        head = head + mixture(c) * s(G * p.elevation_change_m);
    }
    if !length.is_finite() || length <= 0. {
        return Err("local pressure path requires a positive dynamic length");
    }
    Ok((
        length,
        cells[face.from].pressure - cells[face.to].pressure - head,
    ))
}
/// Physical interface pressure at an explicitly selected boundary between
/// authored pressure segments. PZR centroid-to-interface-to-centroid faces
/// select the boundary after their first segment; no new algebraic p is added.
pub fn pressure_after_segments(face: &Face, cells: &[Cell], count: usize) -> Result<Scalar> {
    if face.from >= cells.len() || face.to >= cells.len() || count > face.pressure_segments.len() {
        return Err("local pressure interface index");
    }
    let (length, dynamic) = pressure_path(face, cells)?;
    let mut p = cells[face.from].pressure;
    for segment in &face.pressure_segments[..count] {
        p = p
            - mixture(cells[segment.region]) * s(G * segment.elevation_change_m)
            - s(segment.path_length_m / length) * dynamic;
    }
    finite(p)?;
    Ok(p)
}

#[derive(Clone, Copy, Debug)]
pub struct Chart {
    pub inertance_kg_m4: Scalar,
    pub volume_flow_m3_s: Scalar,
    pub mass_flow_kg_s: Scalar,
    pub enthalpy_flow_w: Scalar,
    pub boron_flow_kg_s: Scalar,
    pub pressure_gravity_pa: Scalar,
    /// Diagnostic only under the selected low-Mach thermal convention.
    pub kinetic_j: Scalar,
    pub donor: Option<usize>,
    pub blocked_absent_donor: bool,
    pub selected_branch_direction: bool,
}

/// Current allocation-free kinematic/pressure chart. Transport is signed from
/// `from` to `to`; the caller adds each M/H/B receipt with opposite owner signs.
/// Geometry is admitted once by Face::validate. Signed Newton fractions are
/// not clipped; physical accepted-state and EOS admission belong to the caller.
pub fn chart(
    face: &Face,
    cells: &[Cell],
    phase: usize,
    impulse_pa_s: Scalar,
) -> Result<Option<Chart>> {
    if phase >= 2 || face.from >= cells.len() || face.to >= cells.len() {
        return Err("local face phase/cell index");
    }
    finite(impulse_pa_s)?;
    check_cell(cells[face.from])?;
    check_cell(cells[face.to])?;
    let mut inertance = s(0.);
    for p in &face.supports {
        let c = *cells.get(p.region).ok_or("local face support index")?;
        check_cell(c)?;
        if let Some(a) = c.phase[phase] {
            inertance = inertance + a.density * a.fraction * s(p.inverse_area_length_per_m);
        }
    }
    finite(inertance)?;
    if inertance.value == 0. && inertance.direction == 0. {
        if impulse_pa_s.value != 0. || impulse_pa_s.direction != 0. {
            return Err("absent face phase cannot retain independent impulse");
        }
        return Ok(None);
    }
    if inertance.value <= 0. {
        return Err("unavailable positive local face inertia");
    }
    chart_from_path(
        face,
        cells,
        phase,
        impulse_pa_s,
        PathKinematics {
            inertance_kg_m4: inertance,
            inertance_rate_kg_m4_s: s(0.),
            volume_flow_m3_s: impulse_pa_s / inertance,
        },
    )
    .map(Some)
}

/// Reuse the same donor/pressure assembly with the explicitly selected finite
/// mass/impulse kinematics. The path owner must supply its physical zero-stock
/// limit; this function never invents a phase or divides an empty impulse.
pub fn chart_from_path(
    face: &Face,
    cells: &[Cell],
    phase: usize,
    impulse_pa_s: Scalar,
    path: PathKinematics,
) -> Result<Chart> {
    if phase >= 2 || face.from >= cells.len() || face.to >= cells.len() {
        return Err("local face phase/cell index");
    }
    finite(impulse_pa_s)?;
    finite(path.inertance_kg_m4)?;
    finite(path.volume_flow_m3_s)?;
    check_cell(cells[face.from])?;
    check_cell(cells[face.to])?;
    let inertance = path.inertance_kg_m4;
    let qv = path.volume_flow_m3_s;
    let selected_branch_direction = qv.value == 0. && qv.direction != 0.;
    let donor = if qv.value > 0. || (qv.value == 0. && qv.direction > 0.) {
        Some(face.from)
    } else if qv.value < 0. || (qv.value == 0. && qv.direction < 0.) {
        Some(face.to)
    } else {
        None
    };
    let available = donor.and_then(|i| cells[i].phase[phase]);
    let (mass, enthalpy, boron) = available.map_or((s(0.), s(0.), s(0.)), |a| {
        let mass = a.density * a.fraction * qv;
        (mass, mass * a.enthalpy, mass * a.boron_concentration)
    });

    // Reconstruct pressure as hydrostatic + a linear dynamic-pressure defect.
    // A single raw linear pressure gradient fails sharp liquid/vapor rest.
    let (length, dynamic) = pressure_path(face, cells)?;
    let mut drive = s(0.);
    for p in &face.pressure_segments {
        let c = cells[p.region];
        if let Some(a) = c.phase[phase] {
            drive = drive
                + a.fraction
                    * ((mixture(c) - a.density) * s(G * p.elevation_change_m)
                        + s(p.path_length_m / length) * dynamic);
        }
    }
    let result = Chart {
        inertance_kg_m4: inertance,
        volume_flow_m3_s: qv,
        mass_flow_kg_s: mass,
        enthalpy_flow_w: enthalpy,
        boron_flow_kg_s: boron,
        pressure_gravity_pa: drive,
        kinetic_j: s(0.5) * impulse_pa_s * qv,
        donor: donor.filter(|_| available.is_some()),
        blocked_absent_donor: donor.is_some() && available.is_none(),
        selected_branch_direction,
    };
    for v in [
        result.inertance_kg_m4,
        result.volume_flow_m3_s,
        result.mass_flow_kg_s,
        result.enthalpy_flow_w,
        result.boron_flow_kg_s,
        result.pressure_gravity_pa,
        result.kinetic_j,
    ] {
        finite(v)?;
    }
    Ok(result)
}

/// The same fixed profile maps finite region forces to a face's generalized
/// force and maps Q back to mean region velocity. For uniform physical force
/// density the coefficient is Lsupport/Vregion, even for an exact radial area.
#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ForceProjection {
    pub region: usize,
    pub coefficient_per_m2: f64,
    pub normal: [f64; 2],
}
fn check_projection(p: ForceProjection, regions: usize) -> Result<()> {
    if p.region >= regions
        || !p.coefficient_per_m2.is_finite()
        || p.coefficient_per_m2 <= 0.
        || !p.normal.iter().all(|v| v.is_finite())
        || (p.normal[0] * p.normal[0] + p.normal[1] * p.normal[1] - 1.).abs() > 1e-14
    {
        Err("invalid local face force/velocity projection")
    } else {
        Ok(())
    }
}
/// Excludes gravity and pressure: this module already owns them. Wall, slip,
/// molecular, advective and conversion forces enter exactly once here.
pub fn project_nonpressure(
    projection: &[ForceProjection],
    region_forces_n: &[[Scalar; 2]],
) -> Result<Scalar> {
    let mut force = s(0.);
    for p in projection {
        check_projection(*p, region_forces_n.len())?;
        let f = region_forces_n[p.region];
        finite(f[0])?;
        finite(f[1])?;
        force = force + s(p.coefficient_per_m2) * (s(p.normal[0]) * f[0] + s(p.normal[1]) * f[1]);
    }
    finite(force)?;
    Ok(force)
}
/// Caller zeros the output once, then adds each active face/phase exactly once.
pub fn add_mean_velocity(
    projection: &[ForceProjection],
    volume_flow_m3_s: Scalar,
    region_velocity_m_s: &mut [[Scalar; 2]],
) -> Result<()> {
    finite(volume_flow_m3_s)?;
    for p in projection {
        check_projection(*p, region_velocity_m_s.len())?;
        for (d, v) in region_velocity_m_s[p.region].iter_mut().enumerate() {
            *v = *v + s(p.coefficient_per_m2 * p.normal[d]) * volume_flow_m3_s;
            finite(*v)?;
        }
    }
    Ok(())
}
/// Additional pressure-Pa laws (existing pipe/pump losses) and projected body
/// forces are supplied once, without adding friction/pressure heat.
pub fn momentum_residual(
    impulse_rate_pa: Scalar,
    current: Chart,
    nonpressure_drive_pa: Scalar,
) -> Result<Scalar> {
    finite(impulse_rate_pa)?;
    finite(nonpressure_drive_pa)?;
    let residual = impulse_rate_pa - current.pressure_gravity_pa - nonpressure_drive_pa;
    finite(residual)?;
    Ok(residual)
}

/// A cold-path limit is an explicit caller-owned physical selection, not a
/// universal zero-current default for a face without phase mass.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ColdOnset {
    Unavailable,
    /// The caller proved this rest start: I=Pi=I'=F=0 and the first nonzero
    /// terms satisfy I=O(t²), F=O(t²), Pi=O(t³), hence Q tends to zero.
    ProvenRest,
}

#[derive(Clone, Copy, Debug)]
pub struct PathKinematics {
    pub inertance_kg_m4: Scalar,
    pub inertance_rate_kg_m4_s: Scalar,
    pub volume_flow_m3_s: Scalar,
}

/// Use retained phase mass directly: alpha*rho=M/Vcell, so neither I nor I'
/// needs an absent-phase EOS point. The authored reciprocal-area integral is
/// the same physical support used by the ordinary finite face chart.
///
/// Nonzero signed I is a Newton extension, not accepted material admission.
/// At I=Pi=0 and I'>0 the actual one-sided momentum balance gives Q=F/I'. F
/// MUST include all selected pressure, gravity and responsible momentum
/// receipts; pressure alone is not a substitute for the complete force.
///
/// At exact zero I the returned direction belongs to the selected onset
/// chart, NOT a Cartesian derivative of Pi/I. A caller-proven rest onset has
/// zero selected Q direction; its impulse equation still retains Pi'. No
/// mass/inertia floor, phase seed, universal Q=0 or higher-order limit is made.
pub fn phase_path_kinematics(
    face: &Face,
    cell_phase_mass: &[Scalar],
    cell_phase_mass_rate: &[Scalar],
    cell_volumes: &[f64],
    impulse_pa_s: Scalar,
    total_force_pa: Scalar,
    onset: ColdOnset,
) -> Result<PathKinematics> {
    if cell_phase_mass.len() != cell_volumes.len()
        || cell_phase_mass_rate.len() != cell_volumes.len()
    {
        return Err("local phase mass/volume layout mismatch");
    }
    finite(impulse_pa_s)?;
    finite(total_force_pa)?;
    let mut inertia = s(0.);
    let mut inertia_rate = s(0.);
    let mut has_nonzero_mass = false;
    for support in &face.supports {
        let i = support.region;
        let v = *cell_volumes.get(i).ok_or("local phase support index")?;
        if !v.is_finite()
            || v <= 0.
            || !support.inverse_area_length_per_m.is_finite()
            || support.inverse_area_length_per_m <= 0.
        {
            return Err("invalid local phase inertia geometry");
        }
        finite(cell_phase_mass[i])?;
        finite(cell_phase_mass_rate[i])?;
        has_nonzero_mass |= cell_phase_mass[i].value != 0.;
        let weight = s(support.inverse_area_length_per_m / v);
        inertia = inertia + cell_phase_mass[i] * weight;
        inertia_rate = inertia_rate + cell_phase_mass_rate[i] * weight;
    }
    finite(inertia)?;
    finite(inertia_rate)?;
    if inertia.value == 0. && has_nonzero_mass {
        return Err("singular signed phase inertia is not exact absence");
    }
    let flow = if inertia.value != 0. {
        impulse_pa_s / inertia
    } else if impulse_pa_s.value != 0. {
        return Err("zero phase inertia cannot retain finite impulse");
    } else if inertia_rate.value > 0. {
        total_force_pa / inertia_rate
    } else if onset == ColdOnset::ProvenRest
        && inertia_rate.value == 0.
        && total_force_pa.value == 0.
    {
        s(0.)
    } else {
        return Err("unavailable responsible cold phase path limit");
    };
    finite(flow)?;
    Ok(PathKinematics {
        inertance_kg_m4: inertia,
        inertance_rate_kg_m4_s: inertia_rate,
        volume_flow_m3_s: flow,
    })
}
