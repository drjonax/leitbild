//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/pumps-and-support.md#shaft-and-energy-model
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/pumps-and-support.md#effective-torque-drive-electrical-loss
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/reversible-pump-model.md#fluid-and-rotor-energy-accounting
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/reversible-pump-model.md#persistent-ideal-shaft-seizure
//! spec: world/packs/process-plant/reference-designs/ld-01/systems/primary-coolant/reversible-pump-model.md#motor-and-admissibility
//!
//! RCP shaft equation blocks, NOT a contactor, protection or thermal-store
//! owner. `P:n` cites pumps-and-support.md and `R:n` reversible-pump-model.md
//! by line at wiki d3bbbec. Supplied here: packet admission against the
//! inertia/drag identities (P:20-23), the one torque-tracking, nonregenerative
//! drive with torque-squared conversion loss (P:30-47), the free-rotor rate row
//! `dL/dt-(T_motor-T_fluid-T_drag)` (P:24, R:51), the locked algebraic row
//! `omega=0` with its zero-work reaction (R:73), the idempotent ideal seizure
//! transaction (R:61-73), explicit fault removal (R:75) and the
//! reverse-rotation START refusal (R:125).
//!
//! The caller supplies the joint signed-flow fluid torque (`hydraulics`) and the
//! actual contactor/motive-AC support, and owns the rotor angular-momentum
//! state `L=J*omega` and the RCP.MOTOR.THERMAL store that receives the
//! separately reported heats. No overload timer, thermal
//! trip, seizure trip or automatic contactor opening exists here (P:53).
//! Evaluation is allocation-free. Exact limit and work-sign kinks carry the
//! one-sided direction of the branch entered and are marked non-linearizable.

use crate::thermal::Scalar;

/// Per-pump drive/rotor coefficients under the fixed packet names of the
/// compiled `hydraulics.pump` object. Its pump-curve fields belong to
/// [`crate::hydraulics::Pump`]; the integrator constructs this sub-selection.
/// Every coefficient is explicit; none has a default. Nominal drag power is
/// derived, `P_drag_0=drag_Nm_per_rad_s*omega0^2` (P:23), not a second field.
#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Parameters {
    /// Effective inertia `J=(P_fluid_0+P_drag_0)*10/omega0^2` from the
    /// selected initial speed-decay scale (P:17, P:21).
    #[serde(rename = "rotorInertia_kg_m2")]
    pub inertia_kg_m2: f64,
    /// Viscous coefficient `P_drag_0/omega0^2`; `T_drag=coefficient*omega` has
    /// the sign of actual speed and dissipates nonnegative power (P:23, R:55).
    #[serde(rename = "drag_Nm_per_rad_s")]
    pub drag_nm_per_rad_s: f64,
    /// Reference speed omega0, converted once from the selected rpm (P:15): the
    /// nominal speed request and the calibration speed of `T0=P0/omega0` (P:38).
    #[serde(rename = "referenceOmega_rad_s")]
    pub reference_omega_rad_s: f64,
    /// Original powered-cycle nominal fluid work `P_fluid_0` (P:9, P:34).
    #[serde(rename = "nominalFluidPower_W")]
    pub nominal_fluid_power_w: f64,
    /// Speed-tracking time constant of the supported torque request (P:30).
    #[serde(rename = "driveTrackingTime_s")]
    pub tracking_time_s: f64,
    /// Upper torque limit as a multiple of the nominal total resisting torque
    /// `T0` (P:30); the lower limit is zero.
    #[serde(rename = "driveTorqueCapFactor")]
    pub torque_cap_factor: f64,
    /// Nominal efficiency `eta0` that calibrates `L0=P0*(1/eta0-1)` once at the
    /// original reference (P:34, P:38-39).
    #[serde(rename = "driveEfficiency")]
    pub efficiency: f64,
}

/// Speed request of a supported drive (P:30). The initial operational
/// interface requests zero or nominal speed; only an explicit engineering test
/// may select an intermediate supported speed.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum SpeedRequest {
    Zero,
    Nominal,
    /// Engineering-test speed strictly between zero and omega0.
    EngineeringTest {
        omega_rad_s: f64,
    },
}

