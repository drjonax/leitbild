//! spec: world/packs/process-plant/reference-designs/ld-01/model/operating-hot-spine.md#joined-spine-at-power
//! The joined hot spine at power (S2): one composed residual `F(t, y, y')`
//! over the nuclear, history and solid blocks, the coarse local-pressure
//! network, both SG secondaries, the 52 rod bodies and their guide passages.
//!
//! The network keeps its own coordinates, rows and scaling (decision 0013,
//! with the stratified PZR cell of decision 0014). The joined blocks meet it
//! only through its ports (`network::ports`): they read its fluid state of
//! the same evaluation and deliver heat through its single liquid enthalpy
//! receipt, so `hot_spine`'s duplicate water charts, continuity, edge
//! advection and external ports have no place here (memo Table 1.3). The
//! SG secondary and rod owners implement [`block::Secondary`] and
//! [`block::Rods`]; until an owner composes its block, the census lists it
//! as pending and no composed evaluation includes it.
pub mod block;
pub mod census;
pub mod nuclear;
pub mod packet;
pub mod solids;

use crate::network::{Network, PZR_ALGEBRAIC, PZR_COORDINATES, Properties, stratified};
use block::{Class, Layout};

/// The network's coordinates as a block layout, in its own order and
/// scaling. Its rows are already scaled by the network; the row scale of a
/// differential coordinate is its own scale (the network's convention), of a
/// rigid-volume EOS row the cell volume, and of a stratified-cell algebraic
/// row its coordinate's scale.
pub fn network_layout<P: Properties>(network: &Network<P>) -> Layout {
    let scales = network.scales();
    let n = scales.len();
    let mut layout = Layout {
        labels: vec![String::new(); n],
        classes: vec![Class::Impulse; n],
        differential: vec![true; n],
        scales: scales.to_vec(),
        row_scales: scales.to_vec(),
    };
    let mut set = |i: usize, label: String, class: Class, differential: bool, row: f64| {
        layout.labels[i] = label;
        layout.classes[i] = class;
        layout.differential[i] = differential;
        layout.row_scales[i] = row;
    };
    for (node, l) in network.cell_layout.iter().enumerate() {
        set(
            l.base,
            format!("p[{node}]"),
            Class::CellPressure,
            false,
            network.volume(node),
        );
        set(
            l.boron,
            format!("B_liquid[{node}]"),
            Class::Tracer,
            true,
            scales[l.boron],
        );
        for k in 0..2 {
            set(
                l.mass[k],
                format!("M[{node},{k}]"),
                Class::PhaseMass,
                true,
                scales[l.mass[k]],
            );
            set(
                l.energy[k],
                format!("U[{node},{k}]"),
                Class::PhaseEnergy,
                true,
                scales[l.energy[k]],
            );
        }
    }
    let names = [
        "p_roof", "V_g", "V_A", "V_R", "V_b", "V_d", "M_g", "U_g", "M_A", "U_A", "B_A", "M_R",
        "U_R", "B_R", "M_b", "M_d", "B_d",
    ];
    for (offset, name) in names.into_iter().enumerate().take(PZR_COORDINATES) {
        let i = network.pzr.base + offset;
        let algebraic = stratified::DIFFERENTIAL[offset] == 0.;
        debug_assert_eq!(algebraic, offset < PZR_ALGEBRAIC);
        set(
            i,
            format!("{name}[{}]", network.pzr.cell),
            if algebraic {
                Class::PzrAlgebraic
            } else {
                Class::PzrStock
            },
            !algebraic,
            scales[i],
        );
    }
    for l in &network.face_layout {
        set(
            l.index,
            format!("Pi[{},{}]", l.face, l.phase),
            Class::Impulse,
            true,
            scales[l.index],
        );
    }
    for (r, index) in network.rotor_index.iter().enumerate() {
        set(
            *index,
            format!("rotor[{r}]"),
            Class::Rotor,
            true,
            scales[*index],
        );
    }
    layout
}

/// The SG secondary owner's declared counts at the prepared state, per the
/// memo's §2 realization (Table 1.1), while it is pending.
pub fn pending_secondary() -> census::Pending {
    census::Pending {
        owner: "secondary",
        by: "S2-SG (block::Secondary)",
        classes: vec![
            (Class::SecondaryStock, [4, 0]),
            (Class::SecondaryChart, [0, 4]),
            (Class::ReliefLift, [4, 0]),
        ],
    }
}

/// The rod owner's declared counts at the prepared hold (bodies HELD: their
/// velocity rows algebraic), per memo §4 and Table 1.1, while it is pending.
pub fn pending_rods() -> census::Pending {
    census::Pending {
        owner: "rods",
        by: "S2-RODS (block::Rods)",
        classes: vec![
            (Class::RodPosition, [52, 0]),
            (Class::RodVelocity, [0, 52]),
            (Class::GuideCurrent, [0, 52]),
        ],
    }
}
