//! Moving-boundary hook of the coarse local-pressure network: the phase
//! elimination closed on a moving free volume, and phase-path inertance on a
//! current volume. Explicit analytic constitutive fixtures only; the actual
//! packet and maintained IF97 check lives in the opt-in water-ffi package.
use leitbild_operating_plant::{
    local_flow::{ColdOnset, Face, MomentumSupport, PressureSegment, phase_path_kinematics},
    phase::{self, ScalarRatePhase},
    thermal::Scalar,
};

fn s(v: f64) -> Scalar {
    Scalar::constant(v)
}
fn close(a: f64, b: f64, rtol: f64) {
    assert!(
        (a - b).abs() <= rtol * a.abs().max(b.abs()).max(1e-300),
        "{a} != {b}"
    );
}

/// Analytic compressible liquid/vapor point: rho, u and their p/T partials.
struct Analytic {
    rho0: f64,
    kappa: f64,
    beta: f64,
    c: f64,
    e: f64,
}
impl Analytic {
    fn density(&self, p: f64, t: f64) -> f64 {
        self.rho0 * (self.kappa * (p - 15e6) - self.beta * (t - 580.)).exp()
    }
    fn energy(&self, p: f64, t: f64) -> f64 {
        1.3e6 + self.c * (t - 580.) + self.e * (p - 15e6)
    }
    /// The mass-cancelled rate inputs the network builds from a caloric point.
    fn phase(&self, mass: f64, p: f64, t: f64) -> ScalarRatePhase {
        let rho = self.density(p, t);
        ScalarRatePhase {
            mass: s(mass),
            density: s(rho),
            specific_u: s(self.energy(p, t)),
            rho_p: s(rho * self.kappa),
            rho_t: s(-rho * self.beta),
            u_p: s(self.e),
            u_t: s(self.c),
        }
    }
}
const LIQUID: Analytic = Analytic {
    rho0: 700.,
    kappa: 1.4e-9,
    beta: 3.1e-3,
    c: 5600.,
    e: -2e-5,
};
const VAPOR: Analytic = Analytic {
    rho0: 95.,
    kappa: 9e-8,
    beta: 1.4e-2,
    c: 3100.,
    e: -4e-4,
};

/// Independent finite-chart rates of one cell whose free volume moves:
/// unknowns p', T_k', V_k'. Each phase obeys d(rho V)/dt = M' and
/// d(M u)/dt = H' - p V_k'; the volumes close on sum V_k' = V'.
fn independent(
    p: f64,
    t: [f64; 2],
    volume: [f64; 2],
    present: [bool; 2],
    mass_rate: [f64; 2],
    enthalpy_rate: [f64; 2],
    boundary_rate: f64,
) -> (f64, [f64; 2], [f64; 2]) {
    // Coordinates [p', T_0', T_1', V_0', V_1'] with absent phases pinned.
    let laws = [&LIQUID, &VAPOR];
    let mut a = [[0.; 5]; 5];
    let mut b = [0.; 5];
    for k in 0..2 {
        let (row_m, row_u) = (2 * k, 2 * k + 1);
        if !present[k] {
            a[row_m][1 + k] = 1.;
            a[row_u][3 + k] = 1.;
            continue;
        }
        let law = laws[k];
        let rho = law.density(p, t[k]);
        let mass = rho * volume[k];
        a[row_m][0] = rho * law.kappa * volume[k];
        a[row_m][1 + k] = -rho * law.beta * volume[k];
        a[row_m][3 + k] = rho;
        b[row_m] = mass_rate[k];
        // M' u + M (u_p p' + u_T T') = H' - p V_k'
        a[row_u][0] = mass * law.e;
        a[row_u][1 + k] = mass * law.c;
        a[row_u][3 + k] = p;
        b[row_u] = enthalpy_rate[k] - mass_rate[k] * law.energy(p, t[k]);
    }
    a[4][3] = 1.;
    a[4][4] = 1.;
    b[4] = boundary_rate;
    let x = solve(a, b);
    let volume_rate = [x[3], x[4]];
    let energy_rate = [
        enthalpy_rate[0] - p * volume_rate[0],
        enthalpy_rate[1] - p * volume_rate[1],
    ];
    (x[0], volume_rate, energy_rate)
}
fn solve(mut a: [[f64; 5]; 5], mut b: [f64; 5]) -> [f64; 5] {
    for k in 0..5 {
        let pivot = (k..5)
            .max_by(|i, j| a[*i][k].abs().total_cmp(&a[*j][k].abs()))
            .unwrap();
        a.swap(k, pivot);
        b.swap(k, pivot);
        let pivot_row = a[k];
        for i in k + 1..5 {
            let f = a[i][k] / pivot_row[k];
            for (target, source) in a[i].iter_mut().zip(pivot_row).skip(k) {
                *target -= f * source;
            }
            b[i] -= f * b[k];
        }
    }
    let mut x = [0.; 5];
    for i in (0..5).rev() {
        let sum: f64 = (i + 1..5).map(|j| a[i][j] * x[j]).sum();
        x[i] = (b[i] - sum) / a[i][i];
    }
    x
}

