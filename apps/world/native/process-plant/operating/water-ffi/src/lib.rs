//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-phase-properties.md#one-maintained-water-implementation
//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-phase-properties.md#bounded-metastable-admission
//! The only unsafe water boundary. The pure operating equation crate remains
//! unsafe-forbidden and has no dependency on this opt-in native package.

use std::fmt;

#[derive(Clone, Copy, Debug)]
#[repr(i32)]
pub enum Branch {
    Liquid = 0,
    Vapor = 1,
    SaturatedLiquid = 2,
    SaturatedVapor = 3,
}

/// C layout checked by actual calls, not a serialized approximation to IF97.
#[derive(Clone, Copy, Debug, Default)]
#[repr(C)]
pub struct WaterPoint {
    pub region: i32,
    pub pressure_pa: f64,
    pub temperature_k: f64,
    pub density_kg_m3: f64,
    pub internal_energy_j_kg: f64,
    pub enthalpy_j_kg: f64,
    pub cp_j_kg_k: f64,
    pub cv_j_kg_k: f64,
    pub expansion_per_k: f64,
    pub compressibility_per_pa: f64,
    pub viscosity_pa_s: f64,
    pub conductivity_w_m_k: f64,
    pub saturation_slope_k_pa: f64,
    /// Signed departure `T - Tsat(p)` on the requested branch: positive is a
    /// superheated liquid, negative a subcooled vapor; zero at an endpoint.
    pub saturation_departure_k: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Error {
    Domain,
    AbiArgument,
    NativeFailure,
    /// A metastable state of the requested branch outside its bounded trial
    /// band. Recoverable: a solver trial may step back inside it.
    TrialBand,
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "operating IF97: {self:?}")
    }
}
impl std::error::Error for Error {}

unsafe extern "C" {
    fn ld01_water_point(
        branch: i32,
        pressure_pa: f64,
        temperature_k: f64,
        output: *mut WaterPoint,
    ) -> i32;
    fn ld01_water_caloric(
        branch: i32,
        pressure_pa: f64,
        temperature_k: f64,
        output: *mut WaterPoint,
    ) -> i32;
    fn ld01_water_complete(caloric: *const WaterPoint, fields: i32, output: *mut WaterPoint)
    -> i32;
    fn ld01_water_direction(
        branch: i32,
        pressure_pa: f64,
        temperature_k: f64,
        pressure_direction: f64,
        temperature_direction: f64,
        output: *mut WaterPoint,
        direction: *mut WaterPoint,
    ) -> i32;
    fn ld01_water_direction_held(
        branch: i32,
        held: *const WaterPoint,
        pressure_direction: f64,
        temperature_direction: f64,
        direction: *mut WaterPoint,
    ) -> i32;
    fn ld01_water_fields(
        branch: i32,
        pressure_pa: f64,
        temperature_k: f64,
        fields: i32,
        output: *mut WaterPoint,
    ) -> i32;
    fn ld01_water_direction_exact(
        branch: i32,
        held: *const WaterPoint,
        pressure_direction: f64,
        temperature_direction: f64,
        direction: *mut WaterPoint,
    ) -> i32;
    fn ld01_water_bracket(
        branch: i32,
        pressure_pa: f64,
        stable_branch: *mut i32,
        stable_temperature_k: *mut f64,
        trial_temperature_k: *mut f64,
    ) -> i32;
    fn ld01_water_metastable_band(output: *mut MetastableBand) -> i32;
    fn ld01_water_surface(
        temperature: f64,
        temperature_direction: f64,
        value: *mut f64,
        direction: *mut f64,
    ) -> i32;
    fn ld01_water_vapor_sat_density(
        temperature: f64,
        temperature_direction: f64,
        value: *mut f64,
        direction: *mut f64,
    ) -> i32;
}

pub fn point(branch: Branch, pressure_pa: f64, temperature_k: f64) -> Result<WaterPoint, Error> {
    let mut output = WaterPoint::default();
    // SAFETY: repr(C) contains only C int/doubles in declared order. Pointer
    // refers to a unique live stack allocation; C writes its complete tuple on
    // success, keeps no pointer, and catches every C++ exception. The enum has
    // only the four supported ABI discriminants. No buffer or allocator crosses.
    let status =
        unsafe { ld01_water_point(branch as i32, pressure_pa, temperature_k, &mut output) };
    match status {
        0 => Ok(output),
        1 => Err(Error::Domain),
        2 => Err(Error::AbiArgument),
        4 => Err(Error::TrialBand),
        _ => Err(Error::NativeFailure),
    }
}