/// Actual drive support from the contactor and electrical owners (P:47, P:71).
/// It is never inferred from a plant-running flag or retained RUN intent.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Support {
    /// Closed contactor in RUN with actual motive AC inside the electrical
    /// owner's accepted voltage/frequency envelope.
    Supported(SpeedRequest),
    /// STOP, open contactor or lost motive AC: torque is withdrawn at once,
    /// including during a retained-RUN dropout interval (P:47, P:71).
    Unsupported,
    /// Closed contactor with motive AC outside the accepted envelope. No torque
    /// law or multiplier is selected there (P:71), so evaluation refuses.
    OutsideSupplyEnvelope,
}

/// Persistent ideal stationary-shaft constraint state (R:61, R:73-75). Only
/// [`Parameters::lock`] sets it and only [`release`] clears it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shaft {
    Free,
    Locked,
}

/// Current coordinates and their one directional derivative. Signed Newton
/// trials are admitted; only finiteness is required.
#[derive(Clone, Copy, Debug)]
pub struct Input {
    /// Actual signed shaft speed, positive in the ordinary motoring direction
    /// (R:13). For a locked shaft it is the algebraic coordinate of `omega=0`.
    pub omega_rad_s: Scalar,
    /// Rate of the rotor angular-momentum state, `dL/dt=J*domega/dt` (N m),
    /// of a free rotor; the locked algebraic row does not use it.
    pub angular_momentum_rate_nm: Scalar,
    /// Actual joint signed-flow passage load `T_fluid=TE+TB`, i.e.
    /// `hydraulics::Receipt::fluid_torque_nm` (P:25, R:99). For a locked shaft
    /// it is the actual passage load at `omega=0` (P:47, R:73).
    pub fluid_torque_nm: Scalar,
}

/// Active branch of the limited torque request `[0, cap*T0]` (P:30). At an
/// exact limit the branch entered along the seeded direction is reported.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TorqueBranch {
    /// Unsupported drive: torque withdrawn, no request exists (P:47).
    Withdrawn,
    /// Supported request below zero: the positive-direction motoring drive
    /// gives zero torque, never active negative torque (P:30, R:125).
    Floor,
    /// Supported request inside the limits: `T_motor` equals the request.
    Tracking,
    /// Supported request above the unchanged cap (P:30, P:47).
    Cap,
}

/// The rotor's own residual row. Its kind changes at the lock transition: the
/// caller flips that row between differential and algebraic.
#[derive(Clone, Copy, Debug)]
pub enum RotorRow {
    /// Differential row `dL/dt-(T_motor-T_fluid-T_drag)`, N m, with
    /// `dL/dt=J*domega/dt` (P:24, R:51).
    Free { residual_nm: Scalar },
    /// Algebraic row `omega=0` in rad/s (the caller's coordinate), and the
    /// sustained reaction on the rotor `T_constraint=-(T_motor-T_fluid-T_drag)`
    /// (R:73). The fixed support takes the opposite reaction; it does zero work.
    Locked {
        residual_rad_s: Scalar,
        constraint_torque_nm: Scalar,
    },
}

#[derive(Clone, Copy, Debug)]
pub struct Evaluation {
    /// Validated speed request; `None` when torque is withdrawn.
    pub requested_omega_rad_s: Option<f64>,
    /// Supported request `T_fluid+T_drag+J*(omega_request-omega)/t_track`
    /// before the limits (P:30); `None` when torque is withdrawn.
    pub requested_torque_nm: Option<Scalar>,
    /// Actual supported nonnegative motor torque `T_motor` (P:47).
    pub motor_torque_nm: Scalar,
    pub branch: TorqueBranch,
    /// Signed viscous drag torque `T_drag`; zero on a locked shaft (P:23).
    pub drag_torque_nm: Scalar,
    /// Signed motor shaft work `W=T_motor*omega` (P:41).
    pub motor_work_w: Scalar,
    /// Conversion loss `L=L0*(T_motor/T0)^2`; zero torque has zero loss (P:40,
    /// P:47).
    pub conversion_loss_w: Scalar,
    /// Electrical demand `max(W,0)+L` for the electrical owner's actual budget;
    /// never negative, never exported (P:42, P:51, P:53).
    pub electric_w: Scalar,
    /// Motor heat `Q_motor=L+max(-W,0)` for RCP.MOTOR.THERMAL, including paid
    /// negative-speed braking (P:43, P:51). `electric_w=motor_work_w+motor_heat_w`.
    pub motor_heat_w: Scalar,
    /// Viscous-drag heat `T_drag*omega>=0` for the same store, counted
    /// separately from `motor_heat_w` (P:30, P:51, R:55).
    pub drag_heat_w: Scalar,
    pub rotor: RotorRow,
    /// False at an exact torque-limit or work-sign kink for this direction.
    pub linearizable: bool,
}

