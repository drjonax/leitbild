//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-phase-properties.md#one-maintained-water-implementation
//! The caloric inverse brackets and iterates on the caloric state (rho, u, h,
//! cp, alpha) of the maintained forward point and evaluates ONE full point at
//! the selected temperature. The earlier full-point iteration over the stable
//! branch is restated here, on the public forward `point`, solely as the
//! comparison oracle: every tuple and caloric direction it recovers must agree
//! bit for bit. States it refuses may since be admitted (bounded metastable
//! admission, the liquid pressure ceiling); they are counted, and every outcome
//! can be dumped (`LD01_IDENTITY_DUMP`) to compare separately built archives
//! and implementations input by input.
use leitbild_operating_plant::{
    network::{Network, Properties, RotorState, Water, packet::Packet},
    rotor::{Shaft, SpeedRequest, Support},
    thermal::{Saturation, Scalar},
};
use leitbild_operating_water::{
    Branch, CaloricLinearization, Error, If97, WaterPoint, directional, point, point_ph, point_pu,
};
use serde_json::json;
use std::{cell::Cell, hint::black_box, rc::Rc, time::Instant};

#[derive(Clone, Copy, Debug)]
enum Kind {
    Internal,
    Enthalpy,
}
impl Kind {
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
    fn recover(self, branch: Branch, p: f64, target: f64) -> Result<CaloricLinearization, Error> {
        match self {
            Self::Internal => CaloricLinearization::internal_energy(branch, p, target),
            Self::Enthalpy => CaloricLinearization::enthalpy(branch, p, target),
        }
    }
}