/// The caloric-inverse state of the SAME forward point, for its brackets and
/// iterates only: the same branch, domain and region checks and bit-identical
/// rho/u/h/cp/alpha, the fields that inverse reads. Entropy, cv, sound speed,
/// compressibility, transport and the p-only saturation slope are not
/// evaluated; their fields are NaN. Never returned to a caller: the inverse
/// returns `complete` of the selected state.
fn caloric_state(
    branch: Branch,
    pressure_pa: f64,
    temperature_k: f64,
) -> Result<WaterPoint, Error> {
    let mut output = WaterPoint::default();
    // SAFETY: the same C-layout contract as `point`: a unique live stack
    // allocation, completely written on success and retained nowhere; the
    // native function catches every C++ exception.
    let status =
        unsafe { ld01_water_caloric(branch as i32, pressure_pa, temperature_k, &mut output) };
    match status {
        0 => Ok(output),
        1 => Err(Error::Domain),
        2 => Err(Error::AbiArgument),
        4 => Err(Error::TrialBand),
        _ => Err(Error::NativeFailure),
    }
}

/// Fields the native completion adds to a caloric state, by bit (the
/// bridge's `FIELD_*`): cv, compressibility, viscosity, conductivity and the
/// saturation slope.
const FIELD_CV: i32 = 1;
const FIELD_KAPPA: i32 = 2;
const FIELD_MU: i32 = 4;
const FIELD_K: i32 = 8;
const FIELD_SLOPE: i32 = 16;
const FIELDS_ALL: i32 = FIELD_CV | FIELD_KAPPA | FIELD_MU | FIELD_K | FIELD_SLOPE;

/// `point(branch, p, T)` from `caloric_state(branch, p, T)`'s own output,
/// without evaluating its caloric fields again: the native boundary adds
/// cv, compressibility, transport and the saturation slope to the held
/// state. Only a state this boundary's `caloric_state` returned is passed.
fn complete(caloric: &WaterPoint) -> Result<WaterPoint, Error> {
    complete_fields(caloric, FIELDS_ALL)
}

/// The same completion restricted to `fields`; unrequested fields are NaN.
fn complete_fields(caloric: &WaterPoint, fields: i32) -> Result<WaterPoint, Error> {
    let mut output = WaterPoint::default();
    // SAFETY: `caloric` is a live shared C-layout tuple that C only reads
    // during the call; `output` is a unique live stack allocation written
    // completely on success. Nothing is retained; C catches every exception.
    let status = unsafe { ld01_water_complete(caloric, fields, &mut output) };
    match status {
        0 => Ok(output),
        1 => Err(Error::Domain),
        2 => Err(Error::AbiArgument),
        _ => Err(Error::NativeFailure),
    }
}

/// `point(branch, p, T)` with only `fields` evaluated beyond the caloric
/// state: the same branch, domain and region checks and status codes.
fn point_fields(branch: Branch, p: f64, t: f64, fields: i32) -> Result<WaterPoint, Error> {
    let mut output = WaterPoint::default();
    // SAFETY: the same C-layout contract as `point`: a unique live stack
    // allocation, completely written on success and retained nowhere; the
    // native function catches every C++ exception.
    let status = unsafe { ld01_water_fields(branch as i32, p, t, fields, &mut output) };
    match status {
        0 => Ok(output),
        1 => Err(Error::Domain),
        2 => Err(Error::AbiArgument),
        4 => Err(Error::TrialBand),
        _ => Err(Error::NativeFailure),
    }
}