/// One-time ideal seizure event at the inactive-to-active transition (R:61-69).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LockEvent {
    /// Angular impulse on the rotor `-J*omega_minus`. The rotor ends at exactly
    /// `omega_plus=0` (R:64-65): set its state to zero, do not add this impulse.
    pub rotor_angular_impulse_nms: f64,
    /// Opposite impulse `+J*omega_minus` to the idealized fixed support, which
    /// is neither a thermal sink nor a second rotor (R:66, R:71).
    pub support_angular_impulse_nms: f64,
    /// `K_removed=0.5*J*omega_minus^2`, credited once to RCP.MOTOR.THERMAL
    /// (R:67-68, R:71) and never to the passage fluid (R:73).
    pub removed_kinetic_energy_j: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Locking {
    pub shaft: Shaft,
    /// `None` for an already-active fault: no second impulse or heat (R:73).
    pub event: Option<LockEvent>,
}

/// Electrical and contactor facts of an explicit external fault-removal
/// intervention (R:75), supplied by their owners.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReleasePreparation {
    pub electrically_isolated: bool,
    pub retained_stop: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    InvalidParameter,
    InvalidInput,
    /// Engineering-test speed not strictly between zero and omega0 (P:30).
    InvalidSpeedRequest,
    /// Motive AC outside the accepted envelope has no selected law (P:71).
    UnsupportedSupplyEnvelope,
    /// START at reverse rotation; no supported restart condition is selected
    /// for it (R:125, P:51).
    ReverseRotationStart,
    /// Fault removal outside an electrically isolated, retained-STOP
    /// preparation (R:75).
    ReleaseNotPrepared,
    NonfiniteResult,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "RCP rotor/drive law: {self:?}")
    }
}
impl std::error::Error for Error {}

fn finite(x: Scalar) -> bool {
    x.value.is_finite() && x.direction.is_finite()
}

/// Selected limits `[0, cap]` (P:30). Strictly beyond a limit the constant
/// limit branch is active, so its direction is zero. At an exact limit the
/// branch entered along the seeded direction supplies the one-sided direction;
/// the other side differs unless that direction is zero.
fn limit(requested: Scalar, cap: f64, linearizable: &mut bool) -> (Scalar, TorqueBranch) {
    let (v, d) = (requested.value, requested.direction);
    if (v == 0. || v == cap) && d != 0. {
        *linearizable = false;
    }
    if v < 0. || (v == 0. && d <= 0.) {
        (Scalar::constant(0.), TorqueBranch::Floor)
    } else if v > cap || (v == cap && d >= 0.) {
        (Scalar::constant(cap), TorqueBranch::Cap)
    } else {
        (requested, TorqueBranch::Tracking)
    }
}

/// `max(x,0)` (P:42-43) with the one-sided direction at an exact zero.
fn positive_part(x: Scalar, linearizable: &mut bool) -> Scalar {
    if x.value > 0. {
        x
    } else if x.value < 0. {
        Scalar::constant(0.)
    } else {
        if x.direction != 0. {
            *linearizable = false;
        }
        Scalar::new(0., x.direction.max(0.))
    }
}

impl Parameters {
    /// Domain checks of the compiled coefficients. The input compiler owns the
    /// wiki derivations `P_drag_0=0.01*P_fluid_0` and
    /// `J=(P_fluid_0+P_drag_0)*10/omega0^2` (P:20-21) and tests them; no plant
    /// selection constant is repeated here.
    pub fn validate(&self) -> Result<(), Error> {
        if ![
            self.inertia_kg_m2,
            self.drag_nm_per_rad_s,
            self.reference_omega_rad_s,
            self.nominal_fluid_power_w,
            self.tracking_time_s,
            self.torque_cap_factor,
            self.efficiency,
        ]
        .iter()
        .all(|v| v.is_finite())
            || self.inertia_kg_m2 <= 0.
            || self.drag_nm_per_rad_s < 0.
            || self.reference_omega_rad_s <= 0.
            || self.nominal_fluid_power_w <= 0.
            || self.tracking_time_s <= 0.
            || self.torque_cap_factor <= 0.
            || self.efficiency <= 0.
            || self.efficiency > 1.
        {
            return Err(Error::InvalidParameter);
        }
        Ok(())
    }