#[test]
fn moving_boundary_rates_match_independently_differentiated_finite_charts() {
    let p = 15.1e6;
    let t = [581., 615.];
    for (present, volume) in [
        ([true, false], [2.5, 0.]),
        ([true, true], [2.1, 0.4]),
        ([false, true], [0., 2.5]),
    ] {
        for boundary in [-1.7e-3, 0., 2.3e-3] {
            let mass_rate = [
                if present[0] { -0.9 } else { 0. },
                if present[1] { 0.2 } else { 0. },
            ];
            let enthalpy_rate = [
                if present[0] { -1.1e6 } else { 0. },
                if present[1] { 0.55e6 } else { 0. },
            ];
            let phases = [
                present[0].then(|| LIQUID.phase(LIQUID.density(p, t[0]) * volume[0], p, t[0])),
                present[1].then(|| VAPOR.phase(VAPOR.density(p, t[1]) * volume[1], p, t[1])),
            ];
            let actual = phase::current_rates_with_boundary(
                s(p),
                phases,
                mass_rate.map(s),
                enthalpy_rate.map(s),
                s(boundary),
            )
            .unwrap();
            let (pd, vd, ud) =
                independent(p, t, volume, present, mass_rate, enthalpy_rate, boundary);
            close(actual.pressure_rate_pa_s.value, pd, 1e-9);
            for k in 0..2 {
                close(actual.volume_rate_m3_s[k].value, vd[k], 1e-9);
                close(actual.internal_energy_rate_w[k].value, ud[k], 1e-9);
            }
            // The phase volumes close on the boundary, and the fluid pays
            // the boundary work -p V' once.
            let total_volume = actual.volume_rate_m3_s[0].value + actual.volume_rate_m3_s[1].value;
            close(total_volume, boundary, 1e-9);
            let work = actual.internal_energy_rate_w[0].value
                + actual.internal_energy_rate_w[1].value
                - enthalpy_rate[0]
                - enthalpy_rate[1];
            close(work, -p * boundary, 1e-9);
        }
    }
}

#[test]
fn a_still_boundary_equals_the_rigid_cell_and_its_rate_direction_is_exact() {
    let p = 15.1e6;
    let phases = [
        Some(LIQUID.phase(LIQUID.density(p, 581.) * 2.1, p, 581.)),
        Some(VAPOR.phase(VAPOR.density(p, 615.) * 0.4, p, 615.)),
    ];
    let mass = [s(-0.9), s(0.2)];
    let heat = [s(-1.1e6), s(0.55e6)];
    let rigid = phase::current_rates(s(p), phases, mass, heat).unwrap();
    let still = phase::current_rates_with_boundary(s(p), phases, mass, heat, s(0.)).unwrap();
    assert_eq!(
        rigid.pressure_rate_pa_s.value,
        still.pressure_rate_pa_s.value
    );
    for k in 0..2 {
        assert_eq!(
            rigid.volume_rate_m3_s[k].value,
            still.volume_rate_m3_s[k].value
        );
        assert_eq!(
            rigid.internal_energy_rate_w[k].value,
            still.internal_energy_rate_w[k].value
        );
    }
    // A seeded boundary rate carries its exact linear direction.
    let seeded =
        phase::current_rates_with_boundary(s(p), phases, mass, heat, Scalar::new(1e-3, 1.))
            .unwrap();
    let probe = |v: f64| {
        phase::current_rates_with_boundary(s(p), phases, mass, heat, s(v))
            .unwrap()
            .pressure_rate_pa_s
            .value
    };
    close(
        seeded.pressure_rate_pa_s.direction,
        (probe(1e-3 + 1e-6) - probe(1e-3 - 1e-6)) / 2e-6,
        1e-7,
    );
}