/// The exact part of `directional_held(branch, held, dp, dt)`: p, T, rho, u
/// and h bit for bit, every other field NaN; no coefficient probe.
fn exact_held(branch: Branch, held: &WaterPoint, dp: f64, dt: f64) -> Result<WaterPoint, Error> {
    let mut direction = WaterPoint::default();
    // SAFETY: `held` is a live shared C-layout tuple that C only reads;
    // `direction` is a unique live stack allocation written on success.
    // Nothing is retained; the native function catches errors.
    let status = unsafe { ld01_water_direction_exact(branch as i32, held, dp, dt, &mut direction) };
    match status {
        0 => Ok(direction),
        1 => Err(Error::Domain),
        2 => Err(Error::AbiArgument),
        _ => Err(Error::NativeFailure),
    }
}

/// The saturated liquid and vapor endpoints at `p` with their exact
/// directions along `dp`: temperature, density and enthalpy bit for bit
/// those of `directional(Saturated*, p, 0, dp, 0)`. Transport, cv, cp and
/// expansion directions are not evaluated (NaN), and no coefficient probe is
/// made. At a seed of exactly +0.0 those three directions are +0.0 (the
/// exact directions are products of the seed with the finite positive
/// slope, compressibility, density and cp), so the endpoint needs neither its
/// compressibility nor its slope, and every other direction is NaN.
pub fn saturation_caloric(p: f64, dp: f64) -> Result<[(WaterPoint, WaterPoint); 2], Error> {
    if !dp.is_finite() {
        return Err(Error::AbiArgument);
    }
    let value_only = dp.to_bits() == 0;
    let endpoint = |branch: Branch| -> Result<(WaterPoint, WaterPoint), Error> {
        if value_only {
            let q = point_fields(branch, p, 0., 0)?;
            let n = f64::NAN;
            let zero = WaterPoint {
                region: q.region,
                pressure_pa: 0.,
                temperature_k: 0.,
                density_kg_m3: 0.,
                internal_energy_j_kg: n,
                enthalpy_j_kg: 0.,
                cp_j_kg_k: n,
                cv_j_kg_k: n,
                expansion_per_k: n,
                compressibility_per_pa: n,
                viscosity_pa_s: n,
                conductivity_w_m_k: n,
                saturation_slope_k_pa: n,
                saturation_departure_k: n,
            };
            return Ok((q, zero));
        }
        let q = point_fields(branch, p, 0., FIELD_KAPPA | FIELD_SLOPE)?;
        Ok((q, exact_held(branch, &q, dp, 0.)?))
    };
    Ok([
        endpoint(Branch::SaturatedLiquid)?,
        endpoint(Branch::SaturatedVapor)?,
    ])
}

/// Exact rho/u/h directional response; disclosed same-branch second-order
/// coefficient probes for transport/cp/alpha. No whole-model probing or cache.
pub fn directional(
    branch: Branch,
    p: f64,
    t: f64,
    dp: f64,
    dt: f64,
) -> Result<(WaterPoint, WaterPoint), Error> {
    let mut value = WaterPoint::default();
    let mut direction = WaterPoint::default();
    // SAFETY: same C-layout contract as point; outputs are distinct live unique
    // stack allocations, retained nowhere. The native function catches errors.
    let status =
        unsafe { ld01_water_direction(branch as i32, p, t, dp, dt, &mut value, &mut direction) };
    match status {
        0 => Ok((value, direction)),
        1 => Err(Error::Domain),
        2 => Err(Error::AbiArgument),
        4 => Err(Error::TrialBand),
        _ => Err(Error::NativeFailure),
    }
}

/// `directional(branch, held.pressure_pa, held.temperature_k, dp, dt).1` at a
/// point this boundary already returned as exactly that forward point, without
/// evaluating it again: only the coefficient probes are evaluated.
fn directional_held(
    branch: Branch,
    held: &WaterPoint,
    dp: f64,
    dt: f64,
) -> Result<WaterPoint, Error> {
    let mut direction = WaterPoint::default();
    // SAFETY: `held` is a live shared C-layout tuple that C only reads during
    // the call; `direction` is a unique live stack allocation written on
    // success. Nothing is retained and the native function catches errors.
    let status = unsafe { ld01_water_direction_held(branch as i32, held, dp, dt, &mut direction) };
    match status {
        0 => Ok(direction),
        1 => Err(Error::Domain),
        2 => Err(Error::AbiArgument),
        _ => Err(Error::NativeFailure),
    }
}