    /// Derived nominal drag power `P_drag_0=drag_Nm_per_rad_s*omega0^2` (P:23).
    pub fn nominal_drag_power_w(&self) -> f64 {
        let omega0 = self.reference_omega_rad_s;
        self.drag_nm_per_rad_s * (omega0 * omega0)
    }

    /// `P0=P_fluid_0+P_drag_0` (P:37).
    pub fn nominal_power_w(&self) -> f64 {
        self.nominal_fluid_power_w + self.nominal_drag_power_w()
    }

    /// Nominal total resisting torque `T0=P0/omega0` (P:30, P:38).
    pub fn nominal_torque_nm(&self) -> f64 {
        self.nominal_power_w() / self.reference_omega_rad_s
    }

    /// Unchanged upper torque limit `cap_factor*T0` (P:30, P:47).
    pub fn torque_cap_nm(&self) -> f64 {
        self.torque_cap_factor * self.nominal_torque_nm()
    }

    /// Nominal conversion loss `L0=P0*(1/eta0-1)` (P:39).
    pub fn nominal_conversion_loss_w(&self) -> f64 {
        self.nominal_power_w() * (1. / self.efficiency - 1.)
    }

    fn requested_omega(&self, request: SpeedRequest) -> Result<f64, Error> {
        match request {
            SpeedRequest::Zero => Ok(0.),
            SpeedRequest::Nominal => Ok(self.reference_omega_rad_s),
            SpeedRequest::EngineeringTest { omega_rad_s }
                if omega_rad_s > 0. && omega_rad_s < self.reference_omega_rad_s =>
            {
                Ok(omega_rad_s)
            }
            SpeedRequest::EngineeringTest { .. } => Err(Error::InvalidSpeedRequest),
        }
    }

