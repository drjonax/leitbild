//! The network's moving-boundary hook on the actual packet with maintained
//! IF97, at its hydrostatic preparation. A zero-time check of the evaluation
//! and its consistent rates, not a trajectory: an empty list evaluates
//! bitwise as the rigid network, a moving volume enters the EOS row, the
//! phase fractions and the face inertance with its exact direction, and a
//! compressing boundary over a closed, still cell raises its pressure at the
//! isentropic rate `p' = -V'/(V kappa_s)`, paying `-p V'` once.
use leitbild_operating_plant::{
    network::{
        CellVolume, ConsistentSystem, Failure, Network, PzrPreparation, RotorState,
        consistent_rates,
        packet::Packet,
        prepare::{self, OperatingPoint, Settings},
    },
    rotor::{Shaft, SpeedRequest, Support},
    thermal::Scalar,
};
use leitbild_operating_water::{Branch, If97, point_pu};

const PZR: PzrPreparation = PzrPreparation {
    pressure_tolerance_pa: 1e-6,
    max_passes: 50,
};

fn prepared() -> (Packet, Network<If97>, Vec<f64>, Vec<f64>) {
    let path = std::env::var("LD01_OPERATING_HOT_SPINE_PACKET")
        .expect("LD01_OPERATING_HOT_SPINE_PACKET names the actual packet");
    let packet: Packet = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let point = OperatingPoint::from(&packet.preparation.operating_point);
    let rotors = vec![
        RotorState {
            support: Support::Supported(SpeedRequest::Nominal),
            shaft: Shaft::Free,
        };
        4
    ];
    let settings = Settings {
        pressure_tolerance_pa: PZR.pressure_tolerance_pa,
        max_passes: PZR.max_passes,
        level_match_m: 1e-9,
        eos_row_bound: 1e-12,
        tree_face_bound_pa: 1e-6,
        representation_search: 8,
    };
    let (network, prepared, _) =
        prepare::prepare(&packet, If97, &point, &rotors, &settings).expect("preparation");
    (packet, network, prepared.y, prepared.differential)
}
fn region(packet: &Packet, id: &str) -> usize {
    packet
        .mechanics
        .regions
        .iter()
        .position(|r| r.id == id)
        .unwrap_or_else(|| panic!("no region {id}"))
}
fn values(network: &Network<impl leitbild_operating_plant::network::Properties>) -> Vec<f64> {
    network.rows().iter().map(|r| r.value).collect()
}
/// Every regular cell at its compiled volume and at rest, then one cell's
/// volume and rate replaced.
fn volumes(network: &Network<If97>, cell: Option<(usize, Scalar, Scalar)>) -> Vec<CellVolume> {
    let mut out: Vec<CellVolume> = (0..network.pzr_cell())
        .map(|c| CellVolume {
            volume_m3: Scalar::constant(network.volume(c)),
            rate_m3_s: Scalar::constant(0.),
        })
        .collect();
    if let Some((c, volume, rate)) = cell {
        out[c] = CellVolume {
            volume_m3: volume,
            rate_m3_s: rate,
        };
    }
    out
}