/// Invert the maintained pure-phase EOS at the SAME pressure and specific U.
/// This is a local coordinate elimination, not a flash calculation or a new
/// property fit. A target beyond the requested branch's stable range is
/// recovered only inside its bounded metastable trial band, on the branch's
/// own basic equation, and refused with `Error::TrialBand` beyond it; it is
/// never clamped to saturation or assigned a different phase.
pub fn point_pu(branch: Branch, p: f64, u: f64) -> Result<WaterPoint, Error> {
    CaloricLinearization::internal_energy(branch, p, u).map(|q| q.point())
}

/// The same stable-branch inverse for a responsible incoming enthalpy. This
/// creates no phase stock and is not used to assign a point to an empty phase
/// without a physical receipt.
pub fn point_ph(branch: Branch, p: f64, h: f64) -> Result<WaterPoint, Error> {
    CaloricLinearization::enthalpy(branch, p, h).map(|q| q.point())
}

/// Fields the thermodynamics-only inverse adds to the caloric state:
/// compressibility and viscosity. cv, conductivity and the saturation slope
/// are not evaluated.
const FIELDS_THERMODYNAMIC: i32 = FIELD_KAPPA | FIELD_MU;

/// One immutable, successfully recovered caloric point. A Jacobian may reuse
/// this point for directions at EXACTLY its pressure and specific energy;
/// callers must construct another point when either value or branch changes.
/// There is no lookup, cross-trial cache, held derivative or EOS approximation.
/// Private fields prevent pairing an arbitrary WaterPoint with another branch.
#[derive(Clone, Copy, Debug)]
pub struct CaloricLinearization {
    branch: Branch,
    kind: Caloric,
    point: WaterPoint,
    /// FIELD_* bits evaluated beyond the caloric state.
    fields: i32,
}
impl CaloricLinearization {
    pub fn internal_energy(branch: Branch, p: f64, u: f64) -> Result<Self, Error> {
        Self::new(branch, p, u, Caloric::Internal, FIELDS_ALL)
    }

    pub fn enthalpy(branch: Branch, p: f64, h: f64) -> Result<Self, Error> {
        Self::new(branch, p, h, Caloric::Enthalpy, FIELDS_ALL)
    }

    /// The same inverse (the same iterates and selected state) evaluating
    /// only the thermodynamic fields and viscosity: in `point()`, cv,
    /// conductivity and the saturation slope are NaN, never zero. Every
    /// evaluated field is bit for bit the complete inverse's.
    pub fn thermodynamic(
        branch: Branch,
        p: f64,
        target: f64,
        enthalpy: bool,
    ) -> Result<Self, Error> {
        let kind = if enthalpy {
            Caloric::Enthalpy
        } else {
            Caloric::Internal
        };
        Self::new(branch, p, target, kind, FIELDS_THERMODYNAMIC)
    }

    fn new(branch: Branch, p: f64, target: f64, kind: Caloric, fields: i32) -> Result<Self, Error> {
        Ok(Self {
            branch,
            kind,
            point: invert_caloric(branch, p, target, kind, fields)?,
            fields,
        })
    }

    pub fn point(self) -> WaterPoint {
        self.point
    }

    /// Whether every field is evaluated.
    pub fn is_complete(self) -> bool {
        self.fields == FIELDS_ALL
    }

    /// This point with every field evaluated: bit for bit the complete
    /// inverse's point for the same inputs, from the held caloric state
    /// without inverting again.
    pub fn completed(self) -> Result<Self, Error> {
        if self.is_complete() {
            return Ok(self);
        }
        Ok(Self {
            point: complete(&self.point)?,
            fields: FIELDS_ALL,
            ..self
        })
    }

    /// The exact thermodynamic part of `directional`: temperature, density,
    /// internal energy and enthalpy bit for bit, without the coefficient
    /// probes; it needs only the thermodynamic fields.
    pub fn exact_directional(self, dp: f64, dtarget: f64) -> Result<[f64; 4], Error> {
        if !dp.is_finite() || !dtarget.is_finite() {
            return Err(Error::Domain);
        }
        if dp == 0. && dtarget == 0. {
            return Ok([0.; 4]);
        }
        let (up, ut) = self.kind.partials(self.point);
        if !ut.is_finite() || ut <= 0. {
            return Err(Error::NativeFailure);
        }
        let d = exact_held(self.branch, &self.point, dp, (dtarget - up * dp) / ut)?;
        Ok([
            d.temperature_k,
            d.density_kg_m3,
            d.internal_energy_j_kg,
            d.enthalpy_j_kg,
        ])
    }