/// The earlier production inverse, unchanged except that it is spelled on
/// the public forward point: every bracket end and iterate is a full point.
fn full_point_inverse(
    branch: Branch,
    p: f64,
    target: f64,
    kind: Kind,
) -> Result<WaterPoint, Error> {
    if !target.is_finite() {
        return Err(Error::Domain);
    }
    let (mut low, mut high) = match branch {
        Branch::Liquid => (
            point(branch, p, 273.15)?,
            point(Branch::SaturatedLiquid, p, 0.)?,
        ),
        Branch::Vapor => (
            point(Branch::SaturatedVapor, p, 0.)?,
            point(branch, p, 1073.15)?,
        ),
        _ => return Err(Error::AbiArgument),
    };
    if target < kind.value(low) || target > kind.value(high) {
        return Err(Error::Domain);
    }
    if target == kind.value(low) {
        return Ok(low);
    }
    if target == kind.value(high) {
        return Ok(high);
    }
    let mut t = low.temperature_k
        + (high.temperature_k - low.temperature_k) * (target - kind.value(low))
            / (kind.value(high) - kind.value(low));
    for _ in 0..64 {
        let q = point(branch, p, t)?;
        let defect = kind.value(q) - target;
        let (_, ut) = kind.partials(q);
        if !ut.is_finite() || ut <= 0. {
            return Err(Error::NativeFailure);
        }
        if defect.abs() <= 2e-12 * target.abs().max(ut * q.temperature_k).max(1.) {
            return Ok(q);
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

/// The caloric direction of the earlier inverse's point (unchanged code).
fn full_point_direction(
    branch: Branch,
    kind: Kind,
    q: WaterPoint,
    dp: f64,
    dtarget: f64,
) -> Result<WaterPoint, Error> {
    if !dp.is_finite() || !dtarget.is_finite() {
        return Err(Error::Domain);
    }
    if dp == 0. && dtarget == 0. {
        return Ok(WaterPoint::default());
    }
    let (up, ut) = kind.partials(q);
    if !ut.is_finite() || ut <= 0. {
        return Err(Error::NativeFailure);
    }
    directional(
        branch,
        q.pressure_pa,
        q.temperature_k,
        dp,
        (dtarget - up * dp) / ut,
    )
    .map(|(_, d)| d)
}

fn bits(q: WaterPoint) -> [u64; 13] {
    [
        q.region as u64,
        q.pressure_pa.to_bits(),
        q.temperature_k.to_bits(),
        q.density_kg_m3.to_bits(),
        q.internal_energy_j_kg.to_bits(),
        q.enthalpy_j_kg.to_bits(),
        q.cp_j_kg_k.to_bits(),
        q.cv_j_kg_k.to_bits(),
        q.expansion_per_k.to_bits(),
        q.compressibility_per_pa.to_bits(),
        q.viscosity_pa_s.to_bits(),
        q.conductivity_w_m_k.to_bits(),
        q.saturation_slope_k_pa.to_bits(),
    ]
}

fn same(a: Result<WaterPoint, Error>, b: Result<WaterPoint, Error>) -> bool {
    match (a, b) {
        (Ok(a), Ok(b)) => bits(a) == bits(b),
        (Err(a), Err(b)) => a == b,
        _ => false,
    }
}

/// FNV-1a over outcome bits; printed so separately built artifacts and
/// implementations can be compared on the same deterministic inputs.
struct Ledger {
    inverses: usize,
    recovered: usize,
    directions: usize,
    forward: usize,
    /// Oracle-refused targets the production inverse now recovers.
    admitted: usize,
    digest: u64,
    forward_digest: u64,
    /// (status tag, FNV-1a of the tuple bits) per outcome, in input order.
    records: Vec<[u64; 2]>,
    /// (branch, kind or direction, pressure bits) per record, for attribution.
    inputs: Vec<[u64; 3]>,
}
fn mix(digest: &mut u64, word: u64) {
    for byte in word.to_le_bytes() {
        *digest = (*digest ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3);
    }
}
/// Error kinds by name, so that archives with and without later kinds compare.
fn tag(outcome: &Result<WaterPoint, Error>) -> u64 {
    match outcome {
        Ok(_) => 0,
        Err(e) => match format!("{e:?}").as_str() {
            "Domain" => 1,
            "AbiArgument" => 2,
            "NativeFailure" => 3,
            _ => 4,
        },
    }
}
fn absorb(digest: &mut u64, outcome: Result<WaterPoint, Error>) {
    match outcome {
        Ok(q) => bits(q).into_iter().for_each(|w| mix(digest, w)),
        Err(_) => mix(digest, 0xEEEE_0000 + tag(&outcome)),
    }
}
fn record(ledger: &mut Ledger, outcome: Result<WaterPoint, Error>) {
    let mut hash = 0xcbf2_9ce4_8422_2325;
    absorb(&mut hash, outcome);
    ledger.records.push([tag(&outcome), hash]);
}
fn input(ledger: &mut Ledger, branch: Branch, what: u64, p: f64, count: usize) {
    for k in 0..count as u64 {
        ledger
            .inputs
            .push([branch as u64, what * 16 + k, p.to_bits()]);
    }
}
/// Placeholder for a direction of a target that was not recovered, so that
/// every input contributes the same number of records in every build.
const ABSENT: [u64; 2] = [9, 0];

/// splitmix64 mapped to [0, 1): deterministic, platform-independent inputs.
fn unit(state: &mut u64) -> f64 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^= z >> 31;
    (z >> 11) as f64 / (1u64 << 53) as f64
}

/// Admitted pressures: a geometric 0.1-16 MPa grid, its exact ends and their
/// inner neighbours, round operating values and pseudo-random pressures.
fn pressures() -> Vec<f64> {
    let mut p: Vec<f64> = (0..=120)
        .map(|i| (1e5 * 160f64.powf(f64::from(i) / 120.)).clamp(1e5, 16e6))
        .collect();
    p.extend([
        1e5,
        1e5f64.next_up(),
        1e6,
        5e6,
        7e6,
        15e6,
        15.5e6,
        16e6f64.next_down(),
        16e6,
    ]);
    let mut state = 0x5EED_0001;
    p.extend((0..40).map(|_| 1e5 + (16e6 - 1e5) * unit(&mut state)));
    p
}

fn ends(branch: Branch) -> ((Branch, f64), (Branch, f64)) {
    match branch {
        Branch::Liquid => ((Branch::Liquid, 273.15), (Branch::SaturatedLiquid, 0.)),
        Branch::Vapor => ((Branch::SaturatedVapor, 0.), (Branch::Vapor, 1073.15)),
        _ => unreachable!("only stable branches are inverted"),
    }
}

/// Targets across one branch's admitted caloric interval: both exact bracket
/// values and their ulp neighbours on both sides, relative offsets down to
/// 1e-15 from each end (saturation included), a uniform interior, forward
/// values near both end temperatures, pseudo-random fractions and refusals.
fn targets(branch: Branch, kind: Kind, p: f64, state: &mut u64) -> Vec<f64> {
    let ((lb, lt), (hb, ht)) = ends(branch);
    let low = point(lb, p, lt).unwrap();
    let high = point(hb, p, ht).unwrap();
    let (a, b) = (kind.value(low), kind.value(high));
    let span = b - a;
    let mut t = vec![
        a,
        b,
        a.next_up(),
        b.next_down(),
        a.next_down(),
        b.next_up(),
        a - 0.01 * span,
        b + 0.01 * span,
    ];
    t.extend((1..40).map(|k| a + span * f64::from(k) / 40.));
    for f in [1e-15, 1e-13, 1e-11, 1e-9, 1e-7, 1e-5, 1e-3] {
        t.extend([a + span * f, b - span * f]);
    }
    let (tl, th) = (low.temperature_k, high.temperature_k);
    for d in [1e-9, 1e-6, 1e-3, 0.1, 1.] {
        for temperature in [tl + d, th - d] {
            if let Ok(q) = point(branch, p, temperature) {
                t.push(kind.value(q));
            }
        }
    }
    for k in 1..10 {
        if let Ok(q) = point(branch, p, tl + (th - tl) * f64::from(k) / 10.) {
            t.push(kind.value(q));
        }
    }
    t.extend((0..8).map(|_| a + span * unit(state)));
    t
}

const DIRECTIONS: [(f64, f64); 5] = [(0., 0.), (1e4, 0.), (0., 2e3), (-3e4, 5e3), (f64::NAN, 0.)];

fn check(ledger: &mut Ledger, branch: Branch, kind: Kind, p: f64, target: f64) {
    let recovered = kind.recover(branch, p, target);
    let actual = recovered.map(CaloricLinearization::point);
    let expected = full_point_inverse(branch, p, target, kind);
    ledger.inverses += 1;
    input(ledger, branch, kind as u64, p, 1 + DIRECTIONS.len());
    record(ledger, actual);
    let Ok(expected) = expected else {
        // Refused by the earlier stable-branch inverse: may since be admitted.
        if let Ok(recovered) = recovered {
            ledger.admitted += 1;
            for (dp, de) in DIRECTIONS {
                record(ledger, recovered.directional(dp, de));
            }
        } else {
            ledger.records.extend([ABSENT; DIRECTIONS.len()]);
        }
        return;
    };
    assert!(
        same(actual, Ok(expected)),
        "{branch:?} {kind:?} p={p:e} target={target:e}: {actual:?} versus {expected:?}"
    );
    absorb(&mut ledger.digest, actual);
    let recovered = recovered.unwrap();
    ledger.recovered += 1;
    for (dp, de) in DIRECTIONS {
        let actual = recovered.directional(dp, de);
        let oracle = full_point_direction(branch, kind, expected, dp, de);
        assert!(
            same(actual, oracle),
            "{branch:?} {kind:?} p={p:e} target={target:e} d=({dp:e},{de:e}): {actual:?} versus {oracle:?}"
        );
        ledger.directions += 1;
        absorb(&mut ledger.digest, actual);
        record(ledger, actual);
    }
}

#[test]
fn caloric_state_iteration_recovers_the_full_point_iteration_bit_for_bit() {
    let mut ledger = Ledger {
        inverses: 0,
        recovered: 0,
        directions: 0,
        forward: 0,
        admitted: 0,
        digest: 0xcbf2_9ce4_8422_2325,
        forward_digest: 0xcbf2_9ce4_8422_2325,
        records: Vec::new(),
        inputs: Vec::new(),
    };
    let mut state = 0x5EED_0002;
    let grid = pressures();
    for &p in &grid {
        for branch in [Branch::Liquid, Branch::Vapor] {
            for kind in [Kind::Internal, Kind::Enthalpy] {
                for target in targets(branch, kind, p, &mut state) {
                    check(&mut ledger, branch, kind, p, target);
                }
            }
        }
    }
    // Refusals: non-finite targets, pressures outside the stable 0.1-16 MPa
    // domain, and the saturated branches' ABI argument.
    for kind in [Kind::Internal, Kind::Enthalpy] {
        for branch in [
            Branch::Liquid,
            Branch::Vapor,
            Branch::SaturatedLiquid,
            Branch::SaturatedVapor,
        ] {
            for p in [
                f64::NAN,
                f64::INFINITY,
                -1.,
                0.,
                1e5f64.next_down(),
                16e6f64.next_up(),
                17e6,
                30e6,
                1e5,
                15e6,
            ] {
                for target in [
                    f64::NAN,
                    f64::INFINITY,
                    f64::NEG_INFINITY,
                    -1e6,
                    0.,
                    1e6,
                    2.6e6,
                ] {
                    check(&mut ledger, branch, kind, p, target);
                }
            }
        }
    }
    // The rebuilt archive's forward entries, digested over all four branches
    // (exact saturation temperatures and their neighbours included), so it
    // can be compared with the earlier archive on the same inputs.
    for &p in &grid {
        let saturation = point(Branch::SaturatedLiquid, p, 0.).unwrap().temperature_k;
        let mut temperatures: Vec<f64> = (0..=40).map(|k| 273.15 + 20. * f64::from(k)).collect();
        temperatures.extend([
            saturation.next_down(),
            saturation,
            saturation.next_up(),
            saturation - 1e-6,
            saturation + 1e-6,
        ]);
        for branch in [
            Branch::Liquid,
            Branch::Vapor,
            Branch::SaturatedLiquid,
            Branch::SaturatedVapor,
        ] {
            // The digest covers the stable side of saturation and the
            // endpoints, which no admission change may alter.
            let stable_side = |t: f64| match branch {
                Branch::Liquid => t <= saturation,
                Branch::Vapor => t >= saturation,
                _ => true,
            };
            for &t in &temperatures {
                let stable = stable_side(t);
                for outcome in [
                    point(branch, p, t),
                    directional(branch, p, t, 1e4, 0.5).map(|(_, d)| d),
                ] {
                    if stable {
                        absorb(&mut ledger.forward_digest, outcome);
                    }
                    record(&mut ledger, outcome);
                    input(&mut ledger, branch, 9, p, 1);
                    ledger.forward += 1;
                }
            }
        }
    }
    println!(
        "{}",
        json!({
            "kind": "caloric-inverse-identity",
            "pressures": grid.len(),
            "inverses": ledger.inverses,
            "recovered": ledger.recovered,
            "refused": ledger.inverses - ledger.recovered,
            "directions": ledger.directions,
            "oracle_refused_now_admitted": ledger.admitted,
            "inverse_digest": format!("{:016x}", ledger.digest),
            "forward_calls": ledger.forward,
            "forward_stable_side_digest": format!("{:016x}", ledger.forward_digest),
            "records": ledger.records.len(),
        })
    );
    if let Ok(path) = std::env::var("LD01_IDENTITY_DUMP") {
        let bytes: Vec<u8> = ledger
            .records
            .iter()
            .flatten()
            .flat_map(|w| w.to_le_bytes())
            .collect();
        std::fs::write(&path, bytes).unwrap();
        let inputs: Vec<u8> = ledger
            .inputs
            .iter()
            .flatten()
            .flat_map(|w| w.to_le_bytes())
            .collect();
        std::fs::write(format!("{path}.inputs"), inputs).unwrap();
    }
    assert!(ledger.inverses > 50_000 && ledger.recovered > 40_000);
}

#[repr(C)]
struct Timespec {
    seconds: i64,
    nanoseconds: i64,
}
unsafe extern "C" {
    fn clock_gettime(clock: i32, out: *mut Timespec) -> i32;
}
/// CLOCK_THREAD_CPUTIME_ID (macOS 16, Linux 3).
const THREAD_CPU_CLOCK: i32 = if cfg!(target_os = "macos") { 16 } else { 3 };
fn thread_cpu_s() -> f64 {
    let mut t = Timespec {
        seconds: 0,
        nanoseconds: 0,
    };
    // SAFETY: one live stack Timespec matching the C layout; the C library
    // writes it and keeps no pointer.
    let status = unsafe { clock_gettime(THREAD_CPU_CLOCK, &mut t) };
    assert_eq!(status, 0, "thread CPU clock unavailable");
    t.seconds as f64 + t.nanoseconds as f64 * 1e-9
}

/// Interleaved best of three in thread CPU time: every round times each
/// candidate once, so a changing load affects all candidates alike.
fn interleaved_best<const N: usize>(runs: &mut [&mut dyn FnMut(); N]) -> [f64; N] {
    let mut best = [f64::INFINITY; N];
    for _ in 0..3 {
        for (b, run) in best.iter_mut().zip(runs.iter_mut()) {
            let started = thread_cpu_s();
            run();
            *b = b.min(thread_cpu_s() - started);
        }
    }
    best
}

#[test]
#[ignore = "cost report only; run explicitly with --ignored --nocapture"]
fn caloric_inverse_cost() {
    let mut reports = Vec::new();
    for (branch, name) in [(Branch::Liquid, "liquid"), (Branch::Vapor, "vapor")] {
        let ((lb, lt), (hb, ht)) = ends(branch);
        let mut cases = Vec::new();
        for i in 0..32 {
            let p = 1e5 * 160f64.powf((f64::from(i) + 0.5) / 32.);
            let (tl, th) = (
                point(lb, p, lt).unwrap().temperature_k,
                point(hb, p, ht).unwrap().temperature_k,
            );
            for k in 1..16 {
                let t = tl + (th - tl) * f64::from(k) / 16.;
                let q = point(branch, p, t).unwrap();
                cases.push((p, t, q.internal_energy_j_kg, q.enthalpy_j_kg));
            }
        }
        let inverse = |caloric: fn(Branch, f64, f64) -> Result<WaterPoint, Error>, h: bool| {
            for &(p, _, u, e) in &cases {
                black_box(caloric(branch, black_box(p), black_box(if h { e } else { u })).unwrap());
            }
        };
        let full = |kind: Kind| {
            for &(p, _, u, e) in &cases {
                let target = match kind {
                    Kind::Internal => u,
                    Kind::Enthalpy => e,
                };
                black_box(
                    full_point_inverse(branch, black_box(p), black_box(target), kind).unwrap(),
                );
            }
        };
        let [pu, ph, pu_full, ph_full, forward] = interleaved_best(&mut [
            &mut || inverse(point_pu, false),
            &mut || inverse(point_ph, true),
            &mut || full(Kind::Internal),
            &mut || full(Kind::Enthalpy),
            &mut || {
                for &(p, t, _, _) in &cases {
                    black_box(point(branch, black_box(p), black_box(t)).unwrap());
                }
            },
        ])
        .map(|seconds| 1e6 * seconds / cases.len() as f64);
        // Band states 1 K past saturation at 10.5-16 MPa, timed only by a
        // build that admits them.
        let band: Vec<(f64, f64)> = (0..16)
            .filter_map(|i| {
                let p = 10.5e6 + 0.35e6 * f64::from(i);
                let ts = point(Branch::SaturatedLiquid, p, 0.).ok()?.temperature_k;
                let t = if name == "liquid" { ts + 1. } else { ts - 1. };
                Some((p, point(branch, p, t).ok()?.internal_energy_j_kg))
            })
            .collect();
        let metastable = (band.len() == 16).then(|| {
            let [seconds] = interleaved_best(&mut [&mut || {
                for &(p, u) in &band {
                    black_box(point_pu(branch, black_box(p), black_box(u)).unwrap());
                }
            }]);
            1e6 * seconds / band.len() as f64
        });
        reports.push(json!({
            "branch": name,
            "calls": cases.len(),
            "metastable_point_pu_us": metastable,
            "point_pu_us": pu,
            "point_ph_us": ph,
            "full_point_iteration_pu_us": pu_full,
            "full_point_iteration_ph_us": ph_full,
            "forward_point_us": forward,
        }));
    }
    println!(
        "{}",
        json!({"kind": "caloric-inverse-cost", "clock": "thread CPU", "best_of": 3, "interleaved": true, "branches": reports})
    );
}

/// Census of one residual's property queries: forward, (p,u) liquid/vapor,
/// (p,h) liquid/vapor and saturation. Every query is delegated unchanged.
struct Census(Rc<Cell<[usize; 6]>>);
impl Census {
    fn count(&self, index: usize) {
        let mut calls = self.0.get();
        calls[index] += 1;
        self.0.set(calls);
    }
}
impl Properties for Census {
    type Caloric = CaloricLinearization;
    fn forward(&self, vapor: bool, p: f64, t: f64) -> Result<Water, String> {
        self.count(0);
        If97.forward(vapor, p, t)
    }
    fn caloric(
        &self,
        vapor: bool,
        p: f64,
        target: f64,
        enthalpy: bool,
    ) -> Result<CaloricLinearization, String> {
        self.count(1 + 2 * usize::from(enthalpy) + usize::from(vapor));
        If97.caloric(vapor, p, target, enthalpy)
    }
    fn values(&self, point: &CaloricLinearization) -> Water {
        If97.values(point)
    }
    fn direction(&self, point: &CaloricLinearization, dp: f64, de: f64) -> Result<Water, String> {
        If97.direction(point, dp, de)
    }
    fn saturation(&self, pressure: Scalar) -> Result<Saturation, String> {
        self.count(5);
        Properties::saturation(&If97, pressure)
    }
}

fn running<P: Properties>(network: &mut Network<P>) {
    for r in 0..network.rotor_count() {
        network.set_rotor_state(
            r,
            RotorState {
                support: Support::Supported(SpeedRequest::Nominal),
                shaft: Shaft::Free,
            },
        );
    }
}

#[test]
#[ignore = "requires LD01_OPERATING_HOT_SPINE_PACKET; cost report only"]
fn prepared_network_residual_cost() {
    let path = std::env::var("LD01_OPERATING_HOT_SPINE_PACKET").unwrap();
    let packet: Packet = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let (mut network, prepared) = Network::new(&packet, If97).unwrap();
    running(&mut network);
    network
        .select_leading_receipts(&prepared.y, &prepared.yp)
        .unwrap();
    network
        .evaluate(0., &prepared.y, &prepared.yp, None, 0., None)
        .unwrap();
    let mut rows = 0xcbf2_9ce4_8422_2325;
    for r in network.rows() {
        mix(&mut rows, r.value.to_bits());
        mix(&mut rows, r.direction.to_bits());
    }
    let evaluations = 200;
    let structure = network.sparse_jacobian().unwrap();
    let mut values = vec![0.; structure.pattern.nonzeros()];
    let mut best = [f64::INFINITY; 2];
    for _ in 0..3 {
        let started = Instant::now();
        for _ in 0..evaluations {
            network
                .evaluate(0., &prepared.y, &prepared.yp, None, 0., None)
                .unwrap();
        }
        best[0] = best[0].min(started.elapsed().as_secs_f64() / f64::from(evaluations));
        let started = Instant::now();
        network
            .jacobian_colored(0., 2.1, &prepared.y, &prepared.yp, &structure, &mut values)
            .unwrap();
        best[1] = best[1].min(started.elapsed().as_secs_f64());
    }
    let [residual, jacobian] = best;
    let calls = Rc::new(Cell::new([0; 6]));
    let (mut census, _) = Network::new(&packet, Census(calls.clone())).unwrap();
    running(&mut census);
    census
        .select_leading_receipts(&prepared.y, &prepared.yp)
        .unwrap();
    calls.set([0; 6]);
    census
        .evaluate(0., &prepared.y, &prepared.yp, None, 0., None)
        .unwrap();
    let [
        forward,
        pu_liquid,
        pu_vapor,
        ph_liquid,
        ph_vapor,
        saturation,
    ] = calls.get();
    let mut matrix = 0xcbf2_9ce4_8422_2325;
    for v in &values {
        mix(&mut matrix, v.to_bits());
    }
    println!(
        "{}",
        json!({
            "kind": "prepared-network-residual-cost",
            "packet": path,
            "unknowns": network.dimension(),
            "best_of": 3,
            "residual_ms": 1e3 * residual,
            "colored_jacobian_ms": 1e3 * jacobian,
            "colors": structure.coloring.count(),
            "queries_per_residual": {
                "forward": forward,
                "pu_liquid": pu_liquid,
                "pu_vapor": pu_vapor,
                "ph_liquid": ph_liquid,
                "ph_vapor": ph_vapor,
                "saturation": saturation,
            },
            "residual_digest": format!("{rows:016x}"),
            "jacobian_digest": format!("{matrix:016x}"),
        })
    );
}