#[test]
#[ignore = "requires the actual packet (LD01_OPERATING_HOT_SPINE_PACKET) and maintained IF97"]
fn the_rigid_network_is_unchanged_and_a_moving_volume_is_exact() {
    let (packet, mut network, y, _) = prepared();
    let yp = vec![0.; y.len()];
    let joined = |network: &mut Network<If97>, seed: Option<&[f64]>, list: &[CellVolume]| {
        network
            .evaluate_joined(0., &y, &yp, seed, 0., None, None, list)
            .unwrap();
        network.rows().to_vec()
    };
    network.evaluate(0., &y, &yp, None, 0., None).unwrap();
    let rigid = values(&network);
    // No list, and every regular cell listed at its compiled volume and at
    // rest, both evaluate bitwise as the rigid network, values and directions.
    let still = volumes(&network, None);
    for list in [&[][..], &still[..]] {
        let rows = joined(&mut network, None, list);
        assert!(
            rows.iter()
                .zip(&rigid)
                .all(|(a, b)| a.value.to_bits() == b.to_bits())
        );
    }
    let seed: Vec<f64> = (0..y.len())
        .map(|i| ((i * 7919) % 13) as f64 / 13. - 0.5)
        .collect();
    network
        .evaluate(0., &y, &yp, Some(&seed), 0., None)
        .unwrap();
    let rigid_direction: Vec<f64> = network.rows().iter().map(|r| r.direction).collect();
    let rows = joined(&mut network, Some(&seed), &still);
    assert!(
        rows.iter()
            .zip(&rigid_direction)
            .all(|(a, b)| a.direction.to_bits() == b.to_bits())
    );

    // A moved volume shifts exactly its own EOS row by dV/V_compiled.
    let cell = region(&packet, "CORE.NE.1");
    let reference = network.volume(cell);
    let shrink = 0.044;
    let moved = |network: &Network<If97>, volume: Scalar, rate: Scalar| {
        volumes(network, Some((cell, volume, rate)))
    };
    let list = moved(
        &network,
        Scalar::constant(reference - shrink),
        Scalar::constant(0.),
    );
    let shifted: Vec<f64> = joined(&mut network, None, &list)
        .iter()
        .map(|r| r.value)
        .collect();
    let eos = network.cell_layout[cell].base;
    let expected = rigid[eos] + shrink / reference;
    assert!((shifted[eos] - expected).abs() <= 1e-14 * expected.abs().max(1.));
    assert_eq!(network.current_volume(cell).value, reference - shrink);

    // Its volume and rate directions are exact against central differences.
    let zero_seed = vec![0.; y.len()];
    for (dv, drate) in [(1., 0.), (0., 1.)] {
        let base = (reference - shrink, -2.1e-3);
        let list = moved(
            &network,
            Scalar::new(base.0, dv),
            Scalar::new(base.1, drate),
        );
        let direction: Vec<f64> = joined(&mut network, Some(&zero_seed), &list)
            .iter()
            .map(|r| r.direction)
            .collect();
        let h = 1e-6;
        let mut arm = |sign: f64| {
            let list = moved(
                &network,
                Scalar::constant(base.0 + sign * h * dv),
                Scalar::constant(base.1 + sign * h * drate),
            );
            joined(&mut network, None, &list)
                .iter()
                .map(|r| r.value)
                .collect::<Vec<f64>>()
        };
        let (plus, minus) = (arm(1.), arm(-1.));
        let mut touched = 0;
        for (i, d) in direction.iter().enumerate() {
            let fd = (plus[i] - minus[i]) / (2. * h);
            let scale = d.abs().max(fd.abs());
            if scale > 0. {
                touched += 1;
            }
            assert!(
                (d - fd).abs() <= 1e-5 * scale + 1e-9,
                "row {i}: exact {d} vs central {fd} (volume {dv}, rate {drate})"
            );
        }
        assert!(touched > 0);
    }
    // A list of the wrong length and a nonpositive volume are refused.
    assert!(
        network
            .evaluate_joined(0., &y, &yp, None, 0., None, None, &still[1..])
            .is_err()
    );
    let bad = moved(&network, Scalar::constant(0.), Scalar::constant(0.));
    assert!(
        network
            .evaluate_joined(0., &y, &yp, None, 0., None, None, &bad)
            .is_err()
    );
}