    /// Same implicit caloric tangent and native coefficient probes as the
    /// one-shot directional_pu/ph calls, without repeating the inverse solve.
    /// A zero direction consumes no derivative and needs no native query.
    pub fn directional(self, dp: f64, dtarget: f64) -> Result<WaterPoint, Error> {
        if !dp.is_finite() || !dtarget.is_finite() {
            return Err(Error::Domain);
        }
        if dp == 0. && dtarget == 0. {
            return Ok(WaterPoint::default());
        }
        // The coefficient probes may read the held point's every field.
        let held = self.completed()?;
        let (up, ut) = held.kind.partials(held.point);
        if !ut.is_finite() || ut <= 0. {
            return Err(Error::NativeFailure);
        }
        // The held point is the forward point at exactly (branch, its p, its
        // T), the saturated-endpoint bracket included, so it is not repeated.
        directional_held(held.branch, &held.point, dp, (dtarget - up * dp) / ut)
    }

    /// The accepted point's band report on its requested branch.
    pub fn band(self) -> BandReport {
        band_check(self.branch, &self.point)
    }
}

#[derive(Clone, Copy, Debug)]
enum Caloric {
    Internal,
    Enthalpy,
}
impl Caloric {
    fn value(self, q: WaterPoint) -> f64 {
        match self {
            Self::Internal => q.internal_energy_j_kg,
            Self::Enthalpy => q.enthalpy_j_kg,
        }
    }
    fn partials(self, q: WaterPoint) -> (f64, f64) {
        let a = q.expansion_per_k;
        let r = q.density_kg_m3;
        match self {
            Self::Internal => (
                (q.pressure_pa * q.compressibility_per_pa - q.temperature_k * a) / r,
                q.cp_j_kg_k - q.pressure_pa * a / r,
            ),
            Self::Enthalpy => ((1. - q.temperature_k * a) / r, q.cp_j_kg_k),
        }
    }
}
/// One end of an inverse bracket: the branch and temperature it is evaluated at.
type End = (Branch, f64);

/// The native branch ends at `p`: the stable end (the saturated endpoint, or
/// region 1 at its temperature limit where saturation lies above it) and the
/// trial end of the bounded metastable band, if the branch has one at `p`.
fn branch_ends(branch: Branch, p: f64) -> Result<(End, Option<f64>), Error> {
    let (mut stable_branch, mut stable_t, mut trial_t) = (0, 0., 0.);
    // SAFETY: three unique live scalar outputs, written on success and
    // retained nowhere; the native function catches every C++ exception.
    let status = unsafe {
        ld01_water_bracket(
            branch as i32,
            p,
            &mut stable_branch,
            &mut stable_t,
            &mut trial_t,
        )
    };
    match status {
        0 => {}
        1 => return Err(Error::Domain),
        2 => return Err(Error::AbiArgument),
        _ => return Err(Error::NativeFailure),
    }
    let stable = match stable_branch {
        0 => Branch::Liquid,
        2 => Branch::SaturatedLiquid,
        3 => Branch::SaturatedVapor,
        _ => return Err(Error::NativeFailure),
    };
    Ok(((stable, stable_t), (!trial_t.is_nan()).then_some(trial_t)))
}