fn face() -> Face {
    Face {
        from: 0,
        to: 1,
        flow_area_m2: 1.2,
        supports: vec![
            MomentumSupport {
                region: 0,
                path_length_m: 1.,
                inverse_area_length_per_m: 0.85,
                volume_m3: 1.2,
            },
            MomentumSupport {
                region: 1,
                path_length_m: 1.,
                inverse_area_length_per_m: 0.85,
                volume_m3: 1.2,
            },
        ],
        pressure_segments: vec![
            PressureSegment {
                region: 0,
                path_length_m: 1.,
                elevation_change_m: 1.,
            },
            PressureSegment {
                region: 1,
                path_length_m: 1.,
                elevation_change_m: 1.,
            },
        ],
    }
}

#[test]
fn constant_scalar_volumes_reproduce_fixed_volumes_bitwise() {
    let f = face();
    let mass = [Scalar::new(1800., -3.), Scalar::new(1750., 2.)];
    let rate = [Scalar::new(-0.4, 0.01), Scalar::new(0.3, -0.02)];
    let impulse = Scalar::new(2200., 15.);
    let fixed = [2.57, 2.54];
    let a = phase_path_kinematics(
        &f,
        &mass,
        &rate,
        &fixed,
        impulse,
        s(0.),
        ColdOnset::Unavailable,
    )
    .unwrap();
    let b = phase_path_kinematics(
        &f,
        &mass,
        &rate,
        &fixed.map(s),
        impulse,
        s(0.),
        ColdOnset::Unavailable,
    )
    .unwrap();
    for (x, y) in [
        (a.inertance_kg_m4, b.inertance_kg_m4),
        (a.inertance_rate_kg_m4_s, b.inertance_rate_kg_m4_s),
        (a.volume_flow_m3_s, b.volume_flow_m3_s),
    ] {
        assert_eq!(x.value.to_bits(), y.value.to_bits());
        assert_eq!(x.direction.to_bits(), y.direction.to_bits());
    }
}

#[test]
fn a_moving_volume_direction_enters_the_inertance_exactly() {
    let f = face();
    let mass = [s(1800.), s(1750.)];
    let rate = [s(0.), s(0.)];
    let impulse = s(2200.);
    let moving = [Scalar::new(2.57, -1.7e-3), s(2.54)];
    let a = phase_path_kinematics(
        &f,
        &mass,
        &rate,
        &moving,
        impulse,
        s(0.),
        ColdOnset::Unavailable,
    )
    .unwrap();
    let probe = |dv: f64| {
        phase_path_kinematics(
            &f,
            &mass,
            &rate,
            &[2.57 + dv, 2.54],
            impulse,
            s(0.),
            ColdOnset::Unavailable,
        )
        .unwrap()
    };
    let h = 1e-7;
    let (plus, minus) = (probe(-1.7e-3 * h), probe(1.7e-3 * h));
    close(
        a.inertance_kg_m4.direction,
        (plus.inertance_kg_m4.value - minus.inertance_kg_m4.value) / (2. * h),
        1e-6,
    );
    close(
        a.volume_flow_m3_s.direction,
        (plus.volume_flow_m3_s.value - minus.volume_flow_m3_s.value) / (2. * h),
        1e-6,
    );
    // A nonpositive current volume is refused, never clipped.
    assert!(
        phase_path_kinematics(
            &f,
            &mass,
            &rate,
            &[s(0.), s(2.54)],
            impulse,
            s(0.),
            ColdOnset::Unavailable,
        )
        .is_err()
    );
}