    /// Drive, loss and rotor rows at the current coordinates.
    ///
    /// Supported: `T_req=T_fluid+T_drag+J*(omega_request-omega)/t_track`,
    /// limited to `[0, cap_factor*T0]` (P:30). Withdrawn: `T_motor=0` (P:47).
    /// A locked shaft evaluates the drive, drag and work at its ideal `omega=0`
    /// with the actual passage load and the unchanged cap, never a substituted
    /// rated or capped torque (P:47); the caller's `omega` enters only the
    /// algebraic row. Energized locks therefore keep heating (P:53, R:75).
    ///
    /// Directions: strictly beyond a torque limit the active constant-limit
    /// branch gives zero direction. At an exact limit, or at exact `W=0` in
    /// `max(W,0)`/`max(-W,0)`, the one-sided direction of the branch entered
    /// along the seeded direction is returned and `linearizable` is false.
    pub fn evaluate(&self, support: Support, shaft: Shaft, x: Input) -> Result<Evaluation, Error> {
        self.validate()?;
        if ![x.omega_rad_s, x.angular_momentum_rate_nm, x.fluid_torque_nm]
            .into_iter()
            .all(finite)
        {
            return Err(Error::InvalidInput);
        }
        let omega = match shaft {
            Shaft::Free => x.omega_rad_s,
            Shaft::Locked => Scalar::constant(0.),
        };
        let mut linearizable = true;
        let drag_torque = Scalar::constant(self.drag_nm_per_rad_s) * omega;
        let (requested_omega, requested, motor, branch) = match support {
            Support::OutsideSupplyEnvelope => return Err(Error::UnsupportedSupplyEnvelope),
            Support::Unsupported => (None, None, Scalar::constant(0.), TorqueBranch::Withdrawn),
            Support::Supported(request) => {
                let target = self.requested_omega(request)?;
                let requested = x.fluid_torque_nm
                    + drag_torque
                    + Scalar::constant(self.inertia_kg_m2) * (Scalar::constant(target) - omega)
                        / Scalar::constant(self.tracking_time_s);
                let (motor, branch) = limit(requested, self.torque_cap_nm(), &mut linearizable);
                (Some(target), Some(requested), motor, branch)
            }
        };
        let work = motor * omega;
        let ratio = motor / Scalar::constant(self.nominal_torque_nm());
        let loss = Scalar::constant(self.nominal_conversion_loss_w()) * ratio * ratio;
        let electric = positive_part(work, &mut linearizable) + loss;
        let motor_heat = loss + positive_part(-work, &mut linearizable);
        let drag_heat = drag_torque * omega;
        let net = motor - x.fluid_torque_nm - drag_torque;
        let rotor = match shaft {
            Shaft::Free => RotorRow::Free {
                residual_nm: x.angular_momentum_rate_nm - net,
            },
            Shaft::Locked => RotorRow::Locked {
                residual_rad_s: x.omega_rad_s,
                constraint_torque_nm: -net,
            },
        };
        let row = match rotor {
            RotorRow::Free { residual_nm } => [residual_nm, Scalar::constant(0.)],
            RotorRow::Locked {
                residual_rad_s,
                constraint_torque_nm,
            } => [residual_rad_s, constraint_torque_nm],
        };
        if ![
            requested.unwrap_or(Scalar::constant(0.)),
            motor,
            drag_torque,
            work,
            loss,
            electric,
            motor_heat,
            drag_heat,
        ]
        .into_iter()
        .chain(row)
        .all(finite)
        {
            return Err(Error::NonfiniteResult);
        }
        Ok(Evaluation {
            requested_omega_rad_s: requested_omega,
            requested_torque_nm: requested,
            motor_torque_nm: motor,
            branch,
            drag_torque_nm: drag_torque,
            motor_work_w: work,
            conversion_loss_w: loss,
            electric_w: electric,
            motor_heat_w: motor_heat,
            drag_heat_w: drag_heat,
            rotor,
            linearizable,
        })
    }

    /// Introduce the persistent ideal stationary-shaft constraint at the actual
    /// signed pre-event speed (R:61-69). It takes no passage, contactor or
    /// supply state: fluid inventories, motor/contact intent and electrical
    /// support stay unchanged by construction, and no trip is hidden (R:73-75).
    /// Repeating an active fault is a no-op (R:73).
    pub fn lock(&self, shaft: Shaft, omega_minus_rad_s: f64) -> Result<Locking, Error> {
        self.validate()?;
        if !omega_minus_rad_s.is_finite() {
            return Err(Error::InvalidInput);
        }
        let event = match shaft {
            Shaft::Locked => None,
            Shaft::Free => {
                let momentum = self.inertia_kg_m2 * omega_minus_rad_s;
                Some(LockEvent {
                    rotor_angular_impulse_nms: -momentum,
                    support_angular_impulse_nms: momentum,
                    removed_kinetic_energy_j: 0.5 * momentum * omega_minus_rad_s,
                })
            }
        };
        Ok(Locking {
            shaft: Shaft::Locked,
            event,
        })
    }
}

/// Explicit external fault removal, admitted only in an electrically isolated,
/// retained-STOP preparation (R:75). It restores no speed, heat, material or
/// old RUN request: the released rotor starts from its locked zero speed and
/// `K_removed` stays in the metal. STOP, support restoration, indication
/// changes and protection reset are not releases.
pub fn release(preparation: ReleasePreparation) -> Result<Shaft, Error> {
    if preparation.electrically_isolated && preparation.retained_stop {
        Ok(Shaft::Free)
    } else {
        Err(Error::ReleaseNotPrepared)
    }
}

/// START admission at the actual shaft speed (R:125, P:51). Reverse rotation
/// is refused: the drive only motors in the positive direction and no
/// supported restart condition for reverse rotation is selected. A refusal
/// deletes no reached physical state; an unpowered windmilling rotor remains.
pub fn admit_start(omega_rad_s: f64) -> Result<(), Error> {
    if !omega_rad_s.is_finite() {
        Err(Error::InvalidInput)
    } else if omega_rad_s < 0. {
        Err(Error::ReverseRotationStart)
    } else {
        Ok(())
    }
}