fn invert_caloric(
    branch: Branch,
    p: f64,
    target: f64,
    kind: Caloric,
    fields: i32,
) -> Result<WaterPoint, Error> {
    if !target.is_finite() {
        return Err(Error::Domain);
    }
    if !matches!(branch, Branch::Liquid | Branch::Vapor) {
        return Err(Error::AbiArgument);
    }
    // These are the normative IF97 R1/R2 temperature bounds already selected
    // by this boundary. Pressure/domain admission remains in the native EOS.
    let (stable, trial) = branch_ends(branch, p)?;
    let (low_end, high_end) = match branch {
        Branch::Liquid => ((branch, 273.15), stable),
        _ => (stable, (branch, 1073.15)),
    };
    // Brackets and iterates read only the caloric state. The returned state is
    // the complete forward point at the selected temperature, completed from
    // the caloric state already evaluated there, so the iteration path and
    // every returned field are those of full-point queries.
    let low = caloric_state(low_end.0, p, low_end.1)?;
    let high = caloric_state(high_end.0, p, high_end.1)?;
    // Beyond the stable end the target can only be a metastable state of the
    // requested branch: it is bracketed by that end and the trial end, and a
    // target beyond the trial end is refused, never clamped.
    match branch {
        Branch::Liquid if target > kind.value(high) => {
            let trial = trial.ok_or(Error::TrialBand)?;
            let top = caloric_state(branch, p, trial)?;
            if target > kind.value(top) {
                return Err(Error::TrialBand);
            }
            return newton(
                branch,
                p,
                target,
                kind,
                fields,
                (high_end, high),
                ((branch, trial), top),
            );
        }
        Branch::Vapor if target < kind.value(low) => {
            let trial = trial.ok_or(Error::TrialBand)?;
            let bottom = caloric_state(branch, p, trial)?;
            if target < kind.value(bottom) {
                return Err(Error::TrialBand);
            }
            return newton(
                branch,
                p,
                target,
                kind,
                fields,
                ((branch, trial), bottom),
                (low_end, low),
            );
        }
        _ => {}
    }
    if target < kind.value(low) || target > kind.value(high) {
        return Err(Error::Domain);
    }
    newton(
        branch,
        p,
        target,
        kind,
        fields,
        (low_end, low),
        (high_end, high),
    )
}

/// Safeguarded Newton inside one bracket whose ends were evaluated as given.
/// The returned point is the forward point at the selected end or
/// temperature, completed with `fields` from the caloric state evaluated there.
fn newton(
    branch: Branch,
    p: f64,
    target: f64,
    kind: Caloric,
    fields: i32,
    (_, mut low): (End, WaterPoint),
    (_, mut high): (End, WaterPoint),
) -> Result<WaterPoint, Error> {
    if target == kind.value(low) {
        return complete_fields(&low, fields);
    }
    if target == kind.value(high) {
        return complete_fields(&high, fields);
    }
    let mut t = low.temperature_k
        + (high.temperature_k - low.temperature_k) * (target - kind.value(low))
            / (kind.value(high) - kind.value(low));
    // Safeguarded Newton uses the actual thermodynamic partial. Bisection is
    // only a root-finding safeguard, never a replacement EOS value or state.
    // The bound is a numerical termination guard, not a simulation timestep.
    for _ in 0..64 {
        let q = caloric_state(branch, p, t)?;
        let defect = kind.value(q) - target;
        let (_, ut) = kind.partials(q);
        if !ut.is_finite() || ut <= 0. {
            return Err(Error::NativeFailure);
        }
        // Use the local thermal energy scale as well as the energy value.
        // An arbitrary EOS datum can make target U zero without making the
        // attainable numerical precision or the heat capacity zero.
        if defect.abs() <= 2e-12 * target.abs().max(ut * q.temperature_k).max(1.) {
            return complete_fields(&q, fields);
        }
        if defect < 0. {
            low = q;
        } else {
            high = q;
        }
        let proposed = t - defect / ut;
        t = if proposed > low.temperature_k && proposed < high.temperature_k {
            proposed
        } else {
            (low.temperature_k + high.temperature_k) / 2.
        };
    }
    Err(Error::NativeFailure)
}

/// The artifact's compiled `ld01-metastable-band` values, as the native
/// boundary applies them.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[repr(C)]
pub struct MetastableBand {
    pub pressure_low_pa: f64,
    pub pressure_high_pa: f64,
    pub trial_max_k: f64,
    pub liquid_superheat_max_k: f64,
    pub vapor_subcooling_max_k: f64,
    pub credited_max_k: f64,
    pub liquid_temperature_max_k: f64,
    pub liquid_pressure_ceiling_pa: f64,
    pub vapor_pressure_ceiling_pa: f64,
    pub lower_bound_exclusive: i32,
}
impl MetastableBand {
    pub fn compiled() -> Self {
        let mut band = Self::default();
        // SAFETY: one unique live C-layout output, written completely; the
        // native function only copies its compiled constants into it.
        let status = unsafe { ld01_water_metastable_band(&mut band) };
        assert_eq!(status, 0, "compiled metastable band unavailable");
        band
    }
}