/// The network joined to one boundary coordinate `xi` [m] that moves one
/// cell's free volume, `V = V0 + area*xi`, at a declared rate `xi' = w`:
/// the joined constraint then sees the boundary through `V(xi)`, as a moving
/// body's coordinates do. A test fixture, not plant physics.
struct Boundary<'a> {
    network: &'a mut Network<If97>,
    cell: usize,
    volume0: f64,
    area: f64,
    rate: f64,
}
impl Boundary<'_> {
    fn evaluate(
        &mut self,
        y: &[f64],
        yp: &[f64],
        seed: Option<&[f64]>,
        cj: f64,
    ) -> Result<Vec<Scalar>, Failure> {
        let n = self.network.dimension();
        let d = seed.map_or(0., |s| s[n]);
        let moving = volumes(
            self.network,
            Some((
                self.cell,
                Scalar::new(self.volume0 + self.area * y[n], self.area * d),
                Scalar::new(self.area * yp[n], self.area * cj * d),
            )),
        );
        self.network.evaluate_joined(
            0.,
            &y[..n],
            &yp[..n],
            seed.map(|s| &s[..n]),
            cj,
            None,
            None,
            &moving,
        )?;
        let mut rows = self.network.rows().to_vec();
        rows.push(Scalar::new(yp[n] - self.rate, cj * d));
        Ok(rows)
    }
}
impl ConsistentSystem for Boundary<'_> {
    fn system_dimension(&self) -> usize {
        self.network.dimension() + 1
    }
    fn rows_at(&mut self, _: f64, y: &[f64], yp: &[f64]) -> Result<Vec<f64>, Failure> {
        Ok(self
            .evaluate(y, yp, None, 0.)?
            .iter()
            .map(|r| r.value)
            .collect())
    }
    fn pencil_at(
        &mut self,
        _: f64,
        y: &[f64],
        yp: &[f64],
    ) -> Result<(Vec<f64>, Vec<f64>), Failure> {
        let n = self.network.dimension() + 1;
        self.evaluate(y, yp, None, 0.)?;
        let mut signs = self.network.column_signs(&y[..n - 1]);
        signs.push(1.);
        let mut dense = |cj: f64| -> Result<Vec<f64>, Failure> {
            let mut out = vec![0.; n * n];
            let mut seed = vec![0.; n];
            for col in 0..n {
                seed[col] = signs[col];
                let rows = self.evaluate(y, yp, Some(&seed), cj);
                seed[col] = 0.;
                for (row, r) in rows?.iter().enumerate() {
                    out[col * n + row] = r.direction / signs[col];
                }
            }
            Ok(out)
        };
        let a = dense(0.)?;
        let ab = dense(1.)?;
        Ok((a.clone(), ab.iter().zip(&a).map(|(x, y)| x - y).collect()))
    }
}

#[test]
#[ignore = "requires the actual packet (LD01_OPERATING_HOT_SPINE_PACKET) and maintained IF97"]
fn a_compressing_boundary_raises_a_still_cell_isentropically() {
    let (packet, mut network, mut y, mut differential) = prepared();
    let cell = region(&packet, "CORE.NE.1");
    // One cluster's 24 bodies entering at 1.25 m/s: V' = -area * 1.25.
    let area = 24. * std::f64::consts::PI * 0.00475_f64.powi(2);
    let speed = -1.25;
    let layout = network.cell_layout[cell];
    let scales = network.scales().to_vec();
    let volume0 = network.volume(cell);
    y.push(0.);
    differential.push(1.);
    let mut system = Boundary {
        network: &mut network,
        cell,
        volume0,
        area,
        rate: speed,
    };
    let (yp, pair) = consistent_rates(&mut system, 0., &y, &differential, 1e-9, 3)
        .unwrap_or_else(|e| panic!("consistent rates: {e:?}"));
    assert!(pair.residual.value <= 1e-9 && pair.constraint_rate.value <= 1e-9);
    let p = y[layout.base] * scales[layout.base];
    let mass = y[layout.mass[0]] * scales[layout.mass[0]];
    let energy = y[layout.energy[0]] * scales[layout.energy[0]];
    let q = point_pu(Branch::Liquid, p, energy / mass).unwrap();
    let isentropic = q.compressibility_per_pa
        - q.temperature_k * q.expansion_per_k.powi(2) / (q.density_kg_m3 * q.cp_j_kg_k);
    let volume_rate = area * speed;
    let expected = -volume_rate / (volume0 * isentropic);
    let actual = yp[layout.base] * scales[layout.base];
    assert!(
        (actual - expected).abs() <= 1e-6 * expected.abs(),
        "p' {actual} vs isentropic {expected}"
    );
    // A still cell's stocks do not move at t = 0; its fluid takes -p V'.
    assert!(yp[layout.mass[0]].abs() * scales[layout.mass[0]] <= 1e-9 * mass);
    let work = yp[layout.energy[0]] * scales[layout.energy[0]];
    assert!(
        (work + p * volume_rate).abs() <= 1e-9 * (p * volume_rate).abs(),
        "U' {work} vs -p V' {}",
        -p * volume_rate
    );
}