/// Where an accepted state lies relative to saturation on its own branch.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Band {
    /// Saturated, or on the stable side of saturation for its branch.
    Stable,
    /// Metastable inside the admitted band; `credited` within `creditedMax_K`.
    Admitted { credited: bool },
    /// Metastable beyond the admitted band (reachable only as a trial state).
    Exceeded,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BandReport {
    /// Signed departure `T - Tsat(p)` on the state's branch.
    pub departure_k: f64,
    pub band: Band,
}

/// Band check of an ACCEPTED state on its requested branch: liquid superheat
/// at most `liquidSuperheatMax_K`, vapor subcooling at most
/// `vaporSubcoolingMax_K`. It classifies and reports; it never clamps, refuses
/// or enters a residual.
pub fn band_check(branch: Branch, point: &WaterPoint) -> BandReport {
    let band = MetastableBand::compiled();
    let departure = point.saturation_departure_k;
    let (metastable, limit) = match branch {
        Branch::Liquid => (departure, band.liquid_superheat_max_k),
        Branch::Vapor => (-departure, band.vapor_subcooling_max_k),
        Branch::SaturatedLiquid | Branch::SaturatedVapor => (0., 0.),
    };
    let band = if metastable <= 0. {
        Band::Stable
    } else if metastable <= limit {
        Band::Admitted {
            credited: metastable <= band.credited_max_k,
        }
    } else {
        Band::Exceeded
    };
    BandReport {
        departure_k: departure,
        band,
    }
}

/// Implicit p/u direction through the same local EOS inversion. Exact first
/// thermo partials determine T'; coefficient directions retain the existing
/// adapter's disclosed same-branch accuracy. No cross-trial cache is used.
pub fn directional_pu(
    branch: Branch,
    p: f64,
    u: f64,
    dp: f64,
    du: f64,
) -> Result<(WaterPoint, WaterPoint), Error> {
    directional_caloric(branch, p, u, dp, du, Caloric::Internal)
}

pub fn directional_ph(
    branch: Branch,
    p: f64,
    h: f64,
    dp: f64,
    dh: f64,
) -> Result<(WaterPoint, WaterPoint), Error> {
    directional_caloric(branch, p, h, dp, dh, Caloric::Enthalpy)
}
fn directional_caloric(
    branch: Branch,
    p: f64,
    target: f64,
    dp: f64,
    dtarget: f64,
    kind: Caloric,
) -> Result<(WaterPoint, WaterPoint), Error> {
    if !dp.is_finite() || !dtarget.is_finite() {
        return Err(Error::Domain);
    }
    let q = CaloricLinearization::new(branch, p, target, kind, FIELDS_ALL)?;
    Ok((q.point(), q.directional(dp, dtarget)?))
}

pub fn surface_tension(t: f64, dt: f64) -> Result<(f64, f64), Error> {
    let mut value = 0.;
    let mut direction = 0.;
    // SAFETY: two unique live scalar outputs; C keeps no pointers/catches errors.
    let status = unsafe { ld01_water_surface(t, dt, &mut value, &mut direction) };
    match status {
        0 => Ok((value, direction)),
        1 => Err(Error::Domain),
        2 => Err(Error::AbiArgument),
        _ => Err(Error::NativeFailure),
    }
}

/// Actual property adapter consumed by the native thermal residual/JVP.
pub struct If97;
fn thermal_point(q: WaterPoint, d: WaterPoint) -> leitbild_operating_plant::thermal::WaterPoint {
    use leitbild_operating_plant::thermal::{Scalar, WaterPoint as ThermalPoint};
    ThermalPoint {
        density: Scalar::new(q.density_kg_m3, d.density_kg_m3),
        viscosity: Scalar::new(q.viscosity_pa_s, d.viscosity_pa_s),
        conductivity: Scalar::new(q.conductivity_w_m_k, d.conductivity_w_m_k),
        cp: Scalar::new(q.cp_j_kg_k, d.cp_j_kg_k),
        expansion: Scalar::new(q.expansion_per_k, d.expansion_per_k),
        enthalpy: Scalar::new(q.enthalpy_j_kg, d.enthalpy_j_kg),
    }
}
impl leitbild_operating_plant::thermal::WaterProperties for If97 {
    fn liquid(
        &self,
        p: leitbild_operating_plant::thermal::Scalar,
        t: leitbild_operating_plant::thermal::Scalar,
    ) -> leitbild_operating_plant::thermal::Result<leitbild_operating_plant::thermal::WaterPoint>
    {
        let (q, d) = directional(Branch::Liquid, p.value, t.value, p.direction, t.direction)
            .map_err(|_| "maintained IF97 liquid domain/derivative")?;
        Ok(thermal_point(q, d))
    }
    fn vapor(
        &self,
        p: leitbild_operating_plant::thermal::Scalar,
        t: leitbild_operating_plant::thermal::Scalar,
    ) -> leitbild_operating_plant::thermal::Result<leitbild_operating_plant::thermal::WaterPoint>
    {
        let (q, d) = directional(Branch::Vapor, p.value, t.value, p.direction, t.direction)
            .map_err(|_| "maintained IF97 vapor domain/derivative")?;
        Ok(thermal_point(q, d))
    }
    fn saturation(
        &self,
        p: leitbild_operating_plant::thermal::Scalar,
    ) -> leitbild_operating_plant::thermal::Result<leitbild_operating_plant::thermal::Saturation>
    {
        use leitbild_operating_plant::thermal::{Saturation, Scalar};
        let (l, dl) = directional(Branch::SaturatedLiquid, p.value, 0., p.direction, 0.)
            .map_err(|_| "maintained IF97 saturation liquid")?;
        let (g, dg) = directional(Branch::SaturatedVapor, p.value, 0., p.direction, 0.)
            .map_err(|_| "maintained IF97 saturation vapor")?;
        let (sigma, dsigma) = surface_tension(l.temperature_k, dl.temperature_k)
            .map_err(|_| "maintained IF97 surface tension")?;
        Ok(Saturation {
            temperature: Scalar::new(l.temperature_k, dl.temperature_k),
            liquid: thermal_point(l, dl),
            vapor: thermal_point(g, dg),
            surface_tension: Scalar::new(sigma, dsigma),
        })
    }
    fn saturated_vapor_density(
        &self,
        t: leitbild_operating_plant::thermal::Scalar,
    ) -> leitbild_operating_plant::thermal::Result<leitbild_operating_plant::thermal::Scalar> {
        let mut value = 0.;
        let mut direction = 0.;
        // SAFETY: unique scalar outputs, no retained pointer; checked native
        // saturation call catches exceptions, using its actual inverse slope.
        let status = unsafe {
            ld01_water_vapor_sat_density(t.value, t.direction, &mut value, &mut direction)
        };
        if status != 0 {
            return Err("maintained IF97 wall saturation density");
        }
        Ok(leitbild_operating_plant::thermal::Scalar::new(
            value, direction,
        ))
    }
}

impl WaterPoint {
    /// Exact thermodynamic first partials at this branch; viscosity/conductivity
    /// derivatives are not invented here. The thermal join must supply those
    /// additional local coefficient derivatives when assembling its Jacobian.
    pub fn phase_point(self) -> leitbild_operating_plant::phase::Point {
        let p = self.pressure_pa;
        let t = self.temperature_k;
        let r = self.density_kg_m3;
        let a = self.expansion_per_k;
        let k = self.compressibility_per_pa;
        leitbild_operating_plant::phase::Point {
            pressure_pa: p,
            temperature_k: t,
            density_kg_m3: r,
            internal_energy_j_kg: self.internal_energy_j_kg,
            enthalpy_j_kg: self.enthalpy_j_kg,
            density_pressure: r * k,
            density_temperature: -r * a,
            energy_pressure: (p * k - t * a) / r,
            energy_temperature: self.cp_j_kg_k - p * a / r,
        }
    }
}

#[cfg(feature = "ida")]
pub mod ida;
#[cfg(feature = "ida")]
pub mod joined;
#[cfg(feature = "quadratures")]
pub mod joined_ledger;
#[cfg(feature = "ida")]
pub mod klu;
pub mod network;
#[cfg(target_os = "macos")]
pub mod spectrum;
